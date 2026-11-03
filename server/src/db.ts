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
  /** "pipeline" (grill → tickets → implement) or "direct" (plain agent turns). */
  mode: string;
  /** setup | grill | spec | tickets | ready | implement | review | retro | pr | done | direct */
  phase: string;
  /** Short summary of the decisions agreed while grilling. */
  grill_summary: string | null;
  /** The spec /to-spec wrote, and where it was published; ticket runs get it. */
  spec: string | null;
  spec_ref: string | null;
  /** pi session id of the final code-review run. */
  review_run: string | null;
  /** pi session id of the last merge run, which resolves a conflict that Approve found. */
  merge_run: string | null;
  /** 1 from a rework until record_tickets records the new breakdown; the old ticket rows stay for the board until then. */
  rework_tickets: number;
  /** finish_review's note from the last review run, for the card detail. */
  review_note: string | null;
  /** When the card last reached Done; the board lists Done newest first by it. */
  done_at: number | null;
  /** pi session id of the end-of-spec retro run, when one ran. */
  retro_run: string | null;
  /** pi session id of the conversation on screen: the session id itself, or a ticket's run. */
  active_run: string | null;
  /** Why the pipeline stopped and waits for the user; null while it may proceed. */
  attention: string | null;
  /** The GitHub issue this session solves, e.g. `owner/name#123`; null for plain sessions. */
  issue_ref: string | null;
  /** Auto-approve for this session: null inherits the global switch, or "on" / "off". */
  auto_approve: string | null;
  /** 1 when the session loads the TypeSafe skill (picked on the New session form). */
  typesafe_skill: number;
};

export type TicketRow = {
  session_id: string;
  num: number;
  title: string;
  body: string;
  /** JSON array of ticket numbers. */
  blocked_by: string;
  tracker_ref: string | null;
  /** ready | running | done | blocked */
  status: string;
  note: string | null;
  run_id: string | null;
  started_at: number | null;
  finished_at: number | null;
  /** The commit the ticket's first run started from. */
  start_commit: string | null;
  /** Why the stop rule stopped this ticket's run, when it did. */
  stop_reason: string | null;
  /** pi session id of the rescue run, when one started. */
  rescue_run_id: string | null;
  /** JSON of the finish_diagnosis arguments the rescue run reported, when it did. */
  diagnosis: string | null;
  /** pi session id of the fix run, when one started. */
  fix_run_id: string | null;
  /** null | diagnosing | fixing | rescued | failed */
  rescue_state: string | null;
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
CREATE TABLE IF NOT EXISTS tickets (
  session_id TEXT NOT NULL, num INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  blocked_by TEXT NOT NULL DEFAULT '[]', tracker_ref TEXT, status TEXT NOT NULL DEFAULT 'ready',
  note TEXT, run_id TEXT, started_at INTEGER, finished_at INTEGER, PRIMARY KEY (session_id, num)
);
-- Auto-approve's audit trail: pi's messages hold no automatic answers, so each is kept here and
-- merged into its run's transcript by time. \`event\` is the wb_auto_answer record as JSON.
CREATE TABLE IF NOT EXISTS auto_decisions (
  session_id TEXT NOT NULL, run_id TEXT NOT NULL, request_id TEXT NOT NULL, event TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (session_id, request_id)
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
  migrate(db);
  return db;
}

export type Db = DatabaseSync;

/** Columns added after the first release; ALTER them onto older databases. */
const ADDED_COLUMNS: [string, string, string][] = [
  ["sessions", "mode", "TEXT NOT NULL DEFAULT 'direct'"],
  ["sessions", "phase", "TEXT NOT NULL DEFAULT 'direct'"],
  ["sessions", "grill_summary", "TEXT"],
  ["sessions", "active_run", "TEXT"],
  ["sessions", "attention", "TEXT"],
  ["sessions", "spec", "TEXT"],
  ["sessions", "spec_ref", "TEXT"],
  ["sessions", "review_run", "TEXT"],
  ["sessions", "retro_run", "TEXT"],
  ["sessions", "issue_ref", "TEXT"],
  ["sessions", "auto_approve", "TEXT"],
  ["sessions", "typesafe_skill", "INTEGER NOT NULL DEFAULT 0"],
  ["sessions", "review_note", "TEXT"],
  ["sessions", "done_at", "INTEGER"],
  ["sessions", "merge_run", "TEXT"],
  ["sessions", "rework_tickets", "INTEGER NOT NULL DEFAULT 0"],
  ["tickets", "start_commit", "TEXT"],
  ["tickets", "stop_reason", "TEXT"],
  ["tickets", "rescue_run_id", "TEXT"],
  ["tickets", "diagnosis", "TEXT"],
  ["tickets", "fix_run_id", "TEXT"],
  ["tickets", "rescue_state", "TEXT"],
];

function migrate(db: DatabaseSync) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  // `done` used to mean "reviewed"; it now means "merged", and a reviewed card with a PR is `pr`.
  // Once only: a card merged after this must stay `done`.
  if (!getSetting(db, "migrated.donePr")) {
    db.exec("UPDATE sessions SET phase = 'pr' WHERE phase = 'done' AND pr_number IS NOT NULL");
    putSetting(db, "migrated.donePr", true);
  }
}

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
