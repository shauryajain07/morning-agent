import type { AgentItem } from "../types/index.js";
import { parseAgentItems } from "../types/schema.js";

export type CalendarCollector = {
  collect(): Promise<AgentItem[]>;
};

const localDate = (date: string, time: string): Date => new Date(`${date}T${time}+08:00`);

export const getMockCalendarItems = (): AgentItem[] =>
  parseAgentItems([
    {
      id: "calendar-math1851-assignment-2",
      source: "calendar",
      title: "MATH1851 Assignment 2 deadline",
      content: "Submit Assignment 2 before the deadline.",
      createdAt: localDate("2026-09-17", "09:00:00"),
      deadline: localDate("2026-09-19", "23:59:00"),
      metadata: {
        calendarId: "mock-calendar",
        eventType: "deadline",
        course: "MATH1851",
      },
    },
    {
      id: "calendar-engg1000-lab",
      source: "calendar",
      title: "ENGG1000 lab",
      content: "Weekly engineering lab.",
      createdAt: localDate("2026-09-01", "08:00:00"),
      deadline: localDate("2026-09-24", "14:00:00"),
      metadata: {
        calendarId: "mock-calendar",
        eventType: "class",
        course: "ENGG1000",
      },
    },
  ]);

export const collectCalendarItems = async (): Promise<AgentItem[]> => [];
