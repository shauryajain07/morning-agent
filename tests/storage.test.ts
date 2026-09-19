import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("round-trips article reading decisions", () => {
    const store = createStore(":memory:");
    const decidedAt = new Date("2026-09-19T08:00:00.000Z");
    store.recordDecision({
      itemId: "news:story-1",
      decision: "worthReading",
      output: { worthReading: true, category: "technology", confidence: 0.91 },
      model: "jev-latest",
      decidedAt,
    });

    expect(store.getDecisions()[0]?.output).toEqual({
      worthReading: true,
      category: "technology",
      confidence: 0.91,
    });
    store.close();
  });

  it("keeps the latest run state across store reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morning-agent-run-"));
    const dbPath = join(directory, "state.sqlite");
    let store = createStore(dbPath);
    const startedAt = new Date("2026-09-19T08:00:00.000Z");
    const completedAt = new Date("2026-09-19T08:01:00.000Z");

    store.recordRun({
      runId: "run-1",
      status: "running",
      stage: "collect",
      startedAt,
      lastEventAt: startedAt,
    });
    store.recordRun({
      runId: "run-1",
      status: "completed",
      stage: "briefing",
      startedAt,
      lastEventAt: completedAt,
      completedAt,
      itemCount: 12,
      decisionCount: 8,
      actionCount: 1,
    });

    store.close();
    store = createStore(dbPath);
    expect(store.getLatestRun()).toMatchObject({
      runId: "run-1",
      status: "completed",
      stage: "briefing",
      itemCount: 12,
      decisionCount: 8,
      actionCount: 1,
      completedAt,
    });
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});
