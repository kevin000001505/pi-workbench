import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
  activityOf,
  type AgentMessage,
  applyEvent,
  emptyTranscript,
  type RpcEvent,
  type Transcript,
  withAutoAnswers,
  withMessages,
} from "../../shared/transcript.ts";
import { config, PROVIDER_ID, SETUP_SKILL, TYPESAFE_SKILL } from "./config.ts";
import type { Db, RepoRow, SessionRow, TicketRow } from "./db.ts";
import { git, type GitEnv } from "./git.ts";
import type { Delivery, MergeResult } from "./delivery.ts";
import { closedIssues, foreignIssues } from "./prs.ts";
import {
  allDone,
  type Diagnosis,
  fixPrompt,
  grillPrompt,
  reworkPrompt,
  implementPrompt,
  mergePrompt,
  RESCUES_PER_SPEC,
  rescuePrompt,
  retroPrompt,
  nextTicket,
  isStartFrom,
  START_PLANS,
  type StartFrom,
  type Phase,
  PIPELINE_TOOLS,
  reviewPrompt,
  specPrompt,
  type Ticket,
  type TicketInput,
  type TicketSeed,
  ticketsPrompt,
  validateDiagnosis,
  validateTickets,
} from "./pipeline.ts";
import { waitsOnUser } from "../../shared/pending.ts";
import { claimRefs, type Column, COLUMNS, issueNumberOf, resolvedNote, sessionColumn } from "../../shared/board.ts";
import {
  type AutoApproveSettings,
  configureAutoApprove,
  getAutoApproveSettings,
  judgeName,
  judgePermission,
  localJudge,
  reviewPermission,
  reviewerName,
  savedJudgeToken,
  savedReviewerKey,
  transcriptExcerpt,
  type ReviewContext,
} from "./autoapprove.ts";
import { createWorktree, getRepo, listRepos, removeWorktree, slugify, worktreeNeedsSetup } from "./repos.ts";
import { loadSshHosts } from "./ssh.ts";
import type { SecretStore } from "./secrets.ts";
import { getModelSettings, getPipelineSettings, LLM_KEY_ENV, rulesFile } from "./settings.ts";
import { describeStopReason, type StopReason, StopRule } from "./stop-rule.ts";
import { type RpcRecord, RpcProcess } from "./rpc.ts";
import { isRescueyRun, RESCUE_PROVIDER_ID, RESCUE_TOKEN_ENV, type RescueProxy } from "./rescue-proxy.ts";

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
  /** permission under auto-approve: the reviewer's pass over a call the judge did not rate safe. */
  review?: { state: "reviewing" | "escalated" | "failed"; by?: string; note?: string };
  /** compatibility shape used by newer UI/test paths. */
  reviewer?: { state: "reviewing" | "waiting" | "failed"; by: string; note?: string };
  createdAt: number;
};

/** A session's auto-approve setting: follow the global switch, or override it. */
export type AutoApproveMode = "inherit" | "on" | "off";

const autoApproveMode = (v: unknown): AutoApproveMode => {
  if (v === undefined || v === null || v === "inherit") return "inherit";
  if (v === "on" || v === "off") return v;
  throw Object.assign(new Error(`Auto-approve must be inherit, on or off (got ${String(v)})`), { status: 400 });
};

export type UiResponse = { value?: string; confirmed?: boolean; cancelled?: boolean };

export type Run = { id: string; label: string };

/** What POST /api/sessions (and an unclaimed card's move) asks SessionManager.create for. */
export type CreateInput = { repoId: string; title: string; baseBranch?: string; prompt: string; mode?: string; issueRef?: string; autoApprove?: unknown; typesafeSkill?: unknown; startFrom?: StartFrom; soloTicket?: number };

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
  reviewNote: string | null;
  /** When the card last reached Done. */
  doneAt: number | null;
  /** The GitHub issue this session solves, e.g. `owner/name#123`; null for plain sessions. */
  issueRef: string | null;
  /** The ticket Solve one ticket runs now; null for a card running every ticket (Solve all) or none. */
  soloTicket: number | null;
  /** The session's own auto-approve setting, and whether auto-approve is in effect for it now. */
  autoApprove: AutoApproveMode;
  autoApproveActive: boolean;
  /** Whether the session loads the TypeSafe skill, and whether that skill is missing from this install. */
  typesafeSkill: boolean;
  typesafeSkillMissing: boolean;
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
  /** Auto-approve judgements and reviews in flight, by request id; aborting one hangs up its call and drops its verdict. */
  reviews: Map<string, AbortController>;
  error: string | null;
  stderr: string[];
  setupRunning: boolean;
  /** Arguments of pipeline tool calls in flight, by toolCallId. */
  toolArgs: Map<string, { name: string; args: any }>;
  /** finish_ticket's (or finish_review's, or finish_merge's) report for the current run, applied when the run settles. */
  finished?: { status: "done" | "blocked"; note: string };
  lastSettleAborted: boolean;
  /** finish_diagnosis's report for the current rescue run, applied when the run settles. */
  diagnosis?: Diagnosis;
  /** The worktree's HEAD and status when a rescue or retro run started; it must leave them as found. */
  runBase?: { runId: string; worktree: string };
  /** finish_retro's report for the retro run, applied when the run settles. */
  retroReport?: string;
  /** The review's note, kept for the done message while the retro runs. */
  reviewNote?: string | null;
  /** The stop rule watching the live implement-phase run, and its clock. */
  watch?: { rule: StopRule; timer: NodeJS.Timeout };
  /** The missing-TypeSafe-skill toast went out; the summary keeps showing the state after it. */
  warnedMissingSkill?: boolean;
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
  rescueState: (r.rescue_state as Ticket["rescueState"]) ?? null,
  rescueRunId: r.rescue_run_id,
  fixRunId: r.fix_run_id,
});

/** The worktree as git sees it: HEAD and the porcelain status. A rescue run must leave it unchanged. */
async function worktreeState(dir: string) {
  return `${(await git(dir, ["rev-parse", "HEAD"])).trim()}\n${await git(dir, ["status", "--porcelain", "--untracked-files=all"])}`;
}

/**
 * Owns every session: its row, its worktree and, while it runs, its `pi --mode rpc` process.
 *
 * A pipeline session moves setup → grill → spec → tickets → ready → implement → review → done. Setup,
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
  /** Fetches a spec issue's ticket sub-issues for sessions started from the Issues page; the server wires GitHub here. */
  private fetchTicketSeed?: (ref: string) => Promise<TicketSeed>;
  /** The localhost proxy rescue and retro runs call the Reviewer model through (ADR 0003). */
  private rescueProxy?: RescueProxy;
  /** Delivers a reviewed card to GitHub (opens its PR); the server wires it from the token and model settings. */
  private delivery?: Delivery;
  private live = new Map<string, Live>();
  private summaryTimers = new Map<string, NodeJS.Timeout>();
  /** Sessions whose Approve is in flight, so a second click does not merge twice. */
  private approving = new Set<string>();
  /** Sessions whose merge run resolves a conflict now; Approve waits for it to finish. */
  private resolving = new Set<string>();
  /** Issues (`owner/name#n`) whose new session is being created now. */
  private claiming = new Set<string>();

  constructor(db: Db, secrets: SecretStore, gitEnv: () => Promise<GitEnv>, refreshSsh?: () => void, fetchTicketSeed?: (ref: string) => Promise<TicketSeed>, rescueProxy?: RescueProxy, delivery?: Delivery) {
    super();
    this.db = db;
    this.secrets = secrets;
    this.gitEnv = gitEnv;
    this.refreshSsh = refreshSsh;
    this.fetchTicketSeed = fetchTicketSeed;
    this.rescueProxy = rescueProxy;
    this.delivery = delivery;
  }

  private row(id: string): SessionRow {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) throw Object.assign(new Error(`Unknown session ${id}`), { status: 404 });
    return row;
  }

  private update(id: string, fields: Partial<SessionRow>) {
    // Every way into Done stamps when it happened, for the board's Done history.
    if (fields.phase === "done" && fields.done_at === undefined) fields = { ...fields, done_at: Date.now() };
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
        reviews: new Map(),
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
      reviewNote: row.review_note,
      doneAt: row.done_at,
      issueRef: row.issue_ref,
      soloTicket: row.solo_ticket ?? null,
      autoApprove: autoApproveMode(row.auto_approve),
      autoApproveActive: this.autoApproveActive(row),
      typesafeSkill: row.typesafe_skill === 1,
      typesafeSkillMissing: this.typesafeSkillMissing(row),
      tickets,
      activeRun: this.runOf(row),
      runs: [
        { id: row.id, label: row.mode === "pipeline" ? "Plan" : "Conversation" },
        ...tickets.flatMap((t) => [
          ...(t.runId ? [{ id: t.runId, label: `#${t.num} ${t.title}` }] : []),
          ...(t.rescueRunId ? [{ id: t.rescueRunId, label: `#${t.num} rescue` }] : []),
          ...(t.fixRunId ? [{ id: t.fixRunId, label: `#${t.num} fix` }] : []),
        ]),
        ...(row.review_run ? [{ id: row.review_run, label: "Review" }] : []),
        ...(row.merge_run ? [{ id: row.merge_run, label: "Merge" }] : []),
        ...(row.retro_run ? [{ id: row.retro_run, label: "retro" }] : []),
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
    return withAutoAnswers(withMessages(readSessionFile(runId)), this.autoAnswers(id, runId));
  }

  /** The automatic answers stored for one run, oldest first. */
  private autoAnswers(id: string, runId: string): RpcEvent[] {
    const rows = this.db.prepare("SELECT event FROM auto_decisions WHERE session_id = ? AND run_id = ? ORDER BY created_at").all(id, runId) as { event: string }[];
    return rows.map((r) => JSON.parse(r.event));
  }

  /** Show an automatic answer live and store it for the run, so reloads, restarts and past runs keep it. */
  private autoAnswered(id: string, s: Live, ev: RpcEvent) {
    this.db
      .prepare("INSERT OR REPLACE INTO auto_decisions (session_id, run_id, request_id, event, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, this.runOf(this.row(id)), String(ev.requestId), JSON.stringify(ev), ev.timestamp);
    applyEvent(s.transcript, ev);
    this.emit("event", id, ev);
  }

  private async load(id: string, s: Live) {
    const runId = this.runOf(this.row(id));
    if (s.proc && !s.proc.exited) {
      const data = await s.proc.call<{ messages: AgentMessage[] }>({ type: "get_messages" });
      const busy = s.transcript.busy;
      const tools = s.transcript.tools;
      const streaming = s.transcript.streaming;
      s.transcript = withMessages(data.messages);
      Object.assign(s.transcript, { busy, tools, streaming });
    } else {
      s.transcript = withMessages(readSessionFile(runId));
    }
    withAutoAnswers(s.transcript, this.autoAnswers(id, runId));
    s.loaded = true;
  }

  /**
   * A new session. A pipeline session whose issue ref names an issue of its repo claims it: a
   * second one for an issue that a card works on already (see claimRefs) is refused with 409.
   */
  async create(input: CreateInput) {
    const repo = getRepo(this.db, input.repoId);
    if (!repo) throw Object.assign(new Error(`Unknown repo ${input.repoId}`), { status: 404 });
    const number = issueNumberOf(input.issueRef?.trim() || null, repo.id);
    if (number === null || input.mode === "direct") return this.createSession(input, repo);
    const claim = `${repo.id.toLowerCase()}#${number}`;
    const claimed = claimRefs(this.list().filter((s) => s.repoId === repo.id)).some((r) => issueNumberOf(r, repo.id) === number);
    if (this.claiming.has(claim) || claimed) throw Object.assign(new Error(`A card already works on issue #${number}.`), { status: 409 });
    // Held from the check until the session row exists, so a second create for the issue is refused.
    this.claiming.add(claim);
    try {
      return await this.createSession(input, repo);
    } finally {
      this.claiming.delete(claim);
    }
  }

  private async createSession(input: CreateInput, repo: RepoRow) {
    const autoApprove = autoApproveMode(input.autoApprove);
    // Absent or null means no, as null means inherit for autoApprove.
    if (input.typesafeSkill != null && typeof input.typesafeSkill !== "boolean") {
      throw Object.assign(new Error("The TypeSafe skill choice must be true or false"), { status: 400 });
    }
    const typesafe = input.typesafeSkill === true;
    if (typesafe && !fs.existsSync(path.join(typesafeSkillDir(), "SKILL.md"))) {
      throw Object.assign(new Error(`The TypeSafe skill is not installed (expected at ${typesafeSkillDir()})`), { status: 400 });
    }
    const mode = input.mode === "direct" ? "direct" : "pipeline";
    // Unclaimed card moves start a session from the issue; START_PLANS picks its phase, its
    // tickets, its held prompt and its spec bookkeeping. A spec card to Doing solves its
    // tickets; to To do reworks it. A plain card to Doing is Solve (the issue is the card's
    // only ticket); to To do is Split (to-tickets on the issue).
    const startFrom = isStartFrom(input.startFrom) ? input.startFrom : undefined;
    const plan = startFrom ? START_PLANS[startFrom] : undefined;
    if (startFrom && input.mode === "direct")
      throw Object.assign(new Error("Solving an issue needs a pipeline session"), { status: 400 });
    const task = (input.prompt ?? "").trim();
    if (mode === "pipeline" && !task && !startFrom) throw Object.assign(new Error("Describe what you want built; grill-me starts from it"), { status: 400 });
    const issueRef = input.issueRef?.trim() || null;
    if (startFrom) {
      if (!issueRef) throw Object.assign(new Error("Solving an issue needs its issue ref (issueRef)"), { status: 400 });
      if (!this.fetchTicketSeed) throw Object.assign(new Error("This workbench has no GitHub connection to read tickets from"), { status: 400 });
    }
    // The issue's title, body, URL and parent, and its ticket sub-issues, for startFrom sessions.
    let seed: TicketSeed | undefined;
    if (startFrom) {
      seed = await this.fetchTicketSeed!(issueRef!);
      if (plan!.needsSubIssues && seed.subIssues.length === 0)
        throw Object.assign(new Error(`Issue ${issueRef} has no open ticket sub-issues`), { status: 404 });
      if (!plan!.needsSubIssues && seed.subIssues.length > 0)
        throw Object.assign(new Error(`Issue ${issueRef} already has open ticket sub-issues; move it to Doing to solve them as a spec.`), { status: 409 });
    }
    const id = crypto.randomUUID();
    const title = input.title.trim() || task.split("\n")[0].slice(0, 60) || seed?.spec.title.slice(0, 120) || "New session";
    const base = input.baseBranch?.trim() || repo.default_branch;
    const branch = `pi/${slugify(title)}-${id.slice(0, 6)}`;
    const worktree = await createWorktree(repo, id, branch, base, await this.gitEnv());
    const now = Date.now();
    const needsSetup = worktreeNeedsSetup(worktree);
    if (plan?.tickets && seed) {
      let ticketInputs: TicketInput[];
      try {
        ticketInputs = plan.tickets(seed);
      } catch (err) {
        throw Object.assign(new Error(`${(err as Error).message} (from the tickets of ${issueRef})`), { status: 400 });
      }
      this.insertTickets(id, ticketInputs);
    }
    const phase: Phase = needsSetup ? "setup" : plan ? plan.phase : mode === "pipeline" ? "grill" : "direct";
    // The first prompt; a setup run holds it until setup is done. A rework holds its rework
    // prompt, a split its split prompt, a plain task the task itself; Solve holds nothing
    // (its recorded ticket starts the run after setup).
    const held = plan?.held ? plan.held(seed!) : task ? input.prompt : null;
    // The phase releaseHeld moves the session to when a held prompt is released.
    const heldPhase = held ? (plan ? plan.phase : mode === "pipeline" ? "grill" : "direct") : null;
    this.db
      .prepare(
        `INSERT INTO sessions (id, repo_id, title, branch, base_branch, worktree, created_at, updated_at, held_prompt, mode, phase, active_run, issue_ref, auto_approve, typesafe_skill, spec, spec_ref, held_phase, solo_ticket)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, repo.id, title, branch, base, worktree, now, now, needsSetup ? held : null, mode, phase, id, issueRef, autoApprove === "inherit" ? null : autoApprove, typesafe ? 1 : 0, plan?.spec ? (seed?.spec.body ?? null) : null, startFrom ? (seed?.spec.htmlUrl ?? null) : null, needsSetup ? heldPhase : null, input.soloTicket ?? null);
    const s = this.state(id);
    s.loaded = true;
    await this.start(id);
    if (needsSetup) {
      s.setupRunning = true;
      await this.send(id, SETUP_PROMPT);
    } else if (plan?.tickets) {
      // grill/spec/tickets are skipped: the first ticket run starts now.
      await this.runNext(id);
    } else if (plan?.held) {
      await this.send(id, held!);
    } else if (mode === "pipeline") {
      await this.send(id, grillPrompt(input.prompt));
    } else if (task) {
      await this.send(id, input.prompt);
    }
    this.emitSummary(id);
    // A new session is a new card on its repo's board (a direct session is a card in Doing).
    this.emit("board", repo.id);
    return this.summary(id);
  }

  /** Record the session's tickets, fresh and ready. */
  private insertTickets(id: string, inputs: TicketInput[]) {
    const insert = this.db.prepare(
      "INSERT INTO tickets (session_id, num, title, body, blocked_by, tracker_ref, status) VALUES (?, ?, ?, ?, ?, ?, 'ready')",
    );
    for (const t of inputs) insert.run(id, t.number, t.title, t.body, JSON.stringify(t.blockedBy), t.trackerRef ?? null);
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
    const extraSkills = this.extraSkillDirs(id);
    // pi starts without a --skill dir it cannot find, and says nothing: say it here (the summary shows it too).
    if (this.typesafeSkillMissing(row) && !s.warnedMissingSkill) {
      s.warnedMissingSkill = true;
      const message = `The TypeSafe skill is not installed (expected at ${typesafeSkillDir()}); this session runs without it.`;
      this.emit("event", id, { type: "wb_notify", message, level: "warning" });
    }
    const env = await this.processEnv(row.repo_id);
    // The extension's Skill tool looks there too, so only these sessions can load them.
    if (extraSkills.length) env.PI_WORKBENCH_EXTRA_SKILLS = extraSkills.join(path.delimiter);
    const runId = this.runOf(row);
    // Rescue and retro runs call the Reviewer model through the rescue proxy: the run gets a
    // per-run token in its environment only, and the Reviewer key stays in the server (ADR 0003).
    const rescuey = !!this.rescueProxy && isRescueyRun(runId);
    let provider = PROVIDER_ID;
    let modelId = m.modelId;
    if (rescuey) {
      const reviewer = getAutoApproveSettings(this.db).reviewer;
      const key = savedReviewerKey(this.secrets);
      provider = RESCUE_PROVIDER_ID;
      modelId = reviewer.model;
      // Point the proxy at the Reviewer as saved now, so a re-saved URL or key applies to the next run.
      this.rescueProxy!.configure({ baseUrl: reviewer.baseUrl, provider: reviewer.provider, key: key.reviewerKey, keyOrigin: key.keyOrigin });
      env[RESCUE_TOKEN_ENV] = this.rescueProxy!.mint(runId);
    }
    const ticket = this.tickets(id).find((t) => [t.runId, t.rescueRunId, t.fixRunId].includes(runId));
    const kind = ticket?.rescueRunId === runId ? " rescue" : ticket?.fixRunId === runId ? " fix" : "";
    const label = ticket
      ? ` · #${ticket.num}${kind}`
      : runId === row.review_run ? " · review" : runId === row.retro_run ? " · retro" : runId === row.merge_run ? " · merge" : "";
    s.error = null;
    s.stderr = [];
    const proc = new RpcProcess(
      config.piBin,
      [
        "--session-dir", config.piSessionsDir,
        "--session-id", runId,
        "--name", `${row.title}${label}`,
        "--approve", "--offline",
        "--provider", provider, "--model", modelId,
        "--append-system-prompt", EXPLAIN_PROMPT,
        ...extraSkills.flatMap((dir) => ["--skill", dir]),
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
      // The run is gone: its rescue token stops working, so a leaked one is useless.
      if (rescuey) this.rescueProxy!.revoke(runId);
      if (s.proc !== proc) return;
      this.dropReviews(s);
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

  private typesafeSkillMissing = (row: SessionRow) => row.typesafe_skill === 1 && !fs.existsSync(path.join(typesafeSkillDir(), "SKILL.md"));

  /** Skill dirs only this session loads, next to the global ones: the TypeSafe skill, when picked. */
  extraSkillDirs(id: string): string[] {
    return this.row(id).typesafe_skill === 1 ? [typesafeSkillDir()] : [];
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
    if (rec.type === "tool_execution_start" && s.watch) {
      const reason = s.watch.rule.toolCall(rec.toolName as string, rec.args);
      if (reason) this.stopRuleFired(id, s, reason);
    }
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
      this.insertTickets(id, tickets);
      this.update(id, { rework_tickets: 0 });
    } else if (name === "finish_ticket" && row.phase === "implement" && (args.status === "done" || args.status === "blocked")) {
      s.finished = { status: args.status, note: String(args.note ?? "").trim() };
    } else if (name === "finish_diagnosis" && row.phase === "implement") {
      s.diagnosis = validateDiagnosis(args);
    } else if (name === "finish_retro" && row.phase === "retro" && typeof args.report === "string" && args.report.trim()) {
      s.retroReport = args.report.trim();
    } else if (name === "finish_review" && row.phase === "review") {
      s.finished = { status: "done", note: String(args.note ?? "").trim() };
    } else if (name === "finish_merge" && row.phase === "pr" && row.merge_run === this.runOf(row) && (args.status === "resolved" || args.status === "failed")) {
      s.finished = { status: args.status === "resolved" ? "done" : "blocked", note: String(args.note ?? "").trim() };
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
    if (req.kind === "permission" && this.autoApproveActive(this.row(id))) {
      req.judge = { state: "judging", by: judgeName(getAutoApproveSettings(this.db).judge) };
      const review = new AbortController();
      s.reviews.set(req.id, review);
      void this.autoJudge(id, s, req, review.signal).finally(() => {
        if (s.reviews.get(req.id) === review) s.reviews.delete(req.id);
      });
    }
    s.pending.set(req.id, req);
    this.emit("event", id, { type: "wb_pending", pending: [...s.pending.values()] });
    this.emitSummary(id, true);
  }

  /** Put a permission to the risk judge; answer it when it is safe, otherwise send it to the reviewer or leave it for the user. */
  private async autoJudge(id: string, s: Live, req: UiRequest, cancelled: AbortSignal) {
    const row = this.row(id);
    const settings = getAutoApproveSettings(this.db);
    const ticket = this.tickets(id).find((t) => t.status === "running");
    const session = {
      title: row.title,
      ...latestTask(s.transcript),
      repo: row.repo_id,
      worktree: row.worktree,
      ...(ticket ? { ticket: `#${ticket.num} ${ticket.title}` } : {}),
    };
    const permission = { tool: req.tool ?? "", subject: req.subject ?? "", reasons: req.reasons ?? [], session };
    const verdict = await judgePermission(permission, settings, savedJudgeToken(this.secrets), localJudge(this.db, this.secrets), cancelled);
    // Answered by the user, dropped with its process or run, or cancelled: the verdict is stale.
    if (cancelled.aborted || !s.pending.has(req.id)) return;
    if (verdict.outcome === "allow") {
      this.autoAnswered(id, s, { type: "wb_auto_answer", requestId: req.id, tool: req.tool, subject: req.subject, answer: "allow", by: verdict.by, detail: verdict.detail, timestamp: Date.now() });
      this.answer(id, s, req, { type: "extension_ui_response", id: req.id, value: "Allow" });
      return;
    }
    if (verdict.outcome === "failed") {
      req.judge = { state: "failed", by: verdict.by, note: verdict.note };
      this.emit("event", id, { type: "wb_pending", pending: [...s.pending.values()] });
      this.emitSummary(id, true);
      return;
    }
    // The judge did not rate it safe. Without a configured reviewer the card waits with the rating, as before.
    const reviewerKey = savedReviewerKey(this.secrets);
    if (!settings.reviewer.model || !reviewerKey.reviewerKey) {
      req.judge = { state: "waiting", by: verdict.by, rating: verdict.rating, note: verdict.note };
      this.emit("event", id, { type: "wb_pending", pending: [...s.pending.values()] });
      this.emitSummary(id, true);
      return;
    }
    req.judge = { state: "waiting", by: verdict.by, rating: verdict.rating, note: verdict.note };
    req.review = { state: "reviewing", by: reviewerName(settings) };
    req.reviewer = { state: "reviewing", by: reviewerName(settings) };
    this.emit("event", id, { type: "wb_pending", pending: [...s.pending.values()] });
    this.emitSummary(id, true);
    const rv = await reviewPermission(permission, this.reviewContext(id, s, row, verdict), settings, reviewerKey, cancelled);
    // Answered by the user, dropped with its process or run, or cancelled: the verdict is stale.
    if (cancelled.aborted || !s.pending.has(req.id)) return;
    if (rv.outcome === "allow" || rv.outcome === "deny") {
      this.autoAnswered(id, s, { type: "wb_auto_answer", requestId: req.id, tool: req.tool, subject: req.subject, answer: rv.outcome, by: rv.by, detail: rv.reason, timestamp: Date.now() });
      // A deny answers with the envelope the extension turns into a reviewer-deny block.
      this.answer(id, s, req, { type: "extension_ui_response", id: req.id, value: rv.outcome === "allow" ? "Allow" : JSON.stringify({ wb: "deny", by: rv.by, reason: rv.reason }) });
      return;
    }
    // An escalation or a reviewer failure: the card waits for the user with the note.
    req.review = { state: rv.outcome === "escalate" ? "escalated" : "failed", by: rv.by, note: rv.outcome === "escalate" ? rv.reason : rv.note };
    req.reviewer = { state: rv.outcome === "escalate" ? "waiting" : "failed", by: rv.by, note: rv.outcome === "escalate" ? rv.reason : rv.note };
    this.emit("event", id, { type: "wb_pending", pending: [...s.pending.values()] });
    this.emitSummary(id, true);
  }

  /** What the reviewer sees, from what the manager already holds (ADR 0002). */
  private reviewContext(id: string, s: Live, row: SessionRow, verdict: { rating?: string; detail?: string }): ReviewContext {
    const ticket = this.tickets(id).find((t) => t.status === "running");
    return {
      title: row.title,
      ...latestTask(s.transcript),
      phase: row.phase,
      ...(ticket ? { ticket: { num: ticket.num, title: ticket.title, body: ticket.body } } : {}),
      repo: row.repo_id,
      branch: row.branch,
      worktree: row.worktree,
      sshHosts: loadSshHosts(this.db).map((h) => ({ alias: h.alias, user: h.user, hostname: h.hostname })),
      recent: transcriptExcerpt(s.transcript.messages),
      rating: verdict.rating,
      judgeDetail: verdict.detail,
    };
  }

  /** Whether auto-approve answers this session's permissions now: its own setting, else the global switch. */
  private autoApproveActive(row: SessionRow): boolean {
    const mode = autoApproveMode(row.auto_approve);
    return mode === "inherit" ? getAutoApproveSettings(this.db).enabled : mode === "on";
  }

  /**
   * Stop the judgements and reviews in flight: their calls are hung up and their verdicts dropped,
   * and a card still pending becomes an ordinary card waiting for the user.
   */
  private cancelReviews(id: string, s: Live) {
    let changed = false;
    for (const [reqId, review] of [...s.reviews]) {
      review.abort();
      s.reviews.delete(reqId);
      const req = s.pending.get(reqId);
      if (!req) continue;
      if (req.judge?.state === "judging") delete req.judge;
      if (req.review?.state === "reviewing" || req.reviewer?.state === "reviewing") {
        delete req.review;
        delete req.reviewer;
      }
      changed = true;
    }
    if (changed) {
      this.emit("event", id, { type: "wb_pending", pending: [...s.pending.values()] });
      this.emitSummary(id, true);
    }
  }

  /** The process or run is gone with its requests: abort every review in flight, so none answers. */
  private dropReviews(s: Live) {
    for (const review of s.reviews.values()) review.abort();
    s.reviews.clear();
  }

  /** Rename and/or set auto-approve (PATCH /api/sessions/:id); a bad value refuses the whole update. */
  patch(id: string, body: { title?: unknown; autoApprove?: unknown }): SessionSummary {
    if (body.autoApprove !== undefined) autoApproveMode(body.autoApprove);
    if (typeof body.title === "string") this.rename(id, body.title);
    if (body.autoApprove !== undefined) this.setAutoApprove(id, body.autoApprove);
    return this.summary(id);
  }

  /** Settings → Save (PUT /api/settings/auto-approve): store the global settings, then apply them to running sessions. */
  async applyAutoApproveSettings(input: Partial<AutoApproveSettings>) {
    const saved = await configureAutoApprove(this.db, this.secrets, input);
    this.autoApproveChanged();
    return saved;
  }

  /** Set the session's auto-approve; turning it off cancels the reviews in flight. Applies to the next permission. */
  setAutoApprove(id: string, value: unknown) {
    const mode = autoApproveMode(value);
    this.update(id, { auto_approve: mode === "inherit" ? null : mode });
    const s = this.live.get(id);
    if (s && !this.autoApproveActive(this.row(id))) this.cancelReviews(id, s);
    this.emitSummary(id, true);
  }

  /** The global switch changed: sessions that inherit it and are now off cancel their reviews in flight. */
  autoApproveChanged() {
    for (const [id, s] of this.live) {
      if (!this.autoApproveActive(this.row(id))) this.cancelReviews(id, s);
      this.emitSummary(id, true);
    }
  }

  /** Write the answer to pi and drop the request; a judgement still running for it finds it gone. */
  private answer(id: string, s: Live, req: UiRequest, record: RpcRecord) {
    s.proc!.write(record);
    s.pending.delete(req.id);
    s.reviews.get(req.id)?.abort();
    s.reviews.delete(req.id);
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

  /**
   * Abort the run. pi keeps its open dialogs through an abort and finishes aborting only once they
   * are answered, so the reviews in flight are cancelled here (their cards wait for the user, and
   * nothing answers for them) and, with a card open, the abort is not awaited.
   */
  async abort(id: string) {
    const s = this.state(id);
    this.cancelReviews(id, s);
    if (!s.proc || s.proc.exited) return;
    const aborted = s.proc.call({ type: "abort" }, 30_000);
    if (s.pending.size > 0) aborted.catch(() => {});
    else await aborted;
  }

  async stop(id: string) {
    const s = this.state(id);
    if (s.proc && !s.proc.exited) {
      // Before the process is gone, so no verdict lands (and is recorded) while it exits.
      this.dropReviews(s);
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
      // held_phase names the phase the prompt releases into: tickets for a split, grill for a
      // rework or a task.
      this.update(id, { phase: row.held_phase ?? "grill" });
      this.emitSummary(id);
      // A session on an existing spec issue holds its whole rework or split prompt; others hold the task.
      await this.send(id, row.spec_ref ? row.held_prompt : grillPrompt(row.held_prompt), "followUp");
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
        else if (this.tickets(id).length > 0) {
          // A session started from existing tickets skips grill/spec/tickets after setup.
          this.update(id, { phase: "implement" });
          await this.runNext(id);
        } else {
          this.update(id, { phase: row.mode === "pipeline" ? "grill" : "direct" });
        }
      }
    } else if (row.phase === "grill" && row.grill_summary) {
      this.update(id, { phase: "spec" });
      await this.send(id, specPrompt(), "followUp");
    } else if (row.phase === "spec" && row.spec) {
      this.update(id, { phase: "tickets" });
      await this.send(id, ticketsPrompt(row.spec_ref), "followUp");
    } else if (row.phase === "tickets" && !row.rework_tickets && this.tickets(id).length > 0) {
      // The tickets are on the tracker: the card waits in Issues until Solve all starts the runs.
      this.update(id, { phase: "ready" });
    } else if (row.phase === "implement") {
      await this.afterTicketRun(id, s);
    } else if (row.phase === "review" && row.review_run === this.runOf(row)) {
      await this.afterReviewRun(id, s);
    } else if (row.phase === "pr" && row.merge_run && row.merge_run === this.runOf(row) && this.resolving.has(id)) {
      await this.afterMergeRun(id, s);
    } else if (row.phase === "retro" && row.retro_run === this.runOf(row)) {
      await this.afterRetroRun(id, s);
    }
    this.emitSummary(id, true);
  }

  private async afterTicketRun(id: string, s: Live) {
    const row = this.row(id);
    const runId = this.runOf(row);
    const ticket = this.tickets(id).find((t) => t.status === "running" && [t.runId, t.rescueRunId, t.fixRunId].includes(runId));
    if (!ticket) return;
    if (runId === ticket.rescueRunId) return this.afterRescueRun(id, s, ticket);
    const fix = runId === ticket.fixRunId;
    const report = s.finished;
    s.finished = undefined;
    const stopped = s.watch?.rule.reason;
    this.unwatch(s);
    if (stopped) {
      // The stop rule aborted the run: not a user abort, and not a report the run made.
      const why = describeStopReason(stopped);
      this.updateTicket(id, ticket.num, { stop_reason: JSON.stringify(stopped) });
      if (fix) return this.rescueFailed(id, ticket, `Ticket #${ticket.num}'s fix run hit the stop rule: ${why}`);
      await this.rescue(id, s, ticket, why);
    } else if (report?.status === "done") {
      this.updateTicket(id, ticket.num, { status: "done", note: report.note || null, finished_at: Date.now(), ...(fix ? { rescue_state: "rescued" } : {}) });
      await this.runNext(id);
    } else if (fix) {
      this.rescueFailed(id, ticket, report ? `Ticket #${ticket.num}'s fix run is blocked: ${report.note || "no reason given"}` : `Ticket #${ticket.num}'s fix run stopped without finishing`);
    } else if (report?.status === "blocked") {
      this.updateTicket(id, ticket.num, { status: "blocked", note: report.note || null, finished_at: Date.now() });
      this.flag(id, `Ticket #${ticket.num} is blocked: ${report.note || "no reason given"}. Retry it, mark it done, or reply to the agent.`);
    } else if (s.lastSettleAborted) {
      this.flag(id, `Ticket #${ticket.num} was stopped. Reply to continue it, retry it from scratch, or mark it done.`);
    } else {
      this.flag(id, `Ticket #${ticket.num} stopped without finishing. Reply to the agent, retry it, or mark it done.`);
    }
  }

  /**
   * A ticket run hit the stop rule: start a rescue run on the Reviewer's model, unless the rescue
   * is off (no Reviewer model), the ticket had its one rescue, or the spec had its three.
   */
  private async rescue(id: string, s: Live, ticket: Ticket, why: string) {
    const row = this.row(id);
    const stuck = (reason: string) => {
      this.updateTicket(id, ticket.num, { status: "blocked", note: `Stopped by ${why}`, finished_at: Date.now() });
      this.flag(id, `Ticket #${ticket.num} hit the stop rule: ${why}. ${reason} Retry it, mark it done, or reply to the agent.`);
    };
    if (!this.rescueProxy || !getAutoApproveSettings(this.db).reviewer.model) return stuck("The rescue is off (the Reviewer has no model).");
    if (ticket.rescueRunId) return stuck("It already had its rescue.");
    if (this.tickets(id).filter((t) => t.rescueRunId).length >= RESCUES_PER_SPEC) return stuck(`The spec already had ${RESCUES_PER_SPEC} rescues.`);
    const startCommit = this.db.prepare("SELECT start_commit FROM tickets WHERE session_id = ? AND num = ?").get(id, ticket.num) as { start_commit: string | null };
    // The handoff is built from facts the server holds, not from the stuck model's summary.
    const diff = startCommit.start_commit
      ? `${await git(row.worktree, ["diff", startCommit.start_commit]).catch(() => "")}${await git(row.worktree, ["status", "--porcelain"]).then((st) => (st.trim() ? `\n# git status --porcelain\n${st}` : "")).catch(() => "")}`
      : "";
    const stuckRun = ticket.runId!;
    const toolErrors = readSessionFile(stuckRun)
      .filter((m: any) => m.role === "toolResult" && m.isError)
      .slice(-5)
      .map((m: any) => `${m.toolName}: ${toolText(m).slice(0, 500)}`);
    const prompt = rescuePrompt({
      ticket,
      spec: row.spec,
      specRef: row.spec_ref,
      stopReason: why,
      startCommit: startCommit.start_commit,
      diff,
      toolErrors,
      sessionFile: findSessionFile(config.piSessionsDir, stuckRun) ?? null,
    });
    const runId = `${id}-t${ticket.num}-rescue-${Date.now().toString(36)}`;
    this.updateTicket(id, ticket.num, { rescue_run_id: runId, rescue_state: "diagnosing", note: `Stopped by ${why}; a rescue run diagnoses it.` });
    await this.switchRun(id, runId, true);
    s.runBase = { runId, worktree: await worktreeState(row.worktree) };
    this.watch(id);
    await this.send(id, prompt);
  }

  /** The rescue run settled: start a fix run on a diagnosis, otherwise flag. Each outcome used the ticket's rescue. */
  private async afterRescueRun(id: string, s: Live, ticket: Ticket) {
    const row = this.row(id);
    const report = s.diagnosis;
    s.diagnosis = undefined;
    const stopped = s.watch?.rule.reason;
    this.unwatch(s);
    const base = s.runBase?.runId === ticket.rescueRunId ? s.runBase.worktree : undefined;
    s.runBase = undefined;
    if (stopped) return this.rescueFailed(id, ticket, `Ticket #${ticket.num}'s rescue run hit the stop rule: ${describeStopReason(stopped)}`);
    if (base !== undefined && (await worktreeState(row.worktree)) !== base) {
      return this.rescueFailed(id, ticket, `Ticket #${ticket.num}'s rescue run changed the worktree; it must leave it as found. Check the changes`);
    }
    if (!report) return this.rescueFailed(id, ticket, `Ticket #${ticket.num}'s rescue run stopped without finish_diagnosis`);
    this.updateTicket(id, ticket.num, { diagnosis: JSON.stringify(report) });
    if (report.status === "no_loop") return this.rescueFailed(id, ticket, `Ticket #${ticket.num}'s rescue could not build a feedback loop (an unclear ticket or a broken environment?): ${report.note || "no note"}`);
    if (report.status === "failed") return this.rescueFailed(id, ticket, `Ticket #${ticket.num}'s rescue found no cause: every hypothesis failed: ${report.note || "no note"}`);
    // Diagnosed: a fresh local run writes the fix, test-first, from the diagnosis.
    const runId = `${id}-t${ticket.num}-fix-${Date.now().toString(36)}`;
    this.updateTicket(id, ticket.num, { fix_run_id: runId, rescue_state: "fixing", note: `Diagnosed: ${report.note || report.chain![0]}` });
    await this.switchRun(id, runId, true);
    this.watch(id);
    const finished = this.tickets(id).filter((x) => x.status === "done");
    await this.send(id, fixPrompt(ticket, row.spec, row.spec_ref, finished, report));
  }

  /** The rescue did not work out: the ticket is blocked, and there is no second rescue for it. */
  private rescueFailed(id: string, ticket: Ticket, reason: string) {
    this.updateTicket(id, ticket.num, { status: "blocked", rescue_state: "failed", note: reason, finished_at: Date.now() });
    this.flag(id, `${reason}. Retry it, mark it done, or reply to the agent.`);
  }

  private async afterReviewRun(id: string, s: Live) {
    const report = s.finished;
    s.finished = undefined;
    if (report) this.update(id, { review_note: report.note || null });
    if (report && this.retroDue(id)) await this.startRetro(id, report.note);
    else if (report) await this.finishPipeline(id, report.note);
    else if (s.lastSettleAborted) this.flag(id, "The review was stopped. Reply to continue it, retry it, or mark it done.");
    else this.flag(id, "The review stopped without finishing. Reply to the agent, retry it, or mark it done.");
  }

  /** A retro runs when a ticket had a rescue and the Reviewer (the retro's model) is still on. */
  private retroDue(id: string) {
    return !!this.rescueProxy && !!getAutoApproveSettings(this.db).reviewer.model && this.tickets(id).some((t) => t.rescueRunId);
  }

  /** The end-of-spec retro: a fresh run on the Reviewer's model over the rescued tickets; it only proposes. */
  private async startRetro(id: string, reviewNote: string | null) {
    const runId = `${id}-retro-${Date.now().toString(36)}`;
    this.update(id, { retro_run: runId, attention: null });
    // Switch runs before announcing the phase that implies the switch.
    await this.switchRun(id, runId, true);
    this.update(id, { phase: "retro" });
    this.emitSummary(id, true);
    const s = this.state(id);
    s.reviewNote = reviewNote;
    const row = this.row(id);
    const file = (run: string | null) => (run ? findSessionFile(config.piSessionsDir, run) ?? null : null);
    const rows = new Map((this.db.prepare("SELECT num, stop_reason, diagnosis FROM tickets WHERE session_id = ?").all(id) as TicketRow[]).map((r) => [r.num, r]));
    const rescued = this.tickets(id)
      .filter((t) => t.rescueRunId)
      .map((t) => {
        const r = rows.get(t.num)!;
        const stop = r.stop_reason ? describeStopReason(JSON.parse(r.stop_reason)) : null;
        return {
          ticket: t,
          stopReason: stop,
          diagnosis: r.diagnosis,
          fixResult: `${t.rescueState ?? "unknown"}${t.note ? `: ${t.note}` : ""}`,
          sessionFiles: { stuck: file(t.runId), rescue: file(t.rescueRunId), fix: file(t.fixRunId) },
        };
      });
    const m = getModelSettings(this.db);
    const pointers = { pipeline: getPipelineSettings(this.db), model: { baseUrl: m.baseUrl, modelId: m.modelId, contextWindow: m.contextWindow, maxTokens: m.maxTokens } };
    s.runBase = { runId, worktree: await worktreeState(row.worktree) };
    this.watch(id);
    await this.send(id, retroPrompt(rescued, pointers));
  }

  /**
   * The retro run settled: notify its report, or why there is none, then finish the pipeline as
   * usual. The retro never blocks the PR; a retro that changed the worktree flags after done.
   */
  private async afterRetroRun(id: string, s: Live) {
    const row = this.row(id);
    const report = s.retroReport;
    s.retroReport = undefined;
    const stopped = s.watch?.rule.reason;
    this.unwatch(s);
    const base = s.runBase?.runId === row.retro_run ? s.runBase.worktree : undefined;
    s.runBase = undefined;
    const reviewNote = s.reviewNote ?? null;
    s.reviewNote = undefined;
    let changed = false;
    try {
      changed = base !== undefined && (await worktreeState(row.worktree)) !== base;
      if (stopped) this.notify(id, `The retro run hit the stop rule: ${describeStopReason(stopped)}. The pipeline finishes without its report.`, "warning");
      else if (!report) this.notify(id, "The retro run stopped without finish_retro. The pipeline finishes without its report.", "warning");
      else this.notify(id, `Retro report for ${row.title}: ${report}`, "info");
    } catch (err) {
      this.notify(id, `The retro run failed: ${(err as Error).message}. The pipeline finishes without its report.`, "warning");
    }
    await this.finishPipeline(id, reviewNote);
    if (changed) this.flag(id, "The retro run changed the worktree; it must only propose. Check the changes before you approve the PR.");
  }

  private notify(id: string, message: string, level: "info" | "warning") {
    this.emit("event", id, { type: "wb_notify", message, level });
  }

  /** The review is finished: push the branch and open the PR. If it cannot open, stay in review with the reason. */
  private async finishPipeline(id: string, reviewNote: string | null) {
    let pr: { number: number; url: string };
    try {
      if (!this.delivery) throw new Error("this workbench has no GitHub connection");
      const { row, repo } = this.repoOf(id);
      pr = await this.delivery.openPr(row, repo, this.tickets(id));
    } catch (err) {
      this.flag(id, `The PR could not open: ${(err as Error).message}. Retry the review, or mark it done to try the PR again.`);
      return;
    }
    // Switch back to the plan conversation before announcing "pr", so no one sees pr + review run.
    await this.switchRun(id, id, false);
    this.update(id, { phase: "pr", pr_number: pr.number, pr_url: pr.url, attention: null });
    const msg = `All tickets are done and reviewed${reviewNote ? ` (${reviewNote})` : ""}. PR #${pr.number} is open.`;
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

  /**
   * Solve one ticket: run only that ticket in the card's session, then pause the card in Issues
   * when it is done (`runNext` reads the solo column). Only a card in `ready` (Issues, no run
   * going) is accepted, with a ticket that is not done or blocked and has every blocker done;
   * a ticket a stopped run left `running` counts as ready and starts a fresh run, as Solve all does.
   */
  async solveTicket(id: string, num: number): Promise<SessionSummary> {
    const row = this.row(id);
    if (row.mode !== "pipeline") throw Object.assign(new Error("Not a pipeline session"), { status: 409 });
    if (row.phase !== "ready") {
      const why = ["implement", "review", "retro", "pr"].includes(row.phase)
        ? "The card runs now"
        : row.phase === "done"
          ? "The card is done"
          : "The card is still being planned";
      throw Object.assign(new Error(why), { status: 409 });
    }
    const tickets = this.tickets(id);
    const t = tickets.find((x) => x.num === num);
    if (!t) throw Object.assign(new Error(`No ticket #${num}`), { status: 409 });
    if (t.status === "done") throw Object.assign(new Error(`Ticket #${num} is done`), { status: 409 });
    if (t.status === "blocked") throw Object.assign(new Error(`Ticket #${num} is blocked`), { status: 409 });
    const done = new Set(tickets.filter((x) => x.status === "done").map((x) => x.num));
    const open = t.blockedBy.filter((b) => !done.has(b));
    if (open.length) throw Object.assign(new Error(`Ticket #${num} is blocked by ${open.map((b) => `#${b}`).join(", ")}`), { status: 409 });
    if (t.status === "running") this.updateTicket(id, num, { status: "ready" });
    this.update(id, { solo_ticket: num, phase: "implement", attention: null });
    await this.runTicket(id, t);
    return this.summary(id);
  }

  /**
   * Start the next unblocked ticket in a fresh run, or move on to the review. With a solo
   * ticket set, the card pauses in Issues when that ticket is done, instead of going on; every
   * ticket done goes on to the review, as Solve all does. A retry re-runs the solo ticket, not
   * the lowest ready one, while the column is set.
   */
  private async runNext(id: string) {
    const row = this.row(id);
    const tickets = this.tickets(id);
    if (row.solo_ticket !== null) {
      const solo = tickets.find((t) => t.num === row.solo_ticket);
      if (!solo || solo.status === "done") {
        this.update(id, { solo_ticket: null });
        if (allDone(tickets)) {
          await this.startReview(id);
          return;
        }
        this.update(id, { phase: "ready", attention: null });
        return;
      }
      await this.runTicket(id, solo);
      return;
    }
    if (allDone(tickets)) {
      await this.startReview(id);
      return;
    }
    const t = nextTicket(tickets);
    if (!t) {
      const remaining = tickets.filter((x) => x.status !== "done");
      const blocked = remaining.filter((x) => x.status === "blocked").map((x) => `#${x.num}`).join(", ");
      // Every remaining ticket is blocked itself, or some wait on the blocked ones.
      const why = remaining.every((x) => x.status === "blocked") ? "every remaining ticket is blocked" : "every remaining ticket is blocked or waits on a blocked one";
      this.flag(id, `No ticket can start: ${why} (${blocked}).`);
      return;
    }
    await this.runTicket(id, t);
  }

  /** A fresh run for one ticket, as the pipeline starts it. */
  private async runTicket(id: string, t: Ticket) {
    const runId = `${id}-t${t.num}-${Date.now().toString(36)}`;
    // The commit the ticket's first run started from: a rescue's diff starts there.
    const startCommit = this.db.prepare("SELECT start_commit FROM tickets WHERE session_id = ? AND num = ?").get(id, t.num) as { start_commit: string | null };
    const head = startCommit.start_commit ?? (await git(this.row(id).worktree, ["rev-parse", "HEAD"]).then((h) => h.trim(), () => null));
    this.updateTicket(id, t.num, { status: "running", run_id: runId, started_at: Date.now(), finished_at: null, start_commit: head });
    await this.switchRun(id, runId, true);
    const row = this.row(id);
    const finished = this.tickets(id).filter((x) => x.status === "done");
    this.watch(id);
    await this.send(id, implementPrompt({ ...t, runId }, row.spec, row.spec_ref, finished));
  }

  /**
   * Put the live run under the stop rule, with the pipeline limits as saved now. The clock runs
   * only while the run works: it pauses while a permission or a decision waits for the user.
   */
  private watch(id: string) {
    const s = this.state(id);
    this.unwatch(s);
    const rule = new StopRule(getPipelineSettings(this.db), config.stopRuleMinuteMs);
    const timer = setInterval(() => {
      const paused = !s.transcript.busy || [...s.pending.values()].some(waitsOnUser);
      const reason = rule.tick(paused);
      if (reason) this.stopRuleFired(id, s, reason);
    }, Math.min(1000, Math.max(20, config.stopRuleMinuteMs / 20)));
    timer.unref();
    s.watch = { rule, timer };
  }

  private unwatch(s: Live) {
    if (s.watch) clearInterval(s.watch.timer);
    s.watch = undefined;
  }

  /** A stop-rule condition fired: the reason is on the live state first, then the run is aborted. */
  private stopRuleFired(id: string, s: Live, _reason: StopReason) {
    clearInterval(s.watch!.timer);
    this.emitSummary(id, true);
    void this.abort(id).catch(() => {});
  }

  /** Point the session at another pi conversation: stop the current process, swap, tell viewers. */
  private async switchRun(id: string, runId: string, fresh: boolean) {
    const s = this.state(id);
    await this.stop(id);
    s.proc = undefined;
    this.dropReviews(s);
    s.pending.clear();
    s.toolArgs.clear();
    s.finished = undefined;
    this.unwatch(s);
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
      // Stop pauses the card in Issues, the same as a move there; Solve all continues it. Only a
      // card with tickets to continue stops: the phases the pipeline panel shows Stop in.
      if (row.phase !== "implement" && row.phase !== "review" && row.phase !== "retro")
        throw Object.assign(new Error("Stop applies only while the tickets, the review or the retro run"), { status: 409 });
      await this.pause(id);
    } else if (row.phase === "review") {
      if (action === "retry") await this.startReview(id);
      else await this.finishPipeline(id, null);
    } else if (row.phase === "retro") {
      if (action === "retry") await this.startRetro(id, null);
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

  /**
   * The board's moves (`<from>><to>` columns): each drag is a command that changes the phase.
   * A move with no entry here is refused with 409, so the card snaps back.
   */
  private readonly moves: Partial<Record<`${Column}>${Column}`, (id: string) => Promise<void>>> = {
    "issues>doing": (id) => this.solveAll(id),
    "review>done": (id) => this.approve(id),
    "doing>issues": (id) => this.pause(id),
    "qa>issues": (id) => this.pause(id),
    "review>issues": (id) => this.pause(id),
    "issues>todo": (id) => this.rework(id),
    "doing>todo": (id) => this.rework(id),
    "qa>todo": (id) => this.rework(id),
    "review>todo": (id) => this.rework(id),
  };

  /**
   * Stop the live run and wait in `ready`; ticket statuses stay, and an open PR stays open for the
   * next review to push to. The phase changes first, so the stopped run's settle moves nothing.
   */
  private async pause(id: string) {
    const merging = this.onMergeRun(id);
    // A backward move or the pipeline's Stop clears the solo ticket: a later Solve all runs everything.
    this.update(id, { phase: "ready", attention: null, solo_ticket: null });
    await this.stop(id);
    await this.dropRun(id, merging);
  }

  /** Whether the run on screen is the merge run: it works, or the card still shows it after a restart. */
  private onMergeRun(id: string) {
    const row = this.row(id);
    return this.resolving.has(id) || (!!row.merge_run && row.merge_run === this.runOf(row));
  }

  /**
   * A backward move stopped the live run. The stop rule's clock goes with it (the next run gets a
   * fresh watch), and a half-done merge is undone, so Approve can start again. The worktree says
   * whether a merge is half done: after a restart no merge run is known, but its MERGE_HEAD stays.
   * When the stopped run was the merge run (`merging`), a merge commit it made is dropped as well.
   */
  private async dropRun(id: string, merging: boolean) {
    this.unwatch(this.state(id));
    this.resolving.delete(id);
    const row = this.row(id);
    if (merging) await this.undoMerge(row);
    else if (await this.mergeHalfDone(row.worktree)) await git(row.worktree, ["merge", "--abort"], await this.gitEnv()).catch(() => {});
  }

  /** Whether the worktree holds a merge that is not committed yet (git's MERGE_HEAD is there). */
  private mergeHalfDone(worktree: string) {
    return git(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(() => true, () => false);
  }

  /**
   * Plan again: stop the live run, go back to the plan conversation, and grill with the rework
   * prompt. The grill summary and spec are cleared (the spec ref stays), and the old tickets are
   * marked stale until record_tickets replaces them, so afterSettled does not skip ahead; send()
   * clears the attention.
   */
  private async rework(id: string) {
    const merging = this.onMergeRun(id);
    this.update(id, { phase: "grill", grill_summary: null, spec: null, rework_tickets: 1, solo_ticket: null });
    await this.switchRun(id, id, false);
    await this.dropRun(id, merging);
    // A ticket the stopped run left `running` is not worked on while the card is in To do.
    for (const t of this.tickets(id)) if (t.status === "running") this.updateTicket(id, t.num, { status: "ready" });
    await this.send(id, reworkPrompt(this.row(id).spec_ref));
  }

  /** Solve all: the paused session implements its tickets, one fresh run each. */
  private async solveAll(id: string) {
    // A ticket a stopped run left `running` starts again. The solo ticket goes: every ticket runs.
    for (const t of this.tickets(id)) if (t.status === "running") this.updateTicket(id, t.num, { status: "ready" });
    this.update(id, { phase: "implement", solo_ticket: null });
    await this.runNext(id);
  }

  /**
   * Approve: merge the card's PR with a merge commit, then deliver it (`delivered`). A merge
   * conflict goes to `mergeConflict`; any other refusal keeps `pr` with GitHub's message.
   */
  async approve(id: string) {
    const row = this.row(id);
    if (row.phase !== "pr" || this.approving.has(id) || this.resolving.has(id)) throw Object.assign(new Error("Only a card in Review with its PR open can be approved."), { status: 409 });
    this.approving.add(id);
    try {
      const { repo } = this.repoOf(id);
      let result: MergeResult;
      try {
        if (!this.delivery) throw new Error("this workbench has no GitHub connection");
        result = await this.delivery.merge(row, repo);
      } catch (err) {
        // A GitHubError carries GitHub's own message as `detail`; the flag ends in one period.
        const why = ((err as { detail?: string }).detail || (err as Error).message).replace(/[.\s]+$/, "");
        this.flag(id, `GitHub refused the merge: ${why}. Fix it on GitHub, then approve again.`);
        return;
      }
      if ("conflict" in result) await this.mergeConflict(id, result.conflict);
      else await this.delivered(id, repo);
    } finally {
      this.approving.delete(id);
      this.emitSummary(id, true);
    }
  }

  /**
   * The merge stopped on a conflict; the card stays in Review. Merge the base branch into the
   * worktree: a clean merge is pushed at once, and one that stops on conflicts goes to a fresh
   * merge run with resolving-merge-conflicts, which `afterMergeRun` finishes.
   */
  private async mergeConflict(id: string, reason: string) {
    const row = this.row(id);
    const env = await this.gitEnv();
    const sh = (args: string[]) => git(row.worktree, args, env);
    try {
      await sh(["fetch", "-q", "origin", row.base_branch]);
      await sh(["merge", "--no-edit", `origin/${row.base_branch}`]);
    } catch (err) {
      const files = (await sh(["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
      if (!files.length) {
        await sh(["merge", "--abort"]).catch(() => {});
        this.flag(id, `${reason}, and the workbench could not merge ${row.base_branch} into the branch: ${(err as Error).message}. Resolve it on the branch, then approve again.`);
        return;
      }
      // Switch to the merge run before anyone hears about it.
      const runId = `${id}-merge-${Date.now().toString(36)}`;
      this.update(id, { merge_run: runId, merge_files: JSON.stringify(files), attention: null });
      this.resolving.add(id);
      await this.switchRun(id, runId, true);
      this.emit("event", id, { type: "wb_notify", message: `${reason}. A merge run resolves it now.`, level: "info" });
      await this.send(id, mergePrompt(row.base_branch, reason, files)).catch((err2) => {
        this.resolving.delete(id);
        this.flag(id, `The merge run could not start: ${(err2 as Error).message}. Resolve the conflict on the branch, then approve again.`);
      });
      return;
    }
    await this.pushResolved(id, `${row.base_branch} merged into the branch with no conflicting lines`);
  }

  /** The merge run settled: push a resolved merge; else undo the half-done merge and say why. */
  private async afterMergeRun(id: string, s: Live) {
    const report = s.finished;
    s.finished = undefined;
    this.resolving.delete(id);
    const row = this.row(id);
    const unfinished = report?.status === "done" ? await this.unfinishedMerge(row) : null;
    if (report?.status === "done" && !unfinished) {
      await this.pushResolved(id, report.note);
      return;
    }
    await this.undoMerge(row);
    const why = unfinished
      ? `the merge run called finish_merge "resolved", but ${unfinished}`
      : report
        ? report.note || "no reason given"
        : s.lastSettleAborted
          ? "the run was stopped"
          : "the run stopped without finishing";
    this.flag(id, `The merge conflict was not resolved: ${why}. Resolve it on the branch, then approve again.`);
  }

  /**
   * Why the worktree does not hold a finished merge of the base branch, or null when it does. A
   * file git reported as conflicted that still has a `<<<<<<< ` or `>>>>>>> ` line is not finished
   * either (a lone `=======` can be a Markdown heading's underline).
   */
  private async unfinishedMerge(row: SessionRow): Promise<string | null> {
    const sh = (args: string[]) => git(row.worktree, args).then(() => true, () => false);
    if (await this.mergeHalfDone(row.worktree)) return "the merge is not committed";
    if (!(await sh(["merge-base", "--is-ancestor", `origin/${row.base_branch}`, "HEAD"]))) return `HEAD does not contain origin/${row.base_branch}`;
    const conflicted: string[] = JSON.parse(row.merge_files ?? "[]");
    if (!conflicted.length) return null;
    const marked = await git(row.worktree, ["grep", "-l", "-z", "-E", "^(<<<<<<<|>>>>>>>) ", "HEAD", "--", ...conflicted]).then(
      (out) => out.split("\0").filter(Boolean).map((f) => f.replace(/^HEAD:/, "")),
      () => [] as string[],
    );
    if (marked.length) return `${marked.join(", ")} still ${marked.length === 1 ? "has" : "have"} conflict markers`;
    return null;
  }

  /**
   * Undo the merge run's merge: abort a half-done one, or drop a committed merge commit (HEAD's
   * first parent is the tip `git merge` started from, ORIG_HEAD), so nothing of it is pushed later.
   */
  private async undoMerge(row: SessionRow) {
    const env = await this.gitEnv();
    const rev = (r: string) => git(row.worktree, ["rev-parse", "-q", "--verify", r]).then((x) => x.trim(), () => null);
    if (await this.mergeHalfDone(row.worktree)) {
      await git(row.worktree, ["merge", "--abort"], env).catch(() => {});
      return;
    }
    const before = await rev("ORIG_HEAD");
    const isMerge = !!(await rev("HEAD^2"));
    if (before && isMerge && before === (await rev("HEAD^1"))) await git(row.worktree, ["reset", "-q", "--hard", before], env).catch(() => {});
  }

  /** Push the merge to the PR's branch; the card stays in Review for a second Approve. */
  private async pushResolved(id: string, note: string) {
    const row = this.row(id);
    try {
      await git(row.worktree, ["push", "-q", "origin", `HEAD:refs/heads/${row.branch}`], await this.gitEnv());
    } catch (err) {
      this.flag(id, `The merge conflict is resolved, but the push failed: ${(err as Error).message}. Push the branch, then approve again.`);
      return;
    }
    this.flag(id, resolvedNote(row.base_branch, note));
  }

  /**
   * The PR is merged: close the issues when GitHub will not (a base that is not the default
   * branch ignores `Closes`, and `Closes` never reaches another repo's issue, which closes only
   * when the workbench tracks its repo), delete the branch on
   * GitHub and the worktree, and set `done`. A cleanup step that fails does not undo the merge; its
   * reason goes on the card.
   */
  private async delivered(id: string, repo: RepoRow) {
    const row = this.row(id);
    const delivery = this.delivery!;
    const problems: string[] = [];
    if (row.base_branch !== repo.default_branch) {
      await delivery.closeIssues(repo, closedIssues(row, this.tickets(id))).catch((err) => problems.push(`the issues did not close (${(err as Error).message})`));
    }
    // An issue of another repo closes only when the workbench tracks that repo: a model-written ref
    // must not close issues in any repo the token can write.
    const tracked = new Set(listRepos(this.db).map((r) => r.id.toLowerCase()));
    for (const issue of foreignIssues(row, this.tickets(id))) {
      if (!tracked.has(issue.repo.toLowerCase())) {
        problems.push(`issue ${issue.repo}#${issue.number} was not closed (it is in a repo the workbench does not track)`);
        continue;
      }
      const [owner, name] = issue.repo.split("/");
      await delivery.closeIssues({ owner, name }, [issue.number]).catch((err) => problems.push(`issue ${issue.repo}#${issue.number} did not close (${(err as Error).message})`));
    }
    await delivery.deleteBranch(row, repo).catch((err) => problems.push(`the branch was not deleted (${(err as Error).message})`));
    await this.stop(id).catch(() => {});
    if (fs.existsSync(row.worktree)) await removeWorktree(repo, row.worktree).catch((err) => problems.push(`the worktree was not removed (${(err as Error).message})`));
    this.update(id, { phase: "done", attention: problems.length ? `PR #${row.pr_number} is merged, but ${problems.join(", and ")}.` : null });
    this.emit("event", id, { type: "wb_notify", message: `PR #${row.pr_number} is merged.`, level: "info" });
  }

  /**
   * A drag of a card to another column. The `from` column is what the board shows (sessionColumn),
   * and a drag is a command only on a pipeline card: a direct card sits in Doing always, and every
   * drag of it is refused with 409, so it snaps back.
   */
  async move(id: string, to: Column) {
    const row = this.row(id);
    const from = sessionColumn(row.mode, row.phase);
    const command = row.mode === "pipeline" && from ? this.moves[`${from}>${to}`] : undefined;
    if (!command) {
      const label = (c: Column | null) => COLUMNS.find((x) => x.id === c)?.label ?? "this place";
      throw Object.assign(new Error(`This card cannot move from ${label(from)} to ${label(to)} now.`), { status: 409 });
    }
    await command(id);
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

  /**
   * Abandon a card: stop its runs, close its PR unmerged, delete its branch on GitHub and its
   * worktree, then delete the session and its tickets. The GitHub issues stay open, so a spec
   * issue with open tickets shows again as an unclaimed card. A GitHub step that fails keeps the card.
   */
  async abandon(id: string) {
    const row = this.row(id);
    const repo = getRepo(this.db, row.repo_id);
    await this.stop(id);
    if (repo && this.delivery) {
      // A merged PR (a card in Done) is not closed again.
      if (row.pr_number && row.phase !== "done") await this.delivery.closePr(row, repo);
      await this.delivery.deleteBranch(row, repo);
    }
    if (repo && fs.existsSync(row.worktree)) await removeWorktree(repo, row.worktree);
    clearTimeout(this.summaryTimers.get(id));
    this.summaryTimers.delete(id);
    this.db.prepare("DELETE FROM tickets WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM auto_decisions WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    this.live.delete(id);
    this.emit("removed", id);
    this.emit("board", row.repo_id);
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

const typesafeSkillDir = () => path.join(config.optionalSkillsDir, TYPESAFE_SKILL);

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

/** A tool result's text. */
const toolText = (m: any): string => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: any) => b?.text ?? "").join("") : "");

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
