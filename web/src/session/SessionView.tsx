import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { go } from "../App.tsx";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import type { Transcript as TranscriptT } from "../../../shared/transcript.ts";
import type { PrStatus } from "../types.ts";
import { Empty, kTokens, Spinner, StatusPill } from "../ui.tsx";
import { ChangesModal } from "./ChangesModal.tsx";
import { Composer } from "./Composer.tsx";
import { PendingCard } from "./PendingCard.tsx";
import { PipelinePanel } from "./PipelinePanel.tsx";
import { PrModal } from "./PrModal.tsx";
import { Transcript } from "./Transcript.tsx";

function PrBadge({ sessionId, number, url }: { sessionId: string; number: number; url: string }) {
  const [st, setSt] = useState<PrStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<PrStatus>(`/api/sessions/${sessionId}/pr`)
        .then((s) => alive && setSt(s))
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId]);
  const checks = st?.checks;
  const ci = !checks || checks.total === 0 ? "" : checks.failed ? "✕" : checks.pending ? "…" : "✓";
  return (
    <a className={`btn btn-sm pr-badge pr-${st?.state ?? "open"} ${checks?.failed ? "pr-failing" : ""}`} href={url} target="_blank" rel="noopener">
      PR #{number}
      {st && <span className="muted"> · {st.state}</span>}
      {ci && <span className={`ci ci-${checks!.failed ? "fail" : checks!.pending ? "pending" : "pass"}`}>{ci}</span>}
    </a>
  );
}

export function SessionView({ id }: { id: string }) {
  const store = useStore();
  const { sessions, watch, toast, version } = store;
  const s = sessions[id];
  const t = store.transcript(id);
  const [pr, setPr] = useState(false);
  const [changes, setChanges] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** A past run being read (a finished ticket, or the plan conversation); null shows the live one. */
  const [past, setPast] = useState<{ runId: string; t: TranscriptT | null } | null>(null);

  useEffect(() => {
    watch(id);
    return () => watch(null);
  }, [id, watch]);

  const viewRun = (runId: string) => {
    if (!s || runId === s.activeRun) return setPast(null);
    setPast({ runId, t: null });
    api
      .get<TranscriptT>(`/api/sessions/${id}/runs/${encodeURIComponent(runId)}`)
      .then((t) => setPast((p) => (p?.runId === runId ? { runId, t } : p)))
      .catch((e) => {
        toast(e.message, "error");
        setPast(null);
      });
  };

  // Follow the stream while the user is at the bottom; leave them be once they scroll up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [version, s?.pending.length]);

  if (!s) {
    return (
      <div className="page">
        <Empty title="Session not found">
          <a href="#/">Back to overview</a>
        </Empty>
      </div>
    );
  }

  const act = (path: string, body?: unknown) => api.post(`/api/sessions/${id}/${path}`, body).catch((e) => toast(e.message, "error"));
  const busy = s.status === "running" || s.status === "waiting";
  const live = s.status !== "stopped" && s.status !== "error";
  const ctxPct = s.contextWindow ? Math.min(100, (s.contextTokens / s.contextWindow) * 100) : 0;

  return (
    <div className="session">
      <header className="session-head">
        <div className="session-title">
          {editing ? (
            <input
              className="input title-input"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                setEditing(false);
                if (title.trim() && title !== s.title) api.patch(`/api/sessions/${id}`, { title }).catch((e) => toast(e.message, "error"));
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <h1
              onDoubleClick={() => {
                setTitle(s.title);
                setEditing(true);
              }}
              title="Double-click to rename"
            >
              {s.title}
            </h1>
          )}
          <div className="session-meta">
            <StatusPill status={s.status} />
            <span className="mono small muted ellipsis">
              {s.repoId} · {s.branch}
            </span>
            {s.contextTokens > 0 && (
              <span className="ctx" title={`${s.contextTokens.toLocaleString()} of ${s.contextWindow.toLocaleString()} tokens`}>
                <span className="ctx-bar">
                  <span style={{ width: `${ctxPct}%` }} className={ctxPct > 80 ? "hot" : ""} />
                </span>
                {kTokens(s.contextTokens)} / {kTokens(s.contextWindow)}
              </span>
            )}
          </div>
        </div>
        <div className="row gap wrap session-actions">
          <button className="btn btn-sm" onClick={() => setChanges(true)}>
            Changes
          </button>
          {s.prNumber && s.prUrl ? (
            <PrBadge sessionId={id} number={s.prNumber} url={s.prUrl} />
          ) : (
            <button className="btn btn-sm btn-accent" onClick={() => setPr(true)}>
              Create PR
            </button>
          )}
          {busy && (
            <button className="btn btn-sm" onClick={() => act("abort")}>
              Stop turn
            </button>
          )}
          {live ? (
            <button className="btn btn-sm btn-ghost" onClick={() => act("stop")} title="End the pi process; the conversation is kept">
              Pause
            </button>
          ) : (
            <button className="btn btn-sm" onClick={() => act("start")}>
              Resume
            </button>
          )}
          <button
            className="btn btn-sm btn-ghost danger"
            onClick={async () => {
              if (!confirm(`Archive "${s.title}"? Its worktree is deleted; pushed branches and PRs stay on GitHub.`)) return;
              await api.del(`/api/sessions/${id}`).catch((e) => toast(e.message, "error"));
              go("#/");
            }}
          >
            Archive
          </button>
        </div>
      </header>

      {s.mode === "pipeline" && <PipelinePanel s={s} viewRun={past?.runId ?? s.activeRun} onView={viewRun} />}
      {s.runs.length > 1 && (
        <div className="run-tabs tabs">
          {s.runs.map((r) => {
            const on = (past?.runId ?? s.activeRun) === r.id;
            return (
              <button key={r.id} className={on ? "active" : ""} onClick={() => viewRun(r.id)} title={r.label}>
                {r.id === s.activeRun && <span className="live-dot" />}
                {r.label}
              </button>
            );
          })}
        </div>
      )}

      <div
        className="session-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {past ? (
          past.t ? (
            <Transcript t={past.t} />
          ) : (
            <div className="center-pad">
              <Spinner />
            </div>
          )
        ) : !t ? (
          <div className="center-pad">
            <Spinner />
          </div>
        ) : (
          <>
            {t.messages.length === 0 && !t.busy && !s.heldPrompt && <Empty title="Say what to build" />}
            <Transcript t={t} />
          </>
        )}
        {s.error && (
          <div className="alert alert-error">
            {s.error}
            <details>
              <summary>pi output</summary>
              <pre className="code">{store.stderr(id).join("\n") || "(none)"}</pre>
            </details>
          </div>
        )}
      </div>

      <div className="session-foot">
        {past && (
          <div className="held">
            <span className="muted">You are reading an earlier run. It is read-only.</span>
            <button className="btn btn-sm btn-primary" onClick={() => setPast(null)}>
              Back to live
            </button>
          </div>
        )}
        {!past && s.heldPrompt && (
          <div className="held">
            <div>
              <strong>Setting up Matt Pocock’s skills first.</strong>{" "}
              <span className="muted">
                {s.mode === "pipeline"
                  ? "Then grill-me starts on your task:"
                  : "Your task is queued and goes out once setup commits its files:"}
              </span>
              <div className="held-text">{s.heldPrompt}</div>
            </div>
            <div className="row gap">
              <button className="btn btn-sm" onClick={() => act("held", { action: "send" })}>
                Send now
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => act("held", { action: "discard" })}>
                Discard
              </button>
            </div>
          </div>
        )}
        {!past && s.pending.map((r) => <PendingCard key={r.id} sessionId={id} req={r} />)}
        {!past && <Composer
          sessionId={id}
          busy={busy}
          onSend={async (text, mode) => {
            stick.current = true;
            await api.post(`/api/sessions/${id}/prompt`, { message: text, mode }).catch((e) => {
              toast(e.message, "error");
              throw e;
            });
          }}
        />}
      </div>
      {pr && <PrModal session={s} onClose={() => setPr(false)} />}
      {changes && <ChangesModal sessionId={id} onClose={() => setChanges(false)} />}
    </div>
  );
}
