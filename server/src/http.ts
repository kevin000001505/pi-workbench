import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
};
type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Tiny method + path router; `:name` segments become params. Handlers return JSON-able values. */
export class Router {
  private routes: { method: string; re: RegExp; keys: string[]; handler: Handler }[] = [];

  on(method: string, pattern: string, handler: Handler) {
    const keys: string[] = [];
    const re = new RegExp(
      `^${pattern.replace(/\//g, "\\/").replace(/:(\w+)(\*)?/g, (_, k, star) => {
        keys.push(k);
        return star ? "(.+)" : "([^/]+)";
      })}$`,
    );
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  match(method: string, pathname: string) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return undefined;
  }
}

export async function readJson(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value ?? null);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

/**
 * The UI has no login (it is network-gated), so guard against the two ways another site in the
 * user's browser could still reach it:
 * - DNS rebinding: only accept Host headers that are IP literals, localhost or ALLOWED_HOSTS.
 * - Cross-site requests: a present Origin must match Host, and writes must be JSON (forces a CORS
 *   preflight, which this server never approves).
 */
export function checkRequestOrigin(req: IncomingMessage, allowedHosts: string[], requireJson: boolean): string | null {
  const host = (req.headers.host ?? "").toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  const okHost = net.isIP(hostname) !== 0 || hostname === "localhost" || allowedHosts.includes(hostname);
  if (!okHost) return `Host ${hostname} is not allowed; add it to ALLOWED_HOSTS`;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== host) return "Cross-origin request refused";
    } catch {
      return "Bad Origin header";
    }
  }
  if (requireJson && !(req.headers["content-type"] ?? "").includes("application/json")) {
    return "Write requests must be application/json";
  }
  return null;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/** Serve the built SPA; unknown paths fall back to index.html. */
export function serveStatic(webDir: string, pathname: string, res: ServerResponse) {
  let file = path.join(webDir, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(webDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(webDir, "index.html");
  }
  if (!fs.existsSync(file)) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Web UI not built. Run `npm run build` in web/.");
    return;
  }
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  fs.createReadStream(file).pipe(res);
}
