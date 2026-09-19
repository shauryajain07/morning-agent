import type Database from "better-sqlite3";

/**
 * The Phase 1 schema is deliberately small and uses stable application-level
 * identifiers so that the store can be initialized more than once safely.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS seen_item_fingerprints (
  fingerprint TEXT PRIMARY KEY NOT NULL,
  seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deadlines (
  fingerprint TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS deadlines_item_id_idx
  ON deadlines (item_id);

CREATE TABLE IF NOT EXISTS decision_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  output_json TEXT NOT NULL,
  model TEXT NOT NULL,
  decided_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS decision_outputs_item_decision_idx
  ON decision_outputs (item_id, decision, id DESC);

CREATE TABLE IF NOT EXISTS action_records (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS action_records_item_id_idx
  ON action_records (item_id);

CREATE TABLE IF NOT EXISTS item_records (
  id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  url TEXT,
  created_at TEXT,
  deadline_at TEXT,
  metadata_json TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS item_records_source_observed_idx
  ON item_records (source, observed_at DESC);

CREATE TABLE IF NOT EXISTS review_records (
  item_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_id, decision)
);

CREATE INDEX IF NOT EXISTS review_records_updated_idx
  ON review_records (updated_at DESC);

CREATE TABLE IF NOT EXISTS run_records (
  run_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  stage TEXT,
  started_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  completed_at TEXT,
  item_count INTEGER,
  decision_count INTEGER,
  action_count INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS run_records_started_idx
  ON run_records (started_at DESC, run_id DESC);
`;

export function initializeSchema(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
}
