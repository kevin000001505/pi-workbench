/**
 * Auto-approve, reviewer half (issue #19): a permission the risk judge did not rate safe goes to
 * the reviewer (Claude or OpenAI). The reviewer allows (the tool runs, "allowed by …" line),
 * denies (the agent's tool result is an error that names the reviewer and carries the reason,
 * "denied by …: …" transcript line), or escalates (the card waits for the user with the note).
 * A reviewer failure leaves the card for the user with a failure note. A malformed
 * `{"wb": "deny"}` answer value is a plain deny, never an allow. A real `pi --mode rpc` process
 * against the mock LLM, judge, and reviewer, driven through SessionManager, like e2e.test.ts.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { RISKY, startMockJudge } from "./mock-judge.ts";
import { startMockLlm } from "./mock-llm.ts";
import { startMockReviewer } from "./mock-reviewer.ts";

const piBin = process.env.PI_BIN ?? "pi";
const hasPi = spawnSync(piBin, ["--version"]).status === 0;
const skip = !hasPi && "pi CLI not found";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-rev-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "rev-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");
process.env.HOME = path.join(tmp, "agent-home");
process.env.AUTO_APPROVE_TIMEOUT_MS = "1500";
process.env.PI_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-extension", "workbench.ts");

const JUDGE_TOKEN = "jev-secret-token";
const CLAUDE_KEY = "claude-secret";
const OPENAI_KEY = "sk-reviewer";

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

/** Save the reviewer settings (and key) so the saved judge's next non-safe call goes to it. */
const useReviewer = (r: { provider: "anthropic" | "openai"; baseUrl: string; model: string; key: string }) => {
  auto.saveAutoApproveKey(secrets, { key: "reviewerKey", value: r.key });
  auto.saveAutoApproveSettings(db, { reviewer: { provider: r.provider, baseUrl: r.baseUrl, model: r.model } });
};

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
  });
}

async function cardFor(id: string, prompt: string, until: (req: any) => boolean) {
  await mgr.send(id, prompt);
  return waitFor(() => mgr.summary(id).pending.find((r: any) => r.kind === "permission" && until(r)), 60_000);
}

async function deny(id: string, req: any) {
  mgr.respond(id, req.id, { value: "Deny" });
  await settle(id);
}

before(async () => {
  if (!hasPi) return;
  mock = await startMockLlm();
  jev = await startMockJudge({ protocol: "systemone", model: "jev-latest", token: JUDGE_TOKEN });
  claude = await startMockReviewer({ provider: "anthropic", model: "claude-mock", key: CLAUDE_KEY });
  gpt = await startMockReviewer({ provider: "openai", model: "gpt-mock", key: OPENAI_KEY });
  const { config } = await import("../src/config.ts");
  const { openDb } = await import("../src/db.ts");
  const { SecretStore } = await import("../src/secrets.ts");
  const { saveModelSettings, writePiConfig } = await import("../src/settings.ts");
  const { SessionManager } = await import("../src/sessions.ts");
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

  secrets = new SecretStore(db, process.env.WORKBENCH_MASTER_KEY!);
  auto.saveAutoApproveKey(secrets, { key: "judgeToken", value: JUDGE_TOKEN, baseUrl: jev.url });
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
  // Auto-approve on: Jev judges, the mock Claude reviews.
  await auto.configureAutoApprove(db, secrets, {
    enabled: true,
    judge: { baseUrl: jev.url, model: "jev-latest", yesAbove: 0.7, noBelow: 0.3 },
    reviewer: { provider: "anthropic", baseUrl: claude.url, model: "claude-mock" },
  });
  auto.saveAutoApproveKey(secrets, { key: "reviewerKey", value: CLAUDE_KEY });
});

beforeEach(() => {
  if (!hasPi) return;
  jev.replies.length = 0;
  claude.replies.length = 0;
  gpt.replies.length = 0;
});

after(async () => {
  if (!hasPi) return;
  await mgr.shutdown();
  await mock.close();
  await jev.close();
  await claude.close();
  await gpt.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a call the judge rates risky runs when the reviewer allows it, with an allowed-by line", { skip }, async () => {
  const from = claude.requests.length;
  const added = await run(sessionId, "please rm the build dir");
  const result = added.find((m: any) => m.role === "toolResult");
  assert.ok(!result.isError, "the call ran");
  const line = added.find((m: any) => m.role === "autoAnswer");
  assert.equal(line.answer, "allow");
  assert.equal(line.by, "Claude");
  assert.equal(line.subject, "rm -rf build");
  assert.equal(line.detail, "Routine cleanup for the task.");
  // The reviewer got the call, the task, and the judge's rating; no key name left the server.
  const req = claude.requests.slice(from).find((r) => r.path === "/v1/messages")!;
  assert.match(JSON.stringify(req.body), /rm -rf build/);
  assert.match(JSON.stringify(req.body), /please rm the build dir/);
  assert.match(JSON.stringify(req.body), /risky/);
  assert.ok(claude.requests.every((r) => !JSON.stringify(r.body).includes(CLAUDE_KEY)), "the key never appears in the request bodies");
});

test("a reviewer deny blocks with the reviewer's wording, and the transcript shows the line", { skip }, async () => {
  const added = await run(sessionId, "please nuke /mnt/data");
  const result = added.find((m: any) => m.role === "toolResult");
  assert.ok(result.isError, "the call was blocked");
  const text = JSON.stringify(result.content);
  assert.match(text, /The auto-approve reviewer \(Claude\) denied this bash call/);
  assert.match(text, /Deletes data outside the worktree; that is not part of the task\./);
  assert.match(text, /ask the user with ask_user/);
  assert.ok(!text.includes("The user denied"), "the agent is not told the user denied it");
  const line = added.find((m: any) => m.role === "autoAnswer");
  assert.equal(line.answer, "deny");
  assert.equal(line.by, "Claude");
  assert.equal(line.subject, "rm -rf /mnt/data");
  assert.equal(line.detail, "Deletes data outside the worktree; that is not part of the task.");
});

test("the OpenAI provider names itself OpenAI in the block and the line", { skip }, async () => {
  useReviewer({ provider: "openai", baseUrl: gpt.url, model: "gpt-mock", key: OPENAI_KEY });
  const added = await run(sessionId, "please nuke /mnt/data");
  const result = added.find((m: any) => m.role === "toolResult");
  assert.ok(result.isError);
  const text = JSON.stringify(result.content);
  assert.match(text, /The auto-approve reviewer \(OpenAI\) denied this bash call/);
  assert.ok(!text.includes("The user denied"));
  const line = added.find((m: any) => m.role === "autoAnswer");
  assert.equal(line.by, "OpenAI");
  assert.equal(line.answer, "deny");
  const req = gpt.requests.findLast((r) => r.path === "/chat/completions")!;
  assert.match(JSON.stringify(req.body), /rm -rf \/mnt\/data/);
  assert.ok(gpt.requests.every((r) => !JSON.stringify(r.body).includes(OPENAI_KEY)), "the key never appears in the request bodies");
  useReviewer({ provider: "anthropic", baseUrl: claude.url, model: "claude-mock", key: CLAUDE_KEY });
});

test("a reviewer escalate turns the card into a waiting card with the rating and the note", { skip }, async () => {
  useReviewer({ provider: "anthropic", baseUrl: claude.url, model: "claude-mock", key: CLAUDE_KEY });
  jev.replies.push({ nouls: RISKY });
  claude.replies.push({ decision: "escalate", reason: "Could damage data beyond the task." });
  const req = await cardFor(sessionId, "please push", (r) => r.review?.state === "escalated");
  assert.equal(req.judge.state, "waiting");
  assert.equal(req.judge.rating, "risky");
  assert.equal(req.review.state, "escalated");
  assert.equal(req.review.by, "Claude");
  assert.match(req.review.note, /damage/);
  assert.equal(mgr.summary(sessionId).status, "waiting");
  await deny(sessionId, req);
});

for (const [name, reply, why] of [
  ["an HTTP error", { status: 500, body: JSON.stringify({ error: { message: "overloaded" } }) }, /HTTP 500: overloaded/],
  ["a garbage body", { body: "<html>nope</html>" }, /unreadable/],
  ["a timeout", { decision: "allow", reason: "late", delayMs: 3000 }, /no answer within/],
] as const) {
  test(`when the reviewer fails with ${name}, the card waits for the user with a failure note`, { skip }, async () => {
    useReviewer({ provider: "anthropic", baseUrl: claude.url, model: "claude-mock", key: CLAUDE_KEY });
    jev.replies.push({ nouls: RISKY });
    claude.replies.push(reply);
    const req = await cardFor(sessionId, "please push", (r) => r.review?.state === "failed");
    assert.equal(req.judge.state, "waiting", "the judge's rating stays on the card");
    assert.equal(req.review.state, "failed");
    assert.match(req.review.note, why);
    assert.equal(mgr.summary(sessionId).status, "waiting");
    await deny(sessionId, req);
  });
}

test("the user's Deny during a review wins: one answer, no late deny reaches pi", { skip }, async () => {
  useReviewer({ provider: "anthropic", baseUrl: claude.url, model: "claude-mock", key: CLAUDE_KEY });
  jev.replies.push({ nouls: RISKY, delayMs: 800 });
  claude.replies.push({ decision: "deny", reason: "late", delayMs: 1200 });
  const req = await cardFor(sessionId, "please push", (r) => r.review?.state === "reviewing");
  const proc = mgr.live.get(sessionId).proc;
  const writes: any[] = [];
  const write = proc.write.bind(proc);
  proc.write = (rec: any) => {
    if (rec.id === req.id) writes.push(rec);
    return write(rec);
  };
  const from = events.length;
  const answeredBefore = claude.answered();
  await deny(sessionId, req);
  await waitFor(() => claude.answered() > answeredBefore);
  await new Promise((r) => setTimeout(r, 200));
  proc.write = write;
  assert.deepEqual(writes.map((w) => w.value), ["Deny"]);
  assert.ok(!events.slice(from).some((e) => e.type === "wb_auto_answer"), "no automatic answer after the user's");
});

/** With auto-approve off the card waits for the user; answer it with `value` and return the tool result. */
async function denyWith(id: string, value: string) {
  await mgr.send(id, "please push");
  const req = await waitFor(() => mgr.summary(id).pending.find((r: any) => r.kind === "permission"));
  const from = (await mgr.snapshot(id)).transcript.messages.length;
  mgr.respond(id, req.id, { value });
  const t = await waitFor(async () => {
    const s = (await mgr.snapshot(id)).transcript;
    return s.messages.length > from && !s.busy ? s : undefined;
  });
  const r = t.messages.slice(from).find((m: any) => m.role === "toolResult" && m.toolName === "bash");
  assert.ok(r, "the blocked call's tool result came back");
  return r;
}

test("the user's answers stay exactly as before: Deny and a typed note block, with the old wording", { skip }, async () => {
  auto.saveAutoApproveSettings(db, { enabled: false });
  // A malformed deny envelope is a plain deny, never an allow, and not a typed note.
  const plain = await denyWith(sessionId, '{"wb": "deny"}');
  const plainText = JSON.stringify(plain.content);
  assert.ok(plain.isError);
  assert.match(plainText, /The user denied/);
  assert.ok(!plainText.includes("auto-approve reviewer"));
  assert.ok(!plainText.includes("The user said"));
  // A deny envelope with a by but no reason is also a plain deny.
  const plain2 = await denyWith(sessionId, '{"wb": "deny", "by": "Claude"}');
  assert.match(JSON.stringify(plain2.content), /The user denied/);
  assert.ok(!JSON.stringify(plain2.content).includes("auto-approve reviewer"));
  // A well-formed deny envelope (the value the server answers with) blocks with the reviewer's wording.
  const reviewed = await denyWith(sessionId, '{"wb": "deny", "by": "Claude", "reason": "mock reason"}');
  const reviewedText = JSON.stringify(reviewed.content);
  assert.match(reviewedText, /The auto-approve reviewer \(Claude\) denied this bash call/);
  assert.match(reviewedText, /mock reason/);
  assert.ok(!reviewedText.includes("The user denied"));
  // And a plain Deny click is exactly as before.
  const denied = await denyWith(sessionId, "Deny");
  assert.match(JSON.stringify(denied.content), /The user denied/);
  assert.ok(!JSON.stringify(denied.content).includes("auto-approve reviewer"));
});

test("the reviewer key never reaches pi: not its environment, not the mock LLM's requests", { skip }, async () => {
  const pid = mgr.live.get(sessionId).proc.pid;
  const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
  assert.ok(environ.length > 0);
  assert.ok(!environ.includes(CLAUDE_KEY));
  assert.ok(!environ.includes(OPENAI_KEY));
  assert.ok(!JSON.stringify(mock.requests).includes(CLAUDE_KEY));
});
