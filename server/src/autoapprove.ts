import { config } from "./config.ts";
import type { Db } from "./db.ts";
import { getSetting, putSetting } from "./db.ts";
import { complete } from "./llm.ts";
import type { SecretStore } from "./secrets.ts";

/**
 * Auto-approve (GLOSSARY.md, ADR 0002): a permission goes to the risk judge before the user. The
 * judge is one URL; its `GET /models` answer says which protocol it speaks:
 * - TypeSafe System One (Jev): atomic yes/no questions (Nouls) about the call, and the rule below
 *   turns their answers into safe / risky / dangerous (Jev judges, code rates: the TypeSafe skill);
 * - OpenAI-compatible chat (llama-swap, any local server): the model answers with one word.
 * A safe rating answers Allow for that one call; anything else, including a judge failure, waits
 * for the user with a note on why. All question wording and the rule live in this module.
 */

/** Keys live in their own SecretStore scope: `envFor` reads only global and repo scopes, so they never reach pi. */
export const AUTO_APPROVE_SCOPE = "wb:auto-approve";
const KEY_NAMES = { judgeToken: "JUDGE_TOKEN", tokenOrigin: "JUDGE_TOKEN_ORIGIN" } as const;
/** The judge token and the origin it was saved for: it is only ever sent to that origin. */
export type JudgeKeys = { judgeToken?: string; tokenOrigin?: string };

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
};

const DEFAULTS: AutoApproveSettings = {
  enabled: false,
  judge: { baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", protocol: "systemone", yesAbove: 0.7, noBelow: 0.3 },
};

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

export function getAutoApproveSettings(db: Db): AutoApproveSettings {
  const saved = getSetting<Partial<AutoApproveSettings>>(db, "autoApprove") ?? {};
  // A safety switch: anything stored but a real `true` reads as off.
  return { enabled: saved.enabled === true, judge: pickJudge({ ...DEFAULTS.judge, ...saved.judge }) };
}

const pickJudge = (j: AutoApproveSettings["judge"]): AutoApproveSettings["judge"] => ({
  baseUrl: j.baseUrl,
  model: j.model,
  protocol: j.protocol,
  yesAbove: j.yesAbove,
  noBelow: j.noBelow,
});

/** Validate and store. The protocol must already be known; `configureAutoApprove` detects it. */
export function saveAutoApproveSettings(db: Db, input: Partial<AutoApproveSettings>): AutoApproveSettings {
  const cur = getAutoApproveSettings(db);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw bad("Auto-approve must be on or off (true or false)");
  const next: AutoApproveSettings = { enabled: input.enabled ?? cur.enabled, judge: pickJudge({ ...cur.judge, ...input.judge }) };
  validateJudge(next.judge);
  putSetting(db, "autoApprove", next);
  return next;
}

function validateJudge(j: AutoApproveSettings["judge"]) {
  if (typeof j.baseUrl !== "string" || !/^https?:\/\//.test(j.baseUrl)) throw bad("The judge URL must start with http:// or https://");
  if (typeof j.model !== "string" || !j.model.trim()) throw bad("Pick the judge model");
  if (j.protocol !== "systemone" && j.protocol !== "openai") throw bad(`Unknown judge protocol ${String(j.protocol)}`);
  const ok = (x: unknown) => typeof x === "number" && x > 0 && x < 1;
  if (!ok(j.noBelow) || !ok(j.yesAbove) || !(j.noBelow < j.yesAbove)) {
    throw bad("The cut-offs must be between 0 and 1, with the no cut-off below the yes cut-off");
  }
}

/**
 * Settings → Save: when the judge URL or model changes, list the URL's models, store the protocol
 * that list implies, and refuse a model the URL does not serve. An unchanged judge is not asked, so
 * the switch can always be turned off, even while the judge is down.
 */
export async function configureAutoApprove(db: Db, secrets: SecretStore, input: Partial<AutoApproveSettings>) {
  const saved = getAutoApproveSettings(db).judge;
  if (!input.judge || (input.judge.baseUrl === saved.baseUrl && input.judge.model === saved.model)) {
    return saveAutoApproveSettings(db, { ...input, judge: input.judge && { ...input.judge, protocol: saved.protocol } });
  }
  const judge = pickJudge({ ...saved, ...input.judge, protocol: "systemone" });
  validateJudge(judge);
  const { protocol, models } = await listJudgeModels(judge.baseUrl, autoApproveKeys(secrets));
  if (!models.includes(judge.model)) throw bad(`${judge.model} is not served at ${judge.baseUrl} (it serves: ${models.join(", ") || "nothing"})`);
  return saveAutoApproveSettings(db, { ...input, judge: { ...judge, protocol } });
}

/** Settings → List models: the given URL's list, or the saved judge's when none is given. */
export function listModelsFor(db: Db, secrets: SecretStore, baseUrl: unknown) {
  const url = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : getAutoApproveSettings(db).judge.baseUrl;
  if (!/^https?:\/\//.test(url)) throw bad("The judge URL must start with http:// or https://");
  return listJudgeModels(url, autoApproveKeys(secrets));
}

/** `GET <url>/models`: TypeSafe answers `{ models: [{ name }] }`, an OpenAI-compatible server `{ data: [{ id }] }`. */
export async function listJudgeModels(baseUrl: string, keys: JudgeKeys): Promise<{ protocol: JudgeProtocol; models: string[] }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  let res: Response;
  let body: any;
  try {
    res = await fetch(url, { headers: authHeaders(tokenFor(url, keys)), signal: AbortSignal.timeout(10_000) });
    body = await res.json().catch(() => undefined);
  } catch (err) {
    throw bad(`Can't list models at ${url}: ${why(err)}`);
  }
  if (!res.ok) throw bad(`Can't list models at ${url}: HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (check the token)" : ""}`);
  if (Array.isArray(body?.models)) return { protocol: "systemone", models: body.models.map((m: any) => String(m?.name)) };
  if (Array.isArray(body?.data)) return { protocol: "openai", models: body.data.map((m: any) => String(m?.id)) };
  throw bad(`${url} did not answer with a TypeSafe or OpenAI-compatible model list`);
}

export function autoApproveKeys(secrets: SecretStore): JudgeKeys {
  return { judgeToken: secrets.get(AUTO_APPROVE_SCOPE, KEY_NAMES.judgeToken), tokenOrigin: secrets.get(AUTO_APPROVE_SCOPE, KEY_NAMES.tokenOrigin) };
}

/** The token for a request to `url`: only when the URL is on the origin the token was saved for. */
function tokenFor(url: string, keys: JudgeKeys): string | undefined {
  try {
    return keys.judgeToken && new URL(url).origin === keys.tokenOrigin ? keys.judgeToken : undefined;
  } catch {
    return undefined;
  }
}

/** Keys are write-only: set with a value and the judge URL it belongs to, cleared with null. */
export function saveAutoApproveKey(secrets: SecretStore, body: { key?: unknown; value?: unknown; baseUrl?: unknown }) {
  if (body.key !== "judgeToken") throw bad(`Unknown key ${String(body.key)}`);
  if (body.value === null) return secrets.delete(AUTO_APPROVE_SCOPE, KEY_NAMES.judgeToken);
  if (typeof body.value !== "string" || !body.value.trim()) throw bad("Value is empty");
  if (typeof body.baseUrl !== "string" || !/^https?:\/\//.test(body.baseUrl)) throw bad("Say which judge URL the token is for");
  secrets.set(AUTO_APPROVE_SCOPE, KEY_NAMES.judgeToken, body.value.trim());
  secrets.set(AUTO_APPROVE_SCOPE, KEY_NAMES.tokenOrigin, new URL(body.baseUrl).origin);
}

/** What Settings shows: the settings, whether the token is set and for which origin, never its value. */
export function autoApproveView(db: Db, secrets: SecretStore) {
  const keys = autoApproveKeys(secrets);
  return { ...getAutoApproveSettings(db), keys: { judgeToken: !!keys.judgeToken, tokenOrigin: keys.judgeToken ? keys.tokenOrigin : undefined } };
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
export async function judgePermission(p: Permission, settings: AutoApproveSettings, keys: JudgeKeys): Promise<Verdict> {
  const j = settings.judge;
  const by = j.model;
  const token = tokenFor(j.baseUrl, keys);
  if (j.protocol === "openai") {
    let reply: string;
    try {
      reply = await complete({ baseUrl: j.baseUrl, modelId: j.model }, token, CHAT_PROMPT, JSON.stringify(stateOf(p), null, 2), 1024, config.autoApproveTimeoutMs);
    } catch (err) {
      return { outcome: "failed", by, note: `${by} failed: ${why(err)}` };
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
  if (!res.ok) return { outcome: "failed", by, note: `${by} failed: HTTP ${res.status}` };
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

const authHeaders = (token: string | undefined): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

function why(err: unknown) {
  const e = err as Error & { cause?: { message?: string } };
  if (e.name === "TimeoutError") return `no answer within ${Math.round(config.autoApproveTimeoutMs / 1000)} s`;
  return [e.message, e.cause?.message].filter(Boolean).join(": ");
}

/** Settings → Test: ask the saved judge about a harmless call and report whether it answered. */
export async function testJudge(settings: AutoApproveSettings, keys: JudgeKeys) {
  const v = await judgePermission(
    {
      tool: "bash",
      subject: "ls",
      reasons: ["connection test"],
      session: { title: "Settings test", task: "List the files in the worktree.", repo: "example/repo", worktree: "/data/worktrees/example" },
    },
    settings,
    keys,
  );
  if (v.outcome === "failed") return { ok: false, message: v.note };
  return { ok: true, message: `${v.by} answered for \`ls\`: ${v.outcome === "allow" ? "safe" : v.rating} (${v.detail}).` };
}
