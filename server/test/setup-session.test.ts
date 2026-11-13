/**
 * Setup when a repo is added (issue #99): adding a repo that is not set up starts one session that
 * runs only the agent-skills setup skill, so setup shows on the board and its questions reach the
 * user. Drives the real server (main.ts) over HTTP with a real `pi --mode rpc` against the scripted
 * mock model and the mock GitHub. Skips when the pi CLI isn't available.
 *
 * Seams under test: the HTTP API the UI uses (POST /api/repos, POST /api/repos/create,
 * GET /api/sessions, GET /api/sessions/:id, GET /api/board, POST /api/sessions/:id/respond) and the
 * db migration that gives an older database the repos.setup_session column (unit.test.ts).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { startReviewServer } from "./review-server.ts";

const { hasPi, tmp, base, gh, api, waitFor, summary, board, llm } = await startReviewServer("setup-session");const skip = !hasPi && "pi CLI not found";
// Read src modules only after startReviewServer set the environment (a static import would snapshot
// process.env too early, see review-server.ts).
const { SETUP_MARKER } = await import("../src/config.ts");

/** What setup-matt-pocock-skills commits: the marker the recorded setup state was read from. */
const ISSUE_TRACKER_DOC = "# Issue tracker\n\nGitHub Issues.\n";

/** This test file's copy of the setup skill. Its body carries SETUP_ASK, which the mock model reads
 * as "this setup asks the user a question first". */
fs.writeFileSync(
  path.join(tmp, "skills", "setup-matt-pocock-skills", "SKILL.md"),
  `---\nname: setup-matt-pocock-skills\ndescription: setup-matt-pocock-skills test skill\n---\nSETUP_ASK: ask which issue tracker the repo uses, then write the files.\n`,
);

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
