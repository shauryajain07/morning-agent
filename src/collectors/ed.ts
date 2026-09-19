import { z } from "zod";

import type { AgentItem } from "../types/index.js";
import { parseAgentItems } from "../types/schema.js";
import { cleanText } from "./text.js";

export type EdPostSnapshot = {
  id: number;
  date?: string;
  modified?: string;
  link?: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  content?: { rendered?: string };
};

export type EdCollectorOptions = {
  enabled: boolean;
  baseUrl: string;
  lookbackHours: number;
  maxPosts: number;
  timeoutMs: number;
};

const defaultBaseUrl = "https://ed.com/";
const defaultLookbackHours = 24;
const defaultMaxPosts = 50;
const defaultTimeoutMs = 15_000;

const edPostSchema = z.object({
  id: z.number().int().positive(),
  date: z.string().optional(),
  modified: z.string().optional(),
  link: z.string().optional(),
  title: z.object({ rendered: z.string().optional() }).optional(),
  excerpt: z.object({ rendered: z.string().optional() }).optional(),
  content: z.object({ rendered: z.string().optional() }).optional(),
}).passthrough();

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

const postDate = (post: EdPostSnapshot): Date | undefined => {
  const candidate = post.modified ?? post.date;
  if (candidate === undefined) return undefined;
  const date = new Date(candidate);
  return Number.isFinite(date.getTime()) ? date : undefined;
};

export const parseEdPosts = (
  input: unknown,
  options: { now?: Date; lookbackHours?: number; maxPosts?: number } = {},
): AgentItem[] => {
  const parsed = z.array(edPostSchema).parse(input) as EdPostSnapshot[];
  const now = options.now ?? new Date();
  const lookbackHours = options.lookbackHours ?? defaultLookbackHours;
  const maxPosts = options.maxPosts ?? defaultMaxPosts;
  const since = now.getTime() - lookbackHours * 60 * 60 * 1_000;
  const until = now.getTime() + 5 * 60 * 1_000;
  const items = parsed.flatMap((post): AgentItem[] => {
    const date = postDate(post);
    const link = post.link?.trim();
    const title = cleanText(post.title?.rendered ?? "");
    if (
      date === undefined ||
      date.getTime() < since ||
      date.getTime() > until ||
      link === undefined ||
      title.length === 0
    ) return [];
    try {
      new URL(link);
    } catch {
      return [];
    }
    const excerpt = cleanText(post.excerpt?.rendered ?? "");
    const content = cleanText(post.content?.rendered ?? "");
    return parseAgentItems([{
      id: `ed:${post.id}`,
      source: "ed",
      title,
      ...(excerpt.length > 0 || content.length > 0 ? { content: excerpt || content } : {}),
      url: link,
      createdAt: date,
      metadata: {
        kind: "article",
        site: "ed.com",
        source: "wordpress",
        ...(post.modified === undefined ? {} : { modifiedAt: post.modified }),
      },
    }]);
  });
  return items
    .sort((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0))
    .slice(0, maxPosts);
};

const fetchJson = async (url: URL, timeoutMs: number): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Morning-Agent/0.1" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`ed.com returned HTTP ${response.status}.`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timer);
  }
};

export const edOptionsFromEnvironment = (): EdCollectorOptions => {
  const explicitEnabled = booleanEnvironmentValue("ED_ENABLED");
  return {
    // ed.com is public, so it is on by default; ED_ENABLED=false opts out.
    enabled: explicitEnabled ?? true,
    baseUrl: nonEmptyEnvironmentValue("ED_BASE_URL") ?? defaultBaseUrl,
    lookbackHours: boundedIntegerEnvironmentValue("ED_LOOKBACK_HOURS", 1, 168, defaultLookbackHours),
    maxPosts: boundedIntegerEnvironmentValue("ED_MAX_POSTS", 1, 100, defaultMaxPosts),
    timeoutMs: boundedIntegerEnvironmentValue("ED_TIMEOUT_MS", 1_000, 120_000, defaultTimeoutMs),
  };
};

export const collectEdItems = async (): Promise<AgentItem[]> => {
  const options = edOptionsFromEnvironment();
  if (!options.enabled) return [];
  const baseUrl = new URL(options.baseUrl);
  const endpoint = new URL("/wp-json/wp/v2/posts", baseUrl);
  endpoint.searchParams.set("per_page", String(Math.min(options.maxPosts, 100)));
  endpoint.searchParams.set("modified_after", new Date(Date.now() - options.lookbackHours * 60 * 60 * 1_000).toISOString());
  endpoint.searchParams.set("_fields", "id,date,modified,link,title,excerpt,content");
  const payload = await fetchJson(endpoint, options.timeoutMs);
  return parseEdPosts(payload, options);
};
