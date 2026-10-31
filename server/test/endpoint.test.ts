/** Settings → Test probe and model-error explanations (issue #1). */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { excerpt, explainFailure, explainModelError, looksLikeHtml } from "../../shared/endpoint.ts";
import { listModelsAt, probeEndpoint } from "../src/llm.ts";
import { startMockLlm } from "./mock-llm.ts";

// The page a user's endpoint returned for POST /v1/chat/completions.
const REDIRECT_404 = `<html> <head> <script type="text/javascript"> <!-- location.href = location.protocol + '//' + location.hostname + (location.port ? ':' + location.port : '') + '' ; //--> </script> </head> <body><br/></body> </html>`;

let mock: Awaited<ReturnType<typeof startMockLlm>>;
let html: http.Server;
let htmlUrl: string;

before(async () => {
  mock = await startMockLlm();
  // Lists models fine, but answers chat with the redirect page, like the failing setup.
  html = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "Qwen3.8-27B-radiance" }] }));
    } else {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(REDIRECT_404);
    }
  });
  await new Promise<void>((r) => html.listen(0, "127.0.0.1", r));
  htmlUrl = `http://127.0.0.1:${(html.address() as AddressInfo).port}/v1`;
});
after(async () => {
  await mock.close();
  await new Promise((r) => html.close(r));
});

const settings = (baseUrl: string, modelId = "Qwen3.8-27B-radiance") => ({
  baseUrl,
  modelId,
  contextWindow: 262144,
  maxTokens: 32768,
  reasoning: false,
  thinkingFormat: "",
});

test("probe passes against a working endpoint", async () => {
  const r = await probeEndpoint(settings(mock.url));
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.map((c) => [c.name, c.ok, c.status]), [["Models", true, 200], ["Chat", true, 200]]);
  assert.ok(r.models.includes("Qwen3.8-27B-radiance"));
});

test("probe names the failing chat URL when it returns a web page", async () => {
  const r = await probeEndpoint(settings(htmlUrl));
  assert.equal(r.ok, false);
  const [models, chat] = r.checks;
  assert.equal(models.ok, true);
  assert.equal(chat.ok, false);
  assert.equal(chat.status, 404);
  assert.equal(chat.url, `${htmlUrl}/chat/completions`);
  assert.match(chat.hint!, /returned a web page \(HTTP 404\), not a model API reply/);
  assert.match(chat.hint!, /chat\/completions/);
  assert.equal(chat.excerpt, "HTML page: [script that redirects the browser to the site's root page]");
});

test("probe explains an unreachable endpoint and an unknown model", async () => {
  const down = await probeEndpoint(settings("http://127.0.0.1:9/v1"));
  assert.equal(down.ok, false);
  assert.match(down.checks[0].hint!, /Nothing answered at 127\.0\.0\.1:9/);

  const wrong = await probeEndpoint(settings(htmlUrl, "Qwen-typo"));
  assert.match(wrong.checks[1].hint!, /doesn't serve "Qwen-typo".*Qwen3\.8-27B-radiance/);
});

test("model errors with a web page body get an explanation", () => {
  const msg = `404 ${REDIRECT_404}`;
  assert.equal(looksLikeHtml(msg), true);
  assert.match(explainModelError(msg)!, /^The model endpoint returned a web page \(HTTP 404\)/);
  assert.equal(explainModelError("429 rate limited"), null);
  assert.equal(explainModelError(undefined), null);
});

test("explainFailure covers auth, server errors, DNS and timeouts", () => {
  const url = "http://llama-swap:8080/v1/chat/completions";
  assert.match(explainFailure({ url, status: 401, body: "{}" }), /LLM_API_KEY/);
  assert.match(explainFailure({ url, status: 502, body: "bad gateway" }), /HTTP 502.*logs/);
  assert.match(explainFailure({ url, status: 404, body: '{"error":"no route"}' }), /ends in \/v1/);
  assert.match(explainFailure({ url, error: "TypeError fetch failed ENOTFOUND" }), /doesn't resolve.*host\.docker\.internal/);
  assert.match(explainFailure({ url, error: "TimeoutError The operation was aborted due to timeout" }), /still be loading/);
  assert.equal(excerpt("a".repeat(300)).length, 201);
});

test("the model list sends the LLM key only to the saved base URL's origin", async () => {
  // Two endpoints that record the Authorization header they get: the saved one and another host.
  const seen: Record<string, (string | undefined)[]> = { saved: [], other: [] };
  const listen = async (name: string) => {
    const s = http.createServer((req, res) => {
      seen[name].push(req.headers.authorization);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: `${name}-model` }] }));
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1` };
  };
  const saved = await listen("saved");
  const other = await listen("other");
  try {
    const m = settings(saved.url);
    assert.deepEqual(await listModelsAt(m, undefined, "sk-secret"), ["saved-model"]);
    assert.deepEqual(await listModelsAt(m, `${saved.url}/`, "sk-secret"), ["saved-model"]);
    assert.deepEqual(await listModelsAt(m, other.url, "sk-secret"), ["other-model"]);
    assert.deepEqual(seen, { saved: ["Bearer sk-secret", "Bearer sk-secret"], other: [undefined] });
  } finally {
    await new Promise((r) => saved.s.close(r));
    await new Promise((r) => other.s.close(r));
  }
});
