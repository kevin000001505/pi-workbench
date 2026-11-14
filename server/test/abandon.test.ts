/**
 * Abandon over HTTP: a card's runs stop, its PR closes, its branch and worktree go, and the card
 * leaves the board, while its GitHub issues stay open. Pipeline cards and direct cards alike.
 * Drives the real server (main.ts) on an ephemeral port, with a real `pi --mode rpc` against the
 * scripted mock model and the mock GitHub. Skips when the pi CLI isn't available.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { startReviewServer } from "./review-server.ts";

const { hasPi, tmp, base, gh, api, waitFor, summary, board, hasRef, toReview, setup } = await startReviewServer("abandon");

const abandon = (id: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/sessions/${id}/abandon`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => null)) as any }));

/** The board events (repo ids) and removed sessions a WebSocket client hears, from now on. */
async function boardEvents() {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
  const seen: string[] = [];
  const removed: string[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "wb_board") seen.push(msg.repoId);
    if (msg.type === "removed") removed.push(msg.id);
  });
  await new Promise((r) => ws.once("open", r));
  return { seen, removed, close: () => ws.close() };
}

/** A repo of its own, so a direct card's branch, PR and worktree are only its own. */
async function directRepo(name: string) {
  await setup();
  // A repo already set up for the agent skills: its card's session is the only session on it.
  gh.createBare("kevin", name, { setup: true });
  assert.equal((await api("POST", "/api/repos", { id: `kevin/${name}` })).status, 200);
  return `kevin/${name}`;
}

/** A bare repo's own git: the refs a mock GitHub write leaves behind. */
function gitOf(repoId: string) {
  const bare = path.join(tmp, "remotes", ...repoId.split("/")) + ".git";
  return {
    sh: (...args: string[]) => spawnSync("git", args, { cwd: bare, stdio: "pipe" }).stdout.toString().trim(),
    hasRef: (ref: string) => spawnSync("git", ["rev-parse", "--verify", "-q", ref], { cwd: bare, stdio: "pipe" }).status === 0,
  };
}

/** A direct session with its PR recorded: its card is in Review, its branch is on GitHub. */
async function directToReview(repoId: string, title: string, opts: { issueRef?: string; workLine?: string } = {}) {
  const d = (await api("POST", "/api/sessions", {
    repoId,
    title,
    prompt: "say hello",
    mode: "direct",
    ...(opts.issueRef ? { issueRef: opts.issueRef } : {}),
  })).json;
  assert.ok(d.id, JSON.stringify(d));
  // A repo already set up starts a direct session past setup, so its branch needs its own commit
  // before a PR can open: its line in work.txt. A base branch that adds a line there conflicts with it.
  await waitFor(async () => (await summary(d.id)).phase === "direct", 120_000);
  const worktree = path.join(process.env.DATA_DIR!, "worktrees", d.id);
  const sh = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@x", ...args], { cwd: worktree, stdio: "pipe" });
  fs.writeFileSync(path.join(worktree, "work.txt"), `${opts.workLine ?? "note the work"}\n`);
  sh("add", "work.txt");
  sh("commit", "-qm", "Note the work");
  const pr = await api("POST", `/api/sessions/${d.id}/pr`, { title, body: "## Summary\n- docs/agents/issue-tracker.md" });
  assert.equal(pr.status, 200, JSON.stringify(pr.json));
  const card = await waitFor(async () => (await board(repoId)).find((c) => c.id === d.id && c.column === "review"), 120_000);
  return {
    id: d.id as string,
    pr: gh.pulls.find((p) => p.number === card.pr.number),
    worktree,
    branch: (await summary(d.id)).branch as string,
  };
}

/** Someone else changes the repo's base branch: a commit puts `line` in work.txt on main. */
function pushToBase(repoId: string, line: string) {
  const bare = path.join(tmp, "remotes", ...repoId.split("/")) + ".git";
  const clone = fs.mkdtempSync(path.join(tmp, "other-"));
  spawnSync("git", ["clone", "-q", "-b", "main", bare, clone], { stdio: "pipe" });
  fs.appendFileSync(path.join(clone, "work.txt"), `${line}\n`);
  const sh = (...args: string[]) => spawnSync("git", ["-c", "user.name=other", "-c", "user.email=other@x", ...args], { cwd: clone, stdio: "pipe" });
  sh("add", "work.txt");
  sh("commit", "-qm", "Change work.txt on the base branch");
  sh("push", "-q", "origin", "main");
}

test("Abandon closes the PR, deletes the branch, the worktree and the card, and its spec issue shows in Issues again", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(7);
  assert.ok(hasRef(`refs/heads/${branch}`));
  assert.ok(fs.existsSync(worktree));
  assert.ok(!(await board()).some((c) => c.id === "issue:7"), "a claimed spec issue is not an unclaimed card");

  // A request from another site is refused, and changes nothing.
  assert.equal((await abandon(id, { Origin: "http://evil.example" })).status, 403);
  assert.ok((await board()).some((c) => c.id === id));
  assert.equal(pr.state, undefined);

  const events = await boardEvents();
  const r = await abandon(id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(pr.state, "closed", "the PR is closed");
  assert.ok(!pr.merged, "the PR is not merged");
  assert.ok(!hasRef(`refs/heads/${branch}`), "the remote branch is deleted");
  assert.ok(!fs.existsSync(worktree), "the worktree is removed");
  assert.deepEqual(gh.closed, [], "the issues stay open");
  assert.equal((await api("GET", `/api/sessions/${id}`)).status, 404, "the session is deleted");
  assert.ok(!(await api("GET", "/api/sessions")).json.some((s: any) => s.id === id));
  const cards = await board();
  assert.ok(!cards.some((c) => c.id === id), "the card is off the board");
  assert.deepEqual(cards.find((c) => c.id === "issue:7"), { id: "issue:7", title: "Spec 7", column: "issues", tickets: { done: 0, total: 1 }, attention: null, pr: null, specRef: "https://github.com/kevin/ship/issues/7", doneAt: null, specCard: true, subs: null });
  await waitFor(() => events.seen.includes("kevin/ship"), 5_000);
  await waitFor(() => events.removed.includes(id), 5_000);
  events.close();

  assert.equal((await abandon(id)).status, 404, "an abandoned card is gone");
});

test("Abandon stops a running card that has no PR and no branch on GitHub", { skip: !hasPi && "pi CLI not found" }, async () => {
  await setup();
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/ship", title: "Drop me", prompt: "add a farewell" })).json;
  const worktree = path.join(process.env.DATA_DIR!, "worktrees", s.id);
  // The grill waits on its first question: the run is live.
  await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "decision"));
  const pulls = gh.pulls.length;
  const r = await abandon(s.id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(gh.pulls.length, pulls);
  assert.ok(!fs.existsSync(worktree));
  assert.equal((await api("GET", `/api/sessions/${s.id}`)).status, 404);
  assert.ok(!(await board()).some((c) => c.id === s.id));
});

test("Abandon takes a Done card off the board and leaves its merged PR alone", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr } = await toReview(27);
  const ok = await api("POST", `/api/sessions/${id}/approve`, {});
  assert.equal(ok.json?.phase, "done", JSON.stringify(ok.json));
  const r = await abandon(id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(pr.merged, true);
  assert.equal(pr.state, undefined, "a merged PR is not closed again");
  assert.ok(!(await board()).some((c) => c.id === id));
});

test("Abandon on a direct card in Review closes its PR unmerged, deletes its branch and worktree, and takes its card off the board", { skip: !hasPi && "pi CLI not found" }, async () => {
  const repo = await directRepo("directdrop");
  const git = gitOf(repo);
  const { id, pr, worktree, branch } = await directToReview(repo, "Drop the quick fix", { issueRef: `kevin/directdrop#1` });
  assert.ok(git.hasRef(`refs/heads/${branch}`), "the branch is on GitHub");
  assert.ok(fs.existsSync(worktree), "the worktree is on disk");
  const closedBefore = gh.closed.length;

  const events = await boardEvents();
  const before = events.seen.length;
  const r = await abandon(id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(pr.state, "closed", "the PR is closed");
  assert.ok(!pr.merged, "the PR is not merged");
  assert.ok(!git.hasRef(`refs/heads/${branch}`), "the remote branch is deleted");
  assert.ok(!fs.existsSync(worktree), "the worktree is removed");
  assert.deepEqual(gh.closed.slice(closedBefore), [], "the issue it named stays open");

  // The session and its card are gone; the issue it talked about is still its own card.
  assert.equal((await api("GET", `/api/sessions/${id}`)).status, 404, "the session is deleted");
  assert.ok(!(await api("GET", "/api/sessions")).json.some((s: any) => s.id === id));
  const cards = await board(repo);
  assert.ok(!cards.some((c) => c.id === id), "the card is off the board");
  assert.ok(cards.some((c) => c.id === "issue:1"), "issue #1 is still an unclaimed card");

  // Open boards of the repo hear the board event, so they fetch the board again.
  await waitFor(() => events.seen.slice(before).includes(repo), 5_000);
  await waitFor(() => events.removed.includes(id), 5_000);
  events.close();

  assert.equal((await abandon(id)).status, 404, "an abandoned card is gone");
});

test("Abandon on a direct card with no PR stops its run, opens no PR, and takes its card off the board", { skip: !hasPi && "pi CLI not found" }, async () => {
  const repo = await directRepo("directnorun");
  const s = (await api("POST", "/api/sessions", { repoId: repo, title: "Drop the question", prompt: "ask which database", mode: "direct" })).json;
  const worktree = path.join(process.env.DATA_DIR!, "worktrees", s.id);
  // The task's ask_user keeps the run live: the card is in Doing with a question waiting.
  const pending = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "decision"), 120_000);
  assert.equal((await summary(s.id)).status, "waiting", "its run is live, waiting on the question");
  assert.equal((await board(repo)).find((c) => c.id === s.id)?.column, "doing");
  const pulls = gh.pulls.length;

  const events = await boardEvents();
  const before = events.seen.length;
  const r = await abandon(s.id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(gh.pulls.length, pulls, "no PR was opened for it");
  assert.ok(!fs.existsSync(worktree), "the worktree is removed");
  assert.equal((await api("GET", `/api/sessions/${s.id}`)).status, 404, "the session is deleted");
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: pending.id, value: pending.options[0] })).status, 409, "its run is stopped: its question is no longer answerable");
  assert.ok(!(await board(repo)).some((c) => c.id === s.id), "the card is off the board");
  await waitFor(() => events.seen.slice(before).includes(repo), 5_000);
  await waitFor(() => events.removed.includes(s.id), 5_000);
  events.close();
});

test("Abandon on a direct card whose merge run is live stops that run, closes its PR unmerged, and removes the half-done merge with the worktree", { skip: !hasPi && "pi CLI not found" }, async () => {
  const repo = await directRepo("directmerging");
  const git = gitOf(repo);
  const { id, pr, worktree, branch } = await directToReview(repo, "Half-done merge", { workLine: "direct was here" });
  pushToBase(repo, "HOLDMERGE: main changed this line");
  const mainSha = git.sh("rev-parse", "refs/heads/main");

  // Approve stops on the conflict and hands it to a merge run, which waits on its question.
  const r = await api("POST", `/api/sessions/${id}/approve`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.activeRun, new RegExp(`^${id}-merge-[a-z0-9]+$`), "the merge run is live");
  await waitFor(async () => (await summary(id)).pending.find((p: any) => p.kind === "decision"), 120_000);
  assert.equal(spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: worktree, stdio: "pipe" }).status, 0, "the merge is half done in the worktree");
  assert.ok(!pr.merged);

  // Abandon is the card's only way out of Review while its merge run works.
  const res = await abandon(id);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(pr.state, "closed", "the PR is closed");
  assert.ok(!pr.merged, "the half-done merge is not merged");
  assert.ok(!fs.existsSync(worktree), "the worktree and its half-done merge are gone");
  assert.ok(!git.hasRef(`refs/heads/${branch}`), "the branch is deleted, and nothing was pushed to it");
  assert.equal(git.sh("rev-parse", "refs/heads/main"), mainSha, "nothing was merged into the base branch");
  assert.equal((await api("GET", `/api/sessions/${id}`)).status, 404, "the session is deleted");
  assert.ok(!(await board(repo)).some((c) => c.id === id), "the card is off the board");
});

test("Abandon on a direct card in Done leaves its merged PR alone and takes its card off the board", { skip: !hasPi && "pi CLI not found" }, async () => {
  const repo = await directRepo("directmerged");
  const git = gitOf(repo);
  const { id, pr, branch } = await directToReview(repo, "Merged quick fix");
  const done = await api("POST", `/api/sessions/${id}/approve`, {});
  assert.equal(done.json?.phase, "done", JSON.stringify(done.json));
  assert.ok(pr.merged, "Approve merged the PR");
  const mainTip = git.sh("rev-parse", "refs/heads/main");

  const r = await abandon(id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(pr.merged, true, "the merged PR stays merged");
  assert.equal(pr.state, undefined, "a merged PR is not closed again");
  assert.equal(git.sh("rev-parse", "refs/heads/main"), mainTip, "the merge commit stays on the base branch");
  assert.ok(!git.hasRef(`refs/heads/${branch}`), "the merged card's branch stays deleted");
  assert.ok(!(await board(repo)).some((c) => c.id === id), "the card is off the board");
});

