import { excerpt, explainFailure } from "../../shared/endpoint.ts";
import type { ModelSettings } from "./settings.ts";

export type ProbeCheck = {
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  contentType?: string;
  excerpt?: string;
  hint?: string;
  ms: number;
};

/**
 * Settings → Test: list the endpoint's models, then send the configured model a 1-token chat
 * completion, the same route sessions use. Each check says which URL failed and why.
 */
export async function probeEndpoint(m: ModelSettings, apiKey?: string) {
  const base = m.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  let models: string[] | undefined;

  const run = async (name: string, url: string, init: RequestInit, timeoutMs: number, parse?: (body: string) => void): Promise<ProbeCheck> => {
    const start = Date.now();
    try {
      const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
      const body = await res.text();
      const contentType = res.headers.get("content-type") ?? "";
      let ok = res.ok && contentType.includes("json");
      if (ok && parse) {
        try {
          parse(body);
        } catch {
          ok = false;
        }
      }
      return {
        name,
        url,
        ok,
        status: res.status,
        contentType,
        excerpt: excerpt(body),
        hint: ok ? undefined : explainFailure({ url, status: res.status, contentType, body, modelId: m.modelId, models: name === "Chat" ? models : undefined }),
        ms: Date.now() - start,
      };
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } };
      const error = [e.name, e.message, e.cause?.code, e.cause?.message].filter(Boolean).join(" ");
      return { name, url, ok: false, hint: explainFailure({ url, error }), ms: Date.now() - start };
    }
  };

  const list = await run("Models", `${base}/models`, { method: "GET" }, 10_000, (body) => {
    models = ((JSON.parse(body) as { data?: { id: string }[] }).data ?? []).map((d) => d.id).sort();
  });
  const chat = await run(
    "Chat",
    `${base}/chat/completions`,
    {
      method: "POST",
      body: JSON.stringify({ model: m.modelId, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, stream: false }),
    },
    180_000,
    (body) => {
      if (!Array.isArray(JSON.parse(body).choices)) throw new Error("no choices");
    },
  );
  return { ok: list.ok && chat.ok, checks: [list, chat], models: models ?? [] };
}

/** Model IDs the OpenAI-compatible endpoint (llama-swap) serves. */
export async function listModels(m: ModelSettings, apiKey?: string): Promise<string[]> {
  const res = await fetch(`${m.baseUrl.replace(/\/+$/, "")}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${m.baseUrl}/models: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data?: { id: string }[] };
  return (body.data ?? []).map((d) => d.id).sort();
}

/** One non-streaming chat completion; returns the assistant text with any <think> block removed. */
export async function complete(
  m: Pick<ModelSettings, "baseUrl" | "modelId">,
  apiKey: string | undefined,
  system: string,
  user: string,
  maxTokens = 4000,
  timeoutMs = 300_000,
) {
  const res = await fetch(`${m.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model: m.modelId,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (body.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
