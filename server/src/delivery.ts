import type { RepoRow, SessionRow } from "./db.ts";
import { git, type GitEnv } from "./git.ts";
import { GitHubError, type GitHub } from "./github.ts";
import type { Ticket } from "./pipeline.ts";
import { draftPr, openPr } from "./prs.ts";
import type { ModelSettings } from "./settings.ts";

/**
 * How a card's work reaches GitHub. `SessionManager` gets one from main.ts, so it holds no
 * GitHub client and no model settings itself. It opens the PR, merges it, deletes the branch
 * and closes the issues, or closes the PR unmerged when a card is abandoned.
 */
export type Delivery = {
  /**
   * Push the branch and open its PR, with the `Closes` lines for the ticket and origin issues.
   * A session that has a PR already pushes to it and opens no second one.
   */
  openPr(row: SessionRow, repo: RepoRow, tickets: Ticket[]): Promise<{ number: number; url: string }>;
  /**
   * Merge the session's PR with a merge commit. A merge conflict resolves to `{ conflict }`; any
   * other refusal (branch protection, red required checks) throws with GitHub's message.
   * A PR that is merged already counts as merged.
   */
  merge(row: SessionRow, repo: RepoRow): Promise<MergeResult>;
  /** Close the session's PR without merging it. */
  closePr(row: SessionRow, repo: RepoRow): Promise<void>;
  /** Delete the session's branch on GitHub. A branch that was never pushed counts as deleted. */
  deleteBranch(row: SessionRow, repo: RepoRow): Promise<void>;
  /** Close these issues of the repo (the card's own repo, or another repo its refs name). */
  closeIssues(repo: Pick<RepoRow, "owner" | "name">, numbers: number[]): Promise<void>;
  /** One issue's title and URL, for the board's Done cards; null when the issue cannot be read. */
  issueInfo(repo: Pick<RepoRow, "owner" | "name">, number: number): Promise<{ title: string; url: string } | null>;
};

export type MergeResult = { merged: true } | { conflict: string };

export type DeliveryDeps = {
  github: () => GitHub;
  gitEnv: () => Promise<GitEnv>;
  model: () => ModelSettings;
  llmKey: () => string | undefined;
};

export function githubDelivery(deps: DeliveryDeps): Delivery {
  return {
    async openPr(row, repo, tickets) {
      const env = await deps.gitEnv();
      // A card that already has its PR (a review run again after a move back): push to it.
      if (row.pr_number && row.pr_url) {
        await git(row.worktree, ["push", "-u", "origin", `HEAD:refs/heads/${row.branch}`], env);
        return { number: row.pr_number, url: row.pr_url };
      }
      const draft = await draftPr(row, env, deps.model(), deps.llmKey(), tickets);
      const pr = await openPr(row, repo, deps.github(), env, { title: draft.title, body: draft.body });
      return { number: pr.number, url: pr.html_url };
    },

    async merge(row, repo) {
      if (!row.pr_number) throw new Error("this card has no PR");
      const gh = deps.github();
      const conflict = async () => {
        const status = await gh.pullStatus(repo.owner, repo.name, row.pr_number!);
        if (status.state === "merged") return { merged: true } as const;
        return status.mergeableState === "dirty" ? { conflict: `PR #${row.pr_number} has a merge conflict with ${row.base_branch}` } : null;
      };
      try {
        await gh.mergePull(repo.owner, repo.name, row.pr_number);
        return { merged: true };
      } catch (err) {
        // GitHub answers a conflict, a protection rule and a merged PR with the same 405: ask the PR which it was.
        if (err instanceof GitHubError && (err.status === 405 || err.status === 409)) {
          const after = await conflict().catch(() => null);
          if (after) return after;
        }
        throw err;
      }
    },

    async closePr(row, repo) {
      if (!row.pr_number) return;
      await deps.github().closePull(repo.owner, repo.name, row.pr_number);
    },

    async deleteBranch(row, repo) {
      try {
        await deps.github().deleteBranch(repo.owner, repo.name, row.branch);
      } catch (err) {
        // 422 "Reference does not exist": the branch was never pushed, or is gone already.
        if (!(err instanceof GitHubError && err.status === 422)) throw err;
      }
    },

    async closeIssues(repo, numbers) {
      const gh = deps.github();
      for (const n of numbers) await gh.closeIssue(repo.owner, repo.name, n);
    },

    async issueInfo(repo, number) {
      try {
        const issue = await deps.github().getIssue(repo.owner, repo.name, number);
        return { title: issue.title, url: issue.htmlUrl };
      } catch {
        return null;
      }
    },
  };
}
