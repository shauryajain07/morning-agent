import type { AgentItem, MoodleProvider } from "../types/index.js";
import { parseAgentItems } from "../types/schema.js";
import {
  collectMoodleItemsFromBrowser,
  type MoodleBrowserOptions,
} from "./moodleBrowser.js";

export type HKUMoodleProviderOptions = Omit<MoodleBrowserOptions, "baseUrl"> & {
  baseUrl?: string;
  enabled?: boolean;
};

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

export const moodleOptionsFromEnvironment = (): HKUMoodleProviderOptions => {
  const baseUrl = nonEmptyEnvironmentValue("MOODLE_BASE_URL");
  const explicitEnabled = booleanEnvironmentValue("MOODLE_ENABLED");
  if (explicitEnabled === true && baseUrl === undefined) {
    throw new Error("MOODLE_ENABLED=true requires MOODLE_BASE_URL.");
  }
  const headless = booleanEnvironmentValue("MOODLE_HEADLESS");
  const options: HKUMoodleProviderOptions = {
    enabled: explicitEnabled ?? baseUrl !== undefined,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };

  const profileDirectory = nonEmptyEnvironmentValue("MOODLE_BROWSER_PROFILE");
  if (profileDirectory !== undefined) options.profileDirectory = profileDirectory;
  const cdpUrl = nonEmptyEnvironmentValue("MOODLE_CDP_URL");
  if (cdpUrl !== undefined) options.cdpUrl = cdpUrl;
  if (headless !== undefined) options.headless = headless;

  const timeoutValue = nonEmptyEnvironmentValue("MOODLE_TIMEOUT_MS");
  if (timeoutValue !== undefined) {
    const timeoutMs = Number(timeoutValue);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
      throw new Error("MOODLE_TIMEOUT_MS must be an integer of at least 1000.");
    }
    options.timeoutMs = timeoutMs;
  }

  const loginTimeoutValue = nonEmptyEnvironmentValue("MOODLE_LOGIN_TIMEOUT_MS");
  if (loginTimeoutValue !== undefined) {
    const loginTimeoutMs = Number(loginTimeoutValue);
    if (!Number.isInteger(loginTimeoutMs) || loginTimeoutMs < 10_000) {
      throw new Error("MOODLE_LOGIN_TIMEOUT_MS must be an integer of at least 10000.");
    }
    options.loginTimeoutMs = loginTimeoutMs;
  }

  const navigationDelayMs = boundedIntegerEnvironmentValue("MOODLE_NAVIGATION_DELAY_MS", 0, 5_000);
  if (navigationDelayMs !== undefined) options.navigationDelayMs = navigationDelayMs;
  const settleDelayMs = boundedIntegerEnvironmentValue("MOODLE_SETTLE_DELAY_MS", 0, 5_000);
  if (settleDelayMs !== undefined) options.settleDelayMs = settleDelayMs;

  const maxCoursePagesValue = nonEmptyEnvironmentValue("MOODLE_MAX_COURSE_PAGES");
  if (maxCoursePagesValue !== undefined) {
    const maxCoursePages = Number(maxCoursePagesValue);
    if (!Number.isInteger(maxCoursePages) || maxCoursePages < 1 || maxCoursePages > 500) {
      throw new Error("MOODLE_MAX_COURSE_PAGES must be an integer from 1 to 500.");
    }
    options.maxCoursePages = maxCoursePages;
  }

  const maxDetailPagesValue = nonEmptyEnvironmentValue("MOODLE_MAX_DETAIL_PAGES");
  if (maxDetailPagesValue !== undefined) {
    const maxDetailPages = Number(maxDetailPagesValue);
    if (!Number.isInteger(maxDetailPages) || maxDetailPages < 1 || maxDetailPages > 1_000) {
      throw new Error("MOODLE_MAX_DETAIL_PAGES must be an integer from 1 to 1000.");
    }
    options.maxDetailPages = maxDetailPages;
  }

  return options;
};

export class HKUMoodleProvider implements MoodleProvider {
  private collectionPromise: Promise<{
    announcements: AgentItem[];
    assignments: AgentItem[];
    courseFiles: AgentItem[];
  }> | undefined;

  public constructor(private readonly options: HKUMoodleProviderOptions = moodleOptionsFromEnvironment()) {}

  private async collect(): Promise<{
    announcements: AgentItem[];
    assignments: AgentItem[];
    courseFiles: AgentItem[];
  }> {
    if (!this.options.enabled || this.options.baseUrl === undefined) {
      return { announcements: [], assignments: [], courseFiles: [] };
    }

    return collectMoodleItemsFromBrowser({
      ...this.options,
      baseUrl: this.options.baseUrl,
    });
  }

  private getCollection(): Promise<{
    announcements: AgentItem[];
    assignments: AgentItem[];
    courseFiles: AgentItem[];
  }> {
    this.collectionPromise ??= this.collect();
    return this.collectionPromise;
  }

  public async getAnnouncements(): Promise<AgentItem[]> {
    return (await this.getCollection()).announcements;
  }

  public async getAssignments(): Promise<AgentItem[]> {
    return (await this.getCollection()).assignments;
  }

  public async getCourseFiles(): Promise<AgentItem[]> {
    return (await this.getCollection()).courseFiles;
  }
}

export class MockMoodleProvider implements MoodleProvider {
  async getAnnouncements(): Promise<AgentItem[]> {
    return [];
  }

  async getAssignments(): Promise<AgentItem[]> {
    return parseAgentItems([
      {
        id: "moodle-math1851-assignment-2",
        source: "moodle",
        title: "MATH1851 Assignment 2",
        content: "Assignment 2 is available on Moodle and is due tomorrow at 23:59.",
        url: "https://moodle.hku.hk/mock/math1851-assignment-2",
        createdAt: new Date("2026-09-18T00:00:00.000Z"),
        deadline: new Date("2026-09-19T15:59:00.000Z"),
        metadata: {
          course: "MATH1851",
          kind: "assignment",
        },
      },
    ]);
  }

  async getCourseFiles(): Promise<AgentItem[]> {
    return parseAgentItems([
      {
        id: "moodle-engg1330-lecture-6",
        source: "moodle",
        title: "ENGG1330 Lecture 6 uploaded",
        content: "A new lecture PDF is available for download.",
        url: "https://moodle.hku.hk/mock/engg1330-lecture-6",
        createdAt: new Date("2026-09-18T00:45:00.000Z"),
        metadata: {
          course: "ENGG1330",
          kind: "course_file",
          filename: "ENGG1330_Lecture_06.pdf",
          extension: ".pdf",
        },
      },
    ]);
  }
}
