import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import type { SshHost, SshView } from "../types.ts";
import { ago, PageHeader, Spinner } from "../ui.tsx";

// A key name becomes the file name ~/.ssh/<name>: start with a letter, then letters, digits, dots and dashes.
const NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;

export function Ssh() {
  const { toast } = useStore();
  const [view, setView] = useState<SshView | null>(null);

  const load = useCallback(() => {
    api.get<SshView>("/api/ssh").then(setView).catch((e) => toast(e.message, "error"));
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);

  if (!view) return <Spinner />;
  return (
    <div className="page page-narrow">
      <PageHeader
        title="SSH"
        sub="Keys and hosts for the agent to reach your machines. Keys are stored encrypted (a value is never shown again) and materialize as ~/.ssh/<name> in the agent's home. Hosts become ssh aliases in the agent's ~/.ssh/config: save a host and Test it, then just say the alias to the agent."
      />
      <KeysCard view={view} reload={load} />
      <HostsCard view={view} reload={load} />
    </div>
  );
}

function KeysCard({ view, reload }: { view: SshView; reload: () => void }) {
  const { toast } = useStore();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [nameError, setNameError] = useState("");
  const keys = view.keys;

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
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const replacing = keys.some((k) => k.name === name.trim());

  return (
    <>
      <div className="card">
        <h3>Keys</h3>
        <p className="muted small">
          Stored encrypted like other secrets; once saved, a value is never shown again. Materialized as ~/.ssh/{"<name>"}
          in the agent's home (a 0600 file in a 0700 directory).
        </p>
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
                reload();
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
    </>
  );
}

type HostForm = { alias: string; user: string; hostname: string; port: string; keyName: string };
const EMPTY_HOST: HostForm = { alias: "", user: "", hostname: "", port: "", keyName: "" };

/** Client-side mirror of the server's host validation; the server re-checks and its message wins. */
function hostError(
  h: { alias: string; user: string; hostname: string; port?: number | string | null; keyName?: string },
  list: { alias: string }[],
  selfIdx: number | null,
): string {
  if (!NAME_RE.test(h.alias)) return `Alias "${h.alias}" must start with a letter and use letters, digits, dots and dashes.`;
  if (list.some((x, i) => i !== selfIdx && x.alias === h.alias)) return `Alias "${h.alias}" is already used by another host.`;
  if (!h.user.trim()) return "User is required.";
  if (!h.hostname.trim()) return "Hostname is required.";
  if (h.port !== undefined && h.port !== null && h.port !== "") {
    const n = typeof h.port === "string" ? (/^\d+$/.test(h.port) ? Number(h.port) : NaN) : h.port;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65535) return "Port must be 1–65535.";
  }
  const k = (h.keyName ?? "").trim();
  if (k && !NAME_RE.test(k)) return "Key name must start with a letter and use letters, digits, dots and dashes.";
  return "";
}

function HostsCard({ view, reload }: { view: SshView; reload: () => void }) {
  const { toast } = useStore();
  const keys = view.keys;
  // The editable working list (full-list save, like the approval rules). keyMissing is recomputed here
  // so unsaved edits and key deletions show up without a reload; it mirrors the server's flag.
  const [list, setList] = useState<SshHost[]>(view.hosts.map(({ keyMissing: _missing, ...h }) => h));
  useEffect(() => {
    setList(view.hosts.map(({ keyMissing: _missing, ...h }) => h));
  }, [view]);
  const [form, setForm] = useState<HostForm | null>(null);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [testBusy, setTestBusy] = useState("");
  const [results, setResults] = useState<Record<string, { ok: boolean; detail: string }>>({});

  const saved = view.hosts.map(({ keyMissing: _missing, ...h }) => h);
  const dirty = JSON.stringify(list) !== JSON.stringify(saved);
  const missingKey = (h: SshHost) => !!h.keyName && !keys.some((k) => k.name === h.keyName);
  const formError = form ? hostError(form, list, editIdx) : "";

  const submitForm = () => {
    if (!form || formError) return;
    const h: SshHost = {
      alias: form.alias,
      user: form.user.trim(),
      hostname: form.hostname.trim(),
      keyName: form.keyName.trim(),
    };
    if (form.port.trim() !== "") h.port = Number(form.port.trim());
    setList((l) => (editIdx === null ? [...l, h] : l.map((x, i) => (i === editIdx ? h : x))));
    setForm(null);
    setEditIdx(null);
  };

  const del = (i: number) => {
    if (!confirm(`Remove ${list[i].alias} from the list? It is deleted from the agent's ssh config when you save.`)) return;
    setList((l) => l.filter((_, j) => j !== i));
  };

  const save = async () => {
    for (let i = 0; i < list.length; i++) {
      const e = hostError(list[i], list, i);
      if (e) {
        toast(e, "error");
        return;
      }
    }
    setSaving(true);
    try {
      const r = await api.put<{ hosts: SshHost[] }>("/api/ssh/hosts", { hosts: list });
      toast(`Saved ${r.hosts.length} host${r.hosts.length === 1 ? "" : "s"}; the agent's ssh config is updated.`);
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (alias: string) => {
    setTestBusy(alias);
    setResults((r) => {
      const n = { ...r };
      delete n[alias];
      return n;
    });
    try {
      const r = await api.post<{ ok: boolean; detail: string }>("/api/ssh/test", { alias });
      setResults((prev) => ({ ...prev, [alias]: r }));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setTestBusy("");
    }
  };

  return (
    <div className="card">
      <h3>Hosts</h3>
      <p className="muted small">
        One ssh alias per machine, in the agent's ~/.ssh/config. Edits apply when you press Save hosts; a Test
        verifies a saved host end to end (key, address, auth).
      </p>
      {list.length === 0 && !form && <p className="muted">No hosts yet. Add one below.</p>}
      {list.map((h, i) => (
        <div key={`${h.alias}-${i}`}>
          <div className="secret-row">
            <strong className="mono">{h.alias}</strong>
            <span className="mono">
              {h.user}@{h.hostname}
              {h.port ? `:${h.port}` : ""}
            </span>
            <span className="mono muted">{h.keyName ? h.keyName : "no key"}</span>
            {missingKey(h) && <span className="text-warn small">key not set</span>}
            {results[h.alias] && !dirty && (
              <span className={`small mono ellipsis ${results[h.alias].ok ? "text-ok" : "text-error"}`}>
                {results[h.alias].ok ? "✓ ok" : `✕ ${results[h.alias].detail}`}
              </span>
            )}
            <button
              className="btn btn-sm"
              disabled={dirty || testBusy !== ""}
              title={dirty ? "Save the list first" : `ssh ${h.alias} true`}
              onClick={() => void runTest(h.alias)}
            >
              {testBusy === h.alias ? <Spinner small /> : "Test"}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setEditIdx(i);
                setForm({
                  alias: h.alias,
                  user: h.user,
                  hostname: h.hostname,
                  port: h.port === undefined ? "" : String(h.port),
                  keyName: h.keyName,
                });
              }}
            >
              Edit
            </button>
            <button className="icon-btn" onClick={() => del(i)} aria-label="Remove host">
              ✕
            </button>
          </div>
        </div>
      ))}

      {form && (
        <form
          className="form"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            submitForm();
          }}
        >
          <h4 className="muted small">
            {editIdx === null ? "New host" : `Edit ${saved[editIdx]?.alias ?? ""}`}
          </h4>
          <div className="grid2">
            <label>
              Alias <span className="muted small">the word you say, e.g. media</span>
              <input className="input mono" placeholder="media" value={form.alias} onChange={(e) => setForm({ ...form, alias: e.target.value })} />
            </label>
            <label>
              User
              <input className="input mono" placeholder="ubuntu" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
            </label>
            <label>
              Hostname
              <input className="input mono" placeholder="10.0.0.5 or media.example" value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value })} />
            </label>
            <label>
              Port <span className="muted small">blank = 22</span>
              <input className="input mono" placeholder="22" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
            </label>
          </div>
          <label>
            Key <span className="muted small">one of your keys, or a name for a key you will add later; blank = no key</span>
            <input className="input mono" list="key-names" placeholder="media" value={form.keyName} onChange={(e) => setForm({ ...form, keyName: e.target.value })} />
            <datalist id="key-names">
              {keys.map((k) => (
                <option key={k.name} value={k.name} />
              ))}
            </datalist>
          </label>
          {formError && <div className="alert alert-error">{formError}</div>}
          <div className="row gap end">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setForm(null);
                setEditIdx(null);
              }}
            >
              Cancel
            </button>
            <button className="btn btn-primary">{editIdx === null ? "Add host" : "Update host"}</button>
          </div>
        </form>
      )}

      <div className="row gap between">
        {!form && (
          <button
            className="btn btn-sm"
            onClick={() => {
              setEditIdx(null);
              setForm(EMPTY_HOST);
            }}
          >
            + Add host
          </button>
        )}
        <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? <Spinner small /> : "Save hosts"}
        </button>
      </div>
    </div>
  );
}
