import http from "node:http";
import type { AddressInfo } from "node:net";
import { holdUntilReleased } from "./mock-judge.ts";

/** One scripted verdict, or a broken reply (garbage body, HTTP error, or a hang). */
export type ReviewerReply = {
  text?: string;
  decision?: "allow" | "deny" | "escalate";
  reason?: string;
  status?: number;
  /** A raw body to send instead of a well-formed answer (unreadable verdicts), or with `status`, the error body. */
  body?: string;
  /** Hold the verdict until the test calls `release()`, or the client hangs up (a cancel or a timeout). */
  hold?: boolean;
};

/**
 * A scripted frontier reviewer, speaking the API its provider uses:
 * - "anthropic": `POST /v1/messages` (x-api-key), a JSON verdict in the reply text;
 * - "openai": `POST /chat/completions` (Bearer or x-api-key), a JSON verdict in the reply text.
 * Queued `replies` answer first. Otherwise: when `defaultVerdict` is set, every non-queued
 * call is answered with it (the subject script stays off); when it is not set, it answers by
 * the call in the state: `rm -rf /mnt` is denied, `ssh` is escalated, any other `rm` is
 * allowed, anything else is allowed too. With `key`, every request without that API key gets
 * 401, like the public APIs.
 */
export function startMockReviewer(opts: { provider: "anthropic" | "openai"; model: string; key?: string; defaultVerdict?: "allow" | "escalate" }): Promise<{
  url: string;
  requests: { path: string; model: string; key?: string; auth?: string; xApiKey?: string; body: any }[];
  replies: ReviewerReply[];
  /** Review calls answered so far (one per finished POST), for tests that wait on a late verdict. */
  answered: () => number;
  /** Review calls the client hung up on before their answer was sent (a cancelled review). */
  dropped: () => number;
  /** Calls held now (see `ReviewerReply.hold`). */
  held: () => number;
  /** Answer every held call. */
  release: () => void;
  close: () => Promise<void>;
}> {
  const held = new Set<() => void>();
  let dropped = 0;
  const requests: { path: string; model: string; key?: string; auth?: string; xApiKey?: string; body: any }[] = [];
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
    requests.push({ path, model: String(body.model ?? ""), key: key || undefined, auth: req.headers.authorization as string | undefined, xApiKey: req.headers["x-api-key"] as string | undefined, body });
    if (opts.key && key !== opts.key) return send(res, 401, { error: { message: "invalid api key" } });
    const route = opts.provider === "anthropic" ? "/v1/messages" : ["/chat/completions", "/v1/chat/completions"];
    if (req.method !== "POST" || (Array.isArray(route) ? !route.includes(path) : path !== route)) return send(res, 404, { error: "not found" });
    // llama-swap-style proxies pick the model by name; the public APIs refuse one they don't serve.
    if (body.model !== opts.model) return send(res, 404, { error: { message: `model ${body.model} not found` } });

    // Both providers send the state object as the user message's content string.
    const userMsg = (body.messages ?? []).find((m: any) => m.role === "user");
    const state = typeof userMsg?.content === "string" ? userMsg.content : JSON.stringify(body);
    const reply = replies.shift() ?? (opts.defaultVerdict ? undefined : scriptFor(/"command":\s*"([^"]*)"/.exec(state)?.[1] ?? ""));
    if (reply?.hold) await holdUntilReleased(held, res);
    answered++;
    if (res.destroyed) {
      dropped++;
      return;
    }
    if (reply?.status && reply.status !== 200) return send(res, reply.status, reply.body ?? { error: { message: "mock failure" } });
    if (reply?.body !== undefined) return send(res, 200, reply.body);
    const verdict = { decision: reply?.decision ?? (opts.defaultVerdict ?? "allow"), reason: reply?.reason ?? `mock reviewer ${(opts.defaultVerdict ?? "allow") === "allow" ? "allows" : "escalates"} it` };
    // The request names no tools, so a model answers in text: the JSON verdict in the content text.
    if (opts.provider === "anthropic") {
      const text = reply?.text ?? JSON.stringify({ decision: verdict.decision, reason: verdict.reason });
      return send(res, 200, { id: "msg_mock", type: "message", role: "assistant", model: opts.model, content: [{ type: "text", text }], stop_reason: "end_turn" });
    }
    send(res, 200, { id: "mock", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply?.text ?? JSON.stringify(verdict) }, finish_reason: "stop" }] });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port: p } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${p}`,
        requests,
        replies,
        answered: () => answered,
        dropped: () => dropped,
        held: () => held.size,
        release: () => [...held].forEach((done) => done()),
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
