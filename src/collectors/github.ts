import { createHash } from "node:crypto";

import type { AgentItem } from "../types/index.js";
import { parseAgentItems } from "../types/schema.js";
import { cleanText } from "./text.js";

export type GitHubCollectorOptions = {
  enabled: boolean;
  token?: string;
  username?: string;
  repositories: string[];
  lookbackHours: number;
  maxItems: number;
  timeoutMs: number;
  apiBaseUrl: string;
};

type JsonRecord = Record<string, unknown>;

const defaultApiBaseUrl = "https://api.github.com";
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

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined => typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
const asNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asDate = (value: unknown): Date | undefined => {
  const text = asString(value);
  if (text === undefined) return undefined;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : undefined;
};

const repositoryHtmlUrl = (repository: string): string => `https://github.com/${repository}`;

const apiUrlToHtmlUrl = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const match = value.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)/iu);
  if (match === null) return undefined;
  return `https://github.com/${match[1]}/${match[2]}/${match[3]}`;
};

const stableHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);

const lookbackWindow = (now: Date, lookbackHours: number): { since: number; until: number } => ({
  since: now.getTime() - lookbackHours * 60 * 60 * 1_000,
  until: now.getTime() + 5 * 60 * 1_000,
});

export const parseGitHubIssueItems = (
  input: unknown,
  repository: string,
  options: { now?: Date; lookbackHours?: number; maxItems?: number } = {},
): AgentItem[] => {
  if (!Array.isArray(input)) return [];
  const now = options.now ?? new Date();
  const window = lookbackWindow(now, options.lookbackHours ?? defaultLookbackHours);
  const maxItems = options.maxItems ?? defaultMaxItems;
  const items = input.flatMap((value): AgentItem[] => {
    if (!isRecord(value)) return [];
    const number = asNumber(value.number);
    const title = asString(value.title);
    const url = asString(value.html_url);
    const updatedAt = asDate(value.updated_at) ?? asDate(value.created_at);
    if (number === undefined || title === undefined || url === undefined || updatedAt === undefined) return [];
    if (updatedAt.getTime() < window.since || updatedAt.getTime() > window.until) return [];
    const isPullRequest = isRecord(value.pull_request);
    const user = isRecord(value.user) ? asString(value.user.login) : undefined;
    const body = asString(value.body);
    const content = body === undefined ? undefined : cleanText(body);
    return parseAgentItems([{
      id: `github:${repository}:${number}`,
      source: "github",
      title: `${isPullRequest ? "PR" : "Issue"} #${number} · ${title}`,
      ...(content === undefined || content.length === 0 ? {} : { content }),
      url,
      createdAt: updatedAt,
      metadata: {
        kind: isPullRequest ? "pull_request" : "issue",
        repository,
        number,
        state: asString(value.state) ?? "unknown",
        action: "updated",
        ...(user === undefined ? {} : { author: user }),
      },
    }]);
  });
  return items
    .sort((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0))
    .slice(0, maxItems);
};

export const parseGitHubNotificationItems = (
  input: unknown,
  options: { now?: Date; lookbackHours?: number; maxItems?: number } = {},
): AgentItem[] => {
  if (!Array.isArray(input)) return [];
  const now = options.now ?? new Date();
  const window = lookbackWindow(now, options.lookbackHours ?? defaultLookbackHours);
  const maxItems = options.maxItems ?? defaultMaxItems;
  const items = input.flatMap((value): AgentItem[] => {
    if (!isRecord(value)) return [];
    const notificationId = asString(value.id);
    const updatedAt = asDate(value.updated_at);
    const subject = isRecord(value.subject) ? value.subject : {};
    const title = asString(subject.title);
    const repositoryValue = isRecord(value.repository) ? value.repository : {};
    const repository = asString(repositoryValue.full_name);
    const subjectApiUrl = asString(subject.url);
    const url = apiUrlToHtmlUrl(subjectApiUrl) ?? (repository === undefined ? undefined : repositoryHtmlUrl(repository));
    if (updatedAt === undefined || title === undefined || url === undefined) return [];
    if (updatedAt.getTime() < window.since || updatedAt.getTime() > window.until) return [];
    const identity = notificationId ?? `${repository ?? "github"}:${subjectApiUrl ?? title}`;
    const reason = asString(value.reason);
    return parseAgentItems([{
      id: `github:notification:${notificationId ?? stableHash(identity)}`,
      source: "github",
      title,
      content: `GitHub notification${repository === undefined ? "" : ` in ${repository}`}.`,
      url,
      createdAt: updatedAt,
      metadata: {
        kind: "notification",
        ...(repository === undefined ? {} : { repository }),
        ...(reason === undefined ? {} : { reason }),
      },
    }]);
  });
  return items
    .sort((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0))
    .slice(0, maxItems);
};

const eventTitle = (eventType: string, payload: JsonRecord, repository: string): { title: string; content?: string; url: string } => {
  const issue = isRecord(payload.issue) ? payload.issue : undefined;
  const pullRequest = isRecord(payload.pull_request) ? payload.pull_request : undefined;
  const issueTitle = asString(issue?.title) ?? asString(pullRequest?.title);
  const issueUrl = asString(issue?.html_url) ?? asString(pullRequest?.html_url);
  const action = asString(payload.action);
  if (issueTitle !== undefined) {
    return {
      title: `${eventType.replace(/Event$/u, "")} · ${issueTitle}`,
      ...(action === undefined ? {} : { content: `GitHub action: ${action}.` }),
      url: issueUrl ?? repositoryHtmlUrl(repository),
    };
  }
  const ref = asString(payload.ref);
  return {
    title: `${eventType.replace(/Event$/u, "")} in ${repository}`,
    ...(ref === undefined ? {} : { content: `Reference: ${ref}.` }),
    url: repositoryHtmlUrl(repository),
  };
};

export const parseGitHubEventItems = (
  input: unknown,
  options: { now?: Date; lookbackHours?: number; maxItems?: number } = {},
): AgentItem[] => {
  if (!Array.isArray(input)) return [];
  const now = options.now ?? new Date();
  const window = lookbackWindow(now, options.lookbackHours ?? defaultLookbackHours);
  const maxItems = options.maxItems ?? defaultMaxItems;
  const items = input.flatMap((value): AgentItem[] => {
    if (!isRecord(value)) return [];
    const eventId = asString(value.id);
    const eventType = asString(value.type);
    const createdAt = asDate(value.created_at);
    const repositoryValue = isRecord(value.repo) ? value.repo : {};
    const repository = asString(repositoryValue.name);
    const payload = isRecord(value.payload) ? value.payload : {};
    if (eventId === undefined || eventType === undefined || createdAt === undefined || repository === undefined) return [];
    if (createdAt.getTime() < window.since || createdAt.getTime() > window.until) return [];
    const detail = eventTitle(eventType, payload, repository);
    const action = asString(payload.action);
    return parseAgentItems([{
      id: `github:event:${eventId}`,
      source: "github",
      title: detail.title,
      ...(detail.content === undefined ? {} : { content: detail.content }),
      url: detail.url,
      createdAt,
      metadata: {
        kind: "event",
        eventType,
        repository,
        ...(action === undefined ? {} : { action }),
      },
    }]);
  });
  return items
    .sort((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0))
    .slice(0, maxItems);
};

const fetchJson = async (url: string, options: GitHubCollectorOptions): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "Morning-Agent/0.1",
    "x-github-api-version": "2022-11-28",
  };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timer);
  }
};

const repositoryPath = (repository: string): string => repository.split("/").map((part) => encodeURIComponent(part)).join("/");

export const githubOptionsFromEnvironment = (): GitHubCollectorOptions => {
  const token = nonEmptyEnvironmentValue("GITHUB_TOKEN");
  const username = nonEmptyEnvironmentValue("GITHUB_USERNAME");
  const configuredRepositories = nonEmptyEnvironmentValue("GITHUB_REPOS");
  const repositories = (configuredRepositories ?? "")
    .split(",")
    .map((repository) => repository.trim())
    .filter((repository) => repository.length > 0);
  for (const repository of repositories) {
    if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
      throw new Error(`GITHUB_REPOS contains an invalid owner/repository value: ${repository}`);
    }
  }
  const explicitEnabled = booleanEnvironmentValue("GITHUB_ENABLED");
  return {
    enabled: explicitEnabled ?? (token !== undefined || username !== undefined || repositories.length > 0),
    ...(token === undefined ? {} : { token }),
    ...(username === undefined ? {} : { username }),
    repositories,
    lookbackHours: boundedIntegerEnvironmentValue("GITHUB_LOOKBACK_HOURS", 1, 168, defaultLookbackHours),
    maxItems: boundedIntegerEnvironmentValue("GITHUB_MAX_ITEMS", 1, 500, defaultMaxItems),
    timeoutMs: boundedIntegerEnvironmentValue("GITHUB_TIMEOUT_MS", 1_000, 120_000, defaultTimeoutMs),
    apiBaseUrl: nonEmptyEnvironmentValue("GITHUB_API_BASE_URL") ?? defaultApiBaseUrl,
  };
};

export const getMockGitHubItems = (): AgentItem[] =>
  parseAgentItems([
    {
      id: "github-rootatom-pr-42-review",
      source: "github",
      title: "RootAtom PR #42 awaiting your review",
      content: "A review was requested from you on the pull request.",
      url: "https://github.com/RootAtom/example/pull/42",
      createdAt: new Date("2026-09-18T00:15:00.000Z"),
      metadata: {
        kind: "review_request",
        repository: "RootAtom/example",
        pullRequestNumber: 42,
        requestedReviewer: "me",
      },
    },
    {
      id: "github-rootatom-issue-17-assigned",
      source: "github",
      title: "RootAtom issue #17 assigned to you",
      content: "Investigate the onboarding regression.",
      url: "https://github.com/RootAtom/example/issues/17",
      createdAt: new Date("2026-09-17T23:50:00.000Z"),
      metadata: {
        kind: "assigned_issue",
        repository: "RootAtom/example",
        issueNumber: 17,
        assignee: "me",
      },
    },
  ]);

export const collectGitHubItems = async (): Promise<AgentItem[]> => {
  const options = githubOptionsFromEnvironment();
  if (!options.enabled) return [];
  if (options.repositories.length === 0 && options.token === undefined && options.username === undefined) return [];

  const now = new Date();
  if (options.repositories.length > 0) {
    const since = new Date(now.getTime() - options.lookbackHours * 60 * 60 * 1_000).toISOString();
    const results = await Promise.all(options.repositories.map(async (repository) => {
      const endpoint = new URL(`/repos/${repositoryPath(repository)}/issues`, options.apiBaseUrl);
      endpoint.searchParams.set("state", "all");
      endpoint.searchParams.set("sort", "updated");
      endpoint.searchParams.set("direction", "desc");
      endpoint.searchParams.set("since", since);
      endpoint.searchParams.set("per_page", String(Math.min(options.maxItems, 100)));
      return parseGitHubIssueItems(await fetchJson(endpoint.toString(), options), repository, options);
    }));
    return results.flat()
      .sort((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0))
      .slice(0, options.maxItems);
  }

  if (options.token !== undefined) {
    const endpoint = new URL("/notifications", options.apiBaseUrl);
    endpoint.searchParams.set("all", "false");
    endpoint.searchParams.set("participating", "true");
    endpoint.searchParams.set("since", new Date(now.getTime() - options.lookbackHours * 60 * 60 * 1_000).toISOString());
    endpoint.searchParams.set("per_page", String(Math.min(options.maxItems, 100)));
    return parseGitHubNotificationItems(await fetchJson(endpoint.toString(), options), options);
  }

  const endpoint = new URL(`/users/${encodeURIComponent(options.username ?? "")}/events/public`, options.apiBaseUrl);
  endpoint.searchParams.set("per_page", "100");
  return parseGitHubEventItems(await fetchJson(endpoint.toString(), options), options);
};

export type GitHubCollector = {
  collect(): Promise<AgentItem[]>;
};
