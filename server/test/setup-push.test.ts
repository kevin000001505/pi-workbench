/**
 * The setup commit's way onto the default branch (issue #100): the server pushes the setup
 * session's commit to the repo's default branch, merges that branch in when it moved, and reports
 * why a push it still cannot make failed. Only a committed setup marker can land. No pull request,
 * no Approve.
 *
 * Seams under test: `pushSetupCommit` (repos.ts) against a real bare remote, a clone and a
 * worktree, and `recordSetUp` with `recordedSetupState` on a real db.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { recordSetUp, recordedSetupState, pushSetupCommit, type RepoRow } from "../src/repos.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const MARKER = "docs/agents/issue-tracker.md";

/**
 * A bare remote on `main`, a clone of it, and a worktree on `setup`. By default the worktree holds
 * one committed setup marker. `commit: false` leaves that file written but never committed, and
 * `mainMarker` puts the setup file on the default branch instead, with nothing new in the worktree.
 */
function setupRepo(opts: { commit?: boolean; mainMarker?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-setup-push-"));
  const seed = path.join(root, "seed");
  fs.mkdirSync(seed);
  sh(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "README.md"), "# demo\n");
  if (opts.mainMarker) {
    fs.mkdirSync(path.join(seed, "docs/agents"), { recursive: true });
    fs.writeFileSync(path.join(seed, MARKER), opts.mainMarker);
  }
  sh(seed, "add", ".");
  sh(seed, ...id, "commit", "-qm", "Initial commit");
  const remote = path.join(root, "remote.git");
  sh(root, "clone", "-q", "--bare", seed, remote);
  const clone = path.join(root, "clone");
  sh(root, "clone", "-q", remote, clone);
  const worktree = path.join(root, "worktree");
  sh(clone, "worktree", "add", "-q", "-b", "setup", worktree, "origin/main");
  if (!opts.mainMarker) {
    fs.mkdirSync(path.join(worktree, "docs/agents"), { recursive: true });
    fs.writeFileSync(path.join(worktree, MARKER), "GitHub Issues\n");
    sh(worktree, "add", ".");
    if (opts.commit !== false) sh(worktree, ...id, "commit", "-qm", "Set up agent skills");
  }
  const repo = { id: "me/demo", owner: "me", name: "demo", default_branch: "main", private: 1, added_at: 0, setup_state: "not_set_up", setup_session: null } as RepoRow;
  return { root, remote, clone, worktree, repo };
}

/** Move the remote's `main` on its own, through a throwaway clone, so the setup worktree's branch falls behind. */
function moveMain(remote: string, files: Record<string, string>, message: string) {
  const root = fs.mkdtempSync(path.join(path.dirname(remote), ".move-"));
  const dir = path.join(root, "other");
  sh(root, "clone", "-q", remote, dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  sh(dir, "add", ".");
  sh(dir, ...id, "commit", "-qm", message);
  sh(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
  fs.rmSync(root, { recursive: true, force: true });
}

const markerOnMain = (remote: string) => {
  try {
    return sh(remote, "show", `refs/heads/main:${MARKER}`);
  } catch {
    return null;
  }
};
const mainLog = (remote: string) => sh(remote, "log", "--format=%s", "refs/heads/main").split("\n");
const mainSha = (remote: string) => sh(remote, "rev-parse", "refs/heads/main");
/** Whether the worktree holds a merge git never finished (its MERGE_HEAD is there). */
const halfMerged = (worktree: string) => {
  try {
    sh(worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD");
    return true;
  } catch {
    return false;
  }
};
/** A worktree still in the middle of a merge, or with changes nothing committed. */
const worktreeDirty = (worktree: string) => halfMerged(worktree) || sh(worktree, "status", "--porcelain").length > 0;

test("the setup commit lands on the repo's default branch, and the push reports no failure", async () => {
  const { remote, worktree, repo } = setupRepo();
  assert.deepEqual(await pushSetupCommit(repo, worktree, gitEnv), { ok: true });
  assert.equal(markerOnMain(remote), "GitHub Issues", "the default branch carries the setup file");
  assert.deepEqual(mainLog(remote), ["Set up agent skills", "Initial commit"]);
});

test("a default branch that moved merges into the setup branch and lands on the second push", async () => {
  const { remote, worktree, repo } = setupRepo();
  moveMain(remote, { "work.txt": "someone else's work\n" }, "Other work");
  assert.deepEqual(await pushSetupCommit(repo, worktree, gitEnv), { ok: true }, "the moved branch merges in, then the push lands");
  assert.ok(mainLog(remote).includes("Set up agent skills"), "the setup commit is on the default branch");
  assert.ok(mainLog(remote).includes("Other work"), "the work that moved the branch stays on it");
  assert.equal(markerOnMain(remote), "GitHub Issues");
  assert.equal(sh(remote, "show", "refs/heads/main:work.txt"), "someone else's work");
});

test("a push git refuses for another reason reports git's own reason, not a moved branch", async () => {
  const { remote, worktree, repo } = setupRepo();
  const before = mainSha(remote);
  fs.writeFileSync(path.join(remote, "hooks", "pre-receive"), "#!/bin/sh\necho protected branch >&2\nexit 1\n");
  fs.chmodSync(path.join(remote, "hooks", "pre-receive"), 0o755);

  const result = await pushSetupCommit(repo, worktree, gitEnv);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.reason, /main/, "the reason names the branch the push failed on");
  assert.match(result.reason, /protected branch/, "the reason carries git's own words");
  assert.ok(!/merging/i.test(result.reason), `no merge was tried: ${result.reason}`);
  assert.equal(mainSha(remote), before, "the default branch is untouched");
  assert.equal(markerOnMain(remote), null);
});

test("a setup marker the run wrote but never committed does not land", async () => {
  const { remote, worktree, repo } = setupRepo({ commit: false });
  const before = mainSha(remote);

  // git calls a push with nothing to push a success, so the missing commit must be the failure.
  const result = await pushSetupCommit(repo, worktree, gitEnv);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.reason, /uncommitted/);
  assert.ok(result.reason.includes(MARKER), `the reason names the file no commit carries: ${result.reason}`);
  assert.equal(mainSha(remote), before, "nothing was pushed");
  assert.equal(markerOnMain(remote), null, "the default branch did not gain the setup file");
});

test("a default branch that already carries the committed setup files lands with nothing to push", async () => {
  const { remote, worktree, repo } = setupRepo({ mainMarker: "GitLab Issues\n" });
  const before = mainSha(remote);
  assert.deepEqual(await pushSetupCommit(repo, worktree, gitEnv), { ok: true }, "the setup files are already on the branch");
  assert.equal(mainSha(remote), before, "the push had nothing to send");
  assert.equal(markerOnMain(remote), "GitLab Issues", "the repo reads as set up because the branch really carries the file");
});

test("a moved default branch that conflicts with the setup commit reports it and leaves the worktree clean", async () => {
  const { remote, worktree, repo } = setupRepo();
  moveMain(remote, { [MARKER]: "GitLab Issues\n" }, "Other tracker");
  const moved = mainSha(remote);

  const result = await pushSetupCommit(repo, worktree, gitEnv);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.reason, /conflict/i);
  assert.ok(result.reason.includes(MARKER), `the reason names the file git could not merge: ${result.reason}`);
  assert.equal(mainSha(remote), moved, "nothing of the setup branch reached the default branch");
  assert.equal(markerOnMain(remote), "GitLab Issues", "the default branch keeps its own setup file");
  assert.equal(worktreeDirty(worktree), false, "the half-done merge is undone in the worktree");
});

test("a moved default branch git cannot merge for another reason reports git's reason, not a conflict", async () => {
  const { remote, worktree, repo } = setupRepo();
  // The worktree holds an uncommitted change to the same file the branch moved: git refuses the
  // merge before it starts, so no file is conflicted.
  fs.writeFileSync(path.join(worktree, "README.md"), "an uncommitted local edit\n");
  moveMain(remote, { "README.md": "someone else's edit\n" }, "Other work");
  const moved = mainSha(remote);

  const result = await pushSetupCommit(repo, worktree, gitEnv);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.reason, /local changes/, `the reason carries git's own words: ${result.reason}`);
  assert.ok(!/conflict/i.test(result.reason), `git reported no conflict: ${result.reason}`);
  assert.equal(mainSha(remote), moved, "the default branch keeps what it had");
  assert.equal(halfMerged(worktree), false, "no merge was left half done");
});

test("a repo whose setup commit landed reads as set up", () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wb-setup-state-")), "t.db"));
  db.prepare("INSERT INTO repos (id, owner, name, default_branch, private, added_at) VALUES ('me/demo','me','demo','main',1,0)").run();
  db.prepare("UPDATE repos SET setup_state = 'not_set_up' WHERE id = 'me/demo'").run();
  assert.equal(recordedSetupState(db, "me/demo"), "not_set_up");
  recordSetUp(db, "me/demo");
  assert.equal(recordedSetupState(db, "me/demo"), "set_up");
});
