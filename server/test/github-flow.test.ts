/** Create repo → clone → worktree → commit → Create PR, against the mock GitHub and local bare repos. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("a session that solves an issue opens a PR whose body closes it; ticket closes are kept and deduped", async () => {
  const { openDb } = await import("../src/db.ts");
  const { config } = await import("../src/config.ts");
  const { GitHub } = await import("../src/github.ts");
  const { addRepo, createWorktree } = await import("../src/repos.ts");
  const { openPr, draftPr } = await import("../src/prs.ts");
  const { startMockLlm } = await import("./mock-llm.ts");
  const db = openDb(config.dbFile);
  const client = new GitHub("ghp_test");

  const created = await client.createRepo({ name: "solve-app", private: true });
  const repo = await addRepo(db, { owner: created.owner.login, name: created.name, defaultBranch: created.default_branch, private: true }, env);
  const worktree = await createWorktree(repo, "s9", "pi/solve-s9", "main", env);
  // The sessions table, as sessions.create persists it: this one solves the repo's issue #1.
  db.prepare(
    "INSERT INTO sessions (id, repo_id, title, branch, base_branch, worktree, created_at, updated_at, issue_ref) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)",
  ).run("s9", repo.id, "Solve issue 1", "pi/solve-s9", "main", worktree, `${repo.id}#1`);
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get("s9") as any;

  fs.writeFileSync(path.join(worktree, "dark.txt"), "dark mode\n");
  execFileSync("git", ["add", "."], { cwd: worktree });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Add dark mode"], { cwd: worktree });

  // The ticket phase published issue #2; the origin issue is #1. Both must close.
  const t = (trackerRef: string) => ({ num: 1, title: "Ship it", body: "", blockedBy: [], trackerRef, status: "done" as const, note: null, runId: null });
  const noModel = { baseUrl: "http://127.0.0.1:9/v1", modelId: "m", contextWindow: 1, maxTokens: 1, reasoning: false, thinkingFormat: "" };

  const fallback = await draftPr(row, env, noModel, undefined, [t("#2")]);
  assert.equal(fallback.drafted, false);
  assert.match(fallback.body, /Closes #2/); // the ticket issue's line is preserved
  assert.match(fallback.body, /Closes #1\n$/); // the origin issue gets its own line

  const llm = await startMockLlm();
  const drafted = await draftPr(row, env, { ...noModel, baseUrl: llm.url }, undefined, [t("#2")]);
  await llm.close();
  assert.equal(drafted.drafted, true);
  assert.match(drafted.body, /Closes #2/);
  assert.match(drafted.body, /Closes #1\n$/);

  await openPr(row, repo, client, env, { title: "Add dark mode", body: fallback.body });
  const pr = gh.pulls[gh.pulls.length - 1];
  assert.match(pr.body, /Closes #1/);
  assert.match(pr.body, /Closes #2/);

  // A ticket that tracks the origin issue itself: the number appears once, not twice.
  const dup = await draftPr(row, env, noModel, undefined, [t("#1")]);
  assert.equal((dup.body.match(/Closes #1/g) ?? []).length, 1);

  // A plain session closes nothing.
  db.prepare(
    "INSERT INTO sessions (id, repo_id, title, branch, base_branch, worktree, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0)",
  ).run("s10", repo.id, "Plain", "pi/plain-s10", "main", worktree);
  const plain = await draftPr(db.prepare("SELECT * FROM sessions WHERE id = ?").get("s10") as any, env, noModel, undefined);
  assert.doesNotMatch(plain.body, /Closes/);
});

test("the delivery pushes the branch and opens the PR with the Closes lines, and reuses that PR on the next push", async () => {
  const { openDb } = await import("../src/db.ts");
  const { config } = await import("../src/config.ts");
  const { GitHub } = await import("../src/github.ts");
  const { addRepo, createWorktree } = await import("../src/repos.ts");
  const { githubDelivery } = await import("../src/delivery.ts");
  const db = openDb(config.dbFile);
  const client = new GitHub("ghp_test");
  const created = await client.createRepo({ name: "deliver-app", private: true });
  const repo = await addRepo(db, { owner: created.owner.login, name: created.name, defaultBranch: created.default_branch, private: true }, env);
  const worktree = await createWorktree(repo, "d1", "pi/deliver-d1", "main", env);
  db.prepare(
    "INSERT INTO sessions (id, repo_id, title, branch, base_branch, worktree, created_at, updated_at, issue_ref) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)",
  ).run("d1", repo.id, "Deliver it", "pi/deliver-d1", "main", worktree, `${repo.id}#3`);
  const row = () => db.prepare("SELECT * FROM sessions WHERE id = ?").get("d1") as any;
  const commit = (file: string) => {
    fs.writeFileSync(path.join(worktree, file), "x\n");
    execFileSync("git", ["add", "."], { cwd: worktree });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `Add ${file}`], { cwd: worktree });
  };
  const remoteLog = () => execFileSync("git", ["log", "--format=%s", "pi/deliver-d1"], { cwd: path.join(remotes, "kevin", "deliver-app.git"), encoding: "utf8" }).trim().split("\n");
  const delivery = githubDelivery({
    github: () => client,
    gitEnv: async () => env,
    model: () => ({ baseUrl: "http://127.0.0.1:9/v1", modelId: "m", contextWindow: 1, maxTokens: 1, reasoning: false, thinkingFormat: "" }),
    llmKey: () => undefined,
  });
  const tickets = [{ num: 1, title: "Ship it", body: "", blockedBy: [], trackerRef: "#4", status: "done" as const, note: null, runId: null }];

  // Nothing to deliver yet: the open fails with the reason.
  await assert.rejects(delivery.openPr(row(), repo, tickets), /No commits/);

  commit("a.txt");
  const pr = await delivery.openPr(row(), repo, tickets);
  const opened = gh.pulls[gh.pulls.length - 1];
  assert.equal(pr.number, opened.number);
  assert.equal(pr.url, opened.html_url);
  assert.equal(opened.head, "pi/deliver-d1");
  assert.match(opened.body, /Closes #4/);
  assert.match(opened.body, /Closes #3\n$/);
  assert.deepEqual(remoteLog()[0], "Add a.txt");

  // The session has that PR: a later delivery pushes the branch to it and opens no second PR.
  db.prepare("UPDATE sessions SET pr_number = ?, pr_url = ? WHERE id = 'd1'").run(pr.number, pr.url);
  commit("b.txt");
  const count = gh.pulls.length;
  assert.deepEqual(await delivery.openPr(row(), repo, tickets), pr);
  assert.equal(gh.pulls.length, count);
  assert.deepEqual(remoteLog()[0], "Add b.txt");
});

test("listTicketSubIssues returns the spec and its open ticket sub-issues, with their edges", async () => {
  const { GitHub, GitHubError } = await import("../src/github.ts");
  const client = new GitHub("ghp_test");
  gh.createBare("kevin", "ticketed");
  gh.seedSubIssues(
    "kevin",
    "ticketed",
    { number: 7, title: "The spec", body: "Do things in order.", html_url: "https://github.com/kevin/ticketed/issues/7" },
    [
      { number: 8, title: "A", body: "a" },
      { number: 9, title: "B", body: "b", blockedBy: [8] },
      { number: 10, title: "C", body: "c", blockedBy: [9, 11] }, // 11 is not a sub-issue of this spec
      { number: 12, title: "D", body: "d", state: "CLOSED" }, // already solved
    ],
  );
  const seed = await client.listTicketSubIssues("kevin", "ticketed", 7);
  assert.deepEqual(seed.spec, { number: 7, title: "The spec", body: "Do things in order.", htmlUrl: "https://github.com/kevin/ticketed/issues/7", hasParent: false });
  assert.deepEqual(
    seed.subIssues.map((s) => [s.number, s.title, s.blockedBy]),
    [
      [8, "A", []],
      [9, "B", [8]],
      [10, "C", [9]], // the edge to 11 is dropped, so the ticket can still start
    ],
  );
  // A spec with no sub-issues, or no seed at all, is a 404.
  gh.seedSubIssues("kevin", "empty", { number: 3, title: "No tickets", body: "", html_url: "https://github.com/kevin/empty/issues/3" }, []);
  gh.createBare("kevin", "empty");
  assert.equal((await client.listTicketSubIssues("kevin", "empty", 3)).subIssues.length, 0);
  await assert.rejects(client.listTicketSubIssues("kevin", "ticketed", 99), (e) => e instanceof GitHubError && e.status === 404);
  // ticketsFromIssueRef reads the owner/name#123 form and the issue URL, and rejects a ref with no repo.
  assert.equal((await client.ticketsFromIssueRef("kevin/ticketed#7")).spec.number, 7);
  assert.equal((await client.ticketsFromIssueRef("https://github.com/kevin/ticketed/issues/7")).spec.number, 7);
  await assert.rejects(client.ticketsFromIssueRef("ticketed#7"), (e) => e instanceof GitHubError && e.status === 400);
  await assert.rejects(client.ticketsFromIssueRef("#7"), (e) => e instanceof GitHubError && e.status === 400);
  // A bad token keeps the REST client's error shape on GraphQL calls too.
  await assert.rejects(new GitHub("nope").listTicketSubIssues("kevin", "ticketed", 7), (e) => e instanceof GitHubError && e.status === 401 && /Bad credentials/.test(e.message));
});

test("issueStates reads issues in one batched call; a number that does not resolve falls back to one read per number", async () => {
  const { GitHub } = await import("../src/github.ts");
  const client = new GitHub("ghp_test");
  gh.createBare("kevin", "state-app");
  // Feed issue #1 (open), spec #5 with one open and one not-planned-closed sub-issue; #8 does not exist.
  gh.seedSubIssues(
    "kevin",
    "state-app",
    { number: 5, title: "Spec five", body: "x", html_url: "https://github.com/kevin/state-app/issues/5" },
    [
      { number: 6, title: "Six", body: "s" },
      { number: 7, title: "Seven", body: "s", state: "CLOSED", state_reason: "NOT_PLANNED" },
    ],
  );
  const before = gh.graphqlCalls;
  const states = await client.issueStates("kevin", "state-app", [5, 1, 8, 6]);
  assert.equal(gh.graphqlCalls - before, 5, "the batch plus one read per number");
  assert.equal(states.get(5)?.state, "OPEN");
  assert.equal(states.get(5)?.title, "Spec five");
  assert.equal(states.get(5)?.url, "https://github.com/kevin/state-app/issues/5");
  assert.deepEqual(states.get(5)?.subIssues, [
    { number: 6, state: "OPEN", stateReason: null },
    { number: 7, state: "CLOSED", stateReason: "NOT_PLANNED" },
  ]);
  assert.equal(states.get(1)?.state, "OPEN", "a plain feed issue resolves in the batch too");
  assert.deepEqual(states.get(1)?.subIssues, []);
  assert.equal(states.get(6)?.state, "OPEN", "a sub-issue resolves in the batch too");
  assert.deepEqual(states.get(6)?.subIssues, []);
  assert.equal(states.get(8), null, "a number that does not resolve is null");
  assert.ok(states.has(8));
  // Every number resolves: one call only.
  const clean = gh.graphqlCalls;
  const again = await client.issueStates("kevin", "state-app", [5, 1]);
  assert.equal(gh.graphqlCalls - clean, 1, "one batched call when every number resolves");
  assert.equal(again.get(5)?.state, "OPEN");
  assert.equal(again.get(1)?.state, "OPEN");
  assert.deepEqual(await client.issueStates("kevin", "state-app", []), new Map());
});

test("closeIssue sends a state reason, and issueStates reads it back", async () => {
  const { GitHub } = await import("../src/github.ts");
  const client = new GitHub("ghp_test");
  gh.createBare("kevin", "reason-app");
  const closed = await client.closeIssue("kevin", "reason-app", 2, "not planned");
  assert.equal(closed.state, "closed");
  assert.equal(gh.issues.find((i) => i.owner === "kevin" && i.name === "reason-app" && i.number === 2)?.state_reason, "not planned", "the mock records the reason on the issue");
  const entry = gh.closed.find((c) => c.ref === "kevin/reason-app#2");
  assert.equal(entry?.reason, "not planned", "the close record carries the reason");
  assert.equal((await client.issueStates("kevin", "reason-app", [2])).get(2)?.stateReason, "not planned");
  // A close without a reason keeps no state reason.
  await client.closeIssue("kevin", "reason-app", 1);
  assert.equal(gh.issues.find((i) => i.owner === "kevin" && i.name === "reason-app" && i.number === 1)?.state_reason, undefined);
  assert.equal((await client.issueStates("kevin", "reason-app", [1])).get(1)?.stateReason, null);
});

test("a bad token surfaces GitHub's message", async () => {
  const { GitHub, GitHubError } = await import("../src/github.ts");
  await assert.rejects(new GitHub("nope").user(), (e: any) => e instanceof GitHubError && e.status === 401 && /Bad credentials/.test(e.message));
  assert.throws(() => new GitHub(undefined), /GITHUB_TOKEN/);
});

// --- the repo's recorded agent-skills setup state ----------------------------------------------

const addLocalRepo = async (db: any, name: string) => {
  const { addRepo } = await import("../src/repos.ts");
  return addRepo(db, { owner: "kevin", name, defaultBranch: "main", private: true }, env);
};

test("adding a repo whose default branch carries the setup marker records it as set up", async () => {
  const { openDb } = await import("../src/db.ts");
  const { config, SETUP_MARKER } = await import("../src/config.ts");
  const { recordedSetupState } = await import("../src/repos.ts");
  const db = openDb(config.dbFile);
  gh.createBare("kevin", "setup-set", { [SETUP_MARKER]: "# Issue tracker\n\nGitHub Issues.\n" });

  const repo = await addLocalRepo(db, "setup-set");

  assert.equal(recordedSetupState(db, repo.id), "set_up");
});

test("adding a repo without the setup marker records it as not set up, and starts no session", async () => {
  const { openDb } = await import("../src/db.ts");
  const { config } = await import("../src/config.ts");
  const { recordedSetupState } = await import("../src/repos.ts");
  const db = openDb(config.dbFile);
  gh.createBare("kevin", "setup-missing");

  const repo = await addLocalRepo(db, "setup-missing");

  assert.equal(recordedSetupState(db, repo.id), "not_set_up");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE repo_id = ?").get(repo.id) as { n: number }).n, 0, "this ticket starts no setup session");
});

test("the recorded setup state answers later reads with no git check", async () => {
  const { openDb } = await import("../src/db.ts");
  const { config, SETUP_MARKER } = await import("../src/config.ts");
  const { clonePath, getRepo, recordedSetupState, repoSetupState } = await import("../src/repos.ts");
  const db = openDb(config.dbFile);
  gh.createBare("kevin", "setup-cached", { [SETUP_MARKER]: "# Issue tracker\n\nGitHub Issues.\n" });
  const added = await addLocalRepo(db, "setup-cached");
  assert.equal(recordedSetupState(db, added.id), "set_up");
  // The clone is gone, so git cannot answer at all: only the record can. A git check would answer
  // "not_set_up" here and overwrite the record.
  const repo = getRepo(db, "kevin/setup-cached")!;
  fs.rmSync(clonePath(repo), { recursive: true, force: true });

  assert.equal(await repoSetupState(db, repo), "set_up");
  assert.equal(recordedSetupState(db, repo.id), "set_up", "the read left the record alone");
});

test("a repo added before this record existed gets one marker check, which records what it finds", async () => {
  const { openDb } = await import("../src/db.ts");
  const { config, SETUP_MARKER } = await import("../src/config.ts");
  const { recordedSetupState, repoSetupState } = await import("../src/repos.ts");
  const db = openDb(config.dbFile);
  gh.createBare("kevin", "setup-old-set", { [SETUP_MARKER]: "# Issue tracker\n\nGitHub Issues.\n" });
  gh.createBare("kevin", "setup-old-missing");
  const withMarker = await addLocalRepo(db, "setup-old-set");
  const withoutMarker = await addLocalRepo(db, "setup-old-missing");
  // Their rows as they were before the record existed: nothing recorded.
  db.prepare("UPDATE repos SET setup_state = NULL WHERE id IN (?, ?)").run(withMarker.id, withoutMarker.id);

  assert.equal(await repoSetupState(db, withMarker), "set_up");
  assert.equal(recordedSetupState(db, withMarker.id), "set_up", "the check recorded what it found");
  assert.equal(await repoSetupState(db, withoutMarker), "not_set_up");
  assert.equal(recordedSetupState(db, withoutMarker.id), "not_set_up", "the check recorded what it found");
});

test("an older repos table gains the setup_state column on open", async () => {
  const { openDb } = await import("../src/db.ts");
  const { recordedSetupState } = await import("../src/repos.ts");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wb-migrate-")), "workbench.db");
  // The repos table as it was before this record: no setup_state, one repo in it.
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE repos (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, default_branch TEXT NOT NULL, private INTEGER NOT NULL DEFAULT 1, added_at INTEGER NOT NULL);");
  old.prepare("INSERT INTO repos (id, owner, name, default_branch, private, added_at) VALUES ('me/old','me','old','main',1,0)").run();
  old.close();

  const db = openDb(file);

  const cols = (db.prepare("PRAGMA table_info(repos)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("setup_state"), `repos gained ${cols.join(", ")}`);
  assert.equal(recordedSetupState(db, "me/old"), null, "a repo from before the record has no recorded state");
});

/** Take `file` off a local remote's default branch, as a repo loses it. */
const dropFromRemote = (name: string, file: string) => {
  const work = fs.mkdtempSync(path.join(remotes, ".edit-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: work });
  execFileSync("git", ["clone", "-q", path.join(remotes, "kevin", `${name}.git`), work]);
  fs.rmSync(path.join(work, file));
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `Remove ${file}`);
  git("push", "-q", "origin", "main");
  fs.rmSync(work, { recursive: true, force: true });
};

test("re-adding a repo already recorded as set up keeps it set up when git no longer sees the marker", async () => {
  const { openDb } = await import("../src/db.ts");
  const { config, SETUP_MARKER } = await import("../src/config.ts");
  const { recordedSetupState, repoNeedsSetup, repoSetupState } = await import("../src/repos.ts");
  const db = openDb(config.dbFile);
  gh.createBare("kevin", "setup-keep", { [SETUP_MARKER]: "# Issue tracker\n\nGitHub Issues.\n" });
  const added = await addLocalRepo(db, "setup-keep");
  assert.equal(recordedSetupState(db, added.id), "set_up");
  // The marker goes off the default branch: git now says the repo needs setup, and the record says it does not.
  dropFromRemote("setup-keep", SETUP_MARKER);
  const repo = await addLocalRepo(db, "setup-keep");

  assert.equal(await repoNeedsSetup(repo), true, "git now reads the marker as gone");
  assert.equal(recordedSetupState(db, repo.id), "set_up", "the record is not downgraded, so setup never runs twice");
  assert.equal(await repoSetupState(db, repo), "set_up");
});
