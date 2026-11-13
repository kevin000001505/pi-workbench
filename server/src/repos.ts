import fs from "node:fs";
import path from "node:path";
import { config, SETUP_MARKER } from "./config.ts";
import type { Db, RepoRow } from "./db.ts";
import { git, type GitEnv } from "./git.ts";

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

export function assertRepoName(owner: string, name: string) {
  if (!NAME_RE.test(owner) || !NAME_RE.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid repository: ${owner}/${name}`);
  }
}

export const clonePath = (repo: Pick<RepoRow, "owner" | "name">) => path.join(config.reposDir, repo.owner, repo.name);

export function listRepos(db: Db): RepoRow[] {
  return db.prepare("SELECT * FROM repos ORDER BY added_at DESC").all() as RepoRow[];
}

export function getRepo(db: Db, id: string): RepoRow | undefined {
  return db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | undefined;
}

/** Like `getRepo`, but for callers that must fail: untracked repos get a clear 404. */
export function requireTrackedRepo(db: Db, id: string): RepoRow {
  const repo = getRepo(db, id);
  if (!repo) throw Object.assign(new Error(`Unknown repo ${id}`), { status: 404 });
  return repo;
}

/** Clone on first use, fetch afterwards. The clone is only a source for worktrees; nobody works in it. */
export async function syncClone(repo: RepoRow, env: GitEnv) {
  const dir = clonePath(repo);
  if (fs.existsSync(path.join(dir, ".git"))) {
    await git(dir, ["fetch", "origin", "--prune"], env);
  } else {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(config.reposDir, ["clone", `${config.githubCloneBase}/${repo.owner}/${repo.name}.git`, dir], env);
  }
  return dir;
}

export async function addRepo(db: Db, input: { owner: string; name: string; defaultBranch: string; private: boolean }, env: GitEnv) {
  assertRepoName(input.owner, input.name);
  const row: RepoRow = {
    id: `${input.owner}/${input.name}`,
    owner: input.owner,
    name: input.name,
    default_branch: input.defaultBranch,
    private: input.private ? 1 : 0,
    added_at: Date.now(),
    setup_state: null,
    setup_session: null,
  };
  await syncClone(row, env);
  db.prepare(
    `INSERT INTO repos (id, owner, name, default_branch, private, added_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET default_branch = excluded.default_branch, private = excluded.private`,
  ).run(row.id, row.owner, row.name, row.default_branch, row.private, row.added_at);
  await recordRepoSetup(db, row);
  return getRepo(db, row.id)!;
}

/** Whether setup-matt-pocock-skills has been committed to the repo's default branch. */
export async function repoNeedsSetup(repo: RepoRow): Promise<boolean> {
  const dir = clonePath(repo);
  try {
    await git(dir, ["cat-file", "-e", `origin/${repo.default_branch}:${SETUP_MARKER}`]);
    return false;
  } catch {
    return true;
  }
}

/** What the workbench recorded about a repo's agent-skills setup. */
export type RepoSetupState = "set_up" | "not_set_up";

/** The state in the repo's row, or null when nothing was recorded (a repo added before this record existed). */
export function recordedSetupState(db: Db, repoId: string): RepoSetupState | null {
  const row = db.prepare("SELECT setup_state FROM repos WHERE id = ?").get(repoId) as { setup_state: string | null } | undefined;
  return row?.setup_state === "set_up" || row?.setup_state === "not_set_up" ? row.setup_state : null;
}

/** Check the setup marker on the default branch once and record what was found. A repo already recorded as set up keeps that state and gets no new check. */
export async function recordRepoSetup(db: Db, repo: RepoRow): Promise<RepoSetupState> {
  const recorded = recordedSetupState(db, repo.id);
  if (recorded === "set_up") return recorded;
  const state: RepoSetupState = (await repoNeedsSetup(repo)) ? "not_set_up" : "set_up";
  db.prepare("UPDATE repos SET setup_state = ? WHERE id = ?").run(state, repo.id);
  return state;
}

/** The state the pages and sessions read: the record, or for a repo with no record (added before this change) one marker check that records what it finds. */
export async function repoSetupState(db: Db, repo: RepoRow): Promise<RepoSetupState> {
  return recordedSetupState(db, repo.id) ?? (await recordRepoSetup(db, repo));
}

/** Record that the repo's agent-skills setup files are on its default branch: every later read says it is set up. */
export function recordSetUp(db: Db, repoId: string) {
  db.prepare("UPDATE repos SET setup_state = 'set_up' WHERE id = ?").run(repoId);
}

/**
 * Whether a session on this repo starts with a setup run (issue #101). The repo's record decides, so
 * no repo runs the setup twice: a repo recorded as set up runs none, and a repo recorded as not set
 * up runs one without a new marker check. Only a repo with no recorded state — added before the
 * record existed — still reads the marker off its fresh worktree, and that check records nothing: the record
 * is written by the add-time check and by a landed setup push.
 */
export function needsSetupRun(db: Db, repo: RepoRow, worktree: string): boolean {
  const recorded = recordedSetupState(db, repo.id);
  return recorded === null ? worktreeNeedsSetup(worktree) : recorded === "not_set_up";
}

/** Why the setup commit did not land on the default branch, in git's own words plus the branch it failed on. */
export type SetupPush = { ok: true } | { ok: false; reason: string };

/**
 * Land the setup session's commit on the repo's default branch: no pull request, no Approve.
 * Fetch the branch, then push the setup branch's HEAD onto it. When the push is refused because
 * the branch moved, merge it into the setup branch and push again; a merge that stops is undone,
 * so the worktree stays as it was. Only a *committed* setup marker can land: a marker the run
 * wrote but never committed is in no ref, and pushing HEAD would report success while the default
 * branch gained nothing. Every way this can fail comes back as the reason, and the default branch
 * keeps what it had.
 */
export async function pushSetupCommit(repo: RepoRow, worktree: string, env: GitEnv): Promise<SetupPush> {
  const base = repo.default_branch;
  const sh = (args: string[]) => git(worktree, args, env);
  const does = (args: string[]) => sh(args).then(() => true, () => false);
  const push = () => sh(["push", "-q", "origin", `HEAD:refs/heads/${base}`]);
  const words = (err: unknown) => (err as Error).message;
  /** Whether a ref carries the setup marker as a committed file. */
  const markerIn = (ref: string) => does(["cat-file", "-e", `${ref}:${SETUP_MARKER}`]);
  try {
    await sh(["fetch", "-q", "origin", base]);
  } catch (err) {
    return { ok: false, reason: `fetching ${base} failed: ${words(err)}` };
  }
  // Nothing to land when no commit carries the setup files. The branch may already carry them
  // (someone landed them by hand), and then recording the repo as set up is still honest.
  if (!(await markerIn("HEAD")) && !(await markerIn(`origin/${base}`)))
    return { ok: false, reason: `no commit carries ${SETUP_MARKER}: the setup run left its setup files uncommitted` };
  try {
    await push();
    return { ok: true };
  } catch (err) {
    // Ask the branch whether it moved: a push git refuses for another reason is not a merge away.
    await sh(["fetch", "-q", "origin", base]).catch(() => {});
    const branchMoved = !(await does(["merge-base", "--is-ancestor", `origin/${base}`, "HEAD"]));
    if (!branchMoved) return { ok: false, reason: `pushing the setup commit to ${base} failed: ${words(err)}` };
    try {
      await sh(["merge", "--no-edit", `origin/${base}`]);
    } catch (mergeErr) {
      // git names the files it could not merge; anything else is git's own reason, not a conflict.
      const conflicted = await sh(["diff", "--name-only", "--diff-filter=U"]).then((out) => out.split("\n").filter(Boolean), () => [] as string[]);
      await sh(["merge", "--abort"]).catch(() => {});
      return {
        ok: false,
        reason: conflicted.length
          ? `${base} moved, and merging it into the setup branch stopped on a conflict in ${conflicted.join(", ")}`
          : `${base} moved, but merging it into the setup branch failed: ${words(mergeErr)}`,
      };
    }
    try {
      await push();
      return { ok: true };
    } catch (err2) {
      return { ok: false, reason: `pushing the setup commit to ${base} again after merging ${base} in failed: ${words(err2)}` };
    }
  }
}

export const worktreeNeedsSetup = (worktree: string) => !fs.existsSync(path.join(worktree, SETUP_MARKER));

/** A fresh worktree on a new branch from origin/<base>, so parallel sessions never share a checkout. */
export async function createWorktree(repo: RepoRow, sessionId: string, branch: string, base: string, env: GitEnv) {
  const dir = await syncClone(repo, env);
  const worktree = path.join(config.worktreesDir, sessionId);
  fs.mkdirSync(config.worktreesDir, { recursive: true });
  await git(dir, ["worktree", "add", "-b", branch, worktree, `origin/${base}`], env);
  return worktree;
}

export async function removeWorktree(repo: RepoRow, worktree: string) {
  const dir = clonePath(repo);
  try {
    await git(dir, ["worktree", "remove", "--force", worktree]);
  } catch {
    fs.rmSync(worktree, { recursive: true, force: true });
    await git(dir, ["worktree", "prune"]).catch(() => {});
  }
}

export async function worktreeStatus(worktree: string, base: string) {
  const [status, ahead] = await Promise.all([
    git(worktree, ["status", "--porcelain"]),
    git(worktree, ["rev-list", "--count", `origin/${base}..HEAD`]).catch(() => "0"),
  ]);
  return { dirty: status.trim().length > 0, changedFiles: status.trim() ? status.trim().split("\n").length : 0, ahead: Number(ahead.trim()) };
}

export function slugify(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "session"
  );
}
