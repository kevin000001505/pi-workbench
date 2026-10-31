# pi workbench

A self-hosted web UI for the [pi coding agent](https://github.com/earendil-works/pi). Run agents on your server, watch them work live, and answer them when they need a permission or a decision. You can create repos and open PRs from the browser, and every repo gets [Matt Pocock's skills](https://github.com/mattpocock/skills) set up.

```
 browser ──WebSocket/REST──▶ workbench server (Node) ──stdin/stdout JSONL──▶ pi --mode rpc   (one per session)
                              │  sqlite: repos, sessions, encrypted secrets       │  worktree: /data/worktrees/<id>
                              │  GitHub REST (PAT)                                 │  skills: mattpocock (pinned) + repo's own
                              └─ git clone/worktree/push                          └─ extension: approval gate + ask_user
                                                                                      │
                                                         OpenAI-compatible endpoint ◀─┘  (llama-swap → Qwen3.8-27B-radiance)
```

## What you get

- **Plan, then build, as the default.** A new session runs a pipeline (see [The pipeline](#the-pipeline)): `grill-with-docs` → `to-spec` → `to-tickets` → test-first build of each ticket → one code review. Pick **Direct** on the New session form to skip it for small fixes.
- **Live sessions.** Every session streams text, thinking, and tool calls as they happen. Sessions keep running when you close the tab, and several can run in parallel, each in its own git worktree and branch.
- **Permissions.** Before a risky tool call runs, the session waits for **Allow / Allow for this session / Deny**. Risky calls include `git push`, `gh`, `rm -r`, `sudo`, `curl`/`wget`, `ssh`, package installs, destructive git commands, and writes outside the worktree. You can edit the rules under Settings.
- **Decisions.** The agent has an `ask_user` tool. Its questions show up as decision cards with options, and you can always type your own answer. A waiting session never times out.
- **Waiting on you.** The sidebar lists every session that's blocked on you. The tab title shows a count, and a desktop notification fires while the tab is in the background (see [Notifications](#notifications)).
- **Skills.** Matt Pocock's engineering and productivity skills are built into the image, plus any `.agents/skills` or `.pi/skills` in the repo. Type `/` in the prompt box, or click **✦ Skills**, to pick one.
- **Setup on every repo.** A repo's first session runs `/setup-matt-pocock-skills` before your task. Its questions come to you as decision cards, it commits the result on the session branch, and then your task goes out.
- **GitHub.** **Create repo** makes a new GitHub repo and clones it. **Create PR**: the model drafts a title and body from the diff, you edit them, then the server pushes the branch and opens the PR. After that, the session header shows the PR's state and CI.
- **Solve issues.** The **Issues** page lists the open issues of a tracked repo — search by keyword, filter by label — and opens any issue with its discussion (the body and comments, rendered as markdown). **Start session** opens the New session form pre-filled with the issue's title and body; one session solves one issue, its PR body carries a `Closes #n` line, and merging the PR closes the issue.
- **Secrets.** Environment variables for sessions, global or per repo. They are encrypted at rest (AES-256-GCM) and write-only from the browser.
- **SSH keys.** Paste a machine's private key on the SSH page. It is stored encrypted like any other secret (never shown again) and materialized in the agent's home as `~/.ssh/<name>` — a 0600 file in a 0700 directory — so the agent can `ssh` to your machines.
- **Model settings.** Base URL, model ID (listed from the endpoint's `/v1/models`), context window, and output limit. The default is `Qwen3.8-27B-radiance` with 256K (262144) tokens. **Test** makes the same chat call a session makes and reports the URL, status, and likely cause when it fails (wrong service, missing `/v1`, unknown model, missing key, unreachable host).

## The pipeline

New sessions follow the flow these skills are designed for: align on requirements, write a spec, split it into tickets, then build each ticket test-first.

| Phase | What runs | Ends when |
|---|---|---|
| Setup | `/setup-matt-pocock-skills`, only on a repo that hasn't run it | its files are committed |
| Grill | `/skill:grill-with-docs` on your idea. It questions you (database choice, edge cases, terms) and writes the glossary and ADRs as it goes | you confirm a shared understanding; the agent commits the docs and calls `save_grill_summary` |
| Spec | `/skill:to-spec` in the same conversation: turns what you agreed into a spec | you approve its test seams; it publishes the spec and calls `save_spec` |
| Tickets | `/skill:to-tickets` on the spec | you approve the breakdown; it publishes the tickets and calls `record_tickets` |
| Implement | one fresh run per ticket with `/skill:tdd`, in dependency order | the agent commits and calls `finish_ticket`; the next ticket starts |
| Review | one fresh `/skill:code-review` run over the whole branch, fixing what it finds | the agent commits the fixes and calls `finish_review` |
| Done | messages become plain follow-ups on the same branch | you press **Create PR** |

- **The workbench plays `/implement-spec`'s orchestrator.** pi has no subagents, so the workbench runs `implement-spec`'s plan itself: a fresh context per ticket (its "implementer subagent"), all on the session's single branch, then one `code-review` over the whole branch. Tickets run one at a time, since one GPU serves the model.
- **Each ticket starts with context pointers:** its ticket, the spec (inline, or a pointer if it's very long), and a note from each finished ticket. The spec, tickets, and notes are kept in SQLite.
- **Every conversation stays readable** (the plan, each ticket, the review) from the run tabs above the transcript.
- **The pipeline stops and notifies you** when a ticket reports itself blocked, a run stops without finishing, or you stop it. **Retry** reruns that ticket (or the review) from scratch. **Mark done & continue** moves on. A reply in the chat continues the same run.
- **When the review is done,** the session tells you, and **Create PR** drafts a PR whose body lists the tickets. GitHub issues become `Closes #n`.
- **New feature, new session.** One session holds one feature. Pick **Direct** on the New session form to skip the pipeline for small fixes.

Matt Pocock's skills hand off to each other by "calling the Skill tool": `grill-with-docs` calls `grilling` and `domain-modeling`, and `implement` calls `tdd` and `code-review`. The workbench extension adds a `Skill` tool to pi so these hand-offs work.

## Deploy

```bash
git clone https://github.com/kevin000001505/pi-workbench.git && cd pi-workbench
cp .env.example .env
```

```bash
sed -i "s|^WORKBENCH_MASTER_KEY=.*|WORKBENCH_MASTER_KEY=$(openssl rand -base64 32)|" .env
```

Edit `.env`, setting `BIND_ADDR` to your VM's IP and `PORT` if needed. Then:

```bash
docker compose up -d --build
```

Open `http://<BIND_ADDR>:<PORT>` and do these three things once:

1. **Secrets → GITHUB_TOKEN**: add a fine-grained PAT. It needs *Contents* and *Pull requests* read/write and *Issues* read on the repos you use. Add *Administration* write if you want **Create repo** to work.
2. **Settings → Model**: check the base URL. **Test** lists the model IDs the endpoint serves.
3. **Repositories**: add an existing repo or create one. Then start a **New session**.

### Reaching the model

llm-model-manager publishes llama-swap on the host's port 8080. The default base URL is `http://host.docker.internal:8080/v1`, which works with no extra setup.

To go over Docker's network instead, join llm-model-manager's network and use `http://llama-swap:8080/v1`:

```bash
docker compose -f docker-compose.yml -f docker-compose.llama-net.yml up -d --build
```

`LLM_*` variables in `.env` only seed the first boot. After that, the Settings page is the source of truth, stored in the data volume.

## Security model

There is **no login**. Whoever can reach the port can run shell commands in the container with your GitHub token.

- **Publish the port on a trusted address only**, via `BIND_ADDR`: a LAN or Tailscale IP, or `127.0.0.1` plus an SSH tunnel or an authenticating reverse proxy.
- **Other sites in your browser can't drive it.** Write requests must be JSON, a present `Origin` must match `Host`, and only IP or `localhost` Hosts, plus the names in `ALLOWED_HOSTS`, are accepted. Together these block cross-site requests and DNS rebinding.
- **Secrets are encrypted at rest** with a key derived from `WORKBENCH_MASTER_KEY`. They are never returned by the API, and they are injected only into pi processes as environment variables. The master key itself is removed from the agent's environment. **The agent can read the variables it is given**: that's how it uses them. Give it scoped, short-lived tokens.
- **The agent runs as the unprivileged `node` user** inside the container, not on your host. The container doesn't mount the Docker socket.
- **Lost master key:** the saved secrets can't be decrypted. Set a new key and re-enter them.

## Notifications

Browsers only allow desktop notifications on secure origins: HTTPS or `localhost`. Plain `http://<VM-IP>:8787` gets badges and the tab-title count, but no pop-ups. To get pop-ups, use one of these:

- `tailscale serve --bg 8787`, then open the `https://<machine>.<tailnet>.ts.net` URL and add that name to `ALLOWED_HOSTS`.
- A reverse proxy with TLS, such as Caddy.
- An SSH tunnel to `localhost`: `ssh -L 8787:127.0.0.1:8787 vm`.

Then enable notifications under **Settings → Notifications**.

## How it works

| Piece | Where |
|---|---|
| One `pi --mode rpc` process per session, JSONL over stdio, resumed by session ID from `/data/pi-sessions` | `server/src/rpc.ts`, `server/src/sessions.ts` |
| Rebuilding the streamed conversation, shared by the server snapshot and the browser | `shared/transcript.ts` |
| Approval gate, `ask_user`, `Skill`, and the pipeline tools (`save_grill_summary`, `save_spec`, `record_tickets`, `finish_ticket`, `finish_review`) | `pi-extension/workbench.ts` |
| Pipeline phases, prompts, ticket order | `server/src/pipeline.ts`, `server/src/sessions.ts` |
| pi config (`models.json`, `settings.json`, rules) generated from the db | `server/src/settings.ts` |
| Clones, worktrees, setup detection (`docs/agents/issue-tracker.md`) | `server/src/repos.ts` |
| PR drafting and opening | `server/src/prs.ts`, `server/src/github.ts` |
| Encrypted secrets | `server/src/secrets.ts` |

**Pause** ends a session's pi process but keeps the conversation. Sending a message, or **Resume**, starts pi again with the same session ID. A container restart stops all sessions the same way: a turn that was mid-run is cut off, and the conversation is kept.

**Archive** deletes the session's worktree. Pushed branches and PRs stay on GitHub.

### Why the pi coding agent and not `pi-durable`

`@earendil-works/pi-durable` is an experimental library: no coding tools, no skills, no approval flow, and an API that changes without notice. The pi coding agent's RPC mode already has all three.

Orchestration and memory live in the workbench's own SQLite: phases, the spec, tickets, blocking edges, and notes. pi's session files keep each conversation, so a stopped run resumes where it left off.

## Development

Requires Node ≥ 22.19 and the `pi` CLI (`npm i -g @earendil-works/pi-coding-agent@1.4.0`).

```bash
cd server && npm install && cd ../web && npm install && cd ..
```

Run these in separate terminals. The first is a scripted model:

```bash
MOCK_PORT=18080 node server/test/mock-llm.ts
```

```bash
WORKBENCH_MASTER_KEY=dev-master-key-123456 LLM_BASE_URL=http://127.0.0.1:18080/v1 node server/src/main.ts
```

```bash
cd web && npm run dev
```

The last command serves the UI with hot reload and proxies `/api` and `/ws` to `:8787`.

Tests: unit, GitHub flow against a mock GitHub, and end-to-end with a real `pi` process against the mock model.

```bash
cd server && npm test
```

```bash
cd web && npm run build
```

`npm run build` typechecks and builds the UI.
