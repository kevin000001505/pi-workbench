import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startMockJudge } from "./mock-judge.ts";
import { applyEvent, emptyTranscript, withMessages } from "../../shared/transcript.ts";
import { autoApproveView, configureAutoApprove, getAutoApproveSettings, judgePermission, localJudge, reviewPermission, saveAutoApproveKey, saveAutoApproveSettings, savedJudgeToken, savedReviewerKey, testJudge, transcriptExcerpt } from "../src/autoapprove.ts";
import { startMockLlm } from "./mock-llm.ts";
import { startMockReviewer } from "./mock-reviewer.ts";
import { waitsOnUser } from "../../shared/pending.ts";
import { openDb } from "../src/db.ts";
import { redact } from "../src/git.ts";
import { checkRequestOrigin, Router } from "../src/http.ts";
import { requireTrackedRepo } from "../src/repos.ts";
import { GLOBAL_SCOPE, assertUserScope, SecretStore, userSecrets } from "../src/secrets.ts";
import { DEFAULT_RULES, getApprovalSettings, getPipelineSettings, LLM_KEY_ENV, saveApprovalSettings, saveModelSettings, savePipelineSettings } from "../src/settings.ts";
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

test("setting several secrets writes all of them or none", () => {
  const db = tmpDb();
  const store = new SecretStore(db, "test-master-key-0123456789");
  store.setAll("global", [["A", "old-a"], ["B", "old-b"]]);
  // The second value fails mid-way (it cannot be encrypted), after the first row was written.
  assert.throws(() => store.setAll("global", [["A", "new-a"], ["B", 5 as any]]));
  assert.deepEqual(store.envFor(), { A: "old-a", B: "old-b" });
  store.setAll("global", [["A", "new-a"], ["B", "new-b"]]);
  assert.deepEqual(store.envFor(), { A: "new-a", B: "new-b" });
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
  assert.deepEqual(hit("ssh Media true"), ["ssh"]);
  assert.deepEqual(hit("ssh -o BatchMode=yes box true"), ["ssh"]);
  assert.deepEqual(hit("echo ssh"), []);
  assert.deepEqual(hit("scp media:file ."), []);
  assert.deepEqual(hit("cat /etc/ssh/ssh_config"), []);
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

  // The stop-rule limits: defaults, positive-integer validation, and partial saves.
  const s = getPipelineSettings(db);
  assert.deepEqual(s, { timeLimitMinutes: 30, repeatLimit: 3, toolCallLimit: 300 });
  for (const [k, v] of [
    ["timeLimitMinutes", 0],
    ["timeLimitMinutes", -5],
    ["timeLimitMinutes", 2.5],
    ["timeLimitMinutes", "30"],
    ["repeatLimit", 0],
    ["toolCallLimit", -1],
  ] as [keyof typeof s, unknown][]) {
    assert.throws(() => savePipelineSettings(db, { [k]: v } as any), /must be a positive integer/, `${k}=${String(v)}`);
  }
  const saved = savePipelineSettings(db, { timeLimitMinutes: 5 });
  assert.deepEqual(saved, { timeLimitMinutes: 5, repeatLimit: 3, toolCallLimit: 300 });
  assert.deepEqual(getPipelineSettings(db), saved, "a partial save keeps the other limits");
  assert.deepEqual(Object.keys(getPipelineSettings(db)).sort(), ["repeatLimit", "timeLimitMinutes", "toolCallLimit"]);
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
    { ...t(4, "done"), trackerRef: "14" },
    { ...t(5, "done"), trackerRef: "https://github.com/other/tracker/issues/15" },
  ], "a/b");
  assert.match(section, /- \[x\] #1 T1 \(Closes #12\)/);
  assert.match(section, /- \[ \] #2 T2 \(Closes #13\)/);
  assert.match(section, /- \[x\] #3 T3 \(`\.scratch\/x\/issues\/03\.md`\)/);
  assert.match(section, /- \[x\] #4 T4 \(Closes #14\)/);
  // Another repo's issue is named, not closed.
  assert.match(section, /- \[x\] #5 T5 \(`https:\/\/github\.com\/other\/tracker\/issues\/15`\)/);
});

test("ticketsFromSubIssues maps open sub-issues to tickets with remapped edges", async () => {
  const { ticketsFromSubIssues, validateTickets } = await import("../src/pipeline.ts");
  const out = ticketsFromSubIssues([
    { number: 40, title: "C", body: "c", url: "u40", blockedBy: [37, 38] },
    { number: 37, title: "A", body: "a", url: "u37", blockedBy: [] },
    { number: 38, title: "B", body: "b", url: "u38", blockedBy: [37] },
    { number: 41, title: "D", body: "  ", url: "u41", blockedBy: [99] }, // 99 is not a sub-issue; the body is empty
  ]);
  assert.deepEqual(out, [
    { number: 1, title: "A", body: "a", blockedBy: [], trackerRef: "37" },
    { number: 2, title: "B", body: "b", blockedBy: [1], trackerRef: "38" },
    { number: 3, title: "C", body: "c", blockedBy: [1, 2], trackerRef: "40" },
    { number: 4, title: "D", body: "No description for #41", blockedBy: [], trackerRef: "41" },
  ]);
  // The mapping keeps the graph valid, so validation passes.
  assert.deepEqual(validateTickets(out).map((t) => t.number), [1, 2, 3, 4]);
  // Cycles among the sub-issues are caught by the same validation.
  assert.throws(
    () =>
      validateTickets(
        ticketsFromSubIssues([
          { number: 1, title: "A", body: "a", url: "u1", blockedBy: [2] },
          { number: 2, title: "B", body: "b", url: "u2", blockedBy: [1] },
        ]),
      ),
    /cycle/,
  );
});

test("the origin issue's Closes line is deduped against ticket lines by number", async () => {
  const { originCloses } = await import("../src/prs.ts");
  const section = (ref: string) => `\n## Tickets\n\n- [x] #1 Ship it (${ref})\n`;

  assert.equal(originCloses("me/app", "me/app#42", ""), "Closes #42\n");
  assert.equal(originCloses("me/app", "me/app#42", section(`.scratch/issues/42.md`)), "Closes #42\n"); // a non-issue ref doesn't close anything
  assert.equal(originCloses("me/app", null, section("Closes #42")), ""); // no origin issue
  assert.equal(originCloses("me/app", "me/app", ""), ""); // malformed ref
  assert.equal(originCloses("me/app", "me/app#42", section("Closes #42")), ""); // a ticket already closes it
  assert.equal(originCloses("me/app", "me/app#1", section("Closes #12")), "Closes #1\n"); // 1 is not 12
  // The spec issue closes too: as `#n` or an issues URL, once, and not when a ticket or the origin already does.
  assert.equal(originCloses("me/app", null, "", "#12"), "Closes #12\n");
  assert.equal(originCloses("me/app", "me/app#42", "", "https://github.com/me/app/issues/12"), "Closes #42\nCloses #12\n");
  assert.equal(originCloses("me/app", "me/app#42", "", "https://github.com/me/app/issues/42"), "Closes #42\n");
  assert.equal(originCloses("me/app", null, section("Closes #12"), "#12"), "");
  assert.equal(originCloses("me/app", null, "", ".scratch/greeting/spec.md"), "");
  // A ref to another repo's issue closes nothing here: GitHub would read `Closes #12` as this repo's #12.
  assert.equal(originCloses("me/app", null, "", "other/tracker#12"), "");
  assert.equal(originCloses("me/app", null, "", "https://github.com/other/tracker/issues/12"), "");
  assert.equal(originCloses("me/app", "other/tracker#42", ""), "");
});

test("closedIssues closes only this repo's issues: a spec ref to another repo closes nothing here", async () => {
  const { closedIssues } = await import("../src/prs.ts");
  const row = (spec_ref: string | null, issue_ref: string | null = null) => ({ repo_id: "me/app", issue_ref, spec_ref }) as any;
  const ticket = (trackerRef: string) => ({ num: 1, title: "T", body: "", blockedBy: [], trackerRef, status: "done", note: null, runId: null }) as any;
  assert.deepEqual(closedIssues(row("me/app#40", "me/app#40"), [ticket("41")]), [41, 40]);
  assert.deepEqual(closedIssues(row("other/tracker#12"), []), []);
  assert.deepEqual(closedIssues(row("https://github.com/other/tracker/issues/12"), [ticket("https://github.com/other/tracker/issues/13")]), []);
});

test("issue refs: parseIssueRef reads every form; a card id maps back to its spec issue's number", async () => {
  const { parseIssueRef, unclaimedId, unclaimedNumber } = await import("../../shared/board.ts");
  assert.deepEqual(parseIssueRef("me/app#12"), { repo: "me/app", number: 12 });
  assert.deepEqual(parseIssueRef("https://github.com/me/app/issues/12/"), { repo: "me/app", number: 12 });
  assert.deepEqual(parseIssueRef("#12"), { repo: null, number: 12 });
  assert.deepEqual(parseIssueRef(" 12 "), { repo: null, number: 12 });
  assert.equal(parseIssueRef(".scratch/greeting/spec.md"), null);
  assert.equal(parseIssueRef(null), null);
  assert.equal(unclaimedNumber(unclaimedId(12)), 12);
  assert.equal(unclaimedNumber("3f2a-session-id"), null);
  assert.equal(unclaimedNumber("issue:x"), null);
});

test("unclaimed cards: plain and ticketed spec issues both sit in Issues; a sub-issue and a claimed issue are no cards", async () => {
  const { unclaimedCards, claimRefs, boardCards } = await import("../../shared/board.ts");
  const issues = [
    { number: 1, title: "A plain issue", url: "https://github.com/me/app/issues/1", openTickets: 0, hasParent: false },
    { number: 5, title: "A spec", url: "https://github.com/me/app/issues/5", openTickets: 2, hasParent: false },
    { number: 7, title: "A ticket sub-issue", url: "https://github.com/me/app/issues/7", openTickets: 1, hasParent: true },
    { number: 8, title: "Claimed by a card", url: "https://github.com/me/app/issues/8", openTickets: 3, hasParent: false },
  ];
  const sessions = [{ mode: "pipeline", phase: "ready", issueRef: "me/app#8", specRef: null }];
  const cards = unclaimedCards(issues, claimRefs(sessions), "me/app");
  assert.deepEqual(cards, [
    { id: "issue:1", title: "A plain issue", column: "issues", tickets: { done: 0, total: 0 }, attention: null, pr: null, specRef: "https://github.com/me/app/issues/1" },
    { id: "issue:5", title: "A spec", column: "issues", tickets: { done: 0, total: 2 }, attention: null, pr: null, specRef: "https://github.com/me/app/issues/5" },
  ]);
  // On the board, the plain card sits in Issues, before the spec's Issues card.
  assert.deepEqual(boardCards([], cards).map((c) => c.id), ["issue:1", "issue:5"]);
});

test("a direct session is a card in Doing: with no PR, and even while it sets up", async () => {
  const { cardOf, sessionColumn } = await import("../../shared/board.ts");
  const session = (mode: string, phase: string, extra: Record<string, unknown> = {}) =>
    ({ id: "s1", title: "T", mode, phase, attention: null, prNumber: null, prUrl: null, specRef: null, tickets: [], ...extra }) as any;
  // The board column a session's card sits in; a direct card is in Doing in every phase it has.
  assert.equal(sessionColumn("direct", "direct"), "doing");
  assert.equal(sessionColumn("direct", "setup"), "doing");
  assert.equal(sessionColumn("pipeline", "setup"), "todo");
  assert.equal(sessionColumn("pipeline", "ready"), "issues");
  assert.equal(sessionColumn("pipeline", "implement"), "doing");
  assert.equal(sessionColumn("pipeline", "review"), "qa");
  assert.equal(sessionColumn("pipeline", "pr"), "review");
  assert.equal(sessionColumn("pipeline", "done"), "done");
  assert.equal(sessionColumn("pipeline", "no-such-phase"), null);
  assert.deepEqual(cardOf(session("direct", "direct")), {
    id: "s1",
    title: "T",
    column: "doing",
    tickets: { done: 0, total: 0 },
    attention: null,
    pr: null,
    specRef: null,
  });
  assert.equal(cardOf(session("direct", "setup"))?.column, "doing", "a direct session in setup is in Doing, not To do");
  // A PR on a direct session keeps the card in Doing, with its badge.
  const pr = cardOf(session("direct", "direct", { prNumber: 7, prUrl: "https://github.com/me/app/pulls/7" }));
  assert.equal(pr?.column, "doing");
  assert.deepEqual(pr?.pr, { number: 7, url: "https://github.com/me/app/pulls/7", state: null });
  // A pipeline card keeps its phase's column through cardOf as well.
  assert.equal(cardOf(session("pipeline", "implement"))?.column, "doing");
});

test("isPlainUnclaimedCard follows the tickets count, not the column", async () => {
  const { isPlainUnclaimedCard } = await import("../../shared/board.ts");
  const card = (id: string, total: number) => ({ id, column: "issues" as const, tickets: { done: 0, total } });
  assert.equal(isPlainUnclaimedCard(card("issue:1", 0)), true, "an unclaimed issue with no tickets is plain");
  assert.equal(isPlainUnclaimedCard(card("issue:5", 2)), false, "an unclaimed issue with open tickets is a spec card");
  assert.equal(isPlainUnclaimedCard({ id: "some-session", column: "issues" as const, tickets: { done: 0, total: 0 } }), false, "a session card is never plain");
});

test("ref labels: an issue ref that names a repo keeps the repo's name, one that does not is #n, a file ref is its file name", async () => {
  const { refLabel } = await import("../../shared/board.ts");
  assert.equal(refLabel("me/app#12"), "app#12");
  assert.equal(refLabel("https://github.com/me/app/issues/12"), "app#12");
  assert.equal(refLabel("#12"), "#12");
  assert.equal(refLabel("12"), "#12");
  assert.equal(refLabel(".scratch/greeting/tickets/01-hello.md"), "01-hello.md");
});

test("the resolved-conflict note the server writes is the one the UI shows as resolved", async () => {
  const { isResolvedNote, resolvedNote } = await import("../../shared/board.ts");
  assert.ok(isResolvedNote(resolvedNote("main")));
  assert.ok(isResolvedNote(resolvedNote("develop", "kept both sides' lines in work.txt")));
  assert.ok(!isResolvedNote("The merge conflict was not resolved: the run was stopped. Resolve it on the branch, then approve again."));
  assert.ok(!isResolvedNote("The merge conflict is resolved, but the push failed: no network. Push the branch, then approve again."));
  assert.ok(!isResolvedNote(null));
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
  old.exec(
    "CREATE TABLE tickets (session_id TEXT NOT NULL, num INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, blocked_by TEXT NOT NULL DEFAULT '[]', tracker_ref TEXT, status TEXT NOT NULL DEFAULT 'ready', note TEXT, run_id TEXT, started_at INTEGER, finished_at INTEGER, PRIMARY KEY (session_id, num))",
  );
  old.prepare("INSERT INTO sessions (id, repo_id, title, branch, base_branch, worktree, created_at, updated_at) VALUES ('s','r','t','b','main','/w',0,0)").run();
  old.prepare("INSERT INTO tickets (session_id, num, title, body) VALUES ('s',1,'T','b')").run();
  old.close();
  const db = openDb(file);
  const row = db.prepare("SELECT mode, phase, active_run, attention, issue_ref, auto_approve, typesafe_skill, retro_run FROM sessions").get() as any;
  // auto_approve null: existing sessions inherit the global switch; and they have no TypeSafe skill.
  assert.deepEqual({ ...row }, { mode: "direct", phase: "direct", active_run: null, attention: null, issue_ref: null, auto_approve: null, typesafe_skill: 0, retro_run: null });
  // The stop-rule and rescue columns land on old tickets rows the same way.
  const trow = db.prepare("SELECT start_commit, stop_reason, rescue_run_id, diagnosis, fix_run_id, rescue_state FROM tickets").get() as any;
  assert.deepEqual({ ...trow }, { start_commit: null, stop_reason: null, rescue_run_id: null, diagnosis: null, fix_run_id: null, rescue_state: null });
  // The auto-approve audit trail's table is created too.
  db.prepare("INSERT INTO auto_decisions (session_id, run_id, request_id, event, created_at) VALUES ('s', 's', 'r1', '{}', 0)").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM auto_decisions").get() as any).n, 1);
});

test("old done pipeline rows with a PR number open as pr, once", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wb-mig-")), "old.db");
  const old = new DatabaseSync(file);
  old.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, title TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL, worktree TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pr_number INTEGER, pr_url TEXT, held_prompt TEXT, archived INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'direct', phase TEXT NOT NULL DEFAULT 'direct')",
  );
  const add = old.prepare("INSERT INTO sessions (id, repo_id, title, branch, base_branch, worktree, created_at, updated_at, pr_number, mode, phase) VALUES (?, 'r', 't', 'b', 'main', '/w', 0, 0, ?, ?, ?)");
  add.run("reviewed-with-pr", 4, "pipeline", "done");
  add.run("reviewed-no-pr", null, "pipeline", "done");
  add.run("implementing", 5, "pipeline", "implement");
  add.run("direct", 6, "direct", "direct");
  old.close();
  const phases = (db: ReturnType<typeof openDb>) =>
    Object.fromEntries((db.prepare("SELECT id, phase FROM sessions ORDER BY id").all() as any[]).map((r) => [r.id, r.phase]));
  const db = openDb(file);
  assert.deepEqual(phases(db), { "reviewed-with-pr": "pr", "reviewed-no-pr": "done", implementing: "implement", direct: "direct" });
  // `done` now means merged: a later merge is not turned back into `pr` on the next open.
  db.prepare("UPDATE sessions SET phase = 'done' WHERE id = 'reviewed-with-pr'").run();
  db.close();
  assert.equal(phases(openDb(file))["reviewed-with-pr"], "done");
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

  // Features: a spec issue with open tickets shows as an unclaimed card; its drags solve or rework it.
  const features = section("What you get");
  assert.match(features, /unclaimed card/i);
  assert.match(features, /ticket sub-issues/);
  assert.match(features, /Doing/);
  assert.match(features, /To do/);
  // Solve flow: the PR closes the spec issue and every ticket issue.
  assert.match(features, /closes the spec issue/i);
});

test("every pipeline prompt starts with a /skill: command pi will expand", async () => {
  const p = await import("../src/pipeline.ts");
  const t = { num: 1, title: "T", body: "b", blockedBy: [], trackerRef: null, status: "ready", note: null, runId: null } as any;
  for (const prompt of [p.grillPrompt("task"), p.specPrompt(), p.ticketsPrompt(null), p.ticketsPrompt("#4"), p.implementPrompt(t, null, null, []), p.reviewPrompt("main", null, null, [t]), p.reworkPrompt("#4"), p.reworkPrompt(null), p.mergePrompt("main", "PR #1 has a merge conflict with main", ["a.txt"]), p.splitPrompt("https://github.com/a/b/issues/5")]) {
    // pi needs an argument after the skill name on the first line.
    assert.match(prompt.split("\n")[0], /^\/skill:[\w-]+ \S/);
  }
});

test("the split prompt breaks the issue into sub-issues with blocking edges, and leaves the issue itself untouched", async () => {
  const { splitPrompt } = await import("../src/pipeline.ts");
  const prompt = splitPrompt("https://github.com/a/b/issues/5");
  assert.match(prompt, /^\/skill:to-tickets /);
  assert.ok(prompt.includes("https://github.com/a/b/issues/5"), "names the issue URL");
  assert.match(prompt, /sub-issue/i, "publishes the tickets as sub-issues of the issue");
  assert.match(prompt, /blocking/i, "keeps the tickets' blocking edges");
  assert.match(prompt, /ask_user/, "asks the user to approve the breakdown");
  assert.match(prompt, /record_tickets/, "records every ticket with its tracker ref");
  assert.match(prompt, /do not (change|close).*the issue itself/i, "does not change or close the issue itself");
});

test("the unclaimed-card starts pick phase, tickets, held prompt and spec in one table", async () => {
  const { START_PLANS, isStartFrom, ticketFromIssue } = await import("../src/pipeline.ts");
  assert.deepEqual(Object.keys(START_PLANS).sort(), ["issue", "spec", "split", "tickets"]);
  assert.ok(isStartFrom("split"), "names the four starts");
  assert.ok(!isStartFrom("grill"));
  assert.ok(!isStartFrom(null));
  assert.ok(!isStartFrom(3));
  assert.equal(START_PLANS.tickets.phase, "implement", "Solve all starts at the tickets");
  assert.equal(START_PLANS.issue.phase, "implement", "Solve starts at the one ticket");
  assert.equal(START_PLANS.split.phase, "tickets", "Split starts at the to-tickets run");
  assert.equal(START_PLANS.spec.phase, "grill", "rework starts at the grill");
  assert.equal(START_PLANS.tickets.needsSubIssues, true, "Solve all needs the sub-issue tickets");
  assert.equal(START_PLANS.spec.needsSubIssues, true, "rework needs the sub-issue tickets");
  assert.equal(START_PLANS.issue.needsSubIssues, false, "Solve refuses a spec issue");
  assert.equal(START_PLANS.split.needsSubIssues, false, "Split refuses a spec issue");
  const seed = { spec: { number: 3, title: "A plain issue", body: "Fix it", htmlUrl: "https://github.com/a/b/issues/3", hasParent: false }, subIssues: [] };
  assert.deepEqual(START_PLANS.issue.tickets!(seed), ticketFromIssue(seed.spec), "Solve records the issue as its only ticket");
  assert.ok(START_PLANS.split.held!(seed).includes("https://github.com/a/b/issues/3"), "Split holds the split prompt");
  assert.ok(START_PLANS.spec.held!(seed).startsWith("/skill:grill-with-docs"), "rework holds the rework prompt");
  assert.ok(START_PLANS.tickets.tickets, "Solve all derives its tickets from the sub-issues");
  assert.equal(START_PLANS.split.spec, true, "a split takes the issue body as its spec");
  assert.equal(START_PLANS.spec.spec, false, "a rework re-saves its spec in the to-spec step");
});

test("the glossary records the board's columns and card actions", () => {
  const glossary = fs.readFileSync(new URL("../../GLOSSARY.md", import.meta.url), "utf8");
  for (const term of ["To do", "Unclaimed card", "Solve", "Split"]) {
    assert.match(glossary, new RegExp(`\\*\\*${term}\\*\\*:`), `glossary defines ${term}`);
  }
  assert.match(glossary, /\*\*Issues\*\* \(column\):/);
  assert.match(glossary, /\*\*Card\*\*:/);
  assert.match(
    glossary,
    /\*\*Split\*\*:\nBreaking a plain issue into ticket sub-issues with `to-tickets`, so it becomes a spec issue that waits for Solve all\./,
    "Split is a term entry, not only the drag-relationship mention",
  );
});

test("glossary and ADR 0003 record the stop-rule, rescue and retro vocabulary", () => {
  const glossary = fs.readFileSync(new URL("../../GLOSSARY.md", import.meta.url), "utf8");
  for (const term of ["Stop rule", "Rescue run", "Fix run", "Retro run"]) {
    assert.match(glossary, new RegExp(`\\*\\*${term}\\*\\*:`), `glossary defines ${term}`);
  }
  // The relationship: the Reviewer's settings drive the Reviewer, rescue and retro runs.
  assert.match(glossary, /an empty Reviewer model turns all three off/i);
  // The Phase union puts retro between review and pr (then done), server and web.
  assert.match(fs.readFileSync(new URL("../src/pipeline.ts", import.meta.url), "utf8"), /"review" \| "retro" \| "pr" \| "done"/);
  assert.match(fs.readFileSync(new URL("../../web/src/types.ts", import.meta.url), "utf8"), /"review" \| "retro" \| "pr" \| "done"/);
  const adrs = fs.readdirSync(new URL("../../docs/adr", import.meta.url));
  const file = adrs.find((f) => f.startsWith("0003-"));
  assert.ok(file, "ADR 0003 exists");
  const adr = fs.readFileSync(new URL(`../../docs/adr/${file}`, import.meta.url), "utf8");
  assert.match(adr, /localhost proxy/i, "the proxy decision");
  assert.match(adr, /key in the rescue run/i, "the considered alternative: the key in the rescue run's environment");
  assert.match(adr, /process\.env/i, "the rejection reason: the rescue agent can read process.env");
  assert.match(adr, /curl/i, "the rejection reason: approval rules gate only curl and wget");
});

test("auto-approve settings: off by default, validated on save", () => {
  const db = tmpDb();
  const s = getAutoApproveSettings(db);
  assert.equal(s.enabled, false);
  assert.deepEqual(s.judge, { kind: "jev", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", protocol: "systemone", yesAbove: 0.7, noBelow: 0.3 });
  const judge = (patch: Record<string, unknown>) => ({ judge: { ...getAutoApproveSettings(db).judge, ...patch } }) as any;
  for (const baseUrl of ["ftp://x", ["https://j.example/v1"], 42]) assert.throws(() => saveAutoApproveSettings(db, judge({ baseUrl })), /judge URL/);
  for (const model of ["", "  ", 7]) assert.throws(() => saveAutoApproveSettings(db, judge({ model })), /model/);
  assert.throws(() => saveAutoApproveSettings(db, judge({ protocol: "grpc" })), /protocol/);
  for (const [noBelow, yesAbove] of [[0, 0.7], [0.3, 1], [0.7, 0.3], [0.5, 0.5], [Number.NaN, 0.7], ["0.3", 0.7]]) {
    assert.throws(() => saveAutoApproveSettings(db, judge({ noBelow, yesAbove })), /cut-off/);
  }
  assert.equal(saveAutoApproveSettings(db, judge({ noBelow: 0.01, yesAbove: 0.99 })).judge.yesAbove, 0.99);
  saveAutoApproveSettings(db, { enabled: true });
  assert.equal(getAutoApproveSettings(db).judge.yesAbove, 0.99, "saving only the switch keeps the judge");
  for (const enabled of ["false", 0, 1, null]) {
    assert.throws(() => saveAutoApproveSettings(db, { enabled } as any), /on or off/);
  }
  assert.equal(getAutoApproveSettings(db).enabled, true, "a rejected save changes nothing");
  saveAutoApproveSettings(db, judge({ extra: "x" }));
  assert.deepEqual(Object.keys(getAutoApproveSettings(db).judge).sort(), ["baseUrl", "kind", "model", "noBelow", "protocol", "yesAbove"]);
});

test("a stored auto-approve switch that is not exactly true reads as off", () => {
  const db = tmpDb();
  for (const enabled of ["false", "true", 1]) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('autoApprove', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ enabled }));
    assert.equal(getAutoApproveSettings(db).enabled, false, JSON.stringify(enabled));
  }
});

test("the judge token is write-only and never reaches a pi environment", () => {
  const db = tmpDb();
  const store = new SecretStore(db, "test-master-key-0123456789");
  store.set("global", "OTHER", "x");
  saveAutoApproveKey(store, { key: "judgeToken", value: "  jev-very-secret  ", baseUrl: "https://api.typesafe.ai/v1" });
  assert.equal(savedJudgeToken(store).judgeToken, "jev-very-secret");
  assert.equal(savedJudgeToken(store).tokenOrigin, "https://api.typesafe.ai", "the token is bound to the origin it was saved for");
  assert.ok(!JSON.stringify(store.envFor()).includes("jev-very-secret"));
  assert.ok(!JSON.stringify(store.envFor("me/app")).includes("jev-very-secret"));
  const view = autoApproveView(db, store);
  assert.equal(view.keys.judgeToken, true);
  assert.equal(view.keys.tokenOrigin, "https://api.typesafe.ai");
  assert.ok(!JSON.stringify(view).includes("jev-very-secret"));
  const url = "https://api.typesafe.ai/v1";
  for (const bad of [
    { key: "masterKey", value: "x", baseUrl: url },
    { key: "judgeToken", value: "", baseUrl: url },
    { key: "judgeToken", value: "  ", baseUrl: url },
    { key: "judgeToken", value: 5, baseUrl: url },
    { key: "judgeToken", value: "t" },
    { key: "judgeToken", value: "t", baseUrl: "ftp://x" },
    { key: "judgeToken", value: "t", baseUrl: "https://" },
    { key: "judgeToken", value: "t", baseUrl: "https://my host/v1" },
  ]) {
    assert.throws(() => saveAutoApproveKey(store, bad), (e: any) => e.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(savedJudgeToken(store), { judgeToken: "jev-very-secret", tokenOrigin: "https://api.typesafe.ai" }, "a refused save changes nothing");
  saveAutoApproveKey(store, { key: "judgeToken", value: null });
  assert.equal(autoApproveView(db, store).keys.judgeToken, false);
  assert.deepEqual(store.list("wb:auto-approve"), [], "removing the token leaves nothing behind");
});

test("reviewer settings validate and keep their shape", () => {
  const db = tmpDb();
  const defaults = getAutoApproveSettings(db);
  assert.deepEqual(defaults.reviewer, { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "" });
  const rev = (patch: Record<string, unknown>) => ({ reviewer: { ...getAutoApproveSettings(db).reviewer, ...patch } }) as any;
  for (const provider of ["google", 7, ""]) assert.throws(() => saveAutoApproveSettings(db, rev({ provider })), /provider/);
  for (const baseUrl of ["ftp://x", 42, "https://", ""]) assert.throws(() => saveAutoApproveSettings(db, rev({ baseUrl })), /URL/);
  for (const model of [7, null]) assert.throws(() => saveAutoApproveSettings(db, rev({ model })), /model/);
  const saved = saveAutoApproveSettings(db, rev({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-mock", extra: "x" }));
  assert.deepEqual(saved.reviewer, { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-mock" });
  const judge = saved.judge;
  assert.deepEqual(saveAutoApproveSettings(db, { enabled: true }).reviewer, saved.reviewer, "saving only the switch keeps the reviewer");
  assert.deepEqual(saveAutoApproveSettings(db, { enabled: true }).judge, judge);
});

test("Save with an empty reviewer model turns the reviewer off and keeps the switch usable", async () => {
  const db = tmpDb();
  const store = new SecretStore(db, "test-master-key-0123456789");
  const judge = getAutoApproveSettings(db).judge;
  const reviewer = { provider: "anthropic" as const, baseUrl: "https://api.anthropic.com", model: "" };
  // Settings → Save always sends the reviewer fields, also when no reviewer is set up.
  const on = await configureAutoApprove(db, store, { enabled: true, judge, reviewer });
  assert.equal(on.enabled, true);
  assert.deepEqual(on.reviewer, reviewer);
  const off = await configureAutoApprove(db, store, { enabled: false, judge, reviewer: { ...reviewer, model: "  " } });
  assert.equal(off.enabled, false);
  assert.equal(off.reviewer.model, "", "a blank model id is stored as the reviewer-off state");
  assert.equal(getAutoApproveSettings(db).enabled, false);
});

test("the reviewer key is write-only and never reaches a pi environment", () => {
  const db = tmpDb();
  const store = new SecretStore(db, "test-master-key-0123456789");
  saveAutoApproveKey(store, { key: "reviewerKey", value: "  claude-secret  ", baseUrl: "https://reviewer.example" });
  assert.deepEqual(savedReviewerKey(store), { reviewerKey: "claude-secret", keyOrigin: "https://reviewer.example" });
  assert.ok(!JSON.stringify(store.envFor()).includes("claude-secret"));
  assert.ok(!JSON.stringify(store.envFor("me/app")).includes("claude-secret"));
  const view = autoApproveView(db, store);
  assert.equal(view.keys.reviewerKey, true);
  assert.ok(!JSON.stringify(view).includes("claude-secret"));
  for (const bad of [{ key: "reviewerKey", value: "" }, { key: "reviewerKey", value: "   " }, { key: "reviewerKey", value: 5 }]) {
    assert.throws(() => saveAutoApproveKey(store, bad), (e: any) => e.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(savedReviewerKey(store), { reviewerKey: "claude-secret", keyOrigin: "https://reviewer.example" }, "a refused save changes nothing");
  saveAutoApproveKey(store, { key: "reviewerKey", value: null });
  assert.deepEqual(savedReviewerKey(store), { reviewerKey: undefined, keyOrigin: undefined });
  assert.equal(autoApproveView(db, store).keys.reviewerKey, false);
  assert.deepEqual(store.list("wb:auto-approve"), [], "removing the key leaves nothing behind");
});

const PERM = {
  tool: "bash",
  subject: "rm -rf build",
  reasons: ["rm -r / -f"],
  session: { title: "Auto", task: "Tidy the demo", repo: "me/demo", worktree: "/wt" },
};
const CTX = {
  title: "Auto",
  task: "Tidy the demo",
  phase: "direct",
  repo: "me/demo",
  branch: "pi/x-1",
  worktree: "/wt",
  sshHosts: [{ alias: "Media", user: "ubuntu", hostname: "127.0.0.1" }],
  recent: "[user] please rm the build dir",
};
const REVIEW_SETTINGS = (baseUrl: string, patch: Record<string, unknown> = {}) => ({
  enabled: true,
  judge: { baseUrl: "https://judge.example/v1", model: "jev-latest", protocol: "systemone", yesAbove: 0.7, noBelow: 0.3 },
  reviewer: { provider: "anthropic", baseUrl, model: "claude-mock", ...patch },
});

test("reviewPermission: a reviewer without a model id or key fails with a note", async () => {
  const noModel = await reviewPermission(PERM, CTX, REVIEW_SETTINGS("https://x.example", { model: "" }), "key");
  assert.equal(noModel.outcome, "failed");
  assert.match(noModel.note, /model id/);
  assert.equal(noModel.by, "Claude");
  const noKey = await reviewPermission(PERM, CTX, REVIEW_SETTINGS("https://x.example"), undefined);
  assert.equal(noKey.outcome, "failed");
  assert.match(noKey.note, /API key/);
});

test("reviewPermission: the anthropic reviewer reads a JSON verdict from the reply, and no key leaves the server", async () => {
  const m = await startMockReviewer({ provider: "anthropic", model: "claude-mock", key: "claude-secret" });
  try {
    const v = await reviewPermission(PERM, CTX, REVIEW_SETTINGS(m.url), "claude-secret");
    assert.deepEqual(v, { outcome: "allow", by: "Claude", reason: "Routine cleanup for the task." });
    const req = m.requests.find((r) => r.path === "/v1/messages")!;
    assert.equal(req.key, "claude-secret");
    assert.equal(req.body.model, "claude-mock");
    assert.equal(req.body.tools, undefined, "no tools offered: the verdict is reply JSON");
    assert.equal(req.body.tool_choice, undefined, "no forced tool choice: not all models support it");
    assert.match(JSON.stringify(req.body.system), /JSON object/);
    const state = JSON.stringify(req.body);
    assert.match(state, /rm -rf build/);
    assert.match(state, /Tidy the demo/);
    assert.match(state, /pi\/x-1/);
    assert.match(state, /Media \(ubuntu@127\.0\.0\.1\)/);
    assert.ok(!state.includes("claude-secret"), "the key is not in the body");
  } finally {
    await m.close();
  }
});

test("reviewPermission: deny and escalate verdicts carry the reason", async () => {
  const m = await startMockReviewer({ provider: "anthropic", model: "claude-mock", key: "k" });
  try {
    m.replies.push({ decision: "deny", reason: "Not part of the task." });
    const deny = await reviewPermission({ ...PERM, subject: "rm -rf /mnt/data" }, CTX, REVIEW_SETTINGS(m.url), "k");
    assert.deepEqual(deny, { outcome: "deny", by: "Claude", reason: "Not part of the task." });
    m.replies.push({ decision: "escalate", reason: "Could damage data beyond the task." });
    const esc = await reviewPermission(PERM, CTX, REVIEW_SETTINGS(m.url), "k");
    assert.deepEqual(esc, { outcome: "escalate", by: "Claude", reason: "Could damage data beyond the task." });
  } finally {
    await m.close();
  }
});

test("reviewPermission: an HTTP error, a garbage body, or a missing verdict fails with a note", async () => {
  const m = await startMockReviewer({ provider: "anthropic", model: "claude-mock", key: "k" });
  try {
    for (const [reply, why] of [
      [{ status: 500, body: JSON.stringify({ error: { message: "overloaded" } }) }, /HTTP 500: overloaded/],
      [{ body: "<html>nope</html>" }, /unreadable/],
      [{ decision: "maybe", reason: "hmm" }, /unreadable/],
      [{ decision: "deny", reason: "" }, /unreadable/],
    ] as const) {
      m.replies.push(reply);
      const v = await reviewPermission(PERM, CTX, REVIEW_SETTINGS(m.url), "k");
      assert.equal(v.outcome, "failed", why);
      assert.match(v.note, why);
    }
  } finally {
    await m.close();
  }
});

test("reviewPermission: the openai provider reads a JSON verdict and names the reviewer OpenAI", async () => {
  const m = await startMockReviewer({ provider: "openai", model: "gpt-mock", key: "sk" });
  try {
    const v = await reviewPermission(PERM, CTX, { ...REVIEW_SETTINGS(m.url), reviewer: { provider: "openai", baseUrl: m.url, model: "gpt-mock" } }, "sk");
    assert.equal(v.by, "OpenAI");
    assert.equal(v.outcome, "allow");
    const req = m.requests.find((r) => r.path === "/chat/completions")!;
    assert.equal(req.key, "sk", "the openai key travels as a bearer token or api key");
    assert.match(JSON.stringify(req.body), /rm -rf build/);
  } finally {
    await m.close();
  }
});

test("transcriptExcerpt keeps the newest messages and truncates", () => {
  const msgs = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message number ${i} ${"x".repeat(200)}` }));
  const out = transcriptExcerpt(msgs, 500);
  assert.match(out, /message number 19/);
  assert.ok(!out.includes("message number 5"), "old lines drop out");
  assert.ok(out.length <= 500);
});

test("waitsOnUser: judging and reviewing do not wait; waiting, escalated, and failed do", () => {
  assert.equal(waitsOnUser({}), true);
  assert.equal(waitsOnUser({ judge: { state: "judging" } }), false);
  assert.equal(waitsOnUser({ judge: { state: "waiting" } }), true);
  assert.equal(waitsOnUser({ judge: { state: "waiting" }, review: { state: "reviewing" } }), false);
  assert.equal(waitsOnUser({ judge: { state: "waiting" }, review: { state: "escalated" } }), true);
  assert.equal(waitsOnUser({ judge: { state: "failed" }, review: { state: "failed" } }), true);
});

// --- issue #20: the local judge kind --------------------------------------------------------

/** Judge settings for the local kind, pointing the model id at a mock endpoint. */
const LOCAL_SETTINGS = (baseUrl: string): any => ({
  enabled: true,
  judge: { kind: "local", baseUrl, model: "mock-judge", protocol: "openai", yesAbove: 0.7, noBelow: 0.3 },
  reviewer: { provider: "anthropic", baseUrl: "https://x.example", model: "" },
});

const PUSH = { ...PERM, subject: "git push origin HEAD", reasons: ["git push"] };

let localMock: Awaited<ReturnType<typeof startMockLlm>>;
let localStore: any;
let localDb: any;

before(async () => {
  localMock = await startMockLlm();
  localDb = tmpDb();
  localStore = new SecretStore(localDb, "local-test-master-key-0123");
  saveModelSettings(localDb, { baseUrl: localMock.url });
  localStore.set(GLOBAL_SCOPE, LLM_KEY_ENV, "llm-secret");
});
after(async () => {
  await localMock.close();
});

test("the judge kind defaults to jev; local and jev are the only kinds", () => {
  const db = tmpDb();
  assert.equal(getAutoApproveSettings(db).judge.kind, "jev");
  for (const kind of ["local-judge", "", 7]) assert.throws(() => saveAutoApproveSettings(db, { judge: { kind } }), /kind/);
  const saved = saveAutoApproveSettings(db, { judge: { kind: "local", baseUrl: "http://agent:8080/v1", model: "m", protocol: "openai" } });
  assert.equal(saved.judge.kind, "local");
  assert.equal(saved.judge.protocol, "openai");
  // Saving only the switch keeps the kind.
  assert.deepEqual(saveAutoApproveSettings(db, { enabled: true }).judge, saved.judge);
});

test("localJudge returns the model settings' endpoint and the LLM key", () => {
  const l = localJudge(localDb, localStore);
  assert.equal(l.baseUrl, localMock.url);
  assert.equal(l.apiKey, "llm-secret");
  const db2 = tmpDb();
  const store2 = new SecretStore(db2, "local-test-master-key-0123");
  saveModelSettings(db2, { baseUrl: "http://other:8080/v1" });
  assert.deepEqual(localJudge(db2, store2), { baseUrl: "http://other:8080/v1", apiKey: undefined });
});

test("configureAutoApprove: the local kind probes the model settings' endpoint, not a judge URL", async () => {
  const saved = await configureAutoApprove(localDb, localStore, { enabled: true, judge: { kind: "local", model: "mock-judge", baseUrl: localMock.url } });
  assert.equal(saved.judge.kind, "local");
  assert.equal(saved.judge.protocol, "openai");
  const probe = localMock.requests.find((r) => r.path?.endsWith("/v1/models"));
  assert.ok(probe, "the probe went to the agent's endpoint");
  assert.equal(probe.auth, "Bearer llm-secret", "with the LLM key");
  // A model the agent's endpoint does not serve is refused, and the refused save changes nothing.
  await assert.rejects(configureAutoApprove(localDb, localStore, { judge: { kind: "local", model: "nope-model" } }), /nope-model.*not served/);
  assert.equal(getAutoApproveSettings(localDb).judge.model, "mock-judge");
  // Re-saving unchanged local settings does not probe again.
  const from = localMock.requests.length;
  await configureAutoApprove(localDb, localStore, { judge: { kind: "local", model: "mock-judge", baseUrl: localMock.url } });
  assert.equal(localMock.requests.length, from, "unchanged: no probe");
});

test("configureAutoApprove: switching the kind away from the saved kind probes the new endpoint", async () => {
  // Saved: the local kind. Input: jev, same model name: the endpoint changed, so probe.
  const jev = await startMockJudge({ protocol: "systemone", model: "mock-judge" });
  try {
    const from = localMock.requests.length;
    await configureAutoApprove(localDb, localStore, { judge: { kind: "jev", model: "mock-judge", baseUrl: jev.url } });
    assert.equal(getAutoApproveSettings(localDb).judge.kind, "jev");
    assert.ok(jev.requests.some((r) => r.path === "/v1/models"), "the new endpoint was probed");
    assert.equal(localMock.requests.length, from, "the agent's endpoint was not asked");
  } finally {
    await jev.close();
    // Back to local for the remaining tests; the agent's endpoint is probed again.
    await configureAutoApprove(localDb, localStore, { judge: { kind: "local", model: "mock-judge", baseUrl: localMock.url } });
  }
});

test("judgePermission: the local kind judges on the agent's endpoint with the LLM key", async () => {
  const local = localJudge(localDb, localStore);
  const v = await judgePermission(PUSH, LOCAL_SETTINGS(localMock.url), savedJudgeToken(localStore), local);
  assert.deepEqual(v, { outcome: "allow", by: "local judge", detail: "SAFE" });
  const req = localMock.requests.find((r) => r.path === "/v1/chat/completions" && r.model === "mock-judge" && r.stream === false);
  assert.ok(req, "the judge call went to the agent's endpoint");
  assert.equal(req.auth, "Bearer llm-secret");
  assert.ok(JSON.stringify(req.messages).includes("git push origin HEAD"), "the call's state");
  assert.equal(req.temperature, 0);
});

test("judgePermission: the local kind's RISKY and DANGEROUS go to the reviewer with the rating", async () => {
  const local = localJudge(localDb, localStore);
  for (const [perm, word] of [[PERM, "risky"], [{ ...PERM, subject: "rm -rf /mnt/data", reasons: ["rm -r / -f"] }, "dangerous"]] as const) {
    const v = await judgePermission(perm, LOCAL_SETTINGS(localMock.url), savedJudgeToken(localStore), local);
    assert.equal(v.outcome, "user", word);
    assert.equal(v.by, "local judge");
    assert.equal(v.rating, word);
    assert.equal(v.detail, word.toUpperCase());
    assert.match(v.note, new RegExp(word), word);
  }
});

test("judgePermission: a local judge reply that is not a level word fails, and a think block is stripped", async () => {
  const local = localJudge(localDb, localStore);
  localMock.judgeReplies.push({ text: "Probably fine, I think." });
  const bad = await judgePermission(PUSH, LOCAL_SETTINGS(localMock.url), savedJudgeToken(localStore), local);
  assert.equal(bad.outcome, "failed");
  assert.equal(bad.note, "local judge failed: the answer was not SAFE, RISKY or DANGEROUS");
  localMock.judgeReplies.push({ text: "  \n\n SAFE" });
  const think = await judgePermission(PUSH, LOCAL_SETTINGS(localMock.url), savedJudgeToken(localStore), local);
  assert.deepEqual(think, { outcome: "allow", by: "local judge", detail: "SAFE" });
  localMock.judgeReplies.push({ status: 500, body: JSON.stringify({ src: "llama-swap", error: { message: "upstream command exited prematurely" } }) });
  const err = await judgePermission(PUSH, LOCAL_SETTINGS(localMock.url), savedJudgeToken(localStore), local);
  assert.equal(err.outcome, "failed");
  assert.equal(err.note, "local judge failed: HTTP 500: upstream command exited prematurely");
});

test("judgePermission: the local kind without a local endpoint falls back to the saved judge URL", async () => {
  const from = localMock.requests.length;
  const v = await judgePermission(PUSH, LOCAL_SETTINGS(localMock.url), savedJudgeToken(localStore));
  assert.equal(v.outcome, "allow");
  const req = localMock.requests.slice(from).find((r) => r.path === "/v1/chat/completions" && r.model === "mock-judge" && r.stream === false);
  assert.ok(req);
  assert.equal(req.auth, undefined, "no saved judge token: no auth header");
});

test("testJudge: the local kind asks the agent's endpoint and reports the word", async () => {
  const ok = await testJudge(getAutoApproveSettings(localDb), savedJudgeToken(localStore), localJudge(localDb, localStore));
  assert.equal(ok.ok, true);
  assert.match(ok.message, /local judge/);
  assert.match(ok.message, /safe/);
  localMock.judgeReplies.push({ status: 401 });
  const bad = await testJudge(getAutoApproveSettings(localDb), savedJudgeToken(localStore), localJudge(localDb, localStore));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /HTTP 401/);
});

test("the Secrets page cannot see, set, or delete the auto-approve scope", () => {
  const db = tmpDb();
  const store = new SecretStore(db, "test-master-key-0123456789");
  store.set("global", "A", "1");
  saveAutoApproveKey(store, { key: "judgeToken", value: "t", baseUrl: "https://api.typesafe.ai/v1" });
  assert.deepEqual(userSecrets(store).map((s) => s.scope), ["global"]);
  const isRepo = (scope: string) => scope === "me/app";
  assert.doesNotThrow(() => assertUserScope("global", isRepo));
  assert.doesNotThrow(() => assertUserScope("me/app", isRepo));
  for (const scope of ["wb:auto-approve", "wb:anything", "other/repo"]) {
    assert.throws(() => assertUserScope(scope, isRepo), (e: any) => e.status === 400, scope);
  }
  // Deleting accepts any listed scope (a removed repo's too), but never a reserved one.
  assert.doesNotThrow(() => assertUserScope("gone/repo", () => true));
  assert.throws(() => assertUserScope("wb:auto-approve", () => true), (e: any) => e.status === 400);
});

test("validateDiagnosis: a diagnosis needs a command and a file:line causal chain; no_loop and failed need only a note", async () => {
  const { validateDiagnosis } = await import("../src/pipeline.ts");
  assert.deepEqual(validateDiagnosis({ status: "diagnosed", command: " npm test ", chain: ["src/a.ts:12 reads null", " src/b.ts:3 never sets it"], note: "n" }), {
    status: "diagnosed",
    command: "npm test",
    chain: ["src/a.ts:12 reads null", "src/b.ts:3 never sets it"],
    note: "n",
  });
  assert.deepEqual(validateDiagnosis({ status: "no_loop", note: " no env " }), { status: "no_loop", note: "no env" });
  assert.throws(() => validateDiagnosis({ status: "fixed", note: "" }), /status must be/);
  assert.throws(() => validateDiagnosis({ status: "diagnosed", chain: ["a.ts:1 x"], note: "" }), /red-capable command/);
  assert.throws(() => validateDiagnosis({ status: "diagnosed", command: "npm test", chain: [], note: "" }), /causal chain/);
  assert.throws(() => validateDiagnosis({ status: "diagnosed", command: "npm test", chain: ["a.ts:1 x", "somewhere in b.ts"], note: "" }), /file:line \(got "somewhere in b.ts"\)/);
  assert.equal(validateDiagnosis({ status: "diagnosed", command: "c", chain: ["a.ts:1"], harness: "file x", note: "" }).harness, "file x");
});
