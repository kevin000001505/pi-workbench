import { useState } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import type { UiRequest } from "../types.ts";

/** A permission or decision the agent is blocked on. Answering it resumes the session. */
export function PendingCard({ sessionId, req }: { sessionId: string; req: UiRequest }) {
  const { toast } = useStore();
  const [text, setText] = useState(req.prefill ?? "");
  const [busy, setBusy] = useState(false);

  const answer = async (body: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
    setBusy(true);
    try {
      await api.post(`/api/sessions/${sessionId}/respond`, { requestId: req.id, ...body });
    } catch (e) {
      toast((e as Error).message, "error");
      setBusy(false);
    }
  };

  if (req.kind === "permission") {
    return (
      <div className="pending pending-permission">
        <div className="pending-head">
          <span className="pending-kind">Permission</span>
          <span className="muted small">{req.reasons?.join(" · ")}</span>
          {req.judge?.state === "judging" && <span className="tag">Risk judge rating…</span>}
        </div>
        {req.judge?.note && <p className={`small ${req.judge.state === "failed" ? "text-warn" : "muted"}`}>{req.judge.note}</p>}
        <p className="pending-title">The agent wants to run {req.tool}:</p>
        <pre className="code pending-subject">{req.subject}</pre>
        <div className="row gap wrap">
          <button className="btn btn-primary" disabled={busy} onClick={() => answer({ value: "Allow" })}>
            Allow
          </button>
          <button className="btn" disabled={busy} onClick={() => answer({ value: "Allow for this session" })}>
            Allow for this session
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={() => answer({ value: "Deny" })}>
            Deny
          </button>
          <input
            className="input grow"
            placeholder="…or deny with a note for the agent"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && text.trim() && answer({ value: text.trim() })}
          />
        </div>
      </div>
    );
  }

  const options = req.method === "select" ? (req.options ?? []) : [];
  return (
    <div className="pending pending-decision">
      <div className="pending-head">
        <span className="pending-kind">{req.kind === "decision" ? "Decision" : "Input"}</span>
      </div>
      <p className="pending-title">{req.title}</p>
      {req.message && <p className="muted">{req.message}</p>}
      {req.method === "confirm" ? (
        <div className="row gap">
          <button className="btn btn-primary" disabled={busy} onClick={() => answer({ confirmed: true })}>
            Yes
          </button>
          <button className="btn" disabled={busy} onClick={() => answer({ confirmed: false })}>
            No
          </button>
        </div>
      ) : (
        <>
          {options.length > 0 && (
            <div className="options">
              {options.map((o, i) => (
                <button key={o} className={`option ${i === 0 ? "option-rec" : ""}`} disabled={busy} onClick={() => answer({ value: o })}>
                  {o}
                </button>
              ))}
            </div>
          )}
          <div className="row gap">
            {req.method === "editor" ? (
              <textarea className="input grow" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
            ) : (
              <input
                className="input grow"
                placeholder={options.length ? "Or type your own answer" : (req.placeholder ?? "Your answer")}
                value={text}
                autoFocus={options.length === 0}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && text.trim() && answer({ value: text.trim() })}
              />
            )}
            <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => answer({ value: text.trim() })}>
              Answer
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => answer({ cancelled: true })}>
              Skip
            </button>
          </div>
        </>
      )}
    </div>
  );
}
