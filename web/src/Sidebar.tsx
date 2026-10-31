import type { Route } from "./App.tsx";
import { useStore } from "./store.tsx";
import { type SessionSummary, waitingOn } from "./types.ts";
import { phaseLabel } from "./session/PipelinePanel.tsx";
import { StatusDot } from "./ui.tsx";

function SessionLink({ s, active }: { s: SessionSummary; active: boolean }) {
  const pending = waitingOn(s);
  return (
    <a href={`#/session/${s.id}`} className={`side-item ${active ? "active" : ""}`}>
      <StatusDot status={s.status} />
      <span className="side-item-main">
        <span className="side-item-title">{s.title}</span>
        <span className="side-item-sub">
          {pending.length > 0
            ? pending[0].kind === "permission"
              ? `Permission: ${pending[0].tool}`
              : "Decision needed"
            : s.attention
              ? "Pipeline needs you"
              : s.activity || phaseLabel(s) || (s.prNumber ? `PR #${s.prNumber}` : s.branch)}
        </span>
      </span>
      {(pending.length > 0 || s.attention) && <span className="badge">{pending.length || "!"}</span>}
    </a>
  );
}

export function Sidebar({ route, onClose }: { route: Route; onClose: () => void }) {
  const { sessions, connected } = useStore();
  const all = Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt);
  const waiting = all.filter((s) => waitingOn(s).length > 0 || s.attention);
  const byRepo = new Map<string, SessionSummary[]>();
  for (const s of all) byRepo.set(s.repoId, [...(byRepo.get(s.repoId) ?? []), s]);
  const activeId = route.page === "session" ? route.id : null;

  return (
    <>
      <div className="nav-scrim" onClick={onClose} />
      <aside className="sidebar">
        <a className="brand" href="#/">
          <span className="brand-mark">π</span>
          <span>workbench</span>
          <span className={`conn ${connected ? "on" : ""}`} title={connected ? "Live" : "Reconnecting…"} />
        </a>
        <a className="btn btn-primary btn-block" href="#/new">
          + New session
        </a>

        {waiting.length > 0 && (
          <section className="side-section side-waiting">
            <h4>Waiting on you</h4>
            {waiting.map((s) => (
              <SessionLink key={s.id} s={s} active={s.id === activeId} />
            ))}
          </section>
        )}

        <div className="side-scroll">
          {[...byRepo.entries()].map(([repo, list]) => (
            <section key={repo} className="side-section">
              <h4 title={repo}>
                {repo}
                <a className="side-add" href={`#/new/${encodeURIComponent(repo)}`} title="New session in this repo">
                  +
                </a>
              </h4>
              {list.map((s) => (
                <SessionLink key={s.id} s={s} active={s.id === activeId} />
              ))}
            </section>
          ))}
          {all.length === 0 && <p className="side-empty muted">No sessions yet.</p>}
        </div>

        <nav className="side-nav">
          <a href="#/issues" className={route.page === "issues" ? "active" : ""}>
            Issues
          </a>
          <a href="#/repos" className={route.page === "repos" ? "active" : ""}>
            Repositories
          </a>
          <a href="#/secrets" className={route.page === "secrets" ? "active" : ""}>
            Secrets
          </a>
          <a href="#/ssh" className={route.page === "ssh" ? "active" : ""}>
            SSH
          </a>
          <a href="#/settings" className={route.page === "settings" ? "active" : ""}>
            Settings
          </a>
        </nav>
      </aside>
    </>
  );
}
