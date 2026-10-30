/** Create repo → clone → worktree → commit → Create PR, against the mock GitHub and local bare repos. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startMockGitHub } from "./mock-github.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gh-"));
const remotes = path.join(tmp, "remotes");
fs.mkdirSync(remotes);
process.env.DATA_DIR = path.join(tmp, "data");
process.env.GITHUB_CLONE_BASE = `file://${remotes}`;

let gh: Awaited<ReturnType<typeof startMockGitHub>>;
const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

before(async () => {
  gh = await startMockGitHub(remotes);
  const { config } = await import("../src/config.ts");
  config.githubApi = gh.url;
});
after(async () => {
  await gh.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("create a repo, work on a branch, and open a PR", async () => {
  const { openDb } = await import("../src/db.ts");
  const { config } = await import("../src/config.ts");
  const { GitHub } = await import("../src/github.ts");
  const { addRepo, createWorktree, repoNeedsSetup, worktreeStatus } = await import("../src/repos.ts");
  const { openPr, draftPr } = await import("../src/prs.ts");
  const db = openDb(config.dbFile);
  const client = new GitHub("ghp_test");

  const created = await client.createRepo({ name: "new-app", private: true });
  const repo = await addRepo(db, { owner: created.owner.login, name: created.name, defaultBranch: created.default_branch, private: true }, env);
  assert.equal(repo.id, "kevin/new-app");
  assert.equal(await repoNeedsSetup(repo), true);
  await assert.rejects(client.createRepo({ name: "new-app", private: true }), /already exists/);

  const worktree = await createWorktree(repo, "s1", "pi/feature-s1", "main", env);
  const row = {
    id: "s1",
    repo_id: repo.id,
    title: "Add feature",
    branch: "pi/feature-s1",
    base_branch: "main",
    worktree,
    created_at: 0,
    updated_at: 0,
    pr_number: null,
    pr_url: null,
    held_prompt: null,
    archived: 0,
  };
  await assert.rejects(openPr(row, repo, client, env, { title: "x", body: "" }), /No commits/);

  fs.writeFileSync(path.join(worktree, "feature.txt"), "hello\n");
  assert.deepEqual(await worktreeStatus(worktree, "main"), { dirty: true, changedFiles: 1, ahead: 0 });
  // Model unreachable: the draft falls back to the title and commit list instead of failing.
  const draft = await draftPr(row, env, { baseUrl: "http://127.0.0.1:9/v1", modelId: "m", contextWindow: 1, maxTokens: 1, reasoning: false, thinkingFormat: "" }, undefined);
  assert.equal(draft.drafted, false);
  assert.equal(draft.title, "Add feature");
  assert.match(draft.uncommitted, /feature\.txt/);

  const pr = await openPr(row, repo, client, env, { title: "Add feature", body: "## Summary", commitMessage: "Add feature file" });
  assert.equal(pr.number, 1);
  assert.equal(gh.pulls[0].head, "pi/feature-s1");
  assert.equal(gh.pulls[0].base, "main");
  const pushed = execFileSync("git", ["log", "--format=%s", "-1", "pi/feature-s1"], { cwd: path.join(remotes, "kevin", "new-app.git"), encoding: "utf8" });
  assert.equal(pushed.trim(), "Add feature file");

  const status = await client.pullStatus("kevin", "new-app", 1);
  assert.deepEqual(status.checks, { total: 2, pending: 1, failed: 0, passed: 1 });
  assert.equal(status.comments, 1);
});

test("a bad token surfaces GitHub's message", async () => {
  const { GitHub, GitHubError } = await import("../src/github.ts");
  await assert.rejects(new GitHub("nope").user(), (e: any) => e instanceof GitHubError && e.status === 401 && /Bad credentials/.test(e.message));
  assert.throws(() => new GitHub(undefined), /GITHUB_TOKEN/);
});
