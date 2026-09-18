import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { courseCodes } from "../config/courses.js";
import type { AgentItem } from "../types/index.js";

export type MoodleLinkSnapshot = {
  href: string;
  text: string;
  context: string;
  title: string;
  ariaLabel: string;
};

export type MoodlePageSnapshot = {
  url: string;
  title: string;
  bodyText: string;
  links: MoodleLinkSnapshot[];
};

export type MoodleCollection = {
  announcements: AgentItem[];
  assignments: AgentItem[];
  courseFiles: AgentItem[];
};

export type MoodleBrowserOptions = {
  baseUrl: string;
  profileDirectory?: string;
  cdpUrl?: string;
  headless?: boolean;
  timeoutMs?: number;
  loginTimeoutMs?: number;
  maxCoursePages?: number;
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
const defaultMaxCoursePages = 12;
const defaultProfileDirectory = join(process.cwd(), ".browser-profile");
const sensitiveQueryParameter = /^(?:token|wstoken|sesskey|session|password|pass|key)$/iu;
const courseCodePattern = new RegExp(`\\b(?:${courseCodes.join("|")})\\b`, "iu");

const cleanText = (value: string): string => value.replace(/\s+/gu, " ").trim();

const isHttpUrl = (value: URL): boolean => value.protocol === "https:" || value.protocol === "http:";

const toCanonicalMoodleUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (!isHttpUrl(url)) return undefined;
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (sensitiveQueryParameter.test(key)) url.searchParams.delete(key);
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
    };
    if (link.href.length > 0) links.push(link);
  }
  return {
    url: window.location.href,
    title: clean(document.title),
    bodyText: clean(document.body && document.body.innerText).slice(0, 50000),
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

  public constructor(private readonly options: MoodleBrowserOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (!isHttpUrl(baseUrl)) {
      throw new Error("MOODLE_BASE_URL must be an http(s) URL.");
    }
    this.origin = baseUrl.origin;
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
        args: this.options.headless ? [] : ["--window-size=1280,900", "--window-position=40,40"],
        ignoreDefaultArgs: ["--enable-automation"],
      });
      this.ownsContext = true;
    }

    this.context.setDefaultTimeout(this.timeoutMs);
    // Use a separate tab so an attached browser's current tab is not redirected.
    this.page = await this.context.newPage();
    return this.page;
  }

  public async goto(targetUrl: string): Promise<MoodlePageSnapshot> {
    const target = new URL(targetUrl, this.options.baseUrl);
    if (!isHttpUrl(target) || target.origin !== this.origin) {
      throw new Error("Moodle collector refused to navigate outside the configured Moodle origin.");
    }

    const page = await this.open();
    await page.goto(target.toString(), {
      waitUntil: "domcontentloaded",
      timeout: this.timeoutMs,
    });
    await page.waitForLoadState("networkidle", { timeout: Math.min(this.timeoutMs, 2_000) }).catch(() => {});
    await this.waitForAuthentication(page);
    return snapshotPage(page);
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
    const page = this.page;
    this.page = undefined;
    await page?.close().catch(() => {});

    if (this.ownsContext) {
      await this.context?.close().catch(() => {});
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
  const links = new Set<string>();
  for (const link of snapshot.links) {
    const value = `${link.href} ${link.text} ${link.context} ${link.title}`;
    if (!courseCodeFromText(value) || !sameOrigin(link.href, origin)) continue;

    let path = "";
    try {
      path = new URL(link.href).pathname.toLowerCase();
    } catch {
      continue;
    }
    if (!path.includes("/course/") && !path.includes("course/view")) continue;

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

const candidateText = (_snapshot: MoodlePageSnapshot, link: MoodleLinkSnapshot): string =>
  cleanText(`${link.text} ${link.ariaLabel} ${link.title} ${link.context}`);

const pathFor = (href: string): string => {
  try {
    return new URL(href).pathname.toLowerCase();
  } catch {
    return "";
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
  if (path.includes("/mod/assign/") || path.includes("/mod/quiz/") || path.includes("/mod/workshop/")) {
    return true;
  }
  return !path.includes("/course/") && /assignment|assessment|quiz|exam|lab|submission/iu.test(text);
};

const isCourseFileCandidate = (snapshot: MoodlePageSnapshot, link: MoodleLinkSnapshot): boolean => {
  const path = pathFor(link.href);
  const text = candidateText(snapshot, link);
  if (path.includes("/mod/resource/") || path.includes("/mod/folder/")) return true;
  if (path.includes("/pluginfile.php")) {
    return (
      /\.(?:pdf|docx?|pptx?|xlsx?|zip|txt|csv|mp4|mov|png|jpe?g)(?:$|[?#])/iu.test(link.href) ||
      /lecture|slides|notes|file|reading|worksheet/iu.test(text)
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
  kind: "announcement" | "assignment" | "course_file",
  snapshot: MoodlePageSnapshot,
  link: MoodleLinkSnapshot,
  now: Date,
): AgentItem | undefined => {
  const href = toCanonicalMoodleUrl(link.href);
  if (href === undefined) return undefined;

  const text = candidateText(snapshot, link);
  const course = courseCodeFromText(`${snapshot.url} ${snapshot.title} ${text}`);
  const fallback = kind === "announcement" ? "Moodle announcement" : kind === "assignment" ? "Moodle assignment" : "Moodle course file";
  const title = titleFor(link, fallback, course);
  const metadata: Record<string, unknown> = { kind, href };
  if (course !== undefined) metadata.course = course;

  const context = cleanText(link.context || text).slice(0, 4_000);
  const createdAt = createdAtCue.test(context) ? parseMoodleDate(context, now, 12, 0) : undefined;
  const deadline = kind === "assignment" && /due|deadline|submit|submission|close/iu.test(context)
    ? parseMoodleDate(context, now)
    : undefined;

  if (kind === "course_file") {
    const filename = fileNameFor(link, title).slice(0, 240);
    metadata.filename = filename;
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

  for (const snapshot of snapshots) {
    for (const link of snapshot.links) {
      const target = isAnnouncementCandidate(snapshot, link)
        ? announcements
        : isAssignmentCandidate(snapshot, link)
          ? assignments
          : isCourseFileCandidate(snapshot, link)
            ? courseFiles
            : undefined;
      if (target === undefined) continue;

      const kind = target === announcements ? "announcement" : target === assignments ? "assignment" : "course_file";
      const item = makeItem(kind, snapshot, link, now);
      if (item !== undefined && !target.has(item.id)) target.set(item.id, item);
    }
  }

  return {
    announcements: Array.from(announcements.values()),
    assignments: Array.from(assignments.values()),
    courseFiles: Array.from(courseFiles.values()),
  };
};

export const collectMoodleItemsFromBrowser = async (
  options: MoodleBrowserOptions,
  now = new Date(),
): Promise<MoodleCollection> => {
  const session = new MoodleBrowserSession(options);
  try {
    const dashboard = await session.goto(options.baseUrl);
    const snapshots: MoodlePageSnapshot[] = [dashboard];
    const courseLinks = discoverCourseLinks(dashboard, options.baseUrl).slice(
      0,
      options.maxCoursePages ?? defaultMaxCoursePages,
    );

    for (const courseLink of courseLinks) {
      try {
        snapshots.push(await session.goto(courseLink));
      } catch (error: unknown) {
        if (error instanceof MoodleAuthenticationRequiredError) throw error;
        // One unavailable course should not discard the rest of the read-only collection.
      }
    }

    return extractMoodleItems(snapshots, now);
  } finally {
    await session.close();
  }
};
