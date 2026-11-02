import { useStore } from "../store.tsx";
import { waitingOn } from "../types.ts";
import { ago, Empty, PageHeader, StatusPill, issueUrl, parseIssueRef } from "../ui.tsx";

/** The direct-mode sessions: plain agent turns, which are no card on any board. */
export function Sessions() {
  const { sessions } = useStore();
  const all = Object.values(sessions)
    .filter((s) => s.mode === "direct")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const waiting = all.filter((s) => waitingOn(s).length > 0 || s.attention);
  const running = all.filter((s) => s.status === "running" || s.status === "starting");

  if (all.length === 0) {
    return (
      <div className="page">
        <Empty title="No direct sessions">
          <p className="muted">
            Direct sessions skip the pipeline: pick <strong>Direct</strong> on the New session form. Pipeline sessions are cards on
            each repo's <a href="#/">board</a>.
          </p>
          <a className="btn btn-primary" href="#/new">
            + New session
          </a>
        </Empty>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Sessions"
        sub={`${running.length} working · ${waiting.length} waiting on you · ${all.length} session${all.length === 1 ? "" : "s"}`}
      >
        <a className="btn btn-primary" href="#/new">
          + New session
        </a>
      </PageHeader>
      <div className="cards">
        {all.map((s) => {
          const issue = parseIssueRef(s.issueRef);
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
    </div>
  );
}
