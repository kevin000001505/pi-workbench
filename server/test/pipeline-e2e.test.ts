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
  for (const name of ["grill-with-docs", "to-spec", "to-tickets", "tdd", "code-review", "setup-matt-pocock-skills"]) {
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
  // Solve all (a later ticket's Issues → Doing move) resumes it; until that route exists, set the
  // phase and let the pipeline's retry start the next ticket.
  db.prepare("UPDATE sessions SET phase = 'implement' WHERE id = ?").run(s.id);
  await mgr.pipelineAction(s.id, "retry");
  await waitFor(() => mgr.summary(s.id).phase === "implement");
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
