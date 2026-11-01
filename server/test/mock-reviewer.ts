import http from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted answer: the reviewer's reply text, or a broken reply (status / raw body / delay). */
export type ReviewerReply = {
  text?: string;
  status?: number;
  body?: string;
  delayMs?: number;
};

/**
 * A scripted frontier reviewer for the auto-approve tests, speaking one provider API:
 * - "openai": `POST /v1/chat/completions` (Bearer key), answer in `choices[0].message.content`;
 * - "anthropic": `POST /v1/messages` (x-api-key header), answer in `content[0].text`.
 * Queued `replies` answer first; otherwise it allows with a canned reason. With `key`, every
 * request without that key gets 403, like the real APIs. A wrong model name gets 404, like llama-swap.
 */
export function startMockReviewer(opts: { provider: "openai" | "anthropic"; model: string; key?: string; defaultVerdict?: "allow" | "escalate" }): Promise<{
  url: string;
  requests: { path: string; model: string; auth?: string; xApiKey?: string; body: any }[];
  replies: ReviewerReply[];
  /** Review calls answered so far (one per finished POST), for tests that wait on a late verdict. */
  answered: () => number;
  close: () => Promise<void>;
}> {
  const requests: { path: string; model: string; auth?: string; xApiKey?: string; body: any }[] = [];
  const replies: ReviewerReply[] = [];
  let answered = 0;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const body = raw ? JSON.parse(raw) : {};
    const route = opts.provider === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
    requests.push({ path, model: body.model, auth: req.headers.authorization, xApiKey: req.headers["x-api-key"], body });
    if (opts.key) {
      const sent = opts.provider === "anthropic" ? req.headers["x-api-key"] : (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (sent !== opts.key) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "invalid api key" } }));
      }
    }
    if (req.method !== "POST" || path !== route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "not found" } }));
    }
    if (body.model !== opts.model) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `model ${body.model} not found` } }));
    }
    const reply = replies.shift() ?? { text: JSON.stringify({ verdict: opts.defaultVerdict ?? "allow", reason: `mock reviewer ${opts.defaultVerdict ?? "allows"} it` }) };
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    answered++;
    if (res.destroyed) return;
    if (reply.status && reply.status !== 200) {
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      return res.end(reply.body ?? JSON.stringify({ error: { message: "mock failure" } }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (reply.body !== undefined) return res.end(reply.body);
    if (opts.provider === "anthropic") {
      res.end(JSON.stringify({ id: "msg_mock", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: reply.text }], stop_reason: "end_turn" }));
    } else {
      res.end(JSON.stringify({ id: "mock", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: reply.text }, finish_reason: "stop" }] }));
    }
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
