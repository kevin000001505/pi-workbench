/**
 * The Repos page's agent-skills setup state over HTTP (issue #102): the repo view states what the
 * page reads — `set_up`, `in_progress` while the repo's setup session runs its setup, or
 * `not_set_up` — and **Run setup** starts that session for a repo that is not set up, refusing with
 * 409 while one already runs, so no repo runs the setup twice. The recorded state itself, the
 * add-time session, and the setup commit's landing are `setup-once.test.ts`, `setup-session.test.ts`
 * and `setup-push.test.ts`. Skips when the pi CLI isn't available.
 *
 * Seam under test: the HTTP API the Repos page uses — GET /api/repos (its `setup` and `setupSession`
 * fields), POST /api/repos/:owner/:name/setup, POST /api/sessions/:id/abandon, GET /api/board.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { startReviewServer } from "./review-server.ts";
import { ISSUE_TRACKER_DOC } from "./remote-repo.ts";

const { hasPi, tmp, base, gh, api, waitFor, summary, board, llm } = await startReviewServer("repo-setup");
const skip = !hasPi && "pi CLI not found";
// Read src modules only after startReviewServer set the environment (a static import would snapshot
// process.env too early, see review-server.ts).
const { SETUP_MARKER } = await import("../src/config.ts");

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

/** This test file's copy of the setup skill: SETUP_ASK makes the run ask a question first, so the
 * state stays "in progress" while a test reads it. SETUP_SLOW keeps the run open after its commit. */
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

const repoView = async (repoId: string) => ((await api("GET", "/api/repos")).json as any[]).find((r) => r.id === repoId);
const sessionsOf = async (repoId: string) => ((await api("GET", "/api/sessions")).json as any[]).filter((s) => s.repoId === repoId);
/** The repo's setup session, through the record on its row — the same read the page's state makes. */
async function setupSessionOf(repoId: string) {
  const id = (await repoView(repoId)).setupSession;
  return id ? (await api("GET", `/api/sessions/${id}`)).json.summary : undefined;
}
/** Answer the setup skill's question, so its run can go on. */
async function answerSetupAsk(id: string) {
  const ask = await waitFor(async () => (await summary(id)).pending.find((p: any) => p.kind === "decision"), 20_000);
  assert.equal((await api("POST", `/api/sessions/${id}/respond`, { requestId: ask.id, value: ask.options[0] })).status, 200);
}
const runSetup = (repoId: string) => api("POST", `/api/repos/${repoId}/setup`, {});

test("the repo view states skills set up for a repo that carries the setup files, and setup in progress while its setup session runs", { skip }, async () => {
  await init();

  // A repo whose default branch carries the setup files: the page states it as set up, with no setup session.
  gh.createBare("kevin", "statesetup", { [SETUP_MARKER]: ISSUE_TRACKER_DOC });
  assert.equal((await api("POST", "/api/repos", { id: "kevin/statesetup" })).status, 200);
  const setUp = await repoView("kevin/statesetup");
  assert.equal(setUp.setup, "set_up");
  assert.equal(setUp.setupSession, null);

  // A repo that is not set up: its setup session already runs, so the page states setup in progress.
  gh.createBare("kevin", "stateprogress");
  const added = await api("POST", "/api/repos", { id: "kevin/stateprogress" });
  assert.equal(added.status, 200);
  assert.equal(added.json.setup, "in_progress", "the add starts the setup session, and it works now");
  assert.ok(added.json.setupSession, JSON.stringify(added.json));
  const running = await setupSessionOf("kevin/stateprogress");
  assert.equal(running.title, "Set up agent skills");
  assert.equal(running.phase, "setup");
  assert.equal(running.heldPrompt, null, "the setup session holds no task");
  assert.equal(running.setupRunning, true);
  assert.equal((await board("kevin/stateprogress")).find((c) => c.id === running.id)?.column, "todo", "its card is on the board");
});

test("the repo view states not set up when no setup session runs its setup", { skip }, async () => {
  await init();
  gh.createBare("kevin", "statenone");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/statenone" })).status, 200);
  const first = (await setupSessionOf("kevin/statenone"))!;

  // Abandon the setup card: no session runs the setup, so the page states the repo as not set up.
  assert.equal((await api("POST", `/api/sessions/${first.id}/abandon`, {})).status, 200);
  const repo = await repoView("kevin/statenone");
  assert.equal(repo.setup, "not_set_up");
  assert.equal(repo.setupSession, null, "the record does not name a session that is gone");
});

test("Run setup starts the setup session of a repo recorded as not set up, and refuses with 409 while that session works", { skip }, async () => {
  await init();
  gh.createBare("kevin", "runsetup");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/runsetup" })).status, 200);
  const first = (await setupSessionOf("kevin/runsetup"))!;
  assert.equal((await api("POST", `/api/sessions/${first.id}/abandon`, {})).status, 200);
  assert.equal((await repoView("kevin/runsetup")).setup, "not_set_up");

  const started = await runSetup("kevin/runsetup");
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.equal(started.json.title, "Set up agent skills");
  assert.equal(started.json.phase, "setup");
  assert.equal(started.json.heldPrompt, null);

  // The page states what that session is doing, and its card is on the repo's board.
  assert.equal((await repoView("kevin/runsetup")).setup, "in_progress");
  assert.equal((await repoView("kevin/runsetup")).setupSession, started.json.id);
  const card = await waitFor(async () => (await board("kevin/runsetup")).find((c) => c.id === started.json.id));
  assert.equal(card.column, "todo");

  // A second Run setup while that session works: refused, and it starts no second session.
  const again = await runSetup("kevin/runsetup");
  assert.equal(again.status, 409, JSON.stringify(again.json));
  assert.match(again.json.error, /kevin\/runsetup/);
  assert.equal((await sessionsOf("kevin/runsetup")).length, 1);
});

test("Run setup refuses with 409 for a repo the workbench recorded as set up", { skip }, async () => {
  await init();
  gh.createBare("kevin", "runsetupdone", { [SETUP_MARKER]: ISSUE_TRACKER_DOC });
  assert.equal((await api("POST", "/api/repos", { id: "kevin/runsetupdone" })).json.setup, "set_up");

  const refused = await runSetup("kevin/runsetupdone");
  assert.equal(refused.status, 409, JSON.stringify(refused.json));
  assert.match(refused.json.error, /already set up/);
  assert.deepEqual(await sessionsOf("kevin/runsetupdone"), [], "no setup session for a repo that is set up");
});

test("two Run setup taps at once start one setup session, and refuse the other", { skip }, async () => {
  await init();
  gh.createBare("kevin", "runtwice");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/runtwice" })).status, 200);
  assert.equal((await api("POST", `/api/sessions/${(await setupSessionOf("kevin/runtwice"))!.id}/abandon`, {})).status, 200);

  const both = await Promise.all([runSetup("kevin/runtwice"), runSetup("kevin/runtwice")]);
  assert.deepEqual(
    both.map((r) => r.status).sort(),
    [200, 409],
    JSON.stringify(both.map((r) => r.json)),
  );
  const sessions = await sessionsOf("kevin/runtwice");
  assert.equal(sessions.length, 1, JSON.stringify(sessions.map((s) => s.title)));
  assert.equal((await repoView("kevin/runtwice")).setupSession, sessions[0].id);
});

test("Run setup keeps the repo's stopped setup card: it refuses with 409 and names that card", { skip }, async () => {
  await init();
  // The mock's setup run keeps working after its commit, so the stop lands between the two.
  fs.writeFileSync(SETUP_SKILL, setupSkillBody("SETUP_SLOW: keep working after the commit."));
  gh.createBare("kevin", "runstopped");
  assert.equal((await api("POST", "/api/repos", { id: "kevin/runstopped" })).status, 200);
  const s = (await setupSessionOf("kevin/runstopped"))!;
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

    // The repo is not set up, and its setup card is still there: Run setup keeps it rather than start a second one.
    assert.equal((await repoView("kevin/runstopped")).setup, "not_set_up");
    const refused = await runSetup("kevin/runstopped");
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.match(refused.json.error, /setup card/, JSON.stringify(refused.json));
    assert.equal((await sessionsOf("kevin/runstopped")).length, 1, "Run setup started no second setup session");

    // Abandoning that card frees the repo, and Run setup starts a fresh setup session.
    assert.equal((await api("POST", `/api/sessions/${s.id}/abandon`, {})).status, 200);
    const again = await runSetup("kevin/runstopped");
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.notEqual(again.json.id, s.id);
  } finally {
    fs.writeFileSync(SETUP_SKILL, setupSkillBody());
  }
});
