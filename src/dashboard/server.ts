import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runMorning } from "../index.js";
import { defaultSettings } from "../config/settings.js";
import { isSensitiveDownloadName, shouldIgnoreDownload } from "../collectors/downloads.js";
import { createStore } from "../storage/db.js";
import {
  agentSources,
  type AgentItem,
  type DecisionName,
  type DecisionRecord,
  type MorningRunEvent,
  type MorningRunStage,
  type ReviewStatus,
  type StoredAgentItem,
} from "../types/index.js";

const dashboardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../dashboard");
const defaultHost = "127.0.0.1";
const defaultPort = 4_782;
const lowConfidenceThreshold = 0.75;

const decisionNames = new Set<DecisionName>([
  "requiresAction",
  "importantEmail",
  "detectDeadline",
  "shouldDownloadFile",
  "shouldCreateCalendarEvent",
  "worthReading",
]);

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

type DashboardRunState = {
  active: boolean;
  runId?: string;
  stage?: MorningRunStage;
  startedAt?: string;
  lastEventAt?: string;
  completedAt?: string;
  itemCount?: number;
  decisionCount?: number;
  actionCount?: number;
  error?: string;
};

type DashboardEvent = MorningRunEvent | { type: "state_invalidated"; at: string };

type SerializedItem = {
  id: string;
  source: AgentItem["source"];
  title: string;
  metadata: Record<string, unknown>;
  observedAt: string;
  content?: string;
  url?: string;
  createdAt?: string;
  deadline?: string;
};

type SerializedDecision = {
  itemId: string;
  decision: DecisionName;
  output: DecisionRecord["output"];
  model: string;
  decidedAt: string;
};

type SerializedReview = {
  itemId: string;
  decision: DecisionName;
  status: ReviewStatus;
  note?: string;
  updatedAt: string;
};

type DashboardState = {
  generatedAt: string;
  run: DashboardRunState;
  metrics: {
    total: number;
    emails: number;
    github: number;
    edstem: number;
    news: number;
    work: number;
    moodle: number;
    downloads: number;
    unread: number;
    deadlines: number;
    lowConfidence: number;
    actionsCompleted: number;
  };
  sources: Record<string, number>;
  items: SerializedItem[];
  decisions: SerializedDecision[];
  reviews: SerializedReview[];
  actions: Array<{
    id: string;
    kind: string;
    itemId: string;
    status: string;
    description: string;
    createdAt: string;
  }>;
  deadlines: Array<{
    id: string;
    source: AgentItem["source"];
    title: string;
    deadline: string;
    firstSeenAt: string;
    lastSeenAt: string;
  }>;
  lowConfidence: Array<{
    item: SerializedItem;
    decision: SerializedDecision;
    review?: SerializedReview;
  }>;
};

const sseClients = new Set<ServerResponse>();

const loadPersistedRunState = (): DashboardRunState => {
  const store = createStore({ dbPath: defaultSettings.databasePath });
  try {
    const latest = store.getLatestRun();
    if (latest === undefined) return { active: false };
    const interrupted = latest.status === "running";
    return {
      active: false,
      runId: latest.runId,
      ...(latest.stage === undefined ? {} : { stage: latest.stage }),
      startedAt: latest.startedAt.toISOString(),
      lastEventAt: latest.lastEventAt.toISOString(),
      ...(latest.completedAt === undefined ? {} : { completedAt: latest.completedAt.toISOString() }),
      ...(latest.itemCount === undefined ? {} : { itemCount: latest.itemCount }),
      ...(latest.decisionCount === undefined ? {} : { decisionCount: latest.decisionCount }),
      ...(latest.actionCount === undefined ? {} : { actionCount: latest.actionCount }),
      ...(latest.error === undefined && !interrupted
        ? {}
        : { error: latest.error ?? "The previous run was interrupted." }),
    };
  } finally {
    store.close();
  }
};

let runState: DashboardRunState = loadPersistedRunState();
let activeRun: Promise<void> | undefined;

const nowIso = (): string => new Date().toISOString();

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
};

const sendError = (response: ServerResponse, status: number, message: string): void => {
  sendJson(response, status, { error: message });
};

const broadcast = (event: DashboardEvent): void => {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
};

const applyRunEvent = (event: MorningRunEvent): void => {
  switch (event.type) {
    case "run_started":
      runState = {
        active: true,
        runId: event.runId,
        startedAt: event.at,
        lastEventAt: event.at,
      };
      break;
    case "stage":
      runState = {
        ...runState,
        active: true,
        runId: event.runId,
        stage: event.stage,
        lastEventAt: event.at,
      };
      break;
    case "run_completed":
      runState = {
        ...runState,
        active: false,
        runId: event.runId,
        completedAt: event.at,
        lastEventAt: event.at,
        itemCount: event.itemCount,
        decisionCount: event.decisionCount,
        actionCount: event.actionCount,
      };
      delete runState.error;
      break;
    case "run_failed":
      runState = {
        ...runState,
        active: false,
        runId: event.runId,
        lastEventAt: event.at,
        error: event.error,
      };
      break;
    default:
      runState = { ...runState, lastEventAt: event.at };
      break;
  }
};

const serializeItem = (item: StoredAgentItem): SerializedItem => {
  const sensitiveDownload = item.source === "downloads" && isSensitiveDownloadName(item.title);
  const metadata = sensitiveDownload
    ? Object.fromEntries(Object.entries(item.metadata).map(([key, value]) => {
        if (key === "filename") return [key, "[sensitive filename redacted]"];
        if (/^(?:path|sourcePath|destinationPath)$/iu.test(key)) return [key, "[local path redacted]"];
        return [key, value];
      }))
    : item.metadata;
  const serialized: SerializedItem = {
    id: item.id,
    source: item.source,
    title: sensitiveDownload ? "[Sensitive downloaded file]" : item.title,
    metadata,
    observedAt: item.observedAt.toISOString(),
  };
  if (item.content !== undefined) serialized.content = item.content;
  if (item.url !== undefined) serialized.url = item.url;
  if (item.createdAt !== undefined) serialized.createdAt = item.createdAt.toISOString();
  if (item.deadline !== undefined) serialized.deadline = item.deadline.toISOString();
  return serialized;
};

const serializeDecision = (decision: DecisionRecord): SerializedDecision => ({
  itemId: decision.itemId,
  decision: decision.decision,
  output: decision.output,
  model: decision.model,
  decidedAt: decision.decidedAt.toISOString(),
});

const buildDashboardState = (): DashboardState => {
  const store = createStore({ dbPath: defaultSettings.databasePath });
  try {
    const items = store.getItems(1_000).filter(
      (item) => !(item.source === "downloads" && shouldIgnoreDownload(item.title)),
    );
    const latestDecisions = new Map<string, DecisionRecord>();
    for (const decision of store.getDecisions()) {
      latestDecisions.set(`${decision.itemId}:${decision.decision}`, decision);
    }
    const decisions = Array.from(latestDecisions.values()).sort(
      (left, right) => right.decidedAt.getTime() - left.decidedAt.getTime(),
    );
    const reviews = store.getReviews();
    const reviewByKey = new Map(reviews.map((review) => [`${review.itemId}:${review.decision}`, review]));
    const serializedItems = items.map(serializeItem);
    const serializedItemById = new Map(serializedItems.map((item) => [item.id, item]));
    const serializedDecisions = decisions.map(serializeDecision);

    const lowConfidence = decisions.flatMap((decision) => {
      if (decision.output.confidence >= lowConfidenceThreshold) return [];
      const item = serializedItemById.get(decision.itemId);
      if (item === undefined) return [];
      const review = reviewByKey.get(`${decision.itemId}:${decision.decision}`);
      const serializedReview = review === undefined
        ? undefined
        : {
            itemId: review.itemId,
            decision: review.decision,
            status: review.status,
            ...(review.note === undefined ? {} : { note: review.note }),
            updatedAt: review.updatedAt.toISOString(),
          };
      if (serializedReview !== undefined && new Date(serializedReview.updatedAt).getTime() >= decision.decidedAt.getTime()) return [];
      return [{
        item,
        decision: serializeDecision(decision),
        ...(serializedReview === undefined ? {} : { review: serializedReview }),
      }];
    });

    const sourceCounts: Record<string, number> = Object.fromEntries(
      agentSources.map((source) => [source, 0]),
    );
    for (const item of items) sourceCounts[item.source] = (sourceCounts[item.source] ?? 0) + 1;
    const deadlineNow = Date.now();
    const deadlineCutoff = deadlineNow + 7 * 24 * 60 * 60 * 1_000;
    const deadlines = store.getDeadlines().filter((deadline) => {
      const timestamp = deadline.deadline.getTime();
      return timestamp >= deadlineNow && timestamp <= deadlineCutoff;
    });
    const actions = store.getActions();

    return {
      generatedAt: nowIso(),
      run: runState,
      metrics: {
        total: items.length,
        emails: sourceCounts.email ?? 0,
        github: sourceCounts.github ?? 0,
        edstem: sourceCounts.edstem ?? 0,
        news: sourceCounts.news ?? 0,
        work: (sourceCounts.github ?? 0) + (sourceCounts.calendar ?? 0),
        moodle: sourceCounts.moodle ?? 0,
        downloads: sourceCounts.downloads ?? 0,
        unread: items.filter((item) => item.metadata.unread === true).length,
        deadlines: deadlines.length,
        lowConfidence: lowConfidence.length,
        actionsCompleted: actions.filter((action) => action.status === "completed").length,
      },
      sources: sourceCounts,
      items: serializedItems,
      decisions: serializedDecisions,
      reviews: reviews.map((review) => ({
        itemId: review.itemId,
        decision: review.decision,
        status: review.status,
        ...(review.note === undefined ? {} : { note: review.note }),
        updatedAt: review.updatedAt.toISOString(),
      })),
      actions: actions.map((action) => ({
        id: action.id,
        kind: action.kind,
        itemId: action.itemId,
        status: action.status,
        description: action.description,
        createdAt: action.createdAt.toISOString(),
      })),
      deadlines: deadlines.map((deadline) => ({
        id: deadline.id,
        source: deadline.source,
        title: deadline.title,
        deadline: deadline.deadline.toISOString(),
        firstSeenAt: deadline.firstSeenAt.toISOString(),
        lastSeenAt: deadline.lastSeenAt.toISOString(),
      })),
      lowConfidence,
    };
  } finally {
    store.close();
  }
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 32_000) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const startRun = (mock: boolean): void => {
  if (activeRun !== undefined) return;
  activeRun = runMorning({
    dryRun: true,
    mock,
    verbose: false,
    persist: true,
    onEvent: (event) => {
      applyRunEvent(event);
      broadcast(event);
      if (
        event.type === "run_completed" ||
        event.type === "run_failed" ||
        (event.type === "stage" && event.status === "completed")
      ) {
        broadcast({ type: "state_invalidated", at: nowIso() });
      }
    },
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      activeRun = undefined;
    });
};

const handleApi = async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> => {
  if (request.method === "GET" && pathname === "/api/state") {
    sendJson(response, 200, buildDashboardState());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`event: connected\ndata: ${JSON.stringify({ type: "connected", at: nowIso() })}\n\n`);
    sseClients.add(response);
    request.on("close", () => sseClients.delete(response));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/run") {
    if (activeRun !== undefined || runState.active) {
      sendError(response, 409, "A run is already in progress.");
      return true;
    }
    let body: unknown;
    try {
      body = await readBody(request);
    } catch (error: unknown) {
      sendError(response, 400, error instanceof Error ? error.message : "Invalid request.");
      return true;
    }
    const mock = isRecord(body) && body.mock === true;
    startRun(mock);
    sendJson(response, 202, { ok: true, mode: mock ? "demo" : "live" });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/reviews") {
    let body: unknown;
    try {
      body = await readBody(request);
    } catch (error: unknown) {
      sendError(response, 400, error instanceof Error ? error.message : "Invalid request.");
      return true;
    }
    if (!isRecord(body) || typeof body.itemId !== "string" || !decisionNames.has(body.decision as DecisionName)) {
      sendError(response, 400, "itemId and a supported decision are required.");
      return true;
    }
    if (body.status !== "approved" && body.status !== "dismissed") {
      sendError(response, 400, "status must be approved or dismissed.");
      return true;
    }
    const decision = body.decision as DecisionName;
    const store = createStore({ dbPath: defaultSettings.databasePath });
    try {
      if (store.getItem(body.itemId) === undefined) {
        sendError(response, 404, "Item not found.");
        return true;
      }
      store.recordReview({
        itemId: body.itemId,
        decision,
        status: body.status as ReviewStatus,
        ...(typeof body.note === "string" && body.note.trim().length > 0 ? { note: body.note.trim() } : {}),
        updatedAt: new Date(),
      });
    } finally {
      store.close();
    }
    broadcast({ type: "state_invalidated", at: nowIso() });
    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
};

const serveStatic = async (response: ServerResponse, pathname: string): Promise<void> => {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\//u, "");
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(relativePath);
  } catch {
    sendError(response, 400, "Invalid path.");
    return;
  }
  const filePath = resolve(join(dashboardRoot, decodedPath));
  if (filePath !== dashboardRoot && !filePath.startsWith(`${dashboardRoot}/`)) {
    sendError(response, 403, "Forbidden.");
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    sendError(response, 404, "Not found.");
  }
};

export const startDashboardServer = (options: { host?: string; port?: number } = {}) => {
  const host = options.host ?? process.env.MORNING_AGENT_DASHBOARD_HOST ?? defaultHost;
  const configuredPort = process.env.MORNING_AGENT_DASHBOARD_PORT;
  const parsedPort = configuredPort === undefined ? undefined : Number(configuredPort);
  const port = options.port ?? (parsedPort !== undefined && Number.isInteger(parsedPort) ? parsedPort : defaultPort);
  const server = createServer((request, response) => {
    const parsedUrl = new URL(request.url ?? "/", `http://${host}:${port}`);
    void handleApi(request, response, parsedUrl.pathname)
      .then((handled) => {
        if (!handled && request.method === "GET") return serveStatic(response, parsedUrl.pathname);
        if (!handled) sendError(response, 405, "Method not allowed.");
        return undefined;
      })
      .catch((error: unknown) => {
        if (!response.headersSent) {
          sendError(response, 500, error instanceof Error ? error.message : "Dashboard request failed.");
        } else {
          response.end();
        }
      });
  });

  server.listen(port, host, () => {
    console.log(`Morning Agent dashboard: http://${host}:${port}`);
  });
  return server;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  startDashboardServer();
}
