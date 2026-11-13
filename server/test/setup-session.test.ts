/**
 * Setup when a repo is added (issue #99) and the setup commit's way onto the default branch
 * (issue #100): adding a repo that is not set up starts one session that runs only the agent-skills
 * setup skill, so setup shows on the board and its questions reach the user; when its run settles
 * with the setup marker committed, the server pushes that commit to the default branch — no pull
 * request, no Approve — records the repo as set up and lands the card in Done. A push the remote
 * refuses flags the card and leaves the repo not set up, and a setup run the user stops lands
 * nothing. Drives the real server (main.ts) over HTTP with a real `pi --mode rpc` against the
 * scripted mock model and the mock GitHub. Skips when the pi CLI isn't available.
 *
 * Seams under test: the HTTP API the UI uses (POST /api/repos, POST /api/repos/create,
 * GET /api/sessions, GET /api/sessions/:id, GET /api/board, POST /api/sessions/:id/respond), the
 * board events a WebSocket client hears, the mock GitHub's bare repo the server pushes to, and the
 * db migration that gives an older database the repos.setup_session column (unit.test.ts).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { startReviewServer } from "./review-server.ts";
import { ISSUE_TRACKER_DOC } from "./remote-repo.ts";

const { hasPi, tmp, base, gh, api, waitFor, summary, board, llm } = await startReviewServer("setup-session");
const skip = !hasPi && "pi CLI not found";
// Read src modules only after startReviewServer set the environment (a static import would snapshot
// process.env too early, see review-server.ts).
const { SETUP_MARKER } = await import("../src/config.ts");

/** The mock model's setup skill writes this into the marker file. */
const MARKER_TEXT = "GitHub issues";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
/** The mock GitHub's bare repo for one repo: the remote the server pushes the setup commit to. */
const bareOf = (owner: string, name: string) => path.join(process.env.GITHUB_CLONE_BASE!.replace(/^file:\/\//, ""), owner, `${name}.git`);
/** A path on the mock repo's default branch, or null when it is not there. */
const onMain = (owner: string, name: string, rel: string) => {
  try {
    return sh(bareOf(owner, name), "show", `refs/heads/main:${rel}`).trim();
  } catch {
    return null;
  }
};
/** The board events a WebSocket client hears, from now on. */
async function boardEvents() {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
  const seen: string[] = [];
  ws.addEventListener("message", (raw) => {
    const msg = JSON.parse(String(raw.data));
    if (msg.type === "wb_board") seen.push(msg.repoId);
  });
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  return { seen, close: () => ws.close() };
}

/** This test file's copy of the setup skill. Its body carries SETUP_ASK, which the mock model reads
 * as "this setup asks the user a question first". A body that also carries SETUP_SLOW keeps the
 * mock's setup run open after its commit (see `setupScript` in mock-llm.ts). */
const SETUP_SKILL = path.join(tmp, "skills", "setup-matt-pocock-skills", "SKILL.md");
const setupSkillBody = (...flags: string[]) =>
  `---\nname: setup-matt-pocock-skills\ndescription: setup-matt-pocock-skills test skill\n---\n${["SETUP_ASK: ask which issue tracker the repo uses, then write the files.", ...flags].join(" ")}\n`;
fs.writeFileSync(SETUP_SKILL, setupSkillBody());

let ready: Promise<void> | undefined;
/** The token and model the server needs before it can add a repo. */
function init() {
  ready ??= (async () => {
    await waitFor(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok);
    assert.equal((await api("PUT", "/api/secrets", { scope: "global", name: "GITHUB_TOKEN", value: "ghp_test" })).status, 200);
    assert.equal((await api("PUT", "/api/settings/model", { baseUrl: llm.url })).status, 200);
  })();
  return ready;
}

const sessionsOf = async (repoId: string) => ((await api("GET", "/api/sessions")).json as any[]).filter((s) => s.repoId === repoId);
const repoRow = async (repoId: string) => ((await api("GET", "/api/repos")).json as any[]).find((r) => r.id === repoId);
/** Answer the setup skill's first question, so its run can write and commit the files. */
async function answerSetupAsk(id: string) {
  const ask = await waitFor(async () => (await summary(id)).pending.find((p: any) => p.kind === "decision"), 20_000);
  assert.match(ask.title, /issue tracker/i);
  assert.equal((await api("POST", `/api/sessions/${id}/respond`, { requestId: ask.id, value: ask.options[0] })).status, 200);
}
/** The user turns the mock model was asked for, as one string. Only user turns count, because the system prompt lists every available skill. */
const userTurns = () =>
  llm.requests
    .map((r: any) => ((r.messages ?? []) as any[]).filter((m) => m.role === "user").map((m) => JSON.stringify(m)).join(""))
    .join("");


test("adding a repo recorded as not set up creates one session titled Set up agent skills, which sends the setup prompt and holds no task", { skip }, async () => {
  await init();
  gh.createBare("kevin", "fresh");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/fresh" })).status, 200);

  const sessions = await sessionsOf("kevin/fresh");
  assert.equal(sessions.length, 1, JSON.stringify(sessions.map((s) => s.title)));
  const s = sessions[0];
  assert.equal(s.title, "Set up agent skills");
  assert.equal(s.phase, "setup");
  assert.equal(s.heldPrompt, null, "the setup session holds no task");

  // The session is already working on the setup skill: its conversation opens with the setup call.
  const snap = await waitFor(async () => {
    const r = await api("GET", `/api/sessions/${s.id}`);
    return JSON.stringify(r.json.transcript?.messages ?? []).includes("setup-matt-pocock-skills") ? r.json : undefined;
  });
  assert.equal(snap.summary.id, s.id);
});

test("the repo records its setup session, so a reader can tell that setup is in progress", { skip }, async () => {
  await init();
  gh.createBare("kevin", "recorded");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/recorded" })).status, 200);
  const s = (await sessionsOf("kevin/recorded"))[0];

  const repo = await repoRow("kevin/recorded");
  assert.equal(repo.setupSession, s.id, JSON.stringify(repo));
  assert.equal((await summary(s.id)).phase, "setup", "the recorded session is the one setting the repo up");
  assert.equal((await summary(s.id)).setupRunning, true);
});

test("adding a repo recorded as set up creates no session", { skip }, async () => {
  await init();
  gh.createBare("kevin", "ready", { [SETUP_MARKER]: ISSUE_TRACKER_DOC });
  const added = await api("POST", "/api/repos", { id: "kevin/ready" });
  assert.equal(added.status, 200);
  assert.equal(added.json.needsSetup, false, "the repo is recorded as set up");
  assert.deepEqual(await sessionsOf("kevin/ready"), []);
  assert.equal((await repoRow("kevin/ready")).setupSession, null);
});

test("the setup session's card sits on its repo's board while its run works, and its question reaches the user as a decision card", { skip }, async () => {
  await init();
  gh.createBare("kevin", "boarded");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/boarded" })).status, 200);
  const s = (await sessionsOf("kevin/boarded"))[0];

  // The card is there while the setup run works, in the column a setup phase sits in.
  const card = (await board("kevin/boarded")).find((c) => c.id === s.id);
  assert.ok(card, JSON.stringify(await board("kevin/boarded")));
  assert.equal(card.title, "Set up agent skills");
  assert.equal(card.column, "todo");

  // The setup skill's question is a decision card the user answers.
  const ask = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "decision"), 20_000);
  assert.match(ask.title, /issue tracker/i);
  assert.equal((await summary(s.id)).status, "waiting");
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: ask.id, value: ask.options[0] })).status, 200);

  // The answer reaches the agent: the setup run has no question waiting on the user any more.
  await waitFor(async () => !(await summary(s.id)).pending.some((p: any) => p.kind === "decision"), 20_000);

  // Setup is the session's whole job: the mock model was never asked to grill or to build a ticket.
  // Only the user turns count, because the system prompt lists every available skill.
  const userTurns = llm.requests
    .map((r: any) => ((r.messages ?? []) as any[]).filter((m) => m.role === "user").map((m) => JSON.stringify(m)).join(""))
    .join("");
  assert.ok(userTurns.includes('<skill name=\\"setup-matt-pocock-skills\\"'), "the setup skill ran");
  assert.ok(!userTurns.includes('<skill name=\\"grill-with-docs\\"'), "no grill run started for the setup session");
  assert.ok(!userTurns.includes('<skill name=\\"tdd\\"'), "no ticket run started");
});

test("adding a repo that already has a setup session does not start a second one", { skip }, async () => {
  await init();
  gh.createBare("kevin", "again");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/again" })).status, 200);
  const first = (await sessionsOf("kevin/again"))[0];
  assert.equal(first?.title, "Set up agent skills");

  // Adding the same repo again keeps the one setup session, and the repo still records it.
  const again = await api("POST", "/api/repos", { id: "kevin/again" });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal(again.json.setupSession, first.id);
  const sessions = await sessionsOf("kevin/again");
  assert.equal(sessions.length, 1, JSON.stringify(sessions.map((s) => s.title)));
  assert.equal(sessions[0].id, first.id);
});

test("creating a repo on GitHub starts its setup session too", { skip }, async () => {
  await init();
  const created = await api("POST", "/api/repos/create", { name: "made", private: true });
  assert.equal(created.status, 200);
  assert.equal(created.json.id, "kevin/made");

  const sessions = await sessionsOf("kevin/made");
  assert.equal(sessions.length, 1, JSON.stringify(sessions.map((s) => s.title)));
  assert.equal(sessions[0].title, "Set up agent skills");
  assert.equal((await repoRow("kevin/made")).setupSession, sessions[0].id);
});

test("the setup session's run finishes on its own: it never grills a task and runs no ticket", { skip }, async () => {
  await init();
  gh.createBare("kevin", "done-setup");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/done-setup" })).status, 200);
  const s = (await sessionsOf("kevin/done-setup"))[0];

  // The setup skill asks first; the answer lets it write the marker and commit it.
  const ask = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "decision"), 20_000);
  assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: ask.id, value: ask.options[0] })).status, 200);

  // The settle that ends the setup run is the one that would move a session on to the grill.
  const settled = await waitFor(async () => ((await summary(s.id)).phase === "done" ? await summary(s.id) : undefined), 60_000);
  assert.equal(settled.setupRunning, false, "the setup run is over, and nothing grilled in its place");
  const turns = userTurns();
  assert.ok(!turns.includes('<skill name=\\"grill-with-docs\\"'), "the settled setup session starts no grill");
  assert.ok(!turns.includes('<skill name=\\"tdd\\"'), "the settled setup session runs no ticket");
});

test("the setup run's commit lands on the default branch: the repo reads as set up, its card is Done, and no pull request is opened", { skip }, async () => {
  await init();
  const events = await boardEvents();
  const before = events.seen.length;
  gh.createBare("kevin", "landed");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/landed" })).status, 200);
  const s = (await sessionsOf("kevin/landed"))[0];
  assert.equal(s.phase, "setup", "the card works in To do while the setup run works");
  await answerSetupAsk(s.id);

  // The server pushes the commit onto the default branch: the card lands in Done, with no PR to Approve.
  const card = await waitFor(async () => (await board("kevin/landed")).find((c) => c.id === s.id && c.column === "done"), 60_000);
  assert.equal(card.pr, null, "the card carries no pull request");
  assert.equal(card.attention, null, "nothing waits on the user");
  const sum = await summary(s.id);
  assert.equal(sum.phase, "done");
  assert.equal(sum.prNumber, null);
  assert.deepEqual(gh.pulls.filter((p: any) => String(p.html_url).includes("/kevin/landed/")), [], "no pull request was opened for this repo");

  // The default branch carries the setup file, so a later session's worktree starts with it.
  assert.equal(onMain("kevin", "landed", SETUP_MARKER), MARKER_TEXT);
  assert.equal((await repoRow("kevin/landed")).needsSetup, false, "the repo reads as set up");

  // The card's move to Done goes out as a board event, so open boards fetch GET /api/board again:
  // one event for the new card, one for its move.
  assert.equal(events.seen.filter((r) => r === "kevin/landed").length - before, 2, JSON.stringify(events.seen));
  events.close();

  // Only the server pushes: the setup prompt still tells the agent not to.
  assert.match(userTurns(), /setup-matt-pocock-skills[\s\S]*?Do not push/, "the setup prompt keeps its no-push instruction");
});

test("a refused setup push flags the card with the reason and leaves the repo recorded as not set up", { skip }, async () => {
  await init();
  gh.createBare("kevin", "protected");
  // The remote refuses every push, as a protected branch does.
  const hook = path.join(bareOf("kevin", "protected"), "hooks", "pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\necho protected branch >&2\nexit 1\n");
  fs.chmodSync(hook, 0o755);
  assert.equal((await api("POST", "/api/repos", { id: "kevin/protected" })).status, 200);
  const s = (await sessionsOf("kevin/protected"))[0];
  await answerSetupAsk(s.id);

  // The commit is in the worktree, but it cannot reach the default branch: the card carries the reason.
  const flagged = await waitFor(async () => {
    const sum = await summary(s.id);
    return !sum.setupRunning && sum.status !== "running" && sum.attention ? sum : undefined;
  }, 60_000);
  assert.match(flagged.attention, /main/);
  assert.match(flagged.attention, /protected branch/, "the card carries git's own words");
  assert.equal(flagged.phase, "setup", "the card is not Done");
  assert.equal((await board("kevin/protected")).find((c) => c.id === s.id)?.column, "todo");
  assert.equal((await repoRow("kevin/protected")).needsSetup, true, "the repo stays recorded as not set up");
  assert.equal(onMain("kevin", "protected", SETUP_MARKER), null, "the default branch has no setup file");
});

test("a setup run the user stops after its commit lands nothing: the card keeps To do with the reason, and the repo stays not set up", { skip }, async () => {
  await init();
  // The mock's setup run keeps working after its commit, so the stop lands between the two.
  fs.writeFileSync(SETUP_SKILL, setupSkillBody("SETUP_SLOW: keep working after the commit."));
  gh.createBare("kevin", "stopped");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/stopped" })).status, 200);
  const s = (await sessionsOf("kevin/stopped"))[0];
  await answerSetupAsk(s.id);

  const worktree = path.join(process.env.DATA_DIR!, "worktrees", s.id);
  try {
    await waitFor(() => {
      try {
        return sh(worktree, "log", "--format=%s", "-1").includes("Set up agent skills");
      } catch {
        return false;
      }
    }, 60_000);
    assert.equal((await api("POST", `/api/sessions/${s.id}/abort`, {})).status, 200);

    const stopped = await waitFor(async () => {
      const sum = await summary(s.id);
      return sum.attention && sum.status !== "running" ? sum : undefined;
    }, 60_000);

    assert.match(stopped.attention, /setup run was stopped/, JSON.stringify(stopped.attention));
    assert.equal(stopped.phase, "setup", "a stopped setup run is not Done");
    assert.equal((await board("kevin/stopped")).find((c) => c.id === s.id)?.column, "todo");
    assert.equal((await repoRow("kevin/stopped")).needsSetup, true, "the repo stays recorded as not set up");
    assert.equal(onMain("kevin", "stopped", SETUP_MARKER), null, "the stopped run's commit did not reach the default branch");
  } finally {
    fs.writeFileSync(SETUP_SKILL, setupSkillBody());
  }
});

test("Abandon clears the repo's record of its setup session, so a later add gets a fresh one", { skip }, async () => {
  await init();
  gh.createBare("kevin", "dropped");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/dropped" })).status, 200);
  const first = (await sessionsOf("kevin/dropped"))[0];

  assert.equal((await api("POST", `/api/sessions/${first.id}/abandon`, {})).status, 200);
  assert.equal((await repoRow("kevin/dropped")).setupSession, null, "the record does not name a session that is gone");

  const again = await api("POST", "/api/repos", { id: "kevin/dropped" });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  const sessions = await sessionsOf("kevin/dropped");
  assert.equal(sessions.length, 1, JSON.stringify(sessions.map((s) => s.title)));
  assert.notEqual(sessions[0].id, first.id);
  assert.equal(again.json.setupSession, sessions[0].id);
});

test("two adds of one repo at once make one setup session", { skip }, async () => {
  await init();
  gh.createBare("kevin", "twice");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/twice" })).status, 200);
  // Drop the first setup session, so the repo has no record to keep and both adds start fresh.
  assert.equal((await api("POST", `/api/sessions/${(await sessionsOf("kevin/twice"))[0].id}/abandon`, {})).status, 200);

  const both = await Promise.all([api("POST", "/api/repos", { id: "kevin/twice" }), api("POST", "/api/repos", { id: "kevin/twice" })]);
  assert.deepEqual(both.map((r) => r.status), [200, 200], JSON.stringify(both.map((r) => r.json)));
  const sessions = await sessionsOf("kevin/twice");
  assert.equal(sessions.length, 1, JSON.stringify(sessions.map((s) => s.title)));
  assert.equal(both[0].json.setupSession, sessions[0].id);
  assert.equal(both[1].json.setupSession, sessions[0].id);
});
