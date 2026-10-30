import type { ModelSettings } from "./settings.ts";

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
export async function complete(m: ModelSettings, apiKey: string | undefined, system: string, user: string, maxTokens = 4000) {
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
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (body.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
