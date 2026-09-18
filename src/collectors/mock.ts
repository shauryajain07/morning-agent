import { getMockCalendarItems } from "./calendar.js";
import { getMockDownloadItems } from "./downloads.js";
import { getMockEmailItems } from "./email.js";
import { getMockGitHubItems } from "./github.js";
import { MockMoodleProvider } from "./moodle.js";
import type { AgentItem } from "../types/index.js";

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
    ...moodleItems,
  ];
};
