import { useEffect, useState } from "react";
import type { Route } from "./App.tsx";
import { api } from "./api.ts";
import { lastBoardRepo } from "./pages/Board.tsx";
import { useStore } from "./store.tsx";
import { type Repo, type SessionSummary, waitingOn } from "./types.ts";
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
  const activeId = route.page === "session" ? route.id : null;
  // Tracked repos, each with its board; reread on navigation, so a repo added on Repositories shows.
  const [repos, setRepos] = useState<Repo[]>([]);
  useEffect(() => {
    api.get<Repo[]>("/api/repos").then(setRepos, () => {});
  }, [route.page]);
  const boardRepo = route.page === "board" ? (route.repoId ?? lastBoardRepo() ?? repos[0]?.id) : null;
  const cardCount = (repoId: string) => all.filter((s) => s.repoId === repoId && s.mode === "pipeline").length;
  const direct = all.filter((s) => s.mode === "direct").length;

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
          <section className="side-section">
            <h4>Boards</h4>
            {repos.map((r) => (
              <a key={r.id} href={`#/board/${encodeURIComponent(r.id)}`} className={`side-item ${boardRepo === r.id ? "active" : ""}`} title={r.id}>
                <span className="side-item-main">
                  <span className="side-item-title">{r.name}</span>
                  <span className="side-item-sub">{r.owner}</span>
                </span>
                <span className="muted small">{cardCount(r.id) || ""}</span>
              </a>
            ))}
            {repos.length === 0 && (
              <p className="side-empty muted">
                No repos yet. <a href="#/repos">Track one</a>.
              </p>
            )}
          </section>
        </div>

        <nav className="side-nav">
          <a href="#/sessions" className={route.page === "sessions" ? "active" : ""}>
            Sessions{direct ? ` (${direct})` : ""}
          </a>
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
