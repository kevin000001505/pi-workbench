import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import type { GhRepo, Repo } from "../types.ts";
import { Empty, Modal, PageHeader, Spinner } from "../ui.tsx";

function AddRepoModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { toast } = useStore();
  const [list, setList] = useState<GhRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<GhRepo[]>("/api/github/repos")
      .then(setList)
      .catch((e) => setError(e.message));
  }, []);
  const shown = useMemo(() => (list ?? []).filter((r) => r.id.toLowerCase().includes(q.toLowerCase())), [list, q]);
  const add = async (id: string) => {
    setAdding(id);
    try {
      await api.post("/api/repos", { id });
      toast(`Cloned ${id}`);
      onAdded();
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
      setAdding(null);
    }
  };
  return (
    <Modal title="Add a GitHub repository" onClose={onClose}>
      {error && <div className="alert alert-error">{error}</div>}
      {!list && !error && <Spinner />}
      {list && (
        <>
          <input className="input" autoFocus placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="pick-list">
            {shown.map((r) => (
              <button key={r.id} className="pick" disabled={!!adding} onClick={() => add(r.id)}>
                <span>
                  <span className="mono">{r.id}</span> {r.private && <span className="tag">private</span>}
                  {r.description && <span className="muted small block">{r.description}</span>}
                </span>
                {adding === r.id ? <Spinner small /> : <span className="muted">Add</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

function CreateRepoModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { toast } = useStore();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priv, setPriv] = useState(true);
  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<Repo>("/api/repos/create", { name, description, private: priv, org: org || undefined });
      toast(`Created ${r.id}`);
      onAdded();
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
      setBusy(false);
    }
  };
  return (
    <Modal title="Create a GitHub repository" onClose={onClose}>
      <div className="form">
        <label>
          Name
          <input className="input mono" autoFocus value={name} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_.-]/g, "-"))} />
        </label>
        <label>
          Description
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Organization <span className="muted small">(empty = your account)</span>
          <input className="input mono" value={org} onChange={(e) => setOrg(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Private
        </label>
        <p className="muted small">Created with a README so it can be cloned. Its first session runs /setup-matt-pocock-skills.</p>
        <div className="row gap end">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name || busy} onClick={create}>
            {busy ? <Spinner small /> : null} Create &amp; clone
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Repos() {
  const { toast, sessions } = useStore();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [modal, setModal] = useState<"add" | "create" | null>(null);
  const load = useCallback(() => {
    api
      .get<Repo[]>("/api/repos")
      .then(setRepos)
      .catch((e) => toast(e.message, "error"));
  }, [toast]);
  useEffect(load, [load]);

  return (
    <div className="page">
      <PageHeader title="Repositories" sub="Repos are cloned into the workbench volume; sessions branch off them in worktrees.">
        <button className="btn" onClick={() => setModal("add")}>
          Add from GitHub
        </button>
        <button className="btn btn-primary" onClick={() => setModal("create")}>
          + Create repo
        </button>
      </PageHeader>
      {!repos && <Spinner />}
      {repos?.length === 0 && (
        <Empty title="No repositories yet">
          <p className="muted">
            Needs a <code>GITHUB_TOKEN</code> on the <a href="#/secrets">Secrets</a> page.
          </p>
        </Empty>
      )}
      <div className="cards">
        {repos?.map((r) => {
          const count = Object.values(sessions).filter((s) => s.repoId === r.id).length;
          return (
            <div key={r.id} className="card">
              <div className="row between">
                <h3 className="mono">{r.id}</h3>
                {r.private && <span className="tag">private</span>}
              </div>
              <p className="muted small">
                default branch <span className="mono">{r.defaultBranch}</span> · {count} session{count === 1 ? "" : "s"}
              </p>
              <p className="small">
                {r.needsSetup ? (
                  <span className="tag tag-warn">skills not set up: the next session runs setup</span>
                ) : (
                  <span className="tag tag-ok">skills set up</span>
                )}
              </p>
              <div className="row gap">
                <a className="btn btn-sm btn-primary" href={`#/new/${encodeURIComponent(r.id)}`}>
                  New session
                </a>
                <a className="btn btn-sm btn-ghost" href={`https://github.com/${r.id}`} target="_blank" rel="noopener">
                  GitHub ↗
                </a>
                <button
                  className="btn btn-sm btn-ghost danger"
                  onClick={async () => {
                    if (!confirm(`Remove ${r.id} from the workbench? This deletes the local clone, not the GitHub repo.`)) return;
                    await api.del(`/api/repos/${r.id}`).catch((e) => toast(e.message, "error"));
                    load();
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {modal === "add" && <AddRepoModal onClose={() => setModal(null)} onAdded={load} />}
      {modal === "create" && <CreateRepoModal onClose={() => setModal(null)} onAdded={load} />}
    </div>
  );
}
