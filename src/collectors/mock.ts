import { getMockCalendarItems } from "./calendar.js";
import { getMockDownloadItems } from "./downloads.js";
import { getMockEmailItems } from "./email.js";
import { getMockGitHubItems } from "./github.js";
import { MockMoodleProvider } from "./moodle.js";
import type { AgentItem } from "../types/index.js";
import { parseAgentItems } from "../types/schema.js";

export const collectMockItems = async (): Promise<AgentItem[]> => {
  const moodle = new MockMoodleProvider();
  const moodleItems = [
    ...(await moodle.getAnnouncements()),
    ...(await moodle.getAssignments()),
    ...(await moodle.getCourseFiles()),
  ];
  return [
    ...getMockCalendarItems(),
    ...getMockDownloadItems(),
    ...getMockEmailItems(),
    ...getMockGitHubItems(),
    ...parseAgentItems([
      {
        id: "ed:mock-jev-article",
        source: "ed",
        title: "A practical guide to a new developer tool",
        content: "A mock ed.com article for testing the reading-value decision.",
        url: "https://ed.com/mock/developer-tool",
        createdAt: new Date("2026-09-19T06:30:00.000Z"),
        metadata: { kind: "article", site: "ed.com" },
      },
      {
        id: "news:mock-daily-brief",
        source: "news",
        title: "Morning technology and science brief",
        content: "A mock RSS article for testing the daily news radar.",
        url: "https://example.com/mock/daily-brief",
        createdAt: new Date("2026-09-19T06:45:00.000Z"),
        metadata: { kind: "news_article", feedHost: "example.com" },
      },
    ]),
    ...moodleItems,
  ];
};
