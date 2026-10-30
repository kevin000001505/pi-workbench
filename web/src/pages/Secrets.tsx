import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import type { Repo, SecretMeta } from "../types.ts";
import { ago, PageHeader } from "../ui.tsx";

const SUGGESTED = [
  { name: "GITHUB_TOKEN", hint: "Fine-grained PAT: Contents + Pull requests read/write, Administration write to create repos" },
  { name: "LLM_API_KEY", hint: "Only if your model endpoint needs a key" },
];

export function Secrets() {
  const { toast } = useStore();
  const [list, setList] = useState<SecretMeta[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [scope, setScope] = useState("global");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);

  const load = useCallback(() => {
    api.get<SecretMeta[]>("/api/secrets").then(setList).catch((e) => toast(e.message, "error"));
  }, [toast]);
  useEffect(() => {
    load();
    api.get<Repo[]>("/api/repos").then(setRepos).catch(() => {});
  }, [load]);

  const save = async () => {
    try {
      await api.put("/api/secrets", { scope, name: name.trim(), value });
      toast(`Saved ${name.trim()}`);
      setName("");
      setValue("");
      setShow(false);
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const scoped = list.filter((s) => s.scope === scope);
  const missing = scope === "global" ? SUGGESTED.filter((s) => !list.some((x) => x.scope === "global" && x.name === s.name)) : [];

  return (
    <div className="page page-narrow">
      <PageHeader
        title="Secrets"
        sub="Environment variables for agent sessions. Encrypted at rest with your master key; once saved, a value is never shown or sent back to the browser."
      />
      <div className="tabs">
        <button className={scope === "global" ? "active" : ""} onClick={() => setScope("global")}>
          Global
        </button>
        {repos.map((r) => (
          <button key={r.id} className={scope === r.id ? "active" : ""} onClick={() => setScope(r.id)}>
            {r.id}
          </button>
        ))}
      </div>
      <p className="muted small">
        {scope === "global"
          ? "Every session gets these."
          : `Sessions in ${scope} get these on top of the global ones; a name here overrides the global value.`}{" "}
        Changes apply to sessions started or resumed afterwards.
      </p>

      <div className="card">
        {scoped.length === 0 && <p className="muted">No variables in this scope.</p>}
        {scoped.map((s) => (
          <div key={s.name} className="secret-row">
            <span className="mono">{s.name}</span>
            <span className="mono muted">••••••••••••</span>
            <span className="muted small">{ago(s.updatedAt)}</span>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setName(s.name);
                setValue("");
              }}
            >
              Replace
            </button>
            <button
              className="btn btn-sm btn-ghost danger"
              onClick={async () => {
                if (!confirm(`Delete ${s.name}?`)) return;
                await api.del(`/api/secrets/${s.scope}/${s.name}`).catch((e) => toast(e.message, "error"));
                load();
              }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>

      {missing.length > 0 && (
        <div className="suggest">
          {missing.map((m) => (
            <button key={m.name} className="suggest-item" onClick={() => setName(m.name)}>
              <span className="mono">+ {m.name}</span>
              <span className="muted small">{m.hint}</span>
            </button>
          ))}
        </div>
      )}

      <form
        className="card form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h3>{list.some((s) => s.scope === scope && s.name === name) ? `Replace ${name}` : "Add a variable"}</h3>
        <div className="grid2">
          <label>
            Name
            <input
              className="input mono"
              placeholder="API_KEY"
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            />
          </label>
          <label>
            Value
            <div className="row gap">
              <input
                className="input mono grow"
                type={show ? "text" : "password"}
                autoComplete="new-password"
                spellCheck={false}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShow((s) => !s)}>
                {show ? "Hide" : "Show"}
              </button>
            </div>
          </label>
        </div>
        <div className="row end">
          <button className="btn btn-primary" disabled={!name || !value}>
            Save encrypted
          </button>
        </div>
      </form>
    </div>
  );
}
