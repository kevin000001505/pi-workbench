import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { notificationsEnabled, setNotifications, useStore } from "../store.tsx";
import type { ApprovalRule, ApprovalSettings, AutoApproveSettings, ModelSettings, ProbeResult } from "../types.ts";
import { PageHeader, Spinner } from "../ui.tsx";

const THINKING_FORMATS = ["", "qwen-chat-template", "qwen", "chat-template", "openai", "deepseek"];

function ModelForm() {
  const { toast } = useStore();
  const [m, setM] = useState<ModelSettings | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [probe, setProbe] = useState<string | null>(null);
  const [test, setTest] = useState<ProbeResult | "running" | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ model: ModelSettings }>("/api/settings").then((s) => setM(s.model)).catch((e) => toast(e.message, "error"));
  }, [toast]);

  const fetchModels = async (baseUrl: string) => {
    setProbe("Checking…");
    try {
      const ids = await api.get<string[]>(`/api/models?baseUrl=${encodeURIComponent(baseUrl)}`);
      setModels(ids);
      setProbe(`${ids.length} model${ids.length === 1 ? "" : "s"} at this endpoint`);
    } catch (e) {
      setModels(null);
      setProbe(`Unreachable: ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    if (m) void fetchModels(m.baseUrl);
    // Probe once on load; afterwards on demand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m === null]);

  /** Calls the endpoint the way a session does, and shows which step fails and why. */
  const runTest = async () => {
    if (!m) return;
    setTest("running");
    try {
      const r = await api.post<ProbeResult>("/api/models/test", { baseUrl: m.baseUrl, modelId: m.modelId });
      setTest(r);
      if (r.models.length) setModels(r.models);
    } catch (e) {
      setTest(null);
      toast((e as Error).message, "error");
    }
  };

  if (!m) return <Spinner />;
  const set = <K extends keyof ModelSettings>(k: K, v: ModelSettings[K]) => setM({ ...m, [k]: v });

  return (
    <form
      className="card form"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          setM(await api.put<ModelSettings>("/api/settings/model", m));
          toast("Model settings saved. New and resumed sessions use them.");
        } catch (err) {
          toast((err as Error).message, "error");
        } finally {
          setSaving(false);
        }
      }}
    >
      <h3>Model</h3>
      <label>
        OpenAI-compatible base URL
        <div className="row gap">
          <input className="input mono grow" value={m.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} />
          <button type="button" className="btn btn-sm" disabled={test === "running"} onClick={runTest}>
            {test === "running" ? <Spinner small /> : null} Test
          </button>
        </div>
        {probe && !test && <span className={`small ${probe.startsWith("Unreachable") ? "text-error" : "muted"}`}>{probe}</span>}
      </label>
      {test === "running" && <p className="muted small">Calling the model; the first call can take a while if llama-swap has to load it…</p>}
      {test && test !== "running" && (
        <div className={`probe ${test.ok ? "probe-ok" : "probe-fail"}`}>
          {test.checks.map((c) => (
            <div key={c.name} className="probe-check">
              <div className="row gap">
                <span className={c.ok ? "text-ok" : "text-error"}>{c.ok ? "✓" : "✕"}</span>
                <strong>{c.name === "Chat" ? `Chat with ${m.modelId}` : "List models"}</strong>
                <span className="mono small muted ellipsis grow">
                  {c.name === "Chat" ? "POST" : "GET"} {c.url}
                </span>
                <span className="mono small muted">
                  {c.status ? `HTTP ${c.status}` : "no reply"} · {(c.ms / 1000).toFixed(1)}s
                </span>
              </div>
              {c.hint && <p className="probe-hint">{c.hint}</p>}
              {!c.ok && c.excerpt && <pre className="code probe-excerpt">{c.excerpt}</pre>}
            </div>
          ))}
          {test.ok && <p className="small text-ok">Sessions can reach this model.</p>}
        </div>
      )}
      <div className="grid2">
        <label>
          Model ID
          <input className="input mono" list="model-ids" value={m.modelId} onChange={(e) => set("modelId", e.target.value)} />
          <datalist id="model-ids">{models?.map((id) => <option key={id} value={id} />)}</datalist>
          {models && !models.includes(m.modelId) && <span className="small text-warn">Not in this endpoint’s model list.</span>}
        </label>
        <label>
          Context window (tokens)
          <input className="input mono" type="number" min={1024} value={m.contextWindow} onChange={(e) => set("contextWindow", Number(e.target.value))} />
          <span className="muted small">{Math.round(m.contextWindow / 1024)}K · pi compacts before it fills</span>
        </label>
        <label>
          Max output tokens
          <input className="input mono" type="number" min={256} value={m.maxTokens} onChange={(e) => set("maxTokens", Number(e.target.value))} />
        </label>
        <label>
          Thinking parameters
          <select className="input" value={m.thinkingFormat} onChange={(e) => set("thinkingFormat", e.target.value)} disabled={!m.reasoning}>
            {THINKING_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f || "auto-detect"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={m.reasoning} onChange={(e) => set("reasoning", e.target.checked)} /> Reasoning model (send thinking
        controls)
      </label>
      <div className="row end">
        <button className="btn btn-primary" disabled={saving}>
          Save model
        </button>
      </div>
    </form>
  );
}

function RulesForm() {
  const { toast } = useStore();
  const [a, setA] = useState<ApprovalSettings | null>(null);
  const [test, setTest] = useState("");
  useEffect(() => {
    api.get<{ approval: ApprovalSettings }>("/api/settings").then((s) => setA(s.approval)).catch((e) => toast(e.message, "error"));
  }, [toast]);
  if (!a) return <Spinner />;
  const setRule = (i: number, patch: Partial<ApprovalRule>) => setA({ ...a, rules: a.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const matches = (r: ApprovalRule) => {
    if (!test || !r.enabled) return false;
    try {
      return new RegExp(r.pattern, "i").test(test);
    } catch {
      return false;
    }
  };

  return (
    <form
      className="card form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          setA(await api.put<ApprovalSettings>("/api/settings/approval", a));
          toast("Approval rules saved. Running sessions pick them up on their next tool call.");
        } catch (err) {
          toast((err as Error).message, "error");
        }
      }}
    >
      <h3>Ask before…</h3>
      <p className="muted small">
        Tool calls matching an enabled rule wait for your Allow / Deny. Patterns are case-insensitive regexes, tested against the bash
        command (or the tool’s JSON input). Everything else runs freely inside the session’s worktree.
      </p>
      <input className="input mono" placeholder="Try a command, e.g. git push origin main" value={test} onChange={(e) => setTest(e.target.value)} />
      <div className="rules">
        {a.rules.map((r, i) => (
          <div key={r.id || i} className={`rule ${matches(r) ? "rule-hit" : ""}`}>
            <input type="checkbox" checked={r.enabled} onChange={(e) => setRule(i, { enabled: e.target.checked })} title="Enabled" />
            <input className="input rule-label" value={r.label} onChange={(e) => setRule(i, { label: e.target.value })} />
            <input className="input mono rule-tool" value={r.tool} onChange={(e) => setRule(i, { tool: e.target.value })} title="Tool (bash, write, edit, * …)" />
            <input className="input mono rule-pattern" value={r.pattern} onChange={(e) => setRule(i, { pattern: e.target.value })} />
            <button type="button" className="icon-btn" onClick={() => setA({ ...a, rules: a.rules.filter((_, j) => j !== i) })} aria-label="Remove">
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="row gap between">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setA({ ...a, rules: [...a.rules, { id: "", tool: "bash", pattern: "", label: "", enabled: true }] })}
        >
          + Add rule
        </button>
        <label className="check">
          <input type="checkbox" checked={a.outsideWorktree} onChange={(e) => setA({ ...a, outsideWorktree: e.target.checked })} /> Ask before
          writing outside the worktree
        </label>
      </div>
      <div className="row end">
        <button className="btn btn-primary">Save rules</button>
      </div>
    </form>
  );
}

function AutoApproveForm() {
  const { toast } = useStore();
  const [a, setA] = useState<AutoApproveSettings | null>(null);
  const [token, setToken] = useState("");
  const [test, setTest] = useState<{ ok: boolean; message: string } | "running" | null>(null);
  useEffect(() => {
    api.get<{ autoApprove: AutoApproveSettings }>("/api/settings").then((s) => setA(s.autoApprove)).catch((e) => toast(e.message, "error"));
  }, [toast]);
  if (!a) return <Spinner />;
  const setJudge = (patch: Partial<AutoApproveSettings["judge"]>) => setA({ ...a, judge: { ...a.judge, ...patch } });

  const saveToken = async (value: string | null) => {
    try {
      setA(await api.put<AutoApproveSettings>("/api/settings/auto-approve/keys", { key: "jevToken", value }));
      setToken("");
      toast(value ? "Jev token saved." : "Jev token removed.");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const runTest = async () => {
    setTest("running");
    try {
      setTest(await api.post<{ ok: boolean; message: string }>("/api/settings/auto-approve/test", {}));
    } catch (e) {
      setTest(null);
      toast((e as Error).message, "error");
    }
  };

  return (
    <form
      className="card form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          setA(await api.put<AutoApproveSettings>("/api/settings/auto-approve", { enabled: a.enabled, judge: a.judge }));
          toast("Auto-approve saved. It applies to the next permission.");
        } catch (err) {
          toast((err as Error).message, "error");
        }
      }}
    >
      <h3>Auto-approve</h3>
      <p className="muted small">
        Permissions go to the risk judge first. A call it rates safe runs without you; any other call, or a judge failure, waits
        for you with the judge’s note. Decisions (questions the agent asks you) always come to you.
      </p>
      <label className="check">
        <input type="checkbox" checked={a.enabled} onChange={(e) => setA({ ...a, enabled: e.target.checked })} /> Auto-approve
        permissions in every session
      </label>
      <label>
        Jev base URL
        <div className="row gap">
          <input className="input mono grow" value={a.judge.jevBaseUrl} onChange={(e) => setJudge({ jevBaseUrl: e.target.value })} />
          <button type="button" className="btn btn-sm" disabled={test === "running"} onClick={runTest} title="Tests the saved URL and token">
            {test === "running" ? <Spinner small /> : null} Test
          </button>
        </div>
        {test && test !== "running" && <span className={`small ${test.ok ? "muted" : "text-error"}`}>{test.message}</span>}
      </label>
      <label>
        Jev token {a.keys.jevToken ? <span className="tag tag-ok">set</span> : <span className="tag tag-warn">not set</span>}
        <div className="row gap">
          <input
            className="input mono grow"
            type="password"
            autoComplete="off"
            placeholder={a.keys.jevToken ? "Enter a new token to replace it" : "TypeSafe API key"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="button" className="btn btn-sm" disabled={!token.trim()} onClick={() => saveToken(token.trim())}>
            Save token
          </button>
          {a.keys.jevToken && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => saveToken(null)}>
              Remove
            </button>
          )}
        </div>
        <span className="muted small">Stored encrypted and never shown again. It is never given to the agent.</span>
      </label>
      <label>
        Safe threshold
        <input
          className="input mono"
          type="number"
          min={0.01}
          max={1}
          step={0.01}
          value={a.judge.safeThreshold}
          onChange={(e) => setJudge({ safeThreshold: Number(e.target.value) })}
        />
        <span className="muted small">A call runs without you only when Jev’s P(safe) is at least this value.</span>
      </label>
      <div className="row end">
        <button className="btn btn-primary">Save auto-approve</button>
      </div>
    </form>
  );
}

function NotificationsCard() {
  const [on, setOn] = useState(notificationsEnabled());
  const supported = "Notification" in window;
  return (
    <div className="card form">
      <h3>Notifications</h3>
      <p className="muted small">
        A desktop notification when a session needs a permission or decision while this tab is in the background.
      </p>
      {!supported ? (
        <p className="text-warn small">This browser has no notification support (or the page is not on HTTPS/localhost).</p>
      ) : (
        <label className="check">
          <input
            type="checkbox"
            checked={on}
            onChange={async (e) => {
              if (e.target.checked && Notification.permission !== "granted") await Notification.requestPermission();
              setNotifications(e.target.checked);
              setOn(notificationsEnabled());
            }}
          />
          Enabled {supported && Notification.permission === "denied" && <span className="text-warn small">(blocked in browser settings)</span>}
        </label>
      )}
    </div>
  );
}

export function Settings() {
  return (
    <div className="page page-narrow">
      <PageHeader title="Settings" />
      <ModelForm />
      <RulesForm />
      <AutoApproveForm />
      <NotificationsCard />
    </div>
  );
}
