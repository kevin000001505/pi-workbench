/**
 * No repo runs the agent-skills setup twice (issue #101): session creation reads the repo's recorded
 * setup state first. A repo recorded as set up starts in its planned phase and gets no marker check;
 * a repo recorded as not set up starts in setup; only a repo with no recorded state (added before the
 * record existed) still reads the marker off its fresh worktree. A real `pi --mode rpc` against the
 * scripted mock model, driven through SessionManager, like pipeline-e2e.test.ts. Skips when the pi
 * CLI is not available.
 *
 * Seams under test: SessionManager.create (the session-creation interface the routes use), the
 * session summary the UI reads (phase, setupRunning, heldPrompt), the prompt the session's run was
 * sent first (its transcript's first user message), and the record under repos.setup_state.
 * What they miss: the git calls themselves. These tests show that the setup decision comes from the
 * record and not from the worktree — the two disagree in both directions — and not how many times
 * git was asked about the marker.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-setup-once-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "setup-once-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");
process.env.HOME = path.join(tmp, "agent-home");
process.env.GITHUB_CLONE_BASE = path.join(tmp, "remotes");
process.env.PI_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-extension", "workbench.ts");

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const WHO = ["-c", "user.name=t", "-c", "user.email=t@t"];
const gitEnv = async () => ({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let mock: Awaited<ReturnType<typeof startMockLlm>>;
let mgr: any;
let db: any;
let secrets: any;
let SETUP_MARKER: string;
let SETUP_SKILL: string;
let cloneBase: string;

/** A bare repo on the mock remote, with the given files on its default branch. */
function seedRemote(name: string, files: Record<string, string> = {}) {
  const bare = path.join(cloneBase, "me", `${name}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  const seed = path.join(tmp, `seed-${name}`);
  fs.mkdirSync(seed, { recursive: true });
  sh(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "README.md"), `# ${name}\n`);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(seed, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(seed, rel), body);
  }
  sh(seed, "add", ".");
  sh(seed, ...WHO, "commit", "-qm", "init");
  sh(tmp, "clone", "-q", "--bare", seed, bare);
  fs.rmSync(seed, { recursive: true, force: true });
}

/** Put a file on (or off) the mock remote's default branch, as another developer's push does. */
function changeRemoteFile(name: string, rel: string, content: string | null) {
  const work = path.join(tmp, `edit-${name}`);
  sh(tmp, "clone", "-q", path.join(cloneBase, "me", `${name}.git`), work);
  if (content === null) fs.rmSync(path.join(work, rel));
  else {
    fs.mkdirSync(path.join(work, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), content);
  }
  sh(work, "add", "-A");
  sh(work, ...WHO, "commit", "-qm", content === null ? `Remove ${rel}` : `Add ${rel}`);
  sh(work, "push", "-q", "origin", "main");
  fs.rmSync(work, { recursive: true, force: true });
}

/** Add the repo through the workbench's own add path, which records its setup state once. */
const track = async (name: string) => {
  const { addRepo } = await import("../src/repos.ts");
  return addRepo(db, { owner: "me", name, defaultBranch: "main", private: true }, await gitEnv());
};
const recorded = async (repoId: string) => {
  const { recordedSetupState } = await import("../src/repos.ts");
  return recordedSetupState(db, repoId);
};
/** The first prompt this session's run was sent, from its own transcript (system messages are not
 * part of it, so the skill list pi is given never shows up here). */
async function firstPrompt(id: string) {
  const start = Date.now();
  for (;;) {
    const t = (await mgr.snapshot(id)).transcript;
    const first = t.messages.find((m: any) => m.role === "user");
    if (first) return JSON.stringify(first.content);
    if (Date.now() - start > 60_000) throw new Error(`no prompt reached session ${id}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const MARKER_DOC = "# Issue tracker\n\nGitHub Issues.\n";

before(async () => {
  if (!hasPi) return;
  mock = await startMockLlm();
  const { config, SETUP_MARKER: marker, SETUP_SKILL: skill } = await import("../src/config.ts");
  const { openDb } = await import("../src/db.ts");
  const { SecretStore } = await import("../src/secrets.ts");
  const { saveModelSettings, writePiConfig } = await import("../src/settings.ts");
  const { SessionManager } = await import("../src/sessions.ts");
  SETUP_MARKER = marker;
  SETUP_SKILL = skill;
  cloneBase = config.githubCloneBase;
  config.piBin = piBin;
  db = openDb(config.dbFile);
  saveModelSettings(db, { baseUrl: mock.url });
  writePiConfig(db);

  // The setup skill the pipeline invokes; pi expands /skill:name from these.
  for (const name of [SETUP_SKILL, "grill-with-docs", "to-spec", "to-tickets", "tdd", "code-review"]) {
    fs.mkdirSync(path.join(config.skillsDir, name), { recursive: true });
    fs.writeFileSync(path.join(config.skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} test skill\n---\n${name} body\n`);
  }

  secrets = new SecretStore(db, process.env.WORKBENCH_MASTER_KEY!);
  mgr = new SessionManager(db, secrets, gitEnv);
});

after(async () => {
  if (!hasPi) return;
  await mgr.shutdown();
  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a direct session on a repo recorded as set up starts in its planned phase, even when its worktree has no setup marker", { skip }, async () => {
  seedRemote("set-up", { [SETUP_MARKER]: MARKER_DOC });
  const repo = await track("set-up");
  assert.equal(await recorded(repo.id), "set_up", "add time recorded it once");

  // The marker goes off the default branch: the next worktree is built without it. The record does not follow.
  changeRemoteFile("set-up", SETUP_MARKER, null);

  const s = await mgr.create({ repoId: repo.id, title: "Quick", prompt: "hello there", mode: "direct" });
  assert.equal(s.phase, "direct", "no setup phase: the repo is recorded as set up");
  assert.equal(s.setupRunning, false, "no setup run started");
  assert.equal(s.heldPrompt, null, "the task is not held behind setup");
  const prompts = await firstPrompt(s.id);
  assert.ok(prompts.includes("hello there"), "the task went out as the session's first prompt");
  assert.ok(!prompts.includes(SETUP_SKILL), "the setup prompt was never sent to this session");
  await mgr.abort(s.id);
});

test("a pipeline session on a repo recorded as set up goes straight to its grill, even when its worktree has no setup marker", { skip }, async () => {
  seedRemote("set-up-pipeline", { [SETUP_MARKER]: MARKER_DOC });
  const repo = await track("set-up-pipeline");
  assert.equal(await recorded(repo.id), "set_up");
  changeRemoteFile("set-up-pipeline", SETUP_MARKER, null);

  const s = await mgr.create({ repoId: repo.id, title: "Greeting", prompt: "add a greeting" });
  assert.equal(s.phase, "grill", "the pipeline starts at its planned phase, not in setup");
  assert.equal(s.setupRunning, false);
  assert.equal(s.heldPrompt, null, "the task went out as the grill prompt at once");
  const prompts = await firstPrompt(s.id);
  assert.ok(prompts.includes("grill-with-docs"), "the grill went out as the session's first prompt");
  assert.ok(!prompts.includes(SETUP_SKILL), "the setup prompt was never sent to this session");
  await mgr.abort(s.id);
});

test("a session on a repo recorded as not set up starts in setup, even when its worktree carries the setup marker", { skip }, async () => {
  seedRemote("not-set-up");
  const repo = await track("not-set-up");
  assert.equal(await recorded(repo.id), "not_set_up", "add time recorded it once");

  // Someone else put the setup files on the default branch afterwards: the worktree now carries them.
  // The record is what decides, so setup runs once more and its push makes the record set up.
  changeRemoteFile("not-set-up", SETUP_MARKER, MARKER_DOC);

  const s = await mgr.create({ repoId: repo.id, title: "Quick", prompt: "hello there", mode: "direct" });
  assert.equal(s.phase, "setup", "the record decides, not the worktree");
  assert.equal(s.setupRunning, true);
  assert.match(s.heldPrompt ?? "", /hello there/, "the task waits behind setup");
  const prompts = await firstPrompt(s.id);
  assert.ok(prompts.includes(SETUP_SKILL), "the setup prompt went out first");
  assert.ok(!prompts.includes("hello there"), "the task waits until setup is done");
  await mgr.abort(s.id);
});

test("a repo with no recorded setup state keeps today's marker check on its fresh worktree", { skip }, async () => {
  seedRemote("unrecorded");
  const repo = await track("unrecorded");
  // Its row as it was before the record existed: nothing recorded.
  db.prepare("UPDATE repos SET setup_state = NULL WHERE id = ?").run(repo.id);

  const s = await mgr.create({ repoId: repo.id, title: "Quick", prompt: "hello there", mode: "direct" });
  assert.equal(s.phase, "setup", "the worktree has no marker, so setup runs first");
  assert.equal(s.setupRunning, true);
  assert.equal(await recorded(repo.id), null, "the worktree check records nothing: only the add-time check and a landed setup push write the record");
  const prompts = await firstPrompt(s.id);
  assert.ok(prompts.includes(SETUP_SKILL), "the setup prompt went out first");
  await mgr.abort(s.id);
});

test("a repo with no recorded setup state skips setup when its worktree carries the marker", { skip }, async () => {
  seedRemote("unrecorded-ready", { [SETUP_MARKER]: MARKER_DOC });
  const repo = await track("unrecorded-ready");
  db.prepare("UPDATE repos SET setup_state = NULL WHERE id = ?").run(repo.id);

  const s = await mgr.create({ repoId: repo.id, title: "Quick", prompt: "hello there", mode: "direct" });
  assert.equal(s.phase, "direct", "the worktree marker check still answers for a repo with no record");
  assert.equal(s.setupRunning, false);
  const prompts = await firstPrompt(s.id);
  assert.ok(!prompts.includes(SETUP_SKILL), "no setup prompt was sent");
  await mgr.abort(s.id);
});
