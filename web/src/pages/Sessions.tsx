import { useStore } from "../store.tsx";
import { waitingOn } from "../types.ts";
import { ago, Empty, PageHeader, StatusPill, issueUrl, repoIssue } from "../ui.tsx";
import { columnOf, COLUMNS } from "../../../shared/board.ts";

/** The column label of a session's phase; "" when the phase has no column (a direct session). */
const columnLabel = (phase: string) => {
  const col = columnOf(phase);
  return col ? (COLUMNS.find((c) => c.id === col)?.label ?? "") : "";
};

/** The direct-mode sessions: plain agent turns, each a card in Doing on its repo's board. */
export function Sessions() {
  const { sessions } = useStore();
  const direct = Object.values(sessions)
    .filter((s) => s.mode === "direct")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const cards = Object.values(sessions)
    .filter((s) => s.mode === "pipeline")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const waiting = direct.filter((s) => waitingOn(s).length > 0 || s.attention);
  const running = direct.filter((s) => s.status === "running" || s.status === "starting");

  return (
    <div className="page">
      <PageHeader
        title="Sessions"
        sub={`${running.length} working · ${waiting.length} waiting on you · ${direct.length} direct session${direct.length === 1 ? "" : "s"}`}
      >
        <a className="btn btn-primary" href="#/new">
          + New session
        </a>
      </PageHeader>

      <section>
        <h2>Cards</h2>
        {cards.length === 0 ? (
          <p className="muted small">
            Card sessions (the pipeline) show here. Start one on the <a href="#/">board</a> or with a new session.
          </p>
        ) : (
          <div className="card-list">
            {cards.map((s) => {
              const isRunning = s.status === "running" || s.status === "starting";
              const run = s.runs.find((r) => r.id === s.activeRun);
              return (
                <a key={s.id} href={`#/session/${s.id}`} className="card-list-row">
                  <div className="row between">
                    <h3 className="ellipsis">{s.title}</h3>
                    {isRunning && <span className="live-dot" />}
                  </div>
                  <div className="row gap">
                    <span className="tag">{columnLabel(s.phase)}</span>
                    <span className="muted small mono ellipsis">{run?.label ?? "—"}</span>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </section>

      <section>
        {direct.length === 0 ? (
          <Empty title="No direct sessions">
            <p className="muted">
              Direct sessions skip the pipeline: pick <strong>Direct</strong> on the New session form. Each is a card in Doing on
              its repo's <a href="#/">board</a>.
            </p>
            <a className="btn btn-primary" href="#/new">
              + New session
            </a>
          </Empty>
        ) : (
          <div className="cards">
            {direct.map((s) => {
              const issue = repoIssue(s.issueRef);
              const pending = waitingOn(s);
              return (
                <a key={s.id} href={`#/session/${s.id}`} className={`card session-card ${pending.length || s.attention ? "card-attn" : ""}`}>
                  <div className="row between">
                    <StatusPill status={s.status} />
                    <span className="muted small">{ago(s.updatedAt)}</span>
                  </div>
                  <h3>{s.title}</h3>
                  <p className="muted small mono ellipsis">
                    {s.repoId} · {s.branch}
                  </p>
                  <p className="card-activity ellipsis">
                    {pending.length > 0
                      ? pending[0].kind === "permission"
                        ? `⚠ Wants to run: ${pending[0].subject}`
                        : `❓ ${pending[0].title}`
                      : s.attention
                        ? `⚠ ${s.attention}`
                        : s.heldPrompt
                          ? "Setting up skills; your task is queued"
                          : s.activity || (s.error ? s.error : "Idle")}
                  </p>
                  <div className="row gap">
                    {issue && (
                      <a className="tag" href={issueUrl(s.issueRef)} title={`Solving ${s.issueRef}`}>
                        Issue #{issue.number}
                      </a>
                    )}
                    {s.prUrl && <span className="tag">PR #{s.prNumber}</span>}
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
