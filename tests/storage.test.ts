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
});
