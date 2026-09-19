import { describe, expect, it } from "vitest";

import { createStore } from "../src/storage/db.js";

describe("SQLite state", () => {
  it("detects a deadline only the first time it is observed", () => {
    const store = createStore(":memory:");
    const deadline = {
      id: "moodle-assignment-1",
      source: "moodle" as const,
      title: "MATH1851 Assignment 2",
      deadline: new Date("2026-09-19T15:59:00.000Z"),
    };

    expect(store.isNewDeadline(deadline)).toBe(true);
    expect(store.recordDeadline(deadline)).toBe(true);
    expect(store.isNewDeadline(deadline)).toBe(false);
    expect(store.recordDeadline(deadline)).toBe(false);
    expect(store.recordDeadline({ ...deadline, deadline: new Date("2026-09-20T15:59:00.000Z") })).toBe(true);
    store.close();
  });

  it("persists dashboard items and review decisions", () => {
    const store = createStore(":memory:");
    const observedAt = new Date("2026-09-19T08:00:00.000Z");
    store.recordItem({
      id: "email:review-1",
      source: "email",
      title: "Please review the draft",
      content: "A short message.",
      createdAt: observedAt,
      metadata: { sender: "Example", unread: true },
    }, observedAt);
    expect(store.getItems()).toHaveLength(1);
    expect(store.getItem("email:review-1")?.metadata).toMatchObject({ unread: true });

    store.recordReview({
      itemId: "email:review-1",
      decision: "importantEmail",
      status: "approved",
      updatedAt: observedAt,
    });
    expect(store.getReview("email:review-1", "importantEmail")?.status).toBe("approved");
    store.close();
  });
});
