import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/** The second provider in the generated models.json: the Reviewer model through the localhost proxy (ADR 0003). */
export const RESCUE_PROVIDER_ID = "workbench-rescue";
/** The per-run token: in the rescue/retro run's environment only, never in models.json or any other process. */
export const RESCUE_TOKEN_ENV = "RESCUE_TOKEN";

/** Whether the run id is a rescue or retro run — the only runs that go through the proxy. */
export const isRescueyRun = (runId: string) => /-(rescue|retro)-/.test(runId);

/** What the proxy forwards to: the Reviewer's URL, provider, key and the origin the key was saved for (ADR 0003). */
export type RescueTarget = {
  baseUrl: string;
  provider: "anthropic" | "openai";
  key?: string;
  keyOrigin?: string;
};

export type RescueProxy = {
  url: string;
  port: number;
  /** Mint a fresh token for a run; the run gets it in its environment only. Supersedes any earlier token for the run. */
  mint(runId: string): string;
  /** Revoke the run's token (its pi process has exited); old tokens from it are useless from then on. */
  revoke(runId: string): void;
  /** Point the proxy at new Reviewer settings (a re-saved URL, provider, key or key origin). */
  configure(target: RescueTarget): void;
  close: () => Promise<void>;
};

/**
 * The localhost-only model hop for rescue and retro runs (ADR 0003): a second HTTP listener, bound
 * to 127.0.0.1 only on an ephemeral port, separate from the UI port. The proxy accepts a request
 * only with a live per-run token. It removes the token, adds the Reviewer key in the provider's
 * header (anthropic: x-api-key; openai: Authorization Bearer), refuses a request whose target URL
 * origin does not match the key's saved origin, sends the request to the Reviewer's URL, and
 * streams the response back. It logs neither the key nor the token, and the key never enters any
 * pi process or models.json.
 */
export function startRescueProxy(log: (text: string) => void = console.error): Promise<RescueProxy> {
  const tokens = new Map<string, string>();
  let target: RescueTarget = { baseUrl: "", provider: "openai" };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const token = readToken(req);
    if (!token || ![...tokens.entries()].some(([, t]) => t === token)) return refuse(res, 401, "a live rescue token is required");
    const t = target;
    if (!t.key) return refuse(res, 503, "no Reviewer key is configured for the rescue proxy");
    if (t.keyOrigin) {
      // The key was saved for an origin; the Reviewer URL must match it, or the key would go to the wrong host.
      let targetOrigin: string | undefined;
      try {
        targetOrigin = new URL(t.baseUrl).origin;
      } catch {}
      if (!targetOrigin || targetOrigin !== t.keyOrigin) return refuse(res, 403, "the Reviewer key is saved for a different origin than the Reviewer URL");
    }
    const base = t.baseUrl.replace(/\/+$/, "");
    const incoming = new URL(req.url ?? "/", "http://localhost/");
    let fwd: Response;
    try {
      fwd = await fetch(`${base}${incoming.pathname}${incoming.search}`, {
        method: req.method ?? "POST",
        headers: forwardHeaders(req, t),
        body: raw || undefined,
      });
    } catch (err) {
      log(`rescue proxy: the Reviewer endpoint did not answer: ${(err as Error).message}`);
      return refuse(res, 502, "the Reviewer endpoint is not reachable");
    }
    const pass: Record<string, string | number> = {};
    for (const [name, value] of fwd.headers.entries()) {
      // fetch already decoded the body: content-encoding would make the client decode twice.
      if (["connection", "transfer-encoding", "content-encoding", "keep-alive", "x-accel-buffering"].includes(name)) continue;
      pass[name] = value;
    }
    res.writeHead(fwd.status, pass);
    if (!fwd.body) return res.end();
    try {
      for await (const chunk of fwd.body) res.write(chunk);
    } catch (err) {
      // The client went away (a run aborted mid-stream); the upstream fetch keeps running to the end.
      log(`rescue proxy: the client went away: ${(err as Error).message}`);
    }
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        mint: (runId) => {
          const token = crypto.randomBytes(24).toString("base64url");
          tokens.set(runId, token);
          return token;
        },
        revoke: (runId) => tokens.delete(runId),
        configure: (next) => {
          target = next;
        },
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

/** The run's token: pi sends it in the provider's header (anthropic: x-api-key; openai: Authorization Bearer). */
const readToken = (req: http.IncomingMessage): string | undefined => {
  const x = req.headers["x-api-key"];
  if (typeof x === "string" && x.trim()) return x.trim();
  const a = req.headers.authorization;
  if (typeof a === "string" && a.startsWith("Bearer ")) {
    const v = a.slice(7).trim();
    if (v) return v;
  }
  return undefined;
};

/** The request's headers, minus the token and hop-by-hop ones, plus the Reviewer key in the provider's header. */
const forwardHeaders = (req: http.IncomingMessage, t: RescueTarget): Record<string, string> => {
  const skip = new Set(["host", "connection", "content-length", "accept-encoding", "x-api-key", "authorization", "proxy-authorization", "transfer-encoding"]);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || skip.has(name.toLowerCase())) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (t.provider === "anthropic") out["x-api-key"] = t.key!;
  else out["authorization"] = `Bearer ${t.key}`;
  return out;
};

const refuse = (res: http.ServerResponse, status: number, message: string) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
};
