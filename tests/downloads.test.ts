import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectDownloads,
  isSensitiveDownloadName,
  shouldIgnoreDownload,
} from "../src/collectors/downloads.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("download collector", () => {
  it("ignores hidden and incomplete browser files", () => {
    expect(shouldIgnoreDownload(".DS_Store")).toBe(true);
    expect(shouldIgnoreDownload("browser.crdownload")).toBe(true);
    expect(shouldIgnoreDownload("lecture.pdf")).toBe(false);
  });

  it("identifies sensitive download names", () => {
    expect(isSensitiveDownloadName("client_secret.json")).toBe(true);
    expect(isSensitiveDownloadName("lecture-notes.pdf")).toBe(false);
  });

  it("collects useful files while skipping system noise", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morning-agent-downloads-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(join(directory, ".DS_Store"), "noise"),
      writeFile(join(directory, "partial.crdownload"), "incomplete"),
      writeFile(join(directory, "lecture-notes.pdf"), "useful"),
    ]);

    const items = await collectDownloads({ directory, now: new Date(), lookbackMs: 60_000 });
    expect(items.map((item) => item.title)).toEqual(["lecture-notes.pdf"]);
  });
});
