import type { AgentItem, MoodleProvider } from "../types/index.js";
import { parseAgentItems } from "../types/schema.js";

export class HKUMoodleProvider implements MoodleProvider {
  async getAnnouncements(): Promise<AgentItem[]> {
    return [];
  }

  async getAssignments(): Promise<AgentItem[]> {
    return [];
  }

  async getCourseFiles(): Promise<AgentItem[]> {
    return [];
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
