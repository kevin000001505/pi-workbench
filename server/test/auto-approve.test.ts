/**
 * Auto-approve (issue #17): permissions go to the risk judge (a scripted Jev) before the user.
 * A real `pi --mode rpc` process against the mock LLM, driven through SessionManager, like e2e.test.ts.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { startMockJudge } from "./mock-judge.ts";
import { startMockLlm } from "./mock-llm.ts";

const piBin = process.env.PI_BIN ?? "pi";
const hasPi = spawnSync(piBin, ["--version"]).status === 0;
const skip = !hasPi && "pi CLI not found";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-auto-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "auto-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");
process.env.HOME = path.join(tmp, "agent-home");
process.env.AUTO_APPROVE_TIMEOUT_MS = "1500";
process.env.PI_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-extension", "workbench.ts");

let mock: Awaited<ReturnType<typeof startMockLlm>>;
let judge: Awaited<ReturnType<typeof startMockJudge>>;
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

const enable = (patch: Record<string, unknown> = {}) =>
  auto.saveAutoApproveSettings(db, { enabled: true, judge: { kind: "jev", jevBaseUrl: judge.url, safeThreshold: 0.8 }, ...patch });

/** Send a prompt and wait until the run settles with nothing pending. */
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

before(async () => {
  if (!hasPi) return;
  mock = await startMockLlm();
  judge = await startMockJudge();
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
  auto.setAutoApproveKey(secrets, "jevToken", "jev-secret-token");
  mgr = new SessionManager(db, secrets, async () => ({
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  }));
  mgr.on("event", (_id: string, ev: any) => events.push(ev));
  const s = await mgr.create({ repoId: "me/demo", title: "Auto", prompt: "hello there", mode: "direct" });
  sessionId = s.id;
  await waitFor(() => events.some((e) => e.type === "message_end" && JSON.stringify(e.message).includes("Hello from the mock")), 60_000);
  await settle(sessionId);
});

after(async () => {
  if (!hasPi) return;
  await mgr.shutdown();
  await mock.close();
  await judge.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a permission Jev rates safe runs without the user, with an allowed-by-Jev transcript line", { skip }, async () => {
  enable();
  const before = judge.requests.length;
  const added = await run(sessionId, "please push");
  const result = added.find((m: any) => m.role === "toolResult");
  assert.ok(!result.isError || !JSON.stringify(result.content).includes("denied"), "the call was not blocked");
  const line = added.find((m: any) => m.role === "autoDecision");
  assert.equal(line.decision, "allow");
  assert.equal(line.by, "jev");
  assert.equal(line.subject, "git push origin HEAD");
  assert.equal(line.pSafe, 0.95);
  assert.equal(judge.requests.length, before + 1);
  assert.equal(judge.requests.at(-1)!.auth, "Bearer jev-secret-token");
  await settle(sessionId);
});

/** Send a prompt and resolve with the permission card it raises. */
async function cardFor(id: string, prompt: string, until: (req: any) => boolean = () => true) {
  await mgr.send(id, prompt);
  return waitFor(() => mgr.summary(id).pending.find((r: any) => r.kind === "permission" && until(r)));
}

/** Deny the card and wait for the run to finish. */
async function deny(id: string, req: any) {
  mgr.respond(id, req.id, { value: "Deny" });
  await settle(id);
}

test("while Jev reviews, the card shows reviewing and the session is not waiting on the user", { skip }, async () => {
  enable();
  judge.replies.push({ probabilities: [0.95, 0.04, 0.01], delayMs: 800 });
  const req = await cardFor(sessionId, "please push");
  assert.equal(req.review.state, "reviewing");
  assert.notEqual(mgr.summary(sessionId).status, "waiting");
  await settle(sessionId);
  assert.equal(mgr.summary(sessionId).pending.length, 0);
});

test("a call below the safe threshold waits for the user with Jev's rating", { skip }, async () => {
  enable();
  const req = await cardFor(sessionId, "please rm the build dir", (r) => r.review?.state !== "reviewing");
  assert.equal(req.review.state, "waiting");
  assert.equal(req.review.rating, "risky");
  assert.equal(req.review.pSafe, 0.1);
  assert.match(req.review.note, /risky/);
  assert.equal(mgr.summary(sessionId).status, "waiting");
  await deny(sessionId, req);
});

test("a dangerous rating names the dangerous level", { skip }, async () => {
  enable();
  judge.replies.push({ probabilities: [0.05, 0.15, 0.8] });
  const req = await cardFor(sessionId, "please rm the build dir", (r) => r.review?.state !== "reviewing");
  assert.equal(req.review.rating, "dangerous");
  await deny(sessionId, req);
});

test("the safe threshold is the user's setting", { skip }, async () => {
  enable({ judge: { kind: "jev", jevBaseUrl: judge.url, safeThreshold: 0.99 } });
  const req = await cardFor(sessionId, "please push", (r) => r.review?.state !== "reviewing");
  assert.equal(req.review.state, "waiting");
  assert.equal(req.review.pSafe, 0.95);
  await deny(sessionId, req);
  enable({ judge: { kind: "jev", jevBaseUrl: judge.url, safeThreshold: 0.95 } });
  const added = await run(sessionId, "please push");
  assert.ok(added.some((m: any) => m.role === "autoDecision"), "P(safe) equal to the threshold passes");
});

for (const [name, reply, why] of [
  ["an HTTP error", { status: 500 }, /HTTP 500/],
  ["a timeout", { probabilities: [0.95, 0.04, 0.01], delayMs: 3000 }, /no answer within/],
  ["an unreadable answer", { body: "<html>nope</html>" }, /no risk probabilities/],
  ["an out-of-range answer", { body: '{"answers":{"risk":{"probabilities":{"0":1e999,"1":0,"2":0}}}}' }, /no risk probabilities/],
  ["a probability above 1", { body: '{"answers":{"risk":{"probabilities":{"0":1.005,"1":0,"2":0}}}}' }, /no risk probabilities/],
  ["a negative probability", { body: '{"answers":{"risk":{"probabilities":{"0":-0.5,"1":1,"2":0.5}}}}' }, /no risk probabilities/],
  ["probabilities that do not sum to 1", { probabilities: [0.9, 0.9, 0.9] }, /no risk probabilities/],
] as const) {
  test(`when Jev fails with ${name}, the card waits for the user with a failure note`, { skip }, async () => {
    enable();
    judge.replies.push(reply);
    const req = await cardFor(sessionId, "please push", (r) => r.review?.state !== "reviewing");
    assert.equal(req.review.state, "failed");
    assert.match(req.review.note, why);
    assert.equal(mgr.summary(sessionId).status, "waiting");
    await deny(sessionId, req);
  });
}

test("when Jev is unreachable, the card waits for the user", { skip }, async () => {
  // A port that was just free: nothing listens there, so the connection is refused.
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
  const port = (closed.address() as AddressInfo).port;
  await new Promise((r) => closed.close(r));
  enable({ judge: { kind: "jev", jevBaseUrl: `http://127.0.0.1:${port}/v1`, safeThreshold: 0.8 } });
  const req = await cardFor(sessionId, "please push", (r) => r.review?.state !== "reviewing");
  assert.equal(req.review.state, "failed");
  assert.match(req.review.note, /^Jev failed: .*ECONNREFUSED/);
  await deny(sessionId, req);
});

test("the user's answer during a review wins and the late verdict is dropped", { skip }, async () => {
  enable();
  judge.replies.push({ probabilities: [0.95, 0.04, 0.01], delayMs: 1000 });
  const req = await cardFor(sessionId, "please push");
  assert.equal(req.review.state, "reviewing");
  const from = events.length;
  await deny(sessionId, req);
  await new Promise((r) => setTimeout(r, 1300));
  assert.ok(!events.slice(from).some((e) => e.type === "wb_auto_decision"), "no automatic answer after the user's");
  const t = (await mgr.snapshot(sessionId)).transcript;
  assert.ok(JSON.stringify(t.messages.findLast((m: any) => m.role === "toolResult").content).includes("denied"));
});

test("decisions are never sent to the risk judge", { skip }, async () => {
  enable();
  const before = judge.requests.length;
  await mgr.send(sessionId, "ask me something");
  const req = await waitFor(() => mgr.summary(sessionId).pending[0]);
  assert.equal(req.kind, "decision");
  assert.equal(req.review, undefined);
  mgr.respond(sessionId, req.id, { value: "Postgres" });
  await settle(sessionId);
  assert.equal(judge.requests.length, before);
});

test("with auto-approve off, permissions wait for the user and Jev is not asked", { skip }, async () => {
  auto.saveAutoApproveSettings(db, { enabled: false });
  const before = judge.requests.length;
  const req = await cardFor(sessionId, "please push");
  assert.equal(req.review, undefined);
  assert.equal(mgr.summary(sessionId).status, "waiting");
  await deny(sessionId, req);
  assert.equal(judge.requests.length, before);
});

test("Settings → Test reports whether Jev answers with the saved URL and token", { skip }, async () => {
  enable();
  const ok = await auto.testJudge(auto.getAutoApproveSettings(db), auto.autoApproveKeys(secrets));
  assert.equal(ok.ok, true);
  assert.match(ok.message, /P\(safe\)=0\.95/);
  judge.replies.push({ status: 401 });
  const bad = await auto.testJudge(auto.getAutoApproveSettings(db), auto.autoApproveKeys(secrets));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /HTTP 401/);
});
