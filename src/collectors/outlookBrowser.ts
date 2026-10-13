import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { parseMoodleDate } from "./moodleBrowser.js";
import {
  BrowserSessionError,
  closeWithTimeout,
  defaultNavigationDelayMs,
  defaultSettleDelayMs,
  isBrowserFailure,
  type BrowserNavigationProgress,
  waitBeforeNavigation,
  waitForPageReady,
} from "./browserReliability.js";
import type { AgentItem, SourceCoverage } from "../types/index.js";

export type OutlookMessageSnapshot = {
  id: string;
  text: string;
  ariaLabel: string;
  href: string;
  dateText: string;
  unread: boolean;
  rowTruncated?: boolean;
  bodyText?: string;
  contentTruncated?: boolean;
  attachments?: Array<{ filename: string; contentType?: string; sizeText?: string }>;
};

export type OutlookBrowserOptions = {
  baseUrl: string;
  profileDirectory?: string;
  cdpUrl?: string;
  headless?: boolean;
  timeoutMs?: number;
  loginTimeoutMs?: number;
  navigationDelayMs?: number;
  settleDelayMs?: number;
  lookbackHours?: number;
  maxScrolls?: number;
  maxMessages?: number;
  onProgress?: (progress: BrowserNavigationProgress) => void;
};

export class OutlookAuthenticationRequiredError extends Error {
  public constructor(url: string) {
    super(
      `Outlook needs an interactive login in the configured browser profile before it can be read (${url}). ` +
        "No credentials or MFA steps are automated.",
    );
    this.name = "OutlookAuthenticationRequiredError";
  }
}

const defaultTimeoutMs = 15_000;
const defaultLoginTimeoutMs = 5 * 60 * 1_000;
const defaultLookbackHours = 24;
const defaultMaxScrolls = 120;
const defaultMaxMessages = 500;
const defaultProfileDirectory = join(process.cwd(), ".outlook-browser-profile");
const allowedOutlookHosts = new Set([
  "outlook.office.com",
  "outlook.office365.com",
  "outlook.live.com",
  "outlook.cloud.microsoft",
]);

const cleanText = (value: string): string => value.replace(/\s+/gu, " ").trim();

const isHttpUrl = (value: URL): boolean => value.protocol === "https:" || value.protocol === "http:";

const isAllowedOutlookHost = (value: string): boolean => {
  try {
    return allowedOutlookHosts.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
};

const snapshotScript = String.raw`(() => {
  const clean = (value) => (value || "").replace(/\s+/gu, " ").trim();
  const cleanLines = (value) => (value || "").split(/\r?\n/gu).map(clean).filter(Boolean).join("\n");
  const selector = '[role="option"], [role="row"], [data-convid], [data-conversation-id]';
  const main = document.querySelector('[role="main"]');
  const root = main && main.querySelector(selector) ? main : document.body;
  const candidates = root.querySelectorAll(selector);
  const seen = new Set();
  const records = [];
  for (const row of candidates) {
    if (seen.has(row)) continue;
    seen.add(row);
    const rect = row.getBoundingClientRect();
    const style = window.getComputedStyle(row);
    if (rect.width < 2 || rect.height < 2 || style.display === "none" || style.visibility === "hidden") continue;
    const rawText = cleanLines(row.innerText);
    const text = rawText.slice(0, 4000);
    const ariaLabel = cleanLines(row.getAttribute("aria-label")).slice(0, 4000);
    if (text.length < 8 && ariaLabel.length < 8) continue;
    const id = row.getAttribute("data-convid") || row.getAttribute("data-conversation-id") || row.getAttribute("data-item-id") || row.id || "";
    const anchor = row.querySelector("a[href]");
    const href = anchor ? anchor.href : "";
    const time = row.querySelector("time");
    const titledValues = Array.from(row.querySelectorAll("[title]"))
      .map((node) => clean(node.getAttribute("title")))
      .filter((value) => value.length > 0);
    const titled =
      titledValues.find((value) => /\b\d{1,2}:\d{2}\b/iu.test(value)) ||
      titledValues.find((value) => /today|yesterday|\b20\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/iu.test(value)) ||
      "";
    const dateText = clean(time && (time.getAttribute("datetime") || time.innerText) || titled);
    const unread = /\bunread\b/iu.test(ariaLabel + " " + String(row.className)) || Boolean(row.querySelector('[aria-label*="Unread" i]'));
    if (/^(focused inbox|other|filter|sort|select all|new mail)$/iu.test(text)) continue;
    records.push({ id, text, ariaLabel, href, dateText, unread, rowTruncated: rawText.length > 4000 });
    if (records.length >= 300) break;
  }
  return records;
})()`;

const scrollScript = String.raw`(() => {
  const selector = '[role="option"], [role="row"], [data-convid], [data-conversation-id]';
  const firstRow = document.querySelector(selector);
  let root = document.querySelector('[role="main"]');
  if (root === null || root.querySelector(selector) === null) {
    root = firstRow;
    while (root !== null && root.parentElement !== null && root.scrollHeight <= root.clientHeight + 2) {
      root = root.parentElement;
    }
  }
  root = root || document.scrollingElement;
  if (!root) return false;
  const before = root.scrollTop;
  root.scrollTop = root.scrollHeight;
  return root.scrollTop !== before;
})()`;

const snapshotPage = async (page: Page): Promise<OutlookMessageSnapshot[]> =>
  (await page.evaluate(snapshotScript)) as OutlookMessageSnapshot[];

const messageBodyScript = String.raw`(() => {
  const clean = (value) => (value || "").replace(/\s+/gu, " ").trim();
  const main = document.querySelector('[role="main"]');
  const candidates = [
    document.querySelector('[role="document"]'),
    document.querySelector('[aria-label*="message body" i]'),
    document.querySelector('[data-app-section="MailReadCompose"]'),
    main,
  ].filter(Boolean);
  const text = candidates.map((node) => clean(node.innerText)).find((value) => value.length > 0) || clean(document.body && document.body.innerText);
  const attachments = [];
  const seen = new Set();
  for (const node of Array.from(document.querySelectorAll('[aria-label*="attachment" i], [data-testid*="attachment" i]'))) {
    const label = clean(node.getAttribute("aria-label") || node.innerText || node.getAttribute("title"));
    if (!label || seen.has(label)) continue;
    seen.add(label);
    attachments.push({ filename: label.slice(0, 240) });
    if (attachments.length >= 30) break;
  }
  return { text, attachments };
})()`;

type OutlookMessageBody = { text: string; attachments: Array<{ filename: string }> };

const messageBodyPage = async (page: Page): Promise<OutlookMessageBody> =>
  (await page.evaluate(messageBodyScript)) as OutlookMessageBody;

const emptyCoverage = (): SourceCoverage => ({
  pagesScanned: 0,
  messagesScanned: 0,
  itemsScanned: 0,
  itemsExtracted: 0,
  itemsSkipped: 0,
  itemsTruncated: 0,
  itemsMissed: 0,
  pagesFailed: 0,
  limitReached: false,
  partial: false,
});

const uniqueSnapshots = (snapshots: readonly OutlookMessageSnapshot[]): OutlookMessageSnapshot[] => {
  const output = new Map<string, OutlookMessageSnapshot>();
  for (const snapshot of snapshots) {
    const key = snapshot.id || snapshot.href || `${snapshot.text}|${snapshot.dateText}`;
    if (!output.has(key)) output.set(key, snapshot);
  }
  return Array.from(output.values());
};

export class OutlookBrowserSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private ownsContext = false;
  private readonly timeoutMs: number;
  private readonly loginTimeoutMs: number;
  private readonly navigationDelayMs: number;
  private readonly settleDelayMs: number;
  private lastNavigationAt = 0;
  private failure: BrowserSessionError | undefined;
  private closing = false;

  public constructor(private readonly options: OutlookBrowserOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (!isHttpUrl(baseUrl) || baseUrl.protocol !== "https:" || !isAllowedOutlookHost(baseUrl.toString())) {
      throw new Error(
        "OUTLOOK_BASE_URL must be an HTTPS Outlook Web URL on an official Outlook host.",
      );
    }
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.loginTimeoutMs = options.loginTimeoutMs ?? defaultLoginTimeoutMs;
    this.navigationDelayMs = Math.max(0, options.navigationDelayMs ?? defaultNavigationDelayMs);
    this.settleDelayMs = Math.max(0, options.settleDelayMs ?? defaultSettleDelayMs);
  }

  public async open(): Promise<Page> {
    if (this.failure !== undefined) throw this.failure;
    if (this.page !== undefined && !this.page.isClosed()) return this.page;
    this.closing = false;

    if (this.options.cdpUrl !== undefined) {
      this.browser = await chromium.connectOverCDP(this.options.cdpUrl);
      const existingContext = this.browser.contexts()[0];
      this.context = existingContext ?? (await this.browser.newContext());
      this.ownsContext = existingContext === undefined;
    } else {
      const profileDirectory = resolve(this.options.profileDirectory ?? defaultProfileDirectory);
      this.context = await chromium.launchPersistentContext(profileDirectory, {
        headless: this.options.headless ?? false,
        viewport: this.options.headless ? { width: 1_280, height: 900 } : null,
        args: this.options.headless ? [] : ["--window-size=1280,900", "--window-position=80,80"],
        ignoreDefaultArgs: ["--enable-automation"],
      });
      this.ownsContext = true;
    }

    this.context.setDefaultTimeout(this.timeoutMs);
    this.context.on("close", () => {
      if (!this.closing) this.failure ??= new BrowserSessionError("Outlook's browser context closed unexpectedly.");
    });
    this.browser?.on("disconnected", () => {
      if (!this.closing) this.failure ??= new BrowserSessionError("Outlook's browser disconnected unexpectedly.");
    });
    this.page = await this.context.newPage();
    this.page.on("crash", () => {
      this.failure ??= new BrowserSessionError("Outlook's browser page crashed.");
    });
    return this.page;
  }

  public isBroken(): boolean {
    return this.failure !== undefined || this.page?.isClosed() === true;
  }

  public async gotoInbox(resumeCursor?: string): Promise<OutlookMessageSnapshot[]> {
    const page = await this.open();
    this.lastNavigationAt = await waitBeforeNavigation(page, this.lastNavigationAt, this.navigationDelayMs);
    this.options.onProgress?.({ phase: "navigating", url: this.options.baseUrl });
    try {
      await page.goto(this.options.baseUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
      await waitForPageReady(page, this.timeoutMs, this.settleDelayMs);
      await this.waitForAuthentication(page);

      const snapshots = new Map<string, OutlookMessageSnapshot>();
      const maxScrolls = this.options.maxScrolls ?? defaultMaxScrolls;
      const maxMessages = this.options.maxMessages ?? defaultMaxMessages;
      let unchangedPasses = 0;
      let limitReached = false;
      let pagesScanned = 0;
      let snapshotCapHits = 0;
      let resumeFound = resumeCursor === undefined;
      for (let index = 0; index <= maxScrolls; index += 1) {
        pagesScanned = index + 1;
        const beforeCount = snapshots.size;
        const pageRecords = await snapshotPage(page);
        if (pageRecords.length >= 300) snapshotCapHits += 1;
        for (const snapshot of pageRecords) {
          const key = snapshot.id || snapshot.href || `${snapshot.text}|${snapshot.dateText}`;
          if (!snapshots.has(key)) snapshots.set(key, snapshot);
          if (key === resumeCursor) resumeFound = true;
        }
        const records = Array.from(snapshots.values());
        const resumeIndex = resumeCursor === undefined
          ? -1
          : records.findIndex((record) => (record.id || record.href || `${record.text}|${record.dateText}`) === resumeCursor);
        if (resumeIndex >= 0) resumeFound = true;
        const eligibleRecords = resumeCursor === undefined
          ? records
          : resumeIndex >= 0
            ? records.slice(resumeIndex + 1)
            : [];
        const overMessageCap = eligibleRecords.length >= maxMessages;
        if (overMessageCap) limitReached = true;
        const coverage: SourceCoverage = {
          ...emptyCoverage(),
          pagesScanned: index + 1,
          messagesScanned: Math.min(eligibleRecords.length, maxMessages),
          itemsScanned: Math.min(eligibleRecords.length, maxMessages),
          itemsTruncated: records.filter((record) => record.rowTruncated === true).length + snapshotCapHits,
          itemsMissed: snapshotCapHits,
          missedCountUnknown: limitReached || snapshotCapHits > 0,
          limitReached: limitReached || snapshotCapHits > 0,
          partial: limitReached || snapshotCapHits > 0 || !resumeFound,
          scope: "Inbox rows and message details",
        };
        this.options.onProgress?.({
          phase: "ready",
          url: this.options.baseUrl,
          title: `Inbox scan ${index + 1}`,
          coverage,
        });
        if (overMessageCap) {
          const limited = eligibleRecords.slice(0, maxMessages);
          const cursor = limited.at(-1);
          this.options.onProgress?.({
            phase: "ready",
            url: this.options.baseUrl,
            title: `Message limit reached at ${limited.length}`,
            coverage: { ...coverage, messagesScanned: limited.length, itemsScanned: limited.length, limitReached: true, partial: true },
            cursor: cursor === undefined ? resumeCursor ?? null : cursor.id || cursor.href || null,
          });
          return limited;
        }
        if (snapshots.size === beforeCount) unchangedPasses += 1;
        else unchangedPasses = 0;
        if (index === maxScrolls) {
          const movedAtSafetyLimit = (await page.evaluate(scrollScript)) as boolean;
          limitReached = movedAtSafetyLimit;
          break;
        }
        if (unchangedPasses >= 2) break;
        const moved = (await page.evaluate(scrollScript)) as boolean;
        if (!moved) break;
        await page.waitForTimeout(this.settleDelayMs);
      }
      const allRecords = uniqueSnapshots(Array.from(snapshots.values()));
      const resumeIndex = resumeCursor === undefined
        ? -1
        : allRecords.findIndex((record) => (record.id || record.href || `${record.text}|${record.dateText}`) === resumeCursor);
      if (resumeIndex >= 0) resumeFound = true;
      const startIndex = resumeCursor !== undefined && resumeIndex >= 0 ? resumeIndex + 1 : 0;
      const records = allRecords.slice(startIndex, startIndex + maxMessages);
      const hasUnreturnedRecords = allRecords.length > startIndex + records.length;
      if (hasUnreturnedRecords || !resumeFound) limitReached = true;
      const cursor = records.at(-1);
      const finalCoverage: SourceCoverage = {
        ...emptyCoverage(),
        pagesScanned,
        messagesScanned: records.length,
        itemsScanned: records.length,
        itemsTruncated: records.filter((record) => record.rowTruncated === true).length + snapshotCapHits,
        itemsMissed: snapshotCapHits,
        missedCountUnknown: limitReached || snapshotCapHits > 0,
        limitReached: limitReached || snapshotCapHits > 0,
        partial: limitReached || snapshotCapHits > 0 || !resumeFound,
        scope: "Inbox rows and message details",
      };
      this.options.onProgress?.({
        phase: "ready",
        url: this.options.baseUrl,
        title: resumeCursor === undefined ? `Scanned ${records.length} inbox messages` : resumeFound ? "Resumed inbox scan" : "Resume marker not found within scan limit",
        coverage: finalCoverage,
        cursor: finalCoverage.limitReached ? cursor?.id || cursor?.href || resumeCursor || null : null,
      });
      return records;
    } catch (error: unknown) {
      if (isBrowserFailure(error) || this.isBroken()) {
        this.failure ??= error instanceof BrowserSessionError
          ? error
          : new BrowserSessionError("Outlook's browser session became unavailable.", error);
      }
      this.options.onProgress?.({ phase: "failed", url: this.options.baseUrl });
      throw error;
    }
  }

  public async readMessage(url: string): Promise<OutlookMessageSnapshot> {
    const target = new URL(url, this.options.baseUrl);
    if (!isAllowedOutlookHost(target.toString())) throw new Error("Outlook refused to open a message outside its official host.");
    const page = await this.open();
    this.lastNavigationAt = await waitBeforeNavigation(page, this.lastNavigationAt, this.navigationDelayMs);
    this.options.onProgress?.({ phase: "navigating", url: target.toString() });
    try {
      await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
      await waitForPageReady(page, this.timeoutMs, this.settleDelayMs);
      await this.waitForAuthentication(page);
      const body = await messageBodyPage(page);
      const truncated = body.text.length > 20_000;
      return {
        id: target.pathname.split("/").filter(Boolean).at(-1) ?? "",
        text: body.text.slice(0, 4_000),
        ariaLabel: "",
        href: target.toString(),
        dateText: "",
        unread: false,
        bodyText: body.text.slice(0, 20_000),
        contentTruncated: truncated,
        attachments: body.attachments,
      };
    } catch (error: unknown) {
      if (isBrowserFailure(error) || this.isBroken()) {
        this.failure ??= error instanceof BrowserSessionError ? error : new BrowserSessionError("Outlook's browser session became unavailable.", error);
      }
      this.options.onProgress?.({ phase: "failed", url: target.toString() });
      throw error;
    }
  }

  private async isAuthenticationPage(page: Page): Promise<boolean> {
    const currentUrl = page.url();
    const loginUrl = /login|authorize|oauth|signin|sign-in/iu.test(currentUrl);
    const passwordInputs = await page.locator('input[type="password"]:visible').count().catch(() => 0);
    const signInText = await page.locator("body").innerText().catch(() => "");
    return (
      !isAllowedOutlookHost(currentUrl) ||
      loginUrl ||
      passwordInputs > 0 ||
      /sign in|pick an account|enter your password/iu.test(signInText.slice(0, 5_000))
    );
  }

  private async waitForAuthentication(page: Page): Promise<void> {
    const deadline = Date.now() + this.loginTimeoutMs;
    // Outlook first serves a same-origin shell and may redirect it to Microsoft
    // sign-in a moment later. Wait for either a real message row or a settled
    // authentication state so the initial shell is not mistaken for an empty inbox.
    const shellDeadline = Date.now() + Math.min(this.loginTimeoutMs, 10_000);
    while (Date.now() < deadline) {
      if (await this.isAuthenticationPage(page)) {
        if (this.options.headless === true) throw new OutlookAuthenticationRequiredError(page.url());
        await page.waitForTimeout(1_000);
        continue;
      }

      const messageSnapshots = await snapshotPage(page).catch(() => []);
      if (messageSnapshots.length > 0 || Date.now() >= shellDeadline) return;
      await page.waitForTimeout(500);
    }
    throw new OutlookAuthenticationRequiredError(page.url());
  }

  public async close(): Promise<void> {
    this.closing = true;
    const page = this.page;
    this.page = undefined;
    await closeWithTimeout(page?.close());
    if (this.ownsContext) await closeWithTimeout(this.context?.close());
    // An attached Chrome belongs to the user; only close the collector's tab.
    this.browser = undefined;
    this.context = undefined;
    this.ownsContext = false;
  }
}

const dateCandidate = (record: OutlookMessageSnapshot): string => {
  if (record.dateText.length > 0) return record.dateText;
  const source = `${record.ariaLabel} ${record.text}`;
  const iso = source.match(/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s]+\d{1,2}:\d{2})?/u)?.[0];
  if (iso !== undefined) return iso;
  const relative = source.match(/\b(?:today|yesterday)(?:\s+at)?\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?/iu)?.[0];
  if (relative !== undefined) return relative;
  return source.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+20\d{2})?/iu)?.[0] ?? "";
};

const parseReceivedAt = (record: OutlookMessageSnapshot, now: Date): Date | undefined => {
  const candidate = dateCandidate(record);
  if (candidate.length === 0) return undefined;
  // Outlook commonly exposes a timezone-bearing ISO value through <time datetime>.
  // Preserve that timezone instead of interpreting it as Hong Kong wall-clock time.
  if (/^20\d{2}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/iu.test(candidate)) {
    const direct = new Date(candidate);
    if (Number.isFinite(direct.getTime())) return direct;
  }
  const parsed = parseMoodleDate(candidate, now, 12, 0);
  if (parsed !== undefined) return parsed;
  const direct = new Date(candidate);
  return Number.isFinite(direct.getTime()) ? direct : undefined;
};

const noiseLine = (line: string): boolean =>
  /^(?:unread|read|today|yesterday|expanded|collapsed|high priority|has files|important|focused inbox|other)$/iu.test(line) ||
  /^\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)$/iu.test(line) ||
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/iu.test(line);

const decorativeLine = (line: string): boolean => {
  if (/^[A-Za-z0-9]$/u.test(line)) return true;
  return line.length > 0 && Array.from(line).every((character) => /[\p{S}\p{M}\p{C}]/u.test(character));
};

const parseLines = (record: OutlookMessageSnapshot): string[] => {
  const primary = record.text
    .split(/\r?\n/gu)
    .map(cleanText)
    .filter((line) => line.length > 0 && !noiseLine(line) && !decorativeLine(line));
  if (primary.length >= 2) return primary;
  return record.ariaLabel
    .split(/\r?\n/gu)
    .map(cleanText)
    .filter((line) => line.length > 0 && !noiseLine(line) && !decorativeLine(line));
};

const itemId = (record: OutlookMessageSnapshot, sender: string, title: string, receivedAt?: Date): string => {
  const stableKey = record.id || record.href || `${sender}|${title}|${(receivedAt?.toISOString() ?? dateCandidate(record)) || "unknown"}`;
  return `outlook:${createHash("sha256").update(stableKey).digest("hex").slice(0, 24)}`;
};

export const extractOutlookEmailItems = (
  records: readonly OutlookMessageSnapshot[],
  now = new Date(),
  lookbackHours = defaultLookbackHours,
): AgentItem[] => {
  const cutoff = now.getTime() - lookbackHours * 60 * 60 * 1_000;
  const latestAllowed = now.getTime() + 5 * 60 * 1_000;
  const items = new Map<string, AgentItem>();

  for (const record of records) {
    const receivedAt = parseReceivedAt(record, now);
    if (receivedAt !== undefined && (receivedAt.getTime() < cutoff || receivedAt.getTime() > latestAllowed)) continue;

    const lines = parseLines(record);
    const sender = lines[0] ?? "Outlook";
    const title = (lines[1] ?? lines[0] ?? "Outlook email").slice(0, 240);
    const preview = lines.slice(2).join(" ").slice(0, 4_000);
    const fullBody = record.bodyText?.trim() ?? "";
    const fullContent = fullBody.length > 0 ? fullBody : preview.length > 0 ? preview : `${sender}: ${title}`;
    const contentTruncated = fullContent.length > 8_000 || record.contentTruncated === true || record.rowTruncated === true;
    const rawDate = record.dateText || dateCandidate(record);
    const id = itemId(record, sender, title, receivedAt);
    const item: AgentItem = {
      id,
      source: "email",
      title,
      content: fullContent.slice(0, 8_000),
      ...(record.href.length > 0 ? { url: record.href } : {}),
      ...(receivedAt === undefined ? {} : { createdAt: receivedAt }),
      metadata: {
        provider: "outlook",
        sender,
        unread: record.unread,
        ...(receivedAt === undefined
          ? { dateStatus: "unknown", ...(rawDate.length === 0 ? {} : { rawDate }) }
          : { receivedAt: receivedAt.toISOString(), dateStatus: "parsed" }),
        ...(record.attachments === undefined || record.attachments.length === 0 ? {} : { attachments: record.attachments }),
        ...(contentTruncated ? { contentTruncated: true } : {}),
        ...(record.id.length > 0 ? { conversationId: record.id } : {}),
      },
    };
    if (!items.has(item.id)) items.set(item.id, item);
  }

  return Array.from(items.values()).sort((left, right) =>
    (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0),
  );
};

export const collectOutlookEmailItemsFromBrowser = async (
  options: OutlookBrowserOptions,
  now = new Date(),
  resumeCursor?: string,
): Promise<AgentItem[]> => {
  let listCoverage = emptyCoverage();
  let savedCursor: string | null = null;
  const onProgress = (progress: BrowserNavigationProgress): void => {
    if (progress.coverage !== undefined) listCoverage = progress.coverage;
    if (progress.cursor !== undefined) savedCursor = progress.cursor;
    options.onProgress?.(progress);
  };
  const session = new OutlookBrowserSession({ ...options, onProgress });
  try {
    let rows: OutlookMessageSnapshot[];
    try {
      rows = await session.gotoInbox(resumeCursor);
    } catch (error: unknown) {
      onProgress({
        phase: "failed",
        url: options.baseUrl,
        title: "Outlook inbox page failed",
        coverage: { ...emptyCoverage(), pagesFailed: 1, missedCountUnknown: true, partial: true },
      });
      throw error;
    }
    const maxMessages = options.maxMessages ?? defaultMaxMessages;
    const selectedRows = rows.slice(0, maxMessages);
    let pagesFailed = 0;
    let messagesMissed = 0;
    let detailPages = 0;
    const records: OutlookMessageSnapshot[] = [];
    for (const row of selectedRows) {
      if (row.href.length === 0) {
        records.push(row);
        messagesMissed += 1;
        continue;
      }
      try {
        const detail = await session.readMessage(row.href);
        detailPages += 1;
        records.push({
          ...row,
          ...(detail.bodyText === undefined ? {} : { bodyText: detail.bodyText }),
          ...(detail.contentTruncated === undefined ? {} : { contentTruncated: detail.contentTruncated }),
          ...(detail.attachments === undefined ? {} : { attachments: detail.attachments }),
        });
      } catch (error: unknown) {
        pagesFailed += 1;
        messagesMissed += 1;
        records.push(row);
        if (session.isBroken()) {
          onProgress({
            phase: "failed",
            url: row.href,
            title: "Outlook message page failed",
            coverage: {
              ...listCoverage,
              pagesScanned: listCoverage.pagesScanned + detailPages,
              messagesScanned: selectedRows.length,
              itemsScanned: selectedRows.length,
              itemsMissed: listCoverage.itemsMissed + messagesMissed,
              pagesFailed,
              missedCountUnknown: true,
              partial: true,
              scope: "Inbox messages in the configured lookback window",
            },
          });
          throw error;
        }
      }
    }
    const items = extractOutlookEmailItems(records, now, options.lookbackHours ?? defaultLookbackHours);
    const itemsTruncated = items.filter((item) => item.metadata.contentTruncated === true).length;
    const coverage: SourceCoverage = {
      ...listCoverage,
      pagesScanned: listCoverage.pagesScanned + detailPages,
      messagesScanned: selectedRows.length,
      itemsScanned: selectedRows.length,
      itemsExtracted: items.length,
      itemsSkipped: Math.max(0, selectedRows.length - items.length - messagesMissed),
      itemsTruncated: listCoverage.itemsTruncated + itemsTruncated,
      itemsMissed: listCoverage.itemsMissed + messagesMissed,
      pagesFailed,
      partial: listCoverage.partial || pagesFailed > 0 || messagesMissed > 0 || listCoverage.itemsTruncated > 0 || itemsTruncated > 0,
      scope: "Inbox messages in the configured lookback window",
    };
    const cursor = listCoverage.limitReached ? savedCursor : null;
    onProgress({
      phase: "ready",
      url: options.baseUrl,
      title: coverage.partial ? "Outlook coverage is partial" : "Full messages read",
      coverage,
      cursor,
    });
    return items;
  } finally {
    await session.close();
  }
};
