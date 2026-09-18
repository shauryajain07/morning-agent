import { describe, expect, it } from "vitest";

import { MockDecisionEngine } from "../src/decisions/mock.js";
import { getMockCalendarItems } from "../src/collectors/calendar.js";

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
});
