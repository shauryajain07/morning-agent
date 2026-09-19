import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

import { initializeSchema } from "./schema.js";
import {
  agentSources,
  emailCategories,
  fileTypes,
} from "../types/index.js";
import type {
  ActionKind,
  ActionRecord,
  ActionStatus,
  AgentItem,
  AgentSource,
  CalendarActionDecision,
  DecisionName,
  DecisionOutput,
  DecisionRecord,
  DeadlineDecision,
  EmailCategory,
  FileDownloadDecision,
  FileType,
  ImportantEmailDecision,
  RequiresActionDecision,
  ReviewRecord,
  ReviewStatus,
  StoredAgentItem,
  Urgency,
} from "../types/index.js";

export const DEFAULT_DB_PATH = resolve(
  process.cwd(),
  ".data",
  "morning-agent.sqlite",
);

export type StoreOptions = {
  dbPath?: string;
};

export type SeenItemFingerprintRecord = {
  fingerprint: string;
  seenAt: Date;
};

export type DeadlineInput = Pick<AgentItem, "id" | "source" | "title"> & {
  deadline: Date;
};

export type DeadlineRecord = DeadlineInput & {
  fingerprint: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

type SeenItemFingerprintRow = {
  fingerprint: string;
  seen_at: string;
};

type DeadlineRow = {
  fingerprint: string;
  item_id: string;
  source: string;
  title: string;
  deadline_at: string;
  first_seen_at: string;
  last_seen_at: string;
};

type DecisionRow = {
  item_id: string;
  decision: string;
  output_json: string;
  model: string;
  decided_at: string;
};

type ActionRow = {
  id: string;
  kind: string;
  item_id: string;
  status: string;
  description: string;
  created_at: string;
};

type ItemRow = {
  id: string;
  source: string;
  title: string;
  content: string | null;
  url: string | null;
  created_at: string | null;
  deadline_at: string | null;
  metadata_json: string;
  observed_at: string;
};

type ReviewRow = {
  item_id: string;
  decision: string;
  status: string;
  note: string | null;
  updated_at: string;
};

const urgencies = ["today", "soon", "later", "none"] as const;
const decisionNames = [
  "requiresAction",
  "importantEmail",
  "detectDeadline",
  "shouldDownloadFile",
  "shouldCreateCalendarEvent",
] as const;
const actionKinds = [
  "downloadFile",
  "moveFile",
  "createCalendarEvent",
  "createTask",
] as const;
const actionStatuses = [
  "completed",
  "suggested",
  "manual_review",
  "skipped",
] as const;
const reviewStatuses = ["approved", "dismissed"] as const;

function isOneOf<Value extends string>(
  values: readonly Value[],
  value: unknown,
): value is Value {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyText(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
}

function assertValidDate(value: unknown, fieldName: string): asserts value is Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${fieldName} must be a valid Date`);
  }
}

function serializeDate(value: Date): string {
  assertValidDate(value, "date");
  return JSON.stringify(value.toISOString());
}

function parseJson(value: string, fieldName: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    throw new Error(`Stored ${fieldName} is not valid JSON`);
  }
}

function serializeJson(value: unknown, fieldName: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError(`${fieldName} could not be serialized as JSON`);
  }
  return serialized;
}

function deserializeDate(value: string, fieldName: string): Date {
  const parsed = parseJson(value, fieldName);
  if (typeof parsed !== "string") {
    throw new Error(`Stored ${fieldName} must contain a JSON date string`);
  }

  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Stored ${fieldName} is not a valid date`);
  }
  return date;
}

function isConfidence(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isAgentSource(value: unknown): value is AgentSource {
  return isOneOf(agentSources, value);
}

function isDecisionName(value: unknown): value is DecisionName {
  return isOneOf(decisionNames, value);
}

function isActionKind(value: unknown): value is ActionKind {
  return isOneOf(actionKinds, value);
}

function isActionStatus(value: unknown): value is ActionStatus {
  return isOneOf(actionStatuses, value);
}

function isReviewStatus(value: unknown): value is ReviewStatus {
  return isOneOf(reviewStatuses, value);
}

function validateDecisionOutput(
  decision: DecisionName,
  output: DecisionOutput,
): void {
  parseDecisionOutput(decision, serializeJson(output, "decision output"));
}

function parseDecisionOutput(
  decision: DecisionName,
  serializedOutput: string,
): DecisionOutput {
  const value = parseJson(serializedOutput, "decision output");
  if (!isRecord(value)) {
    throw new Error("Stored decision output must be a JSON object");
  }

  switch (decision) {
    case "requiresAction": {
      const actionRequired = value.actionRequired;
      const urgency = value.urgency;
      const confidence = value.confidence;
      if (
        typeof actionRequired !== "boolean" ||
        !isOneOf(urgencies, urgency) ||
        !isConfidence(confidence)
      ) {
        throw new Error("Stored requiresAction output has an invalid shape");
      }
      const result: RequiresActionDecision = {
        actionRequired,
        urgency,
        confidence,
      };
      return result;
    }
    case "importantEmail": {
      const important = value.important;
      const category = value.category;
      const requiresReply = value.requiresReply;
      const confidence = value.confidence;
      if (
        typeof important !== "boolean" ||
        !isOneOf(emailCategories, category) ||
        typeof requiresReply !== "boolean" ||
        !isConfidence(confidence)
      ) {
        throw new Error("Stored importantEmail output has an invalid shape");
      }
      const result: ImportantEmailDecision = {
        important,
        category,
        requiresReply,
        confidence,
      };
      return result;
    }
    case "detectDeadline": {
      const hasDeadline = value.hasDeadline;
      const confidence = value.confidence;
      if (typeof hasDeadline !== "boolean" || !isConfidence(confidence)) {
        throw new Error("Stored detectDeadline output has an invalid shape");
      }
      const result: DeadlineDecision = { hasDeadline, confidence };
      if (value.deadline !== undefined) {
        if (typeof value.deadline !== "string") {
          throw new Error("Stored detectDeadline deadline must be a string");
        }
        result.deadline = value.deadline;
      }
      return result;
    }
    case "shouldDownloadFile": {
      const download = value.download;
      const fileType = value.fileType;
      const confidence = value.confidence;
      if (
        typeof download !== "boolean" ||
        !isOneOf(fileTypes, fileType) ||
        !isConfidence(confidence)
      ) {
        throw new Error("Stored shouldDownloadFile output has an invalid shape");
      }
      const result: FileDownloadDecision = {
        download,
        fileType,
        confidence,
      };
      if (value.course !== undefined) {
        if (typeof value.course !== "string") {
          throw new Error("Stored shouldDownloadFile course must be a string");
        }
        result.course = value.course;
      }
      return result;
    }
    case "shouldCreateCalendarEvent": {
      const createEvent = value.createEvent;
      const confidence = value.confidence;
      if (typeof createEvent !== "boolean" || !isConfidence(confidence)) {
        throw new Error(
          "Stored shouldCreateCalendarEvent output has an invalid shape",
        );
      }
      const result: CalendarActionDecision = { createEvent, confidence };
      if (value.title !== undefined) {
        if (typeof value.title !== "string") {
          throw new Error("Stored calendar event title must be a string");
        }
        result.title = value.title;
      }
      if (value.startTime !== undefined) {
        if (typeof value.startTime !== "string") {
          throw new Error("Stored calendar event startTime must be a string");
        }
        result.startTime = value.startTime;
      }
      if (value.endTime !== undefined) {
        if (typeof value.endTime !== "string") {
          throw new Error("Stored calendar event endTime must be a string");
        }
        result.endTime = value.endTime;
      }
      return result;
    }
  }
}

function deadlineFingerprint(deadline: DeadlineInput): string {
  return serializeJson(
    {
      source: deadline.source,
      itemId: deadline.id,
      deadline: deadline.deadline.toISOString(),
    },
    "deadline fingerprint",
  );
}

function validateDeadline(deadline: DeadlineInput): void {
  assertNonEmptyText(deadline.id, "deadline.id");
  assertNonEmptyText(deadline.title, "deadline.title");
  if (!isAgentSource(deadline.source)) {
    throw new TypeError("deadline.source is not a supported agent source");
  }
  assertValidDate(deadline.deadline, "deadline.deadline");
}

function validateDecision(record: DecisionRecord): void {
  assertNonEmptyText(record.itemId, "decision.itemId");
  assertNonEmptyText(record.model, "decision.model");
  if (!isDecisionName(record.decision)) {
    throw new TypeError("decision.decision is not a supported decision name");
  }
  assertValidDate(record.decidedAt, "decision.decidedAt");
  validateDecisionOutput(record.decision, record.output);
}

function validateAction(record: ActionRecord): void {
  assertNonEmptyText(record.id, "action.id");
  assertNonEmptyText(record.itemId, "action.itemId");
  assertNonEmptyText(record.description, "action.description");
  if (!isActionKind(record.kind)) {
    throw new TypeError("action.kind is not a supported action kind");
  }
  if (!isActionStatus(record.status)) {
    throw new TypeError("action.status is not a supported action status");
  }
  assertValidDate(record.createdAt, "action.createdAt");
}

function validateItem(item: AgentItem): void {
  assertNonEmptyText(item.id, "item.id");
  assertNonEmptyText(item.title, "item.title");
  if (!isAgentSource(item.source)) {
    throw new TypeError("item.source is not a supported agent source");
  }
  if (item.content !== undefined) assertNonEmptyText(item.content, "item.content");
  if (item.url !== undefined) assertNonEmptyText(item.url, "item.url");
  if (item.createdAt !== undefined) assertValidDate(item.createdAt, "item.createdAt");
  if (item.deadline !== undefined) assertValidDate(item.deadline, "item.deadline");
  if (!isRecord(item.metadata)) {
    throw new TypeError("item.metadata must be a record");
  }
}

function validateReview(record: ReviewRecord): void {
  assertNonEmptyText(record.itemId, "review.itemId");
  if (!isDecisionName(record.decision)) {
    throw new TypeError("review.decision is not a supported decision name");
  }
  if (!isReviewStatus(record.status)) {
    throw new TypeError("review.status is not a supported review status");
  }
  if (record.note !== undefined) assertNonEmptyText(record.note, "review.note");
  assertValidDate(record.updatedAt, "review.updatedAt");
}

function parseSeenItemFingerprint(row: SeenItemFingerprintRow): SeenItemFingerprintRecord {
  return {
    fingerprint: row.fingerprint,
    seenAt: deserializeDate(row.seen_at, "seen item timestamp"),
  };
}

function parseDeadline(row: DeadlineRow): DeadlineRecord {
  if (!isAgentSource(row.source)) {
    throw new Error(`Stored deadline has an unsupported source: ${row.source}`);
  }
  return {
    id: row.item_id,
    source: row.source,
    title: row.title,
    deadline: deserializeDate(row.deadline_at, "deadline timestamp"),
    fingerprint: row.fingerprint,
    firstSeenAt: deserializeDate(row.first_seen_at, "deadline first-seen timestamp"),
    lastSeenAt: deserializeDate(row.last_seen_at, "deadline last-seen timestamp"),
  };
}

function parseDecision(row: DecisionRow): DecisionRecord {
  if (!isDecisionName(row.decision)) {
    throw new Error(`Stored decision has an unsupported name: ${row.decision}`);
  }
  return {
    itemId: row.item_id,
    decision: row.decision,
    output: parseDecisionOutput(row.decision, row.output_json),
    model: row.model,
    decidedAt: deserializeDate(row.decided_at, "decision timestamp"),
  };
}

function parseAction(row: ActionRow): ActionRecord {
  if (!isActionKind(row.kind)) {
    throw new Error(`Stored action has an unsupported kind: ${row.kind}`);
  }
  if (!isActionStatus(row.status)) {
    throw new Error(`Stored action has an unsupported status: ${row.status}`);
  }
  return {
    id: row.id,
    kind: row.kind,
    itemId: row.item_id,
    status: row.status,
    description: row.description,
    createdAt: deserializeDate(row.created_at, "action timestamp"),
  };
}

function parseStoredItem(row: ItemRow): StoredAgentItem {
  if (!isAgentSource(row.source)) {
    throw new Error(`Stored item has an unsupported source: ${row.source}`);
  }
  const metadata = parseJson(row.metadata_json, "item metadata");
  if (!isRecord(metadata)) {
    throw new Error("Stored item metadata must be a JSON object");
  }
  const item: AgentItem = {
    id: row.id,
    source: row.source,
    title: row.title,
    metadata,
    ...(row.content === null ? {} : { content: row.content }),
    ...(row.url === null ? {} : { url: row.url }),
    ...(row.created_at === null ? {} : { createdAt: deserializeDate(row.created_at, "item created timestamp") }),
    ...(row.deadline_at === null ? {} : { deadline: deserializeDate(row.deadline_at, "item deadline timestamp") }),
  };
  return {
    ...item,
    observedAt: deserializeDate(row.observed_at, "item observed timestamp"),
  };
}

function parseReview(row: ReviewRow): ReviewRecord {
  if (!isDecisionName(row.decision)) {
    throw new Error(`Stored review has an unsupported decision: ${row.decision}`);
  }
  if (!isReviewStatus(row.status)) {
    throw new Error(`Stored review has an unsupported status: ${row.status}`);
  }
  return {
    itemId: row.item_id,
    decision: row.decision,
    status: row.status,
    ...(row.note === null ? {} : { note: row.note }),
    updatedAt: deserializeDate(row.updated_at, "review timestamp"),
  };
}

function ensureParentDirectory(dbPath: string): void {
  if (dbPath === ":memory:") {
    return;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
}

export class MorningAgentStore {
  public readonly dbPath: string;

  private readonly database: Database.Database;

  public constructor(options: StoreOptions | string = {}) {
    const configuredPath =
      typeof options === "string" ? options : options.dbPath;
    const dbPath = configuredPath ?? DEFAULT_DB_PATH;
    assertNonEmptyText(dbPath, "dbPath");
    ensureParentDirectory(dbPath);

    this.dbPath = dbPath;
    this.database = new Database(dbPath);
    initializeSchema(this.database);
  }

  public close(): void {
    if (this.database.open) {
      this.database.close();
    }
  }

  public recordSeenItemFingerprint(
    fingerprint: string,
    seenAt: Date = new Date(),
  ): boolean {
    assertNonEmptyText(fingerprint, "fingerprint");
    const result = this.database
      .prepare<{ fingerprint: string; seenAt: string }, unknown>(
        `
          INSERT INTO seen_item_fingerprints (fingerprint, seen_at)
          VALUES (@fingerprint, @seenAt)
          ON CONFLICT(fingerprint) DO NOTHING
        `,
      )
      .run({ fingerprint, seenAt: serializeDate(seenAt) });
    return result.changes > 0;
  }

  public hasSeenItemFingerprint(fingerprint: string): boolean {
    assertNonEmptyText(fingerprint, "fingerprint");
    const row = this.database
      .prepare<{ fingerprint: string }, SeenItemFingerprintRow>(
        `
          SELECT fingerprint, seen_at
          FROM seen_item_fingerprints
          WHERE fingerprint = @fingerprint
        `,
      )
      .get({ fingerprint });
    return row !== undefined;
  }

  public getSeenItemFingerprint(
    fingerprint: string,
  ): SeenItemFingerprintRecord | undefined {
    assertNonEmptyText(fingerprint, "fingerprint");
    const row = this.database
      .prepare<{ fingerprint: string }, SeenItemFingerprintRow>(
        `
          SELECT fingerprint, seen_at
          FROM seen_item_fingerprints
          WHERE fingerprint = @fingerprint
        `,
      )
      .get({ fingerprint });
    return row === undefined ? undefined : parseSeenItemFingerprint(row);
  }

  public getSeenItemFingerprints(): SeenItemFingerprintRecord[] {
    const rows = this.database
      .prepare<[], SeenItemFingerprintRow>(
        `
          SELECT fingerprint, seen_at
          FROM seen_item_fingerprints
          ORDER BY seen_at ASC, fingerprint ASC
        `,
      )
      .all();
    return rows.map(parseSeenItemFingerprint);
  }

  public isNewDeadline(deadline: DeadlineInput): boolean {
    validateDeadline(deadline);
    const fingerprint = deadlineFingerprint(deadline);
    const row = this.database
      .prepare<{ fingerprint: string }, DeadlineRow>(
        `
          SELECT fingerprint
          FROM deadlines
          WHERE fingerprint = @fingerprint
        `,
      )
      .get({ fingerprint });
    return row === undefined;
  }

  public recordDeadline(
    deadline: DeadlineInput,
    seenAt: Date = new Date(),
  ): boolean {
    validateDeadline(deadline);
    assertValidDate(seenAt, "deadline.seenAt");
    const fingerprint = deadlineFingerprint(deadline);
    const firstSeenAt = serializeDate(seenAt);
    const isNew = this.isNewDeadline(deadline);

    this.database
      .prepare<
        {
          fingerprint: string;
          itemId: string;
          source: AgentSource;
          title: string;
          deadlineAt: string;
          seenAt: string;
        },
        unknown
      >(
        `
          INSERT INTO deadlines (
            fingerprint,
            item_id,
            source,
            title,
            deadline_at,
            first_seen_at,
            last_seen_at
          )
          VALUES (
            @fingerprint,
            @itemId,
            @source,
            @title,
            @deadlineAt,
            @seenAt,
            @seenAt
          )
          ON CONFLICT(fingerprint) DO UPDATE SET
            item_id = excluded.item_id,
            source = excluded.source,
            title = excluded.title,
            deadline_at = excluded.deadline_at,
            last_seen_at = excluded.last_seen_at
        `,
      )
      .run({
        fingerprint,
        itemId: deadline.id,
        source: deadline.source,
        title: deadline.title,
        deadlineAt: serializeDate(deadline.deadline),
        seenAt: firstSeenAt,
      });

    return isNew;
  }

  public getDeadline(deadline: DeadlineInput): DeadlineRecord | undefined {
    validateDeadline(deadline);
    const fingerprint = deadlineFingerprint(deadline);
    const row = this.database
      .prepare<{ fingerprint: string }, DeadlineRow>(
        `
          SELECT
            fingerprint,
            item_id,
            source,
            title,
            deadline_at,
            first_seen_at,
            last_seen_at
          FROM deadlines
          WHERE fingerprint = @fingerprint
        `,
      )
      .get({ fingerprint });
    return row === undefined ? undefined : parseDeadline(row);
  }

  public getDeadlines(itemId?: string): DeadlineRecord[] {
    if (itemId !== undefined) {
      assertNonEmptyText(itemId, "itemId");
      const rows = this.database
        .prepare<{ itemId: string }, DeadlineRow>(
          `
            SELECT
              fingerprint,
              item_id,
              source,
              title,
              deadline_at,
              first_seen_at,
              last_seen_at
            FROM deadlines
            WHERE item_id = @itemId
            ORDER BY deadline_at ASC, fingerprint ASC
          `,
        )
        .all({ itemId });
      return rows.map(parseDeadline);
    }

    const rows = this.database
      .prepare<[], DeadlineRow>(
        `
          SELECT
            fingerprint,
            item_id,
            source,
            title,
            deadline_at,
            first_seen_at,
            last_seen_at
          FROM deadlines
          ORDER BY deadline_at ASC, fingerprint ASC
        `,
      )
      .all();
    return rows.map(parseDeadline);
  }

  public recordDecision(record: DecisionRecord): void {
    validateDecision(record);
    this.database
      .prepare<
        {
          itemId: string;
          decision: DecisionName;
          outputJson: string;
          model: string;
          decidedAt: string;
        },
        unknown
      >(
        `
          INSERT INTO decision_outputs (
            item_id,
            decision,
            output_json,
            model,
            decided_at
          )
          VALUES (
            @itemId,
            @decision,
            @outputJson,
            @model,
            @decidedAt
          )
        `,
      )
      .run({
        itemId: record.itemId,
        decision: record.decision,
        outputJson: serializeJson(record.output, "decision output"),
        model: record.model,
        decidedAt: serializeDate(record.decidedAt),
      });
  }

  public getDecision(
    itemId: string,
    decision: DecisionName,
  ): DecisionRecord | undefined {
    assertNonEmptyText(itemId, "itemId");
    if (!isDecisionName(decision)) {
      throw new TypeError("decision is not a supported decision name");
    }
    const row = this.database
      .prepare<{ itemId: string; decision: DecisionName }, DecisionRow>(
        `
          SELECT item_id, decision, output_json, model, decided_at
          FROM decision_outputs
          WHERE item_id = @itemId AND decision = @decision
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get({ itemId, decision });
    return row === undefined ? undefined : parseDecision(row);
  }

  public getDecisions(itemId?: string): DecisionRecord[] {
    if (itemId !== undefined) {
      assertNonEmptyText(itemId, "itemId");
      const rows = this.database
        .prepare<{ itemId: string }, DecisionRow>(
          `
            SELECT item_id, decision, output_json, model, decided_at
            FROM decision_outputs
            WHERE item_id = @itemId
            ORDER BY id ASC
          `,
        )
        .all({ itemId });
      return rows.map(parseDecision);
    }

    const rows = this.database
      .prepare<[], DecisionRow>(
        `
          SELECT item_id, decision, output_json, model, decided_at
          FROM decision_outputs
          ORDER BY id ASC
        `,
      )
      .all();
    return rows.map(parseDecision);
  }

  public recordAction(record: ActionRecord): void {
    validateAction(record);
    this.database
      .prepare<
        {
          id: string;
          kind: ActionKind;
          itemId: string;
          status: ActionStatus;
          description: string;
          createdAt: string;
        },
        unknown
      >(
        `
          INSERT INTO action_records (
            id,
            kind,
            item_id,
            status,
            description,
            created_at
          )
          VALUES (
            @id,
            @kind,
            @itemId,
            @status,
            @description,
            @createdAt
          )
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            item_id = excluded.item_id,
            status = excluded.status,
            description = excluded.description,
            created_at = excluded.created_at
        `,
      )
      .run({
        id: record.id,
        kind: record.kind,
        itemId: record.itemId,
        status: record.status,
        description: record.description,
        createdAt: serializeDate(record.createdAt),
      });
  }

  public getAction(id: string): ActionRecord | undefined {
    assertNonEmptyText(id, "id");
    const row = this.database
      .prepare<{ id: string }, ActionRow>(
        `
          SELECT id, kind, item_id, status, description, created_at
          FROM action_records
          WHERE id = @id
        `,
      )
      .get({ id });
    return row === undefined ? undefined : parseAction(row);
  }

  public getActions(itemId?: string): ActionRecord[] {
    if (itemId !== undefined) {
      assertNonEmptyText(itemId, "itemId");
      const rows = this.database
        .prepare<{ itemId: string }, ActionRow>(
          `
            SELECT id, kind, item_id, status, description, created_at
            FROM action_records
            WHERE item_id = @itemId
            ORDER BY created_at ASC, id ASC
          `,
        )
        .all({ itemId });
      return rows.map(parseAction);
    }

    const rows = this.database
      .prepare<[], ActionRow>(
        `
          SELECT id, kind, item_id, status, description, created_at
          FROM action_records
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all();
    return rows.map(parseAction);
  }

  public recordItem(item: AgentItem, observedAt: Date = new Date()): void {
    validateItem(item);
    assertValidDate(observedAt, "item.observedAt");
    this.database
      .prepare<
        {
          id: string;
          source: AgentSource;
          title: string;
          content: string | null;
          url: string | null;
          createdAt: string | null;
          deadlineAt: string | null;
          metadataJson: string;
          observedAt: string;
        },
        unknown
      >(
        `
          INSERT INTO item_records (
            id, source, title, content, url, created_at, deadline_at, metadata_json, observed_at
          )
          VALUES (
            @id, @source, @title, @content, @url, @createdAt, @deadlineAt, @metadataJson, @observedAt
          )
          ON CONFLICT(id) DO UPDATE SET
            source = excluded.source,
            title = excluded.title,
            content = excluded.content,
            url = excluded.url,
            created_at = excluded.created_at,
            deadline_at = excluded.deadline_at,
            metadata_json = excluded.metadata_json,
            observed_at = excluded.observed_at
        `,
      )
      .run({
        id: item.id,
        source: item.source,
        title: item.title,
        content: item.content ?? null,
        url: item.url ?? null,
        createdAt: item.createdAt === undefined ? null : serializeDate(item.createdAt),
        deadlineAt: item.deadline === undefined ? null : serializeDate(item.deadline),
        metadataJson: serializeJson(item.metadata, "item metadata"),
        observedAt: serializeDate(observedAt),
      });
  }

  public getItem(id: string): StoredAgentItem | undefined {
    assertNonEmptyText(id, "id");
    const row = this.database
      .prepare<{ id: string }, ItemRow>(
        `
          SELECT id, source, title, content, url, created_at, deadline_at, metadata_json, observed_at
          FROM item_records
          WHERE id = @id
        `,
      )
      .get({ id });
    return row === undefined ? undefined : parseStoredItem(row);
  }

  public getItems(limit = 500): StoredAgentItem[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      throw new TypeError("limit must be an integer from 1 to 5000");
    }
    const rows = this.database
      .prepare<{ limit: number }, ItemRow>(
        `
          SELECT id, source, title, content, url, created_at, deadline_at, metadata_json, observed_at
          FROM item_records
          ORDER BY observed_at DESC, id ASC
          LIMIT @limit
        `,
      )
      .all({ limit });
    return rows.map(parseStoredItem);
  }

  public recordReview(record: ReviewRecord): void {
    validateReview(record);
    this.database
      .prepare<
        { itemId: string; decision: DecisionName; status: ReviewStatus; note: string | null; updatedAt: string },
        unknown
      >(
        `
          INSERT INTO review_records (item_id, decision, status, note, updated_at)
          VALUES (@itemId, @decision, @status, @note, @updatedAt)
          ON CONFLICT(item_id, decision) DO UPDATE SET
            status = excluded.status,
            note = excluded.note,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        itemId: record.itemId,
        decision: record.decision,
        status: record.status,
        note: record.note ?? null,
        updatedAt: serializeDate(record.updatedAt),
      });
  }

  public getReview(itemId: string, decision: DecisionName): ReviewRecord | undefined {
    assertNonEmptyText(itemId, "itemId");
    if (!isDecisionName(decision)) throw new TypeError("decision is not a supported decision name");
    const row = this.database
      .prepare<{ itemId: string; decision: DecisionName }, ReviewRow>(
        `
          SELECT item_id, decision, status, note, updated_at
          FROM review_records
          WHERE item_id = @itemId AND decision = @decision
        `,
      )
      .get({ itemId, decision });
    return row === undefined ? undefined : parseReview(row);
  }

  public getReviews(): ReviewRecord[] {
    const rows = this.database
      .prepare<[], ReviewRow>(
        `
          SELECT item_id, decision, status, note, updated_at
          FROM review_records
          ORDER BY updated_at DESC, item_id ASC, decision ASC
        `,
      )
      .all();
    return rows.map(parseReview);
  }
}

export const LocalStore = MorningAgentStore;

export function createStore(options: StoreOptions | string = {}): MorningAgentStore {
  return new MorningAgentStore(options);
}
