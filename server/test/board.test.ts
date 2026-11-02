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
import { DatabaseSync } from "node:sqlite";
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

test("a card started from a spec's ticket issues skips Issues: Doing, then QA, then Review with the opened PR", { skip: !hasPi && "pi CLI not found" }, async () => {
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
  // After the review, the workbench opens the PR: the card moves to Review with its PR badge.
  await waitFor(async () => (await column()) === "review");
  const card = (await board()).find((c) => c.id === s.id);
  assert.deepEqual(card.tickets, { done: 1, total: 1 });
  assert.equal(card.attention, null);
  assert.match(card.specRef, /issues\/7$/);
  const pr = gh.pulls.at(-1);
  assert.match(pr.body, /Closes #8/);
  assert.match(pr.body, /Closes #7/);
  // A check still runs on the PR head.
  assert.deepEqual(card.pr, { number: pr.number, url: pr.html_url, state: "checks" });
  // The card detail reads the review's note from the session.
  assert.equal((await summary(s.id)).reviewNote, "Fixed one naming issue");

  // The newest card still sorts by column, after the older ones in To do and Issues.
  assert.deepEqual((await board()).map((c) => c.column), ["todo", "issues", "review"]);

  // The badge follows the PR on GitHub: every check passed, a check failed, then a merge conflict.
  gh.checkRuns.splice(1);
  assert.equal((await board()).find((c) => c.id === s.id).pr.state, "open");
  gh.checkRuns[0].conclusion = "failure";
  assert.equal((await board()).find((c) => c.id === s.id).pr.state, "checks", "a failed check");
  pr.mergeable_state = "dirty";
  assert.equal((await board()).find((c) => c.id === s.id).pr.state, "conflict");
});

/** Put a session in Done the way a merge will, stamping when it got there. */
function markDone(id: string) {
  const db = new DatabaseSync(path.join(process.env.DATA_DIR!, "workbench.db"));
  db.prepare("UPDATE sessions SET phase = 'done', done_at = ? WHERE id = ?").run(Date.now(), id);
  db.close();
}

test("Done lists merged cards newest first, and a done limit hides the older ones", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "history");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/history" })).status, 200);
  const ids: string[] = [];
  for (const title of ["First", "Second", "Third"]) {
    const s = (await api("POST", "/api/sessions", { repoId: "kevin/history", title, prompt: `add ${title}` })).json;
    await waitFor(async () => (await summary(s.id)).pending.some((p: any) => p.kind === "decision"));
    // Stop ends the run (the card pauses in Issues); until Approve exists, the db write puts it in Done.
    assert.equal((await api("POST", `/api/sessions/${s.id}/pipeline`, { action: "stop" })).status, 200);
    await waitFor(async () => (await summary(s.id)).phase === "ready");
    markDone(s.id);
    await waitFor(async () => (await summary(s.id)).phase === "done");
    ids.push(s.id);
    await new Promise((r) => setTimeout(r, 20));
  }
  // A later message in an older card's session does not move it up: Done sorts by when the card got there.
  const touched = (await summary(ids[2])).updatedAt;
  assert.equal((await api("POST", `/api/sessions/${ids[0]}/prompt`, { message: "one more thing" })).status, 200);
  assert.ok((await summary(ids[0])).updatedAt > touched, "the older card's session is now the latest updated");
  const all = await api("GET", "/api/board?repo=kevin/history");
  assert.deepEqual(all.json.cards.map((c: any) => [c.title, c.column]), [["Third", "done"], ["Second", "done"], ["First", "done"]]);
  assert.equal(all.json.doneHidden, 0);

  const two = await api("GET", "/api/board?repo=kevin/history&done=2");
  assert.equal(two.status, 200);
  assert.deepEqual(two.json.cards.map((c: any) => c.title), ["Third", "Second"]);
  assert.equal(two.json.doneHidden, 1);
  // "Show more" raises the limit.
  assert.deepEqual((await api("GET", "/api/board?repo=kevin/history&done=3")).json.cards.length, 3);
  assert.equal((await api("GET", "/api/board?repo=kevin/history&done=nope")).status, 400);
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

test("a move back to Issues stops the run; a move to Doing resumes it with the done tickets kept", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.seedSubIssues("kevin", "demo", { number: 20, title: "Wave", body: "## Solution\nwave.txt says Wave." }, [
    { number: 21, title: "Write wave.txt", body: "Create wave.txt containing Wave." },
    { number: 22, title: "Push wave.txt", body: "Push it. PUSHME", blockedBy: [21] },
  ]);
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Wave", issueRef: "kevin/demo#20", mode: "pipeline", startFrom: "tickets" })).json;
  const move = (column: string) => api("POST", `/api/sessions/${s.id}/move`, { column });
  const ticketRuns = (num: number) => mock.requests.filter((r) => JSON.stringify(r.messages ?? []).includes(`Ticket #${num}: `)).length;

  // Ticket 1 finishes; ticket 2's `git push` waits on a permission in Doing.
  await waitFor(async () => (await summary(s.id)).pending.some((p: any) => p.kind === "permission"));
  const before = await summary(s.id);
  assert.deepEqual(before.tickets.map((t: any) => t.status), ["done", "running"]);
  assert.equal(await columnOf(s.id), "doing");

  // Doing → Issues: the run stops and the session pauses in `ready`; the ticket statuses stay.
  const paused = await move("issues");
  assert.equal(paused.status, 200, JSON.stringify(paused.json));
  assert.equal(paused.json.phase, "ready");
  assert.equal(await columnOf(s.id), "issues");
  await waitFor(async () => (await summary(s.id)).status === "stopped");
  await new Promise((r) => setTimeout(r, 1000));
  const stopped = await summary(s.id);
  assert.equal(stopped.phase, "ready");
  assert.deepEqual(stopped.pending, [], "the stopped run's permission is gone");
  assert.deepEqual(stopped.tickets.map((t: any) => t.status), ["done", "running"]);
  assert.equal(stopped.attention, null);
  const t1Runs = ticketRuns(1);

  // Issues → Doing resumes: ticket 2 starts again in a fresh run; ticket 1 does not run again.
  const resumed = await move("doing");
  assert.equal(resumed.status, 200, JSON.stringify(resumed.json));
  const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  const again = await summary(s.id);
  assert.deepEqual(again.tickets.map((t: any) => t.status), ["done", "running"]);
  assert.notEqual(again.tickets[1].runId, before.tickets[1].runId, "a fresh run for the stopped ticket");
  assert.equal(again.activeRun, again.tickets[1].runId);
  assert.equal(again.tickets[0].runId, before.tickets[0].runId, "the done ticket keeps its run");
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: perm.id, value: perm.options[0] })).status, 200);

  // The review's `git push` waits in QA; QA → Issues stops the review the same way.
  await waitFor(async () => {
    const x = await summary(s.id);
    return x.phase === "review" && x.pending.some((p: any) => p.kind === "permission");
  });
  assert.equal(await columnOf(s.id), "qa");
  assert.equal(ticketRuns(1), t1Runs, "ticket 1 never ran again");
  assert.equal((await move("issues")).json.phase, "ready");
  await waitFor(async () => (await summary(s.id)).status === "stopped");
  assert.deepEqual((await summary(s.id)).tickets.map((t: any) => t.status), ["done", "done"]);
  // Back to Doing with every ticket done: the review starts again.
  assert.equal((await move("doing")).status, 200);
  const perm2 = await waitFor(async () => {
    const x = await summary(s.id);
    return x.phase === "review" ? x.pending.find((p: any) => p.kind === "permission") : undefined;
  });
  assert.ok(perm2);
  // QA → To do stops the review and plans again.
  assert.equal((await move("todo")).json.phase, "grill");
  assert.equal(await columnOf(s.id), "todo");
});

test("a move back to To do stops the run and grills again in the plan conversation, to rework the spec", { skip: !hasPi && "pi CLI not found" }, async () => {
  const greeting = (await board()).find((c) => c.title === "Greeting");
  // The previous test left it in Doing, its first ticket waiting on a permission.
  assert.equal(greeting.column, "doing");
  const before = await summary(greeting.id);
  assert.ok(before.grillSummary && before.spec);
  const rework = () => mock.requests.find((x) => JSON.stringify(x.messages ?? []).includes("Rework the spec (.scratch/greeting/spec.md)"));

  const r = await api("POST", `/api/sessions/${greeting.id}/move`, { column: "todo" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.phase, "grill");
  assert.equal(await columnOf(greeting.id), "todo");
  const s = await summary(greeting.id);
  assert.equal(s.activeRun, greeting.id, "back on the plan conversation");
  assert.equal(s.grillSummary, null);
  assert.equal(s.spec, null);
  assert.equal(s.specRef, ".scratch/greeting/spec.md", "the spec ref is kept");
  assert.equal(s.attention, null);

  // The grill runs again with the rework prompt, and the pipeline waits for it: no skip ahead.
  const decision = await waitFor(async () => (await summary(greeting.id)).pending.find((p: any) => p.kind === "decision"));
  assert.match(decision.title, /shared understanding/);
  assert.ok(rework(), "the grill gets the rework prompt with the kept spec ref");
  const text = JSON.stringify(rework().messages);
  assert.match(text, /<skill name=\\"grill-with-docs\\"[^]*Rework the spec/);
  assert.match(text, /update the existing spec issue/i);
  assert.match(text, /close every ticket issue .*drops/i);
  assert.ok(text.includes("add a greeting"), "the plan conversation keeps its history");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await summary(greeting.id)).phase, "grill", "the pipeline waits for the grill");
  assert.equal((await api("POST", `/api/sessions/${greeting.id}/respond`, { requestId: decision.id, value: decision.options[0] })).status, 200);
  await waitFor(async () => (await summary(greeting.id)).phase === "spec");
  assert.equal(await columnOf(greeting.id), "todo");
});

test("a backward move clears the card's attention", { skip: !hasPi && "pi CLI not found" }, async () => {
  const blockedCard = async (number: number, title: string) => {
    gh.seedSubIssues("kevin", "demo", { number, title, body: "## Solution\nSomething." }, [{ number: number + 1, title: "Do it", body: "Do it. BLOCKME" }]);
    const s = (await api("POST", "/api/sessions", { repoId: "kevin/demo", title, issueRef: `kevin/demo#${number}`, mode: "pipeline", startFrom: "tickets" })).json;
    await waitFor(async () => (await board()).find((c) => c.id === s.id && c.attention));
    return s.id as string;
  };
  // A blocked ticket's card in Doing, moved to Issues.
  const a = await blockedCard(30, "Blocked to Issues");
  assert.equal((await api("POST", `/api/sessions/${a}/move`, { column: "issues" })).status, 200);
  const paused = (await board()).find((c) => c.id === a);
  assert.equal(paused.column, "issues");
  assert.equal(paused.attention, null);
  // Issues → To do reworks a paused card too.
  assert.equal((await api("POST", `/api/sessions/${a}/move`, { column: "todo" })).status, 200);
  assert.equal(await columnOf(a), "todo");
  // A blocked ticket's card in Doing, moved to To do: the rework names its spec issue.
  const b = await blockedCard(40, "Blocked to To do");
  assert.equal((await api("POST", `/api/sessions/${b}/move`, { column: "todo" })).status, 200);
  const card = (await board()).find((c) => c.id === b);
  assert.equal(card.column, "todo");
  assert.equal(card.attention, null);
  await waitFor(() => mock.requests.some((r) => /Rework the spec \(\S*issues\/40\)/.test(JSON.stringify(r.messages ?? []))));
});
