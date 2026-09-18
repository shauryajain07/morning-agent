import { describe, expect, it } from "vitest";

import {
  evaluateActionPolicy,
  getConfidenceBand,
  isForbiddenActionKind,
} from "../src/policy/index.js";

describe("confidence policy", () => {
  it("uses the three requested confidence bands", () => {
    expect(getConfidenceBand(0.74)).toBe("manual_review");
    expect(getConfidenceBand(0.75)).toBe("suggested");
    expect(getConfidenceBand(0.949)).toBe("suggested");
    expect(getConfidenceBand(0.95)).toBe("automatic");
  });

  it("allows only high-confidence local file actions to auto-run", () => {
    expect(evaluateActionPolicy("moveFile", 0.99).canAutoRun).toBe(true);
    expect(evaluateActionPolicy("createCalendarEvent", 0.99).requiresApproval).toBe(true);
    expect(evaluateActionPolicy("createTask", 0.50).requiresManualReview).toBe(true);
  });

  it("denies forbidden action kinds", () => {
    expect(isForbiddenActionKind("sendEmail")).toBe(true);
    expect(evaluateActionPolicy("sendEmail", 1).disposition).toBe("denied");
  });
});
