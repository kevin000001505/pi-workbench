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
import { WebSocket } from "ws";
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

/** The column a session card sits in on a repo's board, for a repo other than the demo's. */
const columnOfCard = (repoId: string) => async (id: string) => (await board(repoId)).find((c) => c.id === id)?.column;

/** Adding a repo that is not set up starts a setup session (issue #99), and its card sits on the board.
 * A test that lists a repo's feature cards drops that card with `featureCards`. */
const SETUP_CARD = "Set up agent skills";
const featureCards = async (repo?: string) => (await board(repo)).filter((c) => c.title !== SETUP_CARD);

/**
 * The ticket run starts the mock model got for one ticket: requests whose last message is that
 * ticket's start prompt. The mock repeats the whole history in every request of a run, so a later
 * step of the run does not match, and a run that started once counts once.
 */
const ticketRunStarts = (num: number) => mock.requests.filter((r) => {
  const last = (r.messages ?? []).at(-1);
  return last?.role === "user" && JSON.stringify(last).includes(`Ticket #${num}: `);
}).length;

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

  // Adding the repo, which is recorded as not set up, starts its setup session (issue #99).
  const setupRuns = (await api("GET", "/api/sessions")).json.filter((s: any) => s.repoId === "kevin/demo");
  assert.equal(setupRuns.length, 1, JSON.stringify(setupRuns.map((s: any) => s.title)));
  assert.equal(setupRuns[0].title, SETUP_CARD);
  assert.equal(setupRuns[0].phase, "setup");

  // A fresh board shows that card beside the repo's plain open issues in Issues.
  assert.deepEqual(await board(), [
    { id: setupRuns[0].id, title: SETUP_CARD, column: "todo", tickets: { done: 0, total: 0 }, attention: null, pr: null, specRef: null, doneAt: null, specCard: false, subs: null },
    { id: "issue:1", title: "Add dark mode", column: "issues", tickets: { done: 0, total: 0 }, attention: null, pr: null, specRef: "https://github.com/kevin/demo/issues/1", doneAt: null, specCard: false, subs: null },
    { id: "issue:2", title: "Fix login Crash", column: "issues", tickets: { done: 0, total: 0 }, attention: null, pr: null, specRef: "https://github.com/kevin/demo/issues/2", doneAt: null, specCard: false, subs: null },
    { id: "issue:3", title: "Docs: setup guide", column: "issues", tickets: { done: 0, total: 0 }, attention: null, pr: null, specRef: "https://github.com/kevin/demo/issues/3", doneAt: null, specCard: false, subs: null },
  ]);

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
    doneAt: null,
    specCard: true,
    subs: null,
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
  // A direct session is a card in Doing too. The repo's setup card already landed its setup files
  // on the default branch (issue #100), so this session starts with them and runs no setup step of
  // its own; a fresh repo's direct session, which does set up, is the test after this one.
  const d = (await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Quick", prompt: "hello there", mode: "direct" })).json;
  assert.equal(d.phase, "direct");
  // The feature cards, beside the plain issue cards, in column order (the repo's setup card is no feature).
  const cards = (await featureCards()).filter((c) => !c.id.startsWith("issue:"));
  assert.deepEqual(
    cards.map((c) => [c.title, c.column]),
    [
      ["Farewell", "todo"],
      ["Greeting", "issues"],
      ["Quick", "doing"],
    ],
  );

  // Each repo has its own board; its plain issues show too.
  gh.createBare("kevin", "other");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/other" })).status, 200);
  assert.deepEqual((await featureCards("kevin/other")).map((c) => [c.title, c.column]), [
    ["Add dark mode", "issues"],
    ["Fix login Crash", "issues"],
    ["Docs: setup guide", "issues"],
  ]);
  // An untracked repo has no board.
  assert.equal((await api("GET", "/api/board?repo=kevin/nope")).status, 404);
});

test("a direct session is a card in Doing, even while it sets up: every drag is refused, and it claims no issue", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "direct");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/direct" })).status, 200);
  const col = async (id: string) => (await board("kevin/direct")).find((c) => c.id === id)?.column;
  const events = await boardEvents();
  const before = events.seen.length;

  // A fresh repo has no setup marker: the direct session runs setup first, and its card is in Doing all the while.
  const d = await api("POST", "/api/sessions", { repoId: "kevin/direct", title: "Quick", prompt: "say hello", mode: "direct" });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  const s = d.json;
  assert.equal(s.mode, "direct");
  assert.equal(s.phase, "setup");
  assert.equal(await col(s.id), "doing", "the card is in Doing while it sets up");
  // Every drag of the card is refused while it is in Doing — even while the session still sets up.
  for (const column of ["todo", "issues", "qa", "review", "done"]) {
    const r = await api("POST", `/api/sessions/${s.id}/move`, { column });
    assert.equal(r.status, 409, `a drag to ${column} while it sets up: ${JSON.stringify(r.json)}`);
  }
  await waitFor(() => events.seen.length >= before + 1);
  assert.equal(events.seen[before], "kevin/direct");

  // The task goes out once setup commits its marker: the phase is `direct`, the card still in Doing.
  await waitFor(async () => (await summary(s.id)).phase === "direct");
  assert.equal(await col(s.id), "doing");

  // The card detail reads the session: it has no spec and no tickets.
  const sum = await summary(s.id);
  assert.equal(sum.spec, null);
  assert.equal(sum.specRef, null);
  assert.deepEqual(sum.tickets, []);

  // Every drag of the card is refused (409), so it snaps back in Doing.
  for (const column of ["todo", "issues", "qa", "review", "done"]) {
    const r = await api("POST", `/api/sessions/${s.id}/move`, { column });
    assert.equal(r.status, 409, `a drag to ${column}: ${JSON.stringify(r.json)}`);
  }
  assert.equal(await col(s.id), "doing");

  // A direct session that talks about an issue claims it not: the issue's unclaimed card stays on the board.
  const t = await api("POST", "/api/sessions", { repoId: "kevin/direct", title: "Talk", prompt: "what is left?", issueRef: "kevin/direct#2", mode: "direct" });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  assert.ok((await board("kevin/direct")).some((c) => c.id === "issue:2"), "issue #2 stays unclaimed");
  events.close();
  await api("POST", `/api/sessions/${t.json.id}/stop`, {});
  await api("POST", `/api/sessions/${s.id}/stop`, {});
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

  // The newest session card still sorts by column, after the older ones in To do and Issues.
  const sessionCards = (await featureCards()).filter((c) => !c.id.startsWith("issue:"));
  assert.deepEqual(sessionCards.map((c) => c.column), ["todo", "issues", "doing", "review"]);

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
    // Approve needs an open PR, so the run is stopped and the db write puts the card in Done as a merge would.
    assert.equal((await api("POST", `/api/sessions/${s.id}/stop`, {})).status, 200);
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
  const sessionTitles = (cards: any[]) => cards.filter((c) => !c.id.startsWith("issue:") && c.title !== SETUP_CARD);
  assert.deepEqual(
    sessionTitles(all.json.cards).map((c: any) => [c.title, c.column]),
    [["Third", "done"], ["Second", "done"], ["First", "done"]],
  );
  assert.equal(all.json.doneHidden, 0);

  const two = await api("GET", "/api/board?repo=kevin/history&done=2");
  assert.equal(two.status, 200);
  assert.deepEqual(sessionTitles(two.json.cards).map((c: any) => c.title), ["Third", "Second"]);
  assert.equal(two.json.doneHidden, 2, "the limit hides the oldest pipeline card and the repo's landed setup card");
  // "Show more" raises the limit.
  assert.equal(sessionTitles((await api("GET", "/api/board?repo=kevin/history&done=3")).json.cards).length, 3);
  assert.equal((await api("GET", "/api/board?repo=kevin/history&done=nope")).status, 400);
});

test("the pipeline's Stop is refused while the card is planned: no ticketless card pauses in Issues", { skip: !hasPi && "pi CLI not found" }, async () => {
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Too early", prompt: "add a farewell" })).json;
  await waitFor(async () => (await summary(s.id)).pending.some((p: any) => p.kind === "decision"));
  const r = await api("POST", `/api/sessions/${s.id}/pipeline`, { action: "stop" });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal((await summary(s.id)).phase, "grill");
  assert.equal(await columnOf(s.id), "todo");
  assert.equal((await api("POST", `/api/sessions/${s.id}/stop`, {})).status, 200);
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
  // The pipeline panel's Stop pauses the review the same way: its permission goes with the run.
  assert.equal((await api("POST", `/api/sessions/${s.id}/pipeline`, { action: "stop" })).status, 200);
  await waitFor(async () => (await summary(s.id)).status === "stopped");
  await new Promise((r) => setTimeout(r, 500));
  const stoppedByPanel = await summary(s.id);
  assert.equal(stoppedByPanel.phase, "ready");
  assert.deepEqual(stoppedByPanel.pending, [], "Stop drops the review run's permission");
  assert.equal((await move("doing")).status, 200);
  await waitFor(async () => {
    const x = await summary(s.id);
    return x.phase === "review" && x.pending.some((p: any) => p.kind === "permission");
  });
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

test("a reworked card waits in To do until the new breakdown is recorded; a ticket the stopped run left running is ready again", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.seedSubIssues("kevin", "demo", { number: 70, title: "Rework wave", body: "## Solution\nwave.txt says Wave." }, [
    { number: 71, title: "Push wave.txt", body: "Create wave.txt and push it. PUSHME" },
  ]);
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Rework wave", issueRef: "kevin/demo#70", mode: "pipeline", startFrom: "tickets" })).json;
  // Ticket 1's `git push` waits on a permission in Doing: the ticket is running.
  await waitFor(async () => (await summary(s.id)).pending.some((p: any) => p.kind === "permission"));
  assert.equal((await summary(s.id)).tickets[0].status, "running");

  const r = await api("POST", `/api/sessions/${s.id}/move`, { column: "todo" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const reworked = await summary(s.id);
  assert.deepEqual(reworked.tickets.map((t: any) => t.status), ["ready"], "the stopped run's ticket is not running");

  // The grill and the spec run again; the breakdown question gets "Change it", and that run ends
  // with a question and no record_tickets: the old ticket does not send the card to Issues.
  await answerNext(s.id, /shared understanding/);
  const ask = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "decision" && /seam/.test(p.title)));
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: ask.id, value: ask.options[0] })).status, 200);
  const breakdown = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "decision" && /Approve:/.test(p.title)));
  assert.equal((await summary(s.id)).activity?.startsWith("#"), false, "the To do card names no ticket");
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: breakdown.id, value: "Change it" })).status, 200);
  await waitFor(async () => mock.requests.some((x) => JSON.stringify(x.messages ?? []).includes("Change it")));
  await waitFor(async () => (await summary(s.id)).status === "idle");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await summary(s.id)).phase, "tickets");
  assert.equal(await columnOf(s.id), "todo");

  // The user replies; the new breakdown is recorded, and only then the card waits in Issues.
  assert.equal((await api("POST", `/api/sessions/${s.id}/prompt`, { message: "/skill:to-tickets Keep the breakdown as it is." })).status, 200);
  await answerNext(s.id, /Approve:/);
  const ready = await waitFor(async () => {
    const x = await summary(s.id);
    return x.phase === "ready" && x;
  });
  assert.deepEqual(ready.tickets.map((t: any) => t.title), ["Write hello.txt", "Add a test", "Add docs"]);
  assert.equal(await columnOf(s.id), "issues");
});

test("a resumed card with no ticket to start says which tickets are blocked, and whether others wait on them", { skip: !hasPi && "pi CLI not found" }, async () => {
  const resumedFlag = async (number: number, subs: any[]) => {
    gh.seedSubIssues("kevin", "demo", { number, title: `Blocked ${number}`, body: "## Solution\nSomething." }, subs);
    const s = (await api("POST", "/api/sessions", { repoId: "kevin/demo", title: `Blocked ${number}`, issueRef: `kevin/demo#${number}`, mode: "pipeline", startFrom: "tickets" })).json;
    await waitFor(async () => (await board()).find((c) => c.id === s.id && c.attention));
    assert.equal((await api("POST", `/api/sessions/${s.id}/move`, { column: "issues" })).status, 200);
    assert.equal((await api("POST", `/api/sessions/${s.id}/move`, { column: "doing" })).status, 200);
    return (await waitFor(async () => (await board()).find((c) => c.id === s.id && c.attention))).attention;
  };
  // The only remaining ticket is the blocked one itself.
  assert.equal(await resumedFlag(90, [{ number: 91, title: "Do it", body: "Do it. BLOCKME" }]), "No ticket can start: every remaining ticket is blocked (#1).");
  // Ticket 2 waits on the blocked ticket 1.
  assert.equal(
    await resumedFlag(92, [
      { number: 93, title: "Do it", body: "Do it. BLOCKME" },
      { number: 94, title: "Then this", body: "After it.", blockedBy: [93] },
    ]),
    "No ticket can start: every remaining ticket is blocked or waits on a blocked one (#1).",
  );
});

test("two moves of one unclaimed card at once make one session: the second is refused", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.seedSubIssues("kevin", "demo", { number: 100, title: "Twice", body: "## Solution\nOnce." }, [{ number: 101, title: "Do it", body: "Do it." }]);
  const move = () => api("POST", "/api/repos/kevin/demo/issues/100/move", { column: "doing" });
  const both = await Promise.all([move(), move()]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], JSON.stringify(both.map((r) => r.json)));
  const sessions = (await api("GET", "/api/sessions")).json.filter((x: any) => x.issueRef === "kevin/demo#100");
  assert.equal(sessions.length, 1);
  // Once the first move made its session, the card is claimed and a later move is refused too.
  assert.equal((await move()).status, 409);
});

test("a new session on an issue a card already works on is refused, from the session form as from a move", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.seedSubIssues("kevin", "demo", { number: 110, title: "Claimed", body: "## Solution\nOnce." }, [{ number: 111, title: "Do it", body: "Do it." }]);
  const create = () => api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Claimed", issueRef: "kevin/demo#110", mode: "pipeline", startFrom: "tickets" });
  const both = await Promise.all([create(), create()]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], JSON.stringify(both.map((r) => r.json)));
  assert.equal((await api("GET", "/api/sessions")).json.filter((x: any) => x.issueRef === "kevin/demo#110").length, 1);
  // Claimed now: a later session for it, in another ref form, and a move of its card, are refused too.
  assert.equal((await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Again", prompt: "work on it", issueRef: "https://github.com/kevin/demo/issues/110" })).status, 409);
  assert.equal((await api("POST", "/api/repos/kevin/demo/issues/110/move", { column: "doing" })).status, 409);
  const mine = (await api("GET", "/api/sessions")).json.find((x: any) => x.issueRef === "kevin/demo#110");
  assert.equal((await api("POST", `/api/sessions/${mine.id}/stop`, {})).status, 200);
});

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

test("an unclaimed spec issue shows in Issues; its move to Doing solves its tickets, its move to To do reworks it", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.seedSubIssues("kevin", "demo", { number: 50, title: "Old spec", body: "## Solution\nold.txt says Old." }, [
    { number: 51, title: "Write old.txt", body: "Create old.txt containing Old." },
    { number: 52, title: "Check old.txt", body: "Check it.", blockedBy: [51] },
    { number: 53, title: "A solved ticket", body: "Done already.", state: "CLOSED" },
  ]);
  gh.seedSubIssues("kevin", "demo", { number: 60, title: "Rework me", body: "## Solution\nre.txt says Re." }, [{ number: 61, title: "Write re.txt", body: "Create re.txt." }]);
  // A spec whose tickets are all closed is no card.
  gh.seedSubIssues("kevin", "demo", { number: 70, title: "All solved", body: "Done." }, [{ number: 71, title: "Solved", body: "x", state: "CLOSED" }]);
  const unclaimed = (await board()).filter((c) => c.id.startsWith("issue:"));
  // The specs a session already claims (#7, #20, #30, #40, #70) are left out; the plain open issues
  // (#1-#3) show in Issues; the ticketed specs show in Issues too. The list is in GitHub's
  // `UPDATED_AT` order, not a contract: assert the set and each card's shape.
  assert.deepEqual(unclaimed.map((c: any) => c.id).sort(), ["issue:1", "issue:2", "issue:3", "issue:50", "issue:60"].sort());
  const of = (n: number) => unclaimed.find((c: any) => c.id === `issue:${n}`)!;
  for (const [n, title] of [[1, "Add dark mode"], [2, "Fix login Crash"], [3, "Docs: setup guide"]]) {
    assert.deepEqual([of(n).title, of(n).column, of(n).tickets, of(n).attention, of(n).pr, of(n).specRef, of(n).doneAt, of(n).specCard, of(n).subs], [
      title, "issues", { done: 0, total: 0 }, null, null, `https://github.com/kevin/demo/issues/${n}`, null, false, null,
    ]);
  }
  assert.deepEqual([of(50).title, of(50).column, of(50).tickets, of(50).attention, of(50).pr, of(50).specRef, of(50).doneAt, of(50).specCard, of(50).subs], [
    "Old spec", "issues", { done: 0, total: 2 }, null, null, "https://github.com/kevin/demo/issues/50", null, true, null,
  ]);
  assert.deepEqual([of(60).title, of(60).column, of(60).tickets, of(60).attention, of(60).pr, of(60).specRef, of(60).doneAt, of(60).specCard, of(60).subs], [
    "Rework me", "issues", { done: 0, total: 1 }, null, null, "https://github.com/kevin/demo/issues/60", null, true, null,
  ]);
  // The ticket sub-issues (#51, #52) are never cards of their own.
  assert.ok(!unclaimed.some((c) => c.id === "issue:51" || c.id === "issue:52"));
  const move = (number: number, column: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/repos/kevin/demo/issues/${number}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ column }),
    }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => null)) as any }));

  // A move with no command, and a move from another site, are refused; the card stays.
  assert.equal((await move(50, "review")).status, 409);
  assert.equal((await move(50, "doing", { Origin: "http://evil.example" })).status, 403);
  assert.ok((await board()).some((c) => c.id === "issue:50"));

  const events = await boardEvents();
  // Unclaimed → Doing is Solve all: a session from the spec's open tickets, and it is now that session's card.
  const solved = await move(50, "doing");
  assert.equal(solved.status, 200, JSON.stringify(solved.json));
  assert.equal(solved.json.issueRef, "kevin/demo#50");
  assert.equal(solved.json.title, "Old spec");
  assert.deepEqual(solved.json.tickets.map((t: any) => t.title), ["Write old.txt", "Check old.txt"]);
  assert.ok(!(await board()).some((c) => c.id === "issue:50"), "the unclaimed card is gone");
  // The demo repo sets up first (To do), then the tickets run in Doing.
  const card = await waitFor(async () => (await board()).find((c) => c.id === solved.json.id && c.column === "doing"));
  assert.equal(card.specRef, "https://github.com/kevin/demo/issues/50");
  await waitFor(() => events.seen.length >= 1);
  assert.equal(events.seen[0], "kevin/demo");

  // A claimed spec issue has no unclaimed card to move.
  assert.equal((await move(50, "todo")).status, 409);

  // Unclaimed → To do: a pipeline session on the spec issue grills in rework mode on that spec.
  const reworked = await move(60, "todo");
  assert.equal(reworked.status, 200, JSON.stringify(reworked.json));
  assert.equal(reworked.json.mode, "pipeline");
  assert.equal(reworked.json.specRef, "https://github.com/kevin/demo/issues/60");
  assert.equal(reworked.json.title, "Rework me");
  assert.deepEqual(reworked.json.tickets, [], "the tickets come from the reworked breakdown, not the old one");
  assert.equal(await columnOf(reworked.json.id), "todo");
  await waitFor(async () => (await summary(reworked.json.id)).phase === "grill");
  assert.ok(!(await board()).some((c) => c.id === "issue:60"));
  const decision = await waitFor(async () => (await summary(reworked.json.id)).pending.find((p: any) => p.kind === "decision"));
  assert.match(decision.title, /shared understanding/);
  const reworkRuns = mock.requests.map((r) => JSON.stringify(r.messages ?? [])).filter((m) => m.includes("Rework the spec (https://github.com/kevin/demo/issues/60)"));
  assert.ok(reworkRuns.length > 0, "the grill gets the rework prompt on the spec issue");
  assert.ok(!reworkRuns.some((m) => m.includes("grill-with-docs → to-spec → to-tickets → implement")), "not a fresh grill of a new feature");
  // The spec is grilled again, so the session holds no spec text yet, as after a rework move.
  assert.equal((await summary(reworked.json.id)).spec, null);
  await waitFor(() => events.seen.length >= 2);

  // A card made with New card announces itself; a direct session is a card too, and it announces itself.
  const before = events.seen.length;
  await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Quick two", prompt: "hi", mode: "direct" });
  const fresh = (await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Wave goodbye", prompt: "wave goodbye" })).json;
  assert.ok(fresh.id);
  await waitFor(() => events.seen.length >= before + 2);
  assert.deepEqual(events.seen.slice(before), ["kevin/demo", "kevin/demo"]);
  events.close();
  // Fewer live pi processes for the tests after this one.
  for (const s of (await api("GET", "/api/sessions")).json) await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("a plain card's move to Doing makes the issue the card's only ticket: the run gets its title, body and URL, and the PR closes the issue", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "solved");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/solved" })).status, 200);
  const col = async (id: string) => (await board("kevin/solved")).find((c) => c.id === id)?.column;
  // A fresh repo has no setup marker, so Solve runs setup first and then reaches implement.
  const r = await api("POST", "/api/repos/kevin/solved/issues/2/move", { column: "doing" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = r.json;
  assert.equal(s.mode, "pipeline");
  assert.equal(s.title, "Fix login Crash");
  assert.equal(s.issueRef, "kevin/solved#2");
  assert.equal(s.phase, "setup");
  assert.deepEqual(s.tickets.map((t: any) => [t.num, t.title, t.trackerRef]), [[1, "Fix login Crash", "2"]], "the issue is the card's only ticket");
  assert.equal(s.spec, "The app crashes when the login page is reloaded.");
  assert.equal(s.specRef, "https://github.com/kevin/solved/issues/2");
  assert.equal(await col(s.id), "todo", "setup runs in To do first");
  assert.ok(!(await board("kevin/solved")).some((c) => c.id === "issue:2"), "the unclaimed card is gone");

  // After setup, the card reaches Doing and the single ticket runs.
  await waitFor(async () => (await summary(s.id)).phase === "implement");
  assert.equal(await col(s.id), "doing");
  await waitFor(() => mock.requests.some((x) => JSON.stringify(x.messages ?? []).includes("Ticket #1: Fix login Crash")));
  // The ticket run's prompt has the issue's title, body and URL.
  const prompt = JSON.stringify(mock.requests.find((x) => JSON.stringify(x.messages ?? []).includes("Ticket #1: Fix login Crash")).messages);
  assert.ok(prompt.includes("The app crashes when the login page is reloaded."), "the issue's body in the ticket section");
  assert.ok(prompt.includes("https://github.com/kevin/solved/issues/2"), "the issue's URL in the Spec section");
  // The single ticket finishes quickly (no BLOCKME/PUSHME words in its body); the review's
  // `git push` waits on a permission in QA.
  const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  assert.equal(await col(s.id), "qa");
  assert.equal((await summary(s.id)).tickets[0].status, "done");
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: perm.id, value: perm.options[0] })).status, 200);
  // After the review, the PR opens; it closes the issue with exactly one Closes line.
  await waitFor(async () => (await summary(s.id)).phase === "pr");
  assert.equal(await col(s.id), "review");
  const pr = gh.pulls.at(-1);
  assert.match(pr.body, /Closes #2/);
  assert.equal((pr.body.match(/Closes #2/g) ?? []).length, 1, "exactly one Closes line for the issue");
  await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("a plain card's move to To do splits the issue into tickets: on an un-setup repo it runs setup first, then the breakdown is recorded and the card waits in Issues for Solve all", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "split");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/split" })).status, 200);
  const col = async (id: string) => (await board("kevin/split")).find((c) => c.id === id)?.column;
  // A plain issue of the fresh repo, moved to To do: a pipeline session on it, setup first.
  const r = await api("POST", "/api/repos/kevin/split/issues/3/move", { column: "todo" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = r.json;
  assert.equal(s.mode, "pipeline");
  assert.equal(s.title, "Docs: setup guide");
  assert.equal(s.issueRef, "kevin/split#3");
  assert.equal(s.phase, "setup");
  assert.deepEqual(s.tickets, [], "no tickets until the split is recorded");
  assert.equal(s.spec, "Write a setup guide for fresh installs.");
  assert.equal(s.specRef, "https://github.com/kevin/split/issues/3");
  assert.ok(!(await board("kevin/split")).some((c) => c.id === "issue:3"), "the unclaimed card is gone");

  // The split prompt is held for the tickets phase; setup runs in To do first.
  await waitFor(async () => (await summary(s.id)).phase === "tickets");
  const promptReq = await waitFor(() => mock.requests.find((x) => JSON.stringify(x.messages ?? []).includes("Split the issue (https://github.com/kevin/split/issues/3)")));
  const text = JSON.stringify(promptReq.messages);
  assert.match(text, /<skill name=\\"to-tickets\\"[^]*Split the issue \(https:\/\/github\.com\/kevin\/split\/issues\/3\)/);
  assert.match(text, /sub-issue/i, "publishes the tickets as sub-issues of the issue");
  assert.match(text, /blocking/i, "keeps the tickets' blocking edges");
  assert.match(text, /ask_user/);
  const ask = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "decision" && /Approve:/.test(p.title)));
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: ask.id, value: ask.options[0] })).status, 200);

  // The recorded breakdown makes the card a spec card in Issues, phase ready.
  await waitFor(async () => (await summary(s.id)).phase === "ready");
  assert.equal(await col(s.id), "issues");
  assert.deepEqual((await summary(s.id)).tickets.map((t: any) => t.title), ["Write hello.txt", "Add a test", "Add docs"]);

  // Solve all starts the first ticket.
  assert.equal((await api("POST", `/api/sessions/${s.id}/move`, { column: "doing" })).status, 200);
  await waitFor(async () => (await summary(s.id)).tickets[0]?.status === "running");
  assert.equal(await col(s.id), "doing");
  await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("a plain card's Grill grills the issue from its title and body: the session claims the card, runs the pipeline, and its PR closes the issue", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "grilled");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/grilled" })).status, 200);
  const col = async (id: string) => (await board("kevin/grilled")).find((c) => c.id === id)?.column;
  const grill = () => api("POST", "/api/repos/kevin/grilled/issues/2/grill", {});

  // Grill on the plain issue card: a pipeline session on the issue, setup first on a fresh worktree.
  const r = await grill();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = r.json;
  assert.equal(s.mode, "pipeline");
  assert.equal(s.title, "Fix login Crash");
  assert.equal(s.issueRef, "kevin/grilled#2");
  assert.equal(s.phase, "setup");
  assert.deepEqual(s.tickets, [], "no tickets until the breakdown is recorded");
  assert.equal(s.spec, null, "the grill writes the spec; the issue body is not it");
  assert.equal(s.specRef, null, "the issue is the origin issue, not the spec issue");
  assert.equal(await col(s.id), "todo", "a grilling card sits in To do");
  assert.ok(!(await board("kevin/grilled")).some((c) => c.id === "issue:2"), "the unclaimed card is gone");

  // A second claim of the same issue is refused: another Grill, a new session, and the card's move.
  assert.equal((await grill()).status, 409);
  assert.equal((await api("POST", "/api/sessions", { repoId: "kevin/grilled", title: "again", prompt: "work", issueRef: "kevin/grilled#2" })).status, 409);
  assert.equal((await api("POST", "/api/repos/kevin/grilled/issues/2/move", { column: "doing" })).status, 409);

  // The grill prompt carries the issue's title, body and URL. Setup releases the held prompt as it
  // is, so pi sees one grill skill call and one pipeline instruction block.
  const promptReq = await waitFor(() => mock.requests.find((x) => JSON.stringify(x.messages ?? []).includes("Issue #2 (https://github.com/kevin/grilled/issues/2)")));
  const released = (promptReq.messages ?? []).filter((m: any) => m.role === "user").at(-1)?.content;
  const grillText = typeof released === "string" ? released : ((released ?? []) as any[]).map((c) => c.text ?? "").join("");
  assert.match(grillText, /^<skill name="grill-with-docs"[^>]*>/, "pi expanded the grill skill call");
  assert.ok(!grillText.includes("/skill:grill-with-docs"), "the held grill prompt is not wrapped in the grill prompt a second time");
  assert.equal((grillText.match(/\[pi-workbench pipeline:/g) ?? []).length, 1, "one pipeline instruction block");
  assert.ok(grillText.includes("Issue #2 (https://github.com/kevin/grilled/issues/2)"), "the issue's URL");
  assert.ok(grillText.includes("Fix login Crash"), "the issue's title");
  assert.ok(grillText.includes("The app crashes when the login page is reloaded."), "the issue's body");

  // The card runs the normal pipeline: grill, spec, tickets, then it waits in Issues for Solve all.
  await waitFor(async () => (await summary(s.id)).phase === "grill");
  assert.equal(await col(s.id), "todo");
  await answerNext(s.id, /shared understanding/);
  await waitFor(async () => (await summary(s.id)).phase === "spec");
  await answerNext(s.id, /seam/);
  await waitFor(async () => (await summary(s.id)).phase === "tickets");
  await answerNext(s.id, /Approve:/);
  await waitFor(async () => (await summary(s.id)).phase === "ready");
  assert.equal(await col(s.id), "issues", "the breakdown waits for Solve all");
  assert.deepEqual((await summary(s.id)).tickets.map((t: any) => t.title), ["Write hello.txt", "Add a test", "Add docs"]);

  // Solve all works the tickets to the review; every decision and permission is answered here, and
  // the mock's blocked ticket is marked done so the review runs.
  assert.equal((await api("POST", `/api/sessions/${s.id}/move`, { column: "doing" })).status, 200);
  const sum = await waitFor(async () => {
    const x = await summary(s.id);
    if (x.phase === "pr") return x;
    const p = x.pending[0];
    if (p) assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: p.id, value: p.options[0] })).status, 200);
    else if (x.attention && x.tickets.some((t: any) => t.status === "blocked"))
      assert.equal((await api("POST", `/api/sessions/${s.id}/pipeline`, { action: "skip" })).status, 200);
    return undefined;
  }, 240_000);
  assert.equal(await col(s.id), "review");

  // The PR the pipeline opened closes the origin issue, and nothing else.
  const pr = gh.pulls.at(-1);
  assert.equal(pr.head, sum.branch);
  assert.deepEqual([...pr.body.matchAll(/Closes #(\d+)/g)].map((m) => Number(m[1])), [2], "one Closes line: the origin issue");
  await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("Grill is refused (409) on a spec issue, which has its open ticket sub-issues, and on a sub-issue's number", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "grilled2");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/grilled2" })).status, 200);
  gh.seedSubIssues("kevin", "grilled2", { number: 10, title: "Spec", body: "## Solution\nSpec." }, [{ number: 11, title: "A ticket", body: "Do it." }]);
  for (const [number, why] of [[10, "a spec issue with open ticket sub-issues"], [11, "a sub-issue, which its spec's card owns"]] as const) {
    const r = await api("POST", `/api/repos/kevin/grilled2/issues/${number}/grill`, {});
    assert.equal(r.status, 409, `${why}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, /issue/i);
  }
  // Both cards are untouched.
  const numbers = (cards: any[]) => cards.filter((c) => c.id.startsWith("issue:")).map((c: any) => Number(c.id.slice(6))).sort((a, b) => a - b);
  assert.deepEqual(numbers(await board("kevin/grilled2")), [1, 2, 3, 10], "both cards are untouched");
});

test("a move of a sub-issue's number is refused (409): its spec's card owns it, for Doing and for To do", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.seedSubIssues("kevin", "demo", { number: 160, title: "Owned", body: "## Solution\nOwned." }, [{ number: 161, title: "Do it", body: "Do it." }]);
  const move = (number: number, column: string) =>
    fetch(`${base}/api/repos/kevin/demo/issues/${number}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ column }),
    }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => null)) as any }));
  for (const column of ["doing", "todo"]) {
    const r = await move(161, column);
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.match(r.json.error, /sub-issue/);
  }
  // The spec's card is untouched by the refused moves.
  assert.ok((await board()).some((c) => c.id === "issue:160"));
  // A plain issue with a parent number seeded in the feed is refused too.
  gh.issues.push({ owner: "kevin", name: "demo", number: 162, title: "Parented plain", body: "x", state: "open", labels: [], assignees: [], updated_at: "2025-01-01T00:00:00Z", html_url: "https://github.com/kevin/demo/issues/162", parent_number: 160 });
  assert.equal((await move(162, "doing")).status, 409);
  assert.equal((await move(162, "todo")).status, 409);
  // Claim the spec card away, so the tests after this one see the same unclaimed set.
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Owned spec", prompt: "work on 160", issueRef: "kevin/demo#160" })).json;
  assert.ok(s.id);
  await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("two Solves of one plain card at once make one session: the second is refused", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "twice");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/twice" })).status, 200);
  const move = () => api("POST", "/api/repos/kevin/twice/issues/1/move", { column: "doing" });
  const both = await Promise.all([move(), move()]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], JSON.stringify(both.map((r) => r.json)));
  const sessions = (await api("GET", "/api/sessions")).json.filter((x: any) => x.issueRef === "kevin/twice#1");
  assert.equal(sessions.length, 1);
  // Once the first Solve made its session, the card is claimed and a later Solve is refused too.
  assert.equal((await move()).status, 409);
  await api("POST", `/api/sessions/${sessions[0].id}/stop`, {});
});

test("a plain open issue is a card in Issues: a sub-issue is no card, a claimed one too, and moves to QA, Review or Done are refused", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "plain");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/plain" })).status, 200);
  // The mock seeds this repo's plain open issues #1-#3; a ticketed spec sits on top of them.
  gh.seedSubIssues("kevin", "plain", { number: 4, title: "Plain spec", body: "## Solution\np.txt says P." }, [{ number: 5, title: "Write p.txt", body: "Create p.txt." }]);
  const boardOf = async (repo: string) => {
    const r = await api("GET", `/api/board?repo=${repo}`);
    assert.equal(r.status, 200);
    return r.json.cards as any[];
  };
  const move = (number: number, column: string) =>
    fetch(`${base}/api/repos/kevin/plain/issues/${number}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ column }),
    }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => null)) as any }));

  // A plain open issue shows in Issues; a ticketed spec in Issues too; no card for the ticket sub-issue.
  // The order is GitHub's `UPDATED_AT` order, not a contract: assert the set and the per-card shape.
  const unclaimed = (await boardOf("kevin/plain")).filter((c) => c.id.startsWith("issue:"));
  assert.deepEqual(unclaimed.map((c: any) => c.id).sort(), ["issue:1", "issue:2", "issue:3", "issue:4"].sort());
  const by = (n: number) => unclaimed.find((c: any) => c.id === `issue:${n}`)!;
  assert.equal(by(1).title, "Add dark mode");
  assert.equal(by(2).title, "Fix login Crash");
  assert.equal(by(3).title, "Docs: setup guide");
  assert.equal(by(4).title, "Plain spec");
  for (const n of [1, 2, 3]) {
    assert.deepEqual(
      [by(n).column, by(n).tickets, by(n).attention, by(n).pr, by(n).specRef, by(n).doneAt, by(n).specCard, by(n).subs],
      ["issues", { done: 0, total: 0 }, null, null, `https://github.com/kevin/plain/issues/${n}`, null, false, null],
    );
  }
  assert.deepEqual(
    [by(4).column, by(4).tickets, by(4).attention, by(4).pr, by(4).specRef, by(4).doneAt, by(4).specCard, by(4).subs],
    ["issues", { done: 0, total: 1 }, null, null, "https://github.com/kevin/plain/issues/4", null, true, null],
  );
  assert.ok(!unclaimed.some((c) => c.id === "issue:5"), "a ticket sub-issue is never a card of its own");

  // Moves to QA, Review or Done are refused, and the card stays.
  for (const column of ["qa", "review", "done"]) assert.equal((await move(1, column)).status, 409);
  assert.ok((await boardOf("kevin/plain")).some((c) => c.id === "issue:1"));

  // A session that claims a plain issue takes its card off the board.
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/plain", title: "Claim 2", prompt: "work on 2", issueRef: "kevin/plain#2" })).json;
  assert.ok(s.id);
  assert.ok(!(await boardOf("kevin/plain")).filter((c) => c.id.startsWith("issue:")).some((c) => c.id === "issue:2"));

  // A ticketed spec card still moves to Doing (Solve all) and to To do (rework).
  assert.equal((await move(4, "doing")).status, 200);
  assert.equal((await move(4, "todo")).status, 409, "a claimed spec card is refused");

  await api("POST", `/api/sessions/${s.id}/stop`, {});
  const solver = (await api("GET", "/api/sessions")).json.find((x: any) => x.issueRef === "kevin/plain#4");
  assert.equal((await api("POST", `/api/sessions/${solver.id}/stop`, {})).status, 200);
});

test("a card's spec issue, in any ref form to-spec gives, is claimed: no unclaimed card for it", { skip: !hasPi && "pi CLI not found" }, async () => {
  for (const n of [80, 81, 82, 83, 84]) {
    gh.seedSubIssues("kevin", "demo", { number: n, title: `Spec ${n}`, body: "## Solution\nSomething." }, [{ number: n + 100, title: "Do it", body: "Do it." }]);
  }
  const unclaimed = async () => (await board()).filter((c) => c.id.startsWith("issue:")).map((c) => c.id);
  // The plain open issues of this repo (#1-#3) show too. The order is GitHub's `UPDATED_AT` order,
  // not a contract: assert the set.
  assert.deepEqual([...(await unclaimed())].sort(), ["issue:1", "issue:2", "issue:3", "issue:80", "issue:81", "issue:82", "issue:83", "issue:84"].sort());
  // A session made from an issue claims it by its issue ref.
  const fromIssue = (await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "From 84", prompt: "work on 84", issueRef: "kevin/demo#84" })).json;
  assert.ok(fromIssue.id);
  assert.equal((await api("POST", `/api/sessions/${fromIssue.id}/stop`, {})).status, 200);
  // Cards whose to-spec published the spec as an issue claim it by the spec ref.
  for (const ref of ["#80", "https://github.com/kevin/demo/issues/81", "82", "kevin/other#83"]) {
    const created = await api("POST", "/api/sessions", { repoId: "kevin/demo", title: `Spec at ${ref}`, prompt: `build it SPEC_REF=${ref}` });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const s = created.json;
    await answerNext(s.id, /shared understanding/);
    await waitFor(async () => (await summary(s.id)).phase === "spec");
    await answerNext(s.id, /seam/);
    await waitFor(async () => (await summary(s.id)).specRef === ref);
    assert.equal((await api("POST", `/api/sessions/${s.id}/stop`, {})).status, 200);
  }
  // #83 is in another repo's ref, so this repo's #83 stays unclaimed; the plain issues show too.
  assert.deepEqual([...(await unclaimed())].sort(), ["issue:1", "issue:2", "issue:3", "issue:83"].sort());
});

test("Solve is refused: an open blocker (409, named), a card not in ready (409), and a done or blocked ticket", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "solo2");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/solo2" })).status, 200);
  const col = columnOfCard("kevin/solo2");

  // A card still being planned (To do) is refused.
  const planned = (await api("POST", "/api/sessions", { repoId: "kevin/solo2", title: "Planned", prompt: "add a plan" })).json;
  assert.equal(planned.phase, "setup");
  assert.equal(await col(planned.id), "todo");
  const plannedRefused = await api("POST", `/api/sessions/${planned.id}/tickets/1/solve`, {});
  assert.equal(plannedRefused.status, 409, JSON.stringify(plannedRefused.json));

  // A full pipeline card: grill → spec → tickets → ready, with the mock's three tickets
  // (1: PUSHME, 2: blocked by 1, 3: BLOCKME and blocked by 1).
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/solo2", title: "Refused", prompt: "add a refusal" })).json;
  await answerNext(s.id, /shared understanding/);
  await waitFor(async () => (await summary(s.id)).phase === "spec");
  await answerNext(s.id, /seam/);
  await waitFor(async () => (await summary(s.id)).phase === "tickets");
  await answerNext(s.id, /Approve/);
  await waitFor(async () => (await summary(s.id)).phase === "ready");
  assert.equal(await col(s.id), "issues");

  // A ticket with an open blocker is refused, and the blocker is named.
  const refused = await api("POST", `/api/sessions/${s.id}/tickets/2/solve`, {});
  assert.equal(refused.status, 409, JSON.stringify(refused.json));
  assert.match(refused.json.error, /blocked by #1/);

  // While ticket 1 runs, the card is not in ready: Solve is refused.
  assert.equal((await api("POST", `/api/sessions/${s.id}/tickets/1/solve`, {})).status, 200);
  const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  const refusedNow = await api("POST", `/api/sessions/${s.id}/tickets/2/solve`, {});
  assert.equal(refusedNow.status, 409, JSON.stringify(refusedNow.json));
  assert.match(refusedNow.json.error, /runs now/);
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: perm.id, value: perm.options[0] })).status, 200);
  await waitFor(async () => (await summary(s.id)).phase === "ready");
  // A done ticket is refused.
  const doneRefused = await api("POST", `/api/sessions/${s.id}/tickets/1/solve`, {});
  assert.equal(doneRefused.status, 409, JSON.stringify(doneRefused.json));
  assert.match(doneRefused.json.error, /is done/);
  // Ticket 3 blocks: the card flags in Doing, and Solve of it is refused there too.
  assert.equal((await api("POST", `/api/sessions/${s.id}/tickets/3/solve`, {})).status, 200);
  await waitFor(async () => (await summary(s.id)).attention);
  assert.equal(await col(s.id), "doing");
  const blockedRefused = await api("POST", `/api/sessions/${s.id}/tickets/3/solve`, {});
  assert.equal(blockedRefused.status, 409, JSON.stringify(blockedRefused.json));
  // A blocked ticket on a card in Issues is refused for being blocked.
  assert.equal((await api("POST", `/api/sessions/${s.id}/move`, { column: "issues" })).status, 200);
  await waitFor(async () => (await summary(s.id)).phase === "ready");
  const blockedRefused2 = await api("POST", `/api/sessions/${s.id}/tickets/3/solve`, {});
  assert.equal(blockedRefused2.status, 409, JSON.stringify(blockedRefused2.json));
  assert.match(blockedRefused2.json.error, /is blocked$/);
  // An unknown ticket number is refused too.
  assert.equal((await api("POST", `/api/sessions/${s.id}/tickets/9/solve`, {})).status, 409);
  await api("POST", `/api/sessions/${planned.id}/stop`, {});
  await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("Solve one ticket on a ready card runs only that ticket, then pauses the card in Issues", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "solo1");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/solo1" })).status, 200);
  const col = columnOfCard("kevin/solo1");
  gh.seedSubIssues("kevin", "solo1", { number: 1, title: "Solo one", body: "## Solution\nones.txt says One." }, [
    { number: 2, title: "Write ones.txt", body: "Create ones.txt containing One. PUSHME" },
    { number: 3, title: "Test ones.txt", body: "Test it.", blockedBy: [2] },
    { number: 4, title: "Push ones.txt", body: "Push it.", blockedBy: [3] },
  ]);
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/solo1", title: "Solo one", issueRef: "kevin/solo1#1", mode: "pipeline", startFrom: "tickets" })).json;
  // Setup runs in To do, then the first ticket runs in Doing; its `git push` waits on a permission.
  const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  assert.equal(await col(s.id), "doing");
  // A move back to Issues stops the run: ticket 1 is left `running`, tickets 2 and 3 wait.
  assert.equal((await api("POST", `/api/sessions/${s.id}/move`, { column: "issues" })).status, 200);
  await waitFor(async () => (await summary(s.id)).status === "stopped");
  const paused = await summary(s.id);
  assert.equal(paused.phase, "ready");
  assert.deepEqual(paused.tickets.map((t: any) => t.status), ["running", "ready", "ready"]);
  const firstRun = paused.tickets[0].runId;
  const t1Runs = ticketRunStarts(1);
  const t2Runs = ticketRunStarts(2);
  const t3Runs = ticketRunStarts(3);

  // Solve ticket 1: the card goes to Doing and the ticket a stopped run left `running` gets a fresh run.
  const solve = await api("POST", `/api/sessions/${s.id}/tickets/1/solve`, {});
  assert.equal(solve.status, 200, JSON.stringify(solve.json));
  assert.equal(solve.json.phase, "implement");
  assert.equal(await col(s.id), "doing");
  const running = await waitFor(async () => {
    const x = await summary(s.id);
    return x.tickets[0].status === "running" && x.activeRun === x.tickets[0].runId ? x : undefined;
  });
  assert.notEqual(running.tickets[0].runId, firstRun, "a fresh run for the stopped ticket");
  // Only ticket 1 runs: tickets 2 and 3 do not start.
  const perm2 = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: perm2.id, value: perm2.options[0] })).status, 200);
  // When ticket 1 is done, the card pauses in Issues: 1 of 3 done, no attention, the solo ticket cleared.
  const back = await waitFor(async () => {
    const x = await summary(s.id);
    return x.phase === "ready" ? x : undefined;
  });
  assert.equal(await col(s.id), "issues");
  assert.equal(back.soloTicket, null);
  assert.equal(back.attention, null);
  assert.deepEqual(back.tickets.map((t: any) => t.status), ["done", "ready", "ready"]);
  assert.equal(ticketRunStarts(1), t1Runs + 1, "the solved ticket ran once more");
  assert.equal(ticketRunStarts(2), t2Runs, "ticket 2 did not start");
  assert.equal(ticketRunStarts(3), t3Runs, "ticket 3 did not start");
  await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("Solve all after a solved ticket runs only the other tickets, then review and PR", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "solo3");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/solo3" })).status, 200);
  const col = columnOfCard("kevin/solo3");
  gh.seedSubIssues("kevin", "solo3", { number: 1, title: "Solo three", body: "## Solution\nthree.txt says Three." }, [
    { number: 2, title: "Write three.txt", body: "Create three.txt containing Three. PUSHME" },
    { number: 3, title: "Test three.txt", body: "Test it.", blockedBy: [2] },
    { number: 4, title: "More three.txt", body: "More.", blockedBy: [2] },
  ]);
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/solo3", title: "Solo three", issueRef: "kevin/solo3#1", mode: "pipeline", startFrom: "tickets" })).json;
  const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  assert.equal((await api("POST", `/api/sessions/${s.id}/move`, { column: "issues" })).status, 200);
  await waitFor(async () => (await summary(s.id)).status === "stopped");
  // Solve the first ticket on the paused card; it runs to done and the card pauses in Issues.
  assert.equal((await api("POST", `/api/sessions/${s.id}/tickets/1/solve`, {})).status, 200);
  const perm2 = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  await api("POST", `/api/sessions/${s.id}/respond`, { requestId: perm2.id, value: perm2.options[0] });
  await waitFor(async () => (await summary(s.id)).phase === "ready");
  assert.equal(await col(s.id), "issues");
  const t1Runs = ticketRunStarts(1);
  const t2Runs = ticketRunStarts(2);
  const t3Runs = ticketRunStarts(3);

  // Solve all (a move to Doing) runs the other tickets; ticket 1 does not run again.
  assert.equal((await api("POST", `/api/sessions/${s.id}/move`, { column: "doing" })).status, 200);
  const review = await waitFor(async () => {
    const x = await summary(s.id);
    return x.phase === "review" && x.pending.some((p: any) => p.kind === "permission") ? x : undefined;
  });
  assert.deepEqual(review.tickets.map((t: any) => t.status), ["done", "done", "done"]);
  assert.equal(ticketRunStarts(1), t1Runs, "the solved ticket never ran again");
  assert.ok(ticketRunStarts(2) > t2Runs, "ticket 2 ran");
  assert.ok(ticketRunStarts(3) > t3Runs, "ticket 3 ran");
  // The review's `git push` waits on a permission; the PR opens after it.
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: review.pending.find((p: any) => p.kind === "permission").id, value: "Allow" })).status, 200);
  await waitFor(async () => (await summary(s.id)).phase === "pr");
  assert.equal(await col(s.id), "review");
  assert.equal((await summary(s.id)).prNumber, gh.pulls.at(-1).number);
  await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("Solve of the last open ticket goes on to review and PR without another call", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "solo4");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/solo4" })).status, 200);
  const col = columnOfCard("kevin/solo4");
  gh.seedSubIssues("kevin", "solo4", { number: 1, title: "Solo last", body: "## Solution\nlast.txt says Last." }, [
    { number: 2, title: "Write last.txt", body: "Create last.txt containing Last. PUSHME" },
    { number: 3, title: "Check last.txt", body: "Check it." },
  ]);
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/solo4", title: "Solo last", issueRef: "kevin/solo4#1", mode: "pipeline", startFrom: "tickets" })).json;
  const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  assert.equal((await api("POST", `/api/sessions/${s.id}/move`, { column: "issues" })).status, 200);
  await waitFor(async () => (await summary(s.id)).status === "stopped");
  // Solve the first ticket; the card pauses in Issues with 1 of 2 done.
  assert.equal((await api("POST", `/api/sessions/${s.id}/tickets/1/solve`, {})).status, 200);
  const perm2 = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  await api("POST", `/api/sessions/${s.id}/respond`, { requestId: perm2.id, value: perm2.options[0] });
  await waitFor(async () => (await summary(s.id)).phase === "ready");
  assert.equal((await summary(s.id)).tickets[0].status, "done");
  // Solve the last open ticket: when it is done, the card goes on to review and PR on its own.
  assert.equal((await api("POST", `/api/sessions/${s.id}/tickets/2/solve`, {})).status, 200);
  const review = await waitFor(async () => {
    const x = await summary(s.id);
    return x.phase === "review" ? x.pending.find((p: any) => p.kind === "permission") : undefined;
  });
  const reviewSum = await summary(s.id);
  assert.deepEqual(reviewSum.tickets.map((t: any) => t.status), ["done", "done"]);
  assert.ok(review, "the review's git push waits");
  await api("POST", `/api/sessions/${s.id}/respond`, { requestId: review.id, value: "Allow" });
  await waitFor(async () => (await summary(s.id)).phase === "pr");
  assert.equal(await col(s.id), "review");
  assert.ok((await summary(s.id)).prNumber);
  await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("a solo ticket that ends blocked flags the card; Mark done pauses it in Issues", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "solo5");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/solo5" })).status, 200);
  const col = columnOfCard("kevin/solo5");
  gh.seedSubIssues("kevin", "solo5", { number: 1, title: "Solo blocked", body: "## Solution\nblocked.txt says Blocked." }, [
    { number: 2, title: "Write blocked.txt", body: "Create blocked.txt containing Blocked. PUSHME" },
    { number: 3, title: "Do it", body: "Do it. BLOCKME" },
    { number: 4, title: "Then this", body: "After it.", blockedBy: [2] },
  ]);
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/solo5", title: "Solo blocked", issueRef: "kevin/solo5#1", mode: "pipeline", startFrom: "tickets" })).json;
  const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  assert.equal((await api("POST", `/api/sessions/${s.id}/move`, { column: "issues" })).status, 200);
  await waitFor(async () => (await summary(s.id)).status === "stopped");
  // Solve the first ticket; it runs to done and the card pauses in Issues.
  assert.equal((await api("POST", `/api/sessions/${s.id}/tickets/1/solve`, {})).status, 200);
  const perm2 = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  await api("POST", `/api/sessions/${s.id}/respond`, { requestId: perm2.id, value: perm2.options[0] });
  await waitFor(async () => (await summary(s.id)).phase === "ready");
  // The solo ticket ends blocked: the card flags in Doing, as a normal blocked ticket does.
  assert.equal((await api("POST", `/api/sessions/${s.id}/tickets/2/solve`, {})).status, 200);
  const flagged = await waitFor(async () => {
    const x = await summary(s.id);
    return x.attention ? x : undefined;
  });
  assert.equal(await col(s.id), "doing");
  assert.match(flagged.attention, /Ticket #2 is blocked/);
  assert.equal(flagged.soloTicket, 2, "the solo ticket stays set while its card is flagged");
  // Mark done pauses the card in Issues, instead of going on to the next ticket.
  assert.equal((await api("POST", `/api/sessions/${s.id}/pipeline`, { action: "skip" })).status, 200);
  const paused = await summary(s.id);
  assert.equal(await col(s.id), "issues");
  assert.equal(paused.phase, "ready");
  assert.equal(paused.attention, null);
  assert.equal(paused.soloTicket, null);
  assert.deepEqual(paused.tickets.map((t: any) => t.status), ["done", "done", "ready"]);
  // Solve the third ticket; when it is done every ticket is done and the card goes on to review and PR.
  assert.equal((await api("POST", `/api/sessions/${s.id}/tickets/3/solve`, {})).status, 200);
  const review = await waitFor(async () => {
    const x = await summary(s.id);
    return x.phase === "review" && x.pending.some((p: any) => p.kind === "permission") ? x : undefined;
  });
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: review.pending.find((p: any) => p.kind === "permission").id, value: "Allow" })).status, 200);
  await waitFor(async () => (await summary(s.id)).phase === "pr");
  assert.ok((await summary(s.id)).prNumber);
  await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("Retry re-runs the solo ticket, not the lowest ready ticket, then pauses the card in Issues", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "solo6");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/solo6" })).status, 200);
  const col = columnOfCard("kevin/solo6");
  gh.seedSubIssues("kevin", "solo6", { number: 1, title: "Solo retry", body: "## Solution\nretry.txt says Retry." }, [
    { number: 2, title: "Write retry.txt", body: "Create retry.txt containing Retry. PUSHME" },
    { number: 3, title: "Check retry.txt", body: "Check it. BLOCKME" },
  ]);
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/solo6", title: "Solo retry", issueRef: "kevin/solo6#1", mode: "pipeline", startFrom: "tickets" })).json;
  const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  assert.equal((await api("POST", `/api/sessions/${s.id}/move`, { column: "issues" })).status, 200);
  await waitFor(async () => (await summary(s.id)).status === "stopped");
  const interrupted = await summary(s.id);
  const t1Run = interrupted.tickets[0].runId;
  const t1Runs = ticketRunStarts(1);
  const t2Runs = ticketRunStarts(2);
  // Solve the second ticket (the solo); it ends blocked, so the card flags for a Retry.
  assert.equal((await api("POST", `/api/sessions/${s.id}/tickets/2/solve`, {})).status, 200);
  const flagged = await waitFor(async () => {
    const x = await summary(s.id);
    return x.attention ? x : undefined;
  });
  assert.match(flagged.attention, /Ticket #2 is blocked/);
  assert.equal(flagged.soloTicket, 2);
  // Retry re-runs the solo ticket, not the lower ticket the stopped move left running; it blocks again.
  assert.equal((await api("POST", `/api/sessions/${s.id}/pipeline`, { action: "retry" })).status, 200);
  const rerun = await waitFor(async () => {
    const x = await summary(s.id);
    return x.tickets[1].status === "running" && x.activeRun === x.tickets[1].runId ? x : undefined;
  });
  assert.notEqual(rerun.tickets[1].runId, flagged.tickets[1].runId, "a fresh run for the solo ticket");
  assert.equal(rerun.tickets[0].runId, t1Run, "the lower ticket's run is untouched");
  assert.equal(ticketRunStarts(1), t1Runs, "the lower ticket did not run");
  assert.equal(ticketRunStarts(2), t2Runs + 1, "the solo ticket ran once more");
  const flaggedAgain = await waitFor(async () => {
    const x = await summary(s.id);
    return x.attention ? x : undefined;
  });
  assert.match(flaggedAgain.attention, /Ticket #2 is blocked/);
  // Mark done then pauses the card in Issues, instead of going on to another ticket.
  assert.equal((await api("POST", `/api/sessions/${s.id}/pipeline`, { action: "skip" })).status, 200);
  const paused = await summary(s.id);
  assert.equal(await col(s.id), "issues");
  assert.equal(paused.phase, "ready");
  assert.equal(paused.attention, null);
  assert.equal(paused.soloTicket, null);
  assert.deepEqual(paused.tickets.map((t: any) => t.status), ["ready", "done"]);
  await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("Stop during a solo ticket clears it: a later Solve all runs every remaining ticket", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "solo7");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/solo7" })).status, 200);
  const col = columnOfCard("kevin/solo7");
  gh.seedSubIssues("kevin", "solo7", { number: 1, title: "Solo stop", body: "## Solution\nstop.txt says Stop." }, [
    { number: 2, title: "Write stop.txt", body: "Create stop.txt containing Stop. PUSHME" },
    { number: 3, title: "Test stop.txt", body: "Test it." },
    { number: 4, title: "More stop.txt", body: "More." },
  ]);
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/solo7", title: "Solo stop", issueRef: "kevin/solo7#1", mode: "pipeline", startFrom: "tickets" })).json;
  const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  assert.equal((await api("POST", `/api/sessions/${s.id}/move`, { column: "issues" })).status, 200);
  await waitFor(async () => (await summary(s.id)).status === "stopped");
  const t1Runs = ticketRunStarts(1);
  const t2Runs = ticketRunStarts(2);
  const t3Runs = ticketRunStarts(3);
  // Solve the first ticket, then stop the card while it runs.
  assert.equal((await api("POST", `/api/sessions/${s.id}/tickets/1/solve`, {})).status, 200);
  const perm2 = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  assert.equal((await api("POST", `/api/sessions/${s.id}/pipeline`, { action: "stop" })).status, 200);
  await waitFor(async () => (await summary(s.id)).status === "stopped");
  const stopped = await summary(s.id);
  assert.equal(stopped.phase, "ready");
  assert.equal(stopped.soloTicket, null, "Stop clears the solo ticket");
  assert.equal(stopped.attention, null);
  assert.deepEqual(stopped.tickets.map((t: any) => t.status), ["running", "ready", "ready"]);

  // A later Solve all runs every remaining ticket, including the stopped one, then review and PR.
  assert.equal((await api("POST", `/api/sessions/${s.id}/move`, { column: "doing" })).status, 200);
  const perm3 = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  await api("POST", `/api/sessions/${s.id}/respond`, { requestId: perm3.id, value: perm3.options[0] });
  const review = await waitFor(async () => {
    const x = await summary(s.id);
    return x.phase === "review" && x.pending.some((p: any) => p.kind === "permission") ? x : undefined;
  });
  assert.deepEqual(review.tickets.map((t: any) => t.status), ["done", "done", "done"]);
  assert.ok(ticketRunStarts(1) > t1Runs, "the stopped ticket ran again");
  assert.ok(ticketRunStarts(2) > t2Runs, "ticket 2 ran");
  assert.ok(ticketRunStarts(3) > t3Runs, "ticket 3 ran");
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: review.pending.find((p: any) => p.kind === "permission").id, value: "Allow" })).status, 200);
  await waitFor(async () => (await summary(s.id)).phase === "pr");
  assert.equal(await col(s.id), "review");
  await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("a spec's open ticket sub-issues come from the read route: number, title, URL, and their open blockers; a closed or foreign blocker is dropped", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "tickets1");
  assert.equal((await api("PUT", "/api/secrets", { scope: "global", name: "GITHUB_TOKEN", value: "ghp_test" })).status, 200);
  assert.equal((await api("PUT", "/api/settings/model", { baseUrl: mock.url })).status, 200);
  assert.equal((await api("POST", "/api/repos", { id: "kevin/tickets1" })).status, 200);
  gh.seedSubIssues("kevin", "tickets1", { number: 10, title: "Read me", body: "## Solution\nr.txt says R." }, [
    { number: 11, title: "Write r.txt", body: "Create r.txt." },
    { number: 12, title: "Then test r.txt", body: "Test it.", blockedBy: [11] },
    { number: 13, title: "Solved already", body: "Done.", state: "CLOSED" },
    { number: 14, title: "Blocks from outside", body: "x", blockedBy: [99] },
  ]);
  const r = await api("GET", "/api/repos/kevin/tickets1/issues/10/tickets");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, {
    spec: { number: 10, title: "Read me", url: "https://github.com/kevin/tickets1/issues/10" },
    subIssues: [
      { number: 11, title: "Write r.txt", url: "https://github.com/kevin/tickets1/issues/11", blockedBy: [] },
      { number: 12, title: "Then test r.txt", url: "https://github.com/kevin/tickets1/issues/12", blockedBy: [11] },
      // #13 is closed: it is not listed. #14's blocker 99 is not an open sub-issue of the spec, so it is dropped.
      { number: 14, title: "Blocks from outside", url: "https://github.com/kevin/tickets1/issues/14", blockedBy: [] },
    ],
  });
  // An unknown spec number: the GitHub module's 404 comes through.
  assert.equal((await api("GET", "/api/repos/kevin/tickets1/issues/99/tickets")).status, 404);
});

test("a sub-issue's Solve on an unclaimed spec card creates one session, runs only that ticket, and pauses in Issues; a blocked or foreign sub-issue is refused (409)", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "unsolo");
  assert.equal((await api("PUT", "/api/secrets", { scope: "global", name: "GITHUB_TOKEN", value: "ghp_test" })).status, 200);
  assert.equal((await api("PUT", "/api/settings/model", { baseUrl: mock.url })).status, 200);
  assert.equal((await api("POST", "/api/repos", { id: "kevin/unsolo" })).status, 200);
  const col = columnOfCard("kevin/unsolo");
  gh.seedSubIssues("kevin", "unsolo", { number: 20, title: "Unclaimed solo", body: "## Solution\nu.txt says U." }, [
    { number: 21, title: "Write u.txt", body: "Create u.txt containing U. PUSHME" },
    { number: 22, title: "Test u.txt", body: "Test it.", blockedBy: [21] },
    { number: 23, title: "More u.txt", body: "More." },
    { number: 24, title: "Solved already", body: "Done.", state: "CLOSED" },
  ]);
  assert.ok((await board("kevin/unsolo")).some((c) => c.id === "issue:20"), "the unclaimed card shows");
  const solve = (sub: number) => api("POST", `/api/repos/kevin/unsolo/issues/20/tickets/${sub}/solve`, {});

  // A sub-issue with an open blocker is refused (409) and names the blocker.
  const refused = await solve(22);
  assert.equal(refused.status, 409, JSON.stringify(refused.json));
  assert.match(refused.json.error, /#21/);
  // A number that is not an open sub-issue of the spec is refused too: the spec itself, a foreign one, and a closed one.
  assert.equal((await solve(20)).status, 409);
  assert.equal((await solve(99)).status, 409);
  assert.equal((await solve(24)).status, 409);
  // A :number that is itself a sub-issue is refused too: its spec's card owns it, as the move route does.
  const subAsSpec = await api("POST", "/api/repos/kevin/unsolo/issues/21/tickets/22/solve", {});
  assert.equal(subAsSpec.status, 409, JSON.stringify(subAsSpec.json));
  assert.match(subAsSpec.json.error, /sub-issue/);
  // The unclaimed card is untouched by the refused Solves.
  assert.ok((await board("kevin/unsolo")).some((c) => c.id === "issue:20"));

  // The baselines come first: earlier tests used the same local ticket numbers, and the mock
  // repeats the whole history in every request of a run.
  const t1Runs = ticketRunStarts(1);
  const t2Runs = ticketRunStarts(2);
  const t3Runs = ticketRunStarts(3);

  // The un-setup repo runs setup first (To do), then the solo ticket runs.
  const s = (await solve(21)).json;
  assert.equal(s.repoId, "kevin/unsolo");
  assert.equal(s.title, "Unclaimed solo");
  assert.equal(s.issueRef, "kevin/unsolo#20");
  assert.equal(s.phase, "setup");
  assert.equal(s.soloTicket, 1, "the sub-issue's local number");
  assert.deepEqual(s.tickets.map((t: any) => t.title), ["Write u.txt", "Test u.txt", "More u.txt"], "the closed sub-issue is not a ticket");
  assert.equal(await col(s.id), "todo", "setup runs in To do first");
  assert.ok(!(await board("kevin/unsolo")).some((c) => c.id === "issue:20"), "the unclaimed card is gone");

  await waitFor(async () => (await summary(s.id)).phase === "implement");
  assert.equal(await col(s.id), "doing");
  // The ticket is running and the run switched to it: the switch follows the ticket's status.
  const running = await waitFor(async () => {
    const x = await summary(s.id);
    return x.tickets[0].status === "running" && x.activeRun === x.tickets[0].runId ? x : undefined;
  });

  // Its `git push` waits on a permission; only when it is answered has the ticket's run reached the model.
  const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"));
  assert.ok(ticketRunStarts(1) > t1Runs, "the solo ticket ran");
  assert.equal(ticketRunStarts(2), t2Runs, "ticket 2 did not start");
  assert.equal(ticketRunStarts(3), t3Runs, "ticket 3 did not start");
  await api("POST", `/api/sessions/${s.id}/respond`, { requestId: perm.id, value: perm.options[0] });
  const back = await waitFor(async () => {
    const x = await summary(s.id);
    return x.phase === "ready" ? x : undefined;
  });
  assert.equal(await col(s.id), "issues");
  assert.equal(back.soloTicket, null);
  assert.equal(back.attention, null);
  assert.deepEqual(back.tickets.map((t: any) => t.status), ["done", "ready", "ready"], "1 of 3 done");
  await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("a Done card and a direct session do not claim their issue: the unclaimed card shows, and a new pipeline session may take it", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.seedSubIssues("kevin", "demo", { number: 140, title: "Merged once", body: "## Solution\nAgain." }, [{ number: 141, title: "Do it", body: "Do it." }]);
  gh.seedSubIssues("kevin", "demo", { number: 150, title: "Talked about", body: "## Solution\nTalk." }, [{ number: 151, title: "Do it", body: "Do it." }]);
  const unclaimed = async () => (await board()).filter((c) => c.id.startsWith("issue:")).map((c) => c.id);
  // A card on #140 reached Done; a direct session talks about #150.
  const merged = (await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Merged once", issueRef: "kevin/demo#140", mode: "pipeline", startFrom: "tickets" })).json;
  assert.ok(merged.id, JSON.stringify(merged));
  assert.equal((await api("POST", `/api/sessions/${merged.id}/stop`, {})).status, 200);
  markDone(merged.id);
  await waitFor(async () => (await summary(merged.id)).phase === "done");
  const talk = await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Talk", prompt: "what is left?", issueRef: "kevin/demo#150", mode: "direct" });
  assert.equal(talk.status, 200, JSON.stringify(talk.json));
  assert.ok((await unclaimed()).includes("issue:140"));
  assert.ok((await unclaimed()).includes("issue:150"));

  // A second direct session on #150 is allowed too, and a pipeline session may take each issue.
  assert.equal((await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Talk again", prompt: "and now?", issueRef: "kevin/demo#150", mode: "direct" })).status, 200);
  for (const n of [140, 150]) {
    const again = await api("POST", "/api/sessions", { repoId: "kevin/demo", title: `Again ${n}`, prompt: "build it", issueRef: `kevin/demo#${n}`, mode: "pipeline" });
    assert.equal(again.status, 200, JSON.stringify(again.json));
  }
  assert.ok(!(await unclaimed()).includes("issue:140"));
  assert.ok(!(await unclaimed()).includes("issue:150"));
  // A direct session may still talk about an issue a pipeline card works on.
  assert.equal((await api("POST", "/api/sessions", { repoId: "kevin/demo", title: "Ask", prompt: "how is it going?", issueRef: "kevin/demo#140", mode: "direct" })).status, 200);
  for (const s of (await api("GET", "/api/sessions")).json) await api("POST", `/api/sessions/${s.id}/stop`, {});
});

test("a direct session's PR puts its card in Review with its PR badge; a backward drag of it is refused", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "directpr");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/directpr" })).status, 200);
  const col = columnOfCard("kevin/directpr");

  // The card's own commit is what its PR carries: the repo's setup files are already on the default
  // branch (issue #100), so the session's own work is the only commit the branch can have.
  const d = await api("POST", "/api/sessions", { repoId: "kevin/directpr", title: "Quick", prompt: "say hello", mode: "direct" });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  const id = d.json.id;
  await waitFor(async () => (await summary(id)).phase === "direct", 120_000);
  assert.equal(await col(id), "doing", "no PR yet: the card is in Doing");
  const own = path.join(process.env.DATA_DIR!, "worktrees", id);
  fs.writeFileSync(path.join(own, "work.txt"), "the quick fix\n");
  const ownGit = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@x", ...args], { cwd: own, stdio: "pipe" });
  ownGit("add", "work.txt");
  ownGit("commit", "-qm", "Note the work");

  const events = await boardEvents();
  const before = events.seen.length;

  // The session page's open-PR action records the PR: the phase is `pr`, and Done time stays unset.
  const pr = await api("POST", `/api/sessions/${id}/pr`, { title: "Quick fix", body: "## Summary\n- work.txt" });
  assert.equal(pr.status, 200, JSON.stringify(pr.json));
  const sum = await summary(id);
  assert.equal(sum.phase, "pr");
  assert.equal(sum.prNumber, pr.json.number);
  assert.equal(sum.doneAt, null, "the card is not Done until its PR merges");

  // The card sits in Review with its PR badge, and open boards hear the board event.
  const card = (await board("kevin/directpr")).find((c) => c.id === id);
  assert.equal(card?.column, "review");
  assert.equal(card?.pr?.number, pr.json.number);
  assert.equal(card?.pr?.url, pr.json.url);
  assert.ok(card?.pr?.state, "the board read the PR's state");
  await waitFor(() => events.seen.slice(before).includes("kevin/directpr"));

  // A backward drag of the direct card is refused (409), so it snaps back in Review: it has no
  // tickets to pause and no spec to rework. Review → Done (Approve) is its only other command.
  for (const column of ["todo", "issues", "doing", "qa"]) {
    const r = await api("POST", `/api/sessions/${id}/move`, { column });
    assert.equal(r.status, 409, `a drag to ${column}: ${JSON.stringify(r.json)}`);
  }
  assert.equal(await col(id), "review", "the card stayed in Review");

  events.close();
});

/** A bare repo's own git: the branch and merge-commit checks a mock GitHub write leaves behind. */
function gitInBare(repoId: string) {
  const bare = path.join(remotes, ...repoId.split("/")) + ".git";
  const sh = (...args: string[]) => spawnSync("git", args, { cwd: bare, stdio: "pipe" }).stdout.toString().trim();
  const hasRef = (ref: string) => spawnSync("git", ["rev-parse", "--verify", "-q", ref], { cwd: bare, stdio: "pipe" }).status === 0;
  return { sh, hasRef };
}

/** Put a session in Done with a Done time of the test's choosing, as a merge would. */
function markDoneAt(id: string, at: number) {
  const db = new DatabaseSync(path.join(process.env.DATA_DIR!, "workbench.db"));
  db.prepare("UPDATE sessions SET phase = 'done', done_at = ? WHERE id = ?").run(at, id);
  db.close();
}

/** A direct session with its PR open: its card sits in Review, and the mock's pull is returned. */
async function directToReview(repoId: string, title: string, opts: { issueRef?: string } = {}) {
  const d = (await api("POST", "/api/sessions", {
    repoId,
    title,
    prompt: "say hello",
    mode: "direct",
    ...(opts.issueRef ? { issueRef: opts.issueRef } : {}),
  })).json;
  assert.ok(d.id, JSON.stringify(d));
  // The card's own commit is what its PR carries: the repo's setup files may already be on the
  // default branch (issue #100), so the session's setup step commits nothing of its own.
  await waitFor(async () => (await summary(d.id)).phase === "direct", 120_000);
  const ownWorktree = path.join(process.env.DATA_DIR!, "worktrees", d.id);
  fs.writeFileSync(path.join(ownWorktree, "work.txt"), "the quick fix\n");
  const ownGit = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@x", ...args], { cwd: ownWorktree, stdio: "pipe" });
  ownGit("add", "work.txt");
  ownGit("commit", "-qm", "Note the work");
  const pr = await api("POST", `/api/sessions/${d.id}/pr`, { title, body: "## Summary\n- work.txt" });
  assert.equal(pr.status, 200, JSON.stringify(pr.json));
  const card = await waitFor(async () => (await board(repoId)).find((c) => c.id === d.id && c.column === "review"), 120_000);
  const pull = gh.pulls.find((p) => p.number === card.pr.number);
  const worktree = path.join(process.env.DATA_DIR!, "worktrees", d.id);
  return { id: d.id as string, pr: pull, number: pr.json.number as number, worktree, branch: (await summary(d.id)).branch as string };
}

test("Review → Done on a direct card is Approve: its PR merges with a merge commit, its branch and worktree go, and it lands in Done with its Done time, newest first beside the merged pipeline cards", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "directmerge");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/directmerge" })).status, 200);
  const { sh, hasRef } = gitInBare("kevin/directmerge");

  // A pipeline card already in Done, with an older Done time: the direct card must land before it.
  const older = (await api("POST", "/api/sessions", { repoId: "kevin/directmerge", title: "Older merge", prompt: "add a greeting" })).json;
  await waitFor(async () => (await summary(older.id)).pending.some((p: any) => p.kind === "decision"), 120_000);
  assert.equal((await api("POST", `/api/sessions/${older.id}/stop`, {})).status, 200);
  markDoneAt(older.id, Date.now() - 60_000);
  await waitFor(async () => (await summary(older.id)).phase === "done");

  const { id, pr, worktree, branch } = await directToReview("kevin/directmerge", "Quick merge", { issueRef: "kevin/directmerge#3" });
  assert.ok(hasRef(`refs/heads/${branch}`), "the branch is on GitHub");
  assert.ok(fs.existsSync(worktree), "the worktree is on disk");

  // A backward drag is refused (409): Review → Done is the only drag of a direct card.
  assert.equal((await api("POST", `/api/sessions/${id}/move`, { column: "doing" })).status, 409, "no drag from Review to Doing");

  const closedBefore = gh.closed.length;
  const at = Date.now();
  // Open boards of the repo are told to fetch the Board again: the card changed column.
  const events = await boardEvents();
  const moved = await api("POST", `/api/sessions/${id}/move`, { column: "done" });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.deepEqual(
    events.seen.filter((r) => r === "kevin/directmerge"),
    ["kevin/directmerge"],
    "the Approve emits one board event for the repo",
  );
  events.close();
  assert.equal(moved.json.phase, "done");
  assert.ok(moved.json.doneAt >= at, "the card's Done time is set");

  // The PR merged with a merge commit: main's tip has two parents, and the branch is gone.
  assert.equal(pr.merged, true);
  assert.equal(pr.merge_method, "merge");
  assert.equal(sh("rev-list", "--parents", "-n1", "refs/heads/main").split(" ").length, 3, "a merge commit");
  assert.ok(!hasRef(`refs/heads/${branch}`), "the remote branch is deleted");
  assert.ok(!fs.existsSync(worktree), "the worktree is removed");

  // The issue its refs name closed with the merge: its PR body carries no `Closes` line, so the
  // workbench closed it.
  assert.deepEqual(gh.closed.slice(closedBefore), [{ ref: "kevin/directmerge#3", by: "api" }]);

  // The card is in Done with its Done time and its merged badge, newest first beside the older
  // merged card. Its closed issue sits under the card, not as a flat card of its own.
  const cards = await board("kevin/directmerge");
  const card = cards.find((c) => c.id === id)!;
  assert.equal(card.column, "done");
  assert.equal(card.pr.state, "merged");
  assert.equal(card.doneAt, moved.json.doneAt);
  const doneCards = (cards: any[]) => cards.filter((c) => c.column === "done" && c.title !== SETUP_CARD);
  assert.deepEqual(
    doneCards(cards).map((c: any) => c.id),
    [id, older.id],
    "the Done cards, newest first, with no flat card for the closed issue",
  );
  assert.ok(!cards.some((c) => c.id === "issue:3"), "the closed issue is not an open card either");

  // A second Approve is refused: the card is no longer in Review.
  assert.equal((await api("POST", `/api/sessions/${id}/approve`, {})).status, 409);

  // Once the session is archived it is no longer a card: its closed issue stands beside the
  // merged cards in Done, newest first.
  assert.equal((await api("DELETE", `/api/sessions/${id}`)).status, 200);
  const after = await board("kevin/directmerge");
  const issueCard = after.find((c) => c.id === "issue:3");
  assert.ok(issueCard, "the closed issue is recorded in Done");
  assert.equal(issueCard.column, "done");
  assert.equal(issueCard.title, "Docs: setup guide");
  assert.ok(issueCard.doneAt >= at, "the issue carries its close time");
  assert.deepEqual(after.filter((c: any) => c.column === "done" && c.title !== SETUP_CARD).map((c: any) => c.id), ["issue:3", older.id]);
});

test("a board load delivers a direct card whose PR was merged by hand on GitHub", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "directhand");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/directhand" })).status, 200);
  const { hasRef } = gitInBare("kevin/directhand");
  const { id, worktree, branch, number } = await directToReview("kevin/directhand", "Hand merge");
  assert.ok(hasRef(`refs/heads/${branch}`), "the branch is on GitHub");

  // Someone merges the PR on GitHub: no Approve, no merge run.
  const merged = await fetch(`${gh.url}/repos/kevin/directhand/pulls/${number}/merge`, {
    method: "PUT",
    headers: { Authorization: "Bearer ghp_test", "Content-Type": "application/json" },
    body: JSON.stringify({ merge_method: "merge" }),
  });
  assert.equal(merged.status, 200, await merged.text());

  // The board load delivers the card: Done with its Done time, the branch deleted, the worktree gone.
  const events = await boardEvents();
  const before = events.seen.length;
  const cards = await board("kevin/directhand");
  const card = cards.find((c) => c.id === id)!;
  assert.equal(card.column, "done");
  assert.ok(card.doneAt, "the card's Done time is set");
  assert.equal(card.pr.state, "merged");
  assert.equal((await summary(id)).phase, "done");
  assert.ok(!hasRef(`refs/heads/${branch}`), "the remote branch is deleted");
  assert.ok(!fs.existsSync(worktree), "the worktree is removed");
  await waitFor(() => events.seen.slice(before).includes("kevin/directhand"), 120_000);

  // The delivered card is not approvable again.
  assert.equal((await api("POST", `/api/sessions/${id}/approve`, {})).status, 409);
  events.close();
});
