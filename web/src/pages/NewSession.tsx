import { useEffect, useState } from "react";
import { go } from "../App.tsx";
import { api } from "../api.ts";
import { SkillPicker, useSkills } from "../session/Composer.tsx";
import { useStore } from "../store.tsx";
import type { Repo, SessionSummary, Skill } from "../types.ts";
import { Empty, PageHeader, Spinner, issueUrl, parseIssueRef } from "../ui.tsx";

export function NewSession({
  repoId,
  issueRef,
  prefillTitle,
  prefillPrompt,
  prefillBase,
}: {
  repoId?: string;
  /** `owner/name#123`; pre-fills the form for that issue and locks the repo to it. */
  issueRef?: string;
  prefillTitle?: string;
  prefillPrompt?: string;
  prefillBase?: string;
}) {
  const { toast, upsert } = useStore();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const fromIssue = parseIssueRef(issueRef); // the origin issue's repo id + number, or null
  const [repo, setRepo] = useState(fromIssue?.repoId ?? repoId ?? "");
  const [base, setBase] = useState(prefillBase ?? "");
  const [title, setTitle] = useState(prefillTitle ?? "");
  const [prompt, setPrompt] = useState(prefillPrompt ?? "");
  const [picker, setPicker] = useState(false);
  const [mode, setMode] = useState<"pipeline" | "direct">("pipeline");
  const [creating, setCreating] = useState(false);
  const skills = useSkills();

  useEffect(() => {
    api
      .get<Repo[]>("/api/repos")
      .then((r) => {
        setRepos(r);
        if (!repo && r[0]) setRepo(r[0].id);
      })
      .catch((e) => toast(e.message, "error"));
  }, [repoId, toast]);

  const selected = repos?.find((r) => r.id === repo);

  const create = async () => {
    setCreating(true);
    try {
      const s = await api.post<SessionSummary>("/api/sessions", {
        repoId: repo,
        title,
        baseBranch: base || undefined,
        prompt,
        mode,
        issueRef: fromIssue ? issueRef : undefined,
      });
      upsert(s);
      go(`#/session/${s.id}`);
    } catch (e) {
      toast((e as Error).message, "error");
      setCreating(false);
    }
  };

  if (repos && repos.length === 0) {
    return (
      <div className="page">
        <Empty title="Add a repository first">
          <a className="btn btn-primary" href="#/repos">
            Go to Repositories
          </a>
        </Empty>
      </div>
    );
  }

  return (
    <div className="page page-narrow">
      <PageHeader title="New session" sub="Each session works in its own git worktree and branch, so sessions can run side by side." />
      {!repos ? (
        <Spinner />
      ) : (
        <div className="form card">
          {fromIssue && (
            <div className="alert alert-info">
              Solving{" "}
              <a className="mono" href={issueUrl(issueRef)}>
                {fromIssue.repoId}#{fromIssue.number}
              </a>
              {" "}
              — the repository is locked to it.
            </div>
          )}
          <div className="grid2">
            <label>
              Repository
              <select className="input" value={repo} disabled={!!fromIssue} onChange={(e) => setRepo(e.target.value)}>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Base branch
              <input className="input mono" placeholder={selected?.defaultBranch ?? "main"} value={base} onChange={(e) => setBase(e.target.value)} />
            </label>
          </div>
          <div className="mode-pick" role="radiogroup" aria-label="How to work">
            <button type="button" role="radio" aria-checked={mode === "pipeline"} className={`mode ${mode === "pipeline" ? "on" : ""}`} onClick={() => setMode("pipeline")}>
              <strong>Pipeline</strong>
              <span className="muted small">grill-with-docs → to-spec → to-tickets → build each ticket test-first → one code review. You approve the plan, the spec’s test seams and the tickets; the rest runs on its own.</span>
            </button>
            <button type="button" role="radio" aria-checked={mode === "direct"} className={`mode ${mode === "direct" ? "on" : ""}`} onClick={() => setMode("direct")}>
              <strong>Direct</strong>
              <span className="muted small">Send the task straight to the agent. For small fixes.</span>
            </button>
          </div>
          {selected?.needsSetup && (
            <div className="alert alert-info">
              This repo hasn’t been set up for Matt Pocock’s skills yet. The session runs <code>/setup-matt-pocock-skills</code> first and
              asks you its questions; your task goes out right after.
            </div>
          )}
          <label>
            Title <span className="muted small">(optional)</span>
            <input className="input" placeholder="Taken from the first line of the task" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="rel">
            {mode === "pipeline" ? "What do you want built?" : "Task"}
            {picker && (
              <SkillPicker
                skills={skills}
                query=""
                onPick={(s: Skill) => {
                  setPrompt(`/skill:${s.name} ${prompt}`);
                  setPicker(false);
                }}
                onClose={() => setPicker(false)}
              />
            )}
            <textarea
              className="input"
              rows={8}
              placeholder={mode === "pipeline" ? "Describe the feature or change, e.g. an API that tracks member points. grill-with-docs will question you until every detail is agreed." : "What should the agent do?"}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && repo) void create();
              }}
            />
          </label>
          <div className="row gap between">
            {mode === "direct" ? (
              <button className="btn btn-ghost btn-sm" onClick={() => setPicker((p) => !p)}>
                ✦ Start with a skill
              </button>
            ) : (
              <span />
            )}
            <button className="btn btn-primary" disabled={!repo || creating || (mode === "pipeline" && !prompt.trim())} onClick={create}>
              {creating ? (
                <>
                  <Spinner small /> Creating worktree…
                </>
              ) : (
                "Start session"
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
