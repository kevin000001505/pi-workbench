import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import type { GitEnv } from "./git.ts";
import { GitHub, GitHubError } from "./github.ts";
import { autoApproveKeys, autoApproveView, configureAutoApprove, getAutoApproveSettings, listModelsFor, saveAutoApproveKey, testJudge } from "./autoapprove.ts";
import { checkRequestOrigin, type Ctx, HttpError, readJson, Router, sendJson, serveStatic } from "./http.ts";
import { listModels, probeEndpoint } from "./llm.ts";
import { draftPr, openPr, changes } from "./prs.ts";
import { addRepo, assertRepoName, clonePath, getRepo, listRepos, repoNeedsSetup, requireTrackedRepo } from "./repos.ts";
import { assertUserScope, GLOBAL_SCOPE, SecretStore, userSecrets } from "./secrets.ts";
import { SessionManager } from "./sessions.ts";
import { applySsh, saveSshHosts, sshView, testSshHost } from "./ssh.ts";
import {
  getApprovalSettings,
  getModelSettings,
  LLM_KEY_ENV,
  saveApprovalSettings,
  saveModelSettings,
  writePiConfig,
} from "./settings.ts";
import { listSkills } from "./skills.ts";

const db = openDb(config.dbFile);
const secrets = new SecretStore(db, config.masterKey);
for (const dir of [config.reposDir, config.worktreesDir, config.piSessionsDir]) fs.mkdirSync(dir, { recursive: true });
writePiConfig(db);
// Fresh ssh keys and host config before the first session and after every key/host change (ADR 0001).
applySsh(db, secrets, config.agentHome, config.piAgentDir);

const allowedHosts = (process.env.ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const token = () => secrets.get(GLOBAL_SCOPE, "GITHUB_TOKEN");
const github = () => new GitHub(token());

/** Commit identity from the PAT's GitHub user, cached per token. */
let identity: { key: string; env: GitEnv } | undefined;
async function gitEnv(): Promise<GitEnv> {
  const t = token();
  const env: GitEnv = t ? { GITHUB_TOKEN: t, GH_TOKEN: t } : {};
  const key = t ? crypto.createHash("sha256").update(t).digest("hex") : "";
  if (identity?.key !== key) {
    let name = "pi-workbench";
    let email = "pi-workbench@localhost";
    if (t) {
      try {
        const u = await github().user();
        name = u.name || u.login;
        email = `${u.id}+${u.login}@users.noreply.github.com`;
      } catch {}
    }
    identity = { key, env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } };
  }
  return { ...identity.env, ...env };
}

const sessions = new SessionManager(db, secrets, gitEnv, () => applySsh(db, secrets, config.agentHome, config.piAgentDir));

const llmKey = () => secrets.get(GLOBAL_SCOPE, LLM_KEY_ENV);

async function repoView(r: ReturnType<typeof listRepos>[number]) {
  return {
    id: r.id,
    owner: r.owner,
    name: r.name,
    defaultBranch: r.default_branch,
    private: !!r.private,
    needsSetup: fs.existsSync(clonePath(r)) ? await repoNeedsSetup(r) : true,
  };
}

const router = new Router()
  .on("GET", "/api/health", () => ({ ok: true }))

  // --- repos & GitHub ---------------------------------------------------------------------
  .on("GET", "/api/repos", async () => Promise.all(listRepos(db).map(repoView)))
  .on("GET", "/api/github/user", async () => {
    if (!token()) return null;
    const u = await github().user();
    return { login: u.login, name: u.name };
  })
  .on("GET", "/api/github/repos", async () =>
    (await github().listRepos()).map((r) => ({
      id: r.full_name,
      owner: r.owner.login,
      name: r.name,
      private: r.private,
      defaultBranch: r.default_branch,
      description: r.description,
      pushedAt: r.pushed_at,
    })),
  )
  .on("GET", "/api/github/issues", async ({ query }) => {
    const repo = requireTrackedRepo(db, query.get("repo") ?? "");
    return github().listIssues(repo.owner, repo.name, {
      label: query.get("label") ?? undefined,
      q: query.get("q") ?? undefined,
    });
  })
  .on("GET", "/api/github/issues/:owner/:name/:number", async ({ params }) => {
    const repo = requireTrackedRepo(db, `${params.owner}/${params.name}`);
    const number = Number(params.number);
    const [issue, comments] = await Promise.all([
      github().getIssue(repo.owner, repo.name, number),
      github().listIssueComments(repo.owner, repo.name, number),
    ]);
    return { ...issue, comments };
  })
  .on("POST", "/api/repos", async ({ body }) => {
    const [owner, name] = String(body.id ?? "").split("/");
    assertRepoName(owner ?? "", name ?? "");
    const gh = await github().getRepo(owner, name);
    return repoView(await addRepo(db, { owner, name, defaultBranch: gh.default_branch, private: gh.private }, await gitEnv()));
  })
  .on("POST", "/api/repos/create", async ({ body }) => {
    const name = String(body.name ?? "").trim();
    assertRepoName("x", name);
    const gh = await github().createRepo({
      name,
      description: body.description ? String(body.description) : undefined,
      private: body.private !== false,
      org: body.org ? String(body.org) : undefined,
    });
    return repoView(
      await addRepo(db, { owner: gh.owner.login, name: gh.name, defaultBranch: gh.default_branch, private: gh.private }, await gitEnv()),
    );
  })
  .on("DELETE", "/api/repos/:owner/:name", async ({ params }) => {
    const id = `${params.owner}/${params.name}`;
    const repo = getRepo(db, id);
    if (!repo) throw new HttpError(404, "Unknown repo");
    if (sessions.list().some((s) => s.repoId === id)) throw new HttpError(409, "Archive this repo's sessions first");
    db.prepare("DELETE FROM repos WHERE id = ?").run(id);
    fs.rmSync(clonePath(repo), { recursive: true, force: true });
    return { ok: true };
  })

  // --- sessions -----------------------------------------------------------------------------
  .on("GET", "/api/sessions", () => sessions.list())
  .on("POST", "/api/sessions", async ({ body }) =>
    sessions.create({
      repoId: String(body.repoId ?? ""),
      title: String(body.title ?? ""),
      baseBranch: body.baseBranch ? String(body.baseBranch) : undefined,
      prompt: String(body.prompt ?? ""),
      mode: body.mode === "direct" ? "direct" : "pipeline",
      issueRef: body.issueRef ? String(body.issueRef) : undefined,
    }),
  )
  .on("GET", "/api/sessions/:id", ({ params }) => sessions.snapshot(params.id))
  .on("PATCH", "/api/sessions/:id", ({ params, body }) => {
    if (typeof body.title === "string") sessions.rename(params.id, body.title);
    return sessions.summary(params.id);
  })
  .on("DELETE", "/api/sessions/:id", async ({ params }) => {
    await sessions.archive(params.id);
    return { ok: true };
  })
  .on("POST", "/api/sessions/:id/prompt", async ({ params, body }) => {
    const message = String(body.message ?? "");
    if (!message.trim()) throw new HttpError(400, "Message is empty");
    return sessions.send(params.id, message, body.mode === "followUp" ? "followUp" : "steer");
  })
  .on("POST", "/api/sessions/:id/respond", ({ params, body }) => {
    sessions.respond(params.id, String(body.requestId), {
      value: body.value === undefined ? undefined : String(body.value),
      confirmed: body.confirmed,
      cancelled: body.cancelled,
    });
    return { ok: true };
  })
  .on("POST", "/api/sessions/:id/start", async ({ params }) => {
    await sessions.start(params.id);
    return sessions.summary(params.id);
  })
  .on("POST", "/api/sessions/:id/abort", async ({ params }) => {
    await sessions.abort(params.id);
    return { ok: true };
  })
  .on("POST", "/api/sessions/:id/stop", async ({ params }) => {
    await sessions.stop(params.id);
    return { ok: true };
  })
  .on("POST", "/api/sessions/:id/held", async ({ params, body }) => {
    await sessions.releaseHeld(params.id, body.action === "discard");
    return { ok: true };
  })
  .on("POST", "/api/sessions/:id/pipeline", async ({ params, body }) => {
    if (!["retry", "skip", "stop"].includes(body.action)) throw new HttpError(400, "action must be retry, skip or stop");
    await sessions.pipelineAction(params.id, body.action);
    return sessions.summary(params.id);
  })
  .on("GET", "/api/sessions/:id/runs/:runId", ({ params }) => sessions.runTranscript(params.id, params.runId))
  .on("GET", "/api/sessions/:id/changes", async ({ params }) => {
    const { row } = sessions.repoOf(params.id);
    return changes(row, await gitEnv());
  })
  .on("POST", "/api/sessions/:id/pr/draft", async ({ params }) => {
    const { row } = sessions.repoOf(params.id);
    return draftPr(row, await gitEnv(), getModelSettings(db), llmKey(), sessions.tickets(params.id));
  })
  .on("POST", "/api/sessions/:id/pr", async ({ params, body }) => {
    const { row, repo } = sessions.repoOf(params.id);
    const pr = await openPr(row, repo, github(), await gitEnv(), {
      title: String(body.title ?? ""),
      body: String(body.body ?? ""),
      commitMessage: body.commitMessage ? String(body.commitMessage) : undefined,
      draft: !!body.draft,
    });
    sessions.setPr(params.id, pr.number, pr.html_url);
    return { number: pr.number, url: pr.html_url };
  })
  .on("GET", "/api/sessions/:id/pr", async ({ params }) => {
    const { row, repo } = sessions.repoOf(params.id);
    if (!row.pr_number) return null;
    return github().pullStatus(repo.owner, repo.name, row.pr_number);
  })
  .on("GET", "/api/skills", ({ query }) => {
    const id = query.get("sessionId");
    const cwd = id ? sessions.repoOf(id).row.worktree : undefined;
    return listSkills(config.skillsDir, cwd).map(({ path: _p, ...s }) => s);
  })

  // --- settings & secrets ---------------------------------------------------------------
  .on("GET", "/api/settings", () => ({ model: getModelSettings(db), approval: getApprovalSettings(db), autoApprove: autoApproveView(db, secrets) }))
  .on("PUT", "/api/settings/auto-approve", async ({ body }) => {
    await configureAutoApprove(db, secrets, body);
    return autoApproveView(db, secrets);
  })
  .on("PUT", "/api/settings/auto-approve/keys", ({ body }) => {
    saveAutoApproveKey(secrets, body);
    return autoApproveView(db, secrets);
  })
  // The judge URL's model list, which also tells the protocol. A POST, so it passes the write-route
  // checks: it calls out to a URL the request names (the token goes only to its own origin).
  .on("POST", "/api/settings/auto-approve/models", ({ body }) => listModelsFor(db, secrets, body.baseUrl))
  .on("POST", "/api/settings/auto-approve/test", () => testJudge(getAutoApproveSettings(db), autoApproveKeys(secrets)))
  .on("PUT", "/api/settings/model", ({ body }) => {
    const model = saveModelSettings(db, body);
    writePiConfig(db);
    return model;
  })
  .on("PUT", "/api/settings/approval", ({ body }) => {
    const approval = saveApprovalSettings(db, body);
    writePiConfig(db);
    return approval;
  })
  .on("GET", "/api/models", async ({ query }) => {
    const m = getModelSettings(db);
    const baseUrl = query.get("baseUrl");
    return listModels(baseUrl ? { ...m, baseUrl } : m, llmKey());
  })
  .on("POST", "/api/models/test", async ({ body }) => {
    const m = getModelSettings(db);
    return probeEndpoint(
      { ...m, baseUrl: typeof body.baseUrl === "string" && body.baseUrl ? body.baseUrl : m.baseUrl, modelId: typeof body.modelId === "string" && body.modelId ? body.modelId : m.modelId },
      llmKey(),
    );
  })
  .on("GET", "/api/ssh", () => sshView(db, secrets))
  // Reserved scopes (the auto-approve keys) have their own routes; the Secrets page never sees them.
  .on("GET", "/api/secrets", () => userSecrets(secrets))
  .on("PUT", "/api/secrets", ({ body }) => {
    const scope = String(body.scope ?? GLOBAL_SCOPE);
    assertUserScope(scope, (s) => !!getRepo(db, s));
    if (typeof body.value !== "string" || body.value === "") throw new HttpError(400, "Value is empty");
    secrets.set(scope, String(body.name ?? ""), body.value);
    if (body.name === "GITHUB_TOKEN") identity = undefined;
    if (scope === GLOBAL_SCOPE) applySsh(db, secrets, config.agentHome, config.piAgentDir);
    return { ok: true };
  })
  .on("DELETE", "/api/secrets/:scope*", ({ params }) => {
    // scope may itself contain a slash (owner/name), so the name is the last segment.
    const parts = params.scope.split("/");
    const name = parts.pop()!;
    // Any listed scope may be cleaned up (even a removed repo's), but never a reserved one.
    assertUserScope(parts.join("/"), () => true);
    secrets.delete(parts.join("/"), name);
    if (parts.join("/") === GLOBAL_SCOPE) applySsh(db, secrets, config.agentHome, config.piAgentDir);
    return { ok: true };
  })
  .on("PUT", "/api/ssh/hosts", ({ body }) => {
    const hosts = saveSshHosts(db, body?.hosts);
    applySsh(db, secrets, config.agentHome, config.piAgentDir);
    return { hosts };
  })
  .on("POST", "/api/ssh/test", ({ body }) =>
    testSshHost(db, secrets, config.agentHome, config.piAgentDir, String(body.alias ?? "")),
  );

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const isApi = url.pathname.startsWith("/api/");
  const write = req.method !== "GET" && req.method !== "HEAD";
  const refused = checkRequestOrigin(req, allowedHosts, isApi && write && req.method !== "DELETE");
  if (refused) return sendJson(res, 403, { error: refused });
  if (!isApi) return serveStatic(config.webDir, url.pathname, res);

  const route = router.match(req.method ?? "GET", url.pathname);
  if (!route) return sendJson(res, 404, { error: "Not found" });
  try {
    const ctx: Ctx = { req, res, params: route.params, query: url.searchParams, body: write ? await readJson(req) : {} };
    sendJson(res, 200, await route.handler(ctx));
  } catch (err) {
    const e = err as Error & { status?: number };
    const status = e instanceof HttpError || e instanceof GitHubError ? e.status : (e.status ?? 500);
    if (status >= 500) console.error(`${req.method} ${url.pathname}:`, e);
    sendJson(res, status, { error: e.message });
  }
});

// --- live updates -------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
const subs = new Map<WebSocket, Set<string>>();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/ws" || checkRequestOrigin(req, allowedHosts, false)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  subs.set(ws, new Set());
  ws.send(JSON.stringify({ type: "sessions", sessions: sessions.list() }));
  ws.on("message", (raw) => {
    let msg: { type?: string; sessionId?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const set = subs.get(ws);
    if (!set || !msg.sessionId) return;
    const id = msg.sessionId;
    if (msg.type === "subscribe") {
      // Snapshot and subscription happen in the same tick, so no event falls between them or is doubled.
      sessions
        .snapshot(id)
        .then((snap) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: "snapshot", sessionId: id, ...snap }));
          set.add(id);
        })
        .catch((err) => ws.send(JSON.stringify({ type: "error", sessionId: id, error: err.message })));
    }
    if (msg.type === "unsubscribe") set.delete(id);
  });
  ws.on("close", () => subs.delete(ws));
});

const broadcast = (msg: unknown, sessionId?: string) => {
  const data = JSON.stringify(msg);
  for (const [ws, set] of subs) {
    if (ws.readyState === WebSocket.OPEN && (!sessionId || set.has(sessionId))) ws.send(data);
  }
};
sessions.on("summary", (session) => broadcast({ type: "summary", session }));
sessions.on("removed", (id) => broadcast({ type: "removed", id }));
sessions.on("event", (sessionId, event) => broadcast({ type: "event", sessionId, event }, sessionId));

server.listen(config.port, config.host, () => {
  console.log(`pi-workbench listening on http://${config.host}:${config.port} (data: ${config.dataDir})`);
});

const shutdown = async () => {
  console.log("shutting down: stopping pi sessions");
  await sessions.shutdown();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
