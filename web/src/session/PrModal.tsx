import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import type { PrDraft, SessionSummary } from "../types.ts";
import { Modal, Spinner } from "../ui.tsx";

/** Create PR: the model drafts a title and body from the diff, the user edits, the server pushes and opens it. */
export function PrModal({ session, onClose }: { session: SessionSummary; onClose: () => void }) {
  const { toast } = useStore();
  const [draft, setDraft] = useState<PrDraft | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [isDraft, setIsDraft] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .post<PrDraft>(`/api/sessions/${session.id}/pr/draft`)
      .then((d) => {
        setDraft(d);
        setTitle(d.title);
        setBody(d.body);
        setCommitMessage(d.title);
      })
      .catch((e) => setError(e.message));
  }, [session.id]);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const pr = await api.post<{ number: number; url: string }>(`/api/sessions/${session.id}/pr`, {
        title,
        body,
        commitMessage: draft?.dirty ? commitMessage : undefined,
        draft: isDraft,
      });
      toast(`Opened PR #${pr.number}`);
      window.open(pr.url, "_blank", "noopener");
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  };

  return (
    <Modal title="Create pull request" onClose={onClose} wide>
      {!draft && !error && (
        <div className="center-pad">
          <Spinner /> <span className="muted">Drafting the title and description from the diff…</span>
        </div>
      )}
      {error && <div className="alert alert-error">{error}</div>}
      {draft && (
        <div className="form">
          <p className="muted small mono">
            {session.branch} → {session.baseBranch} · {draft.ahead} commit{draft.ahead === 1 ? "" : "s"}
            {draft.dirty ? ` · ${draft.changedFiles} uncommitted file${draft.changedFiles === 1 ? "" : "s"}` : ""}
          </p>
          {draft.error && <div className="alert">{draft.error}. You can still write it yourself.</div>}
          <label>
            Title
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Description
            <textarea className="input mono" rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          {draft.dirty && (
            <label>
              Commit the uncommitted changes as
              <input className="input" value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} />
              <span className="muted small">Leave empty to open the PR with only the commits already made.</span>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={isDraft} onChange={(e) => setIsDraft(e.target.checked)} /> Open as draft
          </label>
          <div className="row gap end">
            <button className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={creating || !title.trim()} onClick={create}>
              {creating ? <Spinner small /> : null} Push &amp; open PR
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
