import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type RepoRow = {
  id: string; // "owner/name"
  owner: string;
  name: string;
  default_branch: string;
  private: number;
  added_at: number;
};

export type SessionRow = {
  id: string;
  repo_id: string;
  title: string;
  branch: string;
  base_branch: string;
  worktree: string;
  created_at: number;
  updated_at: number;
  pr_number: number | null;
  pr_url: string | null;
  /** The user's first task, held back until setup-matt-pocock-skills has run. */
  held_prompt: string | null;
  archived: number;
};

export type SecretRow = {
  scope: string; // "global" or a repo id
  name: string;
  iv: string;
  tag: string;
  data: string;
  updated_at: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
  default_branch TEXT NOT NULL, private INTEGER NOT NULL DEFAULT 1, added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, title TEXT NOT NULL,
  branch TEXT NOT NULL, base_branch TEXT NOT NULL, worktree TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  pr_number INTEGER, pr_url TEXT, held_prompt TEXT, archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS secrets (
  scope TEXT NOT NULL, name TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL,
  data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (scope, name)
);
`;

export function openDb(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

export type Db = ReturnType<typeof openDb>;

export function getSetting<T>(db: Db, key: string): T | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function putSetting(db: Db, key: string, value: unknown) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    JSON.stringify(value),
  );
}
