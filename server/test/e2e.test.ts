/**
 * End-to-end: a real `pi --mode rpc` process against the scripted mock LLM, driven through
 * SessionManager. Needs the pi CLI: PI_BIN, or `pi` on PATH. Skips when neither is available.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { startMockLlm } from "./mock-llm.ts";

const piBin = process.env.PI_BIN ?? "pi";
const hasPi = spawnSync(piBin, ["--version"]).status === 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "e2e-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");
// The spawned pi inherits this HOME, so the agent's ~/.ssh (ADR 0001) lands in a temp dir.
process.env.HOME = path.join(tmp, "agent-home");
// A deployment may export PI_EXTENSION (the installed copy); the test must load this repo's
// extension, so the assertions cover the code under test.
process.env.PI_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-extension", "workbench.ts");

let mock: Awaited<ReturnType<typeof startMockLlm>>;
let mgr: any;
let db: any;
let secrets: any;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** The system prompt delivered to the LLM in a captured request (string or content blocks). */
const sysText = (req: any): string => {
  const m = (req.messages ?? []).find((x: any) => x.role === "system");
  const c = m?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b?.text ?? "").join("") : "";
};

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
  const { GLOBAL_SCOPE, SecretStore } = await import("../src/secrets.ts");
  const { saveModelSettings, writePiConfig } = await import("../src/settings.ts");
  const { SessionManager } = await import("../src/sessions.ts");
  const { applySsh } = await import("../src/ssh.ts");
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

  secrets = new SecretStore(db, process.env.WORKBENCH_MASTER_KEY!);
  // Every pi spawn re-materializes ~/.ssh and the hosts file (ADR 0001), so nothing goes stale.
  mgr = new SessionManager(db, secrets, async () => ({
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  }), () => applySsh(db, secrets, config.agentHome, config.piAgentDir));
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

test("the agent knows the ssh hosts: prompt section, fresh materialization, approval gate, cleanup", {
  skip: !hasPi && "pi CLI not found",
}, async () => {
  const { config } = await import("../src/config.ts");
  const { GLOBAL_SCOPE } = await import("../src/secrets.ts");
  const { applySsh, saveSshHosts } = await import("../src/ssh.ts");

  // Save a key and a host whose address fails fast (nothing listens on 127.0.0.1:2223).
  const key = `-----BEGIN OPENSSH PRIVATE KEY-----\ne2e-ssh-key-data==\n-----END OPENSSH PRIVATE KEY-----\n`;
  secrets.set(GLOBAL_SCOPE, "media", key);
  saveSshHosts(db, [{ alias: "Media", user: "ubuntu", hostname: "127.0.0.1", port: 2223, keyName: "media" }]);
  applySsh(db, secrets, config.agentHome, config.piAgentDir);
  assert.match(fs.readFileSync(path.join(config.agentHome, ".ssh", "config"), "utf8"), /Host Media/);

  // Materialization repeats before every spawn: nuke ~/.ssh, the spawn brings it back.
  fs.rmSync(path.join(config.agentHome, ".ssh"), { recursive: true, force: true });

  const before = mock.requests.length;
  const s = await mgr.create({ repoId: "me/demo", title: "Remote", prompt: "please ssh into Media", mode: "direct" });

  assert.ok(fs.existsSync(path.join(config.agentHome, ".ssh", "config")), "spawn re-materialized ~/.ssh/config");
  assert.ok(fs.existsSync(path.join(config.agentHome, ".ssh", "media")), "spawn re-materialized the key file");

  // The system prompt delivered to the LLM names the host (the extension injected it).
  const sysReq = await waitFor(() => mock.requests.slice(before).find((r) => sysText(r).includes("Known SSH hosts")));
  assert.ok(sysText(sysReq).includes("- Media → ubuntu@127.0.0.1 (key: media)"), "host line in the system prompt");

  // The first ssh hits the approval gate labeled "ssh".
  const req = await waitFor(() => mgr.summary(s.id).pending[0]);
  assert.equal(req.kind, "permission");
  assert.equal(req.subject, "ssh Media true");
  assert.deepEqual(req.reasons, ["ssh"]);
  mgr.respond(s.id, req.id, { value: "Allow" });
  await waitFor(async () => {
    const t = (await mgr.snapshot(s.id)).transcript;
    return t.messages.some((m: any) => m.role === "toolResult" && m.toolName === "bash") && !t.busy ? t : undefined;
  });
  await waitFor(() => mgr.summary(s.id).status === "idle");

  // Deleting the host (and its key) regenerates the config and removes the key file.
  saveSshHosts(db, []);
  secrets.delete(GLOBAL_SCOPE, "media");
  applySsh(db, secrets, config.agentHome, config.piAgentDir);
  const cfg = fs.readFileSync(path.join(config.agentHome, ".ssh", "config"), "utf8");
  assert.ok(!cfg.includes("Host Media"), "config regenerated without the host");
  assert.ok(!fs.existsSync(path.join(config.agentHome, ".ssh", "media")), "key file removed");

  // No hosts → no section on the next run.
  const before2 = mock.requests.length;
  await mgr.send(s.id, "list the files");
  await waitFor(() => mock.requests.length > before2);
  assert.ok(!sysText(mock.requests[before2]).includes("Known SSH hosts"), "section gone without hosts");
});
