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
  const untidy = await api("POST", "/api/skill-sources", { url, subpath: "packages/" });
  assert.equal(untidy.status, 200);
  assert.deepEqual(skillNames(untidy.json), ["helper-style", "ui-style"]);
  // A subpath the source does not carry is a refusal that names it.
  const missing = await api("POST", "/api/skill-sources", { url, subpath: "does-not-exist" });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /no directory "does-not-exist"/);
  assert.equal((await api("GET", "/api/skill-sources")).json.length, before + 3, "a refusal installs nothing");
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
