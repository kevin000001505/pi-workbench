import http from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted answer: Jev's Noul probabilities or a chat model's reply text, or a broken reply. */
export type JudgeReply = {
  /** System One: P(yes) per question name. */
  nouls?: Record<string, number>;
  /** OpenAI-compatible: the assistant's reply text. */
  text?: string;
  status?: number;
  /** A raw body to send instead of a well-formed answer (unreadable answers), or with `status`, the error body. */
  body?: string;
  delayMs?: number;
};

export const SAFE = { deletes_data: 0.04, reaches_outside: 0.05, hard_to_undo: 0.03, fits_task: 0.92 };
export const RISKY = { deletes_data: 0.9, reaches_outside: 0.1, hard_to_undo: 0.6, fits_task: 0.8 };
export const DANGEROUS = { deletes_data: 0.9, reaches_outside: 0.9, hard_to_undo: 0.9, fits_task: 0.5 };
/** What a faithful Jev answers for `git push` of the session branch: it reaches outside, nothing else. */
export const PUSH = { deletes_data: 0.03, reaches_outside: 0.95, hard_to_undo: 0.1, fits_task: 0.9 };

/**
 * A scripted risk judge for the auto-approve tests, speaking one protocol:
 * - "systemone": TypeSafe's `GET /v1/models` ({ models: [{ name }] }) and `POST /v1/systemone` (Nouls);
 * - "openai": an OpenAI-compatible `GET /v1/models` ({ data: [{ id }] }) and `POST /v1/chat/completions`.
 * Queued `replies` answer first; otherwise it answers by the call in the state: `rm ` is risky,
 * `git push` reaches outside (and is otherwise safe), anything else safe. With `token`, every request without that bearer token gets 403, like TypeSafe.
 * `list: "openai"` lists a System One model the way llama-swap does, in the OpenAI shape.
 */
export function startMockJudge(opts: { protocol: "systemone" | "openai"; model: string; token?: string; list?: "systemone" | "openai" }): Promise<{
  url: string;
  requests: { path: string; auth?: string; body: any }[];
  replies: JudgeReply[];
  /** Judge calls answered so far (one per finished POST), for tests that wait on a late verdict. */
  answered: () => number;
  close: () => Promise<void>;
}> {
  const requests: { path: string; auth?: string; body: any }[] = [];
  const replies: JudgeReply[] = [];
  let answered = 0;
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path, auth: req.headers.authorization, body });
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return send(res, 403, { detail: "Not authenticated" });
    if (req.method === "GET" && path === "/v1/models") {
      return send(
        res,
        200,
        (opts.list ?? opts.protocol) === "systemone"
          ? { models: [{ name: opts.model, description: "mock", release_date: "2026-09-15" }] }
          : { object: "list", data: [{ id: opts.model, object: "model" }] },
      );
    }
    const route = opts.protocol === "systemone" ? "/v1/systemone" : "/v1/chat/completions";
    if (req.method !== "POST" || path !== route) return send(res, 404, { error: "not found" });
    // llama-swap picks the model process by name, and TypeSafe refuses a model it doesn't serve.
    if (body.model !== opts.model) return send(res, 404, { error: { message: `model ${body.model} not found` } });

    const state = JSON.stringify(opts.protocol === "systemone" ? body.state : body.messages);
    const risky = state.includes("rm ");
    const push = state.includes("git push");
    const reply = replies.shift() ?? (opts.protocol === "systemone" ? { nouls: risky ? RISKY : push ? PUSH : SAFE } : { text: risky ? "RISKY" : "SAFE" });
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    answered++;
    if (res.destroyed) return;
    if (reply.status && reply.status !== 200) return send(res, reply.status, reply.body ?? { error: "mock failure" });
    if (reply.body !== undefined) return send(res, 200, reply.body);
    if (opts.protocol === "systemone") {
      const answers = Object.fromEntries(Object.entries(reply.nouls!).map(([k, v]) => [k, { type: "noul", noul: v }]));
      return send(res, 200, { model: "jev-1.14.0", answers, usage: { input_tokens: 300, output_tokens: 8 } });
    }
    send(res, 200, { id: "mock", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply.text }, finish_reason: "stop" }] });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        replies,
        answered: () => answered,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
