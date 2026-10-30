import fs from "node:fs";
import path from "node:path";
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
  const [log, committed, tracked, untracked, status] = await Promise.all([
    git(row.worktree, ["log", "--format=- %s", `origin/${row.base_branch}..HEAD`]).catch(() => ""),
    git(row.worktree, ["diff", range]).catch(() => ""),
    git(row.worktree, ["diff", "HEAD"]).catch(() => ""),
    git(row.worktree, ["ls-files", "--others", "--exclude-standard", "-z"]).catch(() => ""),
    worktreeStatus(row.worktree, row.base_branch),
  ]);
  const added = untracked.split("\0").filter(Boolean).slice(0, 100).map((f) => newFileDiff(row.worktree, f));
  return { log: log.trim(), committed, uncommitted: [tracked, ...added].filter(Boolean).join("\n"), ...status };
}

/** `git diff HEAD` leaves out untracked files; render them as additions. */
function newFileDiff(root: string, file: string) {
  const header = `diff --git a/${file} b/${file}\nnew file\n--- /dev/null\n+++ b/${file}\n`;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(path.join(root, file));
  } catch {
    return `${header}(unreadable)`;
  }
  if (buf.includes(0)) return `${header}Binary file`;
  if (buf.length > 200_000) return `${header}(${buf.length} bytes, not shown)`;
  const lines = buf.toString("utf8").replace(/\n$/, "").split("\n");
  return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
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
    if (!text.includes("{")) throw new Error("the model's reply had no JSON object");
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
