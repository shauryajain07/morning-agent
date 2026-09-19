import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { parseMoodleDate } from "./moodleBrowser.js";
import type { AgentItem } from "../types/index.js";

export type OutlookMessageSnapshot = {
  id: string;
  text: string;
  ariaLabel: string;
  href: string;
  dateText: string;
  unread: boolean;
};

export type OutlookBrowserOptions = {
  baseUrl: string;
  profileDirectory?: string;
  cdpUrl?: string;
  headless?: boolean;
  timeoutMs?: number;
  loginTimeoutMs?: number;
  lookbackHours?: number;
  maxScrolls?: number;
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
const defaultMaxScrolls = 6;
const defaultProfileDirectory = join(process.cwd(), ".outlook-browser-profile");
const allowedOutlookHosts = new Set([
  "outlook.office.com",
  "outlook.office365.com",
  "outlook.live.com",
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
  const root = document.querySelector('[role="main"]') || document.body;
  const candidates = root.querySelectorAll('[role="option"], [role="row"], [data-convid], [data-conversation-id]');
  const seen = new Set();
  const records = [];
  for (const row of candidates) {
    if (seen.has(row)) continue;
    seen.add(row);
    const rect = row.getBoundingClientRect();
    const style = window.getComputedStyle(row);
    if (rect.width < 2 || rect.height < 2 || style.display === "none" || style.visibility === "hidden") continue;
    const text = clean(row.innerText).slice(0, 4000);
    const ariaLabel = clean(row.getAttribute("aria-label")).slice(0, 4000);
    if (text.length < 8 && ariaLabel.length < 8) continue;
    const id = row.getAttribute("data-convid") || row.getAttribute("data-conversation-id") || row.getAttribute("data-item-id") || row.id || "";
    const anchor = row.querySelector("a[href]");
    const href = anchor ? anchor.href : "";
    const time = row.querySelector("time");
    const titled = Array.from(row.querySelectorAll("[title]"))
      .map((node) => clean(node.getAttribute("title")))
      .find((value) => value.length > 0) || "";
    const dateText = clean(time && (time.getAttribute("datetime") || time.innerText) || titled);
    const unread = /\bunread\b/iu.test(ariaLabel + " " + String(row.className)) || Boolean(row.querySelector('[aria-label*="Unread" i]'));
    if (/^(focused inbox|other|filter|sort|select all|new mail)$/iu.test(text)) continue;
    records.push({ id, text, ariaLabel, href, dateText, unread });
    if (records.length >= 300) break;
  }
  return records;
})()`;

const scrollScript = String.raw`(() => {
  const root = document.querySelector('[role="main"]') || document.scrollingElement;
  if (!root) return false;
  const before = root.scrollTop;
  root.scrollTop = root.scrollHeight;
  return root.scrollTop !== before;
})()`;

const snapshotPage = async (page: Page): Promise<OutlookMessageSnapshot[]> =>
  (await page.evaluate(snapshotScript)) as OutlookMessageSnapshot[];

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

  public constructor(private readonly options: OutlookBrowserOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (!isHttpUrl(baseUrl) || baseUrl.protocol !== "https:" || !isAllowedOutlookHost(baseUrl.toString())) {
      throw new Error(
        "OUTLOOK_BASE_URL must be an HTTPS Outlook Web URL on outlook.office.com, outlook.office365.com, or outlook.live.com.",
      );
    }
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.loginTimeoutMs = options.loginTimeoutMs ?? defaultLoginTimeoutMs;
  }

  public async open(): Promise<Page> {
    if (this.page !== undefined && !this.page.isClosed()) return this.page;

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
    this.page = await this.context.newPage();
    return this.page;
  }

  public async gotoInbox(): Promise<OutlookMessageSnapshot[]> {
    const page = await this.open();
    await page.goto(this.options.baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.timeoutMs,
    });
    await page.waitForLoadState("networkidle", { timeout: Math.min(this.timeoutMs, 2_000) }).catch(() => {});
    await this.waitForAuthentication(page);

    const snapshots: OutlookMessageSnapshot[] = [];
    const maxScrolls = this.options.maxScrolls ?? defaultMaxScrolls;
    for (let index = 0; index <= maxScrolls; index += 1) {
      snapshots.push(...(await snapshotPage(page)));
      if (index === maxScrolls) break;
      const moved = (await page.evaluate(scrollScript)) as boolean;
      if (!moved) break;
      await page.waitForTimeout(350);
    }
    return uniqueSnapshots(snapshots);
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
    const page = this.page;
    this.page = undefined;
    await page?.close().catch(() => {});
    if (this.ownsContext) await this.context?.close().catch(() => {});
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

const parseLines = (record: OutlookMessageSnapshot): string[] => {
  const primary = record.text.split(/\r?\n/gu).map(cleanText).filter((line) => line.length > 0 && !noiseLine(line));
  if (primary.length >= 2) return primary;
  return record.ariaLabel.split(/\r?\n/gu).map(cleanText).filter((line) => line.length > 0 && !noiseLine(line));
};

const itemId = (record: OutlookMessageSnapshot, sender: string, title: string, receivedAt: Date): string => {
  const stableKey = record.id || record.href || `${sender}|${title}|${receivedAt.toISOString()}`;
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
    if (receivedAt === undefined || receivedAt.getTime() < cutoff || receivedAt.getTime() > latestAllowed) continue;

    const lines = parseLines(record);
    const sender = lines[0] ?? "Outlook";
    const title = (lines[1] ?? lines[0] ?? "Outlook email").slice(0, 240);
    const preview = lines.slice(2).join(" ").slice(0, 4_000);
    const id = itemId(record, sender, title, receivedAt);
    const item: AgentItem = {
      id,
      source: "email",
      title,
      content: preview.length > 0 ? preview : `${sender}: ${title}`,
      ...(record.href.length > 0 ? { url: record.href } : {}),
      createdAt: receivedAt,
      metadata: {
        provider: "outlook",
        sender,
        unread: record.unread,
        receivedAt: receivedAt.toISOString(),
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
): Promise<AgentItem[]> => {
  const session = new OutlookBrowserSession(options);
  try {
    const records = await session.gotoInbox();
    return extractOutlookEmailItems(records, now, options.lookbackHours ?? defaultLookbackHours);
  } finally {
    await session.close();
  }
};
