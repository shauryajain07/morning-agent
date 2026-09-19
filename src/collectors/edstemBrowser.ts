import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { parseMoodleDate } from "./moodleBrowser.js";
import type { AgentItem } from "../types/index.js";
import { cleanText } from "./text.js";

export type EdStemLinkSnapshot = {
  href: string;
  text: string;
  context: string;
  title: string;
  ariaLabel: string;
  dateText: string;
};

export type EdStemPageSnapshot = {
  url: string;
  title: string;
  headingText: string;
  bodyText: string;
  dateText: string;
  links: EdStemLinkSnapshot[];
};

export type EdStemBrowserOptions = {
  baseUrl: string;
  courseUrls?: string[];
  courses?: string[];
  profileDirectory?: string;
  cdpUrl?: string;
  headless?: boolean;
  timeoutMs?: number;
  loginTimeoutMs?: number;
  lookbackHours?: number;
  maxCoursePages?: number;
  maxLessonPages?: number;
};

export class EdStemAuthenticationRequiredError extends Error {
  public constructor(url: string) {
    super(
      `EdStem needs an interactive login in the configured browser profile before it can be read (${url}). ` +
        "No credentials or MFA steps are automated.",
    );
    this.name = "EdStemAuthenticationRequiredError";
  }
}

const defaultTimeoutMs = 15_000;
const defaultLoginTimeoutMs = 5 * 60 * 1_000;
const defaultLookbackHours = 24;
const defaultMaxCoursePages = 100;
const defaultMaxLessonPages = 500;
const defaultProfileDirectory = join(process.cwd(), ".edstem-browser-profile");
const allowedHostPattern = /(?:^|\.)edstem\.org$/iu;

const clean = (value: string): string => value.replace(/\s+/gu, " ").trim();

const isHttpUrl = (value: URL): boolean => value.protocol === "https:" || value.protocol === "http:";

const isAllowedEdStemUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && allowedHostPattern.test(url.hostname);
  } catch {
    return false;
  }
};

const canonicalUrl = (value: string, baseUrl: string): string | undefined => {
  try {
    const url = new URL(value, baseUrl);
    if (!isAllowedEdStemUrl(url.toString())) return undefined;
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(?:utm_[^ ]+|fbclid|gclid)$/iu.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return undefined;
  }
};

const pathSegments = (value: string): string[] => {
  try {
    return new URL(value).pathname.split("/").filter(Boolean).map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  } catch {
    return [];
  }
};

const courseRoute = (value: string): { prefix: string; courseId: string } | undefined => {
  const segments = pathSegments(value);
  const index = segments.findIndex((segment) => segment.toLowerCase() === "courses");
  const courseId = index < 0 ? undefined : segments[index + 1];
  if (courseId === undefined || courseId.length === 0) return undefined;
  try {
    const url = new URL(value);
    const prefix = url.pathname.split("/").slice(0, index + 2).join("/");
    return { prefix: prefix.startsWith("/") ? prefix : `/${prefix}`, courseId };
  } catch {
    return undefined;
  }
};

export const edStemCourseId = (value: string): string | undefined => courseRoute(value)?.courseId;

const lessonRoute = (value: string): { prefix: string; courseId: string; lessonId: string } | undefined => {
  const segments = pathSegments(value);
  const courseIndex = segments.findIndex((segment) => segment.toLowerCase() === "courses");
  const lessonsIndex = segments.findIndex(
    (segment, index) => index > courseIndex && segment.toLowerCase() === "lessons",
  );
  const courseId = courseIndex < 0 ? undefined : segments[courseIndex + 1];
  const lessonId = lessonsIndex < 0 ? undefined : segments[lessonsIndex + 1];
  if (courseId === undefined || lessonId === undefined || lessonId.length === 0) return undefined;
  try {
    const url = new URL(value);
    const prefix = url.pathname.split("/").slice(0, courseIndex + 2).join("/");
    return {
      prefix: prefix.startsWith("/") ? prefix : `/${prefix}`,
      courseId,
      lessonId,
    };
  } catch {
    return undefined;
  }
};

export const edStemLessonId = (value: string): string | undefined => lessonRoute(value)?.lessonId;

const courseRootUrl = (value: string): string | undefined => {
  const route = courseRoute(value);
  if (route === undefined) return undefined;
  try {
    return `${new URL(value).origin}${route.prefix}/${encodeURIComponent(route.courseId)}/`;
  } catch {
    return undefined;
  }
};

const lessonsIndexUrl = (value: string): string | undefined => {
  const route = courseRoute(value);
  if (route === undefined) return undefined;
  try {
    return `${new URL(value).origin}${route.prefix}/${encodeURIComponent(route.courseId)}/lessons`;
  } catch {
    return undefined;
  }
};

const lessonPageUrl = (value: string): string | undefined => {
  const route = lessonRoute(value);
  if (route === undefined) return undefined;
  try {
    return `${new URL(value).origin}${route.prefix}/${encodeURIComponent(route.courseId)}/lessons/${encodeURIComponent(route.lessonId)}`;
  } catch {
    return undefined;
  }
};

const snapshotScript = String.raw`(() => {
  const clean = (value) => (value || "").replace(/\s+/gu, " ").trim();
  const visibleText = (node) => {
    if (!node) return "";
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width < 2 || rect.height < 2) return "";
    return clean(node.innerText);
  };
  const main = document.querySelector('[role="main"], main, [data-testid="main"]') || document.body;
  const contextFor = (anchor) => {
    let node = anchor;
    for (let depth = 0; depth < 5 && node; depth += 1) {
      const text = visibleText(node);
      if (text.length >= 32) return text.slice(0, 1800);
      node = node.parentElement;
    }
    return visibleText(anchor).slice(0, 1800);
  };
  const dateFor = (node) => {
    let current = node;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      const time = current.querySelector && current.querySelector("time");
      if (time) return clean(time.getAttribute("datetime") || time.innerText || time.getAttribute("title"));
      const titled = current.querySelector && current.querySelector('[title*="20"], [title*="Today" i], [title*="Yesterday" i]');
      if (titled) return clean(titled.getAttribute("title") || titled.innerText);
      current = current.parentElement;
    }
    return "";
  };
  const links = [];
  const seen = new Set();
  // Ed's course navigation (including the Lessons book icon) can live outside
  // the semantic main region, so inspect the full document for links while
  // keeping the body snapshot scoped to the visible main content.
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const href = anchor.href;
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const text = visibleText(anchor);
    const ariaLabel = clean(anchor.getAttribute("aria-label"));
    const title = clean(anchor.getAttribute("title"));
    const context = contextFor(anchor);
    links.push({ href, text, context, title, ariaLabel, dateText: dateFor(anchor) });
    if (links.length >= 600) break;
  }
  const headingText = Array.from(main.querySelectorAll("h1, h2, h3, [role=heading]"))
    .map(visibleText)
    .filter(Boolean)
    .slice(0, 12)
    .join(" | ");
  const dateText = Array.from(main.querySelectorAll("time, [datetime]"))
    .map((node) => clean(node.getAttribute("datetime") || node.innerText || node.getAttribute("title")))
    .find(Boolean) || "";
  return {
    url: window.location.href,
    title: clean(document.title),
    headingText,
    bodyText: visibleText(main).slice(0, 60000),
    dateText,
    links,
  };
})()`;

const snapshotPage = async (page: Page): Promise<EdStemPageSnapshot> =>
  (await page.evaluate(snapshotScript)) as EdStemPageSnapshot;

export class EdStemBrowserSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private ownsContext = false;
  private readonly timeoutMs: number;
  private readonly loginTimeoutMs: number;

  public constructor(private readonly options: EdStemBrowserOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (!isHttpUrl(baseUrl) || !isAllowedEdStemUrl(baseUrl.toString())) {
      throw new Error("EDSTEM_BASE_URL must be an HTTPS EdStem URL.");
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
        args: this.options.headless ? [] : ["--window-size=1280,900", "--window-position=120,120"],
        ignoreDefaultArgs: ["--enable-automation"],
      });
      this.ownsContext = true;
    }

    this.context.setDefaultTimeout(this.timeoutMs);
    this.page = await this.context.newPage();
    return this.page;
  }

  public async goto(targetUrl: string): Promise<EdStemPageSnapshot> {
    const target = new URL(targetUrl, this.options.baseUrl);
    if (!isAllowedEdStemUrl(target.toString())) {
      throw new Error("EdStem collector refused to navigate outside the EdStem origin.");
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
    const loginUrl = /(?:\/login|\/auth|\/oauth|signin|sign-in|authorize)/iu.test(currentUrl);
    const passwordInputs = await page.locator('input[type="password"]:visible').count().catch(() => 0);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const loginPrompt = /log\s+in\s+to\s+continue|sign\s+in\s+to\s+continue/iu.test(bodyText.slice(0, 8_000));
    const publicLoginControls = await page
      .locator('[data-testid="login"], button.land-head-btn-login, a[href$="/login"]')
      .count()
      .catch(() => 0);
    const publicLanding = publicLoginControls > 0 && /\b(?:sign\s*up|login)\b/iu.test(bodyText.slice(0, 8_000));
    return !isAllowedEdStemUrl(currentUrl) || loginUrl || passwordInputs > 0 || loginPrompt || publicLanding;
  }

  private async openLoginScreen(page: Page): Promise<void> {
    const loginControl = page
      .locator('[data-testid="login"], button.land-head-btn-login, a[href$="/login"]')
      .first();
    if (await loginControl.count().catch(() => 0) === 0) return;
    await loginControl.click({ timeout: this.timeoutMs }).catch(() => {});
    await page.waitForTimeout(250);
  }

  private async waitForAuthentication(page: Page): Promise<void> {
    const deadline = Date.now() + this.loginTimeoutMs;
    const shellDeadline = Date.now() + Math.min(this.loginTimeoutMs, 10_000);
    let loginScreenOpened = false;
    while (Date.now() < deadline) {
      if (!(await this.isAuthenticationPage(page))) {
        const snapshot = await snapshotPage(page).catch(() => undefined);
        if (snapshot !== undefined && (snapshot.links.length > 0 || snapshot.bodyText.length > 0 || Date.now() >= shellDeadline)) {
          return;
        }
      } else if (this.options.headless === true) {
        throw new EdStemAuthenticationRequiredError(page.url());
      } else if (!loginScreenOpened) {
        loginScreenOpened = true;
        await this.openLoginScreen(page);
      }
      await page.waitForTimeout(750);
    }
    throw new EdStemAuthenticationRequiredError(page.url());
  }

  public async close(): Promise<void> {
    const page = this.page;
    this.page = undefined;
    await page?.close().catch(() => {});
    if (this.ownsContext) await this.context?.close().catch(() => {});
    // An attached browser belongs to the user; only close the collector's tab.
    this.browser = undefined;
    this.context = undefined;
    this.ownsContext = false;
  }
}

const candidateText = (snapshot: EdStemPageSnapshot, link: EdStemLinkSnapshot): string =>
  clean(`${snapshot.title} ${snapshot.headingText} ${link.text} ${link.ariaLabel} ${link.title} ${link.context}`);

const isLessonIndexPath = (value: string): boolean => {
  const segments = pathSegments(value).map((segment) => segment.toLowerCase());
  const lessonsIndex = segments.lastIndexOf("lessons");
  return lessonsIndex >= 0 && lessonsIndex === segments.length - 1;
};

const hasLessonRoute = (value: string): boolean => lessonRoute(value) !== undefined;

const isGenericCourseLabel = (value: string): boolean =>
  /^(?:home|course|courses|discussion|lessons?|resources?|assessments?|announcements?|ed\s*discussion|edstem)$/iu.test(value);

const courseRootLabel = (value: string): string | undefined => {
  const segments = pathSegments(value);
  const courseIndex = segments.findIndex((segment) => segment.toLowerCase() === "courses");
  if (courseIndex < 0 || segments.length !== courseIndex + 2) return undefined;
  return courseRoute(value)?.courseId;
};

const courseLabelFromLink = (link: EdStemLinkSnapshot): string | undefined => {
  const label = clean(link.text || link.ariaLabel || link.title);
  if (label.length === 0 || isGenericCourseLabel(label)) return undefined;
  return label.slice(0, 160);
};

const courseLabelFromSnapshot = (snapshot: EdStemPageSnapshot): { courseId: string; label: string } | undefined => {
  const courseId = courseRootLabel(snapshot.url);
  if (courseId === undefined) return undefined;
  const candidates = `${snapshot.headingText}|${snapshot.title}`
    .split("|")
    .map(clean)
    .filter((value) => value.length > 0 && !isGenericCourseLabel(value) && value !== courseId);
  const label = candidates[0];
  return label === undefined ? undefined : { courseId, label: label.slice(0, 160) };
};

const rememberCourseLabels = (snapshot: EdStemPageSnapshot, labels: Map<string, string>): void => {
  const snapshotLabel = courseLabelFromSnapshot(snapshot);
  if (snapshotLabel !== undefined && !labels.has(snapshotLabel.courseId)) {
    labels.set(snapshotLabel.courseId, snapshotLabel.label);
  }
  for (const link of snapshot.links) {
    const courseId = courseRootLabel(link.href);
    const label = courseId === undefined ? undefined : courseLabelFromLink(link);
    if (courseId !== undefined && label !== undefined && !labels.has(courseId)) labels.set(courseId, label);
  }
};

const matchesCourseFilter = (value: string, filters: readonly string[]): boolean => {
  if (filters.length === 0) return true;
  const text = value.toLowerCase();
  return filters.some((filter) => text.includes(filter.toLowerCase()));
};

export const discoverEdStemCourseLinks = (
  snapshot: EdStemPageSnapshot,
  baseUrl: string,
  filters: readonly string[] = [],
): string[] => {
  const candidates = new Map<string, string>();
  const currentCourse = courseRootUrl(snapshot.url);
  if (currentCourse !== undefined) {
    candidates.set(currentCourse, `${snapshot.url} ${snapshot.title} ${snapshot.headingText} ${snapshot.bodyText}`);
  }

  for (const link of snapshot.links) {
    const root = courseRootUrl(link.href);
    if (root === undefined) continue;
    const value = candidateText(snapshot, link);
    if (!matchesCourseFilter(`${root} ${value}`, filters)) continue;
    candidates.set(root, value);
  }

  return Array.from(candidates.entries())
    .filter(([url, value]) => canonicalUrl(url, baseUrl) !== undefined && matchesCourseFilter(`${url} ${value}`, filters))
    .map(([url]) => canonicalUrl(url, baseUrl) as string);
};

export const discoverEdStemLessonIndexLinks = (
  snapshot: EdStemPageSnapshot,
  baseUrl: string,
): string[] => {
  const links = new Set<string>();
  const current = isLessonIndexPath(snapshot.url) ? snapshot.url : undefined;
  if (current !== undefined) {
    const canonical = canonicalUrl(current, baseUrl);
    if (canonical !== undefined) links.add(canonical);
  }
  for (const link of snapshot.links) {
    if (!isLessonIndexPath(link.href)) continue;
    const canonical = canonicalUrl(link.href, baseUrl);
    if (canonical !== undefined) links.add(canonical);
  }
  return Array.from(links);
};

export const discoverEdStemLessonLinks = (
  snapshot: EdStemPageSnapshot,
  baseUrl: string,
): string[] => {
  const links = new Set<string>();
  for (const link of snapshot.links) {
    if (!hasLessonRoute(link.href)) continue;
    const lesson = lessonPageUrl(link.href);
    const canonical = lesson === undefined ? undefined : canonicalUrl(lesson, baseUrl);
    if (canonical !== undefined) links.add(canonical);
  }
  return Array.from(links);
};

const parseDate = (value: string, now: Date): Date | undefined => {
  const text = clean(value);
  if (text.length === 0) return undefined;
  if (/^20\d{2}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/iu.test(text)) {
    const direct = new Date(text);
    if (Number.isFinite(direct.getTime())) return direct;
  }
  const parsed = parseMoodleDate(text, now, 12, 0);
  if (parsed !== undefined) return parsed;
  const direct = new Date(text);
  return Number.isFinite(direct.getTime()) ? direct : undefined;
};

const resourcePathPattern = /\.(?:pdf|docx?|pptx?|xlsx?|zip|csv|txt|mp4|mov|png|jpe?g)(?:$|[?#])/iu;

const resourceLinks = (snapshot: EdStemPageSnapshot): Array<{ title: string; url: string }> => {
  const resources = new Map<string, { title: string; url: string }>();
  for (const link of snapshot.links) {
    const text = clean(`${link.text} ${link.ariaLabel} ${link.title} ${link.context}`);
    const sameSite = isAllowedEdStemUrl(link.href);
    const path = pathSegments(link.href).map((segment) => segment.toLowerCase()).join("/");
    const linkedLessonRoot = lessonPageUrl(link.href);
    const canonicalLink = canonicalUrl(link.href, snapshot.url);
    const isLessonNavigation =
      (hasLessonRoute(link.href) && linkedLessonRoot !== undefined && linkedLessonRoot === canonicalLink) ||
      /\/courses\/[^/]+\/(?:discussion|resources|assessments)(?:\/|$)/iu.test(`/${path}`);
    const looksLikeResource = resourcePathPattern.test(link.href) || /attachment|download|file|resource|slide|pdf|worksheet|reading/iu.test(text);
    if (!looksLikeResource || (sameSite && isLessonNavigation)) continue;
    const url = (() => {
      const internal = canonicalUrl(link.href, snapshot.url);
      if (internal !== undefined) return internal;
      try {
        const external = new URL(link.href, snapshot.url);
        if (external.protocol !== "https:" && external.protocol !== "http:") return undefined;
        external.hash = "";
        return external.toString();
      } catch {
        return undefined;
      }
    })();
    if (url === undefined) continue;
    const title = clean(link.text || link.ariaLabel || link.title || link.href).slice(0, 240);
    if (!resources.has(url)) resources.set(url, { title, url });
  }
  return Array.from(resources.values()).slice(0, 50);
};

const lessonTitle = (snapshot: EdStemPageSnapshot, route: { lessonId: string }): string => {
  const heading = snapshot.headingText
    .split("|")
    .map(clean)
    .find((value) => value.length > 0 && !/^lessons?$/iu.test(value));
  if (heading !== undefined) return heading.slice(0, 240);
  const title = clean(snapshot.title)
    .replace(/\s*[|—-]\s*(?:ed\s*)?(?:discussion|lessons?).*$/iu, "")
    .trim();
  if (title.length > 0) return title.slice(0, 240);
  return `EdStem lesson ${route.lessonId}`;
};

const lessonFingerprint = (
  title: string,
  bodyText: string,
  resources: readonly { title: string; url: string }[],
): string => createHash("sha256")
  .update(JSON.stringify({ title, bodyText: clean(bodyText).slice(0, 50_000), resources }))
  .digest("hex")
  .slice(0, 24);

export const extractEdStemLessonItems = (
  snapshots: readonly EdStemPageSnapshot[],
  now = new Date(),
  lookbackHours = defaultLookbackHours,
  courseLabels: ReadonlyMap<string, string> = new Map(),
): AgentItem[] => {
  const cutoff = now.getTime() - lookbackHours * 60 * 60 * 1_000;
  const latestAllowed = now.getTime() + 5 * 60 * 1_000;
  const items = new Map<string, AgentItem>();

  for (const snapshot of snapshots) {
    const route = lessonRoute(snapshot.url);
    if (route === undefined) continue;

    const title = lessonTitle(snapshot, route);
    const resources = resourceLinks(snapshot);
    const bodyText = clean(snapshot.bodyText).slice(0, 12_000);
    const content = bodyText.length > 0 ? bodyText : title;
    const fingerprint = lessonFingerprint(title, content, resources);
    const updatedAt = parseDate(snapshot.dateText, now);
    if (updatedAt !== undefined && (updatedAt.getTime() < cutoff || updatedAt.getTime() > latestAllowed)) continue;

    const url = lessonPageUrl(snapshot.url) ?? snapshot.url;
    const item = {
      id: `edstem:lesson:${route.courseId}:${route.lessonId}:${fingerprint}`,
      source: "edstem" as const,
      title,
      content,
      url,
      ...(updatedAt === undefined ? {} : { createdAt: updatedAt }),
      metadata: {
        kind: "lesson",
        platform: "edstem",
        courseId: route.courseId,
        ...(courseLabels.get(route.courseId) === undefined ? {} : { courseLabel: courseLabels.get(route.courseId) }),
        lessonId: route.lessonId,
        contentHash: fingerprint,
        resourceCount: resources.length,
        ...(resources.length === 0 ? {} : { resources }),
      },
    } satisfies AgentItem;
    if (!items.has(item.id) || (items.get(item.id)?.content?.length ?? 0) < content.length) items.set(item.id, item);
  }

  return Array.from(items.values()).sort((left, right) =>
    (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0),
  );
};

const uniqueUrls = (values: readonly string[], baseUrl: string): string[] => {
  const output = new Set<string>();
  for (const value of values) {
    const canonical = canonicalUrl(value, baseUrl);
    if (canonical !== undefined) output.add(canonical);
  }
  return Array.from(output);
};

export const collectEdStemLessonItemsFromBrowser = async (
  options: EdStemBrowserOptions,
  now = new Date(),
): Promise<AgentItem[]> => {
  const session = new EdStemBrowserSession(options);
  const snapshots: EdStemPageSnapshot[] = [];
  const courseLabels = new Map<string, string>();
  const visited = new Set<string>();
  const maxCoursePages = options.maxCoursePages ?? defaultMaxCoursePages;
  const maxLessonPages = options.maxLessonPages ?? defaultMaxLessonPages;

  const visit = async (url: string): Promise<EdStemPageSnapshot | undefined> => {
    const canonical = canonicalUrl(url, options.baseUrl);
    if (canonical === undefined || visited.has(canonical)) return undefined;
    visited.add(canonical);
    const snapshot = await session.goto(canonical);
    snapshots.push(snapshot);
    rememberCourseLabels(snapshot, courseLabels);
    return snapshot;
  };

  try {
    const entryUrls = uniqueUrls([options.baseUrl, ...(options.courseUrls ?? [])], options.baseUrl);
    for (const entryUrl of entryUrls.slice(0, maxCoursePages)) await visit(entryUrl);

    const courseUrls = uniqueUrls(
      [
        ...(options.courseUrls ?? []),
        ...snapshots.flatMap((snapshot) => discoverEdStemCourseLinks(snapshot, options.baseUrl, options.courses ?? [])),
      ],
      options.baseUrl,
    );
    for (const courseUrl of courseUrls.slice(0, maxCoursePages)) {
      await visit(courseUrl);
    }

    const indexUrls = uniqueUrls(
      snapshots.flatMap((snapshot) => discoverEdStemLessonIndexLinks(snapshot, options.baseUrl)),
      options.baseUrl,
    );
    for (const indexUrl of indexUrls.slice(0, maxCoursePages)) await visit(indexUrl);

    const lessonUrls = uniqueUrls(
      snapshots.flatMap((snapshot) => discoverEdStemLessonLinks(snapshot, options.baseUrl)),
      options.baseUrl,
    );
    for (const lessonUrl of lessonUrls.slice(0, maxLessonPages)) await visit(lessonUrl);

    // A course or lesson page can lazy-load another lesson list after navigation.
    // Take one final bounded discovery pass without clicking or submitting anything.
    const lateLessonUrls = uniqueUrls(
      snapshots.flatMap((snapshot) => discoverEdStemLessonLinks(snapshot, options.baseUrl)),
      options.baseUrl,
    );
    for (const lessonUrl of lateLessonUrls.slice(0, maxLessonPages)) await visit(lessonUrl);

    return extractEdStemLessonItems(snapshots, now, options.lookbackHours ?? defaultLookbackHours, courseLabels);
  } finally {
    await session.close();
  }
};
