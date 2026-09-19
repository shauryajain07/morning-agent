import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

import type { AgentItem } from "../types/index.js";
import { parseAgentItems } from "../types/schema.js";

export type DownloadCollectorOptions = {
  directory?: string;
  now?: Date;
  lookbackMs?: number;
};

const defaultLookbackMs = 24 * 60 * 60 * 1000;

const sensitiveDownloadPattern = /(secret|credential|token|password)/iu;
const temporaryDownloadPattern = /\.(?:crdownload|download|part|tmp)$/iu;

export const shouldIgnoreDownload = (filename: string): boolean =>
  filename.startsWith(".") || temporaryDownloadPattern.test(filename);

export const isSensitiveDownloadName = (filename: string): boolean =>
  sensitiveDownloadPattern.test(filename);

export const collectDownloads = async (options: DownloadCollectorOptions = {}): Promise<AgentItem[]> => {
  const directory = options.directory ?? join(homedir(), "Downloads");
  const now = options.now ?? new Date();
  const lookbackMs = options.lookbackMs ?? defaultLookbackMs;
  const entries = await readdir(directory, { withFileTypes: true });
  const items: AgentItem[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || shouldIgnoreDownload(entry.name)) continue;
    const path = join(directory, entry.name);
    const details = await stat(path);
    const createdAt = details.birthtime > details.mtime ? details.birthtime : details.mtime;
    if (now.getTime() - createdAt.getTime() > lookbackMs) continue;
    items.push({
      id: `downloads:${path}`,
      source: "downloads",
      title: entry.name,
      createdAt,
      metadata: {
        filename: entry.name,
        extension: extname(entry.name).toLowerCase(),
        size: details.size,
        creationTime: details.birthtime.toISOString(),
        modifiedTime: details.mtime.toISOString(),
        path,
      },
    });
  }

  return parseAgentItems(items);
};

export const getMockDownloadItems = (): AgentItem[] =>
  parseAgentItems([
    {
      id: "downloads:mock:ENGG1330_Lecture_06.pdf",
      source: "downloads",
      title: "ENGG1330_Lecture_06.pdf",
      createdAt: new Date("2026-09-18T01:10:00.000Z"),
      metadata: {
        filename: "ENGG1330_Lecture_06.pdf",
        extension: ".pdf",
        size: 284_000,
        creationTime: "2026-09-18T01:10:00.000Z",
        path: join(homedir(), "Downloads", "ENGG1330_Lecture_06.pdf"),
      },
    },
  ]);
