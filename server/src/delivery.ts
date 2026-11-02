import type { RepoRow, SessionRow } from "./db.ts";
import { git, type GitEnv } from "./git.ts";
import type { GitHub } from "./github.ts";
import type { Ticket } from "./pipeline.ts";
import { draftPr, openPr } from "./prs.ts";
import type { ModelSettings } from "./settings.ts";

/**
 * How a card's work reaches GitHub. `SessionManager` gets one from main.ts, so it holds no
 * GitHub client and no model settings itself. Today it opens the PR; merge, close the PR,
 * delete the branch and close the issues join it later.
 */
export type Delivery = {
  /**
   * Push the branch and open its PR, with the `Closes` lines for the ticket and origin issues.
   * A session that has a PR already pushes to it and opens no second one.
   */
  openPr(row: SessionRow, repo: RepoRow, tickets: Ticket[]): Promise<{ number: number; url: string }>;
};

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
  };
}
