/**
 * A ticket's Ticket skill tags over HTTP (issue #121): the user changes them on the card, the route
 * applies the same rules the tickets step applies, and the Board states them. Drives the real server
 * (main.ts) on an ephemeral port, in the shape of the skill source route test: the skill library is
 * installed through its own routes, from a local git source cloned through `file://`.
 *
 * The card and its tickets are seeded rows: this feature is a write to a ticket that already exists,
 * and no pi run is needed to change its tags.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { startMockGitHub } from "./mock-github.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-ticket-tags-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "ticket-tags-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");
process.env.OPTIONAL_SKILLS_DIR = path.join(tmp, "optional-skills");
process.env.HOME = path.join(tmp, "agent-home");
process.env.PI_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-extension", "workbench.ts");

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A port nothing listens on, so this test can start its own server on it. */
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

// The mock GitHub stands in for the API the board load reads, so a tag change can be read back on a card.
const gh = await startMockGitHub(path.join(tmp, "gh"), "me");
process.env.GITHUB_API_URL = gh.url;

// Import after the env is set: main.ts reads config on load and starts the server.
await import("../src/main.ts");
const { config } = await import("../src/config.ts");
const { openDb } = await import("../src/db.ts");

const api = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

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

const db = openDb(config.dbFile);

/** The library's skills, in a git source the server clones the way the Skills page does. */
const skillSource = path.join(tmp, "skill-source");
for (const name of ["design-rules", "copy-desk", "a11y-check", "switched-off"]) {
  fs.mkdirSync(path.join(skillSource, name), { recursive: true });
  fs.writeFileSync(path.join(skillSource, name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill from the library.\n---\n${name} body\n`);
}
sh(skillSource, "init", "-q", "-b", "main");
sh(skillSource, "add", ".");
sh(skillSource, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "the library's skills");

/** The repo, its card and its tickets, as rows: no pi run is needed to change a ticket's tags. */
function seedCard(id: string, tickets: { num: number; title: string }[], extra: Record<string, unknown> = {}) {
  db.prepare("INSERT OR IGNORE INTO repos (id, owner, name, default_branch, private, added_at, setup_state) VALUES ('me/app','me','app','main',1,0,'set_up')").run();
  db.prepare(
    "INSERT INTO sessions (id, repo_id, title, branch, base_branch, worktree, created_at, updated_at, mode, phase) VALUES (?, 'me/app', ?, 'b', 'main', ?, 0, 0, 'pipeline', 'ready')",
  ).run(id, "Greeting suite", path.join(tmp, `worktree-${id}`));
  for (const [key, value] of Object.entries(extra)) db.prepare(`UPDATE sessions SET ${key} = ? WHERE id = ?`).run(value as any, id);
  for (const t of tickets) db.prepare("INSERT INTO tickets (session_id, num, title, body) VALUES (?, ?, ?, ?)").run(id, t.num, t.title, `${t.title} body`);
  return id;
}

/** The library through its own route: one git source, its installed skills by name. */
async function library() {
  const added = await api("POST", "/api/skill-sources", { url: `file://${skillSource}` });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const byName = new Map<string, string>(added.json.skills.map((s: any) => [s.name, s.id]));
  return { sourceId: added.json.id, skills: byName };
}

after(() => {
  gh.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.kill(process.pid, "SIGTERM");
});

await waitReady();
// The board load reads the repo's open issues on GitHub, so the mock token is saved first.
assert.equal((await api("PUT", "/api/secrets", { scope: "global", name: "GITHUB_TOKEN", value: "ghp_test" })).status, 200);
const lib = await library();
const setTags = (card: string, num: number, skills: unknown) => api("PATCH", `/api/sessions/${card}/tickets/${num}/skills`, { skills });

test("one route sets a ticket's tags, answers with the stored ticket, and the session's ticket list states the same tags", async () => {
  const card = seedCard("tag-card", [
    { num: 1, title: "Write hello.txt" },
    { num: 2, title: "Add a test" },
  ]);

  const r = await setTags(card, 1, ["design-rules"]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // The answer is the stored ticket: its tags are the library's identifiers, and the names beside them.
  assert.equal(r.json.ticket.num, 1);
  assert.deepEqual(r.json.ticket.skills, [lib.skills.get("design-rules")]);
  assert.deepEqual(r.json.ticket.skillTags, ["design-rules"]);

  // The outside read of the same card states the tags too, on the ticket the user looks at.
  const listed = await api("GET", "/api/sessions");
  const summary = listed.json.find((s: any) => s.id === card);
  assert.deepEqual(summary.tickets.map((t: any) => t.skillTags), [["design-rules"], []]);
  assert.deepEqual(summary.tickets.map((t: any) => t.skills), [[lib.skills.get("design-rules")], []]);
});

test("the route applies the tickets step's rules: a fourth tag is refused with the cap named, and a name the library holds no switched-on skill for is dropped and named back", async () => {
  const card = seedCard("tag-rules", [
    { num: 1, title: "Write hello.txt" },
    { num: 2, title: "Add a test" },
  ]);

  // A fourth tag is refused, the reason names the cap, and nothing is stored: the ticket keeps what it had.
  await setTags(card, 1, ["design-rules"]);
  const four = await setTags(card, 1, ["design-rules", "copy-desk", "a11y-check", "switched-off"]);
  assert.equal(four.status, 400, JSON.stringify(four.json));
  assert.match(four.json.error, /at most 3 skill tags/, JSON.stringify(four.json));
  assert.match(four.json.error, /names 4/, "the refusal states how many tags were named");
  const afterFour = (await api("GET", "/api/sessions")).json.find((s: any) => s.id === card).tickets[0];
  assert.deepEqual(afterFour.skillTags, ["design-rules"], "the refused call stored nothing");

  // A name the library holds no switched-on skill for is dropped and named back; the rest is stored.
  // `switched-off` is an installed skill the user has switched off, so it is not a name to tag with.
  const off = await api("PATCH", `/api/skill-sources/${lib.sourceId}/skills/${lib.skills.get("switched-off")}`, { enabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  const dropped = await setTags(card, 2, ["copy-desk", "switched-off", "not-in-the-library"]);
  assert.equal(dropped.status, 200, JSON.stringify(dropped.json));
  assert.deepEqual(dropped.json.dropped, ["switched-off", "not-in-the-library"], "every name outside the taggable skills is named back");
  assert.deepEqual(dropped.json.ticket.skillTags, ["copy-desk"], "the tags the card carries are the names the library holds");
  assert.deepEqual(dropped.json.ticket.skills, [lib.skills.get("copy-desk")]);

  // The cap counts names, not duplicates: the same name twice is one tag.
  const twice = await setTags(card, 2, ["copy-desk", "copy-desk", "a11y-check"]);
  assert.equal(twice.status, 200, JSON.stringify(twice.json));
  assert.deepEqual(twice.json.ticket.skillTags, ["copy-desk", "a11y-check"], "each name is stored once");

  // An empty list clears the ticket's tags; a body that is not a list of names is refused.
  const cleared = await setTags(card, 2, []);
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.deepEqual(cleared.json.ticket.skillTags, []);
  assert.deepEqual(cleared.json.ticket.skills, []);
  assert.equal((await setTags(card, 2, "design-rules")).status, 400, "a tag list is a list");

  // No such ticket, and no such card: refused, and the card keeps its tags.
  assert.equal((await setTags(card, 9, ["design-rules"])).status, 409);
  assert.equal((await setTags("no-such-card", 1, ["design-rules"])).status, 404);
});

test("a skill attached to no pipeline place is still a name a ticket can be tagged with, and the switch decides the names, not a tag already stored", async () => {
  const card = seedCard("tag-any-skill", [{ num: 1, title: "Write hello.txt" }]);

  // design-rules is attached to nothing: an installed skill reaches a ticket through its tag, whatever
  // place the skill is attached to.
  const r = await setTags(card, 1, ["design-rules"]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.ticket.skillTags, ["design-rules"]);

  // Switch it off on the Skills page's route: the ticket keeps the tag it carries, because the stored
  // tag is an identifier (issue #119) and a tagged skill reaches its ticket's runs whatever the switch
  // says (issue #120). Switching off is not un-tagging.
  const off = await api("PATCH", `/api/skill-sources/${lib.sourceId}/skills/${lib.skills.get("design-rules")}`, { enabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  const stated = (await api("GET", "/api/sessions")).json.find((s: any) => s.id === card).tickets[0];
  assert.deepEqual(stated.skillTags, ["design-rules"], "a tag the card carries keeps its name");
  assert.deepEqual(stated.skills, [lib.skills.get("design-rules")], "and its stored identifier");

  // What the switch decides is the names a ticket may be tagged with now: on a ticket that does not
  // carry the off skill it is dropped and named back.
  const other = seedCard("tag-off-add", [{ num: 1, title: "Write the panel" }]);
  const added = await setTags(other, 1, ["copy-desk", "switched-off"]);
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.deepEqual(added.json.dropped, ["switched-off"], "a switched-off skill is no longer a name to add");
  assert.deepEqual(added.json.ticket.skillTags, ["copy-desk"]);

  // On a ticket that already carries it, the tag survives the switch and a save: saving never drops a
  // tag behind the user's back.
  const retagged = await setTags(card, 1, ["design-rules", "copy-desk"]);
  assert.equal(retagged.status, 200, JSON.stringify(retagged.json));
  assert.deepEqual(retagged.json.dropped, [], "the tag the ticket carries is kept");
  assert.deepEqual(retagged.json.ticket.skillTags, ["design-rules", "copy-desk"], "in the order the user chose");

  // Switch it on again: it is a name to tag with again.
  const on = await api("PATCH", `/api/skill-sources/${lib.sourceId}/skills/${lib.skills.get("design-rules")}`, { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  const again = await setTags(card, 1, ["design-rules"]);
  assert.deepEqual(again.json.dropped, []);
  assert.deepEqual(again.json.ticket.skillTags, ["design-rules"]);
});

/** The board events a WebSocket client hears, from now on. */
async function boardEvents() {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
  const seen: string[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "wb_board") seen.push(msg.repoId);
  });
  await new Promise((r) => ws.once("open", r));
  return { seen, close: () => ws.close() };
}

async function waitFor<T>(fn: () => T | undefined | false, ms = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("the Board's card carries the tag names beside the ticket list that names the same tags, and a tag change tells the repo's boards to read again", async () => {
  const card = seedCard("tag-board", [
    { num: 1, title: "Write the panel" },
    { num: 2, title: "Add a test" },
  ]);
  const events = await boardEvents();

  const r = await setTags(card, 1, ["design-rules", "a11y-check"]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // The repo's boards are told: every open Board fetches GET /api/board again, so its card states the tags.
  await waitFor(() => events.seen.includes("me/app"));

  const cards = (await api("GET", "/api/board?repo=me/app")).json.cards as any[];
  const c = cards.find((x) => x.id === card);
  assert.ok(c, "the card is on the board");
  // Only the ticket that carries tags has an entry, so a sub-card shows a chip only for it.
  assert.deepEqual(c.ticketTags, [{ num: 1, names: ["design-rules", "a11y-check"] }], "the card names its tagged ticket's skills, in the ticket's own order");

  // The two reads agree: the same names on the ticket list the card detail reads.
  const summary = (await api("GET", "/api/sessions")).json.find((s: any) => s.id === card);
  assert.deepEqual(summary.tickets.map((t: any) => t.skillTags), [["design-rules", "a11y-check"], []]);

  // A card whose tickets carry no tags carries no tag names at all.
  const plain = seedCard("untagged-board", [{ num: 1, title: "Write hello.txt" }]);
  const plainCard = (await api("GET", "/api/board?repo=me/app")).json.cards.find((x: any) => x.id === plain);
  assert.deepEqual(plainCard.ticketTags, []);

  events.close();
});
