import { waitsOnUser } from "../../shared/pending.ts";

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
  tool?: string;
  subject?: string;
  reasons?: string[];
  /** permission under auto-approve: the risk judge's rating, then why it still waits for the user. */
  judge?: { state: "judging" | "waiting" | "failed"; by: string; rating?: string; note?: string };
  /** permission under auto-approve: the frontier reviewer's verdict on the non-safe rating. */
  reviewer?: { state: "reviewing" | "waiting" | "failed"; by: string; note?: string };
  createdAt: number;
};

/** The session's requests that wait on the user (see shared/pending.ts). */
export const waitingOn = (s: { pending: UiRequest[] }) => s.pending.filter(waitsOnUser);

export type AutoApproveSettings = {
  enabled: boolean;
  judge: { baseUrl: string; model: string; protocol: JudgeProtocol; yesAbove: number; noBelow: number };
  reviewer: ReviewerSettings;
  /** Whether the write-only keys are set (their values never come back) and the hosts they are bound to. */
  keys: { judgeToken: boolean; tokenOrigin?: string; reviewerKey: boolean; reviewerKeyOrigin?: string };
};

/** The frontier reviewer for the calls the judge does not rate safe. */
export type ReviewerProvider = "anthropic" | "openai";
export type ReviewerSettings = { provider: ReviewerProvider; model: string; baseUrl: string };

/** The public APIs a base URL defaults to, per provider. */
export const REVIEWER_DEFAULT_URL: Record<ReviewerProvider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};

/** What the judge URL speaks, read from its model list: TypeSafe System One or OpenAI-compatible chat. */
export type JudgeProtocol = "systemone" | "openai";
export type JudgeModels = { protocol: JudgeProtocol; models: string[] };

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
  attention: string | null;
  grillSummary: string | null;
  spec: string | null;
  specRef: string | null;
  issueRef: string | null;
  tickets: Ticket[];
  activeRun: string;
  runs: { id: string; label: string }[];
};

export type Phase = "setup" | "grill" | "spec" | "tickets" | "implement" | "review" | "done" | "direct";

export type Ticket = {
  num: number;
  title: string;
  body: string;
  blockedBy: number[];
  trackerRef: string | null;
  status: "ready" | "running" | "done" | "blocked";
  note: string | null;
  runId: string | null;
};

export type Repo = { id: string; owner: string; name: string; defaultBranch: string; private: boolean; needsSetup: boolean };

export type GhRepo = {
  id: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  pushedAt: string | null;
};

export type GhIssueSummary = { number: number; title: string; labels: string[]; updatedAt: string; htmlUrl: string };
export type GhIssueDetail = GhIssueSummary & { body: string | null; assignees: string[] };
export type GhIssueComment = { id: number; author: string; body: string | null; createdAt: string };
/** The issue-detail route response: the detail plus up to 100 comments. */
export type GhIssueWithComments = GhIssueDetail & { comments: GhIssueComment[] };

export type Skill = { name: string; description: string; source: "global" | "repo"; manualOnly: boolean };

export type ModelSettings = {
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingFormat: string;
};

export type ApprovalRule = { id: string; tool: string; pattern: string; label: string; enabled: boolean };
export type ApprovalSettings = { rules: ApprovalRule[]; outsideWorktree: boolean };

export type SecretMeta = { scope: string; name: string; updatedAt: number };

export type SshKeyMeta = { name: string; updatedAt: number };
export type SshHost = { alias: string; user: string; hostname: string; port?: number; keyName: string };
export type SshHostView = SshHost & { keyMissing: boolean };
export type SshView = { keys: SshKeyMeta[]; hosts: SshHostView[] };

export type Changes = {
  log: string;
  committed: string;
  uncommitted: string;
  dirty: boolean;
  changedFiles: number;
  ahead: number;
};

export type PrDraft = Changes & { title: string; body: string; drafted: boolean; error: string | null };

export type PrStatus = {
  state: string;
  draft: boolean;
  mergeableState: string;
  url: string;
  comments: number;
  checks: { total: number; pending: number; failed: number; passed: number };
};

export type ProbeResult = {
  ok: boolean;
  models: string[];
  checks: { name: string; url: string; ok: boolean; status?: number; contentType?: string; excerpt?: string; hint?: string; ms: number }[];
};
