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
  SourceCoverage,
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

const defaultSourceOrder: RunSourceKey[] = [
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
  coverage?: SourceCoverage;
}) => void;

type SourceCollectionContext = {
  cursor?: string;
  onProgress: (progress: BrowserNavigationProgress) => void;
};

const emptySourceCoverage = (): SourceCoverage => ({
  pagesScanned: 0,
  messagesScanned: 0,
  itemsScanned: 0,
  itemsExtracted: 0,
  itemsSkipped: 0,
  itemsTruncated: 0,
  itemsMissed: 0,
  pagesFailed: 0,
  pagesPending: 0,
  messagesPendingEstimate: 0,
  missedCountUnknown: false,
  limitReached: false,
  partial: false,
});

const coverageDescription = (coverage: SourceCoverage): string => {
  const unit = coverage.messagesScanned > 0
    ? `${coverage.messagesScanned} messages scanned`
    : coverage.pagesScanned > 0
      ? `${coverage.pagesScanned} pages scanned`
      : `${coverage.itemsScanned} records scanned`;
  const parts = [
    unit,
    `${coverage.itemsExtracted} extracted`,
    `${coverage.itemsSkipped} skipped`,
    `${coverage.itemsTruncated} truncated`,
    `${coverage.itemsMissed} missed`,
  ];
  if (coverage.pagesFailed > 0) parts.push(`${coverage.pagesFailed} page${coverage.pagesFailed === 1 ? "" : "s"} failed`);
  if ((coverage.messagesFailed ?? 0) > 0) parts.push(`${coverage.messagesFailed} message${coverage.messagesFailed === 1 ? "" : "s"} failed`);
  if ((coverage.attachmentsScanned ?? 0) > 0) parts.push(`${coverage.attachmentsTextExtracted ?? 0}/${coverage.attachmentsScanned} text attachments extracted`);
  if ((coverage.attachmentsFailed ?? 0) > 0) parts.push(`${coverage.attachmentsFailed} attachment${coverage.attachmentsFailed === 1 ? "" : "s"} missed`);
  if ((coverage.pagesPending ?? 0) > 0) parts.push(`${coverage.pagesPending} page${coverage.pagesPending === 1 ? "" : "s"} pending`);
  if ((coverage.messagesPendingEstimate ?? 0) > 0) parts.push(`about ${coverage.messagesPendingEstimate} messages pending`);
  if (coverage.missedCountUnknown) parts.push("additional missed count unknown");
  if (coverage.limitReached) parts.push("limit reached, continuation saved");
  if (coverage.scope !== undefined) parts.push(coverage.scope);
  if (coverage.partial) parts.push("partial results");
  return parts.join(" · ");
};

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
  collector: (context: SourceCollectionContext) => Promise<AgentItem[]>,
  store: MorningAgentStore,
  report: SourceProgressReporter,
): Promise<AgentItem[]> => {
  const previousCursor = store.getCollectorCursor(source);
  let coverage = emptySourceCoverage();
  let reportedCursor = false;
  report({ source, label, status: "starting", detail: "Preparing source" });
  try {
    report({ source, label, status: "reading", detail: "Reading without making changes" });
    const items = await collector({
      ...(previousCursor === undefined ? {} : { cursor: previousCursor }),
      onProgress: (progress) => {
        if (progress.coverage !== undefined) coverage = progress.coverage;
        if (progress.cursor !== undefined) {
          store.setCollectorCursor(source, progress.cursor);
          reportedCursor = true;
        }
        report({
          source,
          label,
          status: "reading",
          detail: browserProgressDetail(progress),
          coverage,
        });
      },
    });
    if (!reportedCursor) store.setCollectorCursor(source, null);
    coverage = {
      ...coverage,
      itemsScanned: Math.max(coverage.itemsScanned, items.length),
      itemsExtracted: items.length,
    };
    const partial = coverage.partial || coverage.limitReached || coverage.pagesFailed > 0 || coverage.itemsMissed > 0 || coverage.itemsTruncated > 0;
    report({
      source,
      label,
      status: partial ? "partial" : "completed",
      detail: coverageDescription({ ...coverage, partial }),
      coverage: { ...coverage, partial },
    });
    return items;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.warn("[" + label + "] skipped: " + message);
    report({
      source,
      label,
      status: "failed",
      detail: message,
      coverage: { ...coverage, partial: true },
    });
    return [];
  }
};

const collectRealItems = async (
  store: MorningAgentStore,
  report: SourceProgressReporter = () => {},
  selectedSources: RunSourceKey[] = defaultSourceOrder,
  forceEnabled = false,
): Promise<AgentItem[]> => {
  const collectors: Record<RunSourceKey, () => Promise<AgentItem[]>> = {
    downloads: () => collectOptionalSource("downloads", "Files", async () => {
      try {
        return await collectDownloads();
      } catch (error: unknown) {
        if (isMissingPathError(error)) return [];
        throw error;
      }
    }, store, report),
    calendar: () => collectOptionalSource("calendar", "Calendar", () => collectCalendarItems(), store, report),
    gmail: () => collectOptionalSource("gmail", "Gmail", (context) => collectEmailItems(context.onProgress, context.cursor, forceEnabled), store, report),
    github: () => collectOptionalSource("github", "GitHub", () => collectGitHubItems(forceEnabled), store, report),
    news: () => collectOptionalSource("news", "Daily news", () => collectNewsItems(), store, report),
    edstem: () => collectOptionalSource(
      "edstem",
      "Ed Lessons",
      (context) => collectEdStemItems(context.onProgress, context.cursor, forceEnabled),
      store,
      report,
    ),
    moodle: () => collectOptionalSource(
      "moodle",
      "Moodle",
      async (context) => {
        const moodleOptions = moodleOptionsFromEnvironment();
        if (forceEnabled && moodleOptions.baseUrl === undefined) {
          throw new Error("MOODLE_BASE_URL is required before Moodle can run.");
        }
        if (forceEnabled) moodleOptions.enabled = true;
        const moodle = new HKUMoodleProvider({
          ...moodleOptions,
          ...(context.cursor === undefined ? {} : { resumeCursor: context.cursor }),
          onProgress: context.onProgress,
        });
        const collection = await Promise.all([
          moodle.getAnnouncements(),
          moodle.getAssignments(),
          moodle.getCourseFiles(),
          moodle.getUnclassifiedItems(),
        ]);
        return collection.flat();
      },
      store,
      report,
    ),
    outlook: () => collectOptionalSource(
      "outlook",
      "Outlook",
      (context) => collectOutlookEmailItems(context.onProgress, context.cursor, forceEnabled),
      store,
      report,
    ),
  };

  const items: AgentItem[] = [];
  for (const source of selectedSources) items.push(...await collectors[source]());
  return items;
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
    if (event.type === "source_progress") {
      runRecord = {
        ...runRecord,
        sourceProgress: {
          ...(runRecord.sourceProgress ?? {}),
          [event.source]: {
            label: event.label,
            status: event.status,
            updatedAt: eventAt,
            ...(event.detail === undefined ? {} : { detail: event.detail }),
            ...(event.coverage === undefined ? {} : { coverage: event.coverage }),
          },
        },
      };
    } else if (event.type === "stage") {
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
    const selectedSourceOrder = options.sourceOrder ?? defaultSourceOrder;
    emit({ type: "run_started", runId, at: now.toISOString() });
    emit({ type: "stage", runId, at: new Date().toISOString(), stage: "collect", status: "started", label: stageLabels.collect });
    for (const source of selectedSourceOrder) {
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
      for (const source of selectedSourceOrder) {
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
      const selectedItems = new Set<AgentItem["source"]>();
      if (selectedSourceOrder.includes("downloads")) selectedItems.add("downloads");
      if (selectedSourceOrder.includes("calendar")) selectedItems.add("calendar");
      if (selectedSourceOrder.includes("gmail") || selectedSourceOrder.includes("outlook")) selectedItems.add("email");
      if (selectedSourceOrder.includes("github")) selectedItems.add("github");
      if (selectedSourceOrder.includes("news")) selectedItems.add("news");
      if (selectedSourceOrder.includes("edstem")) selectedItems.add("edstem");
      if (selectedSourceOrder.includes("moodle")) selectedItems.add("moodle");
      collected = (await collectMockItems()).filter((item) => selectedItems.has(item.source));
    } else {
      collected = await collectRealItems(store, (progress) => emit({
        type: "source_progress",
        runId,
        at: new Date().toISOString(),
        ...progress,
      }), selectedSourceOrder, options.sourceOrder !== undefined);
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
    let decisions: DecisionRecord[];
    try {
      decisions = (await Promise.all(items.map((item) => decisionEngine.evaluateItem(item)))).flat();
    } finally {
      await decisionEngine.close?.();
    }
    persistDecisions(store, decisions);
    emit({ type: "stage", runId, at: new Date().toISOString(), stage: "jev", status: "completed", label: stageLabels.jev });
    emit({ type: "decisions_completed", runId, at: new Date().toISOString(), count: decisions.length });

    for (const item of items) {
      if (item.deadline === undefined) continue;
      store.recordDeadline({ id: item.id, source: item.source, title: item.title, deadline: item.deadline }, now);
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
    const report = createMorningReport({ now, items, decisions, actions, newItemIds });
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
      console.error(
        "Set LAYA_MLX_ENABLED=true with the local runtime, set TYPESAFE_API_KEY, or run: npm run morning -- --mock",
      );
    }
    process.exitCode = 1;
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

export { parseOptions };
