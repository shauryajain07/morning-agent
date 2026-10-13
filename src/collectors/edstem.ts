import type { AgentItem } from "../types/index.js";
import {
  collectEdStemLessonItemsFromBrowser,
  type EdStemBrowserOptions,
} from "./edstemBrowser.js";
import type { BrowserNavigationProgress } from "./browserReliability.js";

export type EdStemCollectorOptions = Omit<EdStemBrowserOptions, "baseUrl"> & {
  enabled: boolean;
  baseUrl: string;
};

const defaultBaseUrl = "https://edstem.org/us/";

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

const splitList = (value: string | undefined): string[] => (value ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

export const edStemOptionsFromEnvironment = (): EdStemCollectorOptions => {
  const explicitEnabled = booleanEnvironmentValue("EDSTEM_ENABLED");
  const options: EdStemCollectorOptions = {
    // Browser collection is opt-in because a real pulse can open a login window.
    enabled: explicitEnabled ?? false,
    baseUrl: nonEmptyEnvironmentValue("EDSTEM_BASE_URL") ?? defaultBaseUrl,
    courses: splitList(nonEmptyEnvironmentValue("EDSTEM_COURSES")),
    courseUrls: splitList(nonEmptyEnvironmentValue("EDSTEM_COURSE_URLS")),
    lookbackHours: boundedIntegerEnvironmentValue("EDSTEM_LOOKBACK_HOURS", 1, 168, 24),
    maxCoursePages: boundedIntegerEnvironmentValue("EDSTEM_MAX_COURSE_PAGES", 1, 500, 100),
    maxLessonPages: boundedIntegerEnvironmentValue("EDSTEM_MAX_LESSON_PAGES", 1, 2_000, 500),
    navigationDelayMs: boundedIntegerEnvironmentValue("EDSTEM_NAVIGATION_DELAY_MS", 0, 5_000, 350),
    settleDelayMs: boundedIntegerEnvironmentValue("EDSTEM_SETTLE_DELAY_MS", 0, 5_000, 300),
  };

  const profileDirectory = nonEmptyEnvironmentValue("EDSTEM_BROWSER_PROFILE");
  if (profileDirectory !== undefined) options.profileDirectory = profileDirectory;
  const cdpUrl = nonEmptyEnvironmentValue("EDSTEM_CDP_URL");
  if (cdpUrl !== undefined) options.cdpUrl = cdpUrl;
  const headless = booleanEnvironmentValue("EDSTEM_HEADLESS");
  if (headless !== undefined) options.headless = headless;

  options.timeoutMs = boundedIntegerEnvironmentValue("EDSTEM_TIMEOUT_MS", 1_000, 120_000, 15_000);
  options.loginTimeoutMs = boundedIntegerEnvironmentValue("EDSTEM_LOGIN_TIMEOUT_MS", 10_000, 1_800_000, 300_000);
  return options;
};

export const collectEdStemItems = async (
  onProgress?: (progress: BrowserNavigationProgress) => void,
  resumeCursor?: string,
  forceEnabled = false,
): Promise<AgentItem[]> => {
  const options = edStemOptionsFromEnvironment();
  if (!options.enabled && !forceEnabled) return [];
  if (forceEnabled) options.enabled = true;
  if (onProgress !== undefined) options.onProgress = onProgress;
  if (resumeCursor !== undefined) options.resumeCursor = resumeCursor;
  return collectEdStemLessonItemsFromBrowser(options, new Date());
};
