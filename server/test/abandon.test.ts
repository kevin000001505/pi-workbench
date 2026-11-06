/**
 * Abandon over HTTP: a card's runs stop, its PR closes, its branch and worktree go, and the card
 * leaves the board, while its GitHub issues stay open.
 * Drives the real server (main.ts) on an ephemeral port, with a real `pi --mode rpc` against the
 * scripted mock model and the mock GitHub. Skips when the pi CLI isn't available.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { startReviewServer } from "./review-server.ts";

const { hasPi, base, gh, api, waitFor, summary, board, hasRef, toReview, setup } = await startReviewServer("abandon");

const abandon = (id: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/sessions/${id}/abandon`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => null)) as any }));

/** The board events (repo ids) and removed sessions a WebSocket client hears, from now on. */
async function boardEvents() {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
  const seen: string[] = [];
  const removed: string[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "wb_board") seen.push(msg.repoId);
    if (msg.type === "removed") removed.push(msg.id);
  });
  await new Promise((r) => ws.once("open", r));
  return { seen, removed, close: () => ws.close() };
}

test("Abandon closes the PR, deletes the branch, the worktree and the card, and its spec issue shows in Issues again", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr, worktree, branch } = await toReview(7);
  assert.ok(hasRef(`refs/heads/${branch}`));
  assert.ok(fs.existsSync(worktree));
  assert.ok(!(await board()).some((c) => c.id === "issue:7"), "a claimed spec issue is not an unclaimed card");

  // A request from another site is refused, and changes nothing.
  assert.equal((await abandon(id, { Origin: "http://evil.example" })).status, 403);
  assert.ok((await board()).some((c) => c.id === id));
  assert.equal(pr.state, undefined);

  const events = await boardEvents();
  const r = await abandon(id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(pr.state, "closed", "the PR is closed");
  assert.ok(!pr.merged, "the PR is not merged");
  assert.ok(!hasRef(`refs/heads/${branch}`), "the remote branch is deleted");
  assert.ok(!fs.existsSync(worktree), "the worktree is removed");
  assert.deepEqual(gh.closed, [], "the issues stay open");
  assert.equal((await api("GET", `/api/sessions/${id}`)).status, 404, "the session is deleted");
  assert.ok(!(await api("GET", "/api/sessions")).json.some((s: any) => s.id === id));
  const cards = await board();
  assert.ok(!cards.some((c) => c.id === id), "the card is off the board");
  assert.deepEqual(cards.find((c) => c.id === "issue:7"), { id: "issue:7", title: "Spec 7", column: "issues", tickets: { done: 0, total: 1 }, attention: null, pr: null, specRef: "https://github.com/kevin/ship/issues/7", doneAt: null, specCard: true, subs: null });
  await waitFor(() => events.seen.includes("kevin/ship"), 5_000);
  await waitFor(() => events.removed.includes(id), 5_000);
  events.close();

  assert.equal((await abandon(id)).status, 404, "an abandoned card is gone");
});

test("Abandon stops a running card that has no PR and no branch on GitHub", { skip: !hasPi && "pi CLI not found" }, async () => {
  await setup();
  const s = (await api("POST", "/api/sessions", { repoId: "kevin/ship", title: "Drop me", prompt: "add a farewell" })).json;
  const worktree = path.join(process.env.DATA_DIR!, "worktrees", s.id);
  // The grill waits on its first question: the run is live.
  await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "decision"));
  const pulls = gh.pulls.length;
  const r = await abandon(s.id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(gh.pulls.length, pulls);
  assert.ok(!fs.existsSync(worktree));
  assert.equal((await api("GET", `/api/sessions/${s.id}`)).status, 404);
  assert.ok(!(await board()).some((c) => c.id === s.id));
});

test("Abandon takes a Done card off the board and leaves its merged PR alone", { skip: !hasPi && "pi CLI not found" }, async () => {
  const { id, pr } = await toReview(27);
  const ok = await api("POST", `/api/sessions/${id}/approve`, {});
  assert.equal(ok.json?.phase, "done", JSON.stringify(ok.json));
  const r = await abandon(id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(pr.merged, true);
  assert.equal(pr.state, undefined, "a merged PR is not closed again");
  assert.ok(!(await board()).some((c) => c.id === id));
});
