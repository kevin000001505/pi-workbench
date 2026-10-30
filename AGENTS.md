# pi workbench: agent notes

Self-hosted web UI that drives the pi coding agent (`@earendil-works/pi-coding-agent`, pinned in the Dockerfile) through `pi --mode rpc`. See README.md for the architecture.

## Layout
- `server/`: Node ≥ 22.19 running TypeScript directly (type stripping, no build step). Imports must use the `.ts` extension, and only erasable syntax works (no enums, no parameter properties). Dependency: `ws`. Storage is `node:sqlite`.
- `web/`: React + Vite. It imports `../shared/` directly.
- `shared/transcript.ts`: the RPC-event → conversation reducer. **Both sides use it.** Change it in one place, never fork it.
- `pi-extension/workbench.ts`: loaded into every pi process via the generated `settings.json`. Imports of pi packages and `typebox` resolve to pi's own copies.

## Pipeline
- Phase transitions happen in `SessionManager.afterSettled`, after a run settles, never mid-run. The extension's pipeline tools only validate and acknowledge. The server reads their arguments from `tool_execution_start` and applies them on a successful `tool_execution_end`.
- Flow: setup → grill (`grill-with-docs`) → spec (`to-spec`) → tickets (`to-tickets`) → implement (`tdd` per ticket) → review (`code-review`) → done. Prompts are in `server/src/pipeline.ts`. pi only expands `/skill:name` when an argument follows on the same line; a unit test guards this.
- Each ticket runs under its own pi session id (`<session>-t<num>-<stamp>`), stored on the ticket row, and the review under `sessions.review_run`. `sessions.active_run` says which run is live. A run switch emits `wb_run`, and the browser re-subscribes to get the new snapshot. Switch runs *before* announcing a phase that implies the switch.
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
