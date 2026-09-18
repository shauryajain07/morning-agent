import { join } from "node:path";

export type AppSettings = {
  databasePath: string;
  timezone: string;
  typesafeModel: string;
};

export const defaultSettings: AppSettings = {
  databasePath:
    process.env.MORNING_AGENT_DB_PATH ?? join(process.cwd(), ".data", "morning-agent.sqlite"),
  timezone: process.env.TZ ?? "Asia/Hong_Kong",
  typesafeModel: "jev-latest",
};
