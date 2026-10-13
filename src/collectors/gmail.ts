import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import type { AgentItem, SourceCoverage } from "../types/index.js";
import type { BrowserNavigationProgress } from "./browserReliability.js";

export type GmailMessageSnapshot = {
  id: string;
  threadId?: string | undefined;
  labelIds?: string[] | undefined;
  internalDate?: string | undefined;
  snippet?: string | undefined;
  payload?: GmailMessagePart | undefined;
};

export type GmailMessagePart = {
  mimeType?: string | undefined;
  filename?: string | undefined;
  attachmentTextMissed?: boolean | undefined;
  headers?: GmailHeader[] | undefined;
  body?: GmailMessageBody | undefined;
  parts?: GmailMessagePart[] | undefined;
};

export type GmailHeader = {
  name: string;
  value: string;
};

export type GmailMessageBody = {
  data?: string | undefined;
  attachmentId?: string | undefined;
  size?: number | undefined;
};

export type GmailProviderOptions = {
  enabled?: boolean;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  credentialsPath?: string;
  tokenPath?: string;
  userId?: string;
  query?: string;
  lookbackHours?: number;
  maxMessages?: number;
  includeSpamTrash?: boolean;
  timeoutMs?: number;
};

export class GmailConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GmailConfigurationError";
  }
}

export class GmailApiError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "GmailApiError";
  }
}

const defaultLookbackHours = 24;
const defaultMaxMessages = 500;
const defaultTimeoutMs = 15_000;
const gmailApiBaseUrl = "https://gmail.googleapis.com/gmail/v1/users";
const tokenEndpoint = "https://oauth2.googleapis.com/token";

const gmailHeaderSchema = z.object({ name: z.string(), value: z.string() }).passthrough();
const gmailBodySchema = z
  .object({ data: z.string().optional(), attachmentId: z.string().optional() })
  .passthrough();
const gmailPartSchema: z.ZodType<GmailMessagePart> = z.lazy(() =>
  z
    .object({
      mimeType: z.string().optional(),
      filename: z.string().optional(),
      headers: z.array(gmailHeaderSchema).optional(),
      body: gmailBodySchema.optional(),
      parts: z.array(gmailPartSchema).optional(),
    })
    .passthrough(),
);
const gmailMessageSchema: z.ZodType<GmailMessageSnapshot> = z
  .object({
    id: z.string().min(1),
    threadId: z.string().optional(),
    labelIds: z.array(z.string()).optional(),
    internalDate: z.string().optional(),
    snippet: z.string().optional(),
    payload: gmailPartSchema.optional(),
  })
  .passthrough();
const gmailListSchema = z
  .object({
    messages: z.array(z.object({ id: z.string().min(1), threadId: z.string().optional() })).optional(),
    nextPageToken: z.string().optional(),
    resultSizeEstimate: z.number().optional(),
  })
  .passthrough();
const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
  })
  .passthrough();

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const cleanText = (value: string): string => value.replace(/\s+/gu, " ").trim();

const headerValue = (part: GmailMessagePart | undefined, name: string): string | undefined => {
  const header = part?.headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  return nonEmpty(header?.value);
};

const decodeMimeHeader = (value: string): string =>
  value.replace(/=\?([^?]+)\?([bq])\?([^?]+)\?=/giu, (_match, charset: string, encoding: string, encoded: string) => {
    try {
      if (encoding.toLowerCase() === "b") {
        return Buffer.from(encoded, "base64").toString(/utf-?8/iu.test(charset) ? "utf8" : "latin1");
      }
      const bytes = encoded
        .replace(/_/gu, " ")
        .replace(/=([0-9A-F]{2})/giu, (_hex, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
      return Buffer.from(bytes, "latin1").toString(/utf-?8/iu.test(charset) ? "utf8" : "latin1");
    } catch {
      return encoded;
    }
  });

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
};

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/gu, "'");

const htmlToText = (value: string): string =>
  cleanText(
    decodeHtmlEntities(
      value
        .replace(/<\s*(?:br|\/p|\/div|\/li|\/tr)[^>]*>/giu, "\n")
        .replace(/<style[\s\S]*?<\/style>/giu, " ")
        .replace(/<script[\s\S]*?<\/script>/giu, " ")
        .replace(/<[^>]+>/gu, " "),
    ),
  );

const collectTextParts = (part: GmailMessagePart | undefined, output: { plain: string[]; html: string[] }): void => {
  if (part === undefined) return;
  if (part.body?.data !== undefined && part.filename === undefined) {
    const decoded = decodeBase64Url(part.body.data);
    if (part.mimeType?.toLowerCase() === "text/plain") output.plain.push(decoded);
    else if (part.mimeType?.toLowerCase() === "text/html") output.html.push(decoded);
  }
  for (const child of part.parts ?? []) collectTextParts(child, output);
};

const messageBody = (message: GmailMessageSnapshot): string => {
  const parts = { plain: [], html: [] } as { plain: string[]; html: string[] };
  collectTextParts(message.payload, parts);
  const plain = cleanText(parts.plain.join("\n"));
  if (plain.length > 0) return plain.slice(0, 8_000);
  const html = htmlToText(parts.html.join("\n"));
  return html.slice(0, 8_000);
};

type GmailAttachmentPart = GmailMessagePart & { body: GmailMessageBody };

const attachmentParts = (part: GmailMessagePart | undefined): GmailAttachmentPart[] => {
  if (part === undefined) return [];
  const current = part.filename !== undefined && part.filename.length > 0 && part.body !== undefined
    ? [part as GmailAttachmentPart]
    : [];
  return [...current, ...(part.parts ?? []).flatMap(attachmentParts)];
};

const textAttachmentType = (part: GmailAttachmentPart): boolean =>
  /^(?:text\/(?:plain|html|csv)|application\/(?:json|xml))$/iu.test(part.mimeType ?? "") ||
  /\.(?:txt|md|csv|json|xml|html?)$/iu.test(part.filename ?? "");

const textAttachmentContent = (message: GmailMessageSnapshot): string => attachmentParts(message.payload)
  .filter((part) => part.body.data !== undefined && textAttachmentType(part))
  .map((part) => {
    const decoded = decodeBase64Url(part.body.data ?? "");
    return (part.mimeType?.toLowerCase() === "text/html" || /\.html?$/iu.test(part.filename ?? ""))
      ? htmlToText(decoded)
      : cleanText(decoded);
  })
  .filter(Boolean)
  .join("\n");

const rawDateFor = (message: GmailMessageSnapshot): string | undefined => headerValue(message.payload, "Date");

const metadataAttachments = (message: GmailMessageSnapshot): Array<Record<string, unknown>> =>
  attachmentParts(message.payload).map((part) => ({
    filename: part.filename,
    mimeType: part.mimeType ?? "unknown",
    ...(part.body.size === undefined ? {} : { sizeBytes: part.body.size }),
    textExtracted: part.body.data !== undefined && textAttachmentType(part),
    ...(part.attachmentTextMissed === true ? { textExtractionFailed: true } : {}),
  }));

const parseSender = (value: string | undefined): { sender: string; senderEmail?: string } => {
  const decoded = decodeMimeHeader(value ?? "");
  const match = decoded.match(/^(.*?)\s*<([^>]+)>\s*$/u);
  if (match !== null) {
    const senderEmail = cleanText(match[2] ?? "");
    const sender = cleanText(match[1] ?? "") || senderEmail || "Gmail";
    return senderEmail.length > 0 ? { sender, senderEmail } : { sender };
  }
  const sender = cleanText(decoded);
  return { sender: sender || "Gmail" };
};

const receivedAtFor = (message: GmailMessageSnapshot): Date | undefined => {
  if (message.internalDate !== undefined) {
    const milliseconds = Number(message.internalDate);
    if (Number.isFinite(milliseconds)) {
      const value = new Date(milliseconds);
      if (Number.isFinite(value.getTime())) return value;
    }
  }
  const dateHeader = headerValue(message.payload, "Date");
  if (dateHeader === undefined) return undefined;
  const value = new Date(dateHeader);
  return Number.isFinite(value.getTime()) ? value : undefined;
};

const itemIdFor = (message: GmailMessageSnapshot, sender: string, title: string, receivedAt?: Date): string => {
  const stableKey = message.id || `${sender}|${title}|${receivedAt?.toISOString() ?? rawDateFor(message) ?? "unknown"}`;
  return `gmail:${createHash("sha256").update(stableKey).digest("hex").slice(0, 24)}`;
};

export const extractGmailEmailItems = (
  messages: readonly GmailMessageSnapshot[],
  now = new Date(),
  lookbackHours = defaultLookbackHours,
): AgentItem[] => {
  const cutoff = now.getTime() - lookbackHours * 60 * 60 * 1_000;
  const latestAllowed = now.getTime() + 5 * 60 * 1_000;
  const items = new Map<string, AgentItem>();

  for (const message of messages) {
    const receivedAt = receivedAtFor(message);
    if (receivedAt !== undefined && (receivedAt.getTime() < cutoff || receivedAt.getTime() > latestAllowed)) continue;

    const senderInfo = parseSender(headerValue(message.payload, "From"));
    const subject = decodeMimeHeader(headerValue(message.payload, "Subject") ?? "");
    const title = cleanText(subject) || cleanText(message.snippet ?? "") || "Gmail email";
    const body = messageBody(message);
    const attachmentText = textAttachmentContent(message);
    const attachments = metadataAttachments(message);
    const fullContent = [body, attachmentText.length === 0 ? "" : `Attachment text:\n${attachmentText}`]
      .filter(Boolean)
      .join("\n\n") || cleanText(message.snippet ?? "") || `${senderInfo.sender}: ${title}`;
    const content = fullContent.slice(0, 8_000);
    const rawDate = rawDateFor(message);
    const item: AgentItem = {
      id: itemIdFor(message, senderInfo.sender, title, receivedAt),
      source: "email",
      title: title.slice(0, 240),
      content,
      url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.id)}`,
      ...(receivedAt === undefined ? {} : { createdAt: receivedAt }),
      metadata: {
        provider: "gmail",
        sender: senderInfo.sender,
        ...(senderInfo.senderEmail === undefined ? {} : { senderEmail: senderInfo.senderEmail }),
        unread: message.labelIds?.includes("UNREAD") ?? false,
        ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
        ...(receivedAt === undefined
          ? { dateStatus: "unknown", ...(rawDate === undefined ? {} : { rawDate }) }
          : { receivedAt: receivedAt.toISOString(), dateStatus: "parsed" }),
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(fullContent.length > 8_000 || body.length >= 8_000 ? { contentTruncated: true } : {}),
      },
    };
    if (!items.has(item.id)) items.set(item.id, item);
  }

  return Array.from(items.values()).sort(
    (left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0),
  );
};

type GmailAuth = {
  accessToken?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  refreshToken?: string | undefined;
};

export type GmailOAuthClientCredentials = {
  clientId: string;
  clientSecret: string;
};

const recordFromUnknown = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const stringProperty = (record: Record<string, unknown>, key: string): string | undefined =>
  typeof record[key] === "string" ? nonEmpty(record[key]) : undefined;

const readJsonRecord = async (path: string): Promise<Record<string, unknown>> => {
  let text: string;
  try {
    text = await readFile(resolve(path), "utf8");
  } catch (error: unknown) {
    throw new GmailConfigurationError(
      `Could not read Gmail credential file ${path}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  try {
    return recordFromUnknown(JSON.parse(text) as unknown);
  } catch {
    throw new GmailConfigurationError(`Gmail credential file ${path} is not valid JSON.`);
  }
};

export const readGmailOAuthClientCredentials = async (
  path: string,
): Promise<GmailOAuthClientCredentials> => {
  const credentials = await readJsonRecord(path);
  const application = recordFromUnknown(credentials.installed ?? credentials.web ?? credentials);
  const clientId = stringProperty(application, "client_id");
  const clientSecret = stringProperty(application, "client_secret");
  if (clientId === undefined || clientSecret === undefined) {
    throw new GmailConfigurationError(
      `Gmail credential file ${path} does not contain an OAuth client_id and client_secret.`,
    );
  }
  return { clientId, clientSecret };
};

const resolveGmailAuth = async (options: GmailProviderOptions): Promise<GmailAuth> => {
  let clientId = nonEmpty(options.clientId);
  let clientSecret = nonEmpty(options.clientSecret);
  let refreshToken = nonEmpty(options.refreshToken);
  let accessToken = nonEmpty(options.accessToken);

  if (options.credentialsPath !== undefined) {
    const credentials = await readGmailOAuthClientCredentials(options.credentialsPath);
    clientId ??= credentials.clientId;
    clientSecret ??= credentials.clientSecret;
  }

  if (options.tokenPath !== undefined) {
    const token = await readJsonRecord(options.tokenPath);
    accessToken ??= stringProperty(token, "access_token");
    refreshToken ??= stringProperty(token, "refresh_token");
  }

  return { accessToken, clientId, clientSecret, refreshToken };
};

class GmailApiClient {
  private accessToken: string | undefined;

  public constructor(private readonly auth: GmailAuth, private readonly timeoutMs: number) {
    this.accessToken = auth.accessToken;
  }

  private async refreshAccessToken(): Promise<string> {
    if (this.auth.clientId === undefined || this.auth.clientSecret === undefined || this.auth.refreshToken === undefined) {
      throw new GmailConfigurationError(
        "Gmail needs GMAIL_ACCESS_TOKEN or GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN. " +
          "A Google API key alone cannot read a private Gmail mailbox.",
      );
    }

    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.auth.clientId,
        client_secret: this.auth.clientSecret,
        refresh_token: this.auth.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
      const message = stringProperty(recordFromUnknown(payload), "error_description") ?? "Google token refresh failed.";
      throw new GmailApiError(response.status, message);
    }
    const token = tokenResponseSchema.parse(payload);
    this.accessToken = token.access_token;
    return token.access_token;
  }

  private async getAccessToken(): Promise<string> {
    return this.accessToken ?? this.refreshAccessToken();
  }

  public async get(path: string, params: URLSearchParams, retried = false): Promise<unknown> {
    const accessToken = await this.getAccessToken();
    const encodedPath = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    const url = `${gmailApiBaseUrl}/${encodedPath}?${params.toString()}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = (await response.json().catch(() => ({}))) as unknown;
    if (response.status === 401 && !retried && this.auth.refreshToken !== undefined) {
      this.accessToken = undefined;
      await this.refreshAccessToken();
      return this.get(path, params, true);
    }
    if (!response.ok) {
      const errorRecord = recordFromUnknown(payload);
      const nested = recordFromUnknown(errorRecord.error);
      const message = stringProperty(nested, "message") ?? "Gmail API request failed.";
      throw new GmailApiError(response.status, message);
    }
    return payload;
  }
}

type GmailListResult = {
  ids: string[];
  pages: number;
  nextCursor: string | null;
  messagesPendingEstimate?: number;
  limitReached: boolean;
};

const listMessageIds = async (
  client: GmailApiClient,
  options: GmailProviderOptions,
  resumeCursor?: string,
  onPageScanned?: (pagesScanned: number, messagesScanned: number) => void,
): Promise<GmailListResult> => {
  const maxMessages = options.maxMessages ?? defaultMaxMessages;
  const lookbackHours = options.lookbackHours ?? defaultLookbackHours;
  const query = options.query ?? `newer_than:${Math.max(1, Math.ceil(lookbackHours / 24))}d`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  let nextCursor: string | null = null;
  let resultSizeEstimate: number | undefined;

  const requestPage = async (token?: string, maxResults = 500) => {
    const params = new URLSearchParams({ maxResults: String(maxResults), q: query });
    if (options.includeSpamTrash === true) params.set("includeSpamTrash", "true");
    if (token !== undefined) params.set("pageToken", token);
    const response = gmailListSchema.parse(await client.get(`${options.userId ?? "me"}/messages`, params));
    pages += 1;
    return response;
  };

  const reportPageScanned = (): void => onPageScanned?.(pages, ids.length);

  if (resumeCursor !== undefined) {
    const freshPage = await requestPage(undefined, Math.min(100, maxMessages));
    resultSizeEstimate = freshPage.resultSizeEstimate;
    for (const message of freshPage.messages ?? []) {
      if (!ids.includes(message.id)) ids.push(message.id);
      if (ids.length >= maxMessages) break;
    }
    reportPageScanned();
    if (ids.length >= maxMessages) {
      return {
        ids,
        pages,
        nextCursor: resumeCursor,
        ...(resultSizeEstimate === undefined ? {} : { messagesPendingEstimate: Math.max(0, resultSizeEstimate - ids.length) }),
        limitReached: true,
      };
    }
    if (freshPage.nextPageToken === undefined) {
      return { ids, pages, nextCursor: null, limitReached: false };
    }
    pageToken = resumeCursor;
  }

  while (ids.length < maxMessages) {
    let response: z.infer<typeof gmailListSchema>;
    try {
      response = await requestPage(pageToken, Math.min(500, maxMessages - ids.length));
    } catch (error: unknown) {
      if (resumeCursor !== undefined && pageToken === resumeCursor && error instanceof GmailApiError && error.status === 400) {
        pageToken = undefined;
        resumeCursor = undefined;
        continue;
      }
      throw error;
    }
    resultSizeEstimate = response.resultSizeEstimate ?? resultSizeEstimate;
    for (const message of response.messages ?? []) {
      if (!ids.includes(message.id)) ids.push(message.id);
      if (ids.length >= maxMessages) break;
    }
    reportPageScanned();
    if (ids.length >= maxMessages || response.nextPageToken === undefined) {
      nextCursor = ids.length >= maxMessages ? response.nextPageToken ?? null : null;
      break;
    }
    pageToken = response.nextPageToken;
  }

  return {
    ids,
    pages,
    nextCursor,
    ...(nextCursor === null || resultSizeEstimate === undefined ? {} : { messagesPendingEstimate: Math.max(0, resultSizeEstimate - ids.length) }),
    limitReached: ids.length >= maxMessages && nextCursor !== null,
  };
};

const getMessages = async (
  client: GmailApiClient,
  userId: string,
  messageIds: readonly string[],
): Promise<{ messages: GmailMessageSnapshot[]; failedCount: number }> => {
  const messages: GmailMessageSnapshot[] = [];
  let failedCount = 0;
  const batchSize = 8;
  for (let index = 0; index < messageIds.length; index += batchSize) {
    const batch = messageIds.slice(index, index + batchSize);
    const values = await Promise.all(
      batch.map(async (id) => {
        try {
          const message = gmailMessageSchema.parse(await client.get(
            `${userId}/messages/${id}`,
            new URLSearchParams({ format: "full" }),
          ));
          const candidates = attachmentParts(message.payload)
            .filter((part) => part.body.attachmentId !== undefined && textAttachmentType(part))
            .slice(0, 5);
          await Promise.all(candidates.map(async (part) => {
            const attachmentId = part.body.attachmentId;
            if (attachmentId === undefined) return;
            try {
              const attachment = recordFromUnknown(await client.get(
                `${userId}/messages/${id}/attachments/${attachmentId}`,
                new URLSearchParams(),
              ));
              if (typeof attachment.data === "string") part.body.data = attachment.data;
            } catch {
              // Attachment details are useful when available. A blocked or unavailable
              // attachment must not hide the message itself.
              part.attachmentTextMissed = true;
            }
          }));
          return message;
        } catch {
          failedCount += 1;
          return undefined;
        }
      }),
    );
    messages.push(...values.filter((value): value is GmailMessageSnapshot => value !== undefined));
  }
  return { messages, failedCount };
};

const emptyCoverage = (): SourceCoverage => ({
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

export const collectGmailEmailItemsFromApi = async (
  options: GmailProviderOptions,
  now = new Date(),
  onProgress?: (progress: BrowserNavigationProgress) => void,
  resumeCursor?: string,
): Promise<AgentItem[]> => {
  const auth = await resolveGmailAuth(options);
  const client = new GmailApiClient(auth, options.timeoutMs ?? defaultTimeoutMs);
  let coverage = emptyCoverage();
  onProgress?.({ phase: "navigating", url: "https://gmail.googleapis.com/gmail/v1/users", title: "Listing messages", coverage });
  let listed: GmailListResult;
  try {
    listed = await listMessageIds(client, options, resumeCursor, (pagesScanned, messagesScanned) => {
      coverage = { ...coverage, pagesScanned, messagesScanned, itemsScanned: messagesScanned };
      onProgress?.({
        phase: "ready",
        url: "https://gmail.googleapis.com/gmail/v1/users",
        title: `Scanned ${pagesScanned} message-list page${pagesScanned === 1 ? "" : "s"}`,
        coverage,
      });
    });
  } catch (error: unknown) {
    coverage = { ...coverage, pagesFailed: 1, missedCountUnknown: true, partial: true };
    onProgress?.({ phase: "failed", url: "https://gmail.googleapis.com/gmail/v1/users", title: "Gmail message listing failed", coverage });
    throw error;
  }
  coverage = { ...coverage, pagesScanned: listed.pages, messagesScanned: listed.ids.length, itemsScanned: listed.ids.length };
  onProgress?.({
    phase: "ready",
    url: "https://gmail.googleapis.com/gmail/v1/users",
    title: `Listed ${listed.ids.length} messages`,
    coverage,
    cursor: listed.nextCursor,
  });
  const fetched = await getMessages(client, options.userId ?? "me", listed.ids);
  const items = extractGmailEmailItems(fetched.messages, now, options.lookbackHours ?? defaultLookbackHours);
  const truncated = items.filter((item) => item.metadata.contentTruncated === true).length;
  const textAttachments = fetched.messages.flatMap((message) => attachmentParts(message.payload)).filter(textAttachmentType);
  const attachmentMissed = textAttachments.filter((part) => part.attachmentTextMissed === true).length;
  const attachmentsTextExtracted = textAttachments.filter((part) => part.body.data !== undefined && part.attachmentTextMissed !== true).length;
  coverage = {
    ...coverage,
    itemsExtracted: items.length,
    itemsSkipped: Math.max(0, fetched.messages.length - items.length),
    itemsTruncated: truncated,
    itemsMissed: fetched.failedCount + attachmentMissed,
    messagesFailed: fetched.failedCount,
    attachmentsScanned: textAttachments.length,
    attachmentsTextExtracted,
    attachmentsFailed: attachmentMissed,
    ...(listed.messagesPendingEstimate === undefined ? {} : { messagesPendingEstimate: listed.messagesPendingEstimate }),
    missedCountUnknown: listed.limitReached && listed.messagesPendingEstimate === undefined,
    limitReached: listed.limitReached,
    partial: listed.limitReached || fetched.failedCount > 0 || attachmentMissed > 0 || truncated > 0,
  };
  onProgress?.({
    phase: "ready",
    url: "https://gmail.googleapis.com/gmail/v1/users",
    title: `Fetched ${items.length} full messages`,
    coverage,
    cursor: listed.nextCursor,
  });
  return items;
};

const nonEmptyEnvironmentValue = (key: string): string | undefined => nonEmpty(process.env[key]);

const booleanEnvironmentValue = (key: string): boolean | undefined => {
  const value = nonEmptyEnvironmentValue(key)?.toLowerCase();
  if (value === undefined) return undefined;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new GmailConfigurationError(`${key} must be true or false.`);
};

const boundedIntegerEnvironmentValue = (key: string, minimum: number, maximum: number): number | undefined => {
  const value = nonEmptyEnvironmentValue(key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new GmailConfigurationError(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
};

export const gmailOptionsFromEnvironment = (): GmailProviderOptions => {
  const accessToken = nonEmptyEnvironmentValue("GMAIL_ACCESS_TOKEN");
  const clientId = nonEmptyEnvironmentValue("GMAIL_CLIENT_ID");
  const clientSecret = nonEmptyEnvironmentValue("GMAIL_CLIENT_SECRET");
  const refreshToken = nonEmptyEnvironmentValue("GMAIL_REFRESH_TOKEN");
  const credentialsPath = nonEmptyEnvironmentValue("GMAIL_CREDENTIALS_PATH");
  const configuredTokenPath = nonEmptyEnvironmentValue("GMAIL_TOKEN_PATH");
  const tokenPath = configuredTokenPath ?? (
    (clientId !== undefined && clientSecret !== undefined) || credentialsPath !== undefined
      ? ".gmail-token.json"
      : undefined
  );
  const explicitEnabled = booleanEnvironmentValue("GMAIL_ENABLED");
  const enabled = explicitEnabled ?? [accessToken, clientId, clientSecret, refreshToken, credentialsPath, tokenPath].some(
    (value) => value !== undefined,
  );
  const options: GmailProviderOptions = {
    enabled,
    ...(accessToken === undefined ? {} : { accessToken }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(credentialsPath === undefined ? {} : { credentialsPath }),
    ...(tokenPath === undefined ? {} : { tokenPath }),
  };

  const userId = nonEmptyEnvironmentValue("GMAIL_USER_ID");
  if (userId !== undefined) options.userId = userId;
  const query = nonEmptyEnvironmentValue("GMAIL_QUERY");
  if (query !== undefined) options.query = query;
  const lookbackHours = boundedIntegerEnvironmentValue("GMAIL_LOOKBACK_HOURS", 1, 168);
  if (lookbackHours !== undefined) options.lookbackHours = lookbackHours;
  const maxMessages = boundedIntegerEnvironmentValue("GMAIL_MAX_MESSAGES", 1, 5_000);
  if (maxMessages !== undefined) options.maxMessages = maxMessages;
  const timeoutMs = boundedIntegerEnvironmentValue("GMAIL_TIMEOUT_MS", 1_000, 120_000);
  if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
  const includeSpamTrash = booleanEnvironmentValue("GMAIL_INCLUDE_SPAM_TRASH");
  if (includeSpamTrash !== undefined) options.includeSpamTrash = includeSpamTrash;
  return options;
};

export const collectGmailEmailItems = async (
  onProgress?: (progress: BrowserNavigationProgress) => void,
  resumeCursor?: string,
  forceEnabled = false,
): Promise<AgentItem[]> => {
  const options = gmailOptionsFromEnvironment();
  if (!options.enabled && !forceEnabled) return [];
  if (forceEnabled) options.enabled = true;
  return collectGmailEmailItemsFromApi(options, new Date(), onProgress, resumeCursor);
};
