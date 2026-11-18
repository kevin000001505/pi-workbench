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
  /** JSON list of installed_skills ids: this ticket's Ticket skill tags (issue #119). */
  skills: string;
  /** pi session id of the fix run, when one started. */
  fix_run_id: string | null;
  /** null | diagnosing | fixing | rescued | failed */
  rescue_state: string | null;
};

/** A Skill source the user added (issue #114). `commit_sha` is the one the clone pinned, and
 * `size_bytes` the tree the install keeps. */
export type SkillSourceRow = {
  id: string;
  url: string;
  ref: string | null;
  subpath: string | null;
  commit_sha: string;
  size_bytes: number;
  created_at: number;
  updated_at: number;
  /** Why the last Update of this source failed, or null when the installed version is the last one the
   * library tried (issue #122). */
  last_error: string | null;
};

/** One installed skill of a Skill source. `dir` is its directory under the install directory,
 * and `files` its file names as a JSON array. */
export type InstalledSkillRow = {
  id: string;
  source_id: string;
  name: string;
  description: string;
  dir: string;
  files: string;
  /** 0 or 1: the skill's on/off switch. An off skill reaches no run.
   * `attach`: a JSON list of the pipeline places it is attached to. */
  enabled: number;
  attach: string;
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
  skills TEXT NOT NULL DEFAULT '[]',
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
-- The skill library (issue #114): the Skill sources the user added, and the skills each one
-- installed. The install directory (config.installedSkillsDir) holds the tree these rows describe.
CREATE TABLE IF NOT EXISTS skill_sources (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, ref TEXT, subpath TEXT, commit_sha TEXT NOT NULL,
  size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_error TEXT
);
CREATE TABLE IF NOT EXISTS installed_skills (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
  dir TEXT NOT NULL, files TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1, attach TEXT NOT NULL DEFAULT '[]'
);
-- The Issue queue (issue #103): the issue numbers "Solve all issues" snapshotted, in number order.
-- state: waiting (its turn has not come), running (the card the queue waits on), paused (that card is
-- stuck — blocked, stopped, or waiting on the user's answer — so the queue starts no next card, issue
-- #104), done (it reached Review), skipped (it was claimed or moved by hand, its start was refused, or
-- its card was Abandoned or archived before its turn). The rows go with the queue.
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
  // The installed skill's on/off switch and its attach points (issue #117): the places are stored as
  // a JSON list of the names pipeline.ts names, in that order.
  ["installed_skills", "enabled", "INTEGER NOT NULL DEFAULT 1"],
  ["installed_skills", "attach", "TEXT NOT NULL DEFAULT '[]'"],
  // A ticket's Ticket skill tags (issue #119): a JSON list of installed_skills ids — the library skills
  // its runs must load.
  ["tickets", "skills", "TEXT NOT NULL DEFAULT '[]'"],
  // Why the last Update of a Skill source failed (issue #122): the reason the Skills page states, so a
  // source that could not take its new version says so instead of looking up to date.
  ["skill_sources", "last_error", "TEXT"],
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
export type IssueQueueStepState = "waiting" | "running" | "paused" | "done" | "skipped";
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

/**
 * Record one installed Skill source and the skills it brought, in one transaction: an add that wrote
 * half of them is no add at all, so nothing half-installed stays in the library.
 */
export function recordSkillSource(db: Db, source: SkillSourceRow, skills: InstalledSkillRow[]) {
  const insSource = db.prepare(
    "INSERT INTO skill_sources (id, url, ref, subpath, commit_sha, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insSkill = db.prepare("INSERT INTO installed_skills (id, source_id, name, description, dir, files) VALUES (?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    insSource.run(source.id, source.url, source.ref, source.subpath, source.commit_sha, source.size_bytes, source.created_at, source.updated_at);
    for (const s of skills) insSkill.run(s.id, s.source_id, s.name, s.description, s.dir, s.files);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Every Skill source in the library, newest first. */
export function skillSourceRows(db: Db): SkillSourceRow[] {
  return db.prepare("SELECT * FROM skill_sources ORDER BY created_at DESC, id").all() as SkillSourceRow[];
}

/** One Skill source, by its id. */
export function skillSourceRow(db: Db, id: string): SkillSourceRow | undefined {
  return db.prepare("SELECT * FROM skill_sources WHERE id = ?").get(id) as SkillSourceRow | undefined;
}

/**
 * Take a Skill source out of the library (issue #122, Remove): its row, the rows of the skills it
 * installed, and every ticket's Ticket skill tag that named one of them — all in one transaction, so no
 * card is left holding a tag that names nothing and no skill is left stated without its source.
 * Answers with the cards whose tags changed, so their boards and card details can be told to read again.
 */
export function deleteSkillSource(db: Db, sourceId: string, skillIds: readonly string[]): TicketTagCard[] {
  db.exec("BEGIN");
  try {
    const cards = clearSkillTags(db, skillIds);
    db.prepare("DELETE FROM installed_skills WHERE source_id = ?").run(sourceId);
    db.prepare("DELETE FROM skill_sources WHERE id = ?").run(sourceId);
    db.exec("COMMIT");
    return cards;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** The version an Update installed: the commit the source's ref resolved to, and the tree it keeps. */
export type SkillSourceVersion = { commit_sha: string; size_bytes: number; updated_at: number };

/**
 * Record the version an Update installed (issue #122), in one transaction: the commit the source now
 * pins and the size of the tree it keeps, the failure the source stated (cleared), the source's
 * installed skills written whole, and every ticket's Ticket skill tag that named a skill the new version
 * no longer carries (dropped). One transaction because these facts are one fact: a library that cannot
 * record them all records none of them and keeps stating the version it had.
 *
 * A skill the new version carries too keeps its row only if the caller passes it — and with the row its
 * identifier, its on/off switch and its attach points, which a Ticket skill tag and a run read.
 */
export function recordSkillSourceUpdate(
  db: Db,
  sourceId: string,
  version: SkillSourceVersion,
  skills: InstalledSkillRow[],
  droppedSkillIds: readonly string[],
): TicketTagCard[] {
  db.exec("BEGIN");
  try {
    const cards = clearSkillTags(db, droppedSkillIds);
    db.prepare("UPDATE skill_sources SET commit_sha = ?, size_bytes = ?, updated_at = ?, last_error = NULL WHERE id = ?").run(
      version.commit_sha,
      version.size_bytes,
      version.updated_at,
      sourceId,
    );
    db.prepare("DELETE FROM installed_skills WHERE source_id = ?").run(sourceId);
    const ins = db.prepare("INSERT INTO installed_skills (id, source_id, name, description, dir, files, enabled, attach) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const s of skills) ins.run(s.id, sourceId, s.name, s.description, s.dir, s.files, s.enabled, s.attach);
    db.exec("COMMIT");
    return cards;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * State why an Update failed, and change nothing else (issue #122): an Update that could not clone or
 * validate keeps its pinned commit and its installed tree, so the only fact it writes is the reason the
 * Skills page has to show.
 */
export function recordSkillSourceFailure(db: Db, sourceId: string, reason: string) {
  db.prepare("UPDATE skill_sources SET last_error = ? WHERE id = ?").run(reason, sourceId);
}

/** One card whose ticket tags a library change changed. */
export type TicketTagCard = { session: string; repo: string };

/**
 * Take these installed skills out of every ticket's Ticket skill tags (issue #122): a card is never told
 * to load a skill the library no longer holds, on a run or on the Board. The tags that still name a
 * skill the library holds keep their order. Answers with the cards that changed, each named once.
 */
export function clearSkillTags(db: Db, skillIds: readonly string[]): TicketTagCard[] {
  if (!skillIds.length) return [];
  const gone = new Set(skillIds);
  const cards = new Map<string, TicketTagCard>();
  // The card's repo comes from the session: a ticket names its card, and a board is told per repo.
  const rows = db.prepare(
    "SELECT t.session_id, t.num, t.skills, s.repo_id FROM tickets t JOIN sessions s ON s.id = t.session_id WHERE t.skills IS NOT NULL",
  ).all() as { session_id: string; num: number; skills: string; repo_id: string }[];
  const update = db.prepare("UPDATE tickets SET skills = ? WHERE session_id = ? AND num = ?");
  for (const t of rows) {
    let stored: unknown;
    try {
      stored = JSON.parse(t.skills);
    } catch {
      continue;
    }
    if (!Array.isArray(stored)) continue;
    const kept = stored.filter((id) => typeof id !== "string" || !gone.has(id));
    if (kept.length === stored.length) continue;
    update.run(JSON.stringify(kept), t.session_id, t.num);
    cards.set(t.session_id, { session: t.session_id, repo: t.repo_id });
  }
  return [...cards.values()];
}

/** The installed skill's on/off switch and its attach points (issue #117). */
export function setInstalledSkillSettings(db: DatabaseSync, id: string, enabled: number, attach: string) {
  db.prepare("UPDATE installed_skills SET enabled = ?, attach = ? WHERE id = ?").run(enabled, attach, id);
}

/** One installed skill, by its id. */
export function installedSkillRow(db: DatabaseSync, id: string): InstalledSkillRow | undefined {
  return db.prepare("SELECT * FROM installed_skills WHERE id = ?").get(id) as InstalledSkillRow | undefined;
}

/** Every installed skill of every source, by name within its source. */
export function installedSkillRows(db: Db): InstalledSkillRow[] {
  return db.prepare("SELECT * FROM installed_skills ORDER BY source_id, name, id").all() as InstalledSkillRow[];
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
