import http from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted verdict, or a broken reply (garbage body, HTTP error, or a hang). */
export type ReviewerReply = {
  decision?: "allow" | "deny" | "escalate";
  reason?: string;
  status?: number;
  /** A raw body to send instead of a well-formed answer (unreadable verdicts), or with `status`, the error body. */
  body?: string;
  delayMs?: number;
};

/**
 * A scripted frontier reviewer, speaking the API its provider uses:
 * - "anthropic": `POST /v1/messages` with a forced `verdict` tool call;
 * - "openai": `POST /chat/completions` with a JSON verdict in the reply text.
 * Queued `replies` answer first; otherwise it answers by the call in the state:
 * `rm -rf /mnt` is denied, `ssh` is escalated, any other `rm` is allowed. With `key`, every
 * request without that API key gets 401, like the public APIs.
 */
export function startMockReviewer(opts: { provider: "anthropic" | "openai"; model: string; key?: string }): Promise<{
  url: string;
  requests: { path: string; key?: string; body: any }[];
  replies: ReviewerReply[];
  /** Review calls answered so far (one per finished POST), for tests that wait on a late verdict. */
  answered: () => number;
  close: () => Promise<void>;
}> {
  const requests: { path: string; key?: string; body: any }[] = [];
  const replies: ReviewerReply[] = [];
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
    const key = (req.headers["x-api-key"] ?? (req.headers.authorization ?? "").replace(/^Bearer /, "")) as string;
    requests.push({ path, key: key || undefined, body });
    if (opts.key && key !== opts.key) return send(res, 401, { error: { message: "invalid api key" } });
    const route = opts.provider === "anthropic" ? "/v1/messages" : "/chat/completions";
    if (req.method !== "POST" || path !== route) return send(res, 404, { error: "not found" });
    // llama-swap-style proxies pick the model by name; the public APIs refuse one they don't serve.
    if (body.model !== opts.model) return send(res, 404, { error: { message: `model ${body.model} not found` } });

    // Both providers send the state object as the user message's content string.
    const userMsg = (body.messages ?? []).find((m: any) => m.role === "user");
    const state = typeof userMsg?.content === "string" ? userMsg.content : JSON.stringify(body);
    const reply = replies.shift() ?? scriptFor(/"command":\s*"([^"]*)"/.exec(state)?.[1] ?? "");
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    answered++;
    if (res.destroyed) return;
    if (reply.status && reply.status !== 200) return send(res, reply.status, reply.body ?? { error: { message: "mock failure" } });
    if (reply.body !== undefined) return send(res, 200, reply.body);
    const verdict = { decision: reply.decision!, reason: reply.reason! };
    if (opts.provider === "anthropic") {
      return send(res, 200, {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: opts.model,
        content: [{ type: "tool_use", id: "toolu_mock", name: "verdict", input: verdict }],
        stop_reason: "tool_use",
        usage: { input_tokens: 400, output_tokens: 30 },
      });
    }
    send(res, 200, { id: "mock", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(verdict) }, finish_reason: "stop" }] });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port: p } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${p}`,
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

function scriptFor(command: string): Required<Pick<ReviewerReply, "decision" | "reason">> {
  if (command.includes("rm -rf /mnt")) return { decision: "deny", reason: "Deletes data outside the worktree; that is not part of the task." };
  if (/^\s*ssh(\s|$)/.test(command)) return { decision: "escalate", reason: "Reaches a machine beyond the task; I cannot judge the target." };
  if (command.includes("rm ")) return { decision: "allow", reason: "Routine cleanup for the task." };
  return { decision: "allow", reason: "Routine for the task." };
}
