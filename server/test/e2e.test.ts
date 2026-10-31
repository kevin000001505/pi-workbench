/**
 * End-to-end: a real `pi --mode rpc` process against the scripted mock LLM, driven through
 * SessionManager. Needs the pi CLI: PI_BIN, or `pi` on PATH. Skips when neither is available.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startMockLlm } from "./mock-llm.ts";

const piBin = process.env.PI_BIN ?? "pi";
const hasPi = spawnSync(piBin, ["--version"]).status === 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "e2e-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");

let mock: Awaited<ReturnType<typeof startMockLlm>>;
let mgr: any;
let db: any;

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

before(async () => {
  if (!hasPi) return;
  mock = await startMockLlm();
  const { config } = await import("../src/config.ts");
  const { openDb } = await import("../src/db.ts");
  const { SecretStore } = await import("../src/secrets.ts");
  const { saveModelSettings, writePiConfig } = await import("../src/settings.ts");
  const { SessionManager } = await import("../src/sessions.ts");
  config.piBin = piBin;
  db = openDb(config.dbFile);
  saveModelSettings(db, { baseUrl: mock.url });
  writePiConfig(db);

  // A local "GitHub": a bare repo the clone fetches from.
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

  const secrets = new SecretStore(db, process.env.WORKBENCH_MASTER_KEY!);
  mgr = new SessionManager(db, secrets, async () => ({
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  }));
});

after(async () => {
  if (!hasPi) return;
  await mgr.shutdown();
  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("first session runs setup, holds the task, then releases it", { skip: !hasPi && "pi CLI not found" }, async () => {
  const events: any[] = [];
  mgr.on("event", (_id: string, ev: any) => events.push(ev));
  const s = await mgr.create({ repoId: "me/demo", title: "Say hello", prompt: "hello there", mode: "direct" });
  assert.equal(s.heldPrompt, "hello there");
  assert.equal(s.setupRunning, true);

  // Setup writes the marker and commits; then the held prompt goes out and the mock says hello.
  await waitFor(() => events.some((e) => e.type === "message_end" && JSON.stringify(e.message).includes("Hello from the mock")));
  const row = db.prepare("SELECT held_prompt, worktree FROM sessions WHERE id = ?").get(s.id);
  assert.equal(row.held_prompt, null);
  assert.ok(fs.existsSync(path.join(row.worktree, "docs/agents/issue-tracker.md")));
  assert.match(sh(row.worktree, "log", "--format=%s", "-1"), /Set up agent skills/);
  await waitFor(() => mgr.summary(s.id).status === "idle");
});

test("risky command waits for permission; deny blocks it", { skip: !hasPi && "pi CLI not found" }, async () => {
  const id = mgr.list()[0].id;
  await mgr.send(id, "please push");
  const req = await waitFor(() => mgr.summary(id).pending[0]);
  assert.equal(req.kind, "permission");
  assert.equal(req.subject, "git push origin HEAD");
  assert.deepEqual(req.reasons, ["git push"]);
  assert.equal(mgr.summary(id).status, "waiting");

  mgr.respond(id, req.id, { value: "Deny" });
  const snap = await waitFor(async () => {
    const t = (await mgr.snapshot(id)).transcript;
    return t.messages.some((m: any) => m.role === "toolResult" && m.isError) && !t.busy ? t : undefined;
  });
  assert.ok(snap);
});

test("ask_user becomes a decision card and the answer reaches the model", { skip: !hasPi && "pi CLI not found" }, async () => {
  const id = mgr.list()[0].id;
  const before = mock.requests.length;
  await mgr.send(id, "ask me something");
  const req = await waitFor(() => mgr.summary(id).pending[0]);
  assert.equal(req.kind, "decision");
  assert.equal(req.title, "Which database should I use?");
  assert.deepEqual(req.options, ["SQLite (Recommended)", "Postgres"]);

  mgr.respond(id, req.id, { value: "Postgres, please" });
  await waitFor(() => mock.requests.slice(before).some((r) => JSON.stringify(r.messages).includes("The user answered: Postgres, please")));
});

test("a stopped session resumes its conversation from pi's session file", { skip: !hasPi && "pi CLI not found" }, async () => {
  const id = mgr.list()[0].id;
  await waitFor(() => mgr.summary(id).status === "idle");
  const count = (await mgr.snapshot(id)).transcript.messages.length;
  await mgr.stop(id);
  assert.equal(mgr.summary(id).status, "stopped");
  const { readSessionFile } = await import("../src/sessions.ts");
  assert.equal(readSessionFile(id).filter((m: any) => m.role !== "system").length, count);

  await mgr.send(id, "hello again");
  await waitFor(async () => (await mgr.snapshot(id)).transcript.messages.length >= count + 2);
});

test("an issue session persists its origin issue on the summary; plain sessions stay null", { skip: !hasPi && "pi CLI not found" }, async () => {
  const s = await mgr.create({
    repoId: "me/demo",
    title: "Solve issue 42",
    prompt: "Solve GitHub issue #42: demo",
    mode: "direct",
    issueRef: "me/demo#42",
  });
  assert.equal(s.issueRef, "me/demo#42");
  const p = await mgr.create({ repoId: "me/demo", title: "Plain", prompt: "Tidy the demo", mode: "direct" });
  assert.equal(p.issueRef, null);
});
