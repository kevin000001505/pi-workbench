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
  /** The agent-skills setup state the workbench recorded: "set_up", "not_set_up", or null when nothing was recorded (a repo added before the record existed). */
  setup_state: string | null;
  /** The session that runs this repo's agent-skills setup (see SessionManager.startSetupSession), null when it has none. */
  setup_session: string | null;
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
  /** The phase a held prompt releases into: tickets for a split, grill for a rework or a task. */
  held_phase: string | null;
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
  /** JSON array of the files git reported as conflicted when the merge run started. */
  merge_files: string | null;
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
  /** The ticket Solve one ticket is running now; null for a card running every ticket (Solve all) or none. */
  solo_ticket: number | null;
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
-- The issues a merged card closed, per repo: the board's Done column lists them beside the merged cards.
-- parent is the spec issue the closed issue is a ticket of, session_id the card that closed it,
-- and not_planned a close the board did not deliver; rows from before these columns stay null.
CREATE TABLE IF NOT EXISTS issues_done (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
  closed_at INTEGER NOT NULL, parent INTEGER, session_id TEXT, not_planned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, number)
);
-- The spec issues the board showed as unclaimed cards; a board load's checks read their state on GitHub.
-- A spec issue a session claims, or that lands in issues_done, leaves the watch list.
CREATE TABLE IF NOT EXISTS spec_watch (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, PRIMARY KEY (repo_id, number)
);
-- The Issue queue (issue #103): the issue numbers "Solve all issues" snapshotted, in number order.
-- state: waiting (its turn has not come), running (the card the queue waits on), done (it reached
-- Review), skipped (it was claimed or moved by hand, its start was refused, or its card was Abandoned
-- or archived before its turn). The rows go with the queue.
CREATE TABLE IF NOT EXISTS issue_queue (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'waiting', session_id TEXT,
  PRIMARY KEY (repo_id, number)
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
  ["sessions", "merge_files", "TEXT"],
  ["sessions", "rework_tickets", "INTEGER NOT NULL DEFAULT 0"],
  ["sessions", "held_phase", "TEXT"],
  ["tickets", "start_commit", "TEXT"],
  ["tickets", "stop_reason", "TEXT"],
  ["tickets", "rescue_run_id", "TEXT"],
  ["tickets", "diagnosis", "TEXT"],
  ["tickets", "fix_run_id", "TEXT"],
  ["tickets", "rescue_state", "TEXT"],
  ["sessions", "solo_ticket", "INTEGER"],
  ["repos", "setup_state", "TEXT"],
  ["repos", "setup_session", "TEXT"],
  ["issues_done", "parent", "INTEGER"],
  ["issues_done", "session_id", "TEXT"],
  ["issues_done", "not_planned", "INTEGER NOT NULL DEFAULT 0"],
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
  // held_phase names the phase a held prompt releases into. Backfill the rows from before the
  // column once: a split prompt (marked in its own pipeline header) goes to tickets, a rework
  // or a task to grill, a direct session's task to direct.
  if (!getSetting(db, "migrated.heldPhase")) {
    db.exec(`UPDATE sessions SET held_phase = 'tickets' WHERE held_prompt LIKE '%pi-workbench pipeline: split%' AND held_phase IS NULL`);
    db.exec(`UPDATE sessions SET held_phase = CASE WHEN mode = 'direct' THEN 'direct' ELSE 'grill' END WHERE held_prompt IS NOT NULL AND held_phase IS NULL`);
    putSetting(db, "migrated.heldPhase", true);
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

/**
 * Record an issue a merged card closed: the board's Done lists it beside the card. One row per repo
 * issue. `parent` is the spec issue the closed issue is a ticket of, `sessionId` the card that
 * closed it, and `notPlanned` a close the board did not deliver (a hand-closed spec). Rows written
 * before these columns exist leave them null, so the board keeps them as flat cards.
 */
export function recordIssueDone(
  db: Db,
  repoId: string,
  number: number,
  title: string,
  url: string,
  closedAt: number,
  extra: { parent?: number | null; sessionId?: string | null; notPlanned?: boolean } = {},
) {
  db.prepare("INSERT OR REPLACE INTO issues_done (repo_id, number, title, url, closed_at, parent, session_id, not_planned) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    repoId,
    number,
    title,
    url,
    closedAt,
    extra.parent ?? null,
    extra.sessionId ?? null,
    extra.notPlanned ? 1 : 0,
  );
}

/** The issues a repo's merged cards closed: the board's Done cards (see doneIssueCards; Done orders them by close time). */
export function doneIssuesOf(db: Db, repoId: string): { number: number; title: string; url: string; closedAt: number; parent: number | null; sessionId: string | null; notPlanned: boolean }[] {
  const rows = db.prepare("SELECT number, title, url, closed_at, parent, session_id, not_planned FROM issues_done WHERE repo_id = ?").all(repoId) as {
    number: number;
    title: string;
    url: string;
    closed_at: number;
    parent: number | null;
    session_id: string | null;
    not_planned: number | null;
  }[];
  return rows.map((r) => ({ number: r.number, title: r.title, url: r.url, closedAt: r.closed_at, parent: r.parent, sessionId: r.session_id, notPlanned: !!r.not_planned }));
}

/** One Issue queue step (issue #103): the snapshotted issue number, its state, and the session the
 * queue started for it — the card it waits on, or the card the user dropped before its turn. */
export type IssueQueueStepState = "waiting" | "running" | "done" | "skipped";
export type IssueQueueRow = { number: number; state: IssueQueueStepState; sessionId: string | null };

/**
 * Save an Issue queue snapshot: one row per number, each waiting, in the order the click
 * snapshotted them (lowest issue number first). It replaces the rows of the queue before it.
 */
export function issueQueueSave(db: Db, repoId: string, numbers: number[]) {
  db.prepare("DELETE FROM issue_queue WHERE repo_id = ?").run(repoId);
  const ins = db.prepare("INSERT INTO issue_queue (repo_id, number, state) VALUES (?, ?, 'waiting')");
  for (const n of numbers) ins.run(repoId, n);
}

/** The repo's Issue queue in issue-number order — the order "Solve all issues" starts the cards in. */
export function issueQueueOf(db: Db, repoId: string): IssueQueueRow[] {
  const rows = db.prepare("SELECT number, state, session_id FROM issue_queue WHERE repo_id = ? ORDER BY number").all(repoId) as {
    number: number;
    state: string;
    session_id: string | null;
  }[];
  return rows.map((r) => ({ number: r.number, state: r.state as IssueQueueStepState, sessionId: r.session_id }));
}

/** One step's state, and the session its card is (null for a step whose card the queue never started). */
export function issueQueueStep(db: Db, repoId: string, number: number, state: IssueQueueStepState, sessionId: string | null = null) {
  db.prepare("UPDATE issue_queue SET state = ?, session_id = ? WHERE repo_id = ? AND number = ?").run(state, sessionId, repoId, number);
}

/** The queue is over: its rows go with it, so the board states no queue for the repo. */
export function issueQueueClear(db: Db, repoId: string) {
  db.prepare("DELETE FROM issue_queue WHERE repo_id = ?").run(repoId);
}

/** The spec issues the board watches for this repo (the unclaimed spec cards it showed; see the spec_watch table). */
export function specWatchOf(db: Db, repoId: string): number[] {
  return (db.prepare("SELECT number FROM spec_watch WHERE repo_id = ?").all(repoId) as { number: number }[]).map((r) => r.number);
}

/** Watch these spec issues of the repo: the unclaimed spec cards a board load showed. */
export function specWatchAdd(db: Db, repoId: string, numbers: number[]) {
  const ins = db.prepare("INSERT OR IGNORE INTO spec_watch (repo_id, number) VALUES (?, ?)");
  for (const n of numbers) ins.run(repoId, n);
}

/** Unwatch these issues of the repo: a session claimed them, or a delivery recorded them as done. */
export function specWatchRemove(db: Db, repoId: string, numbers: number[]) {
  const del = db.prepare("DELETE FROM spec_watch WHERE repo_id = ? AND number = ?");
  for (const n of numbers) del.run(repoId, n);
}
