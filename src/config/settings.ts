import { join } from "node:path";

export type AppSettings = {
  databasePath: string;
  timezone: string;
  typesafeModel: string;
};

export const defaultSettings: AppSettings = {
  databasePath: join(process.cwd(), ".data", "morning-agent.sqlite"),
  timezone: process.env.TZ ?? "Asia/Hong_Kong",
  typesafeModel: "jev-latest",
};
