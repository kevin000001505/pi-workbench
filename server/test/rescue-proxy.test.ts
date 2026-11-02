/**
 * The rescue proxy (ADR 0003): a second HTTP listener, bound to 127.0.0.1 only on an ephemeral
 * port, that lets a rescue or retro run call the Reviewer's model. A request is accepted only
 * with a live per-run token; the proxy removes the token, adds the Reviewer key in the
 * provider's header, refuses a target URL whose origin differs from the key's saved origin,
 * and streams the response back. It logs neither the key nor the token.
 */
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { startRescueProxy, type RescueProxy } from "../src/rescue-proxy.ts";

const KEY = "sk-test-reviewer-key-123456";
const logs: string[] = [];
const proxy: RescueProxy = await startRescueProxy((text) => logs.push(text));

/** A scripted model endpoint: records what it receives and writes its answer chunk by chunk. */
function startTarget() {
  const requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  let chunks: string[] = ["one"];
  let status = 200;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} });
    res.writeHead(status, { "Content-Type": "application/json" });
    for (const chunk of chunks) res.write(chunk);
    res.end();
  });
  return {
    server,
    requests,
    url: "",
    setChunks: (c: string[]) => { chunks = c; },
    setStatus: (s: number) => { status = s; },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const target = startTarget();
await new Promise<void>((resolve) =>
  target.server.listen(0, "127.0.0.1", () => {
    target.url = `http://127.0.0.1:${(target.server.address() as AddressInfo).port}`;
    resolve();
  }),
);
after(async () => {
  await target.close();
  await proxy.close();
});

/** A request to the proxy, the way pi sends it: the token in the provider's header. */
const callProxy = async (token: string | undefined, mode: "xapi" | "bearer" = "xapi", headers: Record<string, string> = {}) => {
  const h = { "Content-Type": "application/json", ...headers };
  if (mode === "xapi" && token) h["x-api-key"] = token;
  if (mode === "bearer" && token) h.authorization = `Bearer ${token}`;
  return fetch(`${proxy.url}/v1/chat/completions`, { method: "POST", headers: h, body: JSON.stringify({ model: "m", messages: [] }) });
};

test("the proxy binds to 127.0.0.1 on an ephemeral port, and does not answer on a non-loopback address", async () => {
  assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(proxy.port > 0);
  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i?.family === "IPv4" && !i.internal);
  assert.ok(external, "this machine has a non-loopback IPv4 to test against");
  let refused = false;
  try {
    await fetch(`http://${external.address}:${proxy.port}/`, { signal: AbortSignal.timeout(3000) });
  } catch (err) {
    refused = true;
  }
  assert.ok(refused, `the proxy answered on ${external.address}:${proxy.port}`);
});

test("a request with a live token reaches the target with the Reviewer key in the provider's header, and streams back", async () => {
  target.setChunks(["alpha", "beta"]);
  // OpenAI: the key goes Authorization Bearer, like the Reviewer's openai calls.
  proxy.configure({ baseUrl: target.url, provider: "openai", key: KEY, keyOrigin: new URL(target.url).origin });
  const token = proxy.mint("run-a");
  const res = await callProxy(token, "bearer");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "alphabeta", "the chunks arrive in order");
  const seen = target.requests.at(-1)!;
  assert.equal(seen.headers.authorization, `Bearer ${KEY}`);
  assert.equal(seen.headers["x-api-key"], undefined, "the token is removed, not forwarded");
  assert.equal(seen.url, "/v1/chat/completions");
  assert.deepEqual(seen.body.model, "m");

  // Anthropic: the key goes x-api-key, and the rest of the headers pass through.
  target.setChunks(["gamma"]);
  proxy.configure({ baseUrl: target.url, provider: "anthropic", key: KEY, keyOrigin: new URL(target.url).origin });
  const res2 = await callProxy(proxy.mint("run-b"), "xapi", { "anthropic-version": "2023-06-01" });
  assert.equal(res2.status, 200);
  assert.equal(await res2.text(), "gamma");
  const seen2 = target.requests.at(-1)!;
  assert.equal(seen2.headers["x-api-key"], KEY);
  assert.equal(seen2.headers.authorization, undefined);
  assert.equal(seen2.headers["anthropic-version"], "2023-06-01");
});

test("a request with no token, or with a revoked (old run) token, is refused", async () => {
  proxy.configure({ baseUrl: target.url, provider: "openai", key: KEY, keyOrigin: new URL(target.url).origin });
  assert.equal((await callProxy(undefined)).status, 401);
  assert.equal((await callProxy("not-a-live-token")).status, 401);
  const token = proxy.mint("run-c");
  assert.equal((await callProxy(token)).status, 200);
  proxy.revoke("run-c");
  assert.equal((await callProxy(token)).status, 401);
  // Minting for the same run again supersedes the old token.
  const old = proxy.mint("run-d");
  const fresh = proxy.mint("run-d");
  assert.notEqual(old, fresh);
  assert.equal((await callProxy(old)).status, 401);
  assert.equal((await callProxy(fresh)).status, 200);
});

test("a key saved for an origin refuses a request whose target URL origin differs", async () => {
  proxy.configure({ baseUrl: target.url, provider: "openai", key: KEY, keyOrigin: "http://other.example" });
  const before = target.requests.length;
  assert.equal((await callProxy(proxy.mint("run-e"))).status, 403);
  assert.equal(target.requests.length, before, "nothing reached the target");
  // The same key without a saved origin is unbound and goes to the configured URL (the Reviewer-off binding).
  proxy.configure({ baseUrl: target.url, provider: "openai", key: KEY });
  assert.equal((await callProxy(proxy.mint("run-f"))).status, 200);
});

test("a request with a live token but no Reviewer key configured is refused", async () => {
  proxy.configure({ baseUrl: target.url, provider: "openai" });
  assert.equal((await callProxy(proxy.mint("run-g"))).status, 503);
});

test("the proxy logs neither the key nor the token", async () => {
  proxy.configure({ baseUrl: target.url, provider: "openai", key: KEY, keyOrigin: new URL(target.url).origin });
  const token = proxy.mint("run-h");
  logs.length = 0;
  await callProxy(token); // success
  await callProxy(undefined); // refused: no token
  proxy.configure({ baseUrl: target.url, provider: "openai", key: KEY, keyOrigin: "http://other.example" });
  await callProxy(token); // refused: origin mismatch
  proxy.configure({ baseUrl: "http://127.0.0.1:1", provider: "openai", key: KEY }); // unreachable target
  assert.equal((await callProxy(token)).status, 502);
  const text = logs.join("\n");
  assert.ok(!text.includes(KEY), `the key appeared in the log: ${text}`);
  assert.ok(!text.includes(token), `the token appeared in the log: ${text}`);
});
