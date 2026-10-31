import { useCallback, useEffect, useRef, useState } from "react";
import { go } from "../App.tsx";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import type { GhIssueSummary, GhIssueWithComments, Repo } from "../types.ts";
import { ago, Empty, Markdown, PageHeader, Spinner } from "../ui.tsx";

function Labels({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <span className="row gap wrap issue-labels">
      {names.map((l) => (
        <span key={l} className="tag">
          {l}
        </span>
      ))}
    </span>
  );
}

/**
 * One repo's open issues. Fetches when the repo or a manual refresh changes;
 * the label/search inputs are read at fetch time and applied by the next refresh
 * (no live polling, no fetch per keystroke).
 */
function IssueList({ repoId, refresh }: { repoId: string; refresh: number }) {
  const [list, setList] = useState<GhIssueSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState({ label: "", q: "" });
  const filters = useRef({ label: "", q: "" });
  filters.current = { label, q };

  const load = useCallback(() => {
    const { label: l, q: s } = filters.current;
    setList(null);
    setError(null);
    const params = new URLSearchParams({ repo: repoId });
    if (l.trim()) params.set("label", l.trim());
    if (s.trim()) params.set("q", s.trim());
    api
      .get<GhIssueSummary[]>(`/api/github/issues?${params.toString()}`)
      .then((r) => {
        setList(r);
        setApplied({ label: l.trim(), q: s.trim() });
      })
      .catch((e) => setError(e.message));
  }, [repoId, refresh]);

  useEffect(load, [load]);

  const stale = label.trim() !== applied.label || q.trim() !== applied.q;

  return (
    <>
      <div className="row gap wrap">
        <input className="input" placeholder="Label filter" title="Applied on the next refresh" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input
          className="input"
          placeholder="Search title, body or #number"
          title="Applied on the next refresh"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {stale && <p className="muted small">Filter changed — hit Refresh to apply it.</p>}
      {error && (
        <div className="alert alert-error">
          {error}
          <PermissionHint />
        </div>
      )}
      {!list && !error && <Spinner />}
      {list && list.length === 0 && (
        <Empty title="No open issues">
          {(applied.label || applied.q) && <p className="muted">Nothing matches the current filter. Clear it and refresh.</p>}
        </Empty>
      )}
      <div className="issue-list">
        {list?.map((i) => (
          <a key={i.number} className="issue-row" href={`#/issues/${encodeURIComponent(repoId)}/${i.number}`}>
            <span className="mono muted issue-num">#{i.number}</span>
            <span className="issue-title ellipsis">{i.title}</span>
            <Labels names={i.labels} />
            <span className="muted small issue-updated" title={i.updatedAt}>
              {ago(Date.parse(i.updatedAt))}
            </span>
          </a>
        ))}
      </div>
    </>
  );
}

function PermissionHint() {
  return (
    <p className="muted small block">
      If the token can’t read issues, add the <code>Issues: read</code> scope to <code>GITHUB_TOKEN</code> on the{" "}
      <a href="#/secrets">Secrets</a> page.
    </p>
  );
}

/** The full issue: markdown body, labels, assignees, up to 100 markdown comments, and a GitHub link. */
function IssueDetail({ repoId, number, refresh }: { repoId: string; number: number; refresh: number }) {
  const { toast } = useStore();
  const [data, setData] = useState<GhIssueWithComments | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const [owner, name] = repoId.split("/");
    setData(null);
    setError(null);
    api
      .get<GhIssueWithComments>(
        `/api/github/issues/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${number}`,
      )
      .then(setData)
      .catch((e) => setError(e.message));
  }, [repoId, number, refresh]);

  useEffect(load, [load]);

  if (error)
    return (
      <div className="alert alert-error">
        {error}
        <PermissionHint />
      </div>
    );
  if (!data) return <Spinner />;

  return (
    <div className="page-narrow issue-detail">
      <a className="muted small" href={`#/issues/${encodeURIComponent(repoId)}`}>
        ← All issues of {repoId}
      </a>
      <div className="card">
        <h2>
          <span className="mono muted">#{data.number}</span> {data.title}
        </h2>
        <div className="row gap wrap">
          <Labels names={data.labels} />
          {data.assignees.map((a) => (
            <span key={a} className="tag">
              @{a}
            </span>
          ))}
        </div>
        <p className="muted small" title={data.updatedAt}>
          Updated {ago(Date.parse(data.updatedAt))}
        </p>
        <div className="row gap">
          <button
            className="btn btn-primary"
            title="Wired up in the next update"
            onClick={() => toast("Starting a session from an issue lands in the next update.")}
          >
            Start session
          </button>
          <a className="btn btn-ghost" href={data.htmlUrl} target="_blank" rel="noopener">
            GitHub ↗
          </a>
        </div>
        {data.body ? <Markdown text={data.body} /> : <p className="muted">No description.</p>}
      </div>
      {data.comments.length > 0 && (
        <section>
          <h3>
            {data.comments.length} comment{data.comments.length === 1 ? "" : "s"}
            {data.comments.length === 100 && <span className="muted small"> (first 100 — the rest on GitHub)</span>}
          </h3>
          {data.comments.map((c) => (
            <div key={c.id} className="comment">
              <div className="row gap">
                <strong>@{c.author}</strong>
                <span className="muted small" title={c.createdAt}>
                  {ago(Date.parse(c.createdAt))}
                </span>
              </div>
              {c.body ? <Markdown text={c.body} /> : <p className="muted">(empty comment)</p>}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

export function Issues({ repoId, number }: { repoId?: string; number?: number }) {
  const { toast } = useStore();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repo, setRepo] = useState(repoId ?? "");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    api
      .get<Repo[]>("/api/repos")
      .then((r) => {
        setRepos(r);
        if (!repoId && r[0]) setRepo(r[0].id);
      })
      .catch((e) => toast(e.message, "error"));
  }, [repoId, toast]);
  useEffect(() => {
    if (repoId) setRepo(repoId);
  }, [repoId]);

  return (
    <div className="page">
      <PageHeader title="Issues" sub="Open issues of your tracked repos. Pick a repo, filter, and click one to read it.">
        <select
          className="input issue-repo"
          value={repo}
          onChange={(e) => {
            setRepo(e.target.value);
            go(`#/issues/${encodeURIComponent(e.target.value)}`);
          }}
        >
          {(repos ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.id}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!repo || !repos} onClick={() => setRefresh((r) => r + 1)}>
          Refresh
        </button>
      </PageHeader>
      {number !== undefined && repoId ? (
        <IssueDetail key={`${repoId}-${number}`} repoId={repoId} number={number} refresh={refresh} />
      ) : repo ? (
        <IssueList key={repo} repoId={repo} refresh={refresh} />
      ) : !repos ? (
        <Spinner />
      ) : (
        <Empty title="Add a repository first">
          <a className="btn btn-primary" href="#/repos">
            Go to Repositories
          </a>
        </Empty>
      )}
    </div>
  );
}
