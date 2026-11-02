/**
 * The TypeSafe skill (issue #25): bundled outside the skills dir every session scans, and loaded
 * only for sessions created with the box ticked. A real `pi --mode rpc` process against the mock
 * LLM, driven through SessionManager; the skill list is the one pi reports (`get_commands`).
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
const skip = !hasPi && "pi CLI not found";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-typesafe-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "typesafe-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");
process.env.OPTIONAL_SKILLS_DIR = path.join(tmp, "optional-skills");
process.env.HOME = path.join(tmp, "agent-home");
process.env.PI_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-extension", "workbench.ts");

let mock: Awaited<ReturnType<typeof startMockLlm>>;
let mgr: any;
let db: any;
let secrets: any;
let SessionManager: any;
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const gitEnv = async () => ({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The skills pi reports for the session's running process. */
async function skillsOf(id: string): Promise<string[]> {
  await mgr.start(id);
  const data = await mgr.live.get(id).proc.call({ type: "get_commands" });
  return data.commands.filter((c: any) => c.source === "skill").map((c: any) => c.name);
}

/** Send a prompt and resolve with the tool result of the call it makes, once the run settled. */
async function toolResult(id: string, prompt: string, tool: string) {
  const from = (await mgr.snapshot(id)).transcript.messages.length;
  await mgr.send(id, prompt);
  return waitFor(async () => {
    const t = (await mgr.snapshot(id)).transcript;
    return !t.busy && t.messages.slice(from).find((m: any) => m.role === "toolResult" && m.toolName === tool);
  });
}

before(async () => {
  if (!hasPi) return;
  mock = await startMockLlm();
  const { config } = await import("../src/config.ts");
  const { openDb } = await import("../src/db.ts");
  const { SecretStore } = await import("../src/secrets.ts");
  const { saveModelSettings, writePiConfig } = await import("../src/settings.ts");
  ({ SessionManager } = await import("../src/sessions.ts"));
  config.piBin = piBin;
  db = openDb(config.dbFile);
  saveModelSettings(db, { baseUrl: mock.url });
  writePiConfig(db);
  // Every session's skill (scanned by pi), and the TypeSafe skill, bundled apart.
  fs.mkdirSync(path.join(config.skillsDir, "tdd"), { recursive: true });
  fs.writeFileSync(path.join(config.skillsDir, "tdd", "SKILL.md"), "---\nname: tdd\ndescription: tdd test skill\n---\ntdd body\n");
  fs.mkdirSync(path.join(config.optionalSkillsDir, "typesafe-ai"), { recursive: true });
  fs.writeFileSync(
    path.join(config.optionalSkillsDir, "typesafe-ai", "SKILL.md"),
    "---\nname: typesafe-ai\ndescription: TypeSafe integration craft for code that calls System One models.\n---\nBuild with TypeSafe: typesafe body\n",
  );

  // A repo already set up, so sessions start straight away.
  const seed = path.join(tmp, "seed");
  fs.mkdirSync(path.join(seed, "docs", "agents"), { recursive: true });
  sh(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "docs", "agents", "issue-tracker.md"), "GitHub issues\n");
  sh(seed, "add", ".");
  sh(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  sh(tmp, "clone", "-q", "--bare", seed, path.join(tmp, "remote.git"));
  const clone = path.join(config.reposDir, "me", "demo");
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  sh(tmp, "clone", "-q", path.join(tmp, "remote.git"), clone);
  db.prepare("INSERT INTO repos (id, owner, name, default_branch, private, added_at) VALUES ('me/demo','me','demo','main',1,0)").run();

  secrets = new SecretStore(db, process.env.WORKBENCH_MASTER_KEY!);
  mgr = new SessionManager(db, secrets, gitEnv);
});

after(async () => {
  if (!hasPi) return;
  await mgr.shutdown();
  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a session created with the TypeSafe box lists typesafe-ai, and pi and the Skill tool can load it", { skip }, async () => {
  const s = await mgr.create({ repoId: "me/demo", title: "With TypeSafe", prompt: "", mode: "direct", typesafeSkill: true });
  assert.equal(s.typesafeSkill, true);
  const skills = await skillsOf(s.id);
  assert.ok(skills.includes("skill:typesafe-ai"), `pi lists it: ${skills.join(", ")}`);
  assert.ok(skills.includes("skill:tdd"), "next to every session's skills");

  // pi expands /skill:typesafe-ai into the skill's body.
  const from = mock.requests.length;
  await mgr.send(s.id, "/skill:typesafe-ai hello there");
  const req = await waitFor(() => mock.requests.slice(from).find((r) => JSON.stringify(r.messages ?? []).includes('<skill name=\\"typesafe-ai\\"')));
  assert.match(JSON.stringify(req.messages), /typesafe body/);
  await waitFor(async () => !(await mgr.snapshot(s.id)).transcript.busy && mgr.summary(s.id).status === "idle");

  // The extension's Skill tool (for skills written for Claude Code) finds it too.
  const r = await toolResult(s.id, "load typesafe please", "Skill");
  assert.equal(r.isError, false);
  assert.match(JSON.stringify(r.content), /typesafe body/);

  // The choice is stored on the session and survives a server restart.
  await mgr.shutdown();
  mgr = new SessionManager(db, secrets, gitEnv);
  assert.equal(mgr.summary(s.id).typesafeSkill, true);
  assert.ok((await skillsOf(s.id)).includes("skill:typesafe-ai"), "after a restart");
});

test("a session created without the box does not list it, and cannot load it", { skip }, async () => {
  const s = await mgr.create({ repoId: "me/demo", title: "Without", prompt: "", mode: "direct" });
  assert.equal(s.typesafeSkill, false);
  const skills = await skillsOf(s.id);
  assert.ok(skills.includes("skill:tdd"));
  assert.ok(!skills.includes("skill:typesafe-ai"), `pi does not list it: ${skills.join(", ")}`);
  const r = await toolResult(s.id, "load typesafe please", "Skill");
  assert.equal(r.isError, true);
});

test("the skill list for the composer follows the session's choice", { skip }, async () => {
  const { listSkills } = await import("../src/skills.ts");
  const { config } = await import("../src/config.ts");
  const withIt = await mgr.create({ repoId: "me/demo", title: "Picker with", prompt: "", mode: "direct", typesafeSkill: true });
  const without = await mgr.create({ repoId: "me/demo", title: "Picker without", prompt: "", mode: "direct" });
  const names = (id: string) => listSkills(config.skillsDir, undefined, mgr.extraSkillDirs(id)).map((x) => x.name);
  assert.ok(names(withIt.id).includes("typesafe-ai"));
  assert.ok(!names(without.id).includes("typesafe-ai"));
});

test("a TypeSafe session whose skill went missing starts with a warning, not silently without it", { skip }, async () => {
  const { config } = await import("../src/config.ts");
  const s = await mgr.create({ repoId: "me/demo", title: "Goes missing", prompt: "", mode: "direct", typesafeSkill: true });
  await mgr.stop(s.id);
  const dir = path.join(config.optionalSkillsDir, "typesafe-ai");
  fs.renameSync(dir, `${dir}.off`);
  try {
    await mgr.start(s.id);
    assert.match(mgr.summary(s.id).attention ?? "", /TypeSafe skill is not installed/);
  } finally {
    fs.renameSync(`${dir}.off`, dir);
  }
});

test("the TypeSafe box is refused when the skill is not installed", { skip }, async () => {
  const { config } = await import("../src/config.ts");
  const dir = path.join(config.optionalSkillsDir, "typesafe-ai");
  fs.renameSync(dir, `${dir}.off`);
  try {
    await assert.rejects(mgr.create({ repoId: "me/demo", title: "Missing", prompt: "", mode: "direct", typesafeSkill: true }), /TypeSafe skill is not installed/);
  } finally {
    fs.renameSync(`${dir}.off`, dir);
  }
});
