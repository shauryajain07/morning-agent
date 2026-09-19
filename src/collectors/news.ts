import { createHash } from "node:crypto";

import type { AgentItem } from "../types/index.js";
import { parseAgentItems } from "../types/schema.js";
import { cleanText, decodeHtmlEntities } from "./text.js";

export type NewsCollectorOptions = {
  enabled: boolean;
  feeds: string[];
  lookbackHours: number;
  maxItems: number;
  timeoutMs: number;
};

const defaultFeeds = [
  "https://feeds.bbci.co.uk/news/rss.xml",
  "https://hnrss.org/frontpage",
];
const defaultLookbackHours = 24;
const defaultMaxItems = 100;
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

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const tagValue = (block: string, tag: string): string | undefined => {
  const escapedTag = escapeRegExp(tag);
  const match = block.match(new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}\\s*>`, "iu"));
  const value = match?.[1];
  if (value === undefined) return undefined;
  const cleaned = cleanText(value);
  return cleaned.length === 0 ? undefined : cleaned;
};

const attributeValue = (block: string, tag: string, attribute: string): string | undefined => {
  const escapedTag = escapeRegExp(tag);
  const escapedAttribute = escapeRegExp(attribute);
  const match = block.match(new RegExp(`<${escapedTag}\\b[^>]*\\b${escapedAttribute}=["']([^"']+)["']`, "iu"));
  const value = match?.[1];
  return value === undefined ? undefined : decodeHtmlEntities(value.trim());
};

const firstTagValue = (block: string, tags: readonly string[]): string | undefined => {
  for (const tag of tags) {
    const value = tagValue(block, tag);
    if (value !== undefined) return value;
  }
  return undefined;
};

const blocksFor = (xml: string, tag: "item" | "entry"): string[] => {
  const escapedTag = escapeRegExp(tag);
  return Array.from(xml.matchAll(new RegExp(`<${escapedTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escapedTag}\\s*>`, "giu")))
    .map((match) => match[0]);
};

const linkFor = (block: string, feedUrl: string): string | undefined => {
  const tagged = tagValue(block, "link");
  const attributed = attributeValue(block, "link", "href");
  const value = tagged ?? attributed;
  if (value === undefined) return undefined;
  try {
    return new URL(value, feedUrl).toString();
  } catch {
    return undefined;
  }
};

const dateFor = (block: string): Date | undefined => {
  const value = firstTagValue(block, ["pubDate", "published", "updated", "date"]);
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
};

const stableId = (url: string): string => `news:${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;

export const parseNewsFeed = (
  xml: string,
  feedUrl: string,
  options: { now?: Date; lookbackHours?: number; maxItems?: number } = {},
): AgentItem[] => {
  const now = options.now ?? new Date();
  const lookbackHours = options.lookbackHours ?? defaultLookbackHours;
  const maxItems = options.maxItems ?? defaultMaxItems;
  const since = now.getTime() - lookbackHours * 60 * 60 * 1_000;
  const until = now.getTime() + 5 * 60 * 1_000;
  const blocks = blocksFor(xml, "item");
  const entries = blocks.length > 0 ? blocks : blocksFor(xml, "entry");
  let feedHost = "unknown feed";
  try {
    feedHost = new URL(feedUrl).hostname;
  } catch {
    // Keep the parser useful for fixtures even if the caller passes a placeholder feed URL.
  }

  const items = entries.flatMap((block): AgentItem[] => {
    const title = firstTagValue(block, ["title"]);
    const url = linkFor(block, feedUrl);
    const createdAt = dateFor(block);
    if (
      title === undefined ||
      url === undefined ||
      createdAt === undefined ||
      createdAt.getTime() < since ||
      createdAt.getTime() > until
    ) return [];
    const content = firstTagValue(block, ["description", "summary", "content:encoded", "content"]);
    return parseAgentItems([{
      id: stableId(url),
      source: "news",
      title,
      ...(content === undefined ? {} : { content }),
      url,
      createdAt,
      metadata: {
        kind: "news_article",
        feed: feedUrl,
        feedHost,
        sourceType: "rss",
        publishedAt: createdAt.toISOString(),
      },
    }]);
  });
  return items
    .sort((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0))
    .slice(0, maxItems);
};

const fetchFeed = async (feed: string, timeoutMs: number): Promise<string> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(feed, {
      headers: {
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        "user-agent": "Morning-Agent/0.1",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${feed} returned HTTP ${response.status}.`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
};

export const newsOptionsFromEnvironment = (): NewsCollectorOptions => {
  const explicitEnabled = booleanEnvironmentValue("NEWS_ENABLED");
  const configuredFeeds = nonEmptyEnvironmentValue("NEWS_FEEDS");
  const feeds = (configuredFeeds === undefined ? defaultFeeds : configuredFeeds.split(","))
    .map((feed) => feed.trim())
    .filter((feed) => feed.length > 0);
  if (feeds.length === 0) throw new Error("NEWS_FEEDS must contain at least one RSS or Atom URL.");
  for (const feed of feeds) {
    try {
      const url = new URL(feed);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      throw new Error(`NEWS_FEEDS contains an invalid URL: ${feed}`);
    }
  }
  return {
    // Daily news is on by default; NEWS_ENABLED=false opts out and NEWS_FEEDS customizes it.
    enabled: explicitEnabled ?? true,
    feeds,
    lookbackHours: boundedIntegerEnvironmentValue("NEWS_LOOKBACK_HOURS", 1, 168, defaultLookbackHours),
    maxItems: boundedIntegerEnvironmentValue("NEWS_MAX_ITEMS", 1, 500, defaultMaxItems),
    timeoutMs: boundedIntegerEnvironmentValue("NEWS_TIMEOUT_MS", 1_000, 120_000, defaultTimeoutMs),
  };
};

export const collectNewsItems = async (): Promise<AgentItem[]> => {
  const options = newsOptionsFromEnvironment();
  if (!options.enabled) return [];
  const results = await Promise.allSettled(options.feeds.map(async (feed) => {
    const xml = await fetchFeed(feed, options.timeoutMs);
    return parseNewsFeed(xml, feed, options);
  }));
  const deduplicated = new Map<string, AgentItem>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const item of result.value) deduplicated.set(item.id, item);
  }
  return Array.from(deduplicated.values())
    .sort((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0))
    .slice(0, options.maxItems);
};
