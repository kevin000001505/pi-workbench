import type { RepoRow, SessionRow } from "./db.ts";
import { git, type GitEnv } from "./git.ts";
import type { GitHub } from "./github.ts";
import { complete } from "./llm.ts";
import { worktreeStatus } from "./repos.ts";
import type { ModelSettings } from "./settings.ts";

const MAX_DIFF = 80_000;

const SYSTEM = `You write GitHub pull request descriptions. Reply with only a JSON object: {"title": "...", "body": "..."}.
The title is imperative, under 70 characters. The body is Markdown: a "## Summary" of what changed and why (bullets),
then "## Testing" with how it was or can be verified. Do not invent changes that are not in the diff.`;

export async function changes(row: SessionRow, env: GitEnv) {
  await git(row.worktree, ["fetch", "origin", row.base_branch], env).catch(() => {});
  const range = `origin/${row.base_branch}...HEAD`;
  const [log, committed, uncommitted, status] = await Promise.all([
    git(row.worktree, ["log", "--format=- %s", `origin/${row.base_branch}..HEAD`]).catch(() => ""),
    git(row.worktree, ["diff", range]).catch(() => ""),
    git(row.worktree, ["diff", "HEAD"]).catch(() => ""),
    worktreeStatus(row.worktree, row.base_branch),
  ]);
  return { log: log.trim(), committed, uncommitted, ...status };
}

/** Ask the configured model for a title and body; fall back to the session title and commit list. */
export async function draftPr(row: SessionRow, env: GitEnv, model: ModelSettings, apiKey: string | undefined) {
  const c = await changes(row, env);
  const fallback = { title: row.title, body: `## Summary\n\n${c.log || "- (no commits yet)"}\n` };
  const diff = `${c.committed}\n${c.uncommitted}`.trim();
  if (!diff) return { ...fallback, drafted: false, error: "No changes against the base branch yet", ...c };
  try {
    const text = await complete(
      model,
      apiKey,
      SYSTEM,
      `Session task: ${row.title}\n\nCommits:\n${c.log || "(none, changes are uncommitted)"}\n\nDiff:\n${diff.slice(0, MAX_DIFF)}${diff.length > MAX_DIFF ? "\n[diff truncated]" : ""}`,
    );
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (typeof json.title !== "string" || typeof json.body !== "string") throw new Error("model reply had no title/body");
    return { title: json.title.trim(), body: json.body.trim(), drafted: true, error: null, ...c };
  } catch (err) {
    return { ...fallback, drafted: false, error: `Draft failed: ${(err as Error).message}`, ...c };
  }
}

export async function openPr(
  row: SessionRow,
  repo: RepoRow,
  gh: GitHub,
  env: GitEnv,
  input: { title: string; body: string; commitMessage?: string; draft?: boolean },
) {
  if (!input.title.trim()) throw new Error("A PR title is required");
  let status = await worktreeStatus(row.worktree, row.base_branch);
  if (status.dirty && input.commitMessage?.trim()) {
    await git(row.worktree, ["add", "-A"], env);
    await git(row.worktree, ["commit", "-m", input.commitMessage.trim()], env);
    status = await worktreeStatus(row.worktree, row.base_branch);
  }
  if (status.ahead === 0) throw new Error(`No commits on ${row.branch} beyond ${row.base_branch}; nothing to open a PR with`);
  await git(row.worktree, ["push", "-u", "origin", `HEAD:refs/heads/${row.branch}`], env);
  return gh.createPull(repo.owner, repo.name, {
    title: input.title.trim(),
    body: input.body,
    head: row.branch,
    base: row.base_branch,
    draft: !!input.draft,
  });
}
