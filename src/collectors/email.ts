import type { AgentItem } from "../types/index.js";
import { parseAgentItems } from "../types/schema.js";
import { collectGmailEmailItems } from "./gmail.js";

export type EmailCollector = {
  collect(): Promise<AgentItem[]>;
};

const localDate = (date: string, time: string): Date => new Date(`${date}T${time}+08:00`);

export const getMockEmailItems = (): AgentItem[] =>
  parseAgentItems([
    {
      id: "email-hku-subclass-registration",
      source: "email",
      title: "Subclass registration update",
      content:
        "HKU Engineering: subclass registration opens Monday. Review your selections before the deadline.",
      url: "https://mail.google.com/mock/hku-subclass-registration",
      createdAt: localDate("2026-09-18", "07:20:00"),
      metadata: {
        sender: "HKU Engineering",
        senderEmail: "engineering@example.hku.hk",
        unread: true,
        threadId: "mock-thread-1",
      },
    },
    {
      id: "email-github-review-request",
      source: "email",
      title: "Review requested on RootAtom PR #42",
      content: "You were requested to review PR #42 in RootAtom.",
      url: "https://github.com/RootAtom/example/pull/42",
      createdAt: localDate("2026-09-18", "08:05:00"),
      metadata: {
        sender: "GitHub",
        senderEmail: "notifications@github.com",
        unread: true,
        threadId: "mock-thread-2",
      },
    },
    {
      id: "email-marketing-newsletter",
      source: "email",
      title: "September student offers",
      content: "A promotional newsletter with student discounts.",
      createdAt: localDate("2026-09-18", "06:30:00"),
      metadata: {
        sender: "Example Offers",
        senderEmail: "offers@example.com",
        unread: true,
        threadId: "mock-thread-3",
      },
    },
  ]);

export const collectEmailItems = async (): Promise<AgentItem[]> => collectGmailEmailItems();
