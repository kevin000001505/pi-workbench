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

test("listIssues returns the repo's open issues, with pull requests filtered out", async () => {
  const { GitHub } = await import("../src/github.ts");
  const client = new GitHub("ghp_test");

  const created = await client.createRepo({ name: "issue-app", private: true });
  const list = await client.listIssues(created.owner.login, created.name);
  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map((i) => [i.number, i.title, i.labels, i.updatedAt]),
    [
      [1, "Add dark mode", ["enhancement"], "2025-01-03T00:00:00Z"],
      [2, "Fix login Crash", ["bug"], "2025-01-02T00:00:00Z"],
      [3, "Docs: setup guide", ["documentation"], "2025-01-01T00:00:00Z"],
    ],
  );
  assert.equal(list[0].htmlUrl, `https://github.com/${created.owner.login}/${created.name}/issues/1`);
  // The mock's issues feed also carries a pull request entry (number 9); it must not leak in.
  assert.ok(!list.some((i) => i.number === 9));
});

test("listIssues filters by label and by case-insensitive search over title, body and number", async () => {
  const { GitHub } = await import("../src/github.ts");
  const client = new GitHub("ghp_test");
  const created = await client.createRepo({ name: "filter-app", private: true });
  const { login } = created.owner;
  const name = created.name;

  assert.deepEqual((await client.listIssues(login, name, { label: "bug" })).map((i) => i.number), [2]);
  assert.deepEqual((await client.listIssues(login, name, { label: "BUG" })).map((i) => i.number), [2]); // label match is case-insensitive
  assert.deepEqual((await client.listIssues(login, name, { label: "nope" })).length, 0);

  assert.deepEqual((await client.listIssues(login, name, { q: "DARK" })).map((i) => i.number), [1]); // title
  assert.deepEqual((await client.listIssues(login, name, { q: "reloaded" })).map((i) => i.number), [2]); // body
  assert.deepEqual((await client.listIssues(login, name, { q: "3" })).map((i) => i.number), [3]); // issue number
  assert.deepEqual((await client.listIssues(login, name, { q: "absent" })).length, 0);
  // label and search combine
  assert.deepEqual((await client.listIssues(login, name, { label: "bug", q: "crash" })).map((i) => i.number), [2]);
  assert.deepEqual((await client.listIssues(login, name, { label: "bug", q: "dark" })).length, 0);
});

test("listIssues caps at 30 when the issues feed holds more", async () => {
  const { GitHub } = await import("../src/github.ts");
  const client = new GitHub("ghp_test");
  const created = await client.createRepo({ name: "cap-app", private: true });
  const { login } = created.owner;
  const name = created.name;
  for (let n = 100; n < 130; n++)
    gh.issues.push({
      owner: login,
      name,
      number: n,
      title: `Issue ${n}`,
      body: null,
      state: "open",
      labels: [],
      assignees: [],
      updated_at: "2025-02-01T00:00:00Z",
      html_url: `https://github.com/${login}/${name}/issues/${n}`,
    });
  assert.equal((await client.listIssues(login, name)).length, 30);
});

test("getIssue returns body, labels, assignees and updated time", async () => {
  const { GitHub, GitHubError } = await import("../src/github.ts");
  const client = new GitHub("ghp_test");
  const created = await client.createRepo({ name: "detail-app", private: true });
  const { login } = created.owner;

  const issue = await client.getIssue(login, created.name, 1);
  assert.deepEqual(
    { number: issue.number, title: issue.title, body: issue.body, labels: issue.labels, assignees: issue.assignees, updatedAt: issue.updatedAt },
    { number: 1, title: "Add dark mode", body: "Support a dark theme for the UI.", labels: ["enhancement"], assignees: ["kevin"], updatedAt: "2025-01-03T00:00:00Z" },
  );
  assert.equal(issue.htmlUrl, `https://github.com/${login}/${created.name}/issues/1`);
  assert.equal((await client.getIssue(login, created.name, 2)).assignees.length, 0);
  await assert.rejects(client.getIssue(login, created.name, 99), (e: any) => e instanceof GitHubError && e.status === 404);
  // A bad token or missing scope surfaces in the client's existing error shape.
  await assert.rejects(new GitHub("nope").getIssue(login, created.name, 1), (e: any) => e instanceof GitHubError && e.status === 401 && /Bad credentials/.test(e.message));
});

test("listIssueComments returns the issue's comments, capped at 100", async () => {
  const { GitHub } = await import("../src/github.ts");
  const client = new GitHub("ghp_test");
  const created = await client.createRepo({ name: "comment-app", private: true });
  const { login } = created.owner;
  const name = created.name;

  assert.deepEqual(
    (await client.listIssueComments(login, name, 1)).map((c) => [c.id, c.author, c.body, c.createdAt]),
    [
      [101, "kevin", "I agree, this would be great.", "2025-01-03T01:00:00Z"],
      [102, "other", "Anyone working on this?", "2025-01-03T02:00:00Z"],
    ],
  );
  // More than 100 comments on one page: only the first 100 come back.
  for (let n = 0; n < 150; n++)
    gh.comments.push({
      owner: login,
      name,
      issueNumber: 1,
      id: 1000 + n,
      user: { login: `bot${n % 5}`, id: 100 + (n % 5), name: null },
      body: `Comment ${n}`,
      created_at: "2025-03-01T00:00:00Z",
    });
  assert.equal((await client.listIssueComments(login, name, 1)).length, 100);
});

test("a bad token surfaces GitHub's message", async () => {
  const { GitHub, GitHubError } = await import("../src/github.ts");
  await assert.rejects(new GitHub("nope").user(), (e: any) => e instanceof GitHubError && e.status === 401 && /Bad credentials/.test(e.message));
  assert.throws(() => new GitHub(undefined), /GITHUB_TOKEN/);
});
