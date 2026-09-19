import type { AgentItem } from "../types/index.js";
import { parseAgentItems } from "../types/schema.js";
import { cleanText } from "./text.js";

export type EdStemCourse = {
  id: string;
  code?: string;
  name?: string;
  year?: string;
  session?: string;
};

export type EdStemCollectorOptions = {
  enabled: boolean;
  token?: string;
  baseUrl: string;
  courses: string[];
  lookbackHours: number;
  maxThreads: number;
  maxCourses: number;
  timeoutMs: number;
};

type JsonRecord = Record<string, unknown>;

const defaultBaseUrl = "https://us.edstem.org/api";
const defaultLookbackHours = 24;
const defaultMaxThreads = 100;
const defaultMaxCourses = 50;
const defaultTimeoutMs = 15_000;

const nonEmptyEnvironmentValue = (key: string): string | undefined => {
  const value = process.env[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
};

const booleanEnvironmentValue = (key: string): boolean | undefined => {
  const value = nonEmptyEnvironmentValue(key)?.toLowerCase();
  if (value === undefined) return undefined;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(`${key} must be true or false.`);
};

const boundedIntegerEnvironmentValue = (
  key: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number => {
  const value = nonEmptyEnvironmentValue(key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
};

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined => typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
const asIdentifier = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value);
  return asString(value);
};

const asDate = (value: unknown): Date | undefined => {
  const text = asString(value);
  if (text === undefined) return undefined;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : undefined;
};

const listValue = (input: unknown, key: string): unknown[] => {
  if (Array.isArray(input)) return input;
  if (!isRecord(input)) return [];
  const direct = input[key];
  if (Array.isArray(direct)) return direct;
  const data = input.data;
  if (isRecord(data) && Array.isArray(data[key])) return data[key];
  return [];
};

const unwrapCourse = (value: unknown): JsonRecord | undefined => {
  if (!isRecord(value)) return undefined;
  return isRecord(value.course) ? value.course : value;
};

export const parseEdStemCourses = (input: unknown): EdStemCourse[] => {
  const courses = listValue(input, "courses").flatMap((value): EdStemCourse[] => {
    const course = unwrapCourse(value);
    const id = asIdentifier(course?.id);
    if (id === undefined) return [];
    const code = asString(course?.code);
    const name = asString(course?.name);
    const year = asString(course?.year);
    const session = asString(course?.session);
    return [{
      id,
      ...(code === undefined ? {} : { code }),
      ...(name === undefined ? {} : { name }),
      ...(year === undefined ? {} : { year }),
      ...(session === undefined ? {} : { session }),
    }];
  });
  const unique = new Map<string, EdStemCourse>();
  for (const course of courses) {
    if (!unique.has(course.id)) unique.set(course.id, course);
  }
  return Array.from(unique.values());
};

const threadList = (input: unknown): unknown[] => {
  if (Array.isArray(input)) return input;
  if (!isRecord(input)) return [];
  for (const key of ["threads", "results", "items"]) {
    if (Array.isArray(input[key])) return input[key];
  }
  const data = input.data;
  if (isRecord(data)) {
    for (const key of ["threads", "results", "items"]) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return [];
};

const threadUrl = (thread: JsonRecord, course: EdStemCourse, baseUrl: string): string => {
  const explicit = asString(thread.url) ?? asString(thread.href) ?? asString(thread.link);
  if (explicit !== undefined) {
    try {
      return new URL(explicit, baseUrl).toString();
    } catch {
      // Fall through to the deterministic course URL.
    }
  }
  const parsedBase = new URL(baseUrl);
  const region = parsedBase.hostname.split(".")[0] ?? "";
  const pathRegion = /^(us|au|uk|eu|ca)$/iu.test(region) ? `${region}/` : "";
  const threadNumber = asIdentifier(thread.number) ?? asIdentifier(thread.id) ?? "0";
  return `${parsedBase.origin}/${pathRegion}courses/${encodeURIComponent(course.id)}/discussion/${encodeURIComponent(threadNumber)}`;
};

export const parseEdStemThreads = (
  input: unknown,
  course: EdStemCourse,
  baseUrl: string,
  options: { now?: Date; lookbackHours?: number; maxThreads?: number } = {},
): AgentItem[] => {
  const now = options.now ?? new Date();
  const lookbackHours = options.lookbackHours ?? defaultLookbackHours;
  const maxThreads = options.maxThreads ?? defaultMaxThreads;
  const since = now.getTime() - lookbackHours * 60 * 60 * 1_000;
  const until = now.getTime() + 5 * 60 * 1_000;
  const items = threadList(input).flatMap((value): AgentItem[] => {
    if (!isRecord(value)) return [];
    const globalId = asIdentifier(value.id);
    const number = asIdentifier(value.number);
    const updatedAt = asDate(value.updated_at) ?? asDate(value.created_at);
    const title = asString(value.title);
    if (
      (globalId === undefined && number === undefined) ||
      title === undefined ||
      updatedAt === undefined ||
      updatedAt.getTime() < since ||
      updatedAt.getTime() > until
    ) return [];
    const document = asString(value.document) ?? asString(value.plaintext) ?? asString(value.content);
    const content = document === undefined ? undefined : cleanText(document);
    const newReplyCount = typeof value.new_reply_count === "number" && Number.isFinite(value.new_reply_count)
      ? value.new_reply_count
      : undefined;
    const isUnread = value.is_seen === false || (newReplyCount !== undefined && newReplyCount > 0);
    const itemIdentity = globalId ?? number ?? "unknown";
    return parseAgentItems([{
      id: `edstem:${course.id}:${itemIdentity}`,
      source: "edstem",
      title,
      ...(content === undefined || content.length === 0 ? {} : { content }),
      url: threadUrl(value, course, baseUrl),
      createdAt: updatedAt,
      metadata: {
        kind: "thread",
        platform: "edstem",
        courseId: course.id,
        ...(course.code === undefined ? {} : { course: course.code }),
        ...(course.name === undefined ? {} : { courseName: course.name }),
        ...(asString(value.category) === undefined ? {} : { category: asString(value.category) }),
        ...(asString(value.subcategory) === undefined ? {} : { subcategory: asString(value.subcategory) }),
        ...(number === undefined ? {} : { threadNumber: number }),
        ...(newReplyCount === undefined ? {} : { newReplyCount }),
        ...(isUnread ? { unread: true } : {}),
      },
    }]);
  });
  return items
    .sort((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0))
    .slice(0, maxThreads);
};

const endpoint = (baseUrl: string, path: string): URL => {
  const base = new URL(baseUrl);
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  return new URL(path.replace(/^\//u, ""), base);
};

const fetchJson = async (url: URL, options: EdStemCollectorOptions): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "Morning-Agent/0.1",
        "x-token": options.token ?? "",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`EdStem returned HTTP ${response.status}.`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timer);
  }
};

export const edStemOptionsFromEnvironment = (): EdStemCollectorOptions => {
  const token = nonEmptyEnvironmentValue("EDSTEM_TOKEN") ?? nonEmptyEnvironmentValue("ED_API_TOKEN");
  const explicitEnabled = booleanEnvironmentValue("EDSTEM_ENABLED");
  const configuredCourses = nonEmptyEnvironmentValue("EDSTEM_COURSES");
  const courses = (configuredCourses ?? "")
    .split(",")
    .map((course) => course.trim())
    .filter((course) => course.length > 0);
  return {
    enabled: explicitEnabled ?? token !== undefined,
    ...(token === undefined ? {} : { token }),
    baseUrl: nonEmptyEnvironmentValue("EDSTEM_BASE_URL") ?? defaultBaseUrl,
    courses,
    lookbackHours: boundedIntegerEnvironmentValue("EDSTEM_LOOKBACK_HOURS", 1, 168, defaultLookbackHours),
    maxThreads: boundedIntegerEnvironmentValue("EDSTEM_MAX_THREADS", 1, 500, defaultMaxThreads),
    maxCourses: boundedIntegerEnvironmentValue("EDSTEM_MAX_COURSES", 1, 100, defaultMaxCourses),
    timeoutMs: boundedIntegerEnvironmentValue("EDSTEM_TIMEOUT_MS", 1_000, 120_000, defaultTimeoutMs),
  };
};

const courseMatches = (course: EdStemCourse, configured: string): boolean => {
  const needle = configured.toLowerCase();
  return course.id.toLowerCase() === needle || course.code?.toLowerCase() === needle || course.name?.toLowerCase() === needle;
};

export const collectEdStemItems = async (): Promise<AgentItem[]> => {
  const options = edStemOptionsFromEnvironment();
  if (!options.enabled || options.token === undefined) return [];
  const userPayload = await fetchJson(endpoint(options.baseUrl, "user"), options);
  let courses = parseEdStemCourses(userPayload);
  if (options.courses.length > 0) {
    courses = courses.filter((course) => options.courses.some((configured) => courseMatches(course, configured)));
  }
  courses = courses.slice(0, options.maxCourses);
  const results = await Promise.all(courses.map(async (course) => {
    const threadsEndpoint = endpoint(options.baseUrl, `courses/${encodeURIComponent(course.id)}/threads`);
    threadsEndpoint.searchParams.set("limit", String(Math.min(options.maxThreads, 100)));
    threadsEndpoint.searchParams.set("offset", "0");
    threadsEndpoint.searchParams.set("sort", "new");
    return parseEdStemThreads(
      await fetchJson(threadsEndpoint, options),
      course,
      options.baseUrl,
      options,
    );
  }));
  const deduplicated = new Map<string, AgentItem>();
  for (const items of results) {
    for (const item of items) deduplicated.set(item.id, item);
  }
  return Array.from(deduplicated.values())
    .sort((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0))
    .slice(0, options.maxThreads);
};
