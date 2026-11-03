/**
 * End-to-end pipeline: setup → grill-with-docs → to-spec → to-tickets → tdd per ticket (fresh pi run
 * each) → one code-review run → done, with a real `pi --mode rpc` against the scripted mock model.
 * Skips when the pi CLI isn't available.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { startMockLlm } from "./mock-llm.ts";
import { startMockGitHub } from "./mock-github.ts";
import { RESCUE_TOKEN_ENV, startRescueProxy } from "../src/rescue-proxy.ts";

const piBin = process.env.PI_BIN ?? "pi";
const hasPi = spawnSync(piBin, ["--version"]).status === 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-pipe-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "pipeline-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");
// A deployment may export PI_EXTENSION (the installed copy); the test must load this repo's
// extension, so the assertions cover the code under test.
process.env.PI_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-extension", "workbench.ts");

const RESCUE_KEY = "sk-pipeline-reviewer-key-123456";

let mock: Awaited<ReturnType<typeof startMockLlm>>;
let ghMock: Awaited<ReturnType<typeof startMockGitHub>>;
let proxy: Awaited<ReturnType<typeof startRescueProxy>>;
let mgr: any;
let db: any;
let auto: typeof import("../src/autoapprove.ts");
let secrets: any;
const events: { id: string; ev: any }[] = [];
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Answer whatever decision card the session is waiting on with its first option. */
async function answerNext(id: string, expect: RegExp) {
  const req = await waitFor(() => mgr.summary(id).pending[0]);
  assert.match(req.title, expect);
  mgr.respond(id, req.id, { value: req.options[0] });
}

before(async () => {
  if (!hasPi) return;
  mock = await startMockLlm();
  proxy = await startRescueProxy(() => {});
  const { config } = await import("../src/config.ts");
  const { openDb } = await import("../src/db.ts");
  const { SecretStore } = await import("../src/secrets.ts");
  const { saveModelSettings, writePiConfig } = await import("../src/settings.ts");
  const { SessionManager } = await import("../src/sessions.ts");
  config.piBin = piBin;
  db = openDb(config.dbFile);
  saveModelSettings(db, { baseUrl: mock.url });
  writePiConfig(db, proxy.url);

  // Skills the pipeline invokes; pi expands /skill:name from these.
  for (const name of ["grill-with-docs", "to-spec", "to-tickets", "tdd", "code-review", "setup-matt-pocock-skills", "diagnosing-bugs", "retro"]) {
    fs.mkdirSync(path.join(config.skillsDir, name), { recursive: true });
    fs.writeFileSync(path.join(config.skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} test skill\n---\n${name} body\n`);
  }

  const seed = path.join(tmp, "seed");
  fs.mkdirSync(seed);
  sh(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "README.md"), "# demo\n");
  sh(seed, "add", ".");
  sh(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  sh(tmp, "clone", "-q", "--bare", seed, path.join(tmp, "remote.git"));
  const clone = path.join(config.reposDir, "me", "demo");
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  sh(tmp, "clone", "-q", path.join(tmp, "remote.git"), clone);
  db.prepare("INSERT INTO repos (id, owner, name, default_branch, private, added_at) VALUES ('me/demo','me','demo','main',1,0)").run();

  secrets = new SecretStore(db, process.env.WORKBENCH_MASTER_KEY!);
  // Auto-approve on, judged by the local model on the agent's endpoint (the mock answers SAFE for
  // `git push`): gated calls in ticket and review runs are answered without the user.
  auto = await import("../src/autoapprove.ts");
  await auto.configureAutoApprove(db, secrets, { enabled: true, judge: { kind: "local", model: "mock-judge" } } as any);
  ghMock = await startMockGitHub(path.join(tmp, "gh"));
  config.githubApi = ghMock.url;
  const { GitHub } = await import("../src/github.ts");
  const { githubDelivery } = await import("../src/delivery.ts");
  const { getModelSettings } = await import("../src/settings.ts");
  const gitEnv = async () => ({
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  });
  const delivery = githubDelivery({ github: () => new GitHub("ghp_test"), gitEnv, model: () => getModelSettings(db), llmKey: () => undefined });
  mgr = new SessionManager(db, secrets, gitEnv, undefined, (ref) => new GitHub("ghp_test").ticketsFromIssueRef(ref), proxy, delivery);
  mgr.on("event", (id: string, ev: any) => events.push({ id, ev }));
});

after(async () => {
  if (!hasPi) return;
  await mgr.shutdown();
  await mock.close();
  await ghMock.close();
  await proxy.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a pipeline session grills, writes a spec and tickets, implements them one fresh run at a time, then reviews", { skip: !hasPi && "pi CLI not found" }, async () => {
  const s = await mgr.create({ repoId: "me/demo", title: "Greeting", prompt: "add a greeting" });
  assert.equal(s.mode, "pipeline");
  assert.equal(s.phase, "setup");

  // Setup commits its marker, then the task goes to grill-me.
  await waitFor(() => mgr.summary(s.id).phase === "grill");
  await answerNext(s.id, /shared understanding/);
  await waitFor(() => mgr.summary(s.id).phase === "spec");
  assert.match(mgr.summary(s.id).grillSummary, /hello\.txt/);

  // to-spec checks the seams, publishes, saves the spec.
  await answerNext(s.id, /seam/);
  await waitFor(() => mgr.summary(s.id).phase === "tickets");
  assert.equal(mgr.summary(s.id).specRef, ".scratch/greeting/spec.md");
  assert.match(mgr.summary(s.id).spec, /hello\.txt says Hello/);

  // to-tickets asks for approval, publishes, records.
  await answerNext(s.id, /Approve/);
  // The recorded tickets pause the session in `ready` (the board's Issues column): no ticket run starts.
  await waitFor(() => mgr.summary(s.id).phase === "ready" && mgr.summary(s.id).status === "idle");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(mgr.summary(s.id).phase, "ready");
  assert.equal(mgr.summary(s.id).activeRun, s.id);
  assert.ok(!mock.requests.some((r) => JSON.stringify(r.messages ?? []).includes('<skill name=\\"tdd\\"')), "no ticket run starts in ready");
  // A ticket left `running` by a stopped run (what a move back to Issues leaves; until that move
  // exists, write it) starts again from `ready`.
  db.prepare("UPDATE tickets SET status = 'running', run_id = ? WHERE session_id = ? AND num = 1").run(`${s.id}-t1-stopped`, s.id);
  // Solve all: the Issues → Doing move (the route POST /api/sessions/:id/move calls this) resumes it.
  await mgr.move(s.id, "doing");
  assert.equal(mgr.summary(s.id).phase, "implement");
  const sum = await waitFor(() => {
    const x = mgr.summary(s.id);
    return x.attention ? x : undefined;
  });

  // Tickets 1 and 2 finish; 3 reports blocked and the pipeline stops for the user.
  assert.deepEqual(
    sum.tickets.map((t: any) => `${t.num}:${t.status}`),
    ["1:done", "2:done", "3:blocked"],
  );
  assert.match(sum.attention, /Ticket #3 is blocked: Needs a docs folder decision/);
  assert.equal(sum.tickets[0].note, "Ticket 1 appended to work.txt");
  // Each ticket ran in its own pi conversation, listed for the viewer.
  assert.deepEqual(sum.runs.map((r: any) => r.label), ["Plan", "#1 Write hello.txt", "#2 Add a test", "#3 Add docs"]);
  assert.equal(sum.activeRun, sum.tickets[2].runId);

  // The second ticket's fresh context carried the spec and ticket 1's note.
  const t2 = mock.requests.find((r) => JSON.stringify(r.messages ?? []).includes("Ticket #2: Add a test"));
  const t2Text = JSON.stringify(t2.messages);
  assert.match(t2Text, /<skill name=\\"tdd\\"/);
  assert.match(t2Text, /hello.txt says Hello/);
  assert.match(t2Text, /#1 Write hello.txt: Ticket 1 appended to work.txt/);
  assert.ok(!t2Text.includes("shared understanding"), "ticket runs start without the grill conversation");

  // Ticket 1's gated `git push` was answered by auto-approve inside the ticket run.
  const autoAnswers = () => events.filter((e) => e.id === s.id && e.ev.type === "wb_auto_answer").map((e) => e.ev);
  assert.deepEqual(
    autoAnswers().map((a) => [a.subject, a.answer, a.by]),
    [['echo "ticket 1" >> work.txt && git add -A && git commit -qm "Ticket 1" && git push -q origin HEAD && echo committed', "allow", "local judge"]],
  );

  // The past run is still readable, with its auto-approve line, which the run on screen does not show.
  const first = mgr.runTranscript(s.id, sum.tickets[0].runId);
  assert.ok(first.messages.some((m: any) => m.role === "toolResult" && m.toolName === "finish_ticket"));
  const line = first.messages.findIndex((m: any) => m.role === "autoAnswer");
  assert.ok(line > 0, "ticket 1's run keeps its automatic allow");
  assert.equal(first.messages[line].answer, "allow");
  const result = first.messages.findIndex((m: any) => m.role === "toolResult" && m.toolName === "bash");
  assert.ok(line < result, "the line sits before the call's result, in time order");
  for (const t of [sum.tickets[1].runId, sum.tickets[2].runId]) {
    assert.ok(!mgr.runTranscript(s.id, t).messages.some((m: any) => m.role === "autoAnswer"), "other runs show none of it");
  }
  assert.ok(!(await mgr.snapshot(s.id)).transcript.messages.some((m: any) => m.role === "autoAnswer"));

  // Skip the blocked ticket: one fresh code-review run covers the whole branch, then the pipeline
  // opens the PR. GitHub has no me/demo repo yet, so the PR cannot open: the session stays in
  // review (the card in QA) with the reason, on the review run.
  await mgr.pipelineAction(s.id, "skip");
  assert.equal(mgr.summary(s.id).phase, "review");
  const failed = await waitFor(() => {
    const x = mgr.summary(s.id);
    return x.phase === "review" && x.attention ? x : undefined;
  });
  assert.match(failed.attention, /The PR could not open: .*No commits between main and/);
  assert.equal(failed.prNumber, null);
  assert.equal(failed.runs[failed.runs.length - 1].label, "Review");
  assert.equal(failed.activeRun, failed.runs[failed.runs.length - 1].id);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(mgr.summary(s.id).phase, "review", "a failed PR open does not move on");
  assert.equal(ghMock.pulls.length, 0);
  const review = mock.requests.find((r) => JSON.stringify(r.messages ?? []).includes('<skill name=\\"code-review\\"'));
  assert.match(JSON.stringify(review.messages), /since origin\/main/);
  assert.ok(!JSON.stringify(review.messages).includes("Ticket #3: Add docs"), "the review run starts fresh");
  // The review run's gated `git push` was auto-approved too.
  assert.equal(autoAnswers().length, 2);
  assert.match(autoAnswers()[1].subject, /Fix review findings" && git push/);
  assert.equal(autoAnswers()[1].answer, "allow");
  const row = db.prepare("SELECT worktree FROM sessions WHERE id = ?").get(s.id);
  assert.deepEqual(sh(row.worktree, "log", "--format=%s", "-4").trim().split("\n"), ["Fix review findings", "Ticket 3", "Ticket 2", "Ticket 1"]);

  // The pipeline's Stop pauses the card in Issues.
  await mgr.pipelineAction(s.id, "stop");
  assert.equal(mgr.summary(s.id).phase, "ready");
  assert.equal(mgr.summary(s.id).attention, null);
});

test("a session started from a spec's ticket issues implements every ticket, reviews, then opens the PR", { skip: !hasPi && "pi CLI not found" }, async () => {
  ghMock.seedSubIssues(
    "me",
    "demo",
    { number: 7, title: "Greeting suite", body: "## Solution\nhello.txt says Hello, and it is tested." },
    [
      { number: 8, title: "Write hello.txt", body: "Create hello.txt containing Hello. PUSHME" },
      { number: 9, title: "Add a test", body: "Test that hello.txt says Hello.", blockedBy: [8] },
      { number: 10, title: "Add docs", body: "Document it.", blockedBy: [8, 9] },
    ],
  );
  // GitHub knows me/demo now (its bare repo is the clone's origin), so this session's PR opens.
  fs.mkdirSync(path.join(tmp, "gh", "me"), { recursive: true });
  fs.symlinkSync(path.join(tmp, "remote.git"), path.join(tmp, "gh", "me", "demo.git"));
  const s = await mgr.create({ repoId: "me/demo", title: "Greeting suite", issueRef: "me/demo#7", mode: "pipeline", startFrom: "tickets" });
  assert.equal(s.mode, "pipeline");
  // The first session never pushed its setup marker, so this one may start in setup; either way it lands on implement.
  await waitFor(() => mgr.summary(s.id).phase === "implement");
  const sum0 = mgr.summary(s.id);
  assert.equal(sum0.issueRef, "me/demo#7");
  assert.match(sum0.spec, /hello.txt says Hello/);
  assert.match(sum0.specRef, /issues\/7$/);
  assert.deepEqual(
    sum0.tickets.map((t: any) => `${t.num}:${t.blockedBy.join(",")}:${t.trackerRef}`),
    ["1::8", "2:1:9", "3:1,2:10"],
  );
  // After the review, the workbench pushes the branch and opens the PR: phase `pr`, the card in Review.
  const done = await waitFor(() => {
    const x = mgr.summary(s.id);
    return x.phase === "pr" ? x : undefined;
  });
  assert.deepEqual(done.tickets.map((t: any) => t.status), ["done", "done", "done"]);
  assert.equal(done.attention, null);
  assert.equal(done.activeRun, s.id, "back on the plan conversation");
  const pr = ghMock.pulls.at(-1);
  assert.equal(done.prNumber, pr.number);
  assert.equal(done.prUrl, pr.html_url);
  assert.equal(pr.head, done.branch);
  assert.equal(pr.base, "main");
  assert.equal(pr.title, "Add a friendly greeting", "the model drafted the PR");
  for (const n of [8, 9, 10, 7]) assert.match(pr.body, new RegExp(`Closes #${n}\\b`));
  assert.equal(sh(path.join(tmp, "remote.git"), "log", "--format=%s", "-1", done.branch).trim(), "Fix review findings", "the branch is pushed");
  // Ticket 2's fresh run carried the spec text read from the spec issue.
  const t2 = mock.requests.find((r) => JSON.stringify(r.messages ?? []).includes("Ticket #2: Add a test"));
  assert.match(JSON.stringify(t2.messages), /hello.txt says Hello/);
  assert.ok(!JSON.stringify(t2.messages).includes("runs automatically on this repository's first"), "ticket runs start fresh, without the setup conversation");
  const row = db.prepare("SELECT worktree FROM sessions WHERE id = ?").get(s.id);
  assert.deepEqual(sh(row.worktree, "log", "--format=%s", "-4").trim().split("\n"), ["Fix review findings", "Ticket 3", "Ticket 2", "Ticket 1"]);
});

test("Direct mode skips the pipeline", { skip: !hasPi && "pi CLI not found" }, async () => {
  const s = await mgr.create({ repoId: "me/demo", title: "Quick", prompt: "hello there", mode: "direct" });
  // origin/main has no setup commit yet (the first session never pushed), so setup runs first.
  assert.equal(s.phase, "setup");
  await waitFor(() => mgr.summary(s.id).phase === "direct");
  // Wait for the reply to the held task itself, not a momentary idle between setup and that turn.
  await waitFor(async () => {
    const tr = (await mgr.snapshot(s.id)).transcript;
    return !tr.busy && tr.messages.some((m: any) => m.role === "assistant" && JSON.stringify(m.content).includes("Hello from the mock"));
  });
  assert.equal(mgr.tickets(s.id).length, 0);

  // Skills written for Claude Code call a "Skill" tool; the extension serves it from the skill dirs.
  await mgr.send(s.id, "load skill please");
  const t = await waitFor(async () => {
    const tr = (await mgr.snapshot(s.id)).transcript;
    return tr.messages.find((m: any) => m.role === "toolResult" && m.toolName === "Skill");
  });
  assert.equal(t.isError, false);
  assert.match(JSON.stringify(t.content), /<skill name=\\"tdd\\"[\s\S]*tdd body/);
  assert.equal(mgr.summary(s.id).runs.length, 1);
});

test("the generated models.json carries the workbench-rescue provider for the Reviewer, with no literal key", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { writePiConfig } = await import("../src/settings.ts");
  const { config } = await import("../src/config.ts");
  const read = () => JSON.parse(fs.readFileSync(path.join(config.piAgentDir, "models.json"), "utf8"));
  // The Reviewer is on: openai, bound to the mock's origin.
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: RESCUE_KEY, baseUrl: mock.url });
  auto.saveAutoApproveSettings(db, { reviewer: { provider: "openai", baseUrl: mock.url, model: "mock-rescue" } });
  writePiConfig(db, proxy.url);
  const models = read();
  assert.equal(models.providers["workbench"].api, "openai-completions", "the local provider is unchanged");
  const rescue = models.providers["workbench-rescue"];
  assert.ok(rescue, "the rescue provider is generated");
  assert.equal(rescue.api, "openai-completions", "the rescue api follows the Reviewer's provider");
  assert.equal(rescue.baseUrl, proxy.url);
  assert.equal(rescue.apiKey, `$${RESCUE_TOKEN_ENV}`, "the api key is a reference to the token variable");
  assert.equal(rescue.models[0].id, "mock-rescue", "the rescue model is the Reviewer's model");
  assert.ok(!JSON.stringify(models).includes(RESCUE_KEY), "the Reviewer key never appears in models.json");
  // An anthropic Reviewer switches the api.
  auto.saveAutoApproveSettings(db, { reviewer: { provider: "anthropic", baseUrl: mock.url, model: "mock-rescue" } });
  writePiConfig(db, proxy.url);
  assert.equal(read().providers["workbench-rescue"].api, "anthropic-messages");
  // An empty Reviewer model turns rescue off: no rescue provider.
  auto.saveAutoApproveSettings(db, { reviewer: { provider: "anthropic", baseUrl: mock.url, model: "" } });
  writePiConfig(db, proxy.url);
  assert.equal(read().providers["workbench-rescue"], undefined, "reviewer off means no rescue provider");
});

test("a rescue run spawns with the Reviewer model through the proxy; the token is per-run and revoked on exit", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { writePiConfig } = await import("../src/settings.ts");
  // The Reviewer is on, openai, bound to the mock's origin; the proxy is pointed at it.
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: RESCUE_KEY, baseUrl: mock.url });
  auto.saveAutoApproveSettings(db, { reviewer: { provider: "openai", baseUrl: mock.url, model: "mock-rescue" } });
  writePiConfig(db, proxy.url);
  const s = await mgr.create({ repoId: "me/demo", title: "Rescue hop", prompt: "hello rescue", mode: "direct" });
  await waitFor(async () => {
    const tr = mgr.live.get(s.id).transcript;
    return !tr.busy && tr.messages.some((m: any) => m.role === "assistant" && JSON.stringify(m.content).includes("Hello from the mock"));
  });
  // A normal run: no token variable, no Reviewer key in the environment.
  const env0 = fs.readFileSync(`/proc/${mgr.live.get(s.id).proc.pid}/environ`, "utf8");
  assert.ok(!env0.includes(RESCUE_TOKEN_ENV), "a normal run gets no rescue token");
  assert.ok(!env0.includes(RESCUE_KEY));
  // The rescue run: a fresh pi process for the rescue run id.
  const rescueRunId = `${s.id}-t1-rescue-${Date.now().toString(36)}`;
  await mgr.switchRun(s.id, rescueRunId, true);
  await mgr.send(s.id, "rescue test");
  const req = await waitFor(() => mock.requests.find((r) => r.model === "mock-rescue"));
  assert.equal(req.auth, `Bearer ${RESCUE_KEY}`, "the Reviewer key is in the provider's header");
  assert.equal(req.path, "/v1/chat/completions");
  await waitFor(async () => {
    const tr = mgr.live.get(s.id).transcript;
    return !tr.busy && tr.messages.some((m: any) => m.role === "assistant" && JSON.stringify(m.content).includes("Hello from the mock"));
  });
  // The rescue run's environment: the token variable, and no Reviewer key.
  const env1 = fs.readFileSync(`/proc/${mgr.live.get(s.id).proc.pid}/environ`, "utf8");
  assert.ok(!env1.includes(RESCUE_KEY), "the Reviewer key never reaches the rescue run");
  const token = env1.split("\0").find((x) => x.startsWith(`${RESCUE_TOKEN_ENV}=`))?.slice(RESCUE_TOKEN_ENV.length + 1);
  assert.ok(token, "the rescue run's environment has the token variable");
  // Stop the run: the token is revoked with the process.
  await mgr.stop(s.id);
  await waitFor(() => mgr.live.get(s.id).proc?.exited);
  const dead = await fetch(`${proxy.url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(dead.status, 401, "the token of an exited run is refused");
  // Back on the plan conversation: the next run is local again, with no token.
  await mgr.switchRun(s.id, s.id, true);
  await mgr.send(s.id, "hello again");
  await waitFor(async () => {
    const tr = mgr.live.get(s.id).transcript;
    return !tr.busy && tr.messages.some((m: any) => m.role === "assistant" && JSON.stringify(m.content).includes("Hello from the mock"));
  });
  const env2 = fs.readFileSync(`/proc/${mgr.live.get(s.id).proc.pid}/environ`, "utf8");
  assert.ok(!env2.includes(RESCUE_TOKEN_ENV), "other runs' environments are unchanged");
});

// --- the stop rule (issue #39) ---------------------------------------------------------------

let specNum = 100;
/** A session started from a one-ticket spec issue whose body drives the mock (see mock-llm.ts). */
async function solveOne(body: string, spec = "A stuck ticket.") {
  const n = (specNum += 10);
  ghMock.seedSubIssues("me", "demo", { number: n, title: `Spec ${n}`, body: `## Solution\n${spec}` }, [{ number: n + 1, title: "Stuck", body }]);
  return mgr.create({ repoId: "me/demo", title: `Spec ${n}`, issueRef: `me/demo#${n}`, mode: "pipeline", startFrom: "tickets" });
}
const flagged = (id: string) => waitFor(() => mgr.summary(id).attention);
const settled = (id: string) => waitFor(() => !mgr.live.get(id).transcript.busy);
const toolCalls = (id: string, runId: string, name = "bash") => mgr.runTranscript(id, runId).messages.filter((m: any) => m.role === "toolResult" && m.toolName === name).length;
/** The Reviewer off: a stuck ticket stops the pipeline, with no rescue (issue #40). */
const rescueOff = () => auto.saveAutoApproveSettings(db, { reviewer: { model: "" } });
const notices = (id: string) => events.filter((e) => e.id === id && e.ev.type === "wb_notify").map((e) => e.ev.message as string);

test("a ticket that repeats one bash call trips the repeat limit: the session is flagged with the call, and the ticket keeps the stop reason", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { savePipelineSettings } = await import("../src/settings.ts");
  rescueOff();
  savePipelineSettings(db, { timeLimitMinutes: 30, repeatLimit: 3, toolCallLimit: 300 });
  const s = await solveOne("Make the tests pass. LOOPME");
  const attention = await flagged(s.id);
  assert.match(attention, /Ticket #1 hit the stop rule: the repeat limit/);
  assert.match(attention, /tests failed: expected Hello/);
  assert.match(attention, /The rescue is off \(the Reviewer has no model\)/);
  assert.match(attention, /\d\d:\d\d/, "it says when");
  assert.ok(notices(s.id).includes(attention), "a notification says the same");
  await settled(s.id);
  const runId = mgr.summary(s.id).tickets[0].runId;
  assert.ok(toolCalls(s.id, runId) <= 3, "the third identical call stops the run");
  const row = db.prepare("SELECT stop_reason FROM tickets WHERE session_id = ? AND num = 1").get(s.id);
  assert.match(row.stop_reason, /repeat/);
});

test("a TDD cycle that runs the same test command between writes never trips the repeat limit", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { savePipelineSettings } = await import("../src/settings.ts");
  rescueOff();
  savePipelineSettings(db, { timeLimitMinutes: 30, repeatLimit: 2, toolCallLimit: 300 });
  const s = await solveOne("Cycle red and green. CYCLEME");
  await waitFor(() => mgr.summary(s.id).phase === "pr" || mgr.summary(s.id).attention);
  assert.equal(mgr.summary(s.id).attention, null);
  assert.equal(mgr.summary(s.id).tickets[0].status, "done");
});

test("a run that makes many different calls stops at the tool-call limit", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { savePipelineSettings } = await import("../src/settings.ts");
  rescueOff();
  savePipelineSettings(db, { timeLimitMinutes: 30, repeatLimit: 3, toolCallLimit: 4 });
  const s = await solveOne("Wander around. WANDERME");
  assert.match(await flagged(s.id), /Ticket #1 hit the stop rule: the tool-call limit \(5 tool calls, limit 4\)/);
  await settled(s.id);
  assert.ok(toolCalls(s.id, mgr.summary(s.id).tickets[0].runId) <= 5);
});

test("the time limit trips on working time; a decision waiting for the user pauses the clock", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { savePipelineSettings } = await import("../src/settings.ts");
  rescueOff();
  const { config } = await import("../src/config.ts");
  const minute = config.stopRuleMinuteMs;
  config.stopRuleMinuteMs = 300;
  try {
    savePipelineSettings(db, { timeLimitMinutes: 1, repeatLimit: 3, toolCallLimit: 300 });
    const s = await solveOne("Take your time. ASKME SLOWME");
    const req = await waitFor(() => mgr.summary(s.id).pending[0]);
    // Away for four times the limit: the clock is paused, so the run is not stopped.
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(mgr.summary(s.id).attention, null);
    const answeredAt = Date.now();
    mgr.respond(s.id, req.id, { value: "Hello" });
    // Back at work, the long `sleep` passes the limit.
    assert.match(await flagged(s.id), /Ticket #1 hit the stop rule: the time limit/);
    const row = db.prepare("SELECT stop_reason FROM tickets WHERE session_id = ? AND num = 1").get(s.id);
    assert.ok(JSON.parse(row.stop_reason).at >= answeredAt, "the clock fired only after the user answered");
    await settled(s.id);
    assert.equal(toolCalls(s.id, mgr.summary(s.id).tickets[0].runId), 1, "the sleep ran before the limit passed");
  } finally {
    config.stopRuleMinuteMs = minute;
  }
});

test("a user abort of a ticket run keeps today's behavior: no stop-rule flag", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { savePipelineSettings } = await import("../src/settings.ts");
  rescueOff();
  savePipelineSettings(db, { timeLimitMinutes: 30, repeatLimit: 3, toolCallLimit: 300 });
  const s = await solveOne("Take your time. SLOWME");
  // Abort once the `sleep` process runs: an abort that lands before pi spawns it is not cancelled.
  const sleeping = () =>
    fs.readdirSync("/proc").some((pid) => {
      try {
        return /^\d+$/.test(pid) && fs.readFileSync(`/proc/${pid}/cmdline`, "utf8") === "sleep\u000030\u0000";
      } catch {
        return false;
      }
    });
  await waitFor(sleeping);
  await mgr.abort(s.id);
  const attention = await flagged(s.id);
  assert.match(attention, /Ticket #1 was stopped/);
  assert.doesNotMatch(attention, /stop rule/);
  const row = db.prepare("SELECT stop_reason FROM tickets WHERE session_id = ? AND num = 1").get(s.id);
  assert.equal(row.stop_reason, null);
});

test("the stop rule watches only implement-phase runs: setup and review runs pass a tool-call limit of 1", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { savePipelineSettings } = await import("../src/settings.ts");
  rescueOff();
  savePipelineSettings(db, { timeLimitMinutes: 30, repeatLimit: 3, toolCallLimit: 1 });
  try {
    const s = await solveOne("Done at once. QUICKME", "A quick ticket. LONGREVIEW");
    await waitFor(() => mgr.summary(s.id).phase === "pr" || mgr.summary(s.id).attention);
    assert.equal(mgr.summary(s.id).attention, null);
    // The review run made five calls (a commit, three checks, finish_review) under the same limit.
    const review = mgr.summary(s.id).runs.find((r: any) => r.label === "Review");
    assert.equal(toolCalls(s.id, review.id), 4);
    assert.ok(!mgr.summary(s.id).runs.some((r: any) => r.label === "retro"), "no rescues, no retro run");
    assert.equal(toolCalls(s.id, review.id, "finish_review"), 1);
  } finally {
    savePipelineSettings(db, { timeLimitMinutes: 30, repeatLimit: 3, toolCallLimit: 300 });
  }
});

test("an idle run's clock is paused: a ticket that stopped without finishing does not trip the time limit while the user is away", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { savePipelineSettings } = await import("../src/settings.ts");
  rescueOff();
  const { config } = await import("../src/config.ts");
  const minute = config.stopRuleMinuteMs;
  config.stopRuleMinuteMs = 300;
  try {
    savePipelineSettings(db, { timeLimitMinutes: 1, repeatLimit: 3, toolCallLimit: 300 });
    const s = await solveOne("Unsure. SILENTME");
    assert.match(await flagged(s.id), /Ticket #1 stopped without finishing/);
    await settled(s.id);
    await new Promise((r) => setTimeout(r, 1200));
    // The user replies: the run answers and settles again without finishing, well inside the limit.
    events.length = 0;
    await mgr.send(s.id, "please continue");
    await waitFor(() => notices(s.id).length > 0);
    assert.match(mgr.summary(s.id).attention, /Ticket #1 stopped without finishing/);
  } finally {
    config.stopRuleMinuteMs = minute;
    savePipelineSettings(db, { timeLimitMinutes: 30, repeatLimit: 3, toolCallLimit: 300 });
  }
});

// --- rescue and fix runs (issue #40) -----------------------------------------------------------

/** The Reviewer on (openai, the mock's origin): stuck tickets get a rescue run. */
function rescueOn() {
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: RESCUE_KEY, baseUrl: mock.url });
  auto.saveAutoApproveSettings(db, { reviewer: { provider: "openai", baseUrl: mock.url, model: "mock-rescue" } });
}
/** A session from a spec whose tickets have these bodies, each blocked by the one before. */
async function solveAll(bodies: string[]) {
  const n = (specNum += 10);
  const subs = bodies.map((body, i) => ({ number: n + 1 + i, title: `Ticket ${i + 1}`, body, ...(i ? { blockedBy: [n + i] } : {}) }));
  ghMock.seedSubIssues("me", "demo", { number: n, title: `Spec ${n}`, body: "## Solution\nRescue me." }, subs);
  return mgr.create({ repoId: "me/demo", title: `Spec ${n}`, issueRef: `me/demo#${n}`, mode: "pipeline", startFrom: "tickets" });
}

test("a looping ticket gets a rescue run, a diagnosed result starts a fix run, the fix finishes the ticket, and the pipeline goes on", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { savePipelineSettings } = await import("../src/settings.ts");
  savePipelineSettings(db, { timeLimitMinutes: 30, repeatLimit: 3, toolCallLimit: 300 });
  rescueOn();
  const before = mock.requests.length;
  const s = await solveAll(["Greet the user. DIRTYME LOOPME HANDOFF-A", "Document it."]);
  const done = await waitFor(() => {
    const x = mgr.summary(s.id);
    return x.phase === "pr" || x.attention ? x : undefined;
  }, 90_000);
  assert.equal(done.attention, null);
  assert.deepEqual(done.tickets.map((t: any) => `${t.num}:${t.status}:${t.rescueState}`), ["1:done:rescued", "2:done:null"]);
  assert.deepEqual(done.runs.map((r: any) => r.label), ["Plan", "#1 Ticket 1", "#1 rescue", "#1 fix", "#2 Ticket 2", "Review", "retro"]);

  // The rescue went to the Reviewer model through the proxy, with the Reviewer key in the header.
  const rescue = mock.requests.slice(before).find((r) => r.model === "mock-rescue");
  assert.ok(rescue, "the rescue run called the Reviewer model");
  assert.equal(rescue.auth, `Bearer ${RESCUE_KEY}`);
  // The handoff is built from facts.
  const handoff = JSON.stringify(rescue.messages);
  assert.match(handoff, /<skill name=\\"diagnosing-bugs\\"/);
  assert.match(handoff, /HANDOFF-A/, "the ticket");
  assert.match(handoff, /issues\/\d+/, "the spec pointer");
  assert.match(handoff, /the repeat limit/, "the stop reason");
  assert.match(handoff, /## Start commit\\n[0-9a-f]{40}/, "the start commit");
  assert.match(handoff, /## Diff since the start commit[\s\S]*README.md[\s\S]*\+half-done/, "the diff, uncommitted changes included");
  assert.match(handoff, /## The stuck run's last tool errors\\n- bash: tests failed: expected Hello/, "the stuck run's last tool errors");
  assert.match(handoff, /\.jsonl/, "the stuck run's session file");
  assert.match(handoff, /do not use ask_user/);
  assert.match(handoff, /Phases 1 to 4 only/);
  assert.match(handoff, /Do not commit/);
  assert.match(handoff, /\[DEBUG-\.\.\.\]/);
  assert.match(handoff, /leave the worktree as you found it/);

  // The fix run is local, carries the diagnosis, and writes the regression test first.
  const fix = mock.requests.slice(before).find((r) => r.model !== "mock-rescue" && JSON.stringify(r.messages ?? []).includes("## Diagnosis"));
  assert.ok(fix, "the fix run ran on the local model");
  const fixText = JSON.stringify(fix.messages);
  assert.match(fixText, /<skill name=\\"tdd\\"/);
  assert.match(fixText, /Command: echo red/);
  assert.match(fixText, /work.txt:1 has no greeting/);
  assert.match(fixText, /regression test first/);
});

/** Run one stuck ticket whose rescue or fix goes wrong; wait for the flag. */
async function rescueFails(body: string) {
  const { savePipelineSettings } = await import("../src/settings.ts");
  savePipelineSettings(db, { timeLimitMinutes: 30, repeatLimit: 3, toolCallLimit: 300 });
  rescueOn();
  const s = await solveOne(body);
  const attention = await flagged(s.id);
  await settled(s.id);
  return { s, attention, ticket: mgr.summary(s.id).tickets[0], labels: mgr.summary(s.id).runs.map((r: any) => r.label) };
}

test("a rescue run that changes the worktree flags the session, and the ticket's rescue is used", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { attention, ticket, labels } = await rescueFails("Greet. LOOPME RESCUE_DIRTY");
  assert.match(attention, /Ticket #1's rescue run changed the worktree/);
  assert.equal(ticket.status, "blocked");
  assert.equal(ticket.rescueState, "failed");
  assert.ok(!labels.includes("#1 fix"), "no fix run starts");
});

for (const [word, says] of [["RESCUE_NOLOOP", /could not build a feedback loop[\s\S]*Rescue says no_loop/], ["RESCUE_FAILED", /found no cause: every hypothesis failed[\s\S]*Rescue says failed/]] as const) {
  test(`a rescue that reports ${word.slice(7).toLowerCase()} flags the session and counts as a used rescue`, { skip: !hasPi && "pi CLI not found" }, async () => {
    const { attention, ticket, labels } = await rescueFails(`Greet. LOOPME ${word}`);
    assert.match(attention, says);
    assert.equal(ticket.rescueState, "failed");
    assert.ok(ticket.rescueRunId, "the rescue is used");
    assert.ok(labels.includes("#1 rescue") && !labels.includes("#1 fix"));
  });
}

test("a rescue run that trips the stop rule flags the session and counts as a used rescue", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { attention, ticket } = await rescueFails("Greet. LOOPME RESCUE_LOOP");
  assert.match(attention, /Ticket #1's rescue run hit the stop rule: the repeat limit/);
  assert.equal(ticket.rescueState, "failed");
});

test("a rescue run with no finish_diagnosis report flags the session and counts as a used rescue", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { attention, ticket } = await rescueFails("Greet. LOOPME RESCUE_SILENT");
  assert.match(attention, /Ticket #1's rescue run stopped without finish_diagnosis/);
  assert.equal(ticket.rescueState, "failed");
});

test("a fix run that trips the stop rule flags the session, with no second rescue", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { attention, ticket, labels } = await rescueFails("Greet. LOOPME FIXLOOPME");
  assert.match(attention, /Ticket #1's fix run hit the stop rule/);
  assert.equal(ticket.rescueState, "failed");
  assert.equal(labels.filter((l: string) => l === "#1 rescue").length, 1);
});

test("a blocked fix run flags the session; a manual Retry keeps the rescue count, so a second rescue is refused", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { s, attention, ticket } = await rescueFails("Greet. LOOPME FIXBLOCKME");
  assert.match(attention, /Ticket #1's fix run is blocked: The diagnosis did not help/);
  assert.equal(ticket.rescueState, "failed");
  const rescues = mock.requests.filter((r) => r.model === "mock-rescue").length;
  await mgr.pipelineAction(s.id, "retry");
  const again = await flagged(s.id);
  assert.match(again, /Ticket #1 hit the stop rule: the repeat limit[\s\S]*It already had its rescue/);
  assert.equal(mock.requests.filter((r) => r.model === "mock-rescue").length, rescues, "no second rescue run");
});

test("a fourth rescue in one spec is refused and flags", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { savePipelineSettings } = await import("../src/settings.ts");
  savePipelineSettings(db, { timeLimitMinutes: 30, repeatLimit: 3, toolCallLimit: 300 });
  rescueOn();
  const s = await solveAll(["One. LOOPME", "Two. LOOPME", "Three. LOOPME", "Four. LOOPME"]);
  const attention = await waitFor(() => mgr.summary(s.id).attention, 120_000);
  assert.match(attention, /Ticket #4 hit the stop rule[\s\S]*The spec already had 3 rescues/);
  assert.deepEqual(mgr.summary(s.id).tickets.map((t: any) => t.rescueState), ["rescued", "rescued", "rescued", null]);
});

// --- the retro run (issue #41) -----------------------------------------------------------------

/** One rescued ticket, then the review; resolves when the pipeline has opened the PR. */
async function rescuedSpec(body: string) {
  const { savePipelineSettings } = await import("../src/settings.ts");
  savePipelineSettings(db, { timeLimitMinutes: 30, repeatLimit: 3, toolCallLimit: 300 });
  rescueOn();
  const s = await solveOne(body);
  const phases: string[] = [];
  const retroOn: string[] = [];
  const onSummary = (x: any) => {
    if (x.id !== s.id) return;
    if (phases.at(-1) !== x.phase) phases.push(x.phase);
    if (x.phase === "retro") retroOn.push(x.runs.find((r: any) => r.id === x.activeRun)?.label);
  };
  mgr.on("summary", onSummary);
  try {
    const done = await waitFor(() => (mgr.summary(s.id).phase === "pr" ? mgr.summary(s.id) : undefined), 90_000);
    return { s, done, phases, retroOn };
  } finally {
    mgr.off("summary", onSummary);
  }
}

test("a spec with a rescued ticket gets a retro run after the review: facts and pointers in, a report out, then done on the plan conversation", { skip: !hasPi && "pi CLI not found" }, async () => {
  const before = mock.requests.length;
  const { s, done, phases, retroOn } = await rescuedSpec("Greet. LOOPME");
  assert.deepEqual(done.runs.map((r: any) => r.label).slice(-2), ["Review", "retro"]);
  assert.deepEqual(phases.filter((p) => ["review", "retro", "pr"].includes(p)), ["review", "retro", "pr"]);
  assert.equal(done.activeRun, s.id, "back on the plan conversation");
  // The run switched to the retro before the phase was announced, and back to the plan before done.
  assert.equal(retroOn[0], "retro");
  assert.ok(!retroOn.includes("Review"), "no summary shows the retro phase on the review run");
  assert.equal(done.attention, null);

  // The retro ran on the Reviewer model through the proxy, with the server's facts and the pointers.
  const retro = mock.requests.slice(before).find((r) => r.model === "mock-rescue" && JSON.stringify(r.messages ?? []).includes('<skill name=\\"retro\\"'));
  assert.ok(retro, "the retro run called the Reviewer model");
  const text = JSON.stringify(retro.messages);
  const t = done.tickets[0];
  for (const run of [t.runId, t.rescueRunId, t.fixRunId]) assert.match(text, new RegExp(`_${run}\\.jsonl`), `the session file of ${run}`);
  assert.match(text, /Stop rule: the repeat limit/);
  assert.match(text, /Diagnosis: .*diagnosed/);
  assert.match(text, /Fix result: rescued/);
  assert.match(text, /server\/src\/pipeline.ts/);
  assert.match(text, /Settings → Pipeline\), now: \{\\"timeLimitMinutes\\":30/);
  assert.match(text, /Settings → Model\), now: /);
  assert.match(text, /llama.cpp sampling settings[^.]*outside this repository/);
  assert.match(text, /Propose only/);
  assert.match(text, /do not commit/i);

  // The report: an info notification before done, and in the retro run's own transcript.
  const n = events.filter((e) => e.id === s.id && e.ev.type === "wb_notify");
  const report = n.findIndex((e) => /Retro report[\s\S]*Raise the repeat limit to 4/.test(e.ev.message));
  assert.ok(report >= 0, "the report notifies");
  assert.equal(n[report].ev.level, "info");
  assert.ok(n.findIndex((e) => /All tickets are done and reviewed/.test(e.ev.message)) > report, "done comes after the retro");
  const retroRun = done.runs.find((r: any) => r.label === "retro");
  assert.ok(mgr.runTranscript(s.id, retroRun.id).messages.some((m: any) => m.role === "toolResult" && m.toolName === "finish_retro"));
});

for (const [word, says] of [["RETRO_SILENT", /retro run stopped without finish_retro/], ["RETRO_LOOP", /retro run hit the stop rule: the repeat limit/]] as const) {
  test(`a retro run that ${word === "RETRO_LOOP" ? "trips the stop rule" : "misses its report"} notifies the user and the pipeline still finishes`, { skip: !hasPi && "pi CLI not found" }, async () => {
    const { s, done } = await rescuedSpec(`Greet. LOOPME ${word}`);
    assert.equal(done.attention, null, "the PR can be created");
    assert.ok(events.some((e) => e.id === s.id && e.ev.type === "wb_notify" && says.test(e.ev.message)));
    assert.equal(done.activeRun, s.id);
  });
}

test("a retro run that changes the worktree flags the session", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { done } = await rescuedSpec("Greet. LOOPME RETRO_DIRTY");
  assert.match(done.attention ?? (await flagged(done.id)), /retro run changed the worktree/);
});

test("QA → Issues during a retro run stops it; the resumed card reviews and retros again, then opens the PR", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { savePipelineSettings } = await import("../src/settings.ts");
  savePipelineSettings(db, { timeLimitMinutes: 30, repeatLimit: 3, toolCallLimit: 300 });
  rescueOn();
  const s = await solveOne("Greet. LOOPME RETRO_HOLD");
  const dump = (e: Error) => {
    throw new Error(`${e.message}: ${JSON.stringify({ ...mgr.summary(s.id), tickets: undefined })}`);
  };
  const holding = await waitFor(() => {
    const x = mgr.summary(s.id);
    return x.phase === "retro" && x.pending.some((p: any) => p.kind === "decision") ? x : undefined;
  }, 90_000).catch(dump);
  const firstRetro = holding.activeRun;
  await mgr.move(s.id, "issues");
  assert.equal(mgr.summary(s.id).phase, "ready");
  assert.equal(mgr.summary(s.id).attention, null);

  // Issues → Doing: every ticket is done, so the review runs again, then a fresh retro.
  await mgr.move(s.id, "doing");
  const again = await waitFor(() => {
    const x = mgr.summary(s.id);
    return x.phase === "retro" && x.activeRun !== firstRetro && x.pending.some((p: any) => p.kind === "decision") ? x : undefined;
  }, 90_000).catch(dump);
  mgr.respond(s.id, again.pending[0].id, { value: "Yes" });
  const done = await waitFor(() => (mgr.summary(s.id).phase === "pr" ? mgr.summary(s.id) : undefined), 90_000).catch(dump);
  assert.equal(done.attention, null);
  assert.ok(events.some((e) => e.id === s.id && e.ev.type === "wb_notify" && /Retro report/.test(e.ev.message)));
});
