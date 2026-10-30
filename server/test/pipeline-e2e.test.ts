/**
 * End-to-end pipeline: setup → grill-with-docs → to-spec → to-tickets → tdd per ticket (fresh pi run
 * each) → one code-review run → done, with a real `pi --mode rpc` against the scripted mock model.
 * Skips when the pi CLI isn't available.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-pipe-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "pipeline-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");

let mock: Awaited<ReturnType<typeof startMockLlm>>;
let mgr: any;
let db: any;
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Answer whatever decision card the session is waiting on with its first option. */
async function answerNext(id: string, expect: RegExp) {
  const req = await waitFor(() => mgr.summary(id).pending[0]);
  assert.match(req.title, expect);
  mgr.respond(id, req.id, { value: req.options[0] });
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

  // Skills the pipeline invokes; pi expands /skill:name from these.
  for (const name of ["grill-with-docs", "to-spec", "to-tickets", "tdd", "code-review", "setup-matt-pocock-skills"]) {
    fs.mkdirSync(path.join(config.skillsDir, name), { recursive: true });
    fs.writeFileSync(path.join(config.skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} test skill\n---\n${name} body\n`);
  }

  const seed = path.join(tmp, "seed");
  fs.mkdirSync(seed);
  sh(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "README.md"), "# demo\n");
  sh(seed, "add", ".");
  sh(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  sh(tmp, "clone", "-q", "--bare", seed, path.join(tmp, "remote.git"));
  const clone = path.join(config.reposDir, "me", "demo");
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  sh(tmp, "clone", "-q", path.join(tmp, "remote.git"), clone);
  db.prepare("INSERT INTO repos (id, owner, name, default_branch, private, added_at) VALUES ('me/demo','me','demo','main',1,0)").run();

  mgr = new SessionManager(db, new SecretStore(db, process.env.WORKBENCH_MASTER_KEY!), async () => ({
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

test("a pipeline session grills, writes a spec and tickets, implements them one fresh run at a time, then reviews", { skip: !hasPi && "pi CLI not found" }, async () => {
  const s = await mgr.create({ repoId: "me/demo", title: "Greeting", prompt: "add a greeting" });
  assert.equal(s.mode, "pipeline");
  assert.equal(s.phase, "setup");

  // Setup commits its marker, then the task goes to grill-me.
  await waitFor(() => mgr.summary(s.id).phase === "grill");
  await answerNext(s.id, /shared understanding/);
  await waitFor(() => mgr.summary(s.id).phase === "spec");
  assert.match(mgr.summary(s.id).grillSummary, /hello\.txt/);

  // to-spec checks the seams, publishes, saves the spec.
  await answerNext(s.id, /seam/);
  await waitFor(() => mgr.summary(s.id).phase === "tickets");
  assert.equal(mgr.summary(s.id).specRef, ".scratch/greeting/spec.md");
  assert.match(mgr.summary(s.id).spec, /hello\.txt says Hello/);

  // to-tickets asks for approval, publishes, records.
  await answerNext(s.id, /Approve/);
  await waitFor(() => mgr.summary(s.id).phase === "implement");
  const sum = await waitFor(() => {
    const x = mgr.summary(s.id);
    return x.attention ? x : undefined;
  });

  // Tickets 1 and 2 finish; 3 reports blocked and the pipeline stops for the user.
  assert.deepEqual(
    sum.tickets.map((t: any) => `${t.num}:${t.status}`),
    ["1:done", "2:done", "3:blocked"],
  );
  assert.match(sum.attention, /Ticket #3 is blocked: Needs a docs folder decision/);
  assert.equal(sum.tickets[0].note, "Ticket 1 appended to work.txt");
  // Each ticket ran in its own pi conversation, listed for the viewer.
  assert.deepEqual(sum.runs.map((r: any) => r.label), ["Plan", "#1 Write hello.txt", "#2 Add a test", "#3 Add docs"]);
  assert.equal(sum.activeRun, sum.tickets[2].runId);

  // The second ticket's fresh context carried the spec and ticket 1's note.
  const t2 = mock.requests.find((r) => JSON.stringify(r.messages).includes("Ticket #2: Add a test"));
  const t2Text = JSON.stringify(t2.messages);
  assert.match(t2Text, /<skill name=\\"tdd\\"/);
  assert.match(t2Text, /hello.txt says Hello/);
  assert.match(t2Text, /#1 Write hello.txt: Ticket 1 appended to work.txt/);
  assert.ok(!t2Text.includes("shared understanding"), "ticket runs start without the grill conversation");

  // The past run is still readable.
  const first = mgr.runTranscript(s.id, sum.tickets[0].runId);
  assert.ok(first.messages.some((m: any) => m.role === "toolResult" && m.toolName === "finish_ticket"));

  // Skip the blocked ticket: one fresh code-review run covers the whole branch, then the pipeline
  // finishes and returns to the plan conversation.
  await mgr.pipelineAction(s.id, "skip");
  assert.equal(mgr.summary(s.id).phase, "review");
  await waitFor(() => mgr.summary(s.id).phase === "done");
  const done = mgr.summary(s.id);
  assert.equal(done.attention, null);
  assert.equal(done.activeRun, s.id);
  assert.equal(done.runs[done.runs.length - 1].label, "Review");
  const review = mock.requests.find((r) => JSON.stringify(r.messages).includes('<skill name=\\"code-review\\"'));
  assert.match(JSON.stringify(review.messages), /since origin\/main/);
  assert.ok(!JSON.stringify(review.messages).includes("Ticket #3: Add docs"), "the review run starts fresh");
  const row = db.prepare("SELECT worktree FROM sessions WHERE id = ?").get(s.id);
  assert.deepEqual(sh(row.worktree, "log", "--format=%s", "-4").trim().split("\n"), ["Fix review findings", "Ticket 3", "Ticket 2", "Ticket 1"]);
});

test("Direct mode skips the pipeline", { skip: !hasPi && "pi CLI not found" }, async () => {
  const s = await mgr.create({ repoId: "me/demo", title: "Quick", prompt: "hello there", mode: "direct" });
  // origin/main has no setup commit yet (the first session never pushed), so setup runs first.
  assert.equal(s.phase, "setup");
  await waitFor(() => mgr.summary(s.id).phase === "direct");
  // Wait for the reply to the held task itself, not a momentary idle between setup and that turn.
  await waitFor(async () => {
    const tr = (await mgr.snapshot(s.id)).transcript;
    return !tr.busy && tr.messages.some((m: any) => m.role === "assistant" && JSON.stringify(m.content).includes("Hello from the mock"));
  });
  assert.equal(mgr.tickets(s.id).length, 0);

  // Skills written for Claude Code call a "Skill" tool; the extension serves it from the skill dirs.
  await mgr.send(s.id, "load skill please");
  const t = await waitFor(async () => {
    const tr = (await mgr.snapshot(s.id)).transcript;
    return tr.messages.find((m: any) => m.role === "toolResult" && m.toolName === "Skill");
  });
  assert.equal(t.isError, false);
  assert.match(JSON.stringify(t.content), /<skill name=\\"tdd\\"[\s\S]*tdd body/);
  assert.equal(mgr.summary(s.id).runs.length, 1);
});
