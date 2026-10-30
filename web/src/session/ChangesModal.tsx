import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Changes } from "../types.ts";
import { Modal, Spinner } from "../ui.tsx";

function Diff({ text }: { text: string }) {
  if (!text.trim()) return <p className="muted">No changes.</p>;
  return (
    <pre className="code diff diff-full">
      {text.split("\n").map((line, i) => {
        const cls = line.startsWith("+++") || line.startsWith("---") ? "file" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : line.startsWith("diff ") ? "file" : "";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

export function ChangesModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [c, setC] = useState<Changes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"committed" | "uncommitted">("committed");
  useEffect(() => {
    api
      .get<Changes>(`/api/sessions/${sessionId}/changes`)
      .then((d) => {
        setC(d);
        if (!d.committed.trim() && d.uncommitted.trim()) setTab("uncommitted");
      })
      .catch((e) => setError(e.message));
  }, [sessionId]);
  return (
    <Modal title="Changes" onClose={onClose} wide>
      {error && <div className="alert alert-error">{error}</div>}
      {!c && !error && <Spinner />}
      {c && (
        <>
          <div className="tabs">
            <button className={tab === "committed" ? "active" : ""} onClick={() => setTab("committed")}>
              Committed ({c.ahead})
            </button>
            <button className={tab === "uncommitted" ? "active" : ""} onClick={() => setTab("uncommitted")}>
              Uncommitted ({c.changedFiles})
            </button>
          </div>
          {tab === "committed" && c.log && <pre className="code log">{c.log}</pre>}
          <Diff text={tab === "committed" ? c.committed : c.uncommitted} />
        </>
      )}
    </Modal>
  );
}
