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
import type { Db, RepoRow, SessionRow, TicketRow } from "./db.ts";
import type { GitEnv } from "./git.ts";
import {
  allDone,
  grillPrompt,
  implementPrompt,
  nextTicket,
  type Phase,
  PIPELINE_TOOLS,
  reviewPrompt,
  specPrompt,
  type Ticket,
  ticketsPrompt,
  validateTickets,
} from "./pipeline.ts";
import { waitsOnUser } from "../../shared/pending.ts";
import { getAutoApproveSettings, judgePermission, savedJudgeToken } from "./autoapprove.ts";
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
  /** permission under auto-approve: the risk judge's rating, then why it still waits for the user. */
  judge?: { state: "judging" | "waiting" | "failed"; by: string; rating?: string; note?: string };
  createdAt: number;
};

export type UiResponse = { value?: string; confirmed?: boolean; cancelled?: boolean };

export type Run = { id: string; label: string };

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
  mode: "pipeline" | "direct";
  phase: Phase;
  /** Why the pipeline stopped and waits for the user. */
  attention: string | null;
  grillSummary: string | null;
  spec: string | null;
  specRef: string | null;
  /** The GitHub issue this session solves, e.g. `owner/name#123`; null for plain sessions. */
  issueRef: string | null;
  tickets: Ticket[];
  /** The conversation on screen; ticket runs each have their own. */
  activeRun: string;
  runs: Run[];
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
  /** Arguments of pipeline tool calls in flight, by toolCallId. */
  toolArgs: Map<string, { name: string; args: any }>;
  /** finish_ticket's (or finish_review's) report for the current run, applied when the run settles. */
  finished?: { status: "done" | "blocked"; note: string };
  lastSettleAborted: boolean;
};

/**
 * What the agent is working on: the latest user message. pi expands `/skill:name args` into the
 * skill's whole body followed by the args; the args are the task, so the body is left out.
 */
function latestTask(t: Transcript): { task: string; skill?: string } {
  const m = t.messages.findLast((x) => x.role === "user");
  const text = typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
  // Like pi's own parser, the block ends at a "</skill>" line followed by a blank line or the end.
  const expanded = /^<skill name="([\w-]+)"[^>]*>\n[\s\S]*?\n<\/skill>(?:\n\n|$)/.exec(text);
  const task = expanded ? text.slice(expanded[0].length) : text;
  return { task: task.length > 2000 ? `${task.slice(0, 2000)}…` : task, ...(expanded ? { skill: expanded[1] } : {}) };
}

const SETUP_PROMPT = `/skill:${SETUP_SKILL} This runs automatically on this repository's first pi-workbench session. Ask each of your questions with the ask_user tool, one at a time. When the files are written, commit them on the current branch with the message "Set up agent skills (${SETUP_SKILL})". Do not push.`;

/** Standing instruction appended to every pi system prompt: explanations follow the asd-ste100 skill. */
const EXPLAIN_PROMPT =
  "When you explain, answer, or summarize for the user, write in Simplified Technical English " +
  "following the asd-ste100 skill (load it with the Skill tool, or read its SKILL.md if the tool " +
  "cannot find it) and follow its rules: short active-voice sentences, one idea per sentence, " +
  "one name per thing, no undefined jargon, keep every hedge. " +
  "Code, tool output, and text the user asked for verbatim are exempt.";

const toTicket = (r: TicketRow): Ticket => ({
  num: r.num,
  title: r.title,
  body: r.body,
  blockedBy: JSON.parse(r.blocked_by),
  trackerRef: r.tracker_ref,
  status: r.status as Ticket["status"],
  note: r.note,
  runId: r.run_id,
});

/**
 * Owns every session: its row, its worktree and, while it runs, its `pi --mode rpc` process.
 *
 * A pipeline session moves setup → grill → spec → tickets → implement → review → done. Setup,
 * grill, spec and tickets share the session's main conversation; each ticket and the final review
 * get a fresh pi run (their own pi session id) in the same worktree. `active_run` says which
 * conversation is live and on screen.
 *
 * Events: "summary" (SessionSummary) when list-level state changes; "event" (sessionId, record) for
 * every pi record and for synthetic `wb_*` records; "removed" (sessionId).
 */
export class SessionManager extends EventEmitter {
  private db: Db;
  private secrets: SecretStore;
  private gitEnv: () => Promise<GitEnv>;
  /** Runs before every pi spawn so materialized ssh keys are fresh; the server wires applySsh here. */
  private refreshSsh?: () => void;
  private live = new Map<string, Live>();
  private summaryTimers = new Map<string, NodeJS.Timeout>();

  constructor(db: Db, secrets: SecretStore, gitEnv: () => Promise<GitEnv>, refreshSsh?: () => void) {
    super();
    this.db = db;
    this.secrets = secrets;
    this.gitEnv = gitEnv;
    this.refreshSsh = refreshSsh;
  }

  private row(id: string): SessionRow {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) throw Object.assign(new Error(`Unknown session ${id}`), { status: 404 });
    return row;
  }

  private update(id: string, fields: Partial<SessionRow>) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
      ...keys.map((k) => (fields as any)[k]),
      id,
    );
  }

  tickets(id: string): Ticket[] {
    return (this.db.prepare("SELECT * FROM tickets WHERE session_id = ? ORDER BY num").all(id) as TicketRow[]).map(toTicket);
  }

  private updateTicket(id: string, num: number, fields: Partial<TicketRow>) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE tickets SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE session_id = ? AND num = ?`).run(
      ...keys.map((k) => (fields as any)[k]),
      id,
      num,
    );
  }

  private runOf = (row: SessionRow) => row.active_run ?? row.id;

  private state(id: string): Live {
    let s = this.live.get(id);
    if (!s) {
      s = {
        transcript: emptyTranscript(),
        loaded: false,
        pending: new Map(),
        error: null,
        stderr: [],
        setupRunning: false,
        toolArgs: new Map(),
        lastSettleAborted: false,
      };
      this.live.set(id, s);
    }
    return s;
  }

  private status(s: Live): SessionStatus {
    if (s.starting) return "starting";
    if (!s.proc || s.proc.exited) return s.error ? "error" : "stopped";
    if ([...s.pending.values()].some(waitsOnUser)) return "waiting";
    return s.transcript.busy ? "running" : "idle";
  }

  summary(id: string): SessionSummary {
    const row = this.row(id);
    const s = this.state(id);
    const tickets = this.tickets(id);
    const running = tickets.find((t) => t.status === "running");
    const activity = activityOf(s.transcript);
    return {
      id: row.id,
      repoId: row.repo_id,
      title: row.title,
      branch: row.branch,
      baseBranch: row.base_branch,
      status: this.status(s),
      activity: running && activity ? `#${running.num} · ${activity}` : activity,
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
      mode: row.mode === "pipeline" ? "pipeline" : "direct",
      phase: row.phase as Phase,
      attention: row.attention,
      grillSummary: row.grill_summary,
      spec: row.spec,
      specRef: row.spec_ref,
      issueRef: row.issue_ref,
      tickets,
      activeRun: this.runOf(row),
      runs: [
        { id: row.id, label: row.mode === "pipeline" ? "Plan" : "Conversation" },
        ...tickets.filter((t) => t.runId).map((t) => ({ id: t.runId!, label: `#${t.num} ${t.title}` })),
        ...(row.review_run ? [{ id: row.review_run, label: "Review" }] : []),
      ],
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

  /** A finished or inactive run's conversation, read from its pi session file. */
  runTranscript(id: string, runId: string): Transcript {
    const sum = this.summary(id);
    if (!sum.runs.some((r) => r.id === runId)) throw Object.assign(new Error(`Unknown run ${runId}`), { status: 404 });
    if (runId === sum.activeRun && this.state(id).loaded) return this.state(id).transcript;
    return withMessages(readSessionFile(runId));
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
      s.transcript = withMessages(readSessionFile(this.runOf(this.row(id))));
    }
    s.loaded = true;
  }

  async create(input: { repoId: string; title: string; baseBranch?: string; prompt: string; mode?: string; issueRef?: string }) {
    const repo = getRepo(this.db, input.repoId);
    if (!repo) throw Object.assign(new Error(`Unknown repo ${input.repoId}`), { status: 404 });
    const mode = input.mode === "direct" ? "direct" : "pipeline";
    const task = input.prompt.trim();
    if (mode === "pipeline" && !task) throw Object.assign(new Error("Describe what you want built; grill-me starts from it"), { status: 400 });
    const issueRef = input.issueRef?.trim() || null;
    const id = crypto.randomUUID();
    const title = input.title.trim() || task.split("\n")[0].slice(0, 60) || "New session";
    const base = input.baseBranch?.trim() || repo.default_branch;
    const branch = `pi/${slugify(title)}-${id.slice(0, 6)}`;
    const worktree = await createWorktree(repo, id, branch, base, await this.gitEnv());
    const now = Date.now();
    const needsSetup = worktreeNeedsSetup(worktree);
    const phase: Phase = needsSetup ? "setup" : mode === "pipeline" ? "grill" : "direct";
    this.db
      .prepare(
        `INSERT INTO sessions (id, repo_id, title, branch, base_branch, worktree, created_at, updated_at, held_prompt, mode, phase, active_run, issue_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, repo.id, title, branch, base, worktree, now, now, needsSetup && task ? input.prompt : null, mode, phase, id, issueRef);
    const s = this.state(id);
    s.loaded = true;
    await this.start(id);
    if (needsSetup) {
      s.setupRunning = true;
      await this.send(id, SETUP_PROMPT);
    } else if (mode === "pipeline") {
      await this.send(id, grillPrompt(input.prompt));
    } else if (task) {
      await this.send(id, input.prompt);
    }
    this.emitSummary(id);
    return this.summary(id);
  }

  /** Spawn pi for the session's active run if it isn't running; resumes its saved conversation. */
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
    // A bad ssh materialization must not wedge the session; missing keys surface at connect time.
    try {
      this.refreshSsh?.();
    } catch (err) {
      console.error("ssh key materialization failed:", err);
    }
    const m = getModelSettings(this.db);
    fs.mkdirSync(config.piSessionsDir, { recursive: true });
    const env = await this.processEnv(row.repo_id);
    const runId = this.runOf(row);
    const ticket = this.tickets(id).find((t) => t.runId === runId);
    const label = ticket ? ` · #${ticket.num}` : runId === row.review_run ? " · review" : "";
    s.error = null;
    s.stderr = [];
    const proc = new RpcProcess(
      config.piBin,
      [
        "--session-dir", config.piSessionsDir,
        "--session-id", runId,
        "--name", `${row.title}${label}`,
        "--approve", "--offline",
        "--provider", PROVIDER_ID, "--model", m.modelId,
        "--append-system-prompt", EXPLAIN_PROMPT,
      ],
      { cwd: row.worktree, env },
    );
    s.proc = proc;
    proc.on("record", (rec: RpcRecord) => {
      if (s.proc === proc) this.onRecord(id, s, rec);
    });
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
      PI_WORKBENCH_SKILLS: config.skillsDir,
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
    if (rec.type === "tool_execution_start" && (PIPELINE_TOOLS as readonly string[]).includes(rec.toolName as string)) {
      s.toolArgs.set(rec.toolCallId as string, { name: rec.toolName as string, args: rec.args });
    }
    if (rec.type === "tool_execution_end" && s.toolArgs.has(rec.toolCallId as string)) {
      const call = s.toolArgs.get(rec.toolCallId as string)!;
      s.toolArgs.delete(rec.toolCallId as string);
      if (!rec.isError) {
        try {
          this.onPipelineTool(id, s, call.name, call.args ?? {});
        } catch (err) {
          this.flag(id, `The agent's ${call.name} call was rejected: ${(err as Error).message}`);
        }
      }
    }
    if (rec.type === "agent_settled") {
      this.touch(id);
      s.lastSettleAborted = !!rec.aborted;
      void this.afterSettled(id, s).catch((err) => {
        this.update(id, { attention: `Pipeline error: ${err.message}` });
        this.emitSummary(id, true);
      });
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

  /** Record what the pipeline tools reported; phase changes wait until the run settles. */
  private onPipelineTool(id: string, s: Live, name: string, args: any) {
    const row = this.row(id);
    if (name === "save_grill_summary" && row.phase === "grill" && typeof args.summary === "string") {
      this.update(id, { grill_summary: args.summary.trim() });
    } else if (name === "save_spec" && row.phase === "spec" && typeof args.spec === "string" && args.spec.trim()) {
      this.update(id, { spec: args.spec.trim(), spec_ref: typeof args.trackerRef === "string" ? args.trackerRef : null });
    } else if (name === "record_tickets" && row.phase === "tickets") {
      const tickets = validateTickets(args.tickets);
      this.db.prepare("DELETE FROM tickets WHERE session_id = ?").run(id);
      const insert = this.db.prepare(
        "INSERT INTO tickets (session_id, num, title, body, blocked_by, tracker_ref, status) VALUES (?, ?, ?, ?, ?, ?, 'ready')",
      );
      for (const t of tickets) insert.run(id, t.number, t.title, t.body, JSON.stringify(t.blockedBy), t.trackerRef ?? null);
    } else if (name === "finish_ticket" && row.phase === "implement" && (args.status === "done" || args.status === "blocked")) {
      s.finished = { status: args.status, note: String(args.note ?? "").trim() };
    } else if (name === "finish_review" && row.phase === "review") {
      s.finished = { status: "done", note: String(args.note ?? "").trim() };
    }
    this.emitSummary(id, true);
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
    if (req.kind === "permission" && getAutoApproveSettings(this.db).enabled) {
      req.judge = { state: "judging", by: getAutoApproveSettings(this.db).judge.model };
      void this.autoJudge(id, s, req);
    }
    s.pending.set(req.id, req);
    this.emit("event", id, { type: "wb_pending", pending: [...s.pending.values()] });
    this.emitSummary(id, true);
  }

  /** Put a permission to the risk judge; answer it when it is safe, otherwise leave it for the user. */
  private async autoJudge(id: string, s: Live, req: UiRequest) {
    const row = this.row(id);
    const ticket = this.tickets(id).find((t) => t.status === "running");
    const session = {
      title: row.title,
      ...latestTask(s.transcript),
      repo: row.repo_id,
      worktree: row.worktree,
      ...(ticket ? { ticket: `#${ticket.num} ${ticket.title}` } : {}),
    };
    const verdict = await judgePermission(
      { tool: req.tool ?? "", subject: req.subject ?? "", reasons: req.reasons ?? [], session },
      getAutoApproveSettings(this.db),
      savedJudgeToken(this.secrets),
    );
    // Answered by the user, or dropped with its process or run: the verdict is stale.
    if (!s.pending.has(req.id)) return;
    if (verdict.outcome === "allow") {
      const ev = { type: "wb_auto_answer", requestId: req.id, tool: req.tool, subject: req.subject, answer: "allow", by: verdict.by, detail: verdict.detail, timestamp: Date.now() };
      applyEvent(s.transcript, ev);
      this.emit("event", id, ev);
      this.answer(id, s, req, { type: "extension_ui_response", id: req.id, value: "Allow" });
      return;
    }
    req.judge = verdict.outcome === "user"
      ? { state: "waiting", by: verdict.by, rating: verdict.rating, note: verdict.note }
      : { state: "failed", by: verdict.by, note: verdict.note };
    this.emit("event", id, { type: "wb_pending", pending: [...s.pending.values()] });
    this.emitSummary(id, true);
  }

  /** Write the answer to pi and drop the request; a judgement still running for it finds it gone. */
  private answer(id: string, s: Live, req: UiRequest, record: RpcRecord) {
    s.proc!.write(record);
    s.pending.delete(req.id);
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
    this.answer(id, s, req, record);
  }

  /** Send user text. While the agent runs it steers (or follows up) instead of starting a new run. */
  async send(id: string, message: string, mode: "steer" | "followUp" = "steer") {
    await this.start(id);
    const s = this.state(id);
    const cmd: RpcRecord = { type: "prompt", message };
    if (s.transcript.busy) cmd.streamingBehavior = mode;
    if (this.row(id).attention) {
      this.update(id, { attention: null });
      this.emitSummary(id, true);
    }
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
    this.update(id, { held_prompt: null });
    this.state(id).setupRunning = false;
    this.emit("event", id, { type: "wb_held", heldPrompt: null });
    if (row.mode === "pipeline" && !discard) {
      this.update(id, { phase: "grill" });
      this.emitSummary(id);
      await this.send(id, grillPrompt(row.held_prompt), "followUp");
      return;
    }
    this.update(id, { phase: "direct", mode: "direct" });
    this.emitSummary(id);
    if (!discard) await this.send(id, row.held_prompt, "followUp");
  }

  private async afterSettled(id: string, s: Live) {
    const row = this.row(id);
    if (row.phase === "setup") {
      if (s.setupRunning && !worktreeNeedsSetup(row.worktree)) {
        s.setupRunning = false;
        if (row.held_prompt) await this.releaseHeld(id);
        else this.update(id, { phase: row.mode === "pipeline" ? "grill" : "direct" });
      }
    } else if (row.phase === "grill" && row.grill_summary) {
      this.update(id, { phase: "spec" });
      await this.send(id, specPrompt(), "followUp");
    } else if (row.phase === "spec" && row.spec) {
      this.update(id, { phase: "tickets" });
      await this.send(id, ticketsPrompt(row.spec_ref), "followUp");
    } else if (row.phase === "tickets" && this.tickets(id).length > 0) {
      this.update(id, { phase: "implement" });
      await this.runNext(id);
    } else if (row.phase === "implement") {
      await this.afterTicketRun(id, s);
    } else if (row.phase === "review" && row.review_run === this.runOf(row)) {
      await this.afterReviewRun(id, s);
    }
    this.emitSummary(id, true);
  }

  private async afterTicketRun(id: string, s: Live) {
    const row = this.row(id);
    const ticket = this.tickets(id).find((t) => t.status === "running" && t.runId === this.runOf(row));
    if (!ticket) return;
    const report = s.finished;
    s.finished = undefined;
    if (report?.status === "done") {
      this.updateTicket(id, ticket.num, { status: "done", note: report.note || null, finished_at: Date.now() });
      await this.runNext(id);
    } else if (report?.status === "blocked") {
      this.updateTicket(id, ticket.num, { status: "blocked", note: report.note || null, finished_at: Date.now() });
      this.flag(id, `Ticket #${ticket.num} is blocked: ${report.note || "no reason given"}. Retry it, mark it done, or reply to the agent.`);
    } else if (s.lastSettleAborted) {
      this.flag(id, `Ticket #${ticket.num} was stopped. Reply to continue it, retry it from scratch, or mark it done.`);
    } else {
      this.flag(id, `Ticket #${ticket.num} stopped without finishing. Reply to the agent, retry it, or mark it done.`);
    }
  }

  private async afterReviewRun(id: string, s: Live) {
    const report = s.finished;
    s.finished = undefined;
    if (report) await this.finishPipeline(id, report.note);
    else if (s.lastSettleAborted) this.flag(id, "The review was stopped. Reply to continue it, retry it, or mark it done.");
    else this.flag(id, "The review stopped without finishing. Reply to the agent, retry it, or mark it done.");
  }

  private async finishPipeline(id: string, reviewNote: string | null) {
    // Switch back to the plan conversation before announcing "done", so no one sees done + review run.
    await this.switchRun(id, id, false);
    this.update(id, { phase: "done", attention: null });
    const msg = `All tickets are done and reviewed${reviewNote ? ` (${reviewNote})` : ""}. Create the PR.`;
    this.emit("event", id, { type: "wb_notify", message: msg, level: "info" });
  }

  /** Fresh run for implement-spec's final step: one code-review over the whole branch. */
  private async startReview(id: string) {
    const runId = `${id}-review-${Date.now().toString(36)}`;
    this.update(id, { phase: "review", review_run: runId, attention: null });
    await this.switchRun(id, runId, true);
    const row = this.row(id);
    await this.send(id, reviewPrompt(row.base_branch, row.spec, row.spec_ref, this.tickets(id)));
  }

  /** Start the next unblocked ticket in a fresh run, or move on to the review. */
  private async runNext(id: string) {
    const tickets = this.tickets(id);
    if (allDone(tickets)) {
      await this.startReview(id);
      return;
    }
    const t = nextTicket(tickets);
    if (!t) {
      this.flag(id, "No ticket can start: every remaining ticket waits on a blocked one.");
      return;
    }
    const runId = `${id}-t${t.num}-${Date.now().toString(36)}`;
    this.updateTicket(id, t.num, { status: "running", run_id: runId, started_at: Date.now(), finished_at: null });
    await this.switchRun(id, runId, true);
    const row = this.row(id);
    const finished = this.tickets(id).filter((x) => x.status === "done");
    await this.send(id, implementPrompt({ ...t, runId }, row.spec, row.spec_ref, finished));
  }

  /** Point the session at another pi conversation: stop the current process, swap, tell viewers. */
  private async switchRun(id: string, runId: string, fresh: boolean) {
    const s = this.state(id);
    await this.stop(id);
    s.proc = undefined;
    s.pending.clear();
    s.toolArgs.clear();
    s.finished = undefined;
    s.transcript = emptyTranscript();
    s.loaded = fresh;
    this.update(id, { active_run: runId });
    this.emit("event", id, { type: "wb_run", runId });
    this.emitSummary(id, true);
  }

  private flag(id: string, reason: string) {
    this.update(id, { attention: reason });
    this.emit("event", id, { type: "wb_notify", message: reason, level: "warning" });
  }

  /** User actions on a stopped pipeline: retry or skip the current ticket, or stop the pipeline. */
  async pipelineAction(id: string, action: "retry" | "skip" | "stop") {
    const row = this.row(id);
    if (row.mode !== "pipeline") throw Object.assign(new Error("Not a pipeline session"), { status: 409 });
    const current = this.tickets(id).find((t) => t.status === "running" || t.status === "blocked");
    if (action === "stop") {
      await this.abort(id).catch(() => {});
      this.update(id, { phase: "done", attention: null });
    } else if (row.phase === "review") {
      if (action === "retry") await this.startReview(id);
      else await this.finishPipeline(id, null);
    } else if (row.phase !== "implement") {
      throw Object.assign(new Error("Retry and skip only apply to tickets and the review"), { status: 409 });
    } else if (action === "retry") {
      if (current) this.updateTicket(id, current.num, { status: "ready" });
      this.update(id, { attention: null });
      await this.runNext(id);
    } else if (action === "skip") {
      if (current) this.updateTicket(id, current.num, { status: "done", note: current.note ?? "Marked done by the user.", finished_at: Date.now() });
      this.update(id, { attention: null });
      await this.runNext(id);
    }
    this.emitSummary(id, true);
  }

  async archive(id: string) {
    const row = this.row(id);
    await this.stop(id);
    const repo = getRepo(this.db, row.repo_id);
    if (repo && fs.existsSync(row.worktree)) await removeWorktree(repo, row.worktree);
    this.update(id, { archived: 1, updated_at: Date.now() });
    this.live.delete(id);
    this.emit("removed", id);
  }

  rename(id: string, title: string) {
    this.update(id, { title: title.trim().slice(0, 120) || "Untitled" });
    this.emitSummary(id);
  }

  setPr(id: string, number: number, url: string) {
    this.update(id, { pr_number: number, pr_url: url });
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
    this.update(id, { updated_at: Date.now() });
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

/** Messages of a stopped run, read from pi's JSONL file (linear: workbench runs never branch). */
export function readSessionFile(runId: string): AgentMessage[] {
  const file = findSessionFile(config.piSessionsDir, runId);
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

function findSessionFile(dir: string, runId: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith(`_${runId}.jsonl`)) return p;
    if (e.isDirectory()) {
      const found = findSessionFile(p, runId);
      if (found) return found;
    }
  }
  return undefined;
}
