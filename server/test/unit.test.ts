import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyEvent, emptyTranscript, withMessages } from "../../shared/transcript.ts";
import { openDb } from "../src/db.ts";
import { redact } from "../src/git.ts";
import { checkRequestOrigin, Router } from "../src/http.ts";
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
