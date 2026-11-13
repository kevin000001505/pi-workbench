/**
 * The server the Review-card tests (approve, abandon) drive: the real server (main.ts) on an
 * ephemeral port, with a real `pi --mode rpc` against the scripted mock model and the mock GitHub,
 * and helpers that bring a card to Review with its PR open. Call it once, at a test file's top
 * level: it sets the process environment and imports main.ts (only when the pi CLI is there).
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { startMockGitHub } from "./mock-github.ts";
import { startMockLlm } from "./mock-llm.ts";

export async function startReviewServer(name: string) {
  const piBin = process.env.PI_BIN ?? "pi";
  const hasPi = spawnSync(piBin, ["--version"]).status === 0;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `wb-${name}-`));
  const remotes = path.join(tmp, "remotes");
  fs.mkdirSync(remotes);
  process.env.DATA_DIR = path.join(tmp, "data");
  process.env.WORKBENCH_MASTER_KEY = `${name}-master-key-0123456789`;
  process.env.SKILLS_DIR = path.join(tmp, "skills");
  process.env.HOME = path.join(tmp, "agent-home");
  process.env.GITHUB_CLONE_BASE = `file://${remotes}`;
  process.env.PI_BIN = piBin;
  process.env.PI_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-extension", "workbench.ts");

  // Skills the pipeline invokes; pi expands /skill:name from these.
  for (const skill of ["grill-with-docs", "to-spec", "to-tickets", "tdd", "code-review", "resolving-merge-conflicts", "setup-matt-pocock-skills"]) {
    fs.mkdirSync(path.join(process.env.SKILLS_DIR, skill), { recursive: true });
    fs.writeFileSync(path.join(process.env.SKILLS_DIR, skill, "SKILL.md"), `---\nname: ${skill}\ndescription: ${skill} test skill\n---\n${skill} body\n`);
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

  async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 60_000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - start > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const summary = async (id: string) => (await api("GET", `/api/sessions/${id}`)).json.summary;

  const board = async (repo = "kevin/ship") => {
    const r = await api("GET", `/api/board?repo=${repo}`);
    assert.equal(r.status, 200);
    return r.json.cards as any[];
  };
  const columnOf = async (id: string) => (await board()).find((c) => c.id === id)?.column;

  after(async () => {
    await mock.close();
    await gh.close();
    // main.ts's SIGTERM handler stops the sessions and exits, after the TAP is out.
    if (hasPi) process.kill(process.pid, "SIGTERM");
  });

  const bare = path.join(remotes, "kevin", "ship.git");
  const hasRef = (ref: string) => {
    try {
      execFileSync("git", ["rev-parse", "--verify", "-q", ref], { cwd: bare, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  };

  let ready: Promise<void> | undefined;
  /** The repo every test ships to; `develop` is a second, non-default base branch. */
  function setup() {
    ready ??= (async () => {
      await waitFor(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok);
      assert.equal((await api("PUT", "/api/secrets", { scope: "global", name: "GITHUB_TOKEN", value: "ghp_test" })).status, 200);
      assert.equal((await api("PUT", "/api/settings/model", { baseUrl: mock.url })).status, 200);
      gh.createBare("kevin", "ship");
      execFileSync("git", ["branch", "develop", "main"], { cwd: bare });
      assert.equal((await api("POST", "/api/repos", { id: "kevin/ship" })).status, 200);
    })();
    return ready;
  }

  /** A card solved from spec issue `spec` with one ticket issue `spec + 1`, driven to Review with its PR open. */
  async function toReview(spec: number, baseBranch?: string) {
    await setup();
    gh.seedSubIssues("kevin", "ship", { number: spec, title: `Spec ${spec}`, body: "## Solution\nhello.txt says Hello." }, [
      { number: spec + 1, title: "Write hello.txt", body: "Create hello.txt containing Hello." },
    ]);
    const s = (await api("POST", "/api/sessions", { repoId: "kevin/ship", title: `Spec ${spec}`, issueRef: `kevin/ship#${spec}`, mode: "pipeline", startFrom: "tickets", baseBranch })).json;
    assert.ok(s.id, JSON.stringify(s));
    // The review's `git push` waits on a permission.
    const perm = await waitFor(async () => (await summary(s.id)).pending.find((p: any) => p.kind === "permission"), 120_000);
    assert.equal((await api("POST", `/api/sessions/${s.id}/respond`, { requestId: perm.id, value: perm.options[0] })).status, 200);
    const card = await waitFor(async () => (await board()).find((c) => c.id === s.id && c.column === "review"), 120_000);
    await waitFor(async () => (await summary(s.id)).status !== "running");
    const pr = gh.pulls.find((p) => p.number === card.pr.number);
    return { id: s.id as string, pr, worktree: path.join(process.env.DATA_DIR!, "worktrees", s.id), branch: (await summary(s.id)).branch as string };
  }

  // `llm` is the mock model: a test that sets the model itself reads its url.
  return { hasPi, tmp, base, gh, api, waitFor, summary, board, columnOf, bare, hasRef, setup, toReview, llm: mock };
}
