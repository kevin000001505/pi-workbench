# pi workbench: agent notes

Self-hosted web UI that drives the pi coding agent (`@earendil-works/pi-coding-agent`, pinned in the Dockerfile) through `pi --mode rpc`. See README.md for the architecture.

## Layout
- `server/`: Node ≥ 22.19 running TypeScript directly (type stripping, no build step). Imports must use the `.ts` extension, and only erasable syntax works (no enums, no parameter properties). Dependency: `ws`. Storage is `node:sqlite`.
- `web/`: React + Vite. It imports `../shared/` directly.
- `shared/transcript.ts`: the RPC-event → conversation reducer. **Both sides use it.** Change it in one place, never fork it.
- `shared/board.ts`: the phase → Board column map (`columnOf`) and the card shape behind `GET /api/board`. Both sides use it too. The Board's kanzo-ported CSS is `web/src/board.css` (AGPL-3.0, see LICENSE).
- `pi-extension/workbench.ts`: loaded into every pi process via the generated `settings.json`. Imports of pi packages and `typebox` resolve to pi's own copies.
- `skills/`: workbench-bundled skills (asd-ste100, and the MIT `resolving-merge-conflicts`, which the pinned mattpocock commit lacks). The Dockerfile copies them into the image skills dir next to mattpocock's skills.
- The TypeSafe skill (`typesafe-ai/skills`, pinned in the Dockerfile) goes to `OPTIONAL_SKILLS_DIR`, which pi never scans. A session created with the TypeSafe box passes it with `--skill` and `PI_WORKBENCH_EXTRA_SKILLS`.

## Pipeline
- Every pi process is spawned with `--append-system-prompt`: user-facing explanations follow the asd-ste100 skill (Simplified Technical English). See `EXPLAIN_PROMPT` in `sessions.ts`.
- Phase transitions happen in `SessionManager.afterSettled`, after a run settles, never mid-run. The extension's pipeline tools only validate and acknowledge. The server reads their arguments from `tool_execution_start` and applies them on a successful `tool_execution_end`.
- Flow: setup → grill (`grill-with-docs`) → spec (`to-spec`) → tickets (`to-tickets`) → ready (paused; the card waits in Issues for Solve all) → implement (`tdd` per ticket) → review (`code-review`) → retro (`retro`, only when a ticket had a rescue) → pr (the PR is open; the card waits in Review for Approve) → done. Prompts are in `server/src/pipeline.ts`. pi only expands `/skill:name` when an argument follows on the same line; a unit test guards this.
- An **unclaimed card** (an open issue no session's `issue_ref`/`spec_ref` names; id `issue:<number>`, from `GitHub.listBoardIssues` — one GraphQL call, capped at the 100 most recently updated open issues, with each issue's open sub-issue count and parent) sits in **Issues**, plain and spec alike, and moves through `POST /api/repos/:owner/:name/issues/:number/move`. A sub-issue never is a card; a stale move of its number is refused (409) — the ticket-seed read in `github.ts` also returns whether the issue has a parent. The move picks the start: a spec (open ticket sub-issues) to Doing is `startFrom: tickets` (Solve all: the sub-issues are recorded as tickets and the session skips setup → grill → spec → tickets, starting at `implement`, or `setup` first on an un-setup repo); to To do it is `startFrom: spec` (the grill gets `reworkPrompt(spec URL)`, so the spec and tickets are updated in place). A plain issue (no open sub-issues, not itself a sub-issue) to Doing is `startFrom: issue` (Solve: the issue becomes the card's only ticket — its title, body, number as the tracker ref; the spec is the issue body, the spec ref the issue URL; it starts at `implement`, or `setup` first); to To do it is `startFrom: split` (Split: the session sits in `tickets` with `splitPrompt(issue URL)` — `/skill:to-tickets` on the issue — and waits for the user's approval; when `record_tickets` succeeds the card goes to ready/Issues, and `releaseHeld` releases a split session (its held prompt starts with `/skill:to-tickets`) into `tickets`, not `grill`). Both set `issue_ref`, so the issue is claimed and the unclaimed card goes. A click on a plain card opens its card detail (title, body and link fetched through `GET /api/github/issues/:owner/:name/:number`), which shows the Solve and Split buttons and closes on a successful move. A new card emits `board` on SessionManager, which goes to every browser as `{type: "wb_board", repoId}`; the Board refetches on it.
- Each ticket runs under its own pi session id (`<session>-t<num>-<stamp>`), stored on the ticket row, and the review under `sessions.review_run`. A stuck ticket's rescue run (`<session>-t<num>-rescue-<stamp>`, `tickets.rescue_run_id`) and fix run (`-fix-`, `tickets.fix_run_id`) and the retro (`<session>-retro-<stamp>`, `sessions.retro_run`) get their own ids too. A conflict on Approve that `git merge origin/<base>` cannot settle gets a merge run (`<session>-merge-<stamp>`, `sessions.merge_run`) that ends with `finish_merge`; the server pushes it and the phase stays `pr`. `sessions.active_run` says which run is live. A run switch emits `wb_run`, and the browser re-subscribes to get the new snapshot. Switch runs *before* announcing a phase that implies the switch.
- The stop rule (`server/src/stop-rule.ts`) watches ticket, rescue, fix, and retro runs only. `SessionManager` aborts a run when a condition fires; `afterTicketRun` and `afterRetroRun` pick the outcome. Rescue and retro runs (ids matching `-rescue-`/`-retro-`) call the Reviewer model through the localhost proxy in `rescue-proxy.ts` (ADR 0003); the Reviewer key never enters a pi process.
- `server/test/mock-llm.ts` scripts each phase by step. Keep `test/pipeline-e2e.test.ts` passing when you change prompts, tools, or transitions.
- New columns go through `ADDED_COLUMNS` in `db.ts`, so older databases migrate on open.

## Rules
- The extension and the server share a protocol: a dialog title that is a JSON `{"wb": "permission" | "decision", ...}` envelope. Change both together, and keep `server/test/e2e.test.ts` passing.
- Never return secret values from the API, and never log them. `SecretStore.envFor` is the only decrypting path to pi. The master key must stay out of child environments: `processEnv` and `git()` strip it.
- The UI has no login. Every new write route goes through the JSON + Origin + Host check in `server/src/http.ts`. Don't add GET routes with side effects.
- Settings in the db are the source of truth. `writePiConfig` regenerates pi's agent dir from them, so don't hand-edit `/data/pi-agent`.
- Read pi's stdout with the LF splitter in `rpc.ts`, not `readline`: `readline` also splits on U+2028/2029.

## Checks
- `cd server && npm test`: unit tests, plus GitHub flow against `test/mock-github.ts`, plus e2e against a real pi process and `test/mock-llm.ts`. The e2e tests skip when `pi` isn't on PATH; set `PI_BIN` to point at one.
- `cd web && npm run build`: `tsc --noEmit` and the Vite build.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `kevin000001505/pi-workbench` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` (label strings equal the role names). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
