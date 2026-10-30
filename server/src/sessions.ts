import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
  activityOf,
  type AgentMessage,
  applyEvent,
  emptyTranscript,
  type Transcript,
  withMessages,
} from "../../shared/transcript.ts";
import { config, PROVIDER_ID, SETUP_SKILL } from "./config.ts";
import type { Db, RepoRow, SessionRow } from "./db.ts";
import type { GitEnv } from "./git.ts";
import { createWorktree, getRepo, removeWorktree, slugify, worktreeNeedsSetup } from "./repos.ts";
import type { SecretStore } from "./secrets.ts";
import { getModelSettings, LLM_KEY_ENV, rulesFile } from "./settings.ts";
import { type RpcRecord, RpcProcess } from "./rpc.ts";

export type SessionStatus = "stopped" | "starting" | "running" | "waiting" | "idle" | "error";

export type UiRequest = {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  kind: "permission" | "decision" | "generic";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** permission: the gated tool call. */
  tool?: string;
  subject?: string;
  reasons?: string[];
  createdAt: number;
};

export type UiResponse = { value?: string; confirmed?: boolean; cancelled?: boolean };

export type SessionSummary = {
  id: string;
  repoId: string;
  title: string;
  branch: string;
  baseBranch: string;
  status: SessionStatus;
  activity: string;
  pending: UiRequest[];
  heldPrompt: string | null;
  setupRunning: boolean;
  contextTokens: number;
  contextWindow: number;
  prNumber: number | null;
  prUrl: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

type Live = {
  proc?: RpcProcess;
  starting?: Promise<void>;
  transcript: Transcript;
  /** False until messages were loaded from pi or its session file. */
  loaded: boolean;
  pending: Map<string, UiRequest>;
  error: string | null;
  stderr: string[];
  setupRunning: boolean;
};

const SETUP_PROMPT = `/skill:${SETUP_SKILL} This runs automatically on this repository's first pi-workbench session. Ask each of your questions with the ask_user tool, one at a time. When the files are written, commit them on the current branch with the message "Set up agent skills (${SETUP_SKILL})". Do not push.`;

/**
 * Owns every session: its row, its worktree and, while it runs, its `pi --mode rpc` process.
 *
 * Events: "summary" (SessionSummary) when list-level state changes; "event" (sessionId, record) for
 * every pi record and for synthetic `wb_pending` / `wb_held` records.
 */
export class SessionManager extends EventEmitter {
  private db: Db;
  private secrets: SecretStore;
  private gitEnv: () => Promise<GitEnv>;
  private live = new Map<string, Live>();
  private summaryTimers = new Map<string, NodeJS.Timeout>();

  constructor(db: Db, secrets: SecretStore, gitEnv: () => Promise<GitEnv>) {
    super();
    this.db = db;
    this.secrets = secrets;
    this.gitEnv = gitEnv;
  }

  private row(id: string): SessionRow {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) throw Object.assign(new Error(`Unknown session ${id}`), { status: 404 });
    return row;
  }

  private state(id: string): Live {
    let s = this.live.get(id);
    if (!s) {
      s = { transcript: emptyTranscript(), loaded: false, pending: new Map(), error: null, stderr: [], setupRunning: false };
      this.live.set(id, s);
    }
    return s;
  }

  private status(s: Live): SessionStatus {
    if (s.starting) return "starting";
    if (!s.proc || s.proc.exited) return s.error ? "error" : "stopped";
    if (s.pending.size > 0) return "waiting";
    return s.transcript.busy ? "running" : "idle";
  }

  summary(id: string): SessionSummary {
    const row = this.row(id);
    const s = this.state(id);
    return {
      id: row.id,
      repoId: row.repo_id,
      title: row.title,
      branch: row.branch,
      baseBranch: row.base_branch,
      status: this.status(s),
      activity: activityOf(s.transcript),
      pending: [...s.pending.values()],
      heldPrompt: row.held_prompt,
      setupRunning: s.setupRunning,
      contextTokens: s.transcript.contextTokens,
      contextWindow: getModelSettings(this.db).contextWindow,
      prNumber: row.pr_number,
      prUrl: row.pr_url,
      error: s.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): SessionSummary[] {
    const rows = this.db.prepare("SELECT id FROM sessions WHERE archived = 0 ORDER BY updated_at DESC").all() as { id: string }[];
    return rows.map((r) => this.summary(r.id));
  }

  /** Everything a new viewer needs; live events continue from here. */
  async snapshot(id: string) {
    const s = this.state(id);
    if (!s.loaded) await this.load(id, s);
    return { summary: this.summary(id), transcript: s.transcript, stderr: s.stderr.slice(-20) };
  }

  private async load(id: string, s: Live) {
    if (s.proc && !s.proc.exited) {
      const data = await s.proc.call<{ messages: AgentMessage[] }>({ type: "get_messages" });
      const busy = s.transcript.busy;
      const tools = s.transcript.tools;
      const streaming = s.transcript.streaming;
      s.transcript = withMessages(data.messages);
      Object.assign(s.transcript, { busy, tools, streaming });
    } else {
      s.transcript = withMessages(readSessionFile(id));
    }
    s.loaded = true;
  }

  async create(input: { repoId: string; title: string; baseBranch?: string; prompt: string }) {
    const repo = getRepo(this.db, input.repoId);
    if (!repo) throw Object.assign(new Error(`Unknown repo ${input.repoId}`), { status: 404 });
    const id = crypto.randomUUID();
    const title = input.title.trim() || input.prompt.trim().split("\n")[0].slice(0, 60) || "New session";
    const base = input.baseBranch?.trim() || repo.default_branch;
    const branch = `pi/${slugify(title)}-${id.slice(0, 6)}`;
    const worktree = await createWorktree(repo, id, branch, base, await this.gitEnv());
    const now = Date.now();
    const needsSetup = worktreeNeedsSetup(worktree);
    this.db
      .prepare(
        `INSERT INTO sessions (id, repo_id, title, branch, base_branch, worktree, created_at, updated_at, held_prompt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, repo.id, title, branch, base, worktree, now, now, needsSetup && input.prompt.trim() ? input.prompt : null);
    const s = this.state(id);
    s.loaded = true;
    await this.start(id);
    if (needsSetup) {
      s.setupRunning = true;
      await this.send(id, SETUP_PROMPT);
    } else if (input.prompt.trim()) {
      await this.send(id, input.prompt);
    }
    this.emitSummary(id);
    return this.summary(id);
  }

  /** Spawn pi for the session if it isn't running; resumes its saved conversation. */
  async start(id: string) {
    const s = this.state(id);
    if (s.proc && !s.proc.exited) return;
    if (s.starting) return s.starting;
    s.starting = this.spawn(id, s).finally(() => {
      s.starting = undefined;
      this.emitSummary(id);
    });
    this.emitSummary(id);
    return s.starting;
  }

  private async spawn(id: string, s: Live) {
    const row = this.row(id);
    if (!fs.existsSync(row.worktree)) throw new Error(`Worktree ${row.worktree} is gone`);
    const m = getModelSettings(this.db);
    fs.mkdirSync(config.piSessionsDir, { recursive: true });
    const env = await this.processEnv(row.repo_id);
    s.error = null;
    s.stderr = [];
    const proc = new RpcProcess(
      config.piBin,
      ["--session-dir", config.piSessionsDir, "--session-id", id, "--name", row.title, "--approve", "--offline", "--provider", PROVIDER_ID, "--model", m.modelId],
      { cwd: row.worktree, env },
    );
    s.proc = proc;
    proc.on("record", (rec: RpcRecord) => this.onRecord(id, s, rec));
    proc.on("stderr", (text: string) => {
      for (const line of text.split("\n")) if (line.trim()) s.stderr.push(line);
      if (s.stderr.length > 200) s.stderr.splice(0, s.stderr.length - 200);
    });
    proc.on("exit", (code: number | null, signal: string | null) => {
      if (s.proc !== proc) return;
      s.pending.clear();
      s.transcript.busy = false;
      s.transcript.streaming = null;
      s.transcript.tools = {};
      s.setupRunning = false;
      if (code !== 0 && signal !== "SIGTERM" && !proc.stopping) {
        s.error = `pi exited (${signal ?? `code ${code}`}): ${s.stderr.slice(-3).join(" | ") || "no output"}`;
      }
      this.emit("event", id, { type: "wb_exit", code, signal, error: s.error });
      this.emitSummary(id);
    });
    // The first command doubles as a readiness check: pi answers once its runtime is up.
    await proc.call({ type: "get_state" }, 120_000).catch((err) => {
      s.error = `pi did not start: ${err.message}. ${s.stderr.slice(-3).join(" | ")}`;
      proc.stop(1000);
      throw new Error(s.error);
    });
    if (!s.loaded) await this.load(id, s);
  }

  private async processEnv(repoId: string): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.WORKBENCH_MASTER_KEY;
    const secrets = this.secrets.envFor(repoId);
    Object.assign(env, await this.gitEnv(), {
      PI_CODING_AGENT_DIR: config.piAgentDir,
      PI_WORKBENCH_RULES: rulesFile(),
      [LLM_KEY_ENV]: "none",
      ...secrets,
    });
    if (secrets.GITHUB_TOKEN && !secrets.GH_TOKEN) env.GH_TOKEN = secrets.GITHUB_TOKEN;
    return env;
  }

  private onRecord(id: string, s: Live, rec: RpcRecord) {
    if (rec.type === "extension_ui_request") {
      this.onUiRequest(id, s, rec);
      return;
    }
    applyEvent(s.transcript, rec);
    this.emit("event", id, rec);
    if (rec.type === "agent_settled") {
      this.touch(id);
      void this.afterSettled(id, s);
    }
    if (
      rec.type === "agent_start" ||
      rec.type === "agent_settled" ||
      rec.type === "tool_execution_start" ||
      rec.type === "tool_execution_end" ||
      rec.type === "message_start" ||
      rec.type === "message_end"
    ) {
      this.emitSummary(id);
    }
  }

  private onUiRequest(id: string, s: Live, rec: RpcRecord) {
    const method = rec.method as string;
    if (method === "notify") {
      this.emit("event", id, { type: "wb_notify", message: rec.message, level: rec.notifyType ?? "info" });
      return;
    }
    if (!["select", "confirm", "input", "editor"].includes(method)) return;
    const req: UiRequest = {
      id: String(rec.id),
      method: method as UiRequest["method"],
      kind: "generic",
      title: String(rec.title ?? ""),
      message: rec.message as string | undefined,
      options: rec.options as string[] | undefined,
      placeholder: rec.placeholder as string | undefined,
      prefill: rec.prefill as string | undefined,
      createdAt: Date.now(),
    };
    const envelope = parseEnvelope(req.title);
    if (envelope?.wb === "permission") {
      Object.assign(req, { kind: "permission", title: `Run ${envelope.tool}?`, tool: envelope.tool, subject: envelope.subject, reasons: envelope.reasons });
    } else if (envelope?.wb === "decision") {
      Object.assign(req, { kind: "decision", title: String(envelope.question ?? "") });
    }
    s.pending.set(req.id, req);
    this.emit("event", id, { type: "wb_pending", pending: [...s.pending.values()] });
    this.emitSummary(id, true);
  }

  respond(id: string, requestId: string, response: UiResponse) {
    const s = this.state(id);
    const req = s.pending.get(requestId);
    if (!req || !s.proc) throw Object.assign(new Error("That request is no longer pending"), { status: 409 });
    const record: RpcRecord = { type: "extension_ui_response", id: requestId };
    if (response.cancelled) record.cancelled = true;
    else if (req.method === "confirm") record.confirmed = !!response.confirmed;
    else record.value = response.value ?? "";
    s.proc.write(record);
    s.pending.delete(requestId);
    this.emit("event", id, { type: "wb_pending", pending: [...s.pending.values()] });
    this.emitSummary(id, true);
  }

  /** Send user text. While the agent runs it steers (or follows up) instead of starting a new run. */
  async send(id: string, message: string, mode: "steer" | "followUp" = "steer") {
    await this.start(id);
    const s = this.state(id);
    const cmd: RpcRecord = { type: "prompt", message };
    if (s.transcript.busy) cmd.streamingBehavior = mode;
    this.touch(id);
    return s.proc!.call<{ disposition: string }>(cmd);
  }

  async abort(id: string) {
    const s = this.state(id);
    if (s.proc && !s.proc.exited) await s.proc.call({ type: "abort" }, 30_000);
  }

  async stop(id: string) {
    const s = this.state(id);
    if (s.proc && !s.proc.exited) {
      s.proc.stopping = true;
      await s.proc.stop();
    }
  }

  /** Release the task held back for setup, now (user asked) or once setup committed its marker file. */
  async releaseHeld(id: string, discard = false) {
    const row = this.row(id);
    if (!row.held_prompt) return;
    this.db.prepare("UPDATE sessions SET held_prompt = NULL WHERE id = ?").run(id);
    this.state(id).setupRunning = false;
    this.emit("event", id, { type: "wb_held", heldPrompt: null });
    this.emitSummary(id);
    if (!discard) await this.send(id, row.held_prompt, "followUp");
  }

  private async afterSettled(id: string, s: Live) {
    const row = this.row(id);
    if (s.setupRunning && !worktreeNeedsSetup(row.worktree)) {
      s.setupRunning = false;
      if (row.held_prompt) await this.releaseHeld(id).catch((err) => (s.error = err.message));
      this.emitSummary(id);
    }
  }

  async archive(id: string) {
    const row = this.row(id);
    await this.stop(id);
    const repo = getRepo(this.db, row.repo_id);
    if (repo && fs.existsSync(row.worktree)) await removeWorktree(repo, row.worktree);
    this.db.prepare("UPDATE sessions SET archived = 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
    this.live.delete(id);
    this.emit("removed", id);
  }

  rename(id: string, title: string) {
    this.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title.trim().slice(0, 120) || "Untitled", id);
    this.emitSummary(id);
  }

  setPr(id: string, number: number, url: string) {
    this.db.prepare("UPDATE sessions SET pr_number = ?, pr_url = ? WHERE id = ?").run(number, url, id);
    this.emitSummary(id);
  }

  repoOf(id: string): { row: SessionRow; repo: RepoRow } {
    const row = this.row(id);
    const repo = getRepo(this.db, row.repo_id);
    if (!repo) throw new Error(`Repo ${row.repo_id} was removed`);
    return { row, repo };
  }

  async shutdown() {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id).catch(() => {})));
  }

  private touch(id: string) {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  /** Coalesce summary pushes (streaming would otherwise send one per token); `now` skips the wait. */
  private emitSummary(id: string, now = false) {
    const flush = () => {
      this.summaryTimers.delete(id);
      try {
        this.emit("summary", this.summary(id));
      } catch {}
    };
    if (now) {
      clearTimeout(this.summaryTimers.get(id));
      flush();
    } else if (!this.summaryTimers.has(id)) {
      this.summaryTimers.set(id, setTimeout(flush, 250));
    }
  }
}

function parseEnvelope(title: string): Record<string, any> | null {
  if (!title.startsWith("{")) return null;
  try {
    const v = JSON.parse(title);
    return v && typeof v === "object" && typeof v.wb === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Messages of a stopped session, read from pi's JSONL file (linear: workbench sessions never branch). */
export function readSessionFile(id: string): AgentMessage[] {
  const file = findSessionFile(config.piSessionsDir, id);
  if (!file) return [];
  const messages: AgentMessage[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message) messages.push(entry.message);
    } catch {}
  }
  return messages;
}

function findSessionFile(dir: string, id: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith(`_${id}.jsonl`)) return p;
    if (e.isDirectory()) {
      const found = findSessionFile(p, id);
      if (found) return found;
    }
  }
  return undefined;
}
