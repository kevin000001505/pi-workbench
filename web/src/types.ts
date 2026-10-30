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
  createdAt: number;
};

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
