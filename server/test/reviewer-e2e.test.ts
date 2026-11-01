/**
 * Reviewer (issue #18): a permission the risk judge did not rate safe goes to the frontier
 * reviewer (Anthropic or OpenAI) instead of the user. The reviewer returns a structured verdict:
 * allow (that one call only), escalate (a deny is an escalation for now), or a failure that
 * falls back to the user. A real `pi --mode rpc` process against the scripted mock LLM, driven
 * through SessionManager, like auto-approve.test.ts; the judge and the reviewer are scripted mocks.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { DANGEROUS, RISKY, startMockJudge } from "./mock-judge.ts";
import { startMockLlm } from "./mock-llm.ts";
import { startMockReviewer } from "./mock-reviewer.ts";

const piBin = process.env.PI_BIN ?? "pi";
const hasPi = spawnSync(piBin, ["--version"]).status === 0;
const skip = !hasPi && "pi CLI not found";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-rev-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "reviewer-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");
process.env.HOME = path.join(tmp, "agent-home");
process.env.AUTO_APPROVE_TIMEOUT_MS = "1500";
process.env.REVIEWER_TIMEOUT_MS = "1500";
process.env.PI_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-extension", "workbench.ts");

const JEV_TOKEN = "jev-secret-token";
const ANTHROPIC_KEY = "anthropic-secret-key";
const OPENAI_KEY = "openai-secret-key";
let mock: Awaited<ReturnType<typeof startMockLlm>>;
let jev: Awaited<ReturnType<typeof startMockJudge>>;
let claude: Awaited<ReturnType<typeof startMockReviewer>>;
let gpt: Awaited<ReturnType<typeof startMockReviewer>>;
let mgr: any;
let db: any;
let secrets: any;
let auto: typeof import("../src/autoapprove.ts");
let sessionId: string;
const events: any[] = [];

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const JEV = { baseUrl: () => jev.url, model: "jev-latest" };
const ANTHROPIC = { provider: "anthropic", model: "claude-mock", baseUrl: () => claude.url };
const OPENAI = { provider: "openai", model: "gpt-mock", baseUrl: () => gpt.url };
/** Turn auto-approve on: the judge at Jev, the reviewer as given (Anthropic by default). */
const enable = (reviewer: { provider?: "anthropic" | "openai"; model?: string; baseUrl?: string | (() => string) } = {}) =>
  auto.configureAutoApprove(db, secrets, {
    enabled: true,
    judge: { baseUrl: JEV.baseUrl(), model: JEV.model },
    reviewer: {
      provider: reviewer.provider ?? "anthropic",
      model: reviewer.model ?? "claude-mock",
      baseUrl: typeof reviewer.baseUrl === "function" ? reviewer.baseUrl() : reviewer.baseUrl,
    },
  });

async function settle(id: string) {
  await waitFor(() => mgr.summary(id).status === "idle");
}

/** Send a prompt; resolve with the messages it added once its bash call has a result and the run settled. */
async function run(id: string, prompt: string) {
  const from = (await mgr.snapshot(id)).transcript.messages.length;
  await mgr.send(id, prompt);
  return waitFor(async () => {
    const t = (await mgr.snapshot(id)).transcript;
    const added = t.messages.slice(from);
    return added.some((m: any) => m.role === "toolResult" && m.toolName === "bash") && !t.busy ? added : undefined;
  }, 45_000);
}

/** The permission card, once the reviewer has spoken (or never, for a test that ends in failure). */
async function reviewedCard(id: string, prompt: string) {
  await mgr.send(id, prompt);
  return waitFor(
    () => mgr.summary(id).pending.find((x: any) => x.kind === "permission" && x.reviewer && x.reviewer.state !== "reviewing"),
    45_000,
  );
}

async function deny(id: string, req: any) {
  mgr.respond(id, req.id, { value: "Deny" });
  await settle(id);
}

before(async () => {
  mock = await startMockLlm();
  jev = await startMockJudge({ protocol: "systemone", model: "jev-latest", token: JEV_TOKEN });
  claude = await startMockReviewer({ provider: "anthropic", model: "claude-mock", key: ANTHROPIC_KEY });
  gpt = await startMockReviewer({ provider: "openai", model: "gpt-mock", key: OPENAI_KEY });
  const { config } = await import("../src/config.ts");
  const { openDb } = await import("../src/db.ts");
  const { GLOBAL_SCOPE, SecretStore } = await import("../src/secrets.ts");
  const { saveModelSettings, writePiConfig } = await import("../src/settings.ts");
  const { SessionManager } = await import("../src/sessions.ts");
  const { saveSshHosts } = await import("../src/ssh.ts");
  auto = await import("../src/autoapprove.ts");
  config.piBin = piBin;
  db = openDb(config.dbFile);
  saveModelSettings(db, { baseUrl: mock.url });
  writePiConfig(db);

  const bare = path.join(tmp, "remote.git");
  const seed = path.join(tmp, "seed");
  fs.mkdirSync(seed);
  sh(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "README.md"), "# demo\n");
  sh(seed, "add", ".");
  sh(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  sh(tmp, "clone", "-q", "--bare", seed, bare);
  const clone = path.join(config.reposDir, "me", "demo");
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  sh(tmp, "clone", "-q", bare, clone);
  db.prepare("INSERT INTO repos (id, owner, name, default_branch, private, added_at) VALUES ('me/demo','me','demo','main',1,0)").run();

  // One known SSH host, with a key name the reviewer context must not carry.
  secrets = new SecretStore(db, process.env.WORKBENCH_MASTER_KEY!);
  secrets.set(GLOBAL_SCOPE, "server_key", `-----BEGIN OPENSSH PRIVATE KEY-----\nreviewer-test-key-data==\n-----END OPENSSH PRIVATE KEY-----\n`);
  saveSshHosts(db, [{ alias: "Media", user: "kevin", hostname: "192.168.1.218", keyName: "server_key" }]);
  auto.saveAutoApproveKey(secrets, { key: "judgeToken", value: JEV_TOKEN, baseUrl: jev.url });

  if (hasPi) {
    mgr = new SessionManager(db, secrets, async () => ({
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    }));
    mgr.on("event", (_id: string, ev: any) => events.push(ev));
    const s = await mgr.create({ repoId: "me/demo", title: "Review", prompt: "hello there", mode: "direct" });
    sessionId = s.id;
    await waitFor(() => events.some((e) => e.type === "message_end" && JSON.stringify(e.message).includes("Hello from the mock")), 60_000);
    await settle(sessionId);
  }
});

after(async () => {
  if (hasPi && mgr) await mgr.shutdown();
  await mock.close();
  await jev.close();
  await claude.close();
  await gpt.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- reviewer settings and keys (module level, no pi needed) ---------------------------------

test("reviewer settings save with the public-API base URL default per provider", async () => {
  const saved = await auto.configureAutoApprove(db, secrets, {
    enabled: true,
    judge: { baseUrl: JEV.baseUrl(), model: JEV.model },
    reviewer: { provider: "anthropic", model: "claude-mock" },
  });
  assert.equal(saved.reviewer.baseUrl, "https://api.anthropic.com");
  const o = await auto.configureAutoApprove(db, secrets, {
    enabled: true,
    judge: { baseUrl: JEV.baseUrl(), model: JEV.model },
    reviewer: { provider: "openai", model: "gpt-mock" },
  });
  assert.equal(o.reviewer.baseUrl, "https://api.openai.com/v1");
  // An explicit base URL is kept.
  const c = await auto.configureAutoApprove(db, secrets, {
    enabled: true,
    judge: { baseUrl: JEV.baseUrl(), model: JEV.model },
    reviewer: { provider: "anthropic", model: "claude-mock", baseUrl: claude.url },
  });
  assert.equal(c.reviewer.baseUrl, claude.url);
  // Changing the provider without a URL resets the base URL to that provider's public API.
  const back = await auto.configureAutoApprove(db, secrets, {
    enabled: true,
    judge: { baseUrl: JEV.baseUrl(), model: JEV.model },
    reviewer: { provider: "openai", model: "gpt-mock" },
  });
  assert.equal(back.reviewer.baseUrl, "https://api.openai.com/v1");
});

test("reviewer settings refuse a bad provider, an empty model or a non-http URL", async () => {
  await enable();
  for (const [patch, why] of [
    [{ provider: "gemini" }, /provider/],
    [{ model: "" }, /model/],
    [{ baseUrl: "ftp://no" }, /http/],
  ] as const) {
    await assert.rejects(enable(patch), why);
  }
  assert.equal(auto.getAutoApproveSettings(db).reviewer.provider, "anthropic", "a refused save changes nothing");
});

test("the reviewer key is write-only, bound to its origin, and never in the view", async () => {
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: ANTHROPIC_KEY, baseUrl: claude.url });
  let view = auto.autoApproveView(db, secrets);
  assert.equal(view.keys.reviewerKey, true);
  assert.equal(view.keys.reviewerKeyOrigin, new URL(claude.url).origin);
  assert.ok(!JSON.stringify(view).includes(ANTHROPIC_KEY), "the key value is never in the view");
  // Re-binding points at the new host.
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: OPENAI_KEY, baseUrl: gpt.url });
  view = auto.autoApproveView(db, secrets);
  assert.equal(view.keys.reviewerKeyOrigin, new URL(gpt.url).origin);
  // Clearing removes it.
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: null });
  view = auto.autoApproveView(db, secrets);
  assert.equal(view.keys.reviewerKey, false);
  assert.equal(view.keys.reviewerKeyOrigin, undefined);
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: ANTHROPIC_KEY, baseUrl: claude.url });
  assert.throws(() => auto.saveReviewerKey(secrets, { key: "other" }), /Unknown key/);
});

test("the reviewer key is out of envFor: reserved scope, like the judge token", async () => {
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: ANTHROPIC_KEY, baseUrl: claude.url });
  assert.ok(!JSON.stringify(secrets.envFor()).includes(ANTHROPIC_KEY));
  assert.ok(!JSON.stringify(secrets.envFor("me/demo")).includes(ANTHROPIC_KEY));
});

// --- reviewPermission against the reviewer mock (module level, no pi needed) ----------------

const REVIEW = {
  tool: "bash",
  subject: "rm -rf build",
  reasons: ["rm -r / -f"],
  rating: "risky" as const,
  judgeDetail: "deletes_data 0.90 · reaches_outside 0.10 · hard_to_undo 0.60 · fits_task 0.80",
  session: { title: "Review", task: "please rm the build dir", repo: "me/demo", branch: "pi/review-x", worktree: "/w", phase: "direct" },
  transcript: "user: hello there\nassistant: Hello from the mock model.",
  ssh: [{ alias: "Media", user: "kevin", hostname: "192.168.1.218" }],
};

/** Bind the right key to the right host, point the settings at the mock, and review `REVIEW`. */
async function reviewAgainst(which: "claude" | "gpt", replies: { text?: string; status?: number; body?: string; delayMs?: number }[]) {
  const m = which === "claude" ? claude : gpt;
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: which === "claude" ? ANTHROPIC_KEY : OPENAI_KEY, baseUrl: m.url });
  m.replies.length = 0;
  for (const r of replies) m.replies.push(r);
  await enable(which === "claude" ? ANTHROPIC : OPENAI);
  return auto.reviewPermission(REVIEW, auto.getAutoApproveSettings(db), auto.savedReviewerKey(secrets));
}

test("the reviewer request carries the call, the rating and the session context", async () => {
  const from = claude.requests.length;
  const v = await reviewAgainst("claude", []);
  assert.equal(v.outcome, "allow");
  const req = claude.requests.slice(from).find((r) => r.path === "/v1/messages")!;
  const sent = JSON.stringify(req.body);
  assert.equal(req.body.model, "claude-mock");
  assert.equal(req.xApiKey, ANTHROPIC_KEY);
  assert.ok(sent.includes("rm -rf build"), "the call subject");
  assert.ok(sent.includes("risky"), "the judge's rating");
  assert.ok(sent.includes("deletes_data 0.90"), "the judge's probabilities");
  assert.ok(sent.includes("please rm the build dir"), "the task");
  assert.ok(sent.includes("hello there"), "the recent transcript");
  assert.ok(sent.includes("Media") && sent.includes("kevin@192.168.1.218"), "the ssh hosts: alias and user@hostname");
  assert.ok(!sent.includes("server_key"), "no key names");
});

test("a structured allow verdict allows, with the model's reason", async () => {
  const v = await reviewAgainst("claude", [{ text: '{"verdict":"allow","reason":"contained, fits the task"}' }]);
  assert.equal(v.outcome, "allow");
  assert.equal(v.by, "Claude");
  assert.match(v.note, /contained, fits the task/);
});

test("an escalate verdict and a deny verdict both wait for the user (deny for now)", async () => {
  for (const verdict of ["escalate", "deny"]) {
    const v = await reviewAgainst("claude", [{ text: `{"verdict":"${verdict}","reason":"could break the remote"}` }]);
    assert.equal(v.outcome, "escalate", verdict);
    assert.match(v.note, /could break the remote/);
  }
});

for (const [name, reply, why] of [
  ["an HTTP 500", { status: 500, body: JSON.stringify({ error: { message: "overloaded" } }) }, /HTTP 500/],
  ["a timeout", { text: '{"verdict":"allow"}', delayMs: 3000 }, /no answer within/],
  ["garbage text", { text: "I think this is fine, probably safe." }, /verdict/],
  ["a JSON with an unknown verdict", { text: '{"verdict":"maybe","reason":"?"}' }, /verdict/],
  ["an empty reply", { text: "" }, /verdict/],
] as const) {
  test(`reviewer ${name}: falls back to the user with a note`, async () => {
    const v = await reviewAgainst("claude", [reply]);
    assert.equal(v.outcome, "failed", name);
    assert.match(v.note, why);
  });
}

test("the OpenAI provider works too, selected by the setting, with a Bearer key", async () => {
  const from = gpt.requests.length;
  const v = await reviewAgainst("gpt", []);
  assert.equal(v.outcome, "allow");
  assert.equal(v.by, "OpenAI");
  const req = gpt.requests.slice(from).find((r) => r.path === "/v1/chat/completions")!;
  assert.equal(req.auth, `Bearer ${OPENAI_KEY}`);
});

test("a key saved for one origin is not sent to the other host", async () => {
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: ANTHROPIC_KEY, baseUrl: claude.url });
  await enable(OPENAI);
  const v = await auto.reviewPermission(REVIEW, auto.getAutoApproveSettings(db), auto.savedReviewerKey(secrets));
  assert.equal(v.outcome, "failed", "no key for this host: the call fails");
  assert.match(v.note, /403|no key|invalid/i);
  // Re-binding the key to the OpenAI host works.
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: OPENAI_KEY, baseUrl: gpt.url });
  const ok = await auto.reviewPermission(REVIEW, auto.getAutoApproveSettings(db), auto.savedReviewerKey(secrets));
  assert.equal(ok.outcome, "allow");
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: ANTHROPIC_KEY, baseUrl: claude.url });
});

test("Settings → Test reports whether the saved reviewer answers with a verdict", async () => {
  await enable(ANTHROPIC);
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: ANTHROPIC_KEY, baseUrl: claude.url });
  const ok = await auto.testReviewer(auto.getAutoApproveSettings(db), auto.savedReviewerKey(secrets));
  assert.equal(ok.ok, true);
  assert.match(ok.message, /Claude/);
  claude.replies.push({ status: 401 });
  const bad = await auto.testReviewer(auto.getAutoApproveSettings(db), auto.savedReviewerKey(secrets));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /HTTP 401/);
});

// --- end to end: judge → reviewer through a real pi process ---------------------------------

test("a risky call the reviewer allows runs, with an allowed-by line", { skip }, async () => {
  await enable();
  jev.replies.push({ nouls: RISKY });
  claude.replies.push({ text: '{"verdict":"allow","reason":"routine for the task"}' });
  const added = await run(sessionId, "please rm the build dir");
  const result = added.find((m: any) => m.role === "toolResult");
  assert.ok(!JSON.stringify(result.content).includes("denied"), "the call was not blocked");
  const line = added.find((m: any) => m.role === "autoAnswer");
  assert.equal(line.by, "Claude");
  assert.equal(line.subject, "rm -rf build");
  assert.match(line.detail, /routine for the task/);
});

test("a safe rating allows without the reviewer; the reviewer is not asked", { skip }, async () => {
  await enable();
  const before = claude.requests.length;
  const added = await run(sessionId, "please push");
  const line = added.find((m: any) => m.role === "autoAnswer");
  assert.equal(line.by, "jev-latest", "the judge's allow, not the reviewer's");
  assert.equal(claude.requests.length, before, "no reviewer call for a safe rating");
});

test("an OpenAI reviewer allows too, end to end, selected by the setting", { skip }, async () => {
  await enable(OPENAI);
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: OPENAI_KEY, baseUrl: gpt.url });
  jev.replies.push({ nouls: RISKY });
  gpt.replies.push({ text: '{"verdict":"allow","reason":"openai said ok"}' });
  const added = await run(sessionId, "please rm the build dir");
  const line = added.find((m: any) => m.role === "autoAnswer");
  assert.equal(line.by, "OpenAI");
  assert.match(line.detail, /openai said ok/);
  const review = gpt.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!;
  assert.equal(review.auth, `Bearer ${OPENAI_KEY}`);
  assert.ok(JSON.stringify(review.body).includes("rm -rf build"), "the call went to the OpenAI mock");
  // Back to the Anthropic mock for the remaining tests.
  await enable(ANTHROPIC);
  auto.saveReviewerKey(secrets, { key: "reviewerKey", value: ANTHROPIC_KEY, baseUrl: claude.url });
});

test("a dangerous call the reviewer escalates waits for the user with the rating and the reason", { skip }, async () => {
  await enable();
  jev.replies.push({ nouls: DANGEROUS });
  claude.replies.push({ text: '{"verdict":"escalate","reason":"force-push could break the remote"}' });
  const req = await reviewedCard(sessionId, "please push");
  assert.equal(req.judge.state, "waiting");
  assert.equal(req.judge.rating, "dangerous");
  assert.equal(req.reviewer.state, "waiting");
  assert.equal(req.reviewer.by, "Claude");
  assert.match(req.reviewer.note, /force-push could break the remote/);
  assert.equal(mgr.summary(sessionId).status, "waiting");
  await deny(sessionId, req);
});

test("a deny verdict waits for the user for now, with the model's reason", { skip }, async () => {
  await enable();
  jev.replies.push({ nouls: DANGEROUS });
  claude.replies.push({ text: '{"verdict":"deny","reason":"unrelated to the task"}' });
  const req = await reviewedCard(sessionId, "please push");
  assert.equal(req.reviewer.state, "waiting");
  assert.match(req.reviewer.note, /unrelated to the task/);
  assert.equal(mgr.summary(sessionId).status, "waiting");
  await deny(sessionId, req);
});

for (const [name, reply, why] of [
  ["an HTTP 500", { status: 500, body: JSON.stringify({ error: { message: "overloaded" } }) }, /HTTP 500/],
  ["a timeout", { text: '{"verdict":"allow"}', delayMs: 3000 }, /no answer within/],
  ["garbage", { text: "seems fine to me, probably" }, /verdict/],
] as const) {
  test(`reviewer ${name}: the card waits for the user with a failure note`, { skip }, async () => {
    await enable();
    jev.replies.push({ nouls: RISKY });
    claude.replies.push(reply);
    const req = await reviewedCard(sessionId, "please rm the build dir");
    assert.equal(req.judge.state, "waiting");
    assert.equal(req.reviewer.state, "failed");
    assert.match(req.reviewer.note, why);
    assert.equal(mgr.summary(sessionId).status, "waiting");
    await deny(sessionId, req);
  });
}

test("while the reviewer thinks, the card shows reviewing and the session is not waiting on the user", { skip }, async () => {
  await enable();
  jev.replies.push({ nouls: RISKY });
  claude.replies.push({ text: '{"verdict":"escalate","reason":"slow"}', delayMs: 800 });
  await mgr.send(sessionId, "please rm the build dir");
  const reviewing = await waitFor(
    () => mgr.summary(sessionId).pending.find((x: any) => x.kind === "permission" && x.reviewer?.state === "reviewing"),
    45_000,
  );
  assert.equal(reviewing.judge.state, "waiting", "the judge has spoken");
  assert.notEqual(mgr.summary(sessionId).status, "waiting", "the review is still running");
  const waiting = await waitFor(
    () => mgr.summary(sessionId).pending.find((x: any) => x.kind === "permission" && x.reviewer?.state === "waiting"),
    45_000,
  );
  assert.match(waiting.reviewer.note, /slow/);
  await deny(sessionId, waiting);
});

test("an automatic allow is one call only: the next matching call is reviewed again", { skip }, async () => {
  await enable();
  jev.replies.push({ nouls: RISKY }, { nouls: RISKY });
  claude.replies.push(
    { text: '{"verdict":"allow","reason":"first"}' },
    { text: '{"verdict":"escalate","reason":"second, now escalate"}' },
  );
  const first = await run(sessionId, "please rm the build dir");
  assert.equal(first.find((m: any) => m.role === "autoAnswer")?.detail, "first");
  const req = await reviewedCard(sessionId, "please rm the build dir");
  assert.equal(req.reviewer.state, "waiting", "the second matching call went to the reviewer again");
  assert.match(req.reviewer.note, /second, now escalate/);
  await deny(sessionId, req);
});

test("the reviewer request in the session carries the session context: branch, phase, transcript, ssh hosts", { skip }, async () => {
  await enable();
  // A fresh, recent conversation the request must quote.
  await mgr.send(sessionId, "transcript marker 7749");
  await settle(sessionId);
  jev.replies.push({ nouls: RISKY });
  claude.replies.push({ text: '{"verdict":"allow","reason":"ok"}' });
  const from = claude.requests.length;
  await run(sessionId, "please rm the build dir");
  const req = claude.requests.slice(from).find((r) => r.path === "/v1/messages")!;
  const sent = JSON.stringify(req.body);
  const row = db.prepare("SELECT branch, phase FROM sessions WHERE id = ?").get(sessionId) as any;
  assert.ok(sent.includes(row.branch), "the branch");
  assert.ok(sent.includes(row.phase), "the phase");
  assert.ok(sent.includes("transcript marker 7749"), "the recent transcript (the user message)");
  assert.ok(sent.includes("Hello from the mock model"), "the recent transcript (the assistant's reply)");
  assert.ok(sent.includes("Media") && sent.includes("kevin@192.168.1.218"), "the ssh hosts");
  assert.ok(!sent.includes("server_key"), "no key names");
  assert.ok(!sent.includes(ANTHROPIC_KEY), "no key value");
});

test("the reviewer key never reaches pi: not its environment, not the agent's requests, not the settings API", { skip }, async () => {
  await enable();
  const pid = mgr.live.get(sessionId).proc.pid;
  const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
  assert.ok(environ.length > 0);
  assert.ok(!environ.includes(ANTHROPIC_KEY));
  assert.ok(!JSON.stringify(mock.requests).includes(ANTHROPIC_KEY));
  assert.ok(!JSON.stringify(secrets.envFor()).includes(ANTHROPIC_KEY));
  const view = auto.autoApproveView(db, secrets);
  assert.ok(!JSON.stringify(view).includes(ANTHROPIC_KEY));
});

test("the user's answer during review wins: pi gets exactly one answer and no late allow", { skip }, async () => {
  await enable();
  jev.replies.push({ nouls: RISKY });
  claude.replies.push({ text: '{"verdict":"allow","reason":"late"}', delayMs: 1000 });
  await mgr.send(sessionId, "please rm the build dir");
  const req = await waitFor(
    () => {
      const r = mgr.summary(sessionId).pending.find((x: any) => x.kind === "permission" && x.reviewer);
      return r?.reviewer.state === "reviewing" ? r : undefined;
    },
    45_000,
  );
  const proc = mgr.live.get(sessionId).proc;
  const writes: any[] = [];
  const write = proc.write.bind(proc);
  proc.write = (rec: any) => {
    if (rec.id === req.id) writes.push(rec);
    return write(rec);
  };
  const from = events.length;
  const answered = claude.answered();
  await deny(sessionId, req);
  // Wait for the late verdict to be delivered, then let the server handle it.
  await waitFor(() => claude.answered() > answered);
  await new Promise((r) => setTimeout(r, 300));
  proc.write = write;
  assert.deepEqual(writes.map((w) => w.value), ["Deny"]);
  assert.ok(!events.slice(from).some((e) => e.type === "wb_auto_answer"), "no automatic answer after the user's");
});

test("with auto-approve off, the reviewer is not asked", { skip }, async () => {
  auto.saveAutoApproveSettings(db, { enabled: false });
  const before = claude.requests.length;
  await mgr.send(sessionId, "please rm the build dir");
  const req = await waitFor(() => mgr.summary(sessionId).pending.find((x: any) => x.kind === "permission"));
  assert.equal(req.judge, undefined);
  assert.equal(req.reviewer, undefined);
  assert.equal(mgr.summary(sessionId).status, "waiting");
  await deny(sessionId, req);
  assert.equal(claude.requests.length, before);
  await enable();
});
