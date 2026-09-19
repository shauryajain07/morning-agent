import { describe, expect, it } from "vitest";

import { MockDecisionEngine } from "../src/decisions/mock.js";
import { getMockCalendarItems } from "../src/collectors/calendar.js";
import { getMockDownloadItems } from "../src/collectors/downloads.js";
import type { AgentItem } from "../src/types/index.js";

describe("decision outputs", () => {
  it("detects a normalized deadline without inventing a date", async () => {
    const item = getMockCalendarItems()[0];
    if (item === undefined) throw new Error("fixture missing");

    const decisions = await new MockDecisionEngine().evaluateItem(item);
    const deadline = decisions.find((decision) => decision.decision === "detectDeadline");

    expect(deadline?.output).toMatchObject({
      hasDeadline: true,
      deadline: item.deadline?.toISOString(),
    });
  });

  it("does not classify an already-downloaded file as an email or calendar item", async () => {
    const item = getMockDownloadItems()[0];
    if (item === undefined) throw new Error("fixture missing");

    const decisions = await new MockDecisionEngine().evaluateItem(item);

    expect(decisions).toEqual([]);
  });

  it("gives articles a typed Jev-style worth-reading decision", async () => {
    const item: AgentItem = {
      id: "edstem:test-thread",
      source: "edstem",
      title: "A useful course discussion",
      content: "A short thread excerpt.",
      url: "https://us.edstem.org/us/courses/146267/discussion/42",
      metadata: { kind: "thread", platform: "edstem" },
    };

    const decisions = await new MockDecisionEngine().evaluateItem(item);

    expect(decisions).toEqual([
      expect.objectContaining({
        decision: "worthReading",
        output: expect.objectContaining({ worthReading: true, category: "education" }),
      }),
    ]);
  });
});
