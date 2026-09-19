import { describe, expect, it } from "vitest";

import { runMorning } from "../src/index.js";

describe("morning run orchestration", () => {
  it("finishes the mock pulse with an explicit state for every source", async () => {
    const events: Array<{ type: string; source?: string; status?: string }> = [];
    await runMorning({
      dryRun: true,
      mock: true,
      verbose: false,
      onEvent: (event) => events.push(event),
    });

    const sourceEvents = events.filter((event) => event.type === "source_progress");
    const latestBySource = new Map<string, string>();
    for (const event of sourceEvents) {
      if (event.source !== undefined && event.status !== undefined) latestBySource.set(event.source, event.status);
    }

    expect(latestBySource.size).toBe(8);
    expect(new Set(latestBySource.values())).toEqual(new Set(["skipped"]));
    expect(events.at(-1)?.type).toBe("run_completed");
  });
});
