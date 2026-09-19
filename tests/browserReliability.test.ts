import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MoodleBrowserSession } from "../src/collectors/moodleBrowser.js";

describe("browser session reliability", () => {
  it("does not reopen a Moodle session after its context closes", async () => {
    const profileDirectory = await mkdtemp(join(tmpdir(), "morning-agent-browser-"));
    const session = new MoodleBrowserSession({
      baseUrl: "https://moodle.example/",
      profileDirectory,
      headless: true,
      timeoutMs: 3_000,
    });

    try {
      const page = await session.open();
      await page.context().close();
      expect(session.isBroken()).toBe(true);
      await expect(session.goto("https://moodle.example/")).rejects.toThrow(/browser|context/iu);
    } finally {
      await session.close();
      await rm(profileDirectory, { recursive: true, force: true });
    }
  });
});
