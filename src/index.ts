import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { collectCalendarItems } from "./collectors/calendar.js";
import { collectDownloads } from "./collectors/downloads.js";
import { collectEmailItems } from "./collectors/email.js";
import { collectEdStemItems } from "./collectors/edstem.js";
import { collectGitHubItems } from "./collectors/github.js";
import { collectNewsItems } from "./collectors/news.js";
import { collectOutlookEmailItems } from "./collectors/outlook.js";
import { collectMockItems } from "./collectors/mock.js";
import {
  HKUMoodleProvider,
  moodleOptionsFromEnvironment,
} from "./collectors/moodle.js";
import { defaultSettings } from "./config/settings.js";
import { createMorningReport } from "./briefing/generateBriefing.js";
import { JevDecisionEngine } from "./decisions/engine.js";
import { MockDecisionEngine } from "./decisions/mock.js";
import { createStore, type MorningAgentStore } from "./storage/db.js";
import { parseAgentItems } from "./types/schema.js";
import type { BrowserNavigationProgress } from "./collectors/browserReliability.js";
import type {
  ActionRecord,
  AgentItem,
  DecisionRecord,
  MorningRunEvent,
  MorningRunRecord,
  MorningRunStage,
  RunSourceKey,
  RunSourceStatus,
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

const stageLabels: Record<MorningRunStage, string> = {
  collect: "COLLECT",
  normalize: "NORMALIZE",
  jev: "JEV DECISIONS",
  policy: "POLICY ENGINE",
  actions: "ACTIONS",
  briefing: "BRIEFING",
};

const sourceLabels: Record<RunSourceKey, string> = {
  downloads: "Files",
  calendar: "Calendar",
  gmail: "Gmail",
  github: "GitHub",
  news: "Daily news",
  edstem: "Ed Lessons",
  moodle: "Moodle",
  outlook: "Outlook",
};

const sourceOrder: RunSourceKey[] = [
  "downloads",
  "calendar",
  "gmail",
  "github",
  "news",
  "edstem",
  "moodle",
  "outlook",
];

const emitRunEvent = (options: RunOptions, event: MorningRunEvent): void => {
  options.onEvent?.(event);
};

const isMissingPathError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

type SourceProgressReporter = (progress: {
  source: RunSourceKey;
  label: string;
  status: RunSourceStatus;
  detail?: string;
}) => void;

const browserProgressDetail = (progress: BrowserNavigationProgress): string => {
  let route = "the next page";
  try {
    route = new URL(progress.url).pathname || "/";
  } catch {
    // Keep the progress event useful even if a provider returns a malformed URL.
  }
  if (progress.phase === "navigating") return "Opening " + route;
  if (progress.phase === "failed") return "Browser page failed at " + route + "; stopping this source safely";
  return progress.title === undefined ? "Read " + route : "Read " + progress.title + " · " + route;
};

const collectOptionalSource = async (
  source: RunSourceKey,
  label: string,
  collector: () => Promise<AgentItem[]>,
  report: SourceProgressReporter,
): Promise<AgentItem[]> => {
  report({ source, label, status: "starting", detail: "Preparing source" });
  try {
    report({ source, label, status: "reading", detail: "Reading without making changes" });
    const items = await collector();
    report({
      source,
      label,
      status: "completed",
      detail: String(items.length) + " item" + (items.length === 1 ? "" : "s") + " found",
    });
    return items;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.warn("[" + label + "] skipped: " + message);
    report({ source, label, status: "failed", detail: message });
    return [];
  }
};

const collectRealItems = async (report: SourceProgressReporter = () => {}): Promise<AgentItem[]> => {
  const downloads = await collectOptionalSource("downloads", "Files", async () => {
    try {
      return await collectDownloads();
    } catch (error: unknown) {
      if (isMissingPathError(error)) return [];
      throw error;
    }
  }, report);
  const [calendar, email, github, news] = await Promise.all([
    collectOptionalSource("calendar", "Calendar", collectCalendarItems, report),
    collectOptionalSource("gmail", "Gmail", collectEmailItems, report),
    collectOptionalSource("github", "GitHub", collectGitHubItems, report),
    collectOptionalSource("news", "Daily news", collectNewsItems, report),
  ]);

  // Browser-backed sources are deliberately serialized. Persistent Chromium
  // profiles are expensive and often crash when several contexts open and
  // close at the same time on macOS.
  const edstem = await collectOptionalSource(
    "edstem",
    "Ed Lessons",
    () => collectEdStemItems((progress) => report({
      source: "edstem",
      label: "Ed Lessons",
      status: progress.phase === "failed" ? "failed" : "reading",
      detail: browserProgressDetail(progress),
    })),
    report,
  );
  const moodleItems = await collectOptionalSource(
    "moodle",
    "Moodle",
    async () => {
      const moodle = new HKUMoodleProvider({
        ...moodleOptionsFromEnvironment(),
        onProgress: (progress) => report({
          source: "moodle",
          label: "Moodle",
          status: progress.phase === "failed" ? "failed" : "reading",
          detail: browserProgressDetail(progress),
        }),
      });
      const collection = await Promise.all([
        moodle.getAnnouncements(),
        moodle.getAssignments(),
        moodle.getCourseFiles(),
      ]);
      return collection.flat();
    },
    report,
  );
  const outlookEmail = await collectOptionalSource(
    "outlook",
    "Outlook",
    () => collectOutlookEmailItems((progress) => report({
      source: "outlook",
      label: "Outlook",
      status: progress.phase === "failed" ? "failed" : "reading",
      detail: browserProgressDetail(progress),
    })),
    report,
  );
  return [
    ...calendar,
    ...downloads,
    ...email,
    ...outlookEmail,
    ...github,
    ...edstem,
    ...news,
    ...moodleItems,
  ];
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
  const runId = randomUUID();
  const store = createStore({
    dbPath: options.persist === true || !options.dryRun ? defaultSettings.databasePath : ":memory:",
  });
  let runRecord: MorningRunRecord = {
    runId,
    status: "running",
    startedAt: now,
    lastEventAt: now,
  };
  const emit = (event: MorningRunEvent): void => {
    const eventAt = new Date(event.at);
    runRecord = { ...runRecord, lastEventAt: eventAt };
    if (event.type === "stage") {
      runRecord = { ...runRecord, stage: event.stage };
    } else if (event.type === "run_completed") {
      runRecord = {
        ...runRecord,
        status: "completed",
        stage: "briefing",
        completedAt: eventAt,
        itemCount: event.itemCount,
        decisionCount: event.decisionCount,
        actionCount: event.actionCount,
      };
    } else if (event.type === "run_failed") {
      runRecord = { ...runRecord, status: "failed", error: event.error };
    }
    store.recordRun(runRecord);
    emitRunEvent(options, event);
  };
  try {
    emit({ type: "run_started", runId, at: now.toISOString() });
    emit({ type: "stage", runId, at: new Date().toISOString(), stage: "collect", status: "started", label: stageLabels.collect });
    for (const source of sourceOrder) {
      emit({
        type: "source_progress",
        runId,
        at: new Date().toISOString(),
        source,
        label: sourceLabels[source],
        status: "queued",
        detail: "Waiting for its turn",
      });
    }
    logStage(options.verbose, "COLLECT");
    let collected: AgentItem[];
    if (options.mock) {
      for (const source of sourceOrder) {
        emit({
          type: "source_progress",
          runId,
          at: new Date().toISOString(),
          source,
          label: sourceLabels[source],
          status: "skipped",
          detail: "Demo run; external source was not opened",
        });
      }
      collected = await collectMockItems();
    } else {
      collected = await collectRealItems((progress) => emit({
        type: "source_progress",
        runId,
        at: new Date().toISOString(),
        ...progress,
      }));
    }
    logStage(options.verbose, `Collected ${collected.length} item(s)`);
    emit({ type: "stage", runId, at: new Date().toISOString(), stage: "collect", status: "completed", label: stageLabels.collect });
    emit({ type: "items_collected", runId, at: new Date().toISOString(), count: collected.length });

    emit({ type: "stage", runId, at: new Date().toISOString(), stage: "normalize", status: "started", label: stageLabels.normalize });
    logStage(options.verbose, "↓\nNORMALIZE");
    const items = parseAgentItems(collected);
    const newItemIds = new Set<string>();
    for (const item of items) {
      store.recordItem(item, now);
      if (store.recordSeenItemFingerprint(itemFingerprint(item), now)) newItemIds.add(item.id);
    }
    emit({ type: "stage", runId, at: new Date().toISOString(), stage: "normalize", status: "completed", label: stageLabels.normalize });

    emit({ type: "stage", runId, at: new Date().toISOString(), stage: "jev", status: "started", label: stageLabels.jev });
    logStage(options.verbose, "↓\nJEV DECISIONS");
    const decisionEngine = options.mock ? new MockDecisionEngine() : new JevDecisionEngine();
    const decisions = (await Promise.all(items.map((item) => decisionEngine.evaluateItem(item)))).flat();
    persistDecisions(store, decisions);
    emit({ type: "stage", runId, at: new Date().toISOString(), stage: "jev", status: "completed", label: stageLabels.jev });
    emit({ type: "decisions_completed", runId, at: new Date().toISOString(), count: decisions.length });

    const newDeadlineIds = new Set<string>();
    for (const item of items) {
      if (item.deadline === undefined) continue;
      if (store.recordDeadline({ id: item.id, source: item.source, title: item.title, deadline: item.deadline }, now)) {
        newDeadlineIds.add(item.id);
      }
    }

    emit({ type: "stage", runId, at: new Date().toISOString(), stage: "policy", status: "started", label: stageLabels.policy });
    logStage(options.verbose, "↓\nPOLICY ENGINE");
    emit({ type: "stage", runId, at: new Date().toISOString(), stage: "policy", status: "completed", label: stageLabels.policy });
    emit({ type: "stage", runId, at: new Date().toISOString(), stage: "actions", status: "started", label: stageLabels.actions });
    logStage(options.verbose, "↓\nACTIONS");
    const actions = await executeActions(items, decisions, options, newItemIds);
    for (const action of actions) store.recordAction(action);
    emit({ type: "stage", runId, at: new Date().toISOString(), stage: "actions", status: "completed", label: stageLabels.actions });
    emit({ type: "actions_completed", runId, at: new Date().toISOString(), count: actions.length });

    emit({ type: "stage", runId, at: new Date().toISOString(), stage: "briefing", status: "started", label: stageLabels.briefing });
    logStage(options.verbose, "↓\nBRIEFING");
    const report = createMorningReport({ now, items, decisions, actions, newDeadlineIds, newItemIds });
    emit({ type: "stage", runId, at: new Date().toISOString(), stage: "briefing", status: "completed", label: stageLabels.briefing });
    emit({
      type: "run_completed",
      runId,
      at: new Date().toISOString(),
      itemCount: items.length,
      decisionCount: decisions.length,
      actionCount: actions.length,
    });
    console.log(report.text);
    return report.text;
  } catch (error: unknown) {
    emit({
      type: "run_failed",
      runId,
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Morning Agent failed.",
    });
    throw error;
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
