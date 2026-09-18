import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { collectCalendarItems } from "./collectors/calendar.js";
import { collectDownloads } from "./collectors/downloads.js";
import { collectEmailItems } from "./collectors/email.js";
import { collectGitHubItems } from "./collectors/github.js";
import { collectMockItems } from "./collectors/mock.js";
import { HKUMoodleProvider } from "./collectors/moodle.js";
import { defaultSettings } from "./config/settings.js";
import { createMorningReport } from "./briefing/generateBriefing.js";
import { JevDecisionEngine } from "./decisions/engine.js";
import { MockDecisionEngine } from "./decisions/mock.js";
import { createStore, type MorningAgentStore } from "./storage/db.js";
import { parseAgentItems } from "./types/schema.js";
import type {
  ActionRecord,
  AgentItem,
  DecisionRecord,
  RunOptions,
} from "./types/index.js";
import {
  createCalendarEvent,
  downloadFile,
  type ActionExecutionResult,
  type CalendarEventPlan,
  type DownloadFilePlan,
} from "./actions/index.js";

const itemFingerprint = (item: AgentItem): string => `${item.source}:${item.id}`;

const getStringMetadata = (item: AgentItem, key: string): string | undefined => {
  const value = item.metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const parseOptions = (argv: string[]): RunOptions => {
  const options: RunOptions = { dryRun: false, mock: false, verbose: false };
  for (const argument of argv) {
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--mock") options.mock = true;
    else if (argument === "--verbose") options.verbose = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
};

const logStage = (verbose: boolean, label: string): void => {
  if (verbose) console.log(label);
};

const isMissingPathError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const collectRealItems = async (): Promise<AgentItem[]> => {
  const moodle = new HKUMoodleProvider();
  const downloads = await collectDownloads().catch((error: unknown) => {
    if (isMissingPathError(error)) return [];
    throw error;
  });
  const [calendar, email, github, announcements, assignments, courseFiles] = await Promise.all([
    collectCalendarItems(),
    collectEmailItems(),
    collectGitHubItems(),
    moodle.getAnnouncements(),
    moodle.getAssignments(),
    moodle.getCourseFiles(),
  ]);
  return [...calendar, ...downloads, ...email, ...github, ...announcements, ...assignments, ...courseFiles];
};

const findDecision = (
  decisions: DecisionRecord[],
  itemId: string,
  name: DecisionRecord["decision"],
): DecisionRecord | undefined =>
  decisions.find((decision) => decision.itemId === itemId && decision.decision === name);

const prepareMockSource = async (item: AgentItem): Promise<{ sourcePath: string; destinationPath: string }> => {
  const filename = getStringMetadata(item, "filename") ?? `${item.id.replaceAll(/[^a-zA-Z0-9._-]/gu, "_")}.txt`;
  const sourcePath = join(process.cwd(), ".data", "mock-input", filename);
  const destinationPath = join(process.cwd(), ".data", "mock-output", filename);
  await mkdir(join(process.cwd(), ".data", "mock-input"), { recursive: true });
  try {
    await access(sourcePath);
  } catch (error: unknown) {
    if (!isMissingPathError(error)) throw error;
    await writeFile(sourcePath, `Mock course fixture for ${item.title}\n`, "utf8");
  }
  return { sourcePath, destinationPath };
};

const executeActions = async (
  items: AgentItem[],
  decisions: DecisionRecord[],
  options: RunOptions,
  newItemIds: Set<string>,
): Promise<ActionRecord[]> => {
  const results: ActionRecord[] = [];
  for (const item of items) {
    if (!newItemIds.has(item.id)) continue;

    const fileDecision = findDecision(decisions, item.id, "shouldDownloadFile");
    if (fileDecision?.output !== undefined && "download" in fileDecision.output && fileDecision.output.download) {
      const mockPaths = options.mock ? await prepareMockSource(item) : undefined;
      const sourcePath = mockPaths?.sourcePath ?? getStringMetadata(item, "path");
      const destinationPath = mockPaths?.destinationPath ?? getStringMetadata(item, "destinationPath");

      if (sourcePath !== undefined && destinationPath !== undefined) {
        const action = await downloadFile(
          { itemId: item.id, sourcePath, destinationPath },
          { confidence: fileDecision.output.confidence, dryRun: options.dryRun },
        );
        results.push(action.record);
      }
    }

    const calendarDecision = findDecision(decisions, item.id, "shouldCreateCalendarEvent");
    if (
      calendarDecision?.output !== undefined &&
      "createEvent" in calendarDecision.output &&
      calendarDecision.output.createEvent &&
      calendarDecision.output.title !== undefined &&
      calendarDecision.output.startTime !== undefined &&
      calendarDecision.output.endTime !== undefined
    ) {
      const action: ActionExecutionResult<CalendarEventPlan> = await createCalendarEvent(
        {
          itemId: item.id,
          title: calendarDecision.output.title,
          startTime: calendarDecision.output.startTime,
          endTime: calendarDecision.output.endTime,
        },
        { confidence: calendarDecision.output.confidence, dryRun: options.dryRun },
      );
      results.push(action.record);
    }
  }
  return results;
};

const persistDecisions = (store: MorningAgentStore, decisions: DecisionRecord[]): void => {
  for (const decision of decisions) store.recordDecision(decision);
};

export const runMorning = async (options: RunOptions): Promise<string> => {
  const now = new Date();
  const store = createStore({ dbPath: options.dryRun ? ":memory:" : defaultSettings.databasePath });
  try {
    logStage(options.verbose, "COLLECT");
    const collected = options.mock ? await collectMockItems() : await collectRealItems();
    logStage(options.verbose, `Collected ${collected.length} item(s)`);

    logStage(options.verbose, "↓\nNORMALIZE");
    const items = parseAgentItems(collected);
    const newItemIds = new Set<string>();
    for (const item of items) {
      if (store.recordSeenItemFingerprint(itemFingerprint(item), now)) newItemIds.add(item.id);
    }

    logStage(options.verbose, "↓\nJEV DECISIONS");
    const decisionEngine = options.mock ? new MockDecisionEngine() : new JevDecisionEngine();
    const decisions = (await Promise.all(items.map((item) => decisionEngine.evaluateItem(item)))).flat();
    persistDecisions(store, decisions);

    const newDeadlineIds = new Set<string>();
    for (const item of items) {
      if (item.deadline === undefined) continue;
      if (store.recordDeadline({ id: item.id, source: item.source, title: item.title, deadline: item.deadline }, now)) {
        newDeadlineIds.add(item.id);
      }
    }

    logStage(options.verbose, "↓\nPOLICY ENGINE");
    logStage(options.verbose, "↓\nACTIONS");
    const actions = await executeActions(items, decisions, options, newItemIds);
    for (const action of actions) store.recordAction(action);

    logStage(options.verbose, "↓\nBRIEFING");
    const report = createMorningReport({ now, items, decisions, actions, newDeadlineIds, newItemIds });
    console.log(report.text);
    return report.text;
  } finally {
    store.close();
  }
};

const main = async (): Promise<void> => {
  try {
    const options = parseOptions(process.argv.slice(2));
    await runMorning(options);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Morning Agent failed.";
    console.error(`Morning Agent failed: ${message}`);
    if (error instanceof Error && error.name === "JevConfigurationError") {
      console.error("Set TYPESAFE_API_KEY or run: npm run morning -- --mock");
    }
    process.exitCode = 1;
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

export { parseOptions };
