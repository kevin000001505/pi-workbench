import { config } from "./config.ts";
import type { Db } from "./db.ts";
import { getSetting, putSetting } from "./db.ts";
import { complete } from "./llm.ts";
import type { SecretStore } from "./secrets.ts";

/**
 * Auto-approve (GLOSSARY.md, ADR 0002): a permission goes to the risk judge before the user. The
 * judge is one URL and a model; Save finds out which protocol the model speaks:
 * - TypeSafe System One (Jev): atomic yes/no questions (Nouls) about the call, and the rule below
 *   turns their answers into safe / risky / dangerous (Jev judges, code rates: the TypeSafe skill);
 * - OpenAI-compatible chat (llama-swap, any local server): the model answers with one word.
 * A TypeSafe model list means System One. An OpenAI-shaped list (llama-swap) can hold either, so
 * Save asks the model one System One request.
 * A safe rating answers Allow for that one call. Any other rating goes to the reviewer: a frontier
 * model (Claude or OpenAI) that allows the call, denies it with a reason the agent reads, or
 * escalates it to the user. A deny answers with the `{"wb": "deny"}` envelope the extension turns
 * into a reviewer-deny block; an escalation and a failure leave the card for the user with a note.
 * All question wording and the rule live in this module.
 */

/** Keys live in their own SecretStore scope: `envFor` reads only global and repo scopes, so they never reach pi. */
export const AUTO_APPROVE_SCOPE = "wb:auto-approve";
/** Rows in that scope: the token (and the origin it was saved for), and the reviewer API key. */
const SECRET_NAMES = { judgeToken: "JUDGE_TOKEN", tokenOrigin: "JUDGE_TOKEN_ORIGIN", reviewerKey: "REVIEWER_KEY" } as const;
/** The judge token and the origin it was saved for: it is only ever sent to that origin. */
export type JudgeToken = { judgeToken?: string; tokenOrigin?: string };

export type JudgeProtocol = "systemone" | "openai";
export type AutoApproveSettings = {
  enabled: boolean;
  judge: {
    baseUrl: string;
    model: string;
    /** Detected from the URL's model list when the settings are saved. */
    protocol: JudgeProtocol;
    /** System One: a Noul above this reads as yes, below `noBelow` as no; between is unsettled. */
    yesAbove: number;
    noBelow: number;
  };
  /** The frontier model that reviews the calls the judge did not rate safe. An empty model id means the reviewer is off. */
  reviewer: {
    provider: "anthropic" | "openai";
    baseUrl: string;
    model: string;
  };
};

const DEFAULTS: AutoApproveSettings = {
  enabled: false,
  judge: { baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", protocol: "systemone", yesAbove: 0.7, noBelow: 0.3 },
  reviewer: { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "" },
};

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

/** Parse an http(s) URL from the request, or refuse it with `message`. */
function httpUrl(value: unknown, message: string): URL {
  let url: URL | undefined;
  try {
    url = typeof value === "string" ? new URL(value) : undefined;
  } catch {}
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) throw bad(message);
  return url;
}

export function getAutoApproveSettings(db: Db): AutoApproveSettings {
  const saved = getSetting<Partial<AutoApproveSettings>>(db, "autoApprove") ?? {};
  // A safety switch: anything stored but a real `true` reads as off.
  return { enabled: saved.enabled === true, judge: pickJudge({ ...DEFAULTS.judge, ...saved.judge }), reviewer: pickReviewer({ ...DEFAULTS.reviewer, ...saved.reviewer }) };
}

const pickJudge = (j: AutoApproveSettings["judge"]): AutoApproveSettings["judge"] => ({
  baseUrl: j.baseUrl,
  model: j.model,
  protocol: j.protocol,
  yesAbove: j.yesAbove,
  noBelow: j.noBelow,
});

const pickReviewer = (r: AutoApproveSettings["reviewer"]): AutoApproveSettings["reviewer"] => ({
  provider: r.provider,
  baseUrl: r.baseUrl,
  model: r.model,
});

/** Validate and store. The protocol must already be known; `configureAutoApprove` detects it. */
export function saveAutoApproveSettings(db: Db, input: Partial<AutoApproveSettings>): AutoApproveSettings {
  const cur = getAutoApproveSettings(db);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw bad("Auto-approve must be on or off (true or false)");
  const next: AutoApproveSettings = { enabled: input.enabled ?? cur.enabled, judge: pickJudge({ ...cur.judge, ...input.judge }), reviewer: pickReviewer({ ...cur.reviewer, ...input.reviewer }) };
  validateJudge(next.judge);
  validateReviewer(next.reviewer);
  putSetting(db, "autoApprove", next);
  return next;
}

function validateJudge(j: AutoApproveSettings["judge"]) {
  httpUrl(j.baseUrl, "The judge URL must be an http:// or https:// URL");
  if (typeof j.model !== "string" || !j.model.trim()) throw bad("Pick the judge model");
  if (j.protocol !== "systemone" && j.protocol !== "openai") throw bad(`Unknown judge protocol ${String(j.protocol)}`);
  const ok = (x: unknown) => typeof x === "number" && x > 0 && x < 1;
  if (!ok(j.noBelow) || !ok(j.yesAbove) || !(j.noBelow < j.yesAbove)) {
    throw bad("The cut-offs must be between 0 and 1, with the no cut-off below the yes cut-off");
  }
}

/** The URL must always be a valid http(s) one; an empty model id is the "not configured" state. */
function validateReviewer(r: AutoApproveSettings["reviewer"]) {
  httpUrl(r.baseUrl, "The reviewer URL must be an http:// or https:// URL");
  if (r.provider !== "anthropic" && r.provider !== "openai") throw bad(`Unknown reviewer provider ${String(r.provider)}`);
  if (typeof r.model !== "string") throw bad("The reviewer model must be a string");
}

/**
 * Settings → Save: when the judge URL or model changes, list the URL's models, refuse a model the
 * URL does not serve, and store the protocol the model speaks. An unchanged judge is not asked, so
 * the switch can always be turned off, even while the judge is down.
 */
export async function configureAutoApprove(db: Db, secrets: SecretStore, input: Partial<AutoApproveSettings>) {
  const saved = getAutoApproveSettings(db).judge;
  if (!input.judge || (input.judge.baseUrl === saved.baseUrl && input.judge.model === saved.model)) {
    return saveAutoApproveSettings(db, { ...input, judge: input.judge && { ...input.judge, protocol: saved.protocol } });
  }
  const judge = pickJudge({ ...saved, ...input.judge, protocol: "systemone" });
  validateJudge(judge);
  const token = savedJudgeToken(secrets);
  const listed = await listJudgeModels(judge.baseUrl, token);
  if (!listed.models.includes(judge.model)) throw bad(`${judge.model} is not served at ${judge.baseUrl} (it serves: ${listed.models.join(", ") || "nothing"})`);
  const protocol = listed.protocol === "systemone" ? "systemone" : await speaksSystemOne(judge, token);
  return saveAutoApproveSettings(db, { ...input, judge: { ...judge, protocol } });
}

/**
 * An OpenAI-shaped list (llama-swap) can also hold System One models, so ask the model one Noul.
 * An answer means System One, a 404 or 501 means chat; anything else refuses Save with the reason.
 */
async function speaksSystemOne(j: AutoApproveSettings["judge"], saved: JudgeToken): Promise<JudgeProtocol> {
  const url = `${j.baseUrl.replace(/\/+$/, "")}/systemone`;
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(tokenFor(url, saved)) },
      body: JSON.stringify({ model: j.model, state: stateOf(HARMLESS), questions: QUESTIONS }),
      signal: AbortSignal.timeout(config.autoApproveTimeoutMs),
    });
    text = await res.text();
  } catch (err) {
    throw bad(`Can't tell whether ${j.model} speaks System One: ${why(err)}`);
  }
  // The server doesn't serve the path: llama.cpp answers 404, vLLM-style servers 501.
  if (res.status === 404 || res.status === 501) return "openai";
  if (res.ok && readNouls(text)) return "systemone";
  throw bad(`Can't tell whether ${j.model} speaks System One: HTTP ${res.status}${serverSays(text)}`);
}


/** Settings → List models: the given URL's list, or the saved judge's when none is given. */
export function listModelsFor(db: Db, secrets: SecretStore, baseUrl: unknown) {
  const url = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : getAutoApproveSettings(db).judge.baseUrl;
  httpUrl(url, "The judge URL must be an http:// or https:// URL");
  return listJudgeModels(url, savedJudgeToken(secrets));
}

/** `GET <url>/models`: TypeSafe answers `{ models: [{ name }] }`, an OpenAI-compatible server `{ data: [{ id }] }`. */
export async function listJudgeModels(baseUrl: string, saved: JudgeToken): Promise<{ protocol: JudgeProtocol; models: string[] }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  let res: Response;
  let body: any;
  try {
    res = await fetch(url, { headers: authHeaders(tokenFor(url, saved)), signal: AbortSignal.timeout(10_000) });
    body = await res.json().catch(() => undefined);
  } catch (err) {
    throw bad(`Can't list models at ${url}: ${why(err)}`);
  }
  if (!res.ok) throw bad(`Can't list models at ${url}: HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (check the token)" : ""}`);
  if (Array.isArray(body?.models)) return { protocol: "systemone", models: body.models.map((m: any) => String(m?.name)) };
  if (Array.isArray(body?.data)) return { protocol: "openai", models: body.data.map((m: any) => String(m?.id)) };
  throw bad(`${url} did not answer with a TypeSafe or OpenAI-compatible model list`);
}

export function savedJudgeToken(secrets: SecretStore): JudgeToken {
  return { judgeToken: secrets.get(AUTO_APPROVE_SCOPE, SECRET_NAMES.judgeToken), tokenOrigin: secrets.get(AUTO_APPROVE_SCOPE, SECRET_NAMES.tokenOrigin) };
}

/** The token for a request to `url`: only when the URL is on the origin the token was saved for. */
function tokenFor(url: string, saved: JudgeToken): string | undefined {
  try {
    return saved.judgeToken && new URL(url).origin === saved.tokenOrigin ? saved.judgeToken : undefined;
  } catch {
    return undefined;
  }
}

/** Keys are write-only: set with a value and, for the judge token, the URL it belongs to; cleared with null. */
export function saveAutoApproveKey(secrets: SecretStore, body: { key?: unknown; value?: unknown; baseUrl?: unknown }) {
  if (body.key === "judgeToken") {
    if (body.value === null) {
      secrets.delete(AUTO_APPROVE_SCOPE, SECRET_NAMES.judgeToken);
      return secrets.delete(AUTO_APPROVE_SCOPE, SECRET_NAMES.tokenOrigin);
    }
    if (typeof body.value !== "string" || !body.value.trim()) throw bad("Value is empty");
    // Check both values before writing either: a half-saved token could go to the old host.
    const origin = httpUrl(body.baseUrl, "Say which judge URL (http:// or https://) the token is for").origin;
    secrets.setAll(AUTO_APPROVE_SCOPE, [
      [SECRET_NAMES.judgeToken, body.value.trim()],
      [SECRET_NAMES.tokenOrigin, origin],
    ]);
    return;
  }
  if (body.key === "reviewerKey") {
    if (body.value === null) return secrets.delete(AUTO_APPROVE_SCOPE, SECRET_NAMES.reviewerKey);
    if (typeof body.value !== "string" || !body.value.trim()) throw bad("Value is empty");
    secrets.set(AUTO_APPROVE_SCOPE, SECRET_NAMES.reviewerKey, body.value.trim());
    return;
  }
  throw bad(`Unknown key ${String(body.key)}`);
}

/** What Settings shows: the settings, whether the keys are set and for which origin, never their values. */
export function autoApproveView(db: Db, secrets: SecretStore) {
  const saved = savedJudgeToken(secrets);
  return { ...getAutoApproveSettings(db), keys: { judgeToken: !!saved.judgeToken, tokenOrigin: saved.judgeToken ? saved.tokenOrigin : undefined, reviewerKey: !!savedReviewerKey(secrets) } };
}

export function savedReviewerKey(secrets: SecretStore): string | undefined {
  return secrets.get(AUTO_APPROVE_SCOPE, SECRET_NAMES.reviewerKey);
}

// --- judging -------------------------------------------------------------------------------

/** What the judge sees: what a person deciding this permission would look at. */
export type Permission = {
  tool: string;
  subject: string;
  reasons: string[];
  session: { title: string; task: string; repo: string; worktree: string; skill?: string; ticket?: string };
};

export type Level = "safe" | "risky" | "dangerous";

export type Verdict =
  | { outcome: "allow"; by: string; detail: string }
  | { outcome: "user"; by: string; rating: Exclude<Level, "safe">; detail: string; note: string }
  | { outcome: "failed"; by: string; note: string };

/** Jev's questions: one observable judgment each. The rule in `rate` turns the answers into a level. */
const QUESTIONS = {
  deletes_data: {
    type: "noul",
    instructions: "Does `call` delete, overwrite, or discard files, data, or commits?",
    criteria: { true: "It removes or replaces existing content, e.g. rm, a force push, git reset --hard", false: "It only reads, or adds new content" },
  },
  reaches_outside: {
    type: "noul",
    instructions: "Does `call` reach a machine, service, or path outside `session.worktree`?",
    criteria: {
      true: "It contacts another host or service (ssh, curl, git push, a package registry) or touches files outside the worktree",
      false: "It stays inside the worktree on this machine",
    },
  },
  hard_to_undo: {
    type: "noul",
    instructions: "Would the effect of `call` be hard to undo?",
    criteria: { true: "Undoing it needs a backup or another person, or is impossible", false: "Its effect can be reverted with git or by running a command again" },
  },
  fits_task: {
    type: "noul",
    instructions: "Is `call` a step the agent needs for `session.task`?",
    criteria: { true: "The call clearly serves the task", false: "The call is unrelated to the task, or goes beyond it" },
  },
} as const;
type Answers = Record<keyof typeof QUESTIONS, number>;

/**
 * The rating, in code. Safe: a clear no to deleting data and to being hard to undo, and a clear yes
 * to fitting the task. Reaching outside alone (a push, an install, a curl) does not block safe; with
 * a hard-to-undo effect it is dangerous.
 */
function rate(a: Answers, j: AutoApproveSettings["judge"]): Level {
  if (a.deletes_data < j.noBelow && a.hard_to_undo < j.noBelow && a.fits_task > j.yesAbove) return "safe";
  if (a.hard_to_undo > j.yesAbove && (a.deletes_data > j.yesAbove || a.reaches_outside > j.yesAbove)) return "dangerous";
  return "risky";
}

const CHAT_PROMPT = [
  "You rate one tool call that a coding agent wants to run on the user's machines.",
  "Reply with exactly one word:",
  "SAFE: routine for the session's task, contained to its worktree, and easily undone.",
  "RISKY: could change or lose work, reach other machines or services, or be hard to undo.",
  "DANGEROUS: could destroy data or break machines or services beyond the task.",
].join("\n");

const stateOf = (p: Permission) => ({
  call: { tool: p.tool, command: p.subject },
  rule_reasons: p.reasons,
  session: p.session,
});

/** Ask the risk judge about one permission. Never throws: a failure is a verdict too. */
export async function judgePermission(p: Permission, settings: AutoApproveSettings, saved: JudgeToken): Promise<Verdict> {
  const j = settings.judge;
  const by = j.model;
  const token = tokenFor(j.baseUrl, saved);
  if (j.protocol === "openai") {
    let reply: string;
    try {
      const call = { maxTokens: 1024, timeoutMs: config.autoApproveTimeoutMs, temperature: 0 };
      reply = await complete({ baseUrl: j.baseUrl, modelId: j.model }, token, CHAT_PROMPT, JSON.stringify(stateOf(p), null, 2), call);
    } catch (err) {
      const { status, body } = err as { status?: number; body?: string };
      return { outcome: "failed", by, note: `${by} failed: ${status ? `HTTP ${status}${serverSays(body ?? "")}` : why(err)}` };
    }
    const word = readWord(reply);
    if (!word) return { outcome: "failed", by, note: `${by} failed: the answer was not SAFE, RISKY or DANGEROUS` };
    if (word === "safe") return { outcome: "allow", by, detail: "SAFE" };
    return { outcome: "user", by, rating: word, detail: word.toUpperCase(), note: `${by} rated this ${word}.` };
  }

  let res: Response;
  let text: string;
  try {
    res = await fetch(`${j.baseUrl.replace(/\/+$/, "")}/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ model: j.model, state: stateOf(p), questions: QUESTIONS }),
      signal: AbortSignal.timeout(config.autoApproveTimeoutMs),
    });
    text = await res.text();
  } catch (err) {
    return { outcome: "failed", by, note: `${by} failed: ${why(err)}` };
  }
  if (!res.ok) return { outcome: "failed", by, note: `${by} failed: HTTP ${res.status}${serverSays(text)}` };
  const answers = readNouls(text);
  if (!answers) return { outcome: "failed", by, note: `${by} failed: the answer was unreadable (expected a probability from 0 to 1 for each question)` };
  const detail = (Object.keys(QUESTIONS) as (keyof Answers)[]).map((k) => `${k} ${answers[k].toFixed(2)}`).join(" · ");
  const level = rate(answers, j);
  if (level === "safe") return { outcome: "allow", by, detail };
  return { outcome: "user", by, rating: level, detail, note: `${by} rated this ${level}: ${detail}.` };
}

function readNouls(text: string): Answers | undefined {
  try {
    const answers = JSON.parse(text)?.answers;
    const out = {} as Answers;
    for (const k of Object.keys(QUESTIONS) as (keyof Answers)[]) {
      const p = answers?.[k]?.noul;
      if (typeof p !== "number" || !(p >= 0 && p <= 1)) return undefined;
      out[k] = p;
    }
    return out;
  } catch {
    return undefined;
  }
}

/** The reply must be the one word (markdown or a full stop around it is fine); a hedge is no answer. */
function readWord(reply: string): Level | undefined {
  const m = /^\W*(SAFE|RISKY|DANGEROUS)\W*$/i.exec(reply);
  return m ? (m[1].toLowerCase() as Level) : undefined;
}

/** The server's own reason for an HTTP error: TypeSafe's `detail`, an OpenAI-style `error.message`, or a plain-text body. */
function serverSays(text: string) {
  let said: unknown = text;
  try {
    const body = JSON.parse(text);
    said = body?.detail ?? body?.error?.message;
  } catch {}
  const s = typeof said === "string" ? said.trim().slice(0, 200) : "";
  return s ? `: ${s}` : "";
}

const authHeaders = (token: string | undefined): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

function why(err: unknown) {
  const e = err as Error & { cause?: { message?: string } };
  if (e.name === "TimeoutError") return `no answer within ${Math.round(config.autoApproveTimeoutMs / 1000)} s`;
  return [e.message, e.cause?.message].filter(Boolean).join(": ");
}

// --- reviewing ------------------------------------------------------------------------------

/** What the reviewer sees, gathered by the caller (SessionManager) from what it already holds. */
export type ReviewContext = {
  title: string;
  task: string;
  skill?: string;
  phase: string;
  ticket?: { num: number; title: string; body: string };
  repo: string;
  branch: string;
  worktree: string;
  /** alias, user, hostname only: never key names or key values. */
  sshHosts: { alias: string; user: string; hostname: string }[];
  /** The recent conversation, one line per message (see transcriptExcerpt). */
  recent: string;
  /** The judge's non-safe rating and its answers, attached to the call. */
  rating?: string;
  judgeDetail?: string;
};

export type ReviewVerdict =
  | { outcome: "allow"; by: string; reason: string }
  | { outcome: "deny"; by: string; reason: string }
  | { outcome: "escalate"; by: string; reason: string }
  | { outcome: "failed"; by: string; note: string };

/** The reviewer's name the agent and the transcript see: the provider, never the model id. */
export const reviewerName = (settings: AutoApproveSettings) => (settings.reviewer.provider === "anthropic" ? "Claude" : "OpenAI");

const REVIEWER_SYSTEM = [
  "You review one tool call that a coding agent wants to run on the user's machines.",
  "A risk judge already rated the call (see rating); you make the final call.",
  "Decide with the verdict tool:",
  "- allow: the call is safe to run for this task. Routine is routine; do not escalate the ordinary.",
  "- deny: the call is a wrong or risky approach the agent can redo differently. Give a short reason the agent will read and act on.",
  "- escalate: the call could damage data, other machines, or services beyond the task, or you cannot judge it from the context. Give a short reason for the user.",
  "Give a one or two sentence reason in every case.",
].join("\n");

const VERDICT_TOOL = {
  name: "verdict",
  description: "Your verdict on the tool call.",
  input_schema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["allow", "deny", "escalate"] },
      reason: { type: "string" },
    },
    required: ["decision", "reason"],
  },
};

const reviewerState = (p: Permission, ctx: ReviewContext) => ({
  call: { tool: p.tool, command: p.subject },
  rule_reasons: p.reasons,
  rating: ctx.rating,
  judge: ctx.judgeDetail,
  session: {
    title: ctx.title,
    task: ctx.task,
    ...(ctx.skill ? { skill: ctx.skill } : {}),
    phase: ctx.phase,
    ...(ctx.ticket ? { ticket: { num: ctx.ticket.num, title: ctx.ticket.title, body: ctx.ticket.body } } : {}),
    repo: ctx.repo,
    branch: ctx.branch,
    worktree: ctx.worktree,
    ssh_hosts: ctx.sshHosts.map((h) => `${h.alias} (${h.user}@${h.hostname})`),
  },
  recent_transcript: ctx.recent,
});

const readVerdict = (v: unknown): { decision: "allow" | "deny" | "escalate"; reason: string } | undefined => {
  const o = v as { decision?: unknown; reason?: unknown };
  if (!o || (o.decision !== "allow" && o.decision !== "deny" && o.decision !== "escalate")) return undefined;
  if (typeof o.reason !== "string" || !o.reason.trim()) return undefined;
  return { decision: o.decision, reason: o.reason };
};

/** Ask the reviewer about a call the judge did not rate safe. Never throws: a failure is a verdict too. */
export async function reviewPermission(p: Permission, ctx: ReviewContext, settings: AutoApproveSettings, savedKey: string | undefined): Promise<ReviewVerdict> {
  const by = reviewerName(settings);
  if (!settings.reviewer.model) return { outcome: "failed", by, note: `${by} has no model id set.` };
  if (!savedKey) return { outcome: "failed", by, note: `${by} has no API key set.` };
  const state = reviewerState(p, ctx);
  if (settings.reviewer.provider === "anthropic") {
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${settings.reviewer.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": savedKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: settings.reviewer.model,
          max_tokens: 1024,
          system: REVIEWER_SYSTEM,
          messages: [{ role: "user", content: JSON.stringify(state) }],
          tools: [VERDICT_TOOL],
          tool_choice: { type: "tool", name: "verdict" },
        }),
        signal: AbortSignal.timeout(config.autoApproveTimeoutMs),
      });
      text = await res.text();
    } catch (err) {
      return { outcome: "failed", by, note: `${by} failed: ${why(err)}` };
    }
    if (!res.ok) return { outcome: "failed", by, note: `${by} failed: HTTP ${res.status}${serverSays(text)}` };
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {}
    const use = (parsed?.content ?? []).find?.((b: any) => b?.type === "tool_use");
    const verdict = use ? readVerdict(use.input) : undefined;
    if (!verdict) return { outcome: "failed", by, note: `${by} failed: the verdict was unreadable (expected decision allow, deny or escalate with a reason)` };
    return { outcome: verdict.decision, by, reason: verdict.reason };
  }
  let reply: string;
  try {
    const call = { maxTokens: 1024, timeoutMs: config.autoApproveTimeoutMs, temperature: 0 };
    reply = await complete({ baseUrl: settings.reviewer.baseUrl, modelId: settings.reviewer.model }, savedKey, `${REVIEWER_SYSTEM} Reply with one JSON object: {"decision": "allow" | "deny" | "escalate", "reason": "..."}. Nothing else.`, JSON.stringify(state, null, 2), call);
  } catch (err) {
    const { status, body } = err as { status?: number; body?: string };
    return { outcome: "failed", by, note: `${by} failed: ${status ? `HTTP ${status}${serverSays(body ?? "")}` : why(err)}` };
  }
  let verdict: { decision: "allow" | "deny" | "escalate"; reason: string } | undefined;
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  if (json) {
    try {
      verdict = readVerdict(JSON.parse(json));
    } catch {}
  }
  if (!verdict) return { outcome: "failed", by, note: `${by} failed: the verdict was unreadable (expected decision allow, deny or escalate with a reason)` };
  return { outcome: verdict.decision, by, reason: verdict.reason };
}

/**
 * The recent conversation for the reviewer's context: the newest messages that fit, one line per
 * message, tool calls as `name args`. System messages and empty lines are dropped.
 */
export function transcriptExcerpt(messages: { role: string; content: unknown }[], maxChars = 1500): string {
  const lines: string[] = [];
  for (const m of messages.filter((x) => x.role !== "system").slice(-12)) {
    let text: string;
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = (m.content as any[])
        .map((b) => (b?.type === "text" ? b.text : b?.type === "toolCall" ? `${b.name} ${JSON.stringify(b.arguments ?? {})}` : ""))
        .join(" ");
    } else text = "";
    const line = `[${m.role}] ${text.replace(/\s+/g, " ").trim()}`.trim();
    if (line.length > 4) lines.push(line.slice(0, 400));
  }
  let out = "";
  for (const line of lines.reverse()) {
    if (out && line.length + out.length + 1 > maxChars) break;
    out = out ? `${line}\n${out}` : line;
  }
  return out;
}

/** The call Settings → Test and the Save probe ask about. */
const HARMLESS: Permission = {
  tool: "bash",
  subject: "ls",
  reasons: ["connection test"],
  session: { title: "Settings test", task: "List the files in the worktree.", repo: "example/repo", worktree: "/data/worktrees/example" },
};

/** Settings → Test: ask the saved judge about a harmless call and report whether it answered. */
export async function testJudge(settings: AutoApproveSettings, saved: JudgeToken) {
  const v = await judgePermission(HARMLESS, settings, saved);
  if (v.outcome === "failed") return { ok: false, message: v.note };
  return { ok: true, message: `${v.by} answered for \`ls\`: ${v.outcome === "allow" ? "safe" : v.rating} (${v.detail}).` };
}
