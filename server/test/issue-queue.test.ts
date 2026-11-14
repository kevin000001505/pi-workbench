/**
 * The Issue queue over HTTP: "Solve all issues" snapshots the cards the Issues column holds, sorts
 * them by issue number, and starts them one at a time — the next card starts when the card the queue
 * waits on reaches Review. Drives the real server (`main.ts`) as a child process, so one test can
 * restart it and show the queue is stored. Real `pi --mode rpc` against the scripted mock model and
 * the mock GitHub, which serves bare repos under `GITHUB_CLONE_BASE` so a card can push and open a PR.
 * Skips when the pi CLI isn't available.
 *
 * Seam: `POST /api/repos/:owner/:name/issues/queue`, the `queue` field of `GET /api/board`, and the
 * session each queued card gets. What these miss: the button in the Issues column header (the web has
 * no test harness; `cd web && npm run build` type-checks it), and a queued card whose start the
 * session refuses.
 *
 * A stuck card pauses the queue (issue #104): the card the queue waits on ends its run Blocked or
 * Stopped, or waits on the user's answer, and the pause is stored with the queue's rows.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startMockLlm } from "./mock-llm.ts";
import { startMockGitHub } from "./mock-github.ts";
import { ISSUE_TRACKER_DOC } from "./remote-repo.ts";

const piBin = process.env.PI_BIN ?? "pi";
const hasPi = spawnSync(piBin, ["--version"]).status === 0;

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = { skip: !hasPi };

let mock: Awaited<ReturnType<typeof startMockLlm>>;
let gh: Awaited<ReturnType<typeof startMockGitHub>>;
let dataDir: string;
let agentHome: string;
let SETUP_MARKER: string;
/** The URL of the server process that works now: a test restarts it and the URL changes. */
let base = "";
let server: ChildProcess | null = null;

const api = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json", origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};

const waitFor = async (fn: () => Promise<boolean>, opts: { timeout?: number; message?: string } = {}) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > (opts.timeout ?? 120_000)) throw new Error(opts.message ?? "timed out");
    await new Promise((r) => setTimeout(r, 150));
  }
};

const waitForValue = async <T,>(fn: () => Promise<T | null | undefined | false>, opts: { timeout?: number; message?: string } = {}) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > (opts.timeout ?? 120_000)) throw new Error(opts.message ?? "timed out");
    await new Promise((r) => setTimeout(r, 150));
  }
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      srv.close(() => resolve(port));
    });
  });

const startServer = async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(serverDir, "src", "main.ts")], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const up = await waitFor(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok, { timeout: 40_000, message: "the server did not start" });
  assert.ok(up);
};

const stopServer = async () => {
  const proc = server!;
  proc.kill("SIGTERM");
  await once(proc, "exit");
  server = null;
};

const boardOf = async (repo: string) => (await api("GET", `/api/board?repo=${encodeURIComponent(repo)}`)).json as {
  cards: { id: string; column: string; number?: number }[];
  queue: { running: boolean; numbers: number[]; paused: number | null };
};
const queueOf = async (repo: string) => (await boardOf(repo)).queue;
const cardsIn = async (repo: string, column: string) => (await boardOf(repo)).cards.filter((c) => c.column === column);
const cardColumn = async (repo: string, id: string) => (await boardOf(repo)).cards.find((c) => c.id === id)?.column;
const sessionsOf = async (repo: string) => ((await api("GET", "/api/sessions")).json as any[]).filter((s) => s.repoId === repo);
const sessionForIssue = async (repo: string, n: number) => (await sessionsOf(repo)).find((s) => s.issueRef === `${repo}#${n}`);
const solveAllIssues = (repo: string) => api("POST", `/api/repos/${repo}/issues/queue`, {});
const summaryOf = async (id: string) => (await api("GET", `/api/sessions/${id}`)).json.summary as any;
const pendingOf = async (id: string, kind: "permission" | "decision") => ((await summaryOf(id)).pending ?? []).find((p: any) => p.kind === kind);

/** A repo whose Issues column holds exactly these plain issues, so a test drives a card it chose. */
const seedPlainIssues = (repo: string, issues: { number: number; title: string; body: string }[]) => {
  const [owner, name] = repo.split("/");
  for (const i of issues) gh.seedIssue(owner, name, i);
};

/** A repo the record says is set up, so a queued card starts in its planned phase and not in setup. */
const addRepo = async (repo: string) => {
  const [owner, name] = repo.split("/");
  gh.createBare(owner, name, { [SETUP_MARKER]: ISSUE_TRACKER_DOC });
  const r = await api("POST", "/api/repos", { id: repo });
  assert.equal(r.status, 200, r.json.error);
  assert.equal(r.json.setup, "set_up");
};

/** Close an issue the mock feed seeds for every repo, so the Issues column holds only what a test seeds. */
const closeMockIssue = async (repo: string, n: number) => {
  const res = await fetch(`${gh.url}/repos/${repo}/issues/${n}`, {
    method: "PATCH",
    headers: { authorization: "Bearer ghp_test", "content-type": "application/json" },
    body: JSON.stringify({ state: "closed", state_reason: "not planned" }),
  });
  assert.equal(res.status, 200);
};

/** Drive one card's runs until `done` holds, answering the gated call each run asks for. */
const driveCard = async (id: string, done: (s: any) => boolean, message: string) => {
  await waitFor(
    async () => {
      const s = await summaryOf(id);
      if (done(s)) return true;
      const p = (s.pending ?? []).find((x: any) => x.kind === "permission");
      if (p) await api("POST", `/api/sessions/${id}/respond`, { requestId: p.id, value: p.options[0] });
      return false;
    },
    { timeout: 240_000, message },
  );
};

/** Drive one card's runs to Review, answering the gated `git push` its review run asks for. */
const toReview = async (repo: string, n: number) => {
  const id = (await sessionForIssue(repo, n))?.id;
  assert.ok(id, `no card works on issue #${n} of ${repo}`);
  await driveCard(id, (s) => s.phase === "pr", `issue #${n} of ${repo} never reached Review`);
  return id;
};

/** Drive the card the queue started until its ticket ends blocked, and return the card's summary. */
const toBlocked = async (id: string) => {
  await driveCard(id, (s) => !!s.attention, `the card ${id} never flagged`);
  const s = await summaryOf(id);
  assert.match(s.attention, /is blocked/, "the stuck card is blocked");
  return s;
};

/** A repo with a queue whose first card is stuck: the card the queue waits on, and its issue number. */
const startStuckQueue = async (repo: string) => {
  seedPlainIssues(repo, [
    { number: 1, title: "Write the guide", body: "Write a setup guide. BLOCKME" },
    { number: 2, title: "Fix the login page", body: "Fix the login page crash." },
  ]);
  await addRepo(repo);
  const r = await solveAllIssues(repo);
  assert.equal(r.status, 200, r.json.error);
  assert.deepEqual(r.json.queued, [1, 2], "the snapshot is the two seeded cards, lowest number first");
  assert.equal(r.json.started?.number, 1);
  const id = r.json.started.sessionId;
  await toBlocked(id);
  return id;
};

const repo1 = "kevin/queue1";
const repo2 = "kevin/queue2";
const repo3 = "kevin/queue3";
const repo4 = "kevin/queue4";
const repo5 = "kevin/queue5";
const repo6 = "kevin/queue6";
const repo7 = "kevin/queue7";
const repo8 = "kevin/queue8";
let queue1First: string | undefined;

before(async () => {
  if (!hasPi) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-queue-"));
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), "wb-queue-home-"));
  const remotes = path.join(dataDir, "remotes");
  fs.mkdirSync(remotes, { recursive: true });
  mock = await startMockLlm();
  gh = await startMockGitHub(remotes);
  process.env.DATA_DIR = path.join(dataDir, "data");
  process.env.WORKBENCH_MASTER_KEY = crypto.randomBytes(32).toString("hex");
  process.env.SKILLS_DIR = path.join(dataDir, "skills");
  process.env.HOME = agentHome;
  process.env.GITHUB_CLONE_BASE = `file://${remotes}`;
  process.env.GITHUB_API_URL = gh.url;
  process.env.PI_BIN = piBin;
  process.env.PI_EXTENSION = path.resolve(serverDir, "../pi-extension/workbench.ts");
  ({ SETUP_MARKER } = await import("../src/config.ts"));
  // Skills the pipeline invokes: pi expands /skill:name from these, and the session checks they exist.
  for (const name of ["grill-with-docs", "to-spec", "to-tickets", "tdd", "code-review", "setup-matt-pocock-skills"]) {
    fs.mkdirSync(path.join(process.env.SKILLS_DIR!, name), { recursive: true });
    fs.writeFileSync(path.join(process.env.SKILLS_DIR!, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} test skill\n---\n${name} body\n`);
  }
  await startServer();
  // One GitHub token and one model endpoint, stored in the db: they outlive a server restart.
  assert.equal((await api("PUT", "/api/secrets", { scope: "global", name: "GITHUB_TOKEN", value: "ghp_test" })).status, 200);
  assert.equal((await api("PUT", "/api/settings/model", { baseUrl: mock.url, model: "gpt-4o", label: "Mock" })).status, 200);
});

after(async () => {
  server?.kill("SIGKILL");
  await mock?.close();
  await gh?.close();
});

test(
  "Solve all issues snapshots the Issues column sorted by issue number and starts the lowest-numbered card with its normal move",
  skip,
  async () => {
    await addRepo(repo1);
    assert.equal((await sessionsOf(repo1)).length, 0, "a repo the record says is set up starts no session");
    assert.deepEqual((await cardsIn(repo1, "issues")).map((c) => c.id), ["issue:1", "issue:2", "issue:3"]);
    assert.deepEqual(await queueOf(repo1), { running: false, numbers: [], paused: null });

    // The click is a write route: it goes through the JSON + Origin + Host check like every other write.
    const noJson = await fetch(`${base}/api/repos/kevin/queue1/issues/queue`, { method: "POST", body: "{}" });
    assert.equal(noJson.status, 403, "a write without application/json is refused");
    const foreign = await fetch(`${base}/api/repos/kevin/queue1/issues/queue`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://elsewhere.example" },
      body: "{}",
    });
    assert.equal(foreign.status, 403, "a cross-origin write is refused");

    const r = await solveAllIssues(repo1);
    assert.equal(r.status, 200, r.json.error);
    assert.deepEqual(r.json.queued, [1, 2, 3], "the snapshot is every Issues card, lowest number first");
    assert.deepEqual(r.json.skipped, []);
    assert.equal(r.json.started?.number, 1, "the queue starts the lowest-numbered card");

    queue1First = r.json.started.sessionId;
    const started = (await api("GET", `/api/sessions/${queue1First}`)).json.summary;
    assert.equal(started.mode, "pipeline");
    assert.equal(started.issueRef, `${repo1}#1`);
    assert.equal(started.phase, "implement", "a plain issue card starts with Solve: its issue is its only ticket");
    assert.deepEqual(started.tickets.map((t: any) => [t.num, t.title, t.trackerRef]), [[1, "Add dark mode", "1"]], "Solve records the issue as the card's only ticket, with its own number as the tracker ref");

    const b = await boardOf(repo1);
    assert.deepEqual(b.cards.filter((c) => c.column === "issues").map((c) => c.id), ["issue:2", "issue:3"], "only the started card left Issues");
    assert.equal(b.cards.find((c) => c.id === queue1First)?.column, "doing");
    assert.deepEqual(b.queue, { running: true, numbers: [1, 2, 3], paused: null }, "the board states the running queue");

    const again = await solveAllIssues(repo1);
    assert.equal(again.status, 409, "a repo has one Issue queue at a time: a second click while one runs is refused");
  },
);

test(
  "the queue starts the next queued card when the card it waits on reaches Review, and ends after the last one",
  skip,
  async () => {
    const first = queue1First!;
    // A card that appears after the click is not part of the queue.
    gh.bulkSeedIssues("kevin", "queue1", 1, 4, "2025-02-01T00:00:00Z");

    await toReview(repo1, 1);
    assert.equal(await cardColumn(repo1, first), "review", "the card the queue started sits in Review");
    const second = await waitForValue(() => sessionForIssue(repo1, 2), { message: "the queue never started issue #2" });
    assert.equal(second.phase, "implement");
    assert.equal(await cardColumn(repo1, second.id), "doing");
    assert.deepEqual(await queueOf(repo1), { running: true, numbers: [2, 3], paused: null }, "the queue waits on #2 now");
    assert.deepEqual(
      (await cardsIn(repo1, "issues")).map((c) => c.id).sort(),
      ["issue:3", "issue:4"],
      "the third card waits its turn, and the card that appeared later is not queued (the board lists unclaimed cards in GitHub's order, so the ids are compared sorted)",
    );

    await toReview(repo1, 2);
    const third = await waitForValue(() => sessionForIssue(repo1, 3), { message: "the queue never started issue #3" });
    assert.equal(await cardColumn(repo1, third.id), "doing");
    assert.deepEqual(await queueOf(repo1), { running: true, numbers: [3], paused: null });

    await toReview(repo1, 3);
    assert.deepEqual(await queueOf(repo1), { running: false, numbers: [], paused: null }, "the queue is over after the last card reaches Review");
    assert.deepEqual(
      (await sessionsOf(repo1)).filter((s) => s.repoId === repo1).map((s) => s.issueRef).sort(),
      [`${repo1}#1`, `${repo1}#2`, `${repo1}#3`],
      "the queue started one card per queued issue, and no card for the issue that appeared later",
    );
    assert.equal((await cardsIn(repo1, "review")).length, 3, "every queued card reached Review");
    assert.equal((await sessionsOf(repo1)).some((s) => s.issueRef === `${repo1}#4`), false, "the card that appeared after the click was never started");
    assert.equal(await cardColumn(repo1, "issue:4"), "issues");
  },
);

test("a queued card claimed by hand before its turn is skipped, and the queue goes on without it", skip, async () => {
  await addRepo(repo2);
  const r = await solveAllIssues(repo2);
  assert.equal(r.status, 200, r.json.error);
  assert.deepEqual(r.json.queued, [1, 2, 3]);
  assert.equal(r.json.started?.number, 1);

  // The user drags the third card to Doing by hand, before the queue reaches it.
  const hand = await api("POST", `/api/repos/${repo2}/issues/3/move`, { column: "doing" });
  assert.equal(hand.status, 200, hand.json.error);

  await toReview(repo2, 1);
  const second = await waitForValue(() => sessionForIssue(repo2, 2), { message: "the queue never started issue #2" });
  assert.equal(await cardColumn(repo2, second.id), "doing");

  await toReview(repo2, 2);
  await waitFor(async () => (await queueOf(repo2)).running === false, { message: "the queue never finished after it skipped #3" });
  const ofThree = (await sessionsOf(repo2)).filter((s) => s.issueRef === `${repo2}#3`);
  assert.equal(ofThree.length, 1, "the queue started no second card for the hand-claimed issue");
  assert.equal(ofThree[0].id, hand.json.id);
  assert.deepEqual(await queueOf(repo2), { running: false, numbers: [], paused: null });
});

test("an unclaimed spec card in Issues is started with Solve all tickets: its tickets come from its open sub-issues", skip, async () => {
  await addRepo(repo3);
  // The mock seeds plain issues #1..#3 for every repo: close them so the spec card is the only one.
  for (const n of [1, 2, 3]) await closeMockIssue(repo3, n);
  gh.seedSubIssues("kevin", "queue3", { number: 10, title: "Add exports", body: "Export the board as JSON." }, [
    { number: 11, title: "Write the JSON", body: "Write the board as JSON." },
    { number: 12, title: "Read the JSON", body: "Read the board from JSON." },
  ]);
  assert.deepEqual((await cardsIn(repo3, "issues")).map((c) => c.id), ["issue:10"]);

  const r = await solveAllIssues(repo3);
  assert.equal(r.status, 200, r.json.error);
  assert.deepEqual(r.json.queued, [10]);
  assert.equal(r.json.started?.number, 10);
  const started = (await api("GET", `/api/sessions/${r.json.started.sessionId}`)).json.summary;
  assert.equal(started.issueRef, `${repo3}#10`);
  assert.equal(started.phase, "implement", "a spec card starts with Solve all tickets: no grill, spec or tickets run");
  assert.deepEqual(
    started.tickets.map((t: any) => [t.num, t.title, t.trackerRef]),
    [
      [1, "Write the JSON", "11"],
      [2, "Read the JSON", "12"],
    ],
    "Solve all tickets records the spec's open sub-issues as its tickets",
  );
  assert.deepEqual(await queueOf(repo3), { running: true, numbers: [10], paused: null });
});

test(
  "the Issue queue is stored: a server restart keeps it, and the next queued card starts when the running card reaches Review",
  skip,
  async () => {
    await addRepo(repo4);
    const r = await solveAllIssues(repo4);
    assert.equal(r.status, 200, r.json.error);
    assert.equal(r.json.started?.number, 1);
    const first = r.json.started.sessionId;

    await stopServer();
    await startServer();

    assert.deepEqual(await queueOf(repo4), { running: true, numbers: [1, 2, 3], paused: null }, "the restarted server still has the queue");
    assert.equal((await solveAllIssues(repo4)).status, 409, "the restarted queue still refuses a second start");
    assert.equal(await cardColumn(repo4, first), "doing", "the card the queue waits on is still on the board");

    // The restart stopped the card's run: the user resumes it with Retry. The queue still waits on it.
    assert.equal((await api("POST", `/api/sessions/${first}/pipeline`, { action: "retry" })).status, 200);
    assert.deepEqual(await queueOf(repo4), { running: true, numbers: [1, 2, 3], paused: null }, "the queue waits on the resumed card and starts no next card");
    await toReview(repo4, 1);

    const second = await waitForValue(() => sessionForIssue(repo4, 2), { message: "the restarted queue never started issue #2" });
    assert.equal(await cardColumn(repo4, second.id), "doing");
    assert.deepEqual(await queueOf(repo4), { running: true, numbers: [2, 3], paused: null });
  },
);

test(
  "a queued card the user Abandons before its turn is skipped, and the queue starts no fresh card for its issue",
  skip,
  async () => {
    await addRepo(repo5);
    const r = await solveAllIssues(repo5);
    assert.equal(r.status, 200, r.json.error);
    assert.deepEqual(r.json.queued, [1, 2, 3]);
    assert.equal(r.json.started?.number, 1);

    // The user starts the third card by hand, pauses it back to Issues — where the snapshot has it —
    // and Abandons it before the queue reaches it.
    const hand = await api("POST", `/api/repos/${repo5}/issues/3/move`, { column: "doing" });
    assert.equal(hand.status, 200, hand.json.error);
    const third = hand.json.id;
    assert.equal((await api("POST", `/api/sessions/${third}/move`, { column: "issues" })).status, 200, "the card waits in Issues, its place in the snapshot");
    assert.equal((await api("POST", `/api/sessions/${third}/abandon`, {})).status, 200);
    assert.equal(await cardColumn(repo5, third), undefined, "the Abandoned card is off the board");

    await toReview(repo5, 1);
    // The queue started the second card with its own Solve: it works on issue #2 now.
    await waitForValue(() => sessionForIssue(repo5, 2), { message: "the queue never started issue #2" });

    await toReview(repo5, 2);
    // The queue's last step is the dropped card's number: it goes as skipped, and no fresh session
    // starts for the issue the user dropped.
    const finished = await waitForValue(async () => {
      if ((await queueOf(repo5)).running) return false;
      return (await sessionsOf(repo5)).filter((s) => s.issueRef === `${repo5}#3`).length === 0;
    }, { message: "the queue did not finish by skipping the Abandoned card #3: it started a fresh card for it, or it is still waiting" });
    assert.ok(finished);
    assert.deepEqual(await queueOf(repo5), { running: false, numbers: [], paused: null }, "the queue is over: its last step was skipped, not started");
  },
);

test(
  "a queued card that waits on the user's answer pauses the queue; the pause survives a restart, and a Retry that reaches Review starts the next card",
  skip,
  async () => {
    // The card's own ticket pushes: its `git push` is a gated call, so the run waits on the user.
    seedPlainIssues(repo6, [
      { number: 1, title: "Add dark mode", body: "Support a dark theme. PUSHME" },
      { number: 2, title: "Fix the login page", body: "Fix the login page crash." },
      { number: 3, title: "Write the setup guide", body: "Write a setup guide." },
    ]);
    await addRepo(repo6);
    const r = await solveAllIssues(repo6);
    assert.equal(r.status, 200, r.json.error);
    assert.deepEqual(r.json.queued, [1, 2, 3]);
    assert.equal(r.json.started?.number, 1);
    const first = r.json.started.sessionId;

    // The ticket's gated `git push` is the answer the card waits on.
    const ask = await waitForValue(() => pendingOf(first, "permission"), { message: `issue #1 of ${repo6} never asked the user` });
    assert.ok(ask, "the card asks the user about its push");
    assert.equal(await cardColumn(repo6, first), "doing", "the card that waits for the user is still in Doing");
    assert.deepEqual(
      await queueOf(repo6),
      { running: true, numbers: [1, 2, 3], paused: 1 },
      "the queue is paused on the card that waits for the user, and keeps its numbers",
    );
    assert.equal(await sessionForIssue(repo6, 2), undefined, "no next card starts while the queue is paused");

    // The pause is stored with the queue, not with the live run.
    await stopServer();
    await startServer();
    assert.deepEqual(await queueOf(repo6), { running: true, numbers: [1, 2, 3], paused: 1 }, "the restarted server keeps the pause");
    assert.equal(await sessionForIssue(repo6, 2), undefined, "the restarted queue still starts no next card");
    const again = await solveAllIssues(repo6);
    assert.equal(again.status, 409, "a paused queue is still one queue: a second click is refused");
    assert.match(again.json.error, /#1/, "the refusal names the card the queue waits on");

    // The user resolves the card: Retry re-runs its ticket, and the card goes on to Review.
    assert.equal((await api("POST", `/api/sessions/${first}/pipeline`, { action: "retry" })).status, 200);
    await driveCard(first, (s) => s.phase === "pr", `issue #1 of ${repo6} never reached Review after a Retry`);
    assert.equal(await cardColumn(repo6, first), "review");

    const second = await waitForValue(() => sessionForIssue(repo6, 2), { message: "the paused queue never started issue #2" });
    assert.equal(await cardColumn(repo6, second.id), "doing");
    assert.deepEqual(await queueOf(repo6), { running: true, numbers: [2, 3], paused: null }, "the queue goes on with the next card by issue number");
    await api("POST", `/api/sessions/${second.id}/stop`, {});
  },
);

test("a queued card whose ticket is blocked holds the queue, and Abandoning it starts the next card", skip, async () => {
  const first = await startStuckQueue(repo7);
  assert.deepEqual(await queueOf(repo7), { running: true, numbers: [1, 2], paused: 1 }, "the blocked card holds the queue");
  assert.equal(await sessionForIssue(repo7, 2), undefined, "no next card starts while the queue is held");

  assert.equal((await api("POST", `/api/sessions/${first}/abandon`, {})).status, 200);
  assert.equal(await cardColumn(repo7, first), undefined, "the Abandoned card is off the board");
  const second = await waitForValue(() => sessionForIssue(repo7, 2), { message: "Abandoning the stuck card never started the next card" });
  assert.equal(await cardColumn(repo7, second.id), "doing");
  assert.deepEqual(await queueOf(repo7), { running: true, numbers: [2], paused: null }, "the queue is not paused: it waits on #2 now");
  await api("POST", `/api/sessions/${second.id}/stop`, {});
});

test("moving the stuck queued card backward out of Doing starts the next card, and the card stays on the board", skip, async () => {
  const first = await startStuckQueue(repo8);
  assert.deepEqual(await queueOf(repo8), { running: true, numbers: [1, 2], paused: 1 }, "the stuck card holds the queue");
  assert.equal(await sessionForIssue(repo8, 2), undefined, "no next card starts while the queue is held");

  // The user drags the stuck card back to Issues: the queue is not waiting on it any more.
  assert.equal((await api("POST", `/api/sessions/${first}/move`, { column: "issues" })).status, 200);
  const second = await waitForValue(() => sessionForIssue(repo8, 2), { message: "the backward move never started the next card" });
  assert.equal(await cardColumn(repo8, second.id), "doing");
  assert.equal(await cardColumn(repo8, first), "issues", "the card the user moved back is still a card in Issues");
  assert.deepEqual(
    await queueOf(repo8),
    { running: true, numbers: [2], paused: null },
    "the queue moved on to the next card, and starts no second card for the card the user moved",
  );
  await api("POST", `/api/sessions/${second.id}/stop`, {});
});
