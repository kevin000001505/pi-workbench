/**
 * The skill library over HTTP (issues #115 and #116): Add skill takes a git URL, an optional ref and an
 * optional subpath, pins the commit it cloned, and answers with the Skill source and the installed skills
 * it found; GET /api/skill-sources lists the library, and the skills reads tell the Skills page the image
 * skills, the installed ones, and the built-in optional skill apart. The source is a local bare git repo
 * cloned through a `file://` URL, in the shape of the repo tests' remotes. Drives the real server (main.ts)
 * on an ephemeral port, in the shape of the settings route test.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { editRemoteFile, nameRemoteRef, remoteCommits, seedBareRepo } from "./remote-repo.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-skill-source-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "skill-source-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");
// The image bakes the TypeSafe skill into the optional skills dir; pi never scans it (ADR 0004).
process.env.OPTIONAL_SKILLS_DIR = path.join(tmp, "optional-skills");
process.env.HOME = path.join(tmp, "agent-home");
process.env.PI_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-extension", "workbench.ts");

// An image skill, so the scanned skills directory has something to tell apart from an installed one.
fs.mkdirSync(path.join(process.env.SKILLS_DIR, "image-skill"), { recursive: true });
fs.writeFileSync(path.join(process.env.SKILLS_DIR, "image-skill", "SKILL.md"), "---\nname: image-skill\ndescription: an image skill every run scans\n---\nimage body\n");
fs.mkdirSync(path.join(process.env.OPTIONAL_SKILLS_DIR, "typesafe-ai"), { recursive: true });
fs.writeFileSync(
  path.join(process.env.OPTIONAL_SKILLS_DIR, "typesafe-ai", "SKILL.md"),
  "---\nname: typesafe-ai\ndescription: Guidance for code that calls TypeSafe System One.\n---\ntypesafe body\n",
);

/** A port nothing listens on, so a test can start its own server on it. */
const findFreePort = () =>
  new Promise<number>((res, rej) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => res(p));
    });
    srv.on("error", rej);
  });

const freePort = await findFreePort();
process.env.PORT = String(freePort);
process.env.HOST = "127.0.0.1";
const base = `http://127.0.0.1:${freePort}`;

// Import after the env is set: main.ts reads config on load and starts the server.
await import("../src/main.ts");

const api = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

/** Poll health until the server is up. */
async function waitReady(ms = 30_000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {}
    if (Date.now() - start > ms) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The bare repos the tests clone through `file://`, and their head. */
const gitRoot = path.join(tmp, "git-remote");
fs.mkdirSync(gitRoot);
const barePath = (owner: string, name: string) => path.join(gitRoot, owner, `${name}.git`);
const gitSourceUrl = (owner: string, name: string) => `file://${barePath(owner, name)}`;
const headOf = (owner: string, name: string) => execFileSync("git", ["-C", barePath(owner, name), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

/** A SKILL.md the way a skill repo writes one. */
const skillDoc = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n${name} body\n`;

// main.ts's SIGTERM handler stops the sessions and exits; the after hook runs after the test's TAP
// has been emitted, so the result is not lost.
after(() => process.kill(process.pid, "SIGTERM"));

test("Add skill installs a git source and answers with the commit it pinned, its size and its skills", async () => {
  await waitReady();
  const files = {
    "naming/SKILL.md": skillDoc("commit-naming", "Name commits the way this team writes them."),
    "README.md": "# plain\n",
  };
  seedBareRepo(gitRoot, "acme", "plain", files);
  // A second commit on the default branch: the pin is the head the source has now, not the first one.
  const added = skillDoc("review-style", "How this team reviews code.");
  editRemoteFile(gitRoot, "acme", "plain", "review/SKILL.md", added);

  const add = await api("POST", "/api/skill-sources", { url: gitSourceUrl("acme", "plain") });
  assert.equal(add.status, 200);
  assert.equal(add.json.url, gitSourceUrl("acme", "plain"));
  assert.equal(add.json.ref, null, "no ref named: the default head");
  assert.equal(add.json.subpath, null);
  assert.equal(add.json.commit, headOf("acme", "plain"), "the source's default head is pinned");
  // The size is the tree the install keeps: the three files, git's own objects aside.
  assert.equal(add.json.sizeBytes, Object.values(files).reduce((n, c) => n + Buffer.byteLength(c), 0) + Buffer.byteLength(added));
  assert.deepEqual(
    add.json.skills.map(({ name, description, files: f }: any) => ({ name, description, files: f })),
    [
      { name: "commit-naming", description: "Name commits the way this team writes them.", files: ["SKILL.md"] },
      { name: "review-style", description: "How this team reviews code.", files: ["SKILL.md"] },
    ],
  );

  // The install lives in the data volume, as a tree of skills and no git objects.
  const { config } = await import("../src/config.ts");
  const installed = path.join(config.installedSkillsDir, add.json.id);
  assert.ok(fs.existsSync(path.join(installed, "naming", "SKILL.md")), "the installed skill's files are on disk");
  assert.ok(fs.existsSync(path.join(installed, "review", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(installed, ".git")), "the install is the tree, not a clone");

  // The library lists it, with its skills.
  const listed = await api("GET", "/api/skill-sources");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.map((s: any) => s.id), [add.json.id]);
  assert.equal(listed.json[0].commit, add.json.commit);
  assert.deepEqual(listed.json[0].skills.map((s: any) => s.name), ["commit-naming", "review-style"]);
  assert.ok(listed.json[0].skills[0].id, "each installed skill has an id the later tickets can name");
});

/** The installed skill names of an add or listing answer, sorted: the library lists them by name. */
const skillNames = (source: any) => source.skills.map((s: any) => s.name).sort();

test("a ref resolves to one pinned commit — a branch, a tag or a commit — and with no ref the default head", async () => {
  await waitReady();
  seedBareRepo(gitRoot, "acme", "versioned", { "one/SKILL.md": skillDoc("one-skill", "The skill the first commit carries.") });
  const [commit1] = remoteCommits(gitRoot, "acme", "versioned");
  // A tag and another branch both stay at commit1 while main moves on.
  nameRemoteRef(gitRoot, "acme", "versioned", "refs/tags/v1", commit1);
  nameRemoteRef(gitRoot, "acme", "versioned", "refs/heads/release", commit1);
  editRemoteFile(gitRoot, "acme", "versioned", "two/SKILL.md", skillDoc("two-skill", "The skill the second commit adds."));
  const url = gitSourceUrl("acme", "versioned");
  const head = headOf("acme", "versioned");
  assert.notEqual(head, commit1, "the fixture moved main on");

  const branch = await api("POST", "/api/skill-sources", { url, ref: "release" });
  assert.equal(branch.status, 200);
  assert.equal(branch.json.ref, "release");
  assert.equal(branch.json.commit, commit1, "the branch names one commit, and that is the pin");
  assert.deepEqual(skillNames(branch.json), ["one-skill"], "the pinned commit's tree is what installs");

  const tag = await api("POST", "/api/skill-sources", { url, ref: "v1" });
  assert.equal(tag.status, 200);
  assert.equal(tag.json.commit, commit1, "a tag resolves to the commit it names");

  const commit = await api("POST", "/api/skill-sources", { url, ref: commit1 });
  assert.equal(commit.status, 200);
  assert.equal(commit.json.commit, commit1, "a commit names itself");
  assert.deepEqual(skillNames(commit.json), ["one-skill"]);

  const def = await api("POST", "/api/skill-sources", { url });
  assert.equal(def.status, 200);
  assert.equal(def.json.ref, null);
  assert.equal(def.json.commit, head, "with no ref the source's default head is pinned");
  assert.deepEqual(skillNames(def.json), ["one-skill", "two-skill"]);

  const bad = await api("POST", "/api/skill-sources", { url, ref: "no-such-thing" });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /no-such-thing/, "the refusal names the ref it could not resolve");
});

test("a subpath installs the skills found under it, deeper nesting included, and refuses a path that is not a URL", async () => {
  await waitReady();
  const files = {
    "README.md": "# collection\n",
    "root-skill/SKILL.md": skillDoc("outside-skill", "A skill outside the subpath."),
    "packages/ui/SKILL.md": skillDoc("ui-style", "How this collection writes UI."),
    "packages/ui/references/tokens.md": "colour tokens\n",
    "packages/db/migrations/helper/SKILL.md": skillDoc("helper-style", "A skill nested deeper than the subpath."),
  };
  seedBareRepo(gitRoot, "acme", "collection", files);
  const url = gitSourceUrl("acme", "collection");
  const before = (await api("GET", "/api/skill-sources")).json.length;

  const sub = await api("POST", "/api/skill-sources", { url, subpath: "packages" });
  assert.equal(sub.status, 200);
  assert.equal(sub.json.subpath, "packages");
  assert.deepEqual(skillNames(sub.json), ["helper-style", "ui-style"], "the skills under the subpath install; the ones outside it do not");
  const ui = sub.json.skills.find((s: any) => s.name === "ui-style");
  assert.deepEqual(ui.files, ["SKILL.md", "references/tokens.md"], "each installed skill comes with its file names");
  // The size is the tree the install keeps: what the subpath holds, nothing outside it.
  const under = (prefix: string) =>
    Object.entries(files).reduce((n, [rel, c]) => (rel.startsWith(`${prefix}/`) ? n + Buffer.byteLength(c) : n), 0);
  assert.equal(sub.json.sizeBytes, under("packages"));

  const { config } = await import("../src/config.ts");
  const installed = path.join(config.installedSkillsDir, sub.json.id);
  assert.ok(fs.existsSync(path.join(installed, "ui", "SKILL.md")), "the install keeps the tree under the subpath");
  assert.ok(fs.existsSync(path.join(installed, "db", "migrations", "helper", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(installed, "root-skill")), "what the subpath leaves out is not installed");

  // The same source with no subpath takes every skill it carries.
  const whole = await api("POST", "/api/skill-sources", { url });
  assert.equal(whole.status, 200);
  assert.deepEqual(skillNames(whole.json), ["helper-style", "outside-skill", "ui-style"]);

  // An absolute local path is refused, with the file:// form named as the way in.
  const local = await api("POST", "/api/skill-sources", { url: barePath("acme", "collection") });
  assert.equal(local.status, 400);
  assert.match(local.json.error, /file:\/\//, "the refusal states the URL form it wants");
  // A subpath outside the source is refused too.
  const escape = await api("POST", "/api/skill-sources", { url, subpath: "../outside" });
  assert.equal(escape.status, 400);
  assert.match(escape.json.error, /outside/);
  // A leading slash names an absolute path, not a directory inside the source: it is refused for what it is.
  const absolute = await api("POST", "/api/skill-sources", { url, subpath: "/packages" });
  assert.equal(absolute.status, 400);
  assert.match(absolute.json.error, /absolute/);
  // A trailing slash is the same directory named untidily: it installs the same skills.
  // A trailing slash names the same directory the library already installed (issue #122): the same
  // source named untidily is one source, so the add is refused instead of installing a second copy.
  const untidy = await api("POST", "/api/skill-sources", { url, subpath: "packages/" });
  assert.equal(untidy.status, 409, JSON.stringify(untidy.json));
  assert.match(untidy.json.error, /already in the library/, "the same source named untidily is one source");
  // A subpath the source does not carry is a refusal that names it.
  const missing = await api("POST", "/api/skill-sources", { url, subpath: "does-not-exist" });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /no directory "does-not-exist"/);
  assert.equal((await api("GET", "/api/skill-sources")).json.length, before + 2, "a refusal installs nothing");
});

test("an add is all-or-nothing: a refused clone, a source with no valid skill, and a source over the cap install nothing", async () => {
  await waitReady();
  const { config } = await import("../src/config.ts");
  const library = async () => (await api("GET", "/api/skill-sources")).json;
  seedBareRepo(gitRoot, "acme", "empty", { "README.md": "# nothing here\n", "notes.txt": "no skill in this source\n" });
  seedBareRepo(gitRoot, "acme", "huge", {
    "big/SKILL.md": skillDoc("big-skill", "A skill in a source over the cap."),
    "big/blob.txt": "x".repeat(11 * 1024 * 1024),
  });
  const before = await library();

  const unreachable = await api("POST", "/api/skill-sources", { url: gitSourceUrl("acme", "gone") });
  assert.equal(unreachable.status, 400);
  assert.match(unreachable.json.error, /acme\/gone/, "a refused clone answers with the source it could not reach");

  const noSkill = await api("POST", "/api/skill-sources", { url: gitSourceUrl("acme", "empty") });
  assert.equal(noSkill.status, 400);
  assert.match(noSkill.json.error, /SKILL\.md/, "the refusal says what the source was missing");

  const overCap = await api("POST", "/api/skill-sources", { url: gitSourceUrl("acme", "huge") });
  assert.equal(overCap.status, 400);
  assert.match(overCap.json.error, /10 MB/, "the refusal states the cap it hit");

  assert.deepEqual(await library(), before, "a refused add leaves nothing in the library");
  // Nothing half-installed survives: the install directory holds only what the library lists.
  const ids = new Set(before.map((s: any) => s.id));
  const extra = fs.readdirSync(config.installedSkillsDir).filter((n) => !ids.has(n));
  assert.deepEqual(extra, [], "no temporary clone or half-install is left on disk");
});

test("a source that carries a pipeline skill name is refused whole, and the reason names the colliding skill", async () => {
  await waitReady();
  seedBareRepo(gitRoot, "acme", "shadow", {
    "tdd/SKILL.md": skillDoc("tdd", "A shadow of the workbench's own tdd."),
    "frontend/design/SKILL.md": skillDoc("frontend-design", "How this team writes frontend."),
    "frontend/review/SKILL.md": skillDoc("code-review-style", "A near miss on a pipeline name."),
  });
  const url = gitSourceUrl("acme", "shadow");
  const before = (await api("GET", "/api/skill-sources")).json.length;

  const shadow = await api("POST", "/api/skill-sources", { url });
  assert.equal(shadow.status, 400);
  assert.match(shadow.json.error, /\btdd\b/, "the refusal names the colliding skill");
  assert.match(shadow.json.error, /pipeline/i, "and says why a pipeline name is off limits");
  assert.equal((await api("GET", "/api/skill-sources")).json.length, before, "the whole source is refused, not only its tdd");

  // Under a subpath that leaves the colliding skill out, the install stands: a name that never
  // installs cannot shadow a pipeline run, and a near miss on a pipeline name is no collision.
  const part = await api("POST", "/api/skill-sources", { url, subpath: "frontend" });
  assert.equal(part.status, 200);
  assert.deepEqual(skillNames(part.json), ["code-review-style", "frontend-design"], "a name close to a pipeline name is no collision");

  // The shared list covers the setup run's skill too: a source that carries it is refused whole.
  seedBareRepo(gitRoot, "acme", "setupname", { "setup/SKILL.md": skillDoc("setup-matt-pocock-skills", "A copy of the workbench's own setup skill.") });
  const setupName = await api("POST", "/api/skill-sources", { url: gitSourceUrl("acme", "setupname") });
  assert.equal(setupName.status, 400);
  assert.match(setupName.json.error, /"setup-matt-pocock-skills"/);
});

test("the library listing answers with every source and its skills, survives a restart, and stays out of the skills dir every run scans", async () => {
  await waitReady();
  const { config } = await import("../src/config.ts");
  seedBareRepo(gitRoot, "acme", "keep", { "keep/SKILL.md": skillDoc("kept-skill", "A skill the library has to keep.") });
  const before = (await api("GET", "/api/skill-sources")).json.length;
  const added = await api("POST", "/api/skill-sources", { url: gitSourceUrl("acme", "keep") });
  assert.equal(added.status, 200);

  const listed = await api("GET", "/api/skill-sources");
  assert.equal(listed.status, 200);
  // Every source the library holds, each with the skills it installed.
  assert.equal(listed.json.length, before + 1, "the listing answers with every source, not only the last add");
  assert.deepEqual(skillNames(listed.json.find((s: any) => s.url === gitSourceUrl("acme", "keep"))), ["kept-skill"]);
  assert.deepEqual(skillNames(listed.json.find((s: any) => s.url === gitSourceUrl("acme", "shadow"))), ["code-review-style", "frontend-design"]);

  // An installed skill is not in the directory every run scans: the session's skill list does not name it.
  const scanned = (await api("GET", "/api/skills")).json.map((s: any) => s.name);
  assert.ok(scanned.includes("image-skill"), "the fixture's image skill is scanned, as the test set it up");
  assert.ok(!scanned.includes("kept-skill"), "the installed skill is not scanned, so an unrelated run never pays for it");

  // A restart is a fresh process on the same data volume: the rows and the installed tree both answer.
  const port = await findFreePort();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/main.ts"], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", () => {});
  const restartBase = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${restartBase}/api/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("the restarted server did not come up");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    const after = await (await fetch(`${restartBase}/api/skill-sources`)).json();
    assert.deepEqual(after.map((s: any) => s.id).sort(), listed.json.map((s: any) => s.id).sort(), "the source rows survive the restart");
    const kept = after.find((s: any) => s.url === gitSourceUrl("acme", "keep"));
    assert.equal(kept.commit, added.json.commit);
    assert.equal(kept.sizeBytes, added.json.sizeBytes);
    assert.equal(kept.ref, null);
    assert.deepEqual(skillNames(kept), ["kept-skill"]);
    const skill = kept.skills[0];
    assert.ok(skill.dir.startsWith(config.installedSkillsDir) && !skill.dir.startsWith(config.skillsDir), "the install lives in the data volume, outside the scanned skills dir");
    assert.ok(fs.existsSync(path.join(skill.dir, "SKILL.md")), "the installed directory survives the restart too");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
});

test("a refusal never echoes the credentials a source URL carries", async () => {
  await waitReady();
  const res = await api("POST", "/api/skill-sources", { url: "https://ghp_abcdefghijklmnopqrst0123456789@github.invalid/acme/private-skills.git" });
  assert.equal(res.status, 400, "the source cannot be reached, so the add is refused");
  assert.ok(!res.json.error.includes("ghp_abcdefghijklmnopqrst0123456789"), "the reason carries no token");
  assert.match(res.json.error, /github\.invalid/, "and it still names the source the user has to fix");
});

test("a body that is not a source is refused with a reason, not a crash", async () => {
  await waitReady();
  const before = (await api("GET", "/api/skill-sources")).json.length;
  for (const body of [null, "a url please", 7, {}, { url: "   " }]) {
    const res = await api("POST", "/api/skill-sources", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.json.error, /git URL/, `the refusal says what Add skill needs (${JSON.stringify(body)})`);
  }
  assert.equal((await api("GET", "/api/skill-sources")).json.length, before, "a refused body installs nothing");
});

test("the skills reads tell the image skills and the built-in optional skill apart, so the Skills page can state both", async () => {
  await waitReady();
  // Without a session and without the optional skill asked for: the image skills only, as the Skills page
  // lists them read-only.
  const scanned = (await api("GET", "/api/skills")).json;
  assert.ok(scanned.some((s: any) => s.name === "image-skill" && s.source === "global"), "the image skill is stated as an image skill");
  assert.ok(!scanned.some((s: any) => s.name === "typesafe-ai"), "a run that did not pick the optional skill does not get it");

  // `typesafe=1`: the same read with the built-in optional skill, so one page states everything a session
  // can reach. The read names which one it is: the page never has to guess a name.
  const withOptional = (await api("GET", "/api/skills?typesafe=1")).json;
  const optional = withOptional.filter((s: any) => s.source === "optional");
  assert.deepEqual(
    optional.map(({ name, description }: any) => ({ name, description })),
    [{ name: "typesafe-ai", description: "Guidance for code that calls TypeSafe System One." }],
    "the built-in optional skill is stated as optional, with its description",
  );
  assert.ok(
    withOptional.some((s: any) => s.name === "image-skill" && s.source === "global"),
    "the image skills stay beside it in the same read",
  );
});

test("a URL that reads as a git option is refused as a source, not run as one", async () => {
  await waitReady();
  const before = (await api("GET", "/api/skill-sources")).json.length;
  for (const url of ["--help", "-v", "--ext::sh -c echo planted"]) {
    const res = await api("POST", "/api/skill-sources", { url });
    assert.equal(res.status, 400, url);
    assert.match(res.json.error, /git URL/, url);
  }
  assert.equal((await api("GET", "/api/skill-sources")).json.length, before, "an option-shaped URL installs nothing");
});

/** One installed skill of one source, as the library listing states it. */
async function librarySkill(url: string, name: string) {
  const listed = await api("GET", "/api/skill-sources");
  const source = listed.json.find((s: any) => s.url === url);
  return { source, skill: source?.skills.find((s: any) => s.name === name) };
}

test("the on/off switch and the attach checkboxes are stored, and every read answers with them", async () => {
  await waitReady();
  const url = gitSourceUrl("acme", "attach");
  seedBareRepo(gitRoot, "acme", "attach", {
    "design/SKILL.md": skillDoc("design-notes", "How this team writes design docs."),
    "ship/SKILL.md": skillDoc("ship-checklist", "The checklist this team ships with."),
  });
  const added = await api("POST", "/api/skill-sources", { url });
  assert.equal(added.status, 200);
  const sourceId = added.json.id;
  const skillId = added.json.skills.find((s: any) => s.name === "design-notes").id;

  // A new installed skill is switched on and attached to nothing, so it reaches no run.
  assert.deepEqual(added.json.skills.find((s: any) => s.name === "design-notes").attach, []);
  assert.equal(added.json.skills.find((s: any) => s.name === "design-notes").enabled, true);

  // The attach checkboxes: the answer and every later read carry the places, in the pipeline's order.
  const saved = await api("PATCH", `/api/skill-sources/${sourceId}/skills/${skillId}`, { attach: ["direct", "review", "implement"] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.attach, ["implement", "review", "direct"], "one order, whatever order the page sent");
  assert.equal(saved.json.enabled, true, "attaching does not switch it off");

  // The on/off switch keeps the attach points: off is not un-attaching.
  const off = await api("PATCH", `/api/skill-sources/${sourceId}/skills/${skillId}`, { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.enabled, false);
  assert.deepEqual(off.json.attach, ["implement", "review", "direct"]);
  const on = await api("PATCH", `/api/skill-sources/${sourceId}/skills/${skillId}`, { enabled: true });
  assert.equal(on.json.enabled, true);

  // The settings are on the row, so the page reads them back after a reload.
  const { skill } = await librarySkill(url, "design-notes");
  assert.deepEqual(skill.attach, ["implement", "review", "direct"]);
  assert.equal(skill.enabled, true);
  const untouched = (await librarySkill(url, "ship-checklist")).skill;
  assert.deepEqual(untouched.attach, [], "the other skill of the source is unchanged");

  // A restart is a fresh process on the same data volume: the settings answer again.
  const port = await findFreePort();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/main.ts"], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", () => {});
  const restartBase = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${restartBase}/api/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("the restarted server did not come up");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    const listed = await (await fetch(`${restartBase}/api/skill-sources`)).json();
    const kept = listed.find((s: any) => s.url === url)?.skills?.find((s: any) => s.name === "design-notes");
    assert.deepEqual(kept.attach, ["implement", "review", "direct"], "the attach points survive the restart");
    assert.equal(kept.enabled, true, "and so does the switch");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
});

test("an attach setting outside the pipeline places is refused, and the reason names the places it can take", async () => {
  await waitReady();
  seedBareRepo(gitRoot, "acme", "attachbad", { "bad/SKILL.md": skillDoc("bad-attach", "A skill the page sets.") });
  const added = await api("POST", "/api/skill-sources", { url: gitSourceUrl("acme", "attachbad") });
  const url = gitSourceUrl("acme", "attachbad");
  const source = added.json;
  const skill = added.json.skills[0];
  const at = `/api/skill-sources/${source.id}/skills/${skill.id}`;
  assert.equal((await api("PATCH", at, { attach: ["grill"] })).json.attach.length, 1, "a place the table knows is accepted, so a refusal is about the value");
  for (const body of [
    { attach: ["done"] },
    { attach: ["setup"] },
    { attach: ["ticket"] },
    { attach: ["implement", "grill-ish"] },
    { attach: "implement" },
    { attach: [7] },
    { attach: null },
    { enabled: "true" },
    { enabled: 1 },
    {},
  ]) {
    const res = await api("PATCH", at, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.json.error, /pipeline place|on\/off switch|Nothing to change/, JSON.stringify(body));
  }
  // A refusal stored nothing.
  const after = (await librarySkill(url, "bad-attach")).skill;
  assert.deepEqual(after.attach, ["grill"]);
  assert.equal(after.enabled, true);

  // An id the library does not hold, or a skill of another source, is refused as unknown.
  assert.equal((await api("PATCH", `/api/skill-sources/${source.id}/skills/nope`, { enabled: false })).status, 404);
  seedBareRepo(gitRoot, "acme", "attachother", { "other/SKILL.md": skillDoc("other-skill", "A skill of another source.") });
  const otherSource = (await api("POST", "/api/skill-sources", { url: gitSourceUrl("acme", "attachother") })).json;
  const otherSkill = otherSource.skills[0];
  const res = await api("PATCH", `/api/skill-sources/${otherSource.id}/skills/${skill.id}`, { enabled: false });
  assert.equal(res.status, 404, "a skill is set under its own source only");
  assert.equal((await librarySkill(url, "bad-attach")).skill.enabled, true, "and nothing changed");
  assert.equal((await api("PATCH", `/api/skill-sources/${source.id}/skills/${otherSkill.id}`, { enabled: false })).status, 404, "nor the other source's skill, under this source");
});

/** One Skill source of the listing, by the URL it was cloned from. */
async function sourceAt(url: string) {
  const listed = await api("GET", "/api/skill-sources");
  return listed.json.find((s: any) => s.url === url);
}

/** The names of every source row the library holds, and the source ids, for the "nothing half-installed" checks. */
async function libraryIds() {
  return new Set<string>((await api("GET", "/api/skill-sources")).json.map((s: any) => s.id));
}

/** The install directory, stated as the names it holds that the library does not list. */
async function strayInstalls() {
  const { config } = await import("../src/config.ts");
  const ids = await libraryIds();
  return fs.readdirSync(config.installedSkillsDir).filter((n) => !ids.has(n));
}

test("Remove takes the Skill source, the rows of its installed skills and its installed directory out of the library", async () => {
  await waitReady();
  const { config } = await import("../src/config.ts");
  const url = gitSourceUrl("acme", "removable");
  seedBareRepo(gitRoot, "acme", "removable", {
    "gone/SKILL.md": skillDoc("gone-skill", "A skill the library is about to lose."),
    "kept/SKILL.md": skillDoc("kept-skill-2", "Another skill of the same source."),
  });
  const added = await api("POST", "/api/skill-sources", { url });
  assert.equal(added.status, 200);
  const dir = path.join(config.installedSkillsDir, added.json.id);
  assert.ok(fs.existsSync(path.join(dir, "gone", "SKILL.md")), "the source is installed before Remove takes it out");
  // Its skill is attached, so a run would have loaded it: Remove has to take that away too.
  const skillId = added.json.skills.find((s: any) => s.name === "gone-skill").id;
  assert.equal((await api("PATCH", `/api/skill-sources/${added.json.id}/skills/${skillId}`, { attach: ["implement"] })).status, 200);

  const removed = await api("DELETE", `/api/skill-sources/${added.json.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));

  const listed = await api("GET", "/api/skill-sources");
  assert.ok(!listed.json.some((s: any) => s.id === added.json.id), "the source row is gone");
  assert.ok(
    !listed.json.some((s: any) => s.skills.some((k: any) => k.name === "gone-skill" || k.name === "kept-skill-2")),
    "and the rows of the skills it installed with it",
  );
  assert.ok(!fs.existsSync(dir), "and so is the installed directory");
  assert.deepEqual(await strayInstalls(), [], "Remove leaves no directory the library does not list");

  // The other sources are untouched by it.
  const untouched = await sourceAt(gitSourceUrl("acme", "attach"));
  assert.deepEqual(skillNames(untouched), ["design-notes", "ship-checklist"]);

  // A source the library does not hold is refused, as every other write route refuses what it cannot find.
  assert.equal((await api("DELETE", "/api/skill-sources/no-such-source")).status, 404);
  assert.equal((await api("POST", "/api/skill-sources/no-such-source/update", {})).status, 404);
});

test("Add skill refuses a source the library already holds, and names Update as the way to take the new version", async () => {
  await waitReady();
  const url = gitSourceUrl("acme", "twice");
  seedBareRepo(gitRoot, "acme", "twice", {
    "twice/SKILL.md": skillDoc("twice-skill", "A skill the library holds once."),
    "other/SKILL.md": skillDoc("other-half", "Another skill of the same source."),
  });
  const first = await api("POST", "/api/skill-sources", { url });
  assert.equal(first.status, 200);

  const dupe = await api("POST", "/api/skill-sources", { url });
  assert.equal(dupe.status, 409, JSON.stringify(dupe.json));
  assert.match(dupe.json.error, /already in the library/, "the refusal says the source is there once already");
  assert.match(dupe.json.error, /Update/, "and names the action that takes a new version of it");
  assert.deepEqual(await strayInstalls(), [], "a refused duplicate installs nothing");

  // What the library holds is named by its URL *and* its ref *and* its subpath: another ref or another
  // subpath of the same repo is a different source, and the add stands.
  assert.equal((await api("POST", "/api/skill-sources", { url, ref: "main" })).status, 200);
  const part = await api("POST", "/api/skill-sources", { url, subpath: "twice" });
  assert.equal(part.status, 200);
  assert.deepEqual(skillNames(part.json), ["twice-skill"], "a subpath is its own source");
  const rows = (await api("GET", "/api/skill-sources")).json.filter((s: any) => s.url === url);
  assert.equal(rows.length, 3, "the three sources the user named, not a copy of one of them");
});

test("two Add skill clicks for one source at once start one clone", async () => {
  await waitReady();
  const url = gitSourceUrl("acme", "racing");
  seedBareRepo(gitRoot, "acme", "racing", { "race/SKILL.md": skillDoc("race-skill", "One skill of a source added twice at once.") });

  // Both clicks read the library before either has recorded a row: the guard is on the source the user
  // named, so the second click waits and no second copy of the tree is cloned.
  const both = await Promise.all([api("POST", "/api/skill-sources", { url }), api("POST", "/api/skill-sources", { url })]);
  const answers = both.map((r) => [r.status, r.json?.error ?? ""]);
  assert.equal(both.filter((r) => r.status === 200).length, 1, `one clone started: ${JSON.stringify(answers)}`);
  assert.equal(both.filter((r) => r.status === 409).length, 1, `the other click waits: ${JSON.stringify(answers)}`);
  for (const r of both.filter((x) => x.status === 409)) assert.match(r.json.error, /already/, JSON.stringify(r.json));
  assert.deepEqual(await strayInstalls(), [], "a refused second clone installs nothing");

  // The library holds the source once, so its switch, its attach points and a ticket tag each have one owner.
  const listed = await api("GET", "/api/skill-sources");
  const held = listed.json.filter((s: any) => s.url === url);
  assert.equal(held.length, 1, "one row for the source the user named twice");
  assert.deepEqual(skillNames(held[0]), ["race-skill"]);

  // Once the clone finished, the same source named again is the refusal that names Update.
  const again = await api("POST", "/api/skill-sources", { url });
  assert.equal(again.status, 409, JSON.stringify(again.json));
  assert.match(again.json.error, /already in the library/, "and the row that stands names Update as the way in");
});

test("Update keeps each installed skill of a source that declares one name twice", async () => {
  await waitReady();
  const { config } = await import("../src/config.ts");
  const url = gitSourceUrl("acme", "samename");
  seedBareRepo(gitRoot, "acme", "samename", {
    "a/SKILL.md": skillDoc("same-name", "The first directory that declares this name."),
    "b/SKILL.md": skillDoc("same-name", "The second directory that declares this name."),
  });
  const added = await api("POST", "/api/skill-sources", { url });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.deepEqual(skillNames(added.json), ["same-name", "same-name"], "Add skill installs a source that declares one name twice");
  const [firstId, secondId] = added.json.skills.map((s: any) => s.id);
  assert.notEqual(firstId, secondId);
  // The user's setting on the first of them, so the Update has a setting to carry.
  assert.equal((await api("PATCH", `/api/skill-sources/${added.json.id}/skills/${firstId}`, { attach: ["implement"], enabled: false })).status, 200);

  editRemoteFile(gitRoot, "acme", "samename", "c/SKILL.md", skillDoc("third", "The skill the new version adds."));
  const updated = await api("POST", `/api/skill-sources/${added.json.id}/update`, {});
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.deepEqual(skillNames(updated.json), ["same-name", "same-name", "third"], "the new version is installed with both");
  assert.equal(updated.json.lastError, null, "and the source states no failure");

  // Each carried name matches one library row, so no identifier is written twice.
  const carried = updated.json.skills.filter((s: any) => s.name === "same-name");
  assert.deepEqual(carried.map((s: any) => s.id).sort(), [firstId, secondId].sort(), "each keeps one of the two identifiers");
  assert.equal(carried.filter((s: any) => !s.enabled).length, 1, "and one of them keeps the switch the user set");
  assert.deepEqual(carried.find((s: any) => !s.enabled).attach, ["implement"]);

  const dir = path.join(config.installedSkillsDir, added.json.id);
  assert.ok(fs.existsSync(path.join(dir, "c", "SKILL.md")), "the skill the source added is installed");
  assert.ok(fs.existsSync(path.join(dir, "a", "SKILL.md")) && fs.existsSync(path.join(dir, "b", "SKILL.md")), "with both directories that share a name");
  assert.deepEqual(await strayInstalls(), [], "no temporary clone and no stashed version is left on disk");
});

test("Update re-resolves the source's ref, installs the new version, and each installed skill keeps its identity and its settings", async () => {
  await waitReady();
  const { config } = await import("../src/config.ts");
  const url = gitSourceUrl("acme", "moving");
  seedBareRepo(gitRoot, "acme", "moving", {
    "keep/SKILL.md": skillDoc("keep-skill", "The rules this team keeps."),
    "gone/SKILL.md": skillDoc("gone-skill", "A skill the source drops."),
  });
  const first = await api("POST", "/api/skill-sources", { url });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const keepId = first.json.skills.find((s: any) => s.name === "keep-skill").id;
  // The user's own settings on a skill of this source: attached to two places, and switched off.
  const saved = await api("PATCH", `/api/skill-sources/${first.json.id}/skills/${keepId}`, { attach: ["implement", "review"], enabled: false });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));

  // The upstream moves its default branch on: one skill goes, one arrives, one is reworded.
  editRemoteFile(gitRoot, "acme", "moving", "gone/SKILL.md", null);
  editRemoteFile(gitRoot, "acme", "moving", "keep/SKILL.md", skillDoc("keep-skill", "The rules this team keeps, reworded."));
  editRemoteFile(gitRoot, "acme", "moving", "new/SKILL.md", skillDoc("new-skill", "The skill the source adds."));
  const head = headOf("acme", "moving");

  const updated = await api("POST", `/api/skill-sources/${first.json.id}/update`, {});
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal(updated.json.id, first.json.id, "the same source row, not a second one");
  assert.equal(updated.json.commit, head, "Update takes the commit the source's ref names now");
  assert.deepEqual(skillNames(updated.json), ["keep-skill", "new-skill"], "the installed skills are the new version's");
  assert.equal(updated.json.lastError, null, "an Update that got through states no failure");

  const kept = updated.json.skills.find((s: any) => s.name === "keep-skill");
  assert.equal(kept.id, keepId, "a skill the library already had keeps its identity, so a card's Ticket skill tag still names it");
  assert.deepEqual(kept.attach, ["implement", "review"], "and keeps its attach points");
  assert.equal(kept.enabled, false, "and its on/off switch");
  assert.equal(kept.description, "The rules this team keeps, reworded.", "its own text is the new version's");
  const added = updated.json.skills.find((s: any) => s.name === "new-skill");
  assert.equal(added.enabled, true, "a skill the new version brings starts switched on");
  assert.deepEqual(added.attach, [], "and attached to no pipeline place");

  // The directory holds the new version, with the replaced version off disk.
  const dir = path.join(config.installedSkillsDir, first.json.id);
  assert.ok(fs.existsSync(path.join(dir, "new", "SKILL.md")), "the skill the source added is installed");
  assert.ok(!fs.existsSync(path.join(dir, "gone")), "the skill the source dropped is off disk");
  assert.equal(fs.readFileSync(path.join(dir, "keep", "SKILL.md"), "utf8").includes("reworded"), true, "the installed tree is the new version");
  assert.ok(fs.existsSync(path.join(kept.dir, "SKILL.md")), "and the skill row still names its directory");
  assert.deepEqual(await strayInstalls(), [], "no temporary clone and no stashed version is left on disk");

  // The listing states the same single source.
  const listed = await sourceAt(url);
  assert.equal(listed.commit, head);
  assert.deepEqual(skillNames(listed), ["keep-skill", "new-skill"]);
  assert.deepEqual(kept.attach, ["implement", "review"], "the listing states the settings that survived");
  assert.equal((await api("GET", "/api/skill-sources")).json.filter((s: any) => s.url === url).length, 1, "one row for one source");
});

test("Update re-resolves the source's own ref: a named ref stays where it is, and a source with no ref takes the new default head", async () => {
  await waitReady();
  seedBareRepo(gitRoot, "acme", "refpin", { "one/SKILL.md": skillDoc("one-skill", "The first commit's skill.") });
  const [firstCommit] = remoteCommits(gitRoot, "acme", "refpin");
  nameRemoteRef(gitRoot, "acme", "refpin", "refs/heads/release", firstCommit);
  // The default branch moves on; the branch the source named does not.
  editRemoteFile(gitRoot, "acme", "refpin", "two/SKILL.md", skillDoc("two-skill", "The skill the second commit adds."));
  const head = headOf("acme", "refpin");
  assert.notEqual(head, firstCommit);

  const url = gitSourceUrl("acme", "refpin");
  const pinned = await api("POST", "/api/skill-sources", { url, ref: "release" });
  const open = await api("POST", "/api/skill-sources", { url });
  assert.equal(pinned.status, 200);
  assert.equal(open.status, 200);

  const moved = await api("POST", `/api/skill-sources/${pinned.json.id}/update`, {});
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.commit, firstCommit, "the branch the source named has not moved, so the pin does not move");
  assert.deepEqual(skillNames(moved.json), ["one-skill"], "and the installed skills are that commit's");
  assert.equal(moved.json.ref, "release", "the source still names its own ref");

  const headless = await api("POST", `/api/skill-sources/${open.json.id}/update`, {});
  assert.equal(headless.status, 200, JSON.stringify(headless.json));
  assert.equal(headless.json.commit, head, "a source that names no ref re-resolves the source's default head");
  assert.deepEqual(skillNames(headless.json), ["one-skill", "two-skill"]);
});

test("when the new version cannot be installed, Update keeps the version that works, and the source states the failure", async () => {
  await waitReady();
  const { config } = await import("../src/config.ts");
  const url = gitSourceUrl("acme", "broken");
  seedBareRepo(gitRoot, "acme", "broken", { "good/SKILL.md": skillDoc("good-skill", "The skill the working version carries.") });
  const added = await api("POST", "/api/skill-sources", { url });
  assert.equal(added.status, 200);
  const pinned = added.json.commit;
  const dir = path.join(config.installedSkillsDir, added.json.id);

  // The upstream pushes a skill that shadows the pipeline's own tdd: the new version cannot install.
  editRemoteFile(gitRoot, "acme", "broken", "tdd/SKILL.md", skillDoc("tdd", "A copy of the workbench's own tdd."));
  const failed = await api("POST", `/api/skill-sources/${added.json.id}/update`, {});
  assert.equal(failed.status, 400, JSON.stringify(failed.json));
  assert.match(failed.json.error, /\btdd\b/, "the answer carries the reason the new version was refused");

  const held = await sourceAt(url);
  assert.equal(held.commit, pinned, "the source still pins the version that works");
  assert.deepEqual(skillNames(held), ["good-skill"], "and its skills stay installed");
  assert.match(held.lastError, /tdd/, "the source states the failure the user has to see");
  assert.ok(fs.existsSync(path.join(dir, "good", "SKILL.md")), "the installed tree is still the working one");
  assert.ok(!fs.existsSync(path.join(dir, "tdd")), "the refused version installed nothing");
  assert.deepEqual(await strayInstalls(), [], "nothing half-installed is left on disk");

  // A source the user cannot clone any more is the same shape: the row keeps what works, and states git's reason.
  const unreachable = gitSourceUrl("acme", "vanished");
  seedBareRepo(gitRoot, "acme", "vanished", { "still/SKILL.md": skillDoc("still-skill", "A skill of a source that later goes away.") });
  const kept = await api("POST", "/api/skill-sources", { url: unreachable });
  assert.equal(kept.status, 200);
  fs.rmSync(barePath("acme", "vanished"), { recursive: true, force: true });
  const unreachableFailed = await api("POST", `/api/skill-sources/${kept.json.id}/update`, {});
  assert.equal(unreachableFailed.status, 400, JSON.stringify(unreachableFailed.json));
  assert.match(unreachableFailed.json.error, /could not (read|clone)/, "the answer carries git's own reason");
  const stillHeld = await sourceAt(unreachable);
  assert.deepEqual(skillNames(stillHeld), ["still-skill"], "and the source states the version that still works");
  assert.ok(fs.existsSync(path.join(config.installedSkillsDir, kept.json.id, "still", "SKILL.md")), "with its installed tree in place");
  assert.match(stillHeld.lastError, /could not (read|clone)/);

  // Once the source is fixed, the user can Update again and take the new version.
  editRemoteFile(gitRoot, "acme", "broken", "tdd/SKILL.md", null);
  const retried = await api("POST", `/api/skill-sources/${added.json.id}/update`, {});
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.equal(retried.json.commit, headOf("acme", "broken"), "the source takes the head its ref names now");
  assert.deepEqual(skillNames(retried.json), ["good-skill"]);
  assert.equal(retried.json.lastError, null, "an Update that gets through clears the failure the source stated");
});

test("two Update clicks on one source at once start one clone, and Remove waits for a clone in flight", async () => {
  await waitReady();
  const { config } = await import("../src/config.ts");
  seedBareRepo(gitRoot, "acme", "double", { "one/SKILL.md": skillDoc("double-skill", "One skill.") });
  const url = gitSourceUrl("acme", "double");
  const added = await api("POST", "/api/skill-sources", { url });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  editRemoteFile(gitRoot, "acme", "double", "two/SKILL.md", skillDoc("second-skill", "The skill the second commit adds."));
  const head = headOf("acme", "double");

  const both = await Promise.all([
    api("POST", `/api/skill-sources/${added.json.id}/update`, {}),
    api("POST", `/api/skill-sources/${added.json.id}/update`, {}),
    api("DELETE", `/api/skill-sources/${added.json.id}`),
  ]);
  const answers = both.map((r) => [r.status, r.json?.error ?? ""]);
  assert.equal(both.filter((r) => r.status === 200).length, 1, `one clone started: ${JSON.stringify(answers)}`);
  assert.equal(both.filter((r) => r.status === 409).length, 2, `the other two wait: ${JSON.stringify(answers)}`);
  for (const r of both.filter((x) => x.status === 409)) assert.match(r.json.error, /already runs/, JSON.stringify(r.json));
  assert.equal(both[2].status, 409, "Remove does not go under a clone in flight");

  // The one clone that ran installed the new version whole: no half-written place, no second clone.
  const listed = await sourceAt(url);
  assert.equal(listed.commit, head);
  assert.deepEqual(skillNames(listed), ["double-skill", "second-skill"]);
  assert.ok(fs.existsSync(path.join(config.installedSkillsDir, listed.id, "two", "SKILL.md")), "the installed directory is the new version's");
  assert.deepEqual(await strayInstalls(), [], "no temporary clone and no stashed version is left on disk");
});

test("Update carries the setting the user changed on an installed skill while its clone ran", async () => {
  await waitReady();
  const url = gitSourceUrl("acme", "midclone");
  seedBareRepo(gitRoot, "acme", "midclone", { "one/SKILL.md": skillDoc("mid-skill", "One skill of the source.") });
  const added = await api("POST", "/api/skill-sources", { url });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const skillId = added.json.skills[0].id;
  assert.deepEqual(added.json.skills[0].attach, [], "the skill starts attached to no place");
  editRemoteFile(gitRoot, "acme", "midclone", "two/SKILL.md", skillDoc("later-skill", "The skill the new version adds."));

  // The user ticks two places for one installed skill while the Update is cloning. The Update reads what
  // the library holds when its clone is done, so the new version carries the setting the user just made.
  const [updated, patched] = await Promise.all([
    api("POST", `/api/skill-sources/${added.json.id}/update`, {}),
    api("PATCH", `/api/skill-sources/${added.json.id}/skills/${skillId}`, { attach: ["implement", "review"] }),
  ]);
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.equal(updated.status, 200, JSON.stringify(updated.json));

  const held = await sourceAt(url);
  assert.deepEqual(skillNames(held), ["later-skill", "mid-skill"], "the new version is installed");
  const carried = held.skills.find((s: any) => s.name === "mid-skill");
  assert.equal(carried.id, skillId, "and the skill the library already had keeps its identity");
  assert.deepEqual(carried.attach, ["implement", "review"], "with the attach points the user set during the clone");
});
