/**
 * The pipeline stop-rule settings over HTTP: GET /api/settings returns them, PUT
 * /api/settings/pipeline stores them, and invalid values are refused without saving.
 * Drives the real server (main.ts) on an ephemeral port.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-route-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKBENCH_MASTER_KEY = "route-master-key-0123456789";
process.env.SKILLS_DIR = path.join(tmp, "skills");
process.env.HOME = path.join(tmp, "agent-home");
process.env.PI_EXTENSION = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "pi-extension", "workbench.ts");

const freePort = await new Promise<number>((res, rej) => {
  const srv = http.createServer();
  srv.listen(0, "127.0.0.1", () => {
    const p = (srv.address() as { port: number }).port;
    srv.close(() => res(p));
  });
  srv.on("error", rej);
});
process.env.PORT = String(freePort);
const base = `http://127.0.0.1:${freePort}`;

// Import after the env is set: main.ts reads config on load and starts the server.
await import("../src/main.ts");

const api = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

/** Poll health until the server is up. */
async function waitReady(ms = 30_000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {}
    if (Date.now() - start > ms) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 50));
  }
}

// main.ts's SIGTERM handler stops the sessions and exits; the after hook runs after the
// test's TAP has been emitted, so the result is not lost.
after(() => process.kill(process.pid, "SIGTERM"));

test("pipeline stop-rule settings: defaults on read, stored on write", async () => {
  await waitReady();

  const get = await api("GET", "/api/settings");
  assert.equal(get.status, 200);
  assert.deepEqual(get.json.pipeline, { timeLimitMinutes: 30, repeatLimit: 3, toolCallLimit: 300 });

  const put = await api("PUT", "/api/settings/pipeline", { timeLimitMinutes: 45 });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json, { timeLimitMinutes: 45, repeatLimit: 3, toolCallLimit: 300 });

  const again = await api("GET", "/api/settings");
  assert.deepEqual(again.json.pipeline, { timeLimitMinutes: 45, repeatLimit: 3, toolCallLimit: 300 });

  // An invalid value is refused and changes nothing.
  const bad = await api("PUT", "/api/settings/pipeline", { repeatLimit: 0 });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /positive integer/);
  const after = await api("GET", "/api/settings");
  assert.deepEqual(after.json.pipeline, { timeLimitMinutes: 45, repeatLimit: 3, toolCallLimit: 300 });
});
