import { describe, expect, it } from "vitest";

import { parseAgentItem } from "../src/types/schema.js";

describe("AgentItem normalization", () => {
  it("coerces external date fields into a normalized typed item", () => {
    const item = parseAgentItem({
      id: "email-1",
      source: "email",
      title: "Registration update",
      content: "Review the notice.",
      createdAt: "2026-09-18T00:00:00.000Z",
      metadata: { unread: true },
    });

    expect(item.createdAt).toBeInstanceOf(Date);
    expect(item.source).toBe("email");
    expect(item.metadata).toEqual({ unread: true });
  });

  it("rejects unsupported sources", () => {
    expect(() =>
      parseAgentItem({ id: "x", source: "unknown", title: "Bad", metadata: {} }),
    ).toThrow();
  });
});
