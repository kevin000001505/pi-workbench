import type { Db } from "./db.ts";
import { getSetting, putSetting } from "./db.ts";
import type { SecretStore } from "./secrets.ts";

/**
 * Auto-approve (GLOSSARY.md, ADR 0002): a permission goes to the risk judge before the user. Jev
 * rates the call safe, risky, or dangerous; a confident "safe" answers Allow for that one call, and
 * everything else, including a judge failure, waits for the user with a note on why.
 */

/** Keys live in their own SecretStore scope: `envFor` reads only global and repo scopes, so they never reach pi. */
export const AUTO_APPROVE_SCOPE = "wb:auto-approve";
const KEY_NAMES = { jevToken: "JEV_TOKEN" } as const;
export type AutoApproveKey = keyof typeof KEY_NAMES;

export type AutoApproveSettings = {
  enabled: boolean;
  judge: { kind: "jev"; jevBaseUrl: string; safeThreshold: number };
};

const DEFAULTS: AutoApproveSettings = {
  enabled: false,
  judge: { kind: "jev", jevBaseUrl: "https://api.typesafe.ai/v1", safeThreshold: 0.8 },
};

export function getAutoApproveSettings(db: Db): AutoApproveSettings {
  const saved = getSetting<Partial<AutoApproveSettings>>(db, "autoApprove") ?? {};
  return { ...DEFAULTS, ...saved, judge: { ...DEFAULTS.judge, ...saved.judge } };
}

export function saveAutoApproveSettings(db: Db, input: Partial<AutoApproveSettings>): AutoApproveSettings {
  const cur = getAutoApproveSettings(db);
  const next: AutoApproveSettings = {
    enabled: input.enabled ?? cur.enabled,
    judge: { ...cur.judge, ...input.judge, kind: "jev" },
  };
  if (!/^https?:\/\//.test(next.judge.jevBaseUrl)) throw new Error("Jev URL must start with http:// or https://");
  const t = next.judge.safeThreshold;
  if (typeof t !== "number" || !(t > 0 && t <= 1)) throw new Error("The safe threshold must be above 0 and at most 1");
  putSetting(db, "autoApprove", next);
  return next;
}

export function setAutoApproveKey(secrets: SecretStore, key: AutoApproveKey, value: string | null) {
  if (value) secrets.set(AUTO_APPROVE_SCOPE, KEY_NAMES[key], value);
  else secrets.delete(AUTO_APPROVE_SCOPE, KEY_NAMES[key]);
}

export type Permission = { tool: string; subject: string; reasons: string[]; cwd?: string; repo?: string };

/** The risk judge's rating levels, in Jev's score order. */
export const LEVELS = ["safe", "risky", "dangerous"] as const;
export type Level = (typeof LEVELS)[number];

export type Verdict =
  | { decision: "allow"; by: "jev"; pSafe: number }
  | { decision: "user"; by: "jev"; pSafe: number; rating: Level; note: string }
  | { decision: "failed"; by: "jev"; note: string };

const timeoutMs = () => Number(process.env.AUTO_APPROVE_TIMEOUT_MS ?? 60_000);

const RISK_QUESTION = {
  type: "score",
  instructions:
    "A coding agent wants to run this tool call on the user's machines. How much harm could it do to data, systems, or anything outside the task?",
  criteria: [
    "Safe: routine for the task, contained to the agent's worktree or easily undone",
    "Risky: could change or lose work, reach other systems, or be hard to undo",
    "Dangerous: could destroy data or break machines or services beyond the task",
  ],
};

/** Ask the risk judge about one permission. Never throws: a failure is a verdict too. */
export async function reviewPermission(
  p: Permission,
  settings: AutoApproveSettings,
  keys: { jevToken?: string },
): Promise<Verdict> {
  const base = settings.judge.jevBaseUrl.replace(/\/+$/, "");
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${base}/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(keys.jevToken ? { Authorization: `Bearer ${keys.jevToken}` } : {}) },
      body: JSON.stringify({ model: "jev-latest", state: JSON.stringify(p), questions: { risk: RISK_QUESTION } }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    text = await res.text();
  } catch (err) {
    const e = err as Error;
    const why = e.name === "TimeoutError" ? `no answer within ${Math.round(timeoutMs() / 1000)} s` : e.message;
    return { decision: "failed", by: "jev", note: `Jev failed: ${why}` };
  }
  if (!res.ok) return { decision: "failed", by: "jev", note: `Jev failed: HTTP ${res.status}` };
  const probs = readProbabilities(text);
  if (!probs) return { decision: "failed", by: "jev", note: "Jev failed: the answer had no risk probabilities" };
  const [pSafe] = probs;
  if (pSafe >= settings.judge.safeThreshold) return { decision: "allow", by: "jev", pSafe };
  const rating: Level = probs[2] > probs[1] ? "dangerous" : "risky";
  return {
    decision: "user",
    by: "jev",
    pSafe,
    rating,
    note: `Jev rated this ${rating} (P(safe)=${pSafe.toFixed(2)}, below ${settings.judge.safeThreshold}).`,
  };
}

function readProbabilities(text: string): [number, number, number] | undefined {
  try {
    const p = JSON.parse(text)?.answers?.risk?.probabilities;
    const v = [p?.["0"], p?.["1"], p?.["2"]];
    return v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as [number, number, number]) : undefined;
  } catch {
    return undefined;
  }
}

export function autoApproveKeys(secrets: SecretStore): { jevToken?: string } {
  return { jevToken: secrets.get(AUTO_APPROVE_SCOPE, KEY_NAMES.jevToken) };
}

/** What Settings shows: the settings and whether each key is set, never a key's value. */
export function autoApproveView(db: Db, secrets: SecretStore) {
  const keys = autoApproveKeys(secrets);
  return { ...getAutoApproveSettings(db), keys: { jevToken: !!keys.jevToken } };
}

/** Settings → Test: ask the risk judge about a harmless call and report whether it answered. */
export async function testJudge(settings: AutoApproveSettings, keys: { jevToken?: string }) {
  const v = await reviewPermission({ tool: "bash", subject: "ls", reasons: ["connection test"] }, settings, keys);
  if (v.decision === "failed") return { ok: false, message: v.note };
  return { ok: true, message: `Jev answered: P(safe)=${v.pSafe.toFixed(2)} for \`ls\`.` };
}
