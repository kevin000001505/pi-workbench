import http from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted answer: Jev's three level probabilities, or a broken reply. */
export type JudgeReply = {
  /** P(safe), P(risky), P(dangerous); the score is their index-weighted mean. */
  probabilities?: [number, number, number];
  status?: number;
  /** A raw body to send instead of a Jev answer (unreadable answers). */
  body?: string;
  delayMs?: number;
};

/**
 * A scripted Jev (`POST /v1/systemone`) for the auto-approve tests. Queued `replies` answer first;
 * otherwise it answers by the subject in the state: "push" is safe, "rm" risky, "ssh" dangerous.
 */
export function startMockJudge(port = 0): Promise<{
  url: string;
  requests: { auth?: string; body: any }[];
  replies: JudgeReply[];
  close: () => Promise<void>;
}> {
  const requests: { auth?: string; body: any }[] = [];
  const replies: JudgeReply[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    if (req.method !== "POST" || !req.url?.endsWith("/systemone")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const body = JSON.parse(raw || "{}");
    requests.push({ auth: req.headers.authorization, body });
    const reply = replies.shift() ?? byKeyword(String(body.state ?? ""));
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;
    if (reply.status && reply.status !== 200) {
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "mock failure" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (reply.body !== undefined) {
      res.end(reply.body);
      return;
    }
    const [p0, p1, p2] = reply.probabilities!;
    res.end(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          risk: {
            type: "score",
            score: p1 + 2 * p2,
            confidence: Math.max(p0, p1, p2),
            legend: { "0": "safe", "1": "risky", "2": "dangerous" },
            probabilities: { "0": p0, "1": p1, "2": p2 },
          },
        },
        usage: { input_tokens: 300, output_tokens: 18 },
      }),
    );
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: p } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${p}/v1`,
        requests,
        replies,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

function byKeyword(state: string): JudgeReply {
  if (state.includes("ssh")) return { probabilities: [0.02, 0.18, 0.8] };
  if (state.includes("rm ")) return { probabilities: [0.1, 0.7, 0.2] };
  return { probabilities: [0.95, 0.04, 0.01] };
}
