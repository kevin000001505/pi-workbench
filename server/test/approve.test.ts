/**
 * Approve over HTTP: a Review card's PR merges, its branch and worktree go, and the card moves to Done.
 * Drives the real server (main.ts) on an ephemeral port, with a real `pi --mode rpc` against the
 * scripted mock model and the mock GitHub. Skips when the pi CLI isn't available.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { startReviewServer } from "./review-server.ts";

const { hasPi, tmp, base, gh, api, waitFor, summary, board, columnOf, bare, hasRef, toReview, setup } = await startReviewServer("approve");

/**
 * Someone else changes the base branch on GitHub: a commit appends `line` to `file`. Every card's
 * ticket and review runs append to work.txt too, so a line there conflicts with the card's PR.
 * Returns the commit.
 */
function pushToBase(line: string, file = "work.txt", baseBranch = "main") {
  const clone = fs.mkdtempSync(path.join(tmp, "other-"));
  execFileSync("git", ["clone", "-q", "-b", baseBranch, bare, clone]);
  fs.appendFileSync(path.join(clone, file), `${line}\n`);
  const sh = (...args: string[]) => execFileSync("git", ["-c", "user.name=other", "-c", "user.email=other@x", ...args], { cwd: clone }).toString().trim();
  sh("add", file);
  sh("commit", "-qm", `Change ${file} on the base branch`);
  sh("push", "-q", "origin", baseBranch);
  return sh("rev-parse", "HEAD");
}

const approve = (id: string) => api("POST", `/api/sessions/${id}/approve`, {});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/*
 * Every merge-run word below (GIVEUP, NOFINISH, HOLDMERGE, ...) stays in main's work.txt, and the
 * mock reads the whole file, so a test that needs the plain keep-both resolve comes before them.
 */

test("Approve merges the PR with a merge commit, deletes the branch and the worktree, and the merge closes the issues", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(7);
  assert.ok(hasRef(`refs/heads/${branch}`), "the branch is on GitHub");
  assert.ok(fs.existsSync(worktree));

  // Branch protection refuses the merge: the card stays in Review with GitHub's message.
  pr.merge_refusal = 'Required status check "ci" is failing.';
  const refused = await approve(id);
  assert.equal(refused.status, 200, JSON.stringify(refused.json));
  assert.equal(refused.json.phase, "pr");
  assert.equal(refused.json.attention, 'GitHub refused the merge: Required status check "ci" is failing. Fix it on GitHub, then approve again.');
  const held = (await board()).find((c) => c.id === id);
  assert.equal(held.column, "review");
  assert.match(held.attention, /Required status check "ci" is failing/);
  assert.ok(!pr.merged);
  assert.ok(hasRef(`refs/heads/${branch}`), "a refused merge keeps the branch");
  assert.ok(fs.existsSync(worktree), "a refused merge keeps the worktree");

  delete pr.merge_refusal;
  // A double click merges once: the second Approve is refused while the first runs.
  const [ok, twice] = await Promise.all([approve(id), approve(id)]);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(twice.status, 409);
  assert.equal(ok.json.phase, "done");
  assert.equal(ok.json.attention, null);
  assert.equal((await summary(id)).attention, null);
  assert.equal(pr.merged, true);
  assert.equal(pr.merge_method, "merge");
  // A merge commit: the base branch's tip has two parents, and the branch's work is in it.
  assert.equal(execFileSync("git", ["rev-list", "--parents", "-n1", "refs/heads/main"], { cwd: bare }).toString().trim().split(" ").length, 3);
  assert.ok(!hasRef(`refs/heads/${branch}`), "the remote branch is deleted");
  assert.ok(!fs.existsSync(worktree), "the worktree is removed");
  // The PR merged into the default branch, so its `Closes` lines closed the issues on GitHub.
  assert.deepEqual(gh.closed.filter((c) => /#[78]$/.test(c.ref)).map((c) => c.by), ["merge", "merge"]);
  assert.deepEqual(gh.closed.map((c) => c.ref).sort(), ["kevin/ship#7", "kevin/ship#8"]);
  const doneCard = (await board()).find((c) => c.id === id);
  assert.equal(doneCard.column, "done");
  assert.equal(doneCard.pr.state, "merged", "a Done card's badge says merged");

  // Approve is only for a card in Review.
  const again = await approve(id);
  assert.equal(again.status, 409);
});

test("Review → Done is Approve; on a non-default base Approve closes the issues itself", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(17, "develop");
  assert.equal(pr.base, "develop");
  const before = gh.closed.length;
  const moved = await api("POST", `/api/sessions/${id}/move`, { column: "done" });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.phase, "done");
  assert.equal(pr.merged, true);
  assert.equal(pr.merge_method, "merge");
  assert.ok(!hasRef(`refs/heads/${branch}`));
  assert.ok(!fs.existsSync(worktree));
  assert.deepEqual(gh.closed.slice(before).map((c) => [c.ref, c.by]).sort(), [["kevin/ship#17", "api"], ["kevin/ship#18", "api"]]);
  assert.equal((await board()).find((c) => c.id === id).column, "done");
});

test("a PR that GitHub calls conflicting but git merges cleanly gets the merge pushed and stays in Review; a PR merged by hand still delivers", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(27);
  // GitHub says the PR conflicts, but git merges the base's new commit cleanly: it is pushed at once.
  const theirs = pushToBase("A readme line", "README.md");
  pr.mergeable_state = "dirty";
  const r = await approve(id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.phase, "pr");
  assert.match(r.json.attention, /conflict with main is resolved and pushed.*approve again/i);
  execFileSync("git", ["merge-base", "--is-ancestor", theirs, `refs/heads/${branch}`], { cwd: bare });
  assert.ok(!pr.merged);
  assert.ok(hasRef(`refs/heads/${branch}`));
  assert.ok(fs.existsSync(worktree));
  assert.equal((await board()).find((c) => c.id === id).column, "review");

  // Someone merged the PR on GitHub by hand: Approve counts it as merged and delivers the card.
  pr.mergeable_state = "clean";
  pr.merged = true;
  const done = await approve(id);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.phase, "done");
  assert.ok(!hasRef(`refs/heads/${branch}`));
  assert.ok(!fs.existsSync(worktree));
});

test("a board-created card's spec issue gets a Closes line, so Approve closes it with the tickets", { skip: !hasPi && "pi CLI not found" }, async () => {
  await setup();
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/ship", title: "Spec issue", prompt: "add a greeting GHSPEC https://github.com/kevin/ship/issues/40", baseBranch: "develop" })).json;
  // Drive the card to Review: answer every question and permission, Solve all in Issues, skip a blocked ticket.
  const card = await waitFor(async () => {
    const x = await summary(s.id);
    const req = x.pending.find((p: any) => p.kind === "decision" || p.kind === "permission");
    if (req) await api("POST", `/api/sessions/${s.id}/respond`, { requestId: req.id, value: req.options[0] });
    else if (x.phase === "ready" && x.status === "idle") await api("POST", `/api/sessions/${s.id}/move`, { column: "doing" });
    else if (x.phase === "implement" && x.attention) await api("POST", `/api/sessions/${s.id}/pipeline`, { action: "skip" });
    return (await board()).find((c) => c.id === s.id && c.column === "review");
  }, 180_000);
  assert.equal(card.specRef, "https://github.com/kevin/ship/issues/40");
  const pr = gh.pulls.find((p) => p.number === card.pr.number);
  assert.equal([...pr.body.matchAll(/Closes #40\b/g)].length, 1, pr.body);

  await waitFor(async () => (await summary(s.id)).status !== "running");
  const before = gh.closed.length;
  const r = await approve(s.id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.phase, "done");
  assert.deepEqual(gh.closed.slice(before), [{ ref: "kevin/ship#40", by: "api" }]);
});

test("Approve closes the issues that name another tracked repo on that repo; one that does not close is noted on the Done card", { skip: !hasPi && "pi CLI not found" }, async () => {
  await setup();
  gh.createBare("kevin", "tracker");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/tracker" })).status, 200);
  // The origin issue and the spec issue live in another repo, so the PR's Closes lines cannot close them.
  gh.lockedIssues.add("kevin/tracker#13");
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/ship", title: "Foreign", prompt: "add a greeting GHSPEC https://github.com/kevin/tracker/issues/13", issueRef: "kevin/tracker#12" })).json;
  assert.ok(s.id, JSON.stringify(s));
  await driveToReview(s.id);
  const before = gh.closed.length;
  const r = await approve(s.id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.phase, "done");
  assert.deepEqual(gh.closed.slice(before), [{ ref: "kevin/tracker#12", by: "api" }]);
  assert.match(r.json.attention, /^PR #\d+ is merged, but issue kevin\/tracker#13 did not close \(.*Resource not accessible by personal access token.*\)\.$/);
  assert.equal((await board()).find((c) => c.id === s.id).column, "done");
});

test("Approve leaves open the issues of repos the workbench does not track, and lists them on the Done card", { skip: !hasPi && "pi CLI not found" }, async () => {
  await setup();
  // A spec ref the model wrote names an upstream repo, and the origin issue is in an untracked repo.
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/ship", title: "Upstream", prompt: "add a wave GHSPEC https://github.com/nodejs/node/issues/123", issueRef: "kevin/elsewhere#5" })).json;
  assert.ok(s.id, JSON.stringify(s));
  await driveToReview(s.id);
  const before = gh.closed.length;
  const r = await approve(s.id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.phase, "done");
  assert.deepEqual(gh.closed.slice(before).filter((c) => !c.ref.startsWith("kevin/ship#")), []);
  assert.equal(
    r.json.attention,
    `PR #${r.json.prNumber} is merged, but issue kevin/elsewhere#5 was not closed (it is in a repo the workbench does not track), and issue nodejs/node#123 was not closed (it is in a repo the workbench does not track).`,
  );
});

test("Approve refuses a card outside Review, and a request from another site", { skip: !hasPi && "pi CLI not found" }, async () => {
  await setup();
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/ship", title: "Not yet", prompt: "add a farewell" })).json;
  const r = await approve(s.id);
  assert.equal(r.status, 409);
  const crossSite = await fetch(`${base}/api/sessions/${s.id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
    body: "{}",
  });
  assert.equal(crossSite.status, 403);
});

test("Approve on a conflicting PR resolves the conflict in a merge run; after finish_merge the branch is pushed and a second Approve merges", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(37);
  const theirs = pushToBase("main was here");
  const r = await approve(id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.phase, "pr");
  // The merge run is on screen as soon as Approve answers.
  assert.match(r.json.activeRun, new RegExp(`^${id}-merge-[a-z0-9]+$`));
  assert.ok(r.json.runs.some((x: any) => x.id === r.json.activeRun));
  assert.ok(!pr.merged);
  // A second Approve while the conflict is being resolved is refused.
  assert.equal((await approve(id)).status, 409);

  const resolved = await waitFor(async () => (await summary(id)).attention && summary(id), 120_000);
  assert.equal(resolved.phase, "pr");
  assert.match(resolved.attention, /conflict.*resolved.*approve again/i);
  assert.equal((await board()).find((c) => c.id === id).column, "review");
  // The resolution is pushed: the branch on GitHub has the base's commit, both sides' lines, and no markers.
  execFileSync("git", ["merge-base", "--is-ancestor", theirs, `refs/heads/${branch}`], { cwd: bare });
  const merged = execFileSync("git", ["show", `refs/heads/${branch}:work.txt`], { cwd: bare }).toString();
  assert.match(merged, /main was here/);
  assert.match(merged, /reviewed/);
  assert.doesNotMatch(merged, /<<<<<<<|=======|>>>>>>>/);

  const done = await approve(id);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.phase, "done");
  assert.equal(pr.merged, true);
  assert.ok(!fs.existsSync(worktree));
});

test("a merge run's resolve is pushed when a file the branch changed has a setext underline (=======) that is no conflict marker", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, worktree, branch } = await toReview(137);
  // The branch's README has a Markdown heading underlined with seven `=`.
  fs.writeFileSync(path.join(worktree, "README.md"), "Install\n=======\n\nRun it.\n");
  git(worktree, "add", "README.md");
  git(worktree, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "Add the README");
  git(worktree, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  const theirs = pushToBase("main was here too");
  const r = await approve(id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.activeRun, new RegExp(`^${id}-merge-`));

  const resolved = await waitFor(async () => (await summary(id)).attention && summary(id), 120_000);
  assert.match(resolved.attention, /^The merge conflict with main is resolved and pushed/);
  execFileSync("git", ["merge-base", "--is-ancestor", theirs, `refs/heads/${branch}`], { cwd: bare });
});

test("a merge run's resolve is pushed when the conflicted file keeps a lone ======= line (a heading underline)", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, branch } = await toReview(157);
  pushToBase("SETEXT: main changed this line");
  assert.equal((await approve(id)).status, 200);
  const resolved = await waitFor(async () => (await summary(id)).attention && summary(id), 120_000);
  assert.match(resolved.attention, /^The merge conflict with main is resolved and pushed/);
  assert.match(git(bare, "show", `refs/heads/${branch}:work.txt`), /^Notes\n=======$/m);
});

test("a conflict resolve whose finish_merge fails keeps the card in Review with the run's reason", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(47);
  const tip = execFileSync("git", ["rev-parse", `refs/heads/${branch}`], { cwd: bare }).toString().trim();
  pushToBase("GIVEUP: main rewrote this line");
  const r = await approve(id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.activeRun, new RegExp(`^${id}-merge-`));

  const failed = await waitFor(async () => (await summary(id)).attention && summary(id), 120_000);
  assert.equal(failed.phase, "pr");
  assert.match(failed.attention, /Both sides rewrote the last line of work\.txt/);
  assert.equal((await board()).find((c) => c.id === id).column, "review");
  assert.ok(!pr.merged);
  // Nothing is pushed, and the worktree is back on the branch's own tip with no merge half done.
  assert.equal(execFileSync("git", ["rev-parse", `refs/heads/${branch}`], { cwd: bare }).toString().trim(), tip);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: worktree }).toString().trim(), "");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree }).toString().trim(), tip);
});

test("a merge run that ends without finish_merge keeps the card in Review, and Approve can start it again", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, branch } = await toReview(57);
  const tip = execFileSync("git", ["rev-parse", `refs/heads/${branch}`], { cwd: bare }).toString().trim();
  pushToBase("NOFINISH: main changed this line");
  const first = (await approve(id)).json.activeRun;
  const stopped = await waitFor(async () => (await summary(id)).attention && summary(id), 120_000);
  assert.equal(stopped.phase, "pr");
  assert.match(stopped.attention, /not resolved: the run stopped without finishing/);
  assert.equal(execFileSync("git", ["rev-parse", `refs/heads/${branch}`], { cwd: bare }).toString().trim(), tip);
  assert.ok(!pr.merged);

  const again = await approve(id);
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.match(again.json.activeRun, new RegExp(`^${id}-merge-`));
  assert.notEqual(again.json.activeRun, first);
  await waitFor(async () => (await summary(id)).attention, 120_000);
});

const move = (id: string, column: string) => api("POST", `/api/sessions/${id}/move`, { column });
const mergeInProgress = (worktree: string) => spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: worktree }).status === 0;

/** Approve a PR whose base changed under it, and wait while the merge run asks the user a question. */
async function holdMergeRun(id: string) {
  pushToBase("HOLDMERGE: main changed this line");
  const r = await approve(id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.activeRun, new RegExp(`^${id}-merge-`));
  await waitFor(async () => (await summary(id)).pending.some((p: any) => p.kind === "decision"), 120_000);
  assert.ok(mergeInProgress(path.join(process.env.DATA_DIR!, "worktrees", id)), "the merge run works on a half-done merge");
  return r.json.activeRun as string;
}

/** Drive a card back to Review: answer every question and permission, Solve all in Issues, skip a blocked ticket. */
async function driveToReview(id: string) {
  await waitFor(async () => {
    const x = await summary(id);
    const req = x.pending.find((p: any) => p.kind === "decision" || p.kind === "permission");
    if (req) await api("POST", `/api/sessions/${id}/respond`, { requestId: req.id, value: req.options[0] });
    else if (x.phase === "ready" && x.status !== "running") await move(id, "doing");
    else if (x.phase === "implement" && x.attention) await api("POST", `/api/sessions/${id}/pipeline`, { action: "skip" });
    return x.phase === "pr" && x.status !== "running";
  }, 180_000);
}

test("Review → Issues during a merge run stops it and undoes the half-done merge; the resumed card's Approve starts a fresh merge run", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, worktree, branch } = await toReview(67);
  const tip = git(bare, "rev-parse", `refs/heads/${branch}`);
  const first = await holdMergeRun(id);

  const paused = await move(id, "issues");
  assert.equal(paused.status, 200, JSON.stringify(paused.json));
  assert.equal(paused.json.phase, "ready");
  assert.equal(await columnOf(id), "issues");
  assert.ok(!mergeInProgress(worktree), "no merge is left half done");
  assert.equal(git(worktree, "status", "--porcelain"), "", "no conflict markers are left in the worktree");
  assert.equal(git(worktree, "rev-parse", "HEAD"), tip);

  // Issues → Doing: every ticket is done, so the review runs again and the card is back in Review.
  await driveToReview(id);
  const again = await approve(id);
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.match(again.json.activeRun, new RegExp(`^${id}-merge-`));
  assert.notEqual(again.json.activeRun, first);
});

test("Review → To do during a merge run stops it and undoes the half-done merge; the reworked card's Approve starts a fresh merge run", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, worktree, branch } = await toReview(77);
  const tip = git(bare, "rev-parse", `refs/heads/${branch}`);
  const first = await holdMergeRun(id);

  const reworked = await move(id, "todo");
  assert.equal(reworked.status, 200, JSON.stringify(reworked.json));
  assert.equal(reworked.json.phase, "grill");
  assert.equal(reworked.json.activeRun, id);
  assert.ok(!mergeInProgress(worktree), "no merge is left half done");
  assert.equal(git(worktree, "rev-parse", "HEAD"), tip);
  assert.equal(git(worktree, "status", "--porcelain"), "", "no conflict markers are left in the worktree");

  await driveToReview(id);
  const again = await approve(id);
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.match(again.json.activeRun, new RegExp(`^${id}-merge-`));
  assert.notEqual(again.json.activeRun, first);
});

test("Review → Issues undoes a half-done merge that no merge run holds (a server restart lost it)", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, worktree, branch } = await toReview(117);
  const tip = git(bare, "rev-parse", `refs/heads/${branch}`);
  // A merge run's half-done merge, left in the worktree: the restarted server knows of no merge run.
  pushToBase("RESTART: main changed this line");
  git(worktree, "fetch", "-q", "origin", "main");
  assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@x", "merge", "--no-edit", "origin/main"], { cwd: worktree }).status, 1, "the merge stops on a conflict");
  assert.ok(mergeInProgress(worktree));

  const paused = await move(id, "issues");
  assert.equal(paused.status, 200, JSON.stringify(paused.json));
  assert.equal(paused.json.phase, "ready");
  assert.ok(!mergeInProgress(worktree), "no merge is left half done");
  assert.equal(git(worktree, "status", "--porcelain"), "", "no conflict markers are left in the worktree");
  assert.equal(git(worktree, "rev-parse", "HEAD"), tip);
});

for (const [word, spec, says] of [
  ["FAKERESOLVE", 87, /the merge is not committed/],
  ["ABORTRESOLVE", 97, /HEAD does not contain origin\/main/],
  ["MARKERRESOLVE", 127, /work\.txt still has conflict markers/],
] as const)
test(`a merge run that says resolved but ${{ FAKERESOLVE: "leaves the merge half done", ABORTRESOLVE: "aborted the merge", MARKERRESOLVE: "committed conflict markers" }[word]} is not pushed: the card stays in Review with the reason`, { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(spec);
  const tip = git(bare, "rev-parse", `refs/heads/${branch}`);
  pushToBase(`${word}: main changed this line`);
  const r = await approve(id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.activeRun, new RegExp(`^${id}-merge-`));

  const failed = await waitFor(async () => (await summary(id)).attention && summary(id), 120_000);
  assert.equal(failed.phase, "pr");
  assert.match(failed.attention, /not resolved: the merge run called finish_merge "resolved", but /);
  assert.match(failed.attention, says);
  assert.ok(!pr.merged);
  assert.equal(git(bare, "rev-parse", `refs/heads/${branch}`), tip, "nothing is pushed");
  assert.ok(!mergeInProgress(worktree));
  assert.equal(git(worktree, "status", "--porcelain"), "");
  assert.equal(git(worktree, "rev-parse", "HEAD"), tip);
});

test("a conflicting PR whose base git cannot merge (no conflicted file) keeps the card in Review with git's reason, and starts no merge run", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(107);
  const tip = git(bare, "rev-parse", `refs/heads/${branch}`);
  // The base adds extra.txt, and the worktree has an untracked extra.txt: git refuses to overwrite it.
  pushToBase("from main", "extra.txt");
  fs.writeFileSync(path.join(worktree, "extra.txt"), "local\n");
  pr.mergeable_state = "dirty";
  const r = await approve(id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.phase, "pr");
  assert.match(r.json.attention, /could not merge main into the branch: .*untracked working tree files would be overwritten/s);
  assert.doesNotMatch(r.json.activeRun, /-merge-/);
  assert.ok(!mergeInProgress(worktree));
  assert.equal(git(bare, "rev-parse", `refs/heads/${branch}`), tip);
  delete pr.mergeable_state;
});

// Last: the mock reads COMMITHOLD before any other word, and it stays in main's work.txt.
for (const [column, spec] of [["issues", 167], ["todo", 177]] as const)
test(`Review → ${column === "issues" ? "Issues" : "To do"} after a merge run committed its resolve but did not call finish_merge drops that merge commit`, { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, worktree, branch } = await toReview(spec);
  const tip = git(bare, "rev-parse", `refs/heads/${branch}`);
  pushToBase("COMMITHOLD: main changed this line");
  assert.equal((await approve(id)).status, 200);
  await waitFor(async () => (await summary(id)).pending.some((p: any) => p.kind === "decision"), 120_000);
  assert.ok(!mergeInProgress(worktree), "the merge run committed the merge");
  assert.notEqual(git(worktree, "rev-parse", "HEAD"), tip);

  const moved = await move(id, column);
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(git(worktree, "rev-parse", "HEAD"), tip);
  assert.equal(git(worktree, "status", "--porcelain"), "");
  assert.equal(git(bare, "rev-parse", `refs/heads/${branch}`), tip, "nothing is pushed");
});
