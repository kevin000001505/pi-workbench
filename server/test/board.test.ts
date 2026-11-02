/**
 * The Board over HTTP: GET /api/board lists a repo's pipeline sessions as cards in column order.
 * Drives the real server (main.ts) on an ephemeral port, with a real `pi --mode rpc` against the
 * scripted mock model and the mock GitHub. Skips when the pi CLI isn't available.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { startMockLlm } from "./mock-llm.ts";
import { startMockGitHub } from "./mock-github.ts";

const piBin = process.env.PI_BIN ?? "pi";
const hasPi = spawnSync(piBin, ["--version"]).status === 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-board-"));
const remotes = path.join(tmp, "remotes");
fs.mkdirSync(remotes);
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "board-master-key-0123456789";
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

/** Answer the decision the session waits on with its first option. */
async function answerNext(id: string, expect: RegExp) {
  const req = await waitFor(async () => (await summary(id)).pending.find((p: any) => p.kind === "decision"));
  assert.match(req.title, expect);
  const r = await api("POST", `/api/sessions/${id}/respond`, { requestId: req.id, value: req.options[0] });
  assert.equal(r.status, 200);
}

const board = async (repo = "kevin/demo") => {
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

test("the board lists a repo's pipeline sessions as cards in column order; a feature stops in Issues", { skip: !hasPi && "pi CLI not found" }, async () => {
  await waitFor(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok);
  assert.equal((await api("PUT", "/api/secrets", { scope: "global", name: "GITHUB_TOKEN", value: "ghp_test" })).status, 200);
  assert.equal((await api("PUT", "/api/settings/model", { baseUrl: mock.url })).status, 200);
  gh.createBare("kevin", "demo");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/demo" })).status, 200);

  assert.deepEqual(await board(), []);

  // A feature runs grill → spec → tickets, then waits in Issues.
  const a = (await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Greeting", prompt: "add a greeting" })).json;
  assert.equal(a.mode, "pipeline");
  assert.equal(await columnOf(a.id), "todo", "setup");
  await answerNext(a.id, /shared understanding/);
  await waitFor(async () => (await summary(a.id)).phase === "spec");
  assert.equal(await columnOf(a.id), "todo", "spec");
  await answerNext(a.id, /seam/);
  await waitFor(async () => (await summary(a.id)).phase === "tickets");
  assert.equal(await columnOf(a.id), "todo", "tickets");
  await answerNext(a.id, /Approve/);
  const card = await waitFor(async () => (await board()).find((c) => c.id === a.id && c.column === "issues"));
  assert.deepEqual(card, {
    id: a.id,
    title: "Greeting",
    column: "issues",
    tickets: { done: 0, total: 3 },
    attention: null,
    pr: null,
    specRef: ".scratch/greeting/spec.md",
  });

  // It is paused: the run settles and no ticket run starts.
  await waitFor(async () => (await summary(a.id)).status === "idle");
  await new Promise((r) => setTimeout(r, 1500));
  const paused = await summary(a.id);
  assert.equal(paused.phase, "ready");
  assert.deepEqual(paused.tickets.map((t: any) => t.status), ["ready", "ready", "ready"]);
  assert.equal(paused.activeRun, a.id, "still on the plan conversation");
  assert.ok(!mock.requests.some((r) => JSON.stringify(r.messages ?? []).includes('<skill name=\\"tdd\\"')), "no ticket run started");

  // A second feature still in the grill sits in To do, before the first; a direct session is no card.
  const b = (await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Farewell", prompt: "add a farewell" })).json;
  await waitFor(async () => (await summary(b.id)).pending.some((p: any) => p.kind === "decision"));
  assert.equal((await summary(b.id)).phase, "grill");
  // A direct session is no card, even while it sets up.
  const d = (await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Quick", prompt: "hello there", mode: "direct" })).json;
  assert.equal(d.phase, "setup");
  const cards = await board();
  assert.deepEqual(
    cards.map((c) => [c.title, c.column]),
    [
      ["Farewell", "todo"],
      ["Greeting", "issues"],
    ],
  );

  // Each repo has its own board.
  gh.createBare("kevin", "other");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/other" })).status, 200);
  assert.deepEqual(await board("kevin/other"), []);
  // An untracked repo has no board.
  assert.equal((await api("GET", "/api/board?repo=kevin/nope")).status, 404);
});

test("a card started from a spec's ticket issues skips Issues: Doing, then QA, then Done", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.seedSubIssues("kevin", "demo", { number: 7, title: "Greeting suite", body: "## Solution\nhello.txt says Hello." }, [
    { number: 8, title: "Write hello.txt", body: "Create hello.txt containing Hello. BLOCKME" },
  ]);
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Greeting suite", issueRef: "kevin/demo#7", mode: "pipeline", startFrom: "tickets" })).json;
  const column = () => columnOf(s.id);
  // The ticket reports blocked: the card holds in Doing with the reason as its attention.
  const blocked = await waitFor(async () => (await board()).find((c) => c.id === s.id && c.attention));
  assert.equal(blocked.column, "doing");
  assert.match(blocked.attention, /Ticket #1 is blocked/);
  assert.deepEqual(blocked.tickets, { done: 0, total: 1 });
  assert.equal((await api("POST", `/api/sessions/${s.id}/pipeline`, { action: "skip" })).status, 200);

  // The review's `git push` waits on a permission, so the card holds in QA.
  const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  assert.equal(await column(), "qa");
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: perm.id, value: perm.options[0] })).status, 200);
  await waitFor(async () => (await column()) === "done");
  const card = (await board()).find((c) => c.id === s.id);
  assert.deepEqual(card.tickets, { done: 1, total: 1 });
  assert.equal(card.attention, null);
  assert.match(card.specRef, /issues\/7$/);
  assert.equal(card.pr, null);
  // The card detail reads the review's note from the session.
  assert.equal((await summary(s.id)).reviewNote, "Fixed one naming issue");

  // The newest card still sorts by column, after the older ones in To do and Issues.
  assert.deepEqual((await board()).map((c) => c.column), ["todo", "issues", "done"]);

  // A PR opened on the session shows on its card.
  const pr = await api("POST", `/api/sessions/${s.id}/pr`, { title: "Greeting suite", body: "Closes #7" });
  assert.equal(pr.status, 200, JSON.stringify(pr.json));
  const withPr = (await board()).find((c) => c.id === s.id);
  assert.deepEqual(withPr.pr, { number: pr.json.number, url: pr.json.url, state: null });
});

test("a move is a command: Issues → Doing is Solve all, a forward move with no command is refused", { skip: !hasPi && "pi CLI not found" }, async () => {
  const cards = await board();
  const greeting = cards.find((c) => c.title === "Greeting");
  const farewell = cards.find((c) => c.title === "Farewell");
  assert.equal(greeting.column, "issues");
  assert.equal(farewell.column, "todo");
  const move = (id: string, column: string) => api("POST", `/api/sessions/${id}/move`, { column });

  // To do → Doing while the grill runs has no command: 409, and the card stays in To do.
  const refused = await move(farewell.id, "doing");
  assert.equal(refused.status, 409);
  assert.equal(await columnOf(farewell.id), "todo");
  assert.equal((await summary(farewell.id)).phase, "grill");

  // A move from another site is refused before it runs.
  const crossSite = await fetch(`${base}/api/sessions/${greeting.id}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
    body: JSON.stringify({ column: "doing" }),
  });
  assert.equal(crossSite.status, 403);
  assert.equal(await columnOf(greeting.id), "issues");

  // Issues → Doing is Solve all: the paused session implements its first ticket in a fresh run.
  const solved = await move(greeting.id, "doing");
  assert.equal(solved.status, 200, JSON.stringify(solved.json));
  assert.equal(solved.json.phase, "implement");
  assert.equal(await columnOf(greeting.id), "doing");
  const running = await waitFor(async () => {
    const x = await summary(greeting.id);
    return x.tickets[0].status === "running" && x.activeRun === x.tickets[0].runId ? x : undefined;
  });
  assert.deepEqual(running.tickets.map((t: any) => t.status), ["running", "ready", "ready"]);
  await waitFor(() => mock.requests.some((r) => JSON.stringify(r.messages ?? []).includes("Ticket #1: Write hello.txt")));
});
