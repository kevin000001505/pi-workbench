/**
 * A card the board load sees merged on GitHub is delivered, as Approve delivers it:
 * SessionManager.reconcile is the one entry point for the GitHub checks on a board load.
 * Drives the real server (main.ts) on an ephemeral port, with a real `pi --mode rpc` against
 * the scripted mock model and the mock GitHub. Skips when the pi CLI isn't available.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { startReviewServer } from "./review-server.ts";

const { hasPi, base, gh, api, board, summary, waitFor, toReview, hasRef, bare } = await startReviewServer("reconcile");

/**
 * Someone else changes the base branch on GitHub: a commit appends `line` to `file`.
 */
function pushToBase(line: string, file = "work.txt", baseBranch = "main") {
  const clone = fs.mkdtempSync(path.join(process.env.DATA_DIR!, "other-"));
  execFileSync("git", ["clone", "-q", "-b", baseBranch, bare, clone]);
  fs.appendFileSync(path.join(clone, file), `${line}\n`);
  const sh = (...args: string[]) => execFileSync("git", ["-c", "user.name=other", "-c", "user.email=other@x", ...args], { cwd: clone }).toString().trim();
  sh("add", file);
  sh("commit", "-qm", `Change ${file} on the base branch`);
  sh("push", "-q", "origin", baseBranch);
  return sh("rev-parse", "HEAD");
}

const approve = (id: string) => api("POST", `/api/sessions/${id}/approve`, {});

/** The board events a WebSocket client hears, from now on. */
async function boardEvents() {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
  const seen: string[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "wb_board") seen.push(msg.repoId);
  });
  await new Promise((r) => ws.once("open", r));
  return { seen, close: () => ws.close() };
}

/** Merge a PR directly on GitHub (not through Approve), through the mock's merge endpoint. */
async function handMerge(pr: any) {
  const res = await fetch(`${gh.url}/repos/kevin/ship/pulls/${pr.number}/merge`, {
    method: "PUT",
    headers: { authorization: "Bearer ghp_test", "Content-Type": "application/json" },
    body: JSON.stringify({ merge_method: "merge" }),
  });
  assert.equal(res.status, 200, `hand merge: ${await res.text()}`);
}

test("a PR merged on GitHub delivers the card on the next board load, as Approve does", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(7);
  const events = await boardEvents();
  await handMerge(pr);
  // The board load reads the merge and delivers the card.
  const done = (await board()).find((c) => c.id === id)!;
  assert.equal(done.column, "done");
  assert.equal(done.pr.state, "merged", "the card's badge says merged");
  assert.ok(!hasRef(`refs/heads/${branch}`), "the branch is deleted");
  assert.ok(!fs.existsSync(worktree), "the worktree is removed");
  assert.equal(done.specCard, true, "a started card's row comes from its session's tickets");
  // The closed issues are recorded as Approve records them: in the card's row, not flat cards.
  assert.ok(!(await board()).some((c) => c.id === "issue:7" || c.id === "issue:8"), "no flat cards for the issues the card closed");
  assert.ok(events.seen.includes("kevin/ship"), "a board event went out for the repo");
  // The hand merge closed the Closes issues itself.
  assert.deepEqual(gh.closed.filter((c) => /#[78]$/.test(c.ref)).map((c) => c.by), ["merge", "merge"]);
});

test("two overlapping board loads deliver a hand-merged card once", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(17);
  await handMerge(pr);
  const events = await boardEvents();
  await Promise.all([board(), board()]);
  const done = (await board()).find((c) => c.id === id)!;
  assert.equal(done.column, "done");
  assert.ok(!hasRef(`refs/heads/${branch}`), "the branch is deleted");
  assert.ok(!fs.existsSync(worktree), "the worktree is removed");
  // One delivery: one board event for the repo, and the issues closed by the hand merge alone.
  assert.equal(events.seen.filter((r) => r === "kevin/ship").length, 1);
  assert.deepEqual(gh.closed.filter((c) => /#1[78]$/.test(c.ref)).map((c) => c.by), ["merge", "merge"]);
});

test("a card whose PR state the board cannot read is not touched", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(27);
  await handMerge(pr); // the PR is merged on GitHub, but the board cannot read it
  gh.pullFailures = true;
  const card = (await board()).find((c) => c.id === id)!;
  assert.equal(card.column, "review");
  assert.equal(card.pr.state, null, "the badge cannot read the PR");
  assert.ok(hasRef(`refs/heads/${branch}`), "the branch stays");
  assert.ok(fs.existsSync(worktree), "the worktree stays");
  gh.pullFailures = false;
  // The next board load reads the merge and delivers the card.
  assert.equal((await board()).find((c) => c.id === id)?.column, "done");
});

test("a card whose merge run is in flight is not delivered by a board load", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(37);
  // Approve finds a conflict and starts a merge run (the HOLDMERGE word makes it wait on a question).
  pushToBase("HOLDMERGE: main changed this line");
  const started = await approve(id);
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.match(started.json.activeRun, /-merge-/);
  await waitFor(async () => (await summary(id)).pending.some((p: any) => p.kind === "decision"), 120_000);
  // The PR merges on GitHub while the merge run waits.
  pr.merged = true;
  const card = (await board()).find((c) => c.id === id)!;
  assert.equal(card.column, "review", "the card is left to its merge run");
  assert.ok(hasRef(`refs/heads/${branch}`), "the branch stays");
  assert.ok(fs.existsSync(worktree), "the worktree stays");
});

test("a card whose Approve is in flight is not delivered twice by a board load", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, worktree, branch } = await toReview(47, "develop");
  // A slow PR read and a slow issue close hold the board load's reconcile inside Approve's delivery.
  gh.slowMs = 400;
  const [a] = await Promise.all([approve(id), board()]);
  gh.slowMs = 0;
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.phase, "done");
  // develop ignores Closes: the workbench closed the issues; a second delivery would close them again.
  assert.deepEqual(gh.closed.filter((c) => /#4[78]$/.test(c.ref)).map((c) => c.by), ["api", "api"]);
  assert.ok(!hasRef(`refs/heads/${branch}`), "the branch is deleted");
  assert.ok(!fs.existsSync(worktree), "the worktree is removed");
});

test("issues the delivery closes during a board load are not Issues cards in the same response", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr } = await toReview(57, "develop");
  await handMerge(pr); // develop ignores Closes: the issues stay open when the board reads them
  const cards = await board();
  assert.equal(cards.find((c) => c.id === id)?.column, "done");
  // The issues were open in this load's read and closed by it: they are not unclaimed cards here.
  assert.ok(!cards.some((c) => c.id === "issue:57" || c.id === "issue:58"), JSON.stringify(cards.map((c: any) => c.id)));
  // And the workbench closed them, once each.
  assert.deepEqual(gh.closed.filter((c) => /#5[78]$/.test(c.ref)).map((c) => c.by), ["api", "api"]);
});

/** The spec issues the board watches for a repo, read straight from the spec_watch table. */
function watchedSpecs(repoId: string) {
  const db = new DatabaseSync(path.join(process.env.DATA_DIR!, "workbench.db"), { readOnly: true });
  return (db.prepare("SELECT number FROM spec_watch WHERE repo_id = ?").all(repoId) as { number: number }[]).map((r) => r.number);
}

test("unclaimed spec cards enter the spec watch list; a claim leaves it", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.seedSubIssues("kevin", "ship", { number: 90, title: "Watched", body: "## Solution\nwatch.txt says Watched." }, [{ number: 91, title: "Write watch.txt", body: "x" }]);
  await board(); // the board load shows the unclaimed spec card and watches the spec
  assert.ok(watchedSpecs("kevin/ship").includes(90), `watched: ${watchedSpecs("kevin/ship")}`);
  // A claim leaves the watch list: the move to To do creates the session.
  const r = await api("POST", "/api/repos/kevin/ship/issues/90/move", { column: "todo" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(!watchedSpecs("kevin/ship").includes(90), `watched: ${watchedSpecs("kevin/ship")}`);
});
