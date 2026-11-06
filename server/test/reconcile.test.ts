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

const { hasPi, base, gh, api, board, summary, waitFor, toReview, hasRef, bare, setup } = await startReviewServer("reconcile");

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

// --- a spec issue closed by hand on GitHub -----------------------------------------------------

/** Close an issue on the mock the way a user would from GitHub's UI: a PATCH without a state reason. */
async function handClose(number: number) {
  const res = await fetch(`${gh.url}/repos/kevin/ship/issues/${number}`, {
    method: "PATCH",
    headers: { authorization: "Bearer ghp_test", "Content-Type": "application/json" },
    body: JSON.stringify({ state: "closed" }),
  });
  assert.equal(res.status, 200, `hand close of #${number}: ${await res.text()}`);
}

/** The done-issue records of a repo, read straight from the issues_done table. */
function issuesDone(repoId: string) {
  const db = new DatabaseSync(path.join(process.env.DATA_DIR!, "workbench.db"), { readOnly: true });
  const rows = db.prepare("SELECT number, title, parent, session_id, not_planned FROM issues_done WHERE repo_id = ?").all(repoId) as { number: number; title: string; parent: number | null; session_id: string | null; not_planned: number }[];
  db.close();
  return rows.map((r) => ({ number: r.number, title: r.title, parent: r.parent, sessionId: r.session_id, notPlanned: !!r.not_planned }));
}

/**
 * A card started from a spec's ticket issues, held in Doing with its ticket run waiting on a push
 * permission: the card is in `doing` with a running ticket and no PR.
 */
async function toDoing(spec: number) {
  gh.seedSubIssues("kevin", "ship", { number: spec, title: `Spec ${spec}`, body: "## Solution\nd.txt says D." }, [
    { number: spec + 1, title: "Write d.txt", body: "Create d.txt containing D. PUSHME" },
  ]);
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/ship", title: `Spec ${spec}`, issueRef: `kevin/ship#${spec}`, mode: "pipeline", startFrom: "tickets" })).json;
  assert.ok(s.id, JSON.stringify(s));
  const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"), 120_000);
  assert.equal((await board()).find((c) => c.id === s.id)?.column, "doing", "the card is in Doing with its ticket run pending");
  return { id: s.id as string, worktree: path.join(process.env.DATA_DIR!, "worktrees", s.id), branch: (await summary(s.id)).branch as string };
}

test("a spec closed by hand on GitHub stops its started card and moves it to Done at the next board load", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, worktree } = await toDoing(75);
  const events = await boardEvents();
  await handClose(75);
  const cards = await board();
  const card = cards.find((c) => c.id === id)!;
  assert.equal(card.column, "done");
  assert.equal(card.specCard, true);
  assert.equal(card.attention, "The spec issue #75 was closed on GitHub.");
  assert.ok(!fs.existsSync(worktree), "the worktree is removed");
  // The run stops; a ticket the stopped run left running is ready again, and the solo ticket goes.
  const sm = await summary(id);
  assert.equal(sm.status, "stopped");
  assert.equal(sm.tickets[0].status, "ready");
  assert.equal(sm.soloTicket, null);
  // The spec's open sub-issue closes on GitHub as not planned.
  assert.deepEqual(gh.closed.filter((c) => c.ref === "kevin/ship#76").map((c) => [c.by, c.reason]), [["api", "not planned"]]);
  // The spec (no parent) and its sub-issues (the spec as parent) are recorded in Done with the card's session id.
  assert.deepEqual(issuesDone("kevin/ship").filter((i) => i.number === 75).map((i) => [i.sessionId, i.parent, i.notPlanned]), [[id, null, false]]);
  assert.deepEqual(issuesDone("kevin/ship").filter((i) => i.number === 76).map((i) => [i.sessionId, i.parent, i.notPlanned]), [[id, 75, true]]);
  // The closed spec is not an Issues card in the same load, and a board event went out.
  assert.ok(!cards.some((c) => c.id === "issue:75"), "no unclaimed card for the closed spec");
  assert.ok(events.seen.includes("kevin/ship"), "a board event went out for the repo");
});

test("a hand-closed spec keeps the card's branch and any open PR, and the note names the PR", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(85);
  const events = await boardEvents();
  await handClose(85);
  const card = (await board()).find((c) => c.id === id)!;
  assert.equal(card.column, "done");
  assert.ok(!pr.merged, "the PR is not merged");
  assert.ok(hasRef(`refs/heads/${branch}`), "the branch stays");
  assert.ok(!fs.existsSync(worktree), "the worktree is removed");
  assert.equal(card.attention, `The spec issue #85 was closed on GitHub, and PR #${pr.number} is still open on GitHub.`);
  // The spec's sub-issue (the card's only ticket, done) closed as not planned; the done ticket's record is not planned too.
  assert.deepEqual(gh.closed.filter((c) => c.ref === "kevin/ship#86").map((c) => [c.by, c.reason]), [["api", "not planned"]]);
  assert.deepEqual(issuesDone("kevin/ship").filter((i) => i.number === 86).map((i) => [i.sessionId, i.parent, i.notPlanned]), [[id, 85, true]]);
  assert.deepEqual(issuesDone("kevin/ship").filter((i) => i.number === 85).map((i) => [i.sessionId, i.parent, i.notPlanned]), [[id, null, false]]);
  assert.ok(events.seen.includes("kevin/ship"), "a board event went out for the repo");
});

test("a merged pr card whose Closes lines closed the spec is delivered, never treated as a hand close", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(95);
  await handMerge(pr); // the merge closes #95 and #96 through the Closes lines
  const card = (await board()).find((c) => c.id === id)!;
  assert.equal(card.column, "done");
  assert.equal(card.pr.state, "merged");
  assert.ok(!hasRef(`refs/heads/${branch}`), "the branch is deleted: the PR-merged rule delivered it");
  assert.ok(!fs.existsSync(worktree), "the worktree is removed");
  assert.equal(card.attention, null, "no hand-close note");
  assert.deepEqual(gh.closed.filter((c) => /#9[56]$/.test(c.ref)).map((c) => c.by), ["merge", "merge"]);
  assert.ok(!gh.closed.filter((c) => /#9[56]$/.test(c.ref)).some((c) => c.reason === "not planned"), "no issue closed as not planned");
});

test("a plain card whose issue closes by hand stays where it is", { skip: !hasPi && "pi CLI not found" }, async () => {
  // A plain card in QA: its review's `git push` waits on a permission, and the card's only ticket is its issue.
  const s = (await api("POST", "/api/repos/kevin/ship/issues/1/move", { column: "doing" })).json;
  assert.ok(s.id, JSON.stringify(s));
  const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"), 120_000);
  const qa = await waitFor(async () => (await board()).find((c) => c.id === s.id && c.column === "qa"), 120_000);
  assert.equal(qa.specCard, false, "the card's only ticket is its own issue");
  assert.deepEqual((await summary(s.id)).tickets.map((t: any) => [t.num, t.trackerRef, t.status]), [[1, "1", "done"]]);
  await handClose(1);
  const card = (await board()).find((c) => c.id === s.id)!;
  assert.equal(card.column, "qa", "a plain card whose issue closes by hand stays where it is");
  assert.ok((await summary(s.id)).pending.some((p: any) => p.kind === "permission"), "the review's permission is still pending");
  assert.equal(card.attention, null);
  await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("a board load whose open-issue list cannot be read stops no card", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, worktree } = await toDoing(105);
  await handClose(105);
  gh.issueFailures = true;
  const card = (await board()).find((c) => c.id === id)!;
  assert.equal(card.column, "doing", "the spec-closed rule is skipped when the open-issue list cannot be read");
  assert.ok(fs.existsSync(worktree), "the worktree stays");
  gh.issueFailures = false;
  assert.equal((await board()).find((c) => c.id === id)?.column, "done");
});

test("an unstarted spec card whose issue closes by hand moves to Done as one card with its sub-issues in subs", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.seedSubIssues("kevin", "ship", { number: 115, title: "Unstarted", body: "## Solution\nus.txt says US." }, [
    { number: 116, title: "Write us.txt", body: "Create us.txt containing US." },
    { number: 117, title: "Check us.txt", body: "Check it.", blockedBy: [116] },
  ]);
  // A second spec with one open sub-issue and two already closed: one closed as not planned on GitHub, one with no reason.
  gh.seedSubIssues("kevin", "ship", { number: 118, title: "Mixed", body: "## Solution\nm.txt says M." }, [
    { number: 119, title: "Write m.txt", body: "Create m.txt containing M." },
    { number: 120, title: "Drop m.txt", body: "Dropped.", state: "CLOSED", state_reason: "NOT_PLANNED" },
    { number: 121, title: "Solve m.txt", body: "Solved.", state: "CLOSED" },
  ]);
  await board(); // the board load shows the unclaimed spec cards and watches the specs
  assert.ok(watchedSpecs("kevin/ship").includes(115), `watched: ${watchedSpecs("kevin/ship")}`);
  assert.ok(watchedSpecs("kevin/ship").includes(118), `watched: ${watchedSpecs("kevin/ship")}`);
  await handClose(115);
  await handClose(118);
  const cards = await board();
  assert.ok(!cards.some((c) => c.id === "issue:115" && c.column === "issues"), "the closed spec is not an Issues card");
  const card = cards.find((c) => c.id === "issue:115")!;
  assert.equal(card.column, "done");
  assert.equal(card.specCard, true);
  assert.deepEqual(
    card.subs?.map((s: any) => [s.number, s.notPlanned, s.title]).sort((a: any, b: any) => a[0] - b[0]),
    [[116, true, "Write us.txt"], [117, true, "Check us.txt"]],
  );
  // The open sub-issues closed on GitHub as not planned, in sub-issue order.
  assert.deepEqual(gh.closed.filter((c) => /#11[67]$/.test(c.ref)).map((c) => [c.by, c.reason]), [["api", "not planned"], ["api", "not planned"]]);
  // The spec records with no parent and no session; its sub-issues nest under it as not planned.
  assert.deepEqual(issuesDone("kevin/ship").filter((i) => i.number === 115).map((i) => [i.parent, i.sessionId, i.notPlanned]), [[null, null, false]]);
  assert.deepEqual(issuesDone("kevin/ship").filter((i) => i.number === 116).map((i) => [i.parent, i.sessionId, i.notPlanned]), [[115, null, true]]);
  assert.ok(!watchedSpecs("kevin/ship").includes(115), "the spec leaves the watch list");

  // The mixed spec: the open sub-issue closes now as not planned; the two already-closed ones are recorded by their GitHub reason, not re-closed.
  const mixed = cards.find((c) => c.id === "issue:118")!;
  assert.equal(mixed.column, "done");
  assert.deepEqual(
    mixed.subs?.map((s: any) => [s.number, s.notPlanned]).sort((a: any, b: any) => a[0] - b[0]),
    [[119, true], [120, true], [121, false]],
  );
  assert.deepEqual(gh.closed.filter((c) => /#119$/.test(c.ref)).map((c) => [c.by, c.reason]), [["api", "not planned"]]);
  assert.ok(!gh.closed.some((c) => /#12[01]$/.test(c.ref)), "already-closed sub-issues are not closed again");
  assert.deepEqual(issuesDone("kevin/ship").filter((i) => i.number === 120).map((i) => [i.parent, i.sessionId, i.notPlanned]), [[118, null, true]]);
  assert.deepEqual(issuesDone("kevin/ship").filter((i) => i.number === 121).map((i) => [i.parent, i.sessionId, i.notPlanned]), [[118, null, false]]);
  assert.ok(!watchedSpecs("kevin/ship").includes(118), "the spec leaves the watch list");
});

test("a watched spec that no longer resolves leaves the watch list; an open one stays", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.seedSubIssues("kevin", "ship", { number: 125, title: "Gone", body: "x" }, [{ number: 126, title: "Do", body: "d" }]);
  gh.seedSubIssues("kevin", "ship", { number: 130, title: "Stays", body: "x" }, [{ number: 131, title: "Do", body: "d" }]);
  await board();
  assert.ok(watchedSpecs("kevin/ship").includes(125), `watched: ${watchedSpecs("kevin/ship")}`);
  assert.ok(watchedSpecs("kevin/ship").includes(130), "130 is watched too");
  gh.forgetSubIssues("kevin", "ship", 125); // the spec no longer resolves on GitHub
  await board();
  assert.ok(!watchedSpecs("kevin/ship").includes(125), "an issue that no longer resolves leaves the watch list");
  assert.ok(watchedSpecs("kevin/ship").includes(130), "an open spec stays on the watch list");
  assert.ok(!(await board()).some((c) => c.id === "issue:125"), "it is not a card anywhere: not open, not done");
});

test("a ticket issue closed by hand on GitHub changes nothing on its spec's card", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, worktree } = await toDoing(135);
  await handClose(136); // the spec's sub-issue, not the spec itself
  const card = (await board()).find((c) => c.id === id)!;
  assert.equal(card.column, "doing", "a hand-closed ticket issue changes nothing");
  assert.equal(card.attention, null);
  assert.ok(fs.existsSync(worktree), "the worktree stays");
  await api("POST", `/api/sessions/${id}/stop`, {});
});

// --- the spec watch list and the 100 most recently updated -------------------------------------

test("a watched spec that is still open but outside the 100 most recent stays watched", { skip: !hasPi && "pi CLI not found" }, async () => {
  // A repo of its own: the 100 bulk issues would push this file's other specs out of the window.
  await setup();
  gh.createBare("kevin", "other");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/other" })).status, 200);
  gh.seedSubIssues("kevin", "other", { number: 175, title: "Held", body: "## Solution\nh.txt says H." }, [
    { number: 176, title: "Write h.txt", body: "Create h.txt containing H." },
  ]);
  await board("kevin/other"); // the board load shows the unclaimed spec card and watches the spec
  assert.ok(watchedSpecs("kevin/other").includes(175), `watched: ${watchedSpecs("kevin/other")}`);
  // 100 issues newer than the spec: the spec falls out of the 100 most recently updated.
  gh.bulkSeedIssues("kevin", "other", 100, 300, "2026-01-01T00:00:00Z");
  const cards = await board("kevin/other");
  assert.ok(watchedSpecs("kevin/other").includes(175), "an open spec outside the 100 most recent stays watched");
  assert.ok(!cards.some((c) => c.id === "issue:175"), "the cap keeps it out of this response's open list");
  assert.ok(!issuesDone("kevin/other").some((i) => i.number === 175), "an open spec is not recorded done");
  assert.ok(!gh.closed.some((c) => /#176$/.test(c.ref)), "an open spec's sub-issues are not closed");
});

test("a spec issue a session claimed is never treated as an unstarted close after its card merges", { skip: !hasPi && "pi CLI not found" }, async () => {
  await setup();
  gh.seedSubIssues("kevin", "ship", { number: 180, title: "Claimed", body: "## Solution\nc.txt says C." }, [
    { number: 181, title: "Write c.txt", body: "Create c.txt containing C." },
  ]);
  await board(); // the board load shows the unclaimed spec card and watches the spec
  assert.ok(watchedSpecs("kevin/ship").includes(180), `watched: ${watchedSpecs("kevin/ship")}`);
  const { id } = await toReview(180); // the claim leaves the watch list, the card goes to Review
  assert.ok(!watchedSpecs("kevin/ship").includes(180), "a claim leaves the watch list");
  await approve(id); // the card merges: the spec and the ticket record in Done with the session id
  await handClose(180); // a hand close of the spec on GitHub after the merge
  await board(); // the next board load: the spec is not in the open list, but it is done, not unstarted
  assert.deepEqual(
    issuesDone("kevin/ship").filter((i) => i.number === 180).map((i) => [i.parent, i.sessionId, i.notPlanned]),
    [[null, id, false]],
    "the spec keeps its delivery record, never an unstarted-close record",
  );
  assert.deepEqual(
    issuesDone("kevin/ship").filter((i) => i.number === 181).map((i) => [i.parent, i.sessionId, i.notPlanned]),
    [[180, id, false]],
  );
  assert.deepEqual(
    gh.closed.filter((c) => /#181$/.test(c.ref)).map((c) => [c.by, c.reason ?? null]),
    [["merge", null]],
    "the ticket closes by the merge, never as not planned",
  );
  assert.ok(!watchedSpecs("kevin/ship").includes(180), "the merged spec is not re-watched");
});
