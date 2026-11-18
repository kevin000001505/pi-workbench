/**
 * Test: an installed skill reaches the agent of a run of a pipeline place it is **attached** to, and
 * no run of a place it is not (issue #117).
 *
 * A real `pi --mode rpc` agent, driven through SessionManager as the pipeline drives it, and read
 * through the skills its own process reports (`get_commands`), the way the session view reads them.
 * The skill library holds the installed skills; only their attach points put one in front of an agent.
 *
 * Attach map of this test's library:
 *   probe-plan    → grill, tickets
 *   probe-impl    → implement
 *   probe-review  → review
 *   probe-direct  → direct
 *   probe-all     → every pipeline place, so setup is the place that must show nothing
 *   probe-off     → every pipeline place, but switched off, so it reaches no run at all
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

const piBin = process.env.PI_BIN ?? "pi";
const hasPi = spawnSync(piBin, ["--version"]).status === 0;
const skip = !hasPi && "pi CLI not found";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-skill-attach-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "attach-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");
process.env.OPTIONAL_SKILLS_DIR = path.join(tmp, "optional-skills");
process.env.HOME = path.join(tmp, "agent-home");
process.env.PI_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-extension", "workbench.ts");

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const gitEnv = async () => ({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let mock: Awaited<ReturnType<typeof startMockLlm>>;
let ghMock: Awaited<ReturnType<typeof startMockGitHub>>;
let mgr: any;
let db: any;
let config: any;
let secrets: any;
let library: { sourceId: string; skills: Record<string, string> };

/** The library's skills, from a git source the test clones the way the Skills page does. */
const SKILL_NAMES = ["probe-plan", "probe-impl", "probe-review", "probe-direct", "probe-all", "probe-off"];
const sourceDir = path.join(tmp, "skill-source");
for (const name of SKILL_NAMES) {
  fs.mkdirSync(path.join(sourceDir, name), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill from the library.\n---\n${name} body\n`);
}
sh(sourceDir, "init", "-q", "-b", "main");
sh(sourceDir, "add", ".");
sh(sourceDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "the library's skills");

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Answer the decision card the session waits on with its first option. */
async function answerNext(id: string, expect: RegExp, value?: string) {
  const req = await waitFor(() => mgr.summary(id).pending[0]);
  assert.match(req.title, expect);
  await mgr.respond(id, req.id, { value: value ?? req.options[0] });
}

/** The skills the session's live pi process reports for its own run. */
async function agentSkills(id: string): Promise<string[]> {
  await mgr.start(id);
  const data = await mgr.live.get(id).proc.call({ type: "get_commands" });
  return data.commands.filter((c: any) => c.source === "skill").map((c: any) => c.name.replace(/^skill:/, ""));
}

/** The same read on the next run of the place: the process is stopped and started again. */
async function agentSkillsOnNextRun(id: string): Promise<string[]> {
  await mgr.stop(id);
  return await agentSkills(id);
}

/** Only this test's library: the image and repo skills are not what the test asks about. */
function libraryOnly(names: string[]): string[] {
  return names.filter((n) => SKILL_NAMES.includes(n)).sort();
}

before(async () => {
  if (!hasPi) return;
  mock = await startMockLlm();
  ghMock = await startMockGitHub(path.join(tmp, "gh"));
  const { config: c } = await import("../src/config.ts");
  config = c;
  config.githubApi = ghMock.url;
  config.piBin = piBin;
  const { openDb } = await import("../src/db.ts");
  const { SecretStore } = await import("../src/secrets.ts");
  const { saveModelSettings, writePiConfig } = await import("../src/settings.ts");
  const { SessionManager } = await import("../src/sessions.ts");
  const { GitHub } = await import("../src/github.ts");
  const { githubDelivery } = await import("../src/delivery.ts");
  const { getModelSettings } = await import("../src/settings.ts");
  const { addSkillSource, setSkillSettings } = await import("../src/skill-library.ts");
  db = openDb(config.dbFile);
  saveModelSettings(db, { baseUrl: mock.url });
  writePiConfig(db);

  // Skills the pipeline invokes; pi expands /skill:name from these.
  for (const name of ["grill-with-docs", "to-spec", "to-tickets", "tdd", "code-review", "setup-matt-pocock-skills", "diagnosing-bugs", "retro", "resolve-merge-conflicts"]) {
    fs.mkdirSync(path.join(config.skillsDir, name), { recursive: true });
    fs.writeFileSync(path.join(config.skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} test skill\n---\n${name} body\n`);
  }

  // A repo already set up (its default branch carries the agent-skills marker), so its cards start in
  // their planned phase. A second repo carries no marker, for the setup run.
  for (const [name, marker] of [["demo", true], ["plain", false]] as const) {
    const seed = path.join(tmp, `seed-${name}`);
    fs.mkdirSync(seed, { recursive: true });
    if (marker) {
      fs.mkdirSync(path.join(seed, "docs/agents"), { recursive: true });
      fs.writeFileSync(path.join(seed, "docs/agents/issue-tracker.md"), "GitHub issues\n");
    }
    fs.writeFileSync(path.join(seed, "README.md"), `# ${name}\n`);
    sh(seed, "init", "-q", "-b", "main");
    sh(seed, "add", ".");
    sh(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    sh(tmp, "clone", "-q", "--bare", seed, path.join(tmp, `${name}.git`));
    const clone = path.join(config.reposDir, "me", name);
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    sh(tmp, "clone", "-q", path.join(tmp, `${name}.git`), clone);
    db.prepare("INSERT INTO repos (id, owner, name, default_branch, private, added_at, setup_state) VALUES (?, 'me', ?, 'main', 1, 0, ?)").run(`me/${name}`, name, marker ? "set_up" : "not_set_up");
  }
  // GitHub knows me/demo, so a card that reaches the PR step can open one.
  fs.mkdirSync(path.join(tmp, "gh", "me"), { recursive: true });
  fs.symlinkSync(path.join(tmp, "demo.git"), path.join(tmp, "gh", "me", "demo.git"));

  secrets = new SecretStore(db, process.env.WORKBENCH_MASTER_KEY!);
  const delivery = githubDelivery({ github: () => new GitHub("ghp_test"), gitEnv, model: () => getModelSettings(db), llmKey: () => undefined });
  mgr = new SessionManager(db, secrets, gitEnv, undefined, (ref: string) => new GitHub("ghp_test").ticketsFromIssueRef(ref), undefined, delivery);

  // The library, installed and attached.
  const source = await addSkillSource(db, { url: `file://${sourceDir}` }, await gitEnv());
  const skills: Record<string, string> = {};
  for (const s of source.skills) skills[s.name] = s.id;
  library = { sourceId: source.id, skills };
  const at = (name: string, attach: string[], enabled?: boolean) => setSkillSettings(db, source.id, skills[name], enabled === false ? { attach, enabled } : { attach });
  at("probe-plan", ["grill", "tickets"]);
  at("probe-impl", ["implement"]);
  at("probe-review", ["review"]);
  at("probe-direct", ["direct"]);
  at("probe-all", ["grill", "spec", "tickets", "implement", "review", "direct"]);
  at("probe-off", ["grill", "spec", "tickets", "implement", "review", "direct"], false);
});

after(async () => {
  if (!hasPi) return;
  await mgr?.shutdown();
  await mock?.close();
  await ghMock?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a pipeline conversation reports the skills attached to the place it is in, and only those", { skip }, async () => {
  const s = await mgr.create({ repoId: "me/demo", title: "Attach probe", prompt: "add a greeting" });
  await waitFor(() => mgr.summary(s.id).phase === "grill");

  // The grill place: what is attached to grill, and nothing from another place.
  const ask = await waitFor(() => mgr.summary(s.id).pending[0]);
  assert.match(ask.title, /shared understanding/);
  assert.deepEqual(libraryOnly(await agentSkills(s.id)), ["probe-all", "probe-plan"], "the grill place gets the skills attached to grill");
  await answerNext(s.id, /shared understanding/);

  // The spec place, in the same conversation: the grill-attached skill is gone, so the place decides,
  // not the session, and not the run that started the conversation.
  const ask2 = await waitFor(() => (mgr.summary(s.id).phase === "spec" ? mgr.summary(s.id).pending[0] : undefined));
  assert.match(ask2.title, /seam/);
  assert.deepEqual(libraryOnly(await agentSkills(s.id)), ["probe-all"], "the spec place keeps only what is attached to spec");
  await answerNext(s.id, /seam/);

  // The tickets place, still the same conversation: the tickets-attached skill is back.
  const ask3 = await waitFor(() => (mgr.summary(s.id).phase === "tickets" ? mgr.summary(s.id).pending[0] : undefined));
  assert.match(ask3.title, /Approve/);
  assert.deepEqual(libraryOnly(await agentSkills(s.id)), ["probe-all", "probe-plan"], "the tickets place gets the skills attached to tickets");
  const ticketsRun = mgr.live.get(s.id).proc;
  await answerNext(s.id, /Approve/);

  // The recorded tickets pause the card in Issues: it keeps the tickets conversation, so the same skills.
  await waitFor(() => mgr.summary(s.id).phase === "ready" && mgr.summary(s.id).status === "idle");
  assert.equal(mgr.live.get(s.id).proc, ticketsRun, "the paused card keeps its tickets run");
  assert.deepEqual(libraryOnly(await agentSkills(s.id)), ["probe-all", "probe-plan"]);
  await mgr.stop(s.id);
});

test("a ticket run gets the implement place, the review run gets the review place, and a setup run gets nothing", { skip }, async () => {
  ghMock.seedSubIssues(
    "me",
    "demo",
    { number: 7, title: "Greeting suite", body: "## Solution\nhello.txt says Hello, and it is tested. REVIEWASK" },
    [
      { number: 8, title: "Write hello.txt", body: "Create hello.txt containing Hello. QUICKME" },
      { number: 9, title: "Add a test", body: "Test that hello.txt says Hello. ASKME", blockedBy: [8] },
    ],
  );
  const s = await mgr.create({ repoId: "me/demo", title: "Attach tickets probe", issueRef: "me/demo#7", mode: "pipeline", startFrom: "tickets" });

  // The implement place, on a ticket run (ticket 2 asks the user before it works, so it is steady to read).
  const ask = await waitFor(() => mgr.summary(s.id).pending[0]);
  assert.match(ask.title, /Which file does this ticket change/);
  assert.equal(mgr.summary(s.id).phase, "implement", "the card implements while its ticket run works");
  assert.deepEqual(libraryOnly(await agentSkills(s.id)), ["probe-all", "probe-impl"], "the implement place gets the skills attached to implement");
  await answerNext(s.id, /Which file does this ticket change/, "work.txt");

  // The review place: its own fresh run, so the implement skills are gone and the review skills are in.
  const reviewAsk = await waitFor(() => (mgr.summary(s.id).phase === "review" ? mgr.summary(s.id).pending[0] : undefined));
  assert.match(reviewAsk.title, /Review the whole branch/);
  assert.deepEqual(libraryOnly(await agentSkills(s.id)), ["probe-all", "probe-review"], "the review place gets the skills attached to review");
  await mgr.stop(s.id);

  // The setup run serves no pipeline place, so nothing attached reaches it — not even a skill attached
  // to all six places.
  const setup = await mgr.create({ repoId: "me/plain", title: "Attach setup probe", prompt: "add a greeting", mode: "pipeline" });
  assert.equal(mgr.summary(setup.id).phase, "setup");
  const reported = await agentSkills(setup.id);
  assert.deepEqual(libraryOnly(reported), [], "no installed skill reaches the setup run");
  assert.equal(mgr.installedSkillDirs(setup.id).length, 0, "the setup run is handed no installed skill");
  const { listAttachedSkills } = await import("../src/skill-library.ts");
  assert.ok(listAttachedSkills(db, "implement").length > 0, "the library does hold skills attached to other places");
  await mgr.stop(setup.id);
});

test("a direct session is the direct place, and a change reaches its next run, not the run going now", { skip }, async () => {
  const { setSkillSettings, installedSkill } = await import("../src/skill-library.ts");

  const s = await mgr.create({ repoId: "me/demo", title: "Attach direct probe", prompt: "", mode: "direct" });
  assert.deepEqual(libraryOnly(await agentSkills(s.id)), ["probe-all", "probe-direct"], "the direct place gets the skills attached to direct");

  // Switch it off while the run lives: the running agent keeps what its spawn carried, and the next run loses it.
  setSkillSettings(db, library.sourceId, library.skills["probe-direct"], { enabled: false });
  assert.deepEqual(libraryOnly(await agentSkills(s.id)), ["probe-all", "probe-direct"], "a change does not reach the run going now");
  assert.deepEqual(libraryOnly(await agentSkillsOnNextRun(s.id)), ["probe-all"], "the next run of the place does not get it");
  assert.deepEqual(installedSkill(db, library.skills["probe-direct"]).attach, ["direct"], "switching off is not un-attaching");

  // A fresh session of the same place reads the switch too.
  const s2 = await mgr.create({ repoId: "me/demo", title: "Attach direct probe 2", prompt: "", mode: "direct" });
  assert.deepEqual(libraryOnly(await agentSkills(s2.id)), ["probe-all"]);

  // An attach point change behaves the same way: only the next run of the place it names gets it.
  setSkillSettings(db, library.sourceId, library.skills["probe-direct"], { enabled: true, attach: ["review"] });
  assert.deepEqual(libraryOnly(await agentSkillsOnNextRun(s2.id)), ["probe-all"], "the direct place no longer gets it");
  const s3 = await mgr.create({ repoId: "me/demo", title: "Attach direct probe 3", prompt: "add a greeting", mode: "pipeline" });
  await waitFor(() => mgr.summary(s3.id).phase === "grill");
  await waitFor(() => mgr.summary(s3.id).pending[0]);
  assert.deepEqual(libraryOnly(await agentSkills(s3.id)), ["probe-all", "probe-plan"], "and the grill place does not get it either");
  await mgr.stop(s3.id);
  setSkillSettings(db, library.sourceId, library.skills["probe-direct"], { attach: ["direct"] });
});

test("the session's own skill read names the installed skills its runs reach, beside the image and repo skills", { skip }, async () => {
  const { listSkills } = await import("../src/skills.ts");
  const s = await mgr.create({ repoId: "me/demo", title: "Attach listing probe", prompt: "add a greeting", mode: "pipeline" });
  await waitFor(() => mgr.summary(s.id).phase === "grill");
  await waitFor(() => mgr.summary(s.id).pending[0]);
  const listed = listSkills(config.skillsDir, mgr.summary(s.id).worktree, mgr.extraSkillDirs(s.id), mgr.installedSkillDirs(s.id));
  const byName = new Map(listed.map((x: any) => [x.name, x]));
  assert.equal(byName.get("probe-plan")?.source, "installed", "an installed skill is stated as installed, never as an image skill");
  assert.equal(byName.get("probe-plan")?.description, "The probe-plan skill from the library.");
  assert.ok(byName.get("grill-with-docs"), "the image skills are listed beside it");
  assert.ok(!byName.has("probe-impl"), "a skill attached to another place is not listed for this session");
  assert.ok(!byName.has("probe-off"), "and a switched-off skill is not listed at all");
  await mgr.stop(s.id);
});
