import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { courseCodes } from "../config/courses.js";
import type { AgentItem, SourceCoverage } from "../types/index.js";
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

export type MoodleLinkSnapshot = {
  href: string;
  text: string;
  context: string;
  title: string;
  ariaLabel: string;
  download?: string;
  mimeType?: string;
};

export type MoodlePageSnapshot = {
  url: string;
  title: string;
  bodyText: string;
  links: MoodleLinkSnapshot[];
  bodyTruncated?: boolean;
};

export type MoodleCollection = {
  announcements: AgentItem[];
  assignments: AgentItem[];
  courseFiles: AgentItem[];
  uncertain: AgentItem[];
};

export type MoodleBrowserOptions = {
  baseUrl: string;
  profileDirectory?: string;
  cdpUrl?: string;
  headless?: boolean;
  timeoutMs?: number;
  loginTimeoutMs?: number;
  navigationDelayMs?: number;
  settleDelayMs?: number;
  maxCoursePages?: number;
  maxDetailPages?: number;
  resumeCursor?: string;
  onProgress?: (progress: BrowserNavigationProgress) => void;
};

export class MoodleAuthenticationRequiredError extends Error {
  public constructor(url: string) {
    super(
      `Moodle needs an interactive login in the configured browser profile before it can be read (${url}). ` +
        "No credentials or MFA steps are automated.",
    );
    this.name = "MoodleAuthenticationRequiredError";
  }
}

const defaultTimeoutMs = 15_000;
const defaultLoginTimeoutMs = 5 * 60 * 1_000;
const defaultMaxCoursePages = 100;
const defaultMaxDetailPages = 500;
const defaultProfileDirectory = join(process.cwd(), ".browser-profile");
const sensitiveQueryParameter = /^(?:token|wstoken|sesskey|session|password|pass|key)$/iu;
const courseCodePattern = new RegExp(`\\b(?:${courseCodes.join("|")})(?=\\b|[_-])`, "iu");
const math1851AbCoursePattern = /\bMATH1851[_\s-]*1AB\b/iu;
const moodleResourcePathPattern = /\/mod\/(?:resource|folder)\/view(?:\.php)?\/?$/u;
const moodleAssignmentPathPattern = /\/mod\/(?:assign|quiz|workshop|turnitintooltwo)\/view(?:\.php)?\/?$/u;
// Assignment/quiz pages are already represented by their course-listing links.
// Only resource/folder pages need a bounded detail crawl to find nested files.
const moodleDetailPathPattern = /\/mod\/(?:resource|folder|assign|quiz|workshop|turnitintooltwo)\/view(?:\.php)?\/?$/u;

const cleanText = (value: string): string => value.replace(/\s+/gu, " ").trim();

const stripMoodleNavigationChrome = (value: string): string => cleanText(
  value
    .replace(/\bSkip to (?:sidebar )?(?:navigation menu|hidden blocks|page footer|main content|-)(?=\s|$)/giu, " ")
    .replace(/\bBlocks\s+Close(?:\s+Blocks)?(?:\s+Close\s+Blocks)?/giu, " ")
    .replace(/\bSkip\s+(?:To\s+)?do(?:\s+To\s+do)*/giu, " ")
    .replace(/\bThere are no upcoming events\s+Go to calendar\.\.\./giu, " ")
    .replace(/\bSkip\s+ReadingList@HKUL(?:\s+ReadingList@HKUL)?\s+Reading list for\s+\S+\s+Close\s+Light Mode\s+\d+\s+JS\s+Open course index\s*/iu, " ")
    .replace(/\bSkip\s+ReadingList@HKUL\s+R\b/giu, " ")
    .replace(/\bDashboard\s+My courses\s+\d+\s+[\s\S]*?\bOpen course index\s*/iu, " ")
    .replace(/\bJS\s+Open course index\s*/iu, " ")
    .replace(/\bHome\s+Courses\s+\S*20\d{2}\S*\s+/iu, "")
    .replace(/\bGeneral\s+(Tutorial|Lecture)\s+Participation\s+Blocks\s+\1\s+Participation\s+Blocks\s+Completion requirements\b/giu, "General $1 Participation · Completion requirements")
    .replace(/\s+Blocks(?:\s+Blocks){2,}\s+FAQs for Teachers[\s\S]*$/iu, " "),
);

const isHttpUrl = (value: URL): boolean => value.protocol === "https:" || value.protocol === "http:";

const toCanonicalMoodleUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (!isHttpUrl(url)) return undefined;
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (sensitiveQueryParameter.test(key)) url.searchParams.delete(key);
    }
    if (
      /\/(?:course\/view(?:\.php)?|mod\/(?:resource|folder|assign|quiz|workshop|turnitintooltwo)\/view(?:\.php)?)\/?$/iu.test(url.pathname)
    ) {
      const id = url.searchParams.get("id");
      if (id !== null) {
        url.search = "";
        url.searchParams.set("id", id);
      }
    }
    return url.toString();
  } catch {
    return undefined;
  }
};

const courseCodeFromText = (value: string): string | undefined => {
  const match = value.match(courseCodePattern);
  return match?.[0]?.toUpperCase();
};

const sameOrigin = (value: string, origin: string): boolean => {
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
};

const isAccessibilitySkipLink = (link: MoodleLinkSnapshot): boolean => {
  const label = cleanText(`${link.text} ${link.ariaLabel} ${link.title}`);
  if (!/^skip(?:\s+to)?(?:\s|$)/iu.test(label)) return false;

  try {
    return new URL(link.href).hash.length > 0;
  } catch {
    return false;
  }
};

const snapshotScript = String.raw`(() => {
  const clean = (value) => (value || "").replace(/\s+/gu, " ").trim();
  const contextFor = (anchor) => {
    let node = anchor;
    for (let depth = 0; depth < 4 && node; depth += 1) {
      const text = clean(node.innerText);
      if (text.length >= 32) return text.slice(0, 1200);
      node = node.parentElement;
    }
    return clean(anchor.innerText).slice(0, 1200);
  };
  const links = [];
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const link = {
      href: anchor.href,
      text: clean(anchor.innerText),
      context: contextFor(anchor),
      title: clean(anchor.getAttribute("title")),
      ariaLabel: clean(anchor.getAttribute("aria-label")),
      download: clean(anchor.getAttribute("download")),
      mimeType: clean(anchor.getAttribute("type")),
    };
    const label = clean([link.text, link.ariaLabel, link.title].filter(Boolean).join(" "));
    const isAccessibilitySkipLink = /^skip(?:\s+to)?(?:\s|$)/iu.test(label) && anchor.hash.length > 0;
    if (link.href.length > 0 && !isAccessibilitySkipLink) links.push(link);
  }
  const rawBodyText = clean(document.body && document.body.innerText);
  return {
    url: window.location.href,
    title: clean(document.title),
    bodyText: rawBodyText.slice(0, 50000),
    bodyTruncated: rawBodyText.length > 50000,
    links,
  };
})()`;

const snapshotPage = async (page: Page): Promise<MoodlePageSnapshot> =>
  (await page.evaluate(snapshotScript)) as MoodlePageSnapshot;

export class MoodleBrowserSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private ownsContext = false;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly loginTimeoutMs: number;
  private readonly navigationDelayMs: number;
  private readonly settleDelayMs: number;
  private lastNavigationAt = 0;
  private failure: BrowserSessionError | undefined;
  private closing = false;

  public constructor(private readonly options: MoodleBrowserOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (!isHttpUrl(baseUrl)) {
      throw new Error("MOODLE_BASE_URL must be an http(s) URL.");
    }
    this.origin = baseUrl.origin;
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
        args: this.options.headless ? [] : ["--window-size=1280,900", "--window-position=40,40"],
        ignoreDefaultArgs: ["--enable-automation"],
      });
      this.ownsContext = true;
    }

    this.context.setDefaultTimeout(this.timeoutMs);
    this.context.on("close", () => {
      if (!this.closing) this.failure ??= new BrowserSessionError("Moodle's browser context closed unexpectedly.");
    });
    this.browser?.on("disconnected", () => {
      if (!this.closing) this.failure ??= new BrowserSessionError("Moodle's browser disconnected unexpectedly.");
    });
    // Use a separate tab so an attached browser's current tab is not redirected.
    this.page = await this.context.newPage();
    this.page.on("crash", () => {
      this.failure ??= new BrowserSessionError("Moodle's browser page crashed.");
    });
    return this.page;
  }

  public isBroken(): boolean {
    return this.failure !== undefined || this.page?.isClosed() === true;
  }

  public async goto(targetUrl: string): Promise<MoodlePageSnapshot> {
    const target = new URL(targetUrl, this.options.baseUrl);
    if (!isHttpUrl(target) || target.origin !== this.origin) {
      throw new Error("Moodle collector refused to navigate outside the configured Moodle origin.");
    }

    const page = await this.open();
    this.lastNavigationAt = await waitBeforeNavigation(page, this.lastNavigationAt, this.navigationDelayMs);
    this.options.onProgress?.({ phase: "navigating", url: target.toString() });
    try {
      await page.goto(target.toString(), {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
      await waitForPageReady(page, this.timeoutMs, this.settleDelayMs);
      await this.waitForAuthentication(page);
      const snapshot = await snapshotPage(page);
      this.options.onProgress?.({
        phase: "ready",
        url: target.toString(),
        ...(snapshot.title.length === 0 ? {} : { title: snapshot.title }),
      });
      return snapshot;
    } catch (error: unknown) {
      if (isBrowserFailure(error) || this.isBroken()) {
        this.failure ??= error instanceof BrowserSessionError
          ? error
          : new BrowserSessionError("Moodle's browser session became unavailable.", error);
      }
      this.options.onProgress?.({ phase: "failed", url: target.toString() });
      throw error;
    }
  }

  private async isAuthenticationPage(page: Page): Promise<boolean> {
    const currentUrl = page.url();
    const sameMoodleOrigin = sameOrigin(currentUrl, this.origin);
    const loginUrl = /\/(?:login|auth)(?:\/|\.|$)/iu.test(currentUrl);
    const passwordInputs = await page.locator('input[type="password"]:visible').count().catch(() => 0);
    const loginForms = await page.locator('form#login, form[action*="login"]:visible').count().catch(() => 0);
    return !sameMoodleOrigin || loginUrl || passwordInputs > 0 || loginForms > 0;
  }

  private async waitForAuthentication(page: Page): Promise<void> {
    if (!(await this.isAuthenticationPage(page))) return;

    if (this.options.headless === true) {
      throw new MoodleAuthenticationRequiredError(page.url());
    }

    const deadline = Date.now() + this.loginTimeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1_000);
      if (!(await this.isAuthenticationPage(page))) return;
    }

    throw new MoodleAuthenticationRequiredError(page.url());
  }

  public async close(): Promise<void> {
    this.closing = true;
    const page = this.page;
    this.page = undefined;
    await closeWithTimeout(page?.close());

    if (this.ownsContext) {
      await closeWithTimeout(this.context?.close());
    }

    // A CDP browser belongs to the user; never close it from the collector.
    this.browser = undefined;
    this.context = undefined;
    this.ownsContext = false;
  }
}

export const discoverCourseLinks = (
  snapshot: MoodlePageSnapshot,
  baseUrl: string,
): string[] => {
  const origin = new URL(baseUrl).origin;
  const candidates: Array<{ canonical: string; value: string }> = [];
  for (const link of snapshot.links) {
    if (isAccessibilitySkipLink(link)) continue;
    const value = `${link.href} ${link.text} ${link.context} ${link.title}`;
    // The dashboard can contain courses that are not in the local folder/
    // decision configuration. The course-view route is the reliable signal;
    // configured course codes are only used later for labels and routing.
    if (!sameOrigin(link.href, origin)) continue;

    let path = "";
    try {
      path = new URL(link.href).pathname.toLowerCase();
    } catch {
      continue;
    }
    if (!path.endsWith("/course/view.php") && !path.endsWith("/course/view")) continue;

    const canonical = toCanonicalMoodleUrl(link.href);
    if (canonical !== undefined) candidates.push({ canonical, value });
  }

  const hasMath1851AbCourse = candidates.some(({ value }) => math1851AbCoursePattern.test(value));
  const links = new Set<string>();
  for (const candidate of candidates) {
    const isMath1851Course = courseCodeFromText(candidate.value) === "MATH1851" || math1851AbCoursePattern.test(candidate.value);
    if (hasMath1851AbCourse && isMath1851Course && !math1851AbCoursePattern.test(candidate.value)) continue;
    links.add(candidate.canonical);
  }
  return Array.from(links);
};

/** Find activity pages whose own DOM may contain the actual Moodle file link. */
export const discoverMoodleDetailLinks = (
  snapshot: MoodlePageSnapshot,
  baseUrl: string,
): string[] => {
  const origin = new URL(baseUrl).origin;
  const links = new Set<string>();
  for (const link of snapshot.links) {
    if (isAccessibilitySkipLink(link)) continue;
    if (!sameOrigin(link.href, origin)) continue;

    let path = "";
    try {
      path = new URL(link.href).pathname.toLowerCase();
    } catch {
      continue;
    }

    if (!moodleDetailPathPattern.test(path)) continue;

    const canonical = toCanonicalMoodleUrl(link.href);
    if (canonical !== undefined) links.add(canonical);
  }
  return Array.from(links);
};

const monthNumbers: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

type CalendarDateParts = {
  year: number;
  month: number;
  day: number;
};

const hkuDateParts = (value: Date): CalendarDateParts => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
};

const parseClock = (value: string): { hour: number; minute: number } | undefined => {
  const twelveHour = value.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/iu);
  if (twelveHour !== null) {
    const rawHour = Number(twelveHour[1]);
    const minute = Number(twelveHour[2] ?? "0");
    if (rawHour < 1 || rawHour > 12 || minute > 59) return undefined;
    const meridiem = twelveHour[3]?.toLowerCase().startsWith("p") ? "pm" : "am";
    const hour = rawHour % 12 + (meridiem === "pm" ? 12 : 0);
    return { hour, minute };
  }

  const twentyFourHour = value.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/u);
  if (twentyFourHour === null) return undefined;
  return { hour: Number(twentyFourHour[1]), minute: Number(twentyFourHour[2]) };
};

const parseMonth = (value: string): number | undefined => {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 12) return numeric;
  return monthNumbers[value.toLowerCase()];
};

const buildHkuDate = (
  date: CalendarDateParts,
  clock: { hour: number; minute: number },
): Date | undefined => {
  if (
    !Number.isInteger(date.year) ||
    !Number.isInteger(date.month) ||
    !Number.isInteger(date.day) ||
    date.month < 1 ||
    date.month > 12 ||
    date.day < 1 ||
    date.day > 31 ||
    clock.hour < 0 ||
    clock.hour > 23 ||
    clock.minute < 0 ||
    clock.minute > 59
  ) return undefined;

  const value = new Date(
    `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}T${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}:00+08:00`,
  );
  if (Number.isNaN(value.getTime())) return undefined;
  const actual = hkuDateParts(value);
  return actual.year === date.year && actual.month === date.month && actual.day === date.day ? value : undefined;
};

/** Parse the date formats Moodle commonly renders, using Hong Kong time. */
export const parseMoodleDate = (
  value: string,
  now = new Date(),
  defaultHour = 23,
  defaultMinute = 59,
): Date | undefined => {
  const text = cleanText(value);
  if (text.length === 0) return undefined;

  const nowParts = hkuDateParts(now);
  let date: CalendarDateParts | undefined;

  const iso = text.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/u);
  if (iso !== null) {
    date = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }

  if (date === undefined) {
    const dayFirst = text.match(
      /\b(\d{1,2})(?:st|nd|rd|th)?[\s/-]+([A-Za-z]{3,9}|\d{1,2})(?:[\s,/-]+(20\d{2}))?\b/iu,
    );
    const month = dayFirst === null ? undefined : parseMonth(dayFirst[2] ?? "");
    if (dayFirst !== null && month !== undefined) {
      date = { year: Number(dayFirst[3] ?? nowParts.year), month, day: Number(dayFirst[1]) };
    }
  }

  if (date === undefined) {
    const monthFirst = text.match(
      /\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:[\s,/-]+(20\d{2}))?\b/iu,
    );
    const month = monthFirst === null ? undefined : parseMonth(monthFirst[1] ?? "");
    if (monthFirst !== null && month !== undefined) {
      date = {
        year: Number(monthFirst[3] ?? nowParts.year),
        month,
        day: Number(monthFirst[2]),
      };
    }
  }

  if (date === undefined) {
    const numeric = text.match(/\b(\d{1,2})[/. -](\d{1,2})[/. -](20\d{2})\b/u);
    if (numeric !== null) {
      date = { year: Number(numeric[3]), month: Number(numeric[2]), day: Number(numeric[1]) };
    }
  }

  if (date === undefined) {
    const relative = text.match(/\b(today|tomorrow|yesterday)\b/iu)?.[1]?.toLowerCase();
    if (relative !== undefined) {
      const offset = relative === "tomorrow" ? 1 : relative === "yesterday" ? -1 : 0;
      const relativeDate = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + offset));
      date = {
        year: relativeDate.getUTCFullYear(),
        month: relativeDate.getUTCMonth() + 1,
        day: relativeDate.getUTCDate(),
      };
    }
  }

  if (date === undefined) return undefined;
  return buildHkuDate(date, parseClock(text) ?? { hour: defaultHour, minute: defaultMinute });
};

const deadlineCuePattern = /\b(?:submission(?:\s+(?:due|deadline|by))?|due(?:\s+date)?|deadline|submit\b[^.!?]{0,60}?\b(?:by|before)|clos(?:e|es|ed|ing)(?:\s+date)?)\b\s*(?::|[-–—])?\s*/giu;
const weekdayPrefixPattern = /(?:(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s*,?\s*)?/iu;
const deadlineDatePattern = new RegExp(
  `^${weekdayPrefixPattern.source}(?:20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}(?:st|nd|rd|th)?[\\s/-]+(?:[A-Za-z]{3,9}|\\d{1,2})(?:[\\s,/-]+20\\d{2})?|[A-Za-z]{3,9}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:[\\s,/-]+20\\d{2})?|today|tomorrow|yesterday)\\b`,
  "iu",
);
const deadlineTimePattern = /^\s*(?:,\s*)?(?:at\s+)?(?:(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*[ap]\.?m\.?|(?:[01]?\d|2[0-3]):[0-5]\d)\b/iu;

/** Parse a due date only when a date immediately follows a deadline cue. */
const parseMoodleDeadline = (value: string, now: Date): Date | undefined => {
  const text = cleanText(value);
  for (const cue of text.matchAll(deadlineCuePattern)) {
    const cueEnd = (cue.index ?? 0) + cue[0].length;
    const afterCue = text.slice(cueEnd).replace(/^\s*(?:is|on|by|at)\s+/iu, "");
    const dateMatch = afterCue.match(deadlineDatePattern);
    if (dateMatch === null) continue;

    const remainder = afterCue.slice(dateMatch[0].length);
    const timeMatch = remainder.match(deadlineTimePattern);
    const dateText = `${dateMatch[0]}${timeMatch?.[0] ?? ""}`;
    const parsed = parseMoodleDate(dateText, now);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const candidateText = (_snapshot: MoodlePageSnapshot, link: MoodleLinkSnapshot): string =>
  stripMoodleNavigationChrome(`${link.text} ${link.ariaLabel} ${link.title} ${link.context}`);

const pathFor = (href: string): string => {
  try {
    return new URL(href).pathname.toLowerCase();
  } catch {
    return "";
  }
};

const moodleModuleId = (href: string): string | undefined => {
  const path = pathFor(href);
  if (!/\/mod\/(?:resource|folder)\//u.test(path)) return undefined;
  try {
    return new URL(href).searchParams.get("id") ?? undefined;
  } catch {
    return undefined;
  }
};

const moodleCourseId = (href: string): string | undefined => {
  try {
    const url = new URL(href);
    if (url.pathname.toLowerCase().endsWith("/course/view.php") || url.pathname.toLowerCase().endsWith("/course/view")) {
      return url.searchParams.get("id") ?? undefined;
    }
    const match = url.pathname.match(/\/pluginfile\.php\/(\d+)(?:\/|$)/iu);
    return match?.[1];
  } catch {
    return undefined;
  }
};

const isAnnouncementCandidate = (snapshot: MoodlePageSnapshot, link: MoodleLinkSnapshot): boolean => {
  const path = pathFor(link.href);
  const text = candidateText(snapshot, link);
  if (!path.includes("/mod/forum/")) return false;
  return /announcement|news|notice/iu.test(`${snapshot.title} ${text}`);
};

const isAssignmentCandidate = (snapshot: MoodlePageSnapshot, link: MoodleLinkSnapshot): boolean => {
  const path = pathFor(link.href);
  const text = candidateText(snapshot, link);
  if (!moodleAssignmentPathPattern.test(path)) return false;
  const assignmentCue = /assignment|assessment|quiz|exam|lab|workshop|submission|due|deadline/iu.test(text);
  // An assign landing page is unambiguous even when its visible title is a
  // week/topic label. Other activity types need an assessment cue so quiz
  // review/question pages cannot become fake assignments.
  return path.includes("/mod/assign/") || assignmentCue;
};

const isCourseFileCandidate = (snapshot: MoodlePageSnapshot, link: MoodleLinkSnapshot): boolean => {
  const path = pathFor(link.href);
  const text = candidateText(snapshot, link);
  const hasVisibleLabel = link.text.length > 0 || link.ariaLabel.length > 0 || link.title.length > 0;
  if (moodleResourcePathPattern.test(path)) return hasVisibleLabel;
  if (path.includes("/pluginfile.php")) {
    return (
      /\.(?:pdf|docx?|pptx?|xlsx?|zip|txt|csv|mp4|mov|png|jpe?g)(?:$|[?#])/iu.test(link.href) ||
      /download|attachment|lecture|slides|notes|file|reading|worksheet/iu.test(text)
    );
  }
  return /\.(?:pdf|docx?|pptx?|xlsx?|zip|txt|csv|mp4|mov|png|jpe?g)(?:$|[?#])/iu.test(link.href);
};

const itemId = (kind: string, href: string): string =>
  `moodle:${kind}:${createHash("sha256").update(href).digest("hex").slice(0, 24)}`;

const titleFor = (
  link: MoodleLinkSnapshot,
  fallback: string,
  course: string | undefined,
): string => {
  const raw = cleanText(link.text || link.ariaLabel || link.title || fallback);
  const title = raw.length > 0 ? raw.slice(0, 240) : fallback;
  if (course !== undefined && !title.toUpperCase().includes(course)) return `${course} ${title}`;
  return title;
};

const extensionFor = (value: string): string | undefined => {
  const match = value.match(/\.([a-z0-9]{1,8})(?:$|[?#])/iu);
  return match?.[1] === undefined ? undefined : `.${match[1].toLowerCase()}`;
};

const fileNameFor = (link: MoodleLinkSnapshot, title: string): string => {
  const pathPart = link.href.split(/[?#]/u)[0]?.split("/").pop();
  let decoded = "";
  try {
    decoded = pathPart === undefined ? "" : decodeURIComponent(pathPart);
  } catch {
    decoded = pathPart ?? "";
  }
  if (decoded.length > 0 && decoded !== "view.php" && decoded !== "pluginfile.php") return decoded;
  return title;
};

const createdAtCue = /posted|created|updated|published|uploaded|added|available/iu;

const makeItem = (
  kind: "announcement" | "assignment" | "course_file" | "unknown",
  snapshot: MoodlePageSnapshot,
  link: MoodleLinkSnapshot,
  now: Date,
): AgentItem | undefined => {
  const href = toCanonicalMoodleUrl(link.href);
  if (href === undefined) return undefined;

  const text = candidateText(snapshot, link);
  const course = courseCodeFromText(`${snapshot.url} ${snapshot.title} ${text}`);
  const courseId = moodleCourseId(snapshot.url) ?? moodleCourseId(href);
  const fallback = kind === "announcement" ? "Moodle announcement" : kind === "assignment" ? "Moodle assignment" : kind === "course_file" ? "Moodle course file" : "Moodle item";
  const title = titleFor(link, fallback, course);
  const metadata: Record<string, unknown> = { kind, href };
  if (kind === "unknown") metadata.rawType = "unknown";
  if (course !== undefined) metadata.course = course;
  if (course === undefined && courseId !== undefined) metadata.courseId = courseId;

  const context = stripMoodleNavigationChrome(link.context || text).slice(0, 4_000);
  const createdAt = createdAtCue.test(context) ? parseMoodleDate(context, now, 12, 0) : undefined;
  const deadline = kind === "assignment" ? parseMoodleDeadline(context, now) : undefined;
  metadata.createdAtStatus = createdAt === undefined ? "unknown" : "parsed";
  if (createdAt === undefined) {
    const rawCreatedAt = context.match(/\b(?:posted|created|updated|published|uploaded|added|available)\b[^.]{0,180}/iu)?.[0];
    if (rawCreatedAt !== undefined) metadata.rawCreatedAtText = rawCreatedAt;
  }
  if (kind === "assignment" || kind === "unknown") {
    metadata.deadlineStatus = deadline === undefined ? "unknown" : "parsed";
    const rawDeadline = context.match(/\b(?:due(?:\s+date)?|deadline|submission(?:\s+(?:due|deadline|by))?|submit(?:\s+(?:by|before))?)\b[^.]{0,180}/iu)?.[0];
    if (rawDeadline !== undefined) metadata.rawDeadlineText = rawDeadline;
  }
  if (snapshot.bodyTruncated || link.context.length >= 1_200 || link.context.length >= 4_000) metadata.contentTruncated = true;

  if (kind === "course_file") {
    const moduleId = moodleModuleId(snapshot.url) ?? moodleModuleId(href);
    if (moduleId !== undefined) metadata.moduleId = moduleId;
    const filename = fileNameFor(link, title).slice(0, 240);
    metadata.filename = filename;
    const downloadName = cleanText(link.download ?? "");
    if (downloadName.length > 0) metadata.downloadName = downloadName.slice(0, 240);
    const mimeType = cleanText(link.mimeType ?? "");
    if (mimeType.length > 0) metadata.mimeType = mimeType.slice(0, 120);
    const extension = extensionFor(`${filename} ${href}`);
    if (extension !== undefined) metadata.extension = extension;
  }

  return {
    id: itemId(kind, href),
    source: "moodle",
    title,
    content: context.length > 0 ? context : title,
    url: href,
    metadata,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(deadline === undefined ? {} : { deadline }),
  };
};

/** Convert compact, deterministic page snapshots into normalized Moodle items. */
export const extractMoodleItems = (
  snapshots: readonly MoodlePageSnapshot[],
  now = new Date(),
): MoodleCollection => {
  const announcements = new Map<string, AgentItem>();
  const assignments = new Map<string, AgentItem>();
  const courseFiles = new Map<string, AgentItem>();
  const uncertain = new Map<string, AgentItem>();

  for (const snapshot of snapshots) {
    for (const link of snapshot.links) {
      if (isAccessibilitySkipLink(link)) continue;
      const target = isAnnouncementCandidate(snapshot, link)
        ? announcements
        : isAssignmentCandidate(snapshot, link)
          ? assignments
          : isCourseFileCandidate(snapshot, link)
            ? courseFiles
            : isUnknownCandidate(snapshot, link)
              ? uncertain
              : undefined;
      if (target === undefined) continue;

      const kind = target === announcements ? "announcement" : target === assignments ? "assignment" : target === courseFiles ? "course_file" : "unknown";
      const item = makeItem(kind, snapshot, link, now);
      if (item !== undefined && !target.has(item.id)) target.set(item.id, item);
    }

    if (moodleAssignmentPathPattern.test(pathFor(snapshot.url))) {
      const pageLink: MoodleLinkSnapshot = {
        href: snapshot.url,
        text: snapshot.title || "Moodle assignment",
        context: snapshot.bodyText,
        title: snapshot.title,
        ariaLabel: "",
      };
      const item = makeItem("assignment", snapshot, pageLink, now);
      if (item !== undefined) assignments.set(item.id, item);
    }
  }

  // A resource/folder wrapper and its pluginfile target describe the same Moodle module.
  // Prefer the actual file URL when the bounded detail crawl found one.
  const nestedModuleIds = new Set(
    Array.from(courseFiles.values())
      .filter((item) => pathFor(item.url ?? "").includes("/pluginfile.php"))
      .map((item) => item.metadata.moduleId)
      .filter((value): value is string => typeof value === "string"),
  );
  for (const [id, item] of courseFiles) {
    if (
      typeof item.metadata.moduleId === "string" &&
      nestedModuleIds.has(item.metadata.moduleId) &&
      /\/mod\/(?:resource|folder)\//u.test(pathFor(item.url ?? ""))
    ) {
      courseFiles.delete(id);
    }
  }

  return {
    announcements: Array.from(announcements.values()),
    assignments: Array.from(assignments.values()),
    courseFiles: Array.from(courseFiles.values()),
    uncertain: Array.from(uncertain.values()),
  };
};

const isUnknownCandidate = (snapshot: MoodlePageSnapshot, link: MoodleLinkSnapshot): boolean => {
  if (isAnnouncementCandidate(snapshot, link) || isAssignmentCandidate(snapshot, link) || isCourseFileCandidate(snapshot, link)) return false;
  return /\b(?:deadline|due date|submit by|coursework|assessment|assignment|quiz|lecture|slides|worksheet|announcement|notice)\b/iu.test(candidateText(snapshot, link));
};

type MoodleResumeCursor = { version: 1; courseUrls: string[]; detailUrls: string[] };

const parseMoodleCursor = (value: string | undefined): MoodleResumeCursor => {
  if (value === undefined) return { version: 1, courseUrls: [], detailUrls: [] };
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || parsed.version !== 1) {
      return { version: 1, courseUrls: [], detailUrls: [] };
    }
    const cursor = parsed as { courseUrls?: unknown; detailUrls?: unknown };
    return {
      version: 1,
      courseUrls: Array.isArray(cursor.courseUrls) ? cursor.courseUrls.filter((url): url is string => typeof url === "string") : [],
      detailUrls: Array.isArray(cursor.detailUrls) ? cursor.detailUrls.filter((url): url is string => typeof url === "string") : [],
    };
  } catch {
    return { version: 1, courseUrls: [], detailUrls: [] };
  }
};

const emptyMoodleCoverage = (): SourceCoverage => ({
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
  scope: "Announcements, assignments, and course files",
});

export const collectMoodleItemsFromBrowser = async (
  options: MoodleBrowserOptions,
  now = new Date(),
): Promise<MoodleCollection> => {
  let coverage = emptyMoodleCoverage();
  const emitProgress = (progress: BrowserNavigationProgress): void =>
    options.onProgress?.({ ...progress, coverage });
  const session = new MoodleBrowserSession({ ...options, onProgress: emitProgress });
  const snapshots: MoodlePageSnapshot[] = [];
  const visited = new Set<string>();
  const failedCourseUrls: string[] = [];
  const failedDetailUrls: string[] = [];
  const resume = parseMoodleCursor(options.resumeCursor);
  try {
    let dashboard: MoodlePageSnapshot;
    try {
      dashboard = await session.goto(options.baseUrl);
    } catch (error: unknown) {
      coverage = { ...coverage, pagesFailed: 1, missedCountUnknown: true, partial: true };
      emitProgress({ phase: "failed", url: options.baseUrl, title: "Moodle dashboard page failed", coverage });
      throw error;
    }
    snapshots.push(dashboard);
    coverage = { ...coverage, pagesScanned: 1 };
    const courseLimit = options.maxCoursePages ?? defaultMaxCoursePages;
    const detailLimit = options.maxDetailPages ?? defaultMaxDetailPages;
    const courseQueue = Array.from(new Set([
      ...resume.courseUrls,
      ...discoverCourseLinks(dashboard, options.baseUrl),
    ]));
    const queuedCourses = courseQueue.slice(0, courseLimit);
    const remainingCourses = courseQueue.slice(courseLimit);
    const detailQueue = new Set(resume.detailUrls);

    for (const courseLink of queuedCourses) {
      const canonicalCourseLink = toCanonicalMoodleUrl(courseLink) ?? courseLink;
      if (visited.has(canonicalCourseLink)) continue;
      visited.add(canonicalCourseLink);
      try {
        const courseSnapshot = await session.goto(canonicalCourseLink);
        snapshots.push(courseSnapshot);
        coverage = { ...coverage, pagesScanned: coverage.pagesScanned + 1 };
        for (const detailLink of discoverMoodleDetailLinks(courseSnapshot, options.baseUrl)) detailQueue.add(detailLink);
      } catch (error: unknown) {
        coverage = { ...coverage, pagesFailed: coverage.pagesFailed + 1, itemsMissed: coverage.itemsMissed + 1 };
        failedCourseUrls.push(canonicalCourseLink);
        if (error instanceof MoodleAuthenticationRequiredError || session.isBroken()) {
          emitProgress({ phase: "failed", url: canonicalCourseLink, title: "Moodle course page failed", coverage: { ...coverage, missedCountUnknown: true, partial: true } });
          throw error;
        }
      }
    }

    const details = Array.from(detailQueue);
    let detailCount = 0;
    const remainingDetails: string[] = [];
    while (details.length > 0) {
      const detailLink = details.shift();
      if (detailLink === undefined) continue;
      const canonicalDetailLink = toCanonicalMoodleUrl(detailLink) ?? detailLink;
      if (visited.has(canonicalDetailLink)) continue;
      if (detailCount >= detailLimit) {
        remainingDetails.push(canonicalDetailLink, ...details);
        break;
      }
      visited.add(canonicalDetailLink);
      try {
        const detailSnapshot = await session.goto(canonicalDetailLink);
        snapshots.push(detailSnapshot);
        coverage = { ...coverage, pagesScanned: coverage.pagesScanned + 1 };
        detailCount += 1;
        for (const nestedLink of discoverMoodleDetailLinks(detailSnapshot, options.baseUrl)) {
          if (!visited.has(nestedLink)) details.push(nestedLink);
        }
      } catch (error: unknown) {
        coverage = { ...coverage, pagesFailed: coverage.pagesFailed + 1, itemsMissed: coverage.itemsMissed + 1 };
        failedDetailUrls.push(canonicalDetailLink);
        if (error instanceof MoodleAuthenticationRequiredError || session.isBroken()) {
          emitProgress({ phase: "failed", url: canonicalDetailLink, title: "Moodle activity page failed", coverage: { ...coverage, missedCountUnknown: true, partial: true } });
          throw error;
        }
      }
    }

    const collection = extractMoodleItems(snapshots, now);
    const items = [collection.announcements, collection.assignments, collection.courseFiles, collection.uncertain].flat();
    const candidateLinks = new Set<string>();
    for (const snapshot of snapshots) {
      for (const link of snapshot.links) {
        if (
          isAnnouncementCandidate(snapshot, link) ||
          isAssignmentCandidate(snapshot, link) ||
          isCourseFileCandidate(snapshot, link) ||
          isUnknownCandidate(snapshot, link)
        ) candidateLinks.add(toCanonicalMoodleUrl(link.href) ?? link.href);
      }
      if (moodleAssignmentPathPattern.test(pathFor(snapshot.url))) candidateLinks.add(toCanonicalMoodleUrl(snapshot.url) ?? snapshot.url);
    }
    const itemsTruncated = items.filter((item) => item.metadata.contentTruncated === true).length;
    const limitReached = remainingCourses.length > 0 || remainingDetails.length > 0;
    coverage = {
      ...coverage,
      itemsScanned: candidateLinks.size,
      itemsExtracted: items.length,
      itemsSkipped: Math.max(0, candidateLinks.size - items.length),
      itemsTruncated,
      pagesPending: remainingCourses.length + remainingDetails.length + failedCourseUrls.length + failedDetailUrls.length,
      missedCountUnknown: limitReached || coverage.pagesFailed > 0,
      limitReached,
      partial: limitReached || coverage.pagesFailed > 0 || itemsTruncated > 0,
    };
    const cursorUrls = {
      version: 1,
      courseUrls: [...remainingCourses, ...failedCourseUrls],
      detailUrls: [...remainingDetails, ...failedDetailUrls],
    } satisfies MoodleResumeCursor;
    const cursor = cursorUrls.courseUrls.length + cursorUrls.detailUrls.length > 0 ? JSON.stringify(cursorUrls) : null;
    emitProgress({
      phase: "ready",
      url: options.baseUrl,
      title: coverage.partial ? "Moodle coverage is partial" : "Moodle pages read",
      coverage,
      cursor,
    });
    return collection;
  } finally {
    await session.close();
  }
};
