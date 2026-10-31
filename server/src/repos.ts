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
  };
  await syncClone(row, env);
  db.prepare(
    `INSERT INTO repos (id, owner, name, default_branch, private, added_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET default_branch = excluded.default_branch, private = excluded.private`,
  ).run(row.id, row.owner, row.name, row.default_branch, row.private, row.added_at);
  return row;
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
