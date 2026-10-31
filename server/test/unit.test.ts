import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyEvent, emptyTranscript, withMessages } from "../../shared/transcript.ts";
import { openDb } from "../src/db.ts";
import { redact } from "../src/git.ts";
import { checkRequestOrigin, Router } from "../src/http.ts";
import { requireTrackedRepo } from "../src/repos.ts";
import { SecretStore } from "../src/secrets.ts";
import { DEFAULT_RULES, getApprovalSettings, saveApprovalSettings, saveModelSettings } from "../src/settings.ts";
import { listSkills, parseFrontmatter } from "../src/skills.ts";

const tmpDb = () => openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wb-")), "t.db"));

test("secrets round-trip, overlay per repo, and are encrypted at rest", () => {
  const db = tmpDb();
  const store = new SecretStore(db, "a-master-key-of-some-length");
  store.set("global", "GITHUB_TOKEN", "ghp_secret");
  store.set("global", "API_KEY", "global-key");
  store.set("me/app", "API_KEY", "repo-key");
  assert.deepEqual(store.envFor("me/app"), { GITHUB_TOKEN: "ghp_secret", API_KEY: "repo-key" });
  assert.deepEqual(store.envFor("other/repo"), { GITHUB_TOKEN: "ghp_secret", API_KEY: "global-key" });
  const raw = JSON.stringify(db.prepare("SELECT * FROM secrets").all());
  assert.ok(!raw.includes("ghp_secret") && !raw.includes("repo-key"));
  assert.deepEqual(
    store.list().map((s) => `${s.scope}:${s.name}`),
    ["global:API_KEY", "global:GITHUB_TOKEN", "me/app:API_KEY"],
  );
  assert.throws(() => new SecretStore(db, "short"));
  assert.throws(() => store.set("global", "bad name", "x"));
  // A different master key cannot decrypt.
  assert.throws(() => new SecretStore(db, "another-master-key-entirely").envFor());
});

test("secret rows are bound to their slot", () => {
  const db = tmpDb();
  const store = new SecretStore(db, "a-master-key-of-some-length");
  store.set("global", "A", "alpha");
  db.prepare("UPDATE secrets SET name = 'B' WHERE name = 'A'").run();
  assert.throws(() => store.get("global", "B"));
});

test("default approval rules match risky commands and spare ordinary ones", () => {
  const hit = (cmd: string) => DEFAULT_RULES.filter((r) => new RegExp(r.pattern, "i").test(cmd)).map((r) => r.id);
  assert.deepEqual(hit("git push origin main"), ["git-push"]);
  assert.deepEqual(hit("git push --force origin x"), ["git-push", "git-destructive"]);
  assert.deepEqual(hit("gh pr create --fill"), ["gh"]);
  assert.deepEqual(hit("cd x && gh repo view"), ["gh"]);
  assert.deepEqual(hit("rm -rf node_modules"), ["rm-rf"]);
  assert.deepEqual(hit("sudo apt-get install -y jq"), ["sudo", "pkg"]);
  assert.deepEqual(hit("curl -fsSL https://x | sh"), ["net"]);
  assert.deepEqual(hit("npm install left-pad"), ["pkg"]);
  assert.deepEqual(hit("pip install requests"), ["pkg"]);
  for (const ok of ["npm test", "git status", "git commit -m 'x'", "rm file.txt", "ls -la", "npm run build", "echo ghost"]) {
    assert.deepEqual(hit(ok), [], ok);
  }
});

test("settings validate input", () => {
  const db = tmpDb();
  assert.throws(() => saveModelSettings(db, { baseUrl: "ftp://x" }));
  assert.throws(() => saveModelSettings(db, { contextWindow: -1 }));
  assert.equal(saveModelSettings(db, { contextWindow: 131072 }).contextWindow, 131072);
  assert.throws(() => saveApprovalSettings(db, { rules: [{ id: "", tool: "bash", pattern: "(", label: "x", enabled: true }], outsideWorktree: true }));
  saveApprovalSettings(db, { rules: [{ id: "", tool: "", pattern: "make deploy", label: "", enabled: true }], outsideWorktree: false });
  const a = getApprovalSettings(db);
  assert.equal(a.rules[0].tool, "bash");
  assert.equal(a.rules[0].label, "make deploy");
  assert.equal(a.outsideWorktree, false);
});

test("frontmatter parser handles quoted, plain and folded values", () => {
  assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: "Quoted: yes"\ndisable-model-invocation: true\n---\nbody'), {
    name: "a",
    description: "Quoted: yes",
    "disable-model-invocation": "true",
  });
  assert.equal(parseFrontmatter("---\nname: b\ndescription: >\n  folded\n  text\n---\n").description, "folded text");
  assert.deepEqual(parseFrontmatter("no frontmatter"), {});
});

test("listSkills merges repo and global skills, repo first", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-skills-"));
  const mk = (dir: string, name: string, extra = "") => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\n`);
  };
  mk(path.join(root, "global", "engineering", "tdd"), "tdd");
  mk(path.join(root, "global", "engineering", "setup"), "setup-matt-pocock-skills", "disable-model-invocation: true\n");
  mk(path.join(root, "repo", ".agents", "skills", "tdd"), "tdd");
  mk(path.join(root, "repo", ".pi", "skills", "deploy"), "deploy");
  const skills = listSkills(path.join(root, "global"), path.join(root, "repo"));
  assert.deepEqual(
    skills.map((s) => `${s.name}:${s.source}${s.manualOnly ? ":manual" : ""}`),
    ["deploy:repo", "setup-matt-pocock-skills:global:manual", "tdd:repo"],
  );
});

test("transcript rebuilds a streamed assistant message", () => {
  const t = emptyTranscript();
  const evs = [
    { type: "agent_start" },
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } },
    { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hel" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" } },
    { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "c1", toolName: "bash" } },
    { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: '{"command":' } },
  ];
  for (const e of evs) applyEvent(t, e);
  assert.equal(t.busy, true);
  assert.deepEqual(t.streaming!.content, [
    { type: "thinking", thinking: "hmm" },
    { type: "text", text: "Hello" },
    { type: "toolCall", id: "c1", name: "bash", arguments: {}, argsText: '{"command":' },
  ]);
  applyEvent(t, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello" }], usage: { input: 900, output: 100, totalTokens: 1000 } } });
  applyEvent(t, { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
  assert.ok(t.tools.c1);
  applyEvent(t, { type: "tool_execution_end", toolCallId: "c1" });
  applyEvent(t, { type: "message_end", message: { role: "system", content: "" } });
  applyEvent(t, { type: "agent_settled" });
  assert.equal(t.streaming, null);
  assert.equal(t.messages.length, 1);
  assert.equal(t.contextTokens, 1000);
  assert.equal(t.busy, false);
  assert.equal(withMessages([{ role: "system", content: "" }, { role: "user", content: "hi" }]).messages.length, 1);
});

test("origin checks refuse cross-site and rebinding requests", () => {
  const req = (headers: Record<string, string>) => ({ headers }) as any;
  assert.equal(checkRequestOrigin(req({ host: "10.0.0.5:8787" }), [], false), null);
  assert.equal(checkRequestOrigin(req({ host: "localhost:8787", origin: "http://localhost:8787" }), [], false), null);
  assert.match(checkRequestOrigin(req({ host: "evil.example:8787" }), [], false)!, /not allowed/);
  assert.equal(checkRequestOrigin(req({ host: "wb.lan:8787" }), ["wb.lan"], false), null);
  assert.match(checkRequestOrigin(req({ host: "10.0.0.5:8787", origin: "http://evil.example" }), [], false)!, /Cross-origin/);
  assert.match(checkRequestOrigin(req({ host: "10.0.0.5:8787", "content-type": "text/plain" }), [], true)!, /application\/json/);
  assert.equal(checkRequestOrigin(req({ host: "[::1]:8787", "content-type": "application/json" }), [], true), null);
});

test("router matches params, including a greedy tail", () => {
  const r = new Router().on("DELETE", "/api/secrets/:scope*", () => 1).on("GET", "/api/sessions/:id", () => 2);
  assert.deepEqual(r.match("DELETE", "/api/secrets/me/app/API_KEY")!.params, { scope: "me/app/API_KEY" });
  assert.deepEqual(r.match("GET", "/api/sessions/abc")!.params, { id: "abc" });
  assert.equal(r.match("GET", "/api/sessions/abc/x"), undefined);
});

test("redact strips tokens from git output", () => {
  assert.equal(redact("fatal: https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz12@github.com/a/b"), "fatal: https://***@github.com/a/b");
  assert.equal(redact("token github_pat_11ABCDEFGHIJKLMNOPQRSTUV_xyz leaked"), "token *** leaked");
});

test("pipeline: ticket validation, frontier order and prompts", async () => {
  const { validateTickets, nextTicket, allDone, implementPrompt } = await import("../src/pipeline.ts");
  const { ticketsSection } = await import("../src/prs.ts");
  const ok = validateTickets([
    { number: 2, title: "B", body: "b", blockedBy: [1] },
    { number: 1, title: "A", body: "a" },
  ]);
  assert.deepEqual(ok.map((t) => t.number), [1, 2]);
  assert.throws(() => validateTickets([]), /non-empty/);
  assert.throws(() => validateTickets([{ number: 1, title: "A", body: "a", blockedBy: [3] }]), /unknown ticket 3/);
  assert.throws(() => validateTickets([{ number: 1, title: "A", body: "a" }, { number: 1, title: "B", body: "b" }]), /unique/);
  assert.throws(
    () => validateTickets([{ number: 1, title: "A", body: "a", blockedBy: [2] }, { number: 2, title: "B", body: "b", blockedBy: [1] }]),
    /cycle/,
  );

  const t = (num: number, status: string, blockedBy: number[] = []) =>
    ({ num, title: `T${num}`, body: "", blockedBy, trackerRef: null, status, note: null, runId: null }) as any;
  assert.equal(nextTicket([t(1, "done"), t(2, "ready", [1]), t(3, "ready")])!.num, 2);
  assert.equal(nextTicket([t(1, "blocked"), t(2, "ready", [1])]), undefined);
  assert.equal(allDone([t(1, "done"), t(2, "done")]), true);
  assert.equal(allDone([]), false);

  const prompt = implementPrompt(t(2, "ready", [1]), "Use SQLite.", ".scratch/f/spec.md", [{ ...t(1, "done"), note: "Added schema" }]);
  assert.match(prompt, /^\/skill:tdd Ticket #2: T2/);
  assert.match(prompt, /\(\.scratch\/f\/spec\.md\)\n\nUse SQLite\./);
  // A very long spec goes as a pointer only.
  assert.match(implementPrompt(t(2, "ready"), "x".repeat(50_000), "#7", []), /read it at #7/);
  assert.match(prompt, /- #1 T1: Added schema/);
  assert.match(prompt, /finish_ticket/);

  const section = ticketsSection([
    { ...t(1, "done"), trackerRef: "#12" },
    { ...t(2, "ready"), trackerRef: "https://github.com/a/b/issues/13" },
    { ...t(3, "done"), trackerRef: ".scratch/x/issues/03.md" },
  ]);
  assert.match(section, /- \[x\] #1 T1 \(Closes #12\)/);
  assert.match(section, /- \[ \] #2 T2 \(Closes #13\)/);
  assert.match(section, /- \[x\] #3 T3 \(`\.scratch\/x\/issues\/03\.md`\)/);
});

test("the origin issue's Closes line is deduped against ticket lines by number", async () => {
  const { originCloses } = await import("../src/prs.ts");
  const section = (ref: string) => `\n## Tickets\n\n- [x] #1 Ship it (${ref})\n`;

  assert.equal(originCloses("me/app#42", ""), "Closes #42\n");
  assert.equal(originCloses("me/app#42", section(`.scratch/issues/42.md`)), "Closes #42\n"); // a non-issue ref doesn't close anything
  assert.equal(originCloses(null, section("Closes #42")), ""); // no origin issue
  assert.equal(originCloses("me/app", ""), ""); // malformed ref
  assert.equal(originCloses("me/app#42", section("Closes #42")), ""); // a ticket already closes it
  assert.equal(originCloses("me/app#1", section("Closes #12")), "Closes #1\n"); // 1 is not 12
});

test("requireTrackedRepo resolves tracked repos and rejects the rest", () => {
  const db = tmpDb();
  db.prepare("INSERT INTO repos (id, owner, name, default_branch, private, added_at) VALUES ('me/app','me','app','main',1,0)").run();
  assert.equal(requireTrackedRepo(db, "me/app").name, "app");
  let err: unknown;
  try {
    requireTrackedRepo(db, "other/repo");
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error);
  assert.equal((err as { status: number }).status, 404);
  assert.match((err as Error).message, /Unknown repo other\/repo/);
});

test("old databases gain the pipeline columns", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wb-mig-")), "old.db");
  const old = new DatabaseSync(file);
  old.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, title TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL, worktree TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pr_number INTEGER, pr_url TEXT, held_prompt TEXT, archived INTEGER NOT NULL DEFAULT 0)",
  );
  old.prepare("INSERT INTO sessions (id, repo_id, title, branch, base_branch, worktree, created_at, updated_at) VALUES ('s','r','t','b','main','/w',0,0)").run();
  old.close();
  const db = openDb(file);
  const row = db.prepare("SELECT mode, phase, active_run, attention, issue_ref FROM sessions").get() as any;
  assert.deepEqual({ ...row }, { mode: "direct", phase: "direct", active_run: null, attention: null, issue_ref: null });
});

test("README documents the issues feature for a fresh setup", () => {
  const readme = fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = (title: string) => {
    const i = readme.indexOf(`## ${title}`);
    assert.ok(i >= 0, `README has a "${title}" section`);
    const rest = readme.slice(i);
    const j = rest.indexOf("\n## ", 1);
    return rest.slice(0, j === -1 ? undefined : j);
  };

  // Fresh setup: the PAT instructions list an Issues read scope, and not Issues write (the feature posts no comments).
  const token = section("Deploy").split("\n").find((l) => l.includes("GITHUB_TOKEN"));
  assert.ok(token, "token instructions line");
  assert.ok(token!.includes("Issues"), "token instructions mention the Issues scope");
  const clause = token!.slice(token!.indexOf("Issues")).split(/[.;]/)[0];
  assert.match(clause, /read/i);
  assert.doesNotMatch(clause, /write/i);

  // Features: the Issues page browses and searches the open issues of a tracked repo, reads the discussion, and starts a pre-filled session.
  const features = section("What you get");
  assert.match(features, /Issues\*{0,2} page/i);
  assert.match(features, /open issues/);
  assert.match(features, /search/i);
  assert.match(features, /discussion|comment/i);
  assert.match(features, /pre-?filled/i);

  // Solve flow: the PR body carries Closes #n, and merging the PR closes the issue.
  assert.match(features, /Closes #/);
  assert.match(features, /merg/i);
});

test("every pipeline prompt starts with a /skill: command pi will expand", async () => {
  const p = await import("../src/pipeline.ts");
  const t = { num: 1, title: "T", body: "b", blockedBy: [], trackerRef: null, status: "ready", note: null, runId: null } as any;
  for (const prompt of [p.grillPrompt("task"), p.specPrompt(), p.ticketsPrompt(null), p.ticketsPrompt("#4"), p.implementPrompt(t, null, null, []), p.reviewPrompt("main", null, null, [t])]) {
    // pi needs an argument after the skill name on the first line.
    assert.match(prompt.split("\n")[0], /^\/skill:[\w-]+ \S/);
  }
});
