/**
 * The Repos page's agent-skills setup state over HTTP: each repo row states its recorded setup
 * state, Run setup starts a repo's setup session, and that session's commit lands on the default
 * branch. Drives the real server (main.ts) on an ephemeral port, with a real `pi --mode rpc`
 * against the scripted mock model and the mock GitHub. Skips when the pi CLI isn't available.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { startMockGitHub } from "./mock-github.ts";
import { startMockLlm } from "./mock-llm.ts";

const piBin = process.env.PI_BIN ?? "pi";
const hasPi = spawnSync(piBin, ["--version"]).status === 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-reposetup-"));
const remotes = path.join(tmp, "remotes");
fs.mkdirSync(remotes);
const dataDir = path.join(tmp, "data");
process.env.DATA_DIR = dataDir;
process.env.WORKBENCH_MASTER_KEY = "reposetup-master-key-01234564789";
process.env.SKILLS_DIR = path.join(tmp, "skills");
process.env.HOME = path.join(tmp, "agent-home");
process.env.GITHUB_CLONE_BASE = `file://${remotes}`;
process.env.PI_BIN = piBin;
process.env.PI_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-extension", "workbench.ts");

for (const name of ["grill-with-docs", "to-spec", "to-tickets", "tdd", "code-review", "setup-matt-pocock-skills"]) {
  fs.mkdirSync(path.join(process.env.SKILLS_DIR, name), { recursive: true });
  fs.writeFileSync(path.join(process.env.SKILLS_DIR, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} test skill\n---\n${name} body\n`);
}

const mock = await startMockLlm();
const gh = await startMockGitHub(remotes);
process.env.GITHUB_API_URL = gh.url;

const freePort = await new Promise<number>((res, rej) => {
  const srv = http.createServer();
  srv.listen(0, "127.0.0.1", () => {
    const p = (srv.address() as { port: number }).port;
    srv.close(() => res(p));
  });
  srv.on("error", rej);
});
process.env.PORT = String(freePort);
process.env.HOST = "127.0.0.1";
const base = `http://127.0.0.1:${freePort}`;

if (hasPi) await import("../src/main.ts");

const api = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 90_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
const remote = (owner: string, name: string) => path.join(remotes, owner, `${name}.git`);
const cloneDir = (id: string) => path.join(dataDir, "repos", ...id.split("/"));
const db = () => {
  const d = new DatabaseSync(path.join(dataDir, "workbench.db"));
  return d;
};

/** origin/main of the mock's bare repo carries the setup marker file. */
const seedMarker = (owner: string, name: string) => {
  const work = fs.mkdtempSync(path.join(tmp, "seed-"));
  sh(tmp, "clone", "-q", remote(owner, name), work);
  fs.mkdirSync(path.join(work, "docs", "agents"), { recursive: true });
  fs.writeFileSync(path.join(work, "docs", "agents", "issue-tracker.md"), "# seed tracker\n");
  sh(work, "add", ".");
  sh(work, "-c", "user.name=seed", "-c", "user.email=seed@x", "commit", "-qm", "Set up agent skills (setup-matt-pocock-skills)");
  sh(work, "push", "-q", "origin", "main");
  fs.rmSync(work, { recursive: true, force: true });
};
const remoteHasMarker = (owner: string, name: string) => {
  try {
    sh(remote(owner, name), "cat-file", "-e", "main:docs/agents/issue-tracker.md");
    return true;
  } catch {
    return false;
  }
};

const repoRow = (id: string) => {
  const d = db();
  try {
    return d.prepare("SELECT * FROM repos WHERE id = ?").get(id) as any;
  } finally {
    d.close();
  }
};
const setupState = async (id: string) => (await api("GET", "/api/repos")).json.find((r: any) => r.id === id)?.setup as string | undefined;
const board = async (repo: string) => {
  const r = await api("GET", `/api/board?repo=${repo}`);
  assert.equal(r.status, 200);
  return r.json.cards as any[];
};

after(async () => {
  await mock.close();
  await gh.close();
  if (hasPi) process.kill(process.pid, "SIGTERM");
});

test("a repo added without the setup files reads as not set up, and the state is recorded", { skip: !hasPi && "pi CLI not found" }, async () => {
  await waitFor(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok);
  assert.equal((await api("PUT", "/api/secrets", { scope: "global", name: "GITHUB_TOKEN", value: "ghp_test" })).status, 200);
  assert.equal((await api("PUT", "/api/settings/model", { baseUrl: mock.url })).status, 200);

  gh.createBare("kevin", "plainrepo");
  const added = await api("POST", "/api/repos", { id: "kevin/plainrepo" });
  assert.equal(added.status, 200);
  assert.equal(added.json.setup, "not_set_up");
  assert.equal(repoRow("kevin/plainrepo").setup_state, "not_set_up");
});

test("a repo added with the setup files on its default branch reads as set up", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "setrepo");
  seedMarker("kevin", "setrepo");
  const added = await api("POST", "/api/repos", { id: "kevin/setrepo" });
  assert.equal(added.json.setup, "set_up");
  assert.equal(repoRow("kevin/setrepo").setup_state, "set_up");
});

test("the recorded state answers later reads, so no second git check runs", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "recorded");
  seedMarker("kevin", "recorded");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/recorded" })).json.setup, "set_up");

  // The clone goes: the read answers from the record, not from git.
  fs.rmSync(cloneDir("kevin/recorded"), { recursive: true, force: true });
  assert.equal(await setupState("kevin/recorded"), "set_up");
});

test("a repo added before states were recorded: the first state read records what it found", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "legacy");
  // A row from before this change, with its clone on disk: no recorded state.
  const d = db();
  d.prepare("INSERT INTO repos (id, owner, name, default_branch, private, added_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "kevin/legacy",
    "kevin",
    "legacy",
    "main",
    1,
    Date.now(),
  );
  d.close();
  await api("POST", "/api/repos", { id: "kevin/legacy" });

  assert.equal(await setupState("kevin/legacy"), "not_set_up");
  assert.equal(repoRow("kevin/legacy").setup_state, "not_set_up");

  // The clone is gone again: the record answers, so no git check runs.
  fs.rmSync(cloneDir("kevin/legacy"), { recursive: true, force: true });
  assert.equal(await setupState("kevin/legacy"), "not_set_up");
});

test("Run setup starts the repo's setup session, and a second Run setup is refused while it works", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "runsetup");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/runsetup" })).json.setup, "not_set_up");

  const started = await api("POST", "/api/repos/kevin/runsetup/setup", {});
  assert.equal(started.status, 200);
  assert.equal(started.json.title, "Set up agent skills");
  assert.equal(started.json.phase, "setup");
  assert.equal(repoRow("kevin/runsetup").setup_session, started.json.id);

  // The page states what the setup session is doing right now.
  assert.equal(await setupState("kevin/runsetup"), "in_progress");

  // Its card is on the repo's board while its run works.
  const card = await waitFor(async () => {
    const c = (await board("kevin/runsetup")).find((x) => x.id === started.json.id);
    return c && c.column === "todo" ? c : undefined;
  });
  assert.equal(card.title, "Set up agent skills");

  const again = await api("POST", "/api/repos/kevin/runsetup/setup", {});
  assert.equal(again.status, 409);
  assert.match(again.json.error, /setup/i);
});

test("Run setup is refused for a repo the workbench recorded as set up", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "alreadysetup");
  seedMarker("kevin", "alreadysetup");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/alreadysetup" })).json.setup, "set_up");

  const refused = await api("POST", "/api/repos/kevin/alreadysetup/setup", {});
  assert.equal(refused.status, 409);
  assert.equal(await setupState("kevin/alreadysetup"), "set_up");
});

test("the setup session lands its commit on the repo default branch, states the repo set up, and its card is Done", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "lands");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/lands" })).json.setup, "not_set_up");
  const started = await api("POST", "/api/repos/kevin/lands/setup", {});
  assert.equal(started.status, 200);

  // The commit is on origin/main, not only on the session branch, and no PR was opened.
  await waitFor(() => remoteHasMarker("kevin", "lands"));
  assert.equal(gh.pulls.filter((p: any) => p.head?.ref === started.json.branch).length, 0);
  assert.equal(started.json.prNumber, null);

  const settled = await waitFor(async () => {
    const c = (await board("kevin/lands")).find((x) => x.id === started.json.id);
    return c && c.column === "done" ? c : undefined;
  });
  assert.equal(settled.attention, null);
  assert.equal(await setupState("kevin/lands"), "set_up");
  assert.equal(repoRow("kevin/lands").setup_state, "set_up");
  assert.equal(repoRow("kevin/lands").setup_session, null);
});

test("a repo the workbench recorded as set up starts its sessions past setup", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "pastsetup");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/pastsetup" })).json.setup, "not_set_up");
  assert.equal((await api("POST", "/api/repos/kevin/pastsetup/setup", {})).status, 200);
  await waitFor(() => (async () => (await board("kevin/pastsetup")).some((c) => c.column === "done"))());

  // The default branch loses the marker file by hand. The recorded state decides: the state is
  // recorded once, and a repo the workbench set up never runs the setup again.
  const work = fs.mkdtempSync(path.join(tmp, "unseed-"));
  sh(tmp, "clone", "-q", remote("kevin", "pastsetup"), work);
  sh(work, "rm", "docs/agents/issue-tracker.md");
  sh(work, "-c", "user.name=hand", "-c", "user.email=hand@x", "commit", "-qam", "Remove the marker");
  sh(work, "push", "-q", "origin", "main");
  fs.rmSync(work, { recursive: true, force: true });
  assert.equal(remoteHasMarker("kevin", "pastsetup"), false);

  const created = await api("POST", "/api/sessions", { repoId: "kevin/pastsetup", title: "Next card", prompt: "Add a feature" });
  assert.equal(created.status, 200);
  assert.equal(created.json.phase, "grill", "no setup run for a repo that is set up");
  assert.equal(created.json.setupRunning, false);
});

test("a setup run that cannot land its commit on the default branch leaves the repo not set up and flags its card", { skip: !hasPi && "pi CLI not found" }, async () => {
  gh.createBare("kevin", "conflicted");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/conflicted" })).json.setup, "not_set_up");
  const started = await api("POST", "/api/repos/kevin/conflicted/setup", {});
  assert.equal(started.status, 200);

  // The default branch moves with its own version of the file the setup commit adds: the merge conflicts.
  const work = fs.mkdtempSync(path.join(tmp, "move-"));
  sh(tmp, "clone", "-q", remote("kevin", "conflicted"), work);
  fs.mkdirSync(path.join(work, "docs", "agents"), { recursive: true });
  fs.writeFileSync(path.join(work, "docs", "agents", "issue-tracker.md"), "# written by hand\n");
  sh(work, "add", ".");
  sh(work, "-c", "user.name=hand", "-c", "user.email=hand@x", "commit", "-qm", "Hand-written tracker");
  sh(work, "push", "-q", "origin", "main");
  fs.rmSync(work, { recursive: true, force: true });

  const flagged = await waitFor(async () => {
    const c = (await board("kevin/conflicted")).find((x) => x.id === started.json.id);
    return c && c.attention ? c : undefined;
  });
  assert.equal(flagged.column, "todo");
  assert.match(flagged.attention, /main/);
  assert.equal(await setupState("kevin/conflicted"), "not_set_up");
  assert.equal(repoRow("kevin/conflicted").setup_session, null);

  // Run setup is available again.
  const again = await api("POST", "/api/repos/kevin/conflicted/setup", {});
  assert.equal(again.status, 200);
  assert.equal(again.json.id !== started.json.id, true);
});
