import { phaseLabel } from "../session/PipelinePanel.tsx";
import { useStore } from "../store.tsx";
import { ago, Empty, PageHeader, StatusPill } from "../ui.tsx";

export function Home() {
  const { sessions } = useStore();
  const all = Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt);
  const waiting = all.filter((s) => s.pending.length > 0 || s.attention);
  const running = all.filter((s) => s.status === "running" || s.status === "starting");

  if (all.length === 0) {
    return (
      <div className="page">
        <Empty title="Nothing running yet">
          <p className="muted">
            Add a GitHub token on <a href="#/secrets">Secrets</a>, pick a repo on <a href="#/repos">Repositories</a>, then start a
            session.
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
        title="Overview"
        sub={`${running.length} working · ${waiting.length} waiting on you · ${all.length} session${all.length === 1 ? "" : "s"}`}
      >
        <a className="btn btn-primary" href="#/new">
          + New session
        </a>
      </PageHeader>
      <div className="cards">
        {all.map((s) => (
          <a key={s.id} href={`#/session/${s.id}`} className={`card session-card ${s.pending.length || s.attention ? "card-attn" : ""}`}>
            <div className="row between">
              <StatusPill status={s.status} />
              <span className="muted small">{ago(s.updatedAt)}</span>
            </div>
            <h3>{s.title}</h3>
            <p className="muted small mono ellipsis">
              {s.repoId} · {s.branch}
            </p>
            <p className="card-activity ellipsis">
              {s.pending.length > 0
                ? s.pending[0].kind === "permission"
                  ? `⚠ Wants to run: ${s.pending[0].subject}`
                  : `❓ ${s.pending[0].title}`
                : s.attention
                  ? `⚠ ${s.attention}`
                  : s.heldPrompt
                    ? "Setting up skills; your task is queued"
                    : s.activity || (s.error ? s.error : "Idle")}
            </p>
            {s.mode === "pipeline" && <p className="small phase-line">{phaseLabel(s)}</p>}
            {s.prUrl && <span className="tag">PR #{s.prNumber}</span>}
          </a>
        ))}
      </div>
    </div>
  );
}
