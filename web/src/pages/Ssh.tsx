import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import type { SshView } from "../types.ts";
import { ago, PageHeader } from "../ui.tsx";

// A key name becomes the file name ~/.ssh/<name>: start with a letter, then letters, digits, dots and dashes.
const NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;

export function Ssh() {
  const { toast } = useStore();
  const [view, setView] = useState<SshView | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [nameError, setNameError] = useState("");

  const load = useCallback(() => {
    api.get<SshView>("/api/ssh").then(setView).catch((e) => toast(e.message, "error"));
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);

  // Unlike the Secrets page, the name is a file name: keep the case, no rewriting.
  const onName = (v: string) => {
    setName(v);
    const n = v.trim();
    if (n && !NAME_RE.test(n)) setNameError("Key names start with a letter and use letters, digits, dots and dashes.");
    else setNameError("");
  };

  const save = async () => {
    try {
      await api.put("/api/secrets", { scope: "global", name: name.trim(), value });
      toast(`Saved ${name.trim()}`);
      setName("");
      setValue("");
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const keys = view?.keys ?? [];
  const replacing = keys.some((k) => k.name === name.trim());

  return (
    <div className="page page-narrow">
      <PageHeader
        title="SSH"
        sub="Keys for the agent to reach your machines. Stored encrypted like other secrets; once saved, a value is never shown again. Keys materialize as ~/.ssh/<name> in the agent's home (a 0600 file in a 0700 directory)."
      />
      <div className="card">
        <h3>Keys</h3>
        {keys.length === 0 && <p className="muted">No keys yet. Paste one below.</p>}
        {keys.map((k) => (
          <div key={k.name} className="secret-row">
            <span className="mono">{k.name}</span>
            <span className="mono muted">••••••••••••</span>
            <span className="muted small">{ago(k.updatedAt)}</span>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setName(k.name);
                setValue("");
              }}
            >
              Replace
            </button>
            <button
              className="btn btn-sm btn-ghost danger"
              onClick={async () => {
                if (!confirm(`Delete ${k.name}? Its ~/.ssh/${k.name} file is removed from the agent's home.`)) return;
                await api.del(`/api/secrets/global/${k.name}`).catch((e) => toast(e.message, "error"));
                load();
              }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>

      <form
        className="card form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h3>{replacing ? `Replace ${name.trim()}` : "Add a key"}</h3>
        <div className="grid2">
          <label>
            Name <span className="muted small">file name, case kept</span>
            <input className="input mono" placeholder="media" value={name} onChange={(e) => onName(e.target.value)} />
          </label>
          <label>
            Key
            <textarea
              className="input mono"
              rows={6}
              spellCheck={false}
              placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        </div>
        {nameError && <div className="alert alert-error">{nameError}</div>}
        <div className="row end">
          <button className="btn btn-primary" disabled={!name.trim() || !value || !!nameError}>
            Save encrypted
          </button>
        </div>
      </form>
    </div>
  );
}
