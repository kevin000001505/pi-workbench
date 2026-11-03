/**
 * Approve over HTTP: a Review card's PR merges, its branch and worktree go, and the card moves to Done.
 * Drives the real server (main.ts) on an ephemeral port, with a real `pi --mode rpc` against the
 * scripted mock model and the mock GitHub. Skips when the pi CLI isn't available.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { startMockLlm } from "./mock-llm.ts";
import { startMockGitHub } from "./mock-github.ts";

const piBin = process.env.PI_BIN ?? "pi";
const hasPi = spawnSync(piBin, ["--version"]).status === 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-approve-"));
const remotes = path.join(tmp, "remotes");
fs.mkdirSync(remotes);
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "approve-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");
process.env.HOME = path.join(tmp, "agent-home");
process.env.GITHUB_CLONE_BASE = `file://${remotes}`;
process.env.PI_BIN = piBin;
process.env.PI_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-extension", "workbench.ts");

// Skills the pipeline invokes; pi expands /skill:name from these.
for (const name of ["grill-with-docs", "to-spec", "to-tickets", "tdd", "code-review", "resolving-merge-conflicts", "setup-matt-pocock-skills"]) {
  fs.mkdirSync(path.join(process.env.SKILLS_DIR, name), { recursive: true });
  fs.writeFileSync(path.join(process.env.SKILLS_DIR, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} test skill\n---\n${name} body\n`);
}

const mock = await startMockLlm();
const gh = await startMockGitHub(remotes);
process.env.GITHUB_API_URL = gh.url;

const freePort = await new Promise<number>((res, rej) => {
  const srv = http.createServer();
  srv.listen(0, "127.0.0.1", () => {
    const p = (srv.address() as { port: number }).port;
    srv.close(() => res(p));
  });
  srv.on("error", rej);
});
process.env.PORT = String(freePort);
process.env.HOST = "127.0.0.1";
const base = `http://127.0.0.1:${freePort}`;

if (hasPi) await import("../src/main.ts");

const api = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const summary = async (id: string) => (await api("GET", `/api/sessions/${id}`)).json.summary;

/** Answer the decision the session waits on with its first option. */
async function answerNext(id: string, expect: RegExp) {
  const req = await waitFor(async () => (await summary(id)).pending.find((p: any) => p.kind === "decision"));
  assert.match(req.title, expect);
  const r = await api("POST", `/api/sessions/${id}/respond`, { requestId: req.id, value: req.options[0] });
  assert.equal(r.status, 200);
}

const board = async (repo = "kevin/ship") => {
  const r = await api("GET", `/api/board?repo=${repo}`);
  assert.equal(r.status, 200);
  return r.json.cards as any[];
};
const columnOf = async (id: string) => (await board()).find((c) => c.id === id)?.column;

after(async () => {
  await mock.close();
  await gh.close();
  // main.ts's SIGTERM handler stops the sessions and exits, after the TAP is out.
  if (hasPi) process.kill(process.pid, "SIGTERM");
});

const bare = path.join(remotes, "kevin", "ship.git");
const hasRef = (ref: string) => {
  try {
    execFileSync("git", ["rev-parse", "--verify", "-q", ref], { cwd: bare, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

let ready: Promise<void> | undefined;
/** The repo every test ships to; `develop` is a second, non-default base branch. */
function setup() {
  ready ??= (async () => {
    await waitFor(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok);
    assert.equal((await api("PUT", "/api/secrets", { scope: "global", name: "GITHUB_TOKEN", value: "ghp_test" })).status, 200);
    assert.equal((await api("PUT", "/api/settings/model", { baseUrl: mock.url })).status, 200);
    gh.createBare("kevin", "ship");
    execFileSync("git", ["branch", "develop", "main"], { cwd: bare });
    assert.equal((await api("POST", "/api/repos", { id: "kevin/ship" })).status, 200);
  })();
  return ready;
}

/** A card solved from spec issue `spec` with one ticket issue `spec + 1`, driven to Review with its PR open. */
async function toReview(spec: number, baseBranch?: string) {
  await setup();
  gh.seedSubIssues("kevin", "ship", { number: spec, title: `Spec ${spec}`, body: "## Solution\nhello.txt says Hello." }, [
    { number: spec + 1, title: "Write hello.txt", body: "Create hello.txt containing Hello." },
  ]);
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/ship", title: `Spec ${spec}`, issueRef: `kevin/ship#${spec}`, mode: "pipeline", startFrom: "tickets", baseBranch })).json;
  assert.ok(s.id, JSON.stringify(s));
  // The review's `git push` waits on a permission.
  const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"), 120_000);
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: perm.id, value: perm.options[0] })).status, 200);
  const card = await waitFor(async () => (await board()).find((c) => c.id === s.id && c.column === "review"), 120_000);
  await waitFor(async () => (await summary(s.id)).status !== "running");
  const pr = gh.pulls.find((p) => p.number === card.pr.number);
  return { id: s.id as string, pr, worktree: path.join(process.env.DATA_DIR!, "worktrees", s.id), branch: (await summary(s.id)).branch as string };
}

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

test("Approve merges the PR with a merge commit, deletes the branch and the worktree, and the merge closes the issues", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(7);
  assert.ok(hasRef(`refs/heads/${branch}`), "the branch is on GitHub");
  assert.ok(fs.existsSync(worktree));

  // Branch protection refuses the merge: the card stays in Review with GitHub's message.
  pr.merge_refusal = 'Required status check "ci" is failing.';
  const refused = await approve(id);
  assert.equal(refused.status, 200, JSON.stringify(refused.json));
  assert.equal(refused.json.phase, "pr");
  assert.match(refused.json.attention, /Required status check "ci" is failing/);
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
  assert.equal((await board()).find((c) => c.id === id).column, "done");

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
