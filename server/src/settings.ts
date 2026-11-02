import fs from "node:fs";
import path from "node:path";
import { getAutoApproveSettings } from "./autoapprove.ts";
import { config, PROVIDER_ID } from "./config.ts";
import { type Db, getSetting, putSetting } from "./db.ts";
import { HttpError } from "./http.ts";
import { RESCUE_PROVIDER_ID, RESCUE_TOKEN_ENV } from "./rescue-proxy.ts";

export type ModelSettings = {
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  /** Ask the model to think; pi then sends thinking parameters in `thinkingFormat`. */
  reasoning: boolean;
  /** pi `compat.thinkingFormat` for openai-completions, or "" for pi's URL-based auto-detection. */
  thinkingFormat: string;
};

export type ApprovalRule = {
  id: string;
  /** pi tool name ("bash", "write", "edit", ...) or "*" for any tool. */
  tool: string;
  /** Regex tested against the bash command, or against the JSON-encoded input of other tools. */
  pattern: string;
  label: string;
  enabled: boolean;
};

export type ApprovalSettings = {
  rules: ApprovalRule[];
  /** Ask before write/edit outside the session's worktree. */
  outsideWorktree: boolean;
};

export const DEFAULT_RULES: ApprovalRule[] = [
  { id: "git-push", tool: "bash", pattern: String.raw`\bgit\s+push\b`, label: "git push", enabled: true },
  { id: "gh", tool: "bash", pattern: String.raw`(^|[\s;&|(])gh\s`, label: "GitHub CLI (gh)", enabled: true },
  { id: "rm-rf", tool: "bash", pattern: String.raw`\brm\s+(-[a-zA-Z]*[rRf]|--recursive|--force)`, label: "rm -r / -f", enabled: true },
  { id: "sudo", tool: "bash", pattern: String.raw`\bsudo\b`, label: "sudo", enabled: true },
  { id: "net", tool: "bash", pattern: String.raw`\b(curl|wget)\b`, label: "curl / wget", enabled: true },
  { id: "ssh", tool: "bash", pattern: String.raw`(^|[\s;&|(])ssh\s`, label: "ssh", enabled: true },
  {
    id: "pkg",
    tool: "bash",
    pattern: String.raw`\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\bapt(-get)?\s+install\b|\bcargo\s+(install|add)\b|\buv\s+(add|pip\s+install)\b|\bgo\s+install\b`,
    label: "package install",
    enabled: true,
  },
  {
    id: "git-destructive",
    tool: "bash",
    pattern: String.raw`\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|branch\s+-D|push\s+.*--force|checkout\s+--\s|restore\s+\.)`,
    label: "destructive git",
    enabled: true,
  },
];

export function getModelSettings(db: Db): ModelSettings {
  return {
    baseUrl: config.defaults.baseUrl,
    modelId: config.defaults.modelId,
    contextWindow: config.defaults.contextWindow,
    maxTokens: config.defaults.maxTokens,
    reasoning: false,
    thinkingFormat: "",
    ...getSetting<Partial<ModelSettings>>(db, "model"),
  };
}

export function saveModelSettings(db: Db, input: Partial<ModelSettings>) {
  const next = { ...getModelSettings(db), ...pick(input, ["baseUrl", "modelId", "contextWindow", "maxTokens", "reasoning", "thinkingFormat"]) };
  if (!/^https?:\/\//.test(next.baseUrl)) throw new Error("Base URL must start with http:// or https://");
  if (!next.modelId.trim()) throw new Error("Model ID is required");
  for (const k of ["contextWindow", "maxTokens"] as const) {
    if (!Number.isInteger(next[k]) || next[k] <= 0) throw new Error(`${k} must be a positive integer`);
  }
  putSetting(db, "model", next);
  return next;
}

export function getApprovalSettings(db: Db): ApprovalSettings {
  return { rules: DEFAULT_RULES, outsideWorktree: true, ...getSetting<Partial<ApprovalSettings>>(db, "approval") };
}

export function saveApprovalSettings(db: Db, input: ApprovalSettings) {
  const rules = (input.rules ?? []).map((r, i) => {
    try {
      new RegExp(r.pattern);
    } catch {
      throw new Error(`Rule "${r.label || r.pattern}" has an invalid regex`);
    }
    return {
      id: r.id || `rule-${Date.now()}-${i}`,
      tool: r.tool?.trim() || "bash",
      pattern: r.pattern,
      label: r.label?.trim() || r.pattern,
      enabled: r.enabled !== false,
    };
  });
  const next = { rules, outsideWorktree: input.outsideWorktree !== false };
  putSetting(db, "approval", next);
  return next;
}

/**
 * The stop rule for runs in the implement phase: a run stops when it passes the time limit
 * (the clock pauses while a permission or decision waits for the user), repeats the same tool
 * call with the same input, or passes the tool-call limit.
 */
export type PipelineSettings = {
  /** Minutes of run time before the stop rule stops a run; the clock pauses while the user is asked something. */
  timeLimitMinutes: number;
  /** Consecutive identical tool calls (same tool, same JSON input) before the stop rule stops a run. */
  repeatLimit: number;
  /** Tool calls in one run before the stop rule stops it. */
  toolCallLimit: number;
};

const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = { timeLimitMinutes: 30, repeatLimit: 3, toolCallLimit: 300 };

export function getPipelineSettings(db: Db): PipelineSettings {
  return { ...DEFAULT_PIPELINE_SETTINGS, ...getSetting<Partial<PipelineSettings>>(db, "pipeline") };
}

export function savePipelineSettings(db: Db, input: Partial<PipelineSettings>): PipelineSettings {
  const next = { ...getPipelineSettings(db), ...pick(input, ["timeLimitMinutes", "repeatLimit", "toolCallLimit"]) };
  for (const k of ["timeLimitMinutes", "repeatLimit", "toolCallLimit"] as const) {
    if (!Number.isInteger(next[k]) || next[k] <= 0) throw new HttpError(400, `${k} must be a positive integer`);
  }
  putSetting(db, "pipeline", next);
  return next;
}

export const LLM_KEY_ENV = "LLM_API_KEY";
export const rulesFile = () => path.join(config.piAgentDir, "workbench-rules.json");

/**
 * Regenerate pi's agent dir from the db: models.json (the workbench provider, and the
 * workbench-rescue provider for rescue and retro runs, ADR 0003), settings.json (default
 * model, global skills and our extension), and the approval rules the extension re-reads on
 * every tool call. The rescue provider points at the rescue proxy and reads the key from the
 * run's token environment variable; the Reviewer key never appears in the file.
 */
export function writePiConfig(db: Db, rescueProxyUrl?: string) {
  const m = getModelSettings(db);
  fs.mkdirSync(config.piAgentDir, { recursive: true });
  const model: Record<string, unknown> = {
    id: m.modelId,
    name: m.modelId,
    reasoning: m.reasoning,
    input: ["text"],
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (m.thinkingFormat) model.compat = { thinkingFormat: m.thinkingFormat };
  const providers: Record<string, unknown> = {
    [PROVIDER_ID]: {
      name: "Workbench LLM",
      baseUrl: m.baseUrl,
      api: "openai-completions",
      // Local servers ignore the key; a hosted endpoint gets it from the LLM_API_KEY secret.
      apiKey: `$${LLM_KEY_ENV}`,
      models: [model],
    },
  };
  // A second provider for rescue and retro runs: the Reviewer's model through the localhost
  // proxy (ADR 0003). Generated only when the Reviewer has a model (an empty one turns rescue
  // and retro off) and the proxy URL is known.
  const reviewer = getAutoApproveSettings(db).reviewer;
  if (rescueProxyUrl && reviewer.model) {
    providers[RESCUE_PROVIDER_ID] = {
      name: "Workbench rescue (the Reviewer model)",
      baseUrl: rescueProxyUrl,
      api: reviewer.provider === "anthropic" ? "anthropic-messages" : "openai-completions",
      // The key here is the run's token; the proxy swaps it for the Reviewer key.
      apiKey: `$${RESCUE_TOKEN_ENV}`,
      models: [{
        id: reviewer.model,
        name: reviewer.model,
        input: ["text"],
        // Frontier models the Reviewer settings point at; adjust if the real limits differ.
        contextWindow: 200_000,
        maxTokens: 16_384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    };
  }
  writeJson(path.join(config.piAgentDir, "models.json"), { providers });
  const settingsFile = path.join(config.piAgentDir, "settings.json");
  const existing = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : {};
  writeJson(settingsFile, {
    ...existing,
    defaultProvider: PROVIDER_ID,
    defaultModel: m.modelId,
    defaultProjectTrust: "always",
    quietStartup: true,
    skills: [config.skillsDir],
    extensions: [config.extensionPath],
  });
  writeJson(rulesFile(), getApprovalSettings(db));
}

function writeJson(file: string, value: unknown) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
