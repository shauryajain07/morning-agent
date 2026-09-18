import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createCalendarEvent, downloadFile } from "../src/actions/index.js";

const tempDirectory = async (): Promise<string> => mkdtemp(join(tmpdir(), "morning-agent-test-"));

describe("safe actions", () => {
  it("routes a file with a high-confidence local action", async () => {
    const directory = await tempDirectory();
    const sourcePath = join(directory, "lecture.pdf");
    const destinationPath = join(directory, "course", "lecture.pdf");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(sourcePath, "lecture fixture", "utf8");

    const result = await downloadFile(
      { itemId: "download-1", sourcePath, destinationPath },
      { confidence: 0.99 },
    );

    expect(result.outcome).toBe("executed");
    expect(await readFile(destinationPath, "utf8")).toBe("lecture fixture");
    expect((await stat(sourcePath)).isFile()).toBe(true);
  });

  it("does not mutate a destination during dry-run", async () => {
    const directory = await tempDirectory();
    const sourcePath = join(directory, "lecture.pdf");
    const destinationPath = join(directory, "course", "lecture.pdf");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(sourcePath, "lecture fixture", "utf8");

    const result = await downloadFile(
      { itemId: "download-2", sourcePath, destinationPath },
      { confidence: 0.99, dryRun: true },
    );

    expect(result.outcome).toBe("planned");
    await expect(stat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps calendar mutations approval-gated", async () => {
    const result = await createCalendarEvent(
      {
        itemId: "deadline-1",
        title: "Assignment deadline",
        startTime: "2026-09-19T14:59:00.000Z",
        endTime: "2026-09-19T15:59:00.000Z",
      },
      { confidence: 0.99 },
    );

    expect(result.outcome).toBe("requires_approval");
    expect(result.policy.requiresApproval).toBe(true);
  });
});
