import type { AgentItem } from "../types/index.js";
import {
  collectOutlookEmailItemsFromBrowser,
  type OutlookBrowserOptions,
} from "./outlookBrowser.js";
import type { BrowserNavigationProgress } from "./browserReliability.js";

export type OutlookProviderOptions = Omit<OutlookBrowserOptions, "baseUrl"> & {
  baseUrl?: string;
  enabled?: boolean;
};

const defaultBaseUrl = "https://outlook.office.com/mail/";

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
): number | undefined => {
  const value = nonEmptyEnvironmentValue(key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
};

export const outlookOptionsFromEnvironment = (): OutlookProviderOptions => {
  const configuredBaseUrl = nonEmptyEnvironmentValue("OUTLOOK_BASE_URL");
  const explicitEnabled = booleanEnvironmentValue("OUTLOOK_ENABLED");
  const enabled = explicitEnabled ?? configuredBaseUrl !== undefined;

  const options: OutlookProviderOptions = {
    enabled,
    baseUrl: configuredBaseUrl ?? defaultBaseUrl,
  };

  const profileDirectory = nonEmptyEnvironmentValue("OUTLOOK_BROWSER_PROFILE");
  if (profileDirectory !== undefined) options.profileDirectory = profileDirectory;
  const cdpUrl = nonEmptyEnvironmentValue("OUTLOOK_CDP_URL");
  if (cdpUrl !== undefined) options.cdpUrl = cdpUrl;
  const headless = booleanEnvironmentValue("OUTLOOK_HEADLESS");
  if (headless !== undefined) options.headless = headless;

  const timeoutMs = boundedIntegerEnvironmentValue("OUTLOOK_TIMEOUT_MS", 1_000, 120_000);
  if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
  const loginTimeoutMs = boundedIntegerEnvironmentValue("OUTLOOK_LOGIN_TIMEOUT_MS", 10_000, 1_800_000);
  if (loginTimeoutMs !== undefined) options.loginTimeoutMs = loginTimeoutMs;
  const lookbackHours = boundedIntegerEnvironmentValue("OUTLOOK_LOOKBACK_HOURS", 1, 168);
  if (lookbackHours !== undefined) options.lookbackHours = lookbackHours;
  const maxScrolls = boundedIntegerEnvironmentValue("OUTLOOK_MAX_SCROLLS", 0, 50);
  if (maxScrolls !== undefined) options.maxScrolls = maxScrolls;
  const navigationDelayMs = boundedIntegerEnvironmentValue("OUTLOOK_NAVIGATION_DELAY_MS", 0, 5_000);
  if (navigationDelayMs !== undefined) options.navigationDelayMs = navigationDelayMs;
  const settleDelayMs = boundedIntegerEnvironmentValue("OUTLOOK_SETTLE_DELAY_MS", 0, 5_000);
  if (settleDelayMs !== undefined) options.settleDelayMs = settleDelayMs;

  return options;
};

export const collectOutlookEmailItems = async (
  onProgress?: (progress: BrowserNavigationProgress) => void,
): Promise<AgentItem[]> => {
  const options = outlookOptionsFromEnvironment();
  if (!options.enabled || options.baseUrl === undefined) return [];
  if (onProgress !== undefined) options.onProgress = onProgress;
  return collectOutlookEmailItemsFromBrowser({
    ...options,
    baseUrl: options.baseUrl,
  });
};
