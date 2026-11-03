/**
 * Abandon over HTTP: a card's runs stop, its PR closes, its branch and worktree go, and the card
 * leaves the board, while its GitHub issues stay open.
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
import { WebSocket } from "ws";

const piBin = process.env.PI_BIN ?? "pi";
const hasPi = spawnSync(piBin, ["--version"]).status === 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-abandon-"));
const remotes = path.join(tmp, "remotes");
fs.mkdirSync(remotes);
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "abandon-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");
process.env.HOME = path.join(tmp, "agent-home");
process.env.GITHUB_CLONE_BASE = `file://${remotes}`;
process.env.PI_BIN = piBin;
process.env.PI_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-extension", "workbench.ts");

// Skills the pipeline invokes; pi expands /skill:name from these.
for (const name of ["grill-with-docs", "to-spec", "to-tickets", "tdd", "code-review", "setup-matt-pocock-skills"]) {
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

const board = async (repo = "kevin/ship") => {
  const r = await api("GET", `/api/board?repo=${repo}`);
  assert.equal(r.status, 200);
  return r.json.cards as any[];
};

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
  assert.deepEqual(cards.find((c) => c.id === "issue:7"), { id: "issue:7", title: "Spec 7", column: "issues", tickets: { done: 0, total: 1 }, attention: null, pr: null, specRef: "https://github.com/kevin/ship/issues/7" });
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
