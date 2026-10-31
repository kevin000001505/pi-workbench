import { config } from "./config.ts";

export type GhUser = { login: string; id: number; name: string | null };
export type GhRepo = {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  description: string | null;
  pushed_at: string | null;
  html_url: string;
};
export type GhIssueSummary = {
  number: number;
  title: string;
  labels: string[];
  updatedAt: string;
  htmlUrl: string;
};
export type GhIssueDetail = GhIssueSummary & { body: string | null; assignees: string[] };
export type GhIssueComment = { id: number; author: string; body: string | null; createdAt: string };

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Minimal GitHub REST client over a personal access token. */
export class GitHub {
  private token: string;
  constructor(token: string | undefined) {
    if (!token) throw new GitHubError(400, "Add a GITHUB_TOKEN secret (fine-grained PAT) on the Secrets page first");
    this.token = token;
  }

  private async req<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url.startsWith("http") ? url : `${config.githubApi}${url}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pi-workbench",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const j = (await res.json()) as { message?: string; errors?: { message?: string }[] };
        msg = [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join(": ");
      } catch {}
      throw new GitHubError(res.status, `GitHub ${method} ${url.replace(config.githubApi, "")}: ${res.status} ${msg}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  user() {
    return this.req<GhUser>("GET", "/user");
  }

  listRepos() {
    return this.req<GhRepo[]>("GET", "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member");
  }

  getRepo(owner: string, name: string) {
    return this.req<GhRepo>("GET", `/repos/${owner}/${name}`);
  }

  /**
   * One page (up to 100) of the repo's open issues; pull requests in the feed are filtered out.
   * `label` matches a label name case-insensitively; `q` is a case-insensitive substring over
   * title, body and issue number. Results are capped at 30.
   */
  listIssues(owner: string, name: string, opts: { label?: string; q?: string } = {}) {
    type Raw = {
      number: number;
      title: string;
      body: string | null;
      labels: { name: string }[];
      updated_at: string;
      html_url: string;
      pull_request?: unknown;
    };
    const query = opts.q?.toLowerCase();
    return this.req<Raw[]>("GET", `/repos/${owner}/${name}/issues?state=open&per_page=100`).then((feed) =>
      feed
        .filter((i) => !("pull_request" in i))
        .filter((i) => !opts.label || i.labels.some((l) => l.name.toLowerCase() === opts.label!.toLowerCase()))
        .filter(
          (i) =>
            !query ||
            i.title.toLowerCase().includes(query) ||
            (i.body ?? "").toLowerCase().includes(query) ||
            String(i.number).includes(query),
        )
        .slice(0, 30)
        .map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((l) => l.name), updatedAt: i.updated_at, htmlUrl: i.html_url })),
    );
  }

  createRepo(input: { name: string; description?: string; private: boolean; org?: string }) {
    const body = { name: input.name, description: input.description ?? "", private: input.private, auto_init: true };
    return this.req<GhRepo>("POST", input.org ? `/orgs/${input.org}/repos` : "/user/repos", body);
  }

  createPull(owner: string, name: string, input: { title: string; body: string; head: string; base: string; draft?: boolean }) {
    return this.req<{ number: number; html_url: string }>("POST", `/repos/${owner}/${name}/pulls`, input);
  }

  /** One issue's detail: body, label names, assignee logins and updated time. */
  getIssue(owner: string, name: string, number: number) {
    type Raw = {
      number: number;
      title: string;
      body: string | null;
      labels: { name: string }[];
      assignees: { login: string }[];
      updated_at: string;
      html_url: string;
    };
    return this.req<Raw>("GET", `/repos/${owner}/${name}/issues/${number}`).then((i) => ({
      number: i.number,
      title: i.title,
      body: i.body,
      labels: i.labels.map((l) => l.name),
      assignees: i.assignees.map((a) => a.login),
      updatedAt: i.updated_at,
      htmlUrl: i.html_url,
    }));
  }

  /** One page of an issue's comments, capped at 100. */
  listIssueComments(owner: string, name: string, number: number) {
    type Raw = {
      id: number;
      user: { login: string };
      body: string | null;
      created_at: string;
    };
    return this.req<Raw[]>("GET", `/repos/${owner}/${name}/issues/${number}/comments?per_page=100`).then((all) =>
      all.slice(0, 100).map((c) => ({ id: c.id, author: c.user.login, body: c.body, createdAt: c.created_at })),
    );
  }

  async pullStatus(owner: string, name: string, number: number) {
    const pr = await this.req<{
      state: string;
      merged: boolean;
      draft: boolean;
      mergeable_state: string;
      html_url: string;
      head: { sha: string };
      comments: number;
      review_comments: number;
    }>("GET", `/repos/${owner}/${name}/pulls/${number}`);
    const runs = await this.req<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>(
      "GET",
      `/repos/${owner}/${name}/commits/${pr.head.sha}/check-runs?per_page=100`,
    ).catch(() => ({ check_runs: [] }));
    const checks = { total: runs.check_runs.length, pending: 0, failed: 0, passed: 0 };
    for (const r of runs.check_runs) {
      if (r.status !== "completed") checks.pending++;
      else if (["success", "neutral", "skipped"].includes(r.conclusion ?? "")) checks.passed++;
      else checks.failed++;
    }
    return {
      state: pr.merged ? "merged" : pr.state,
      draft: pr.draft,
      mergeableState: pr.mergeable_state,
      url: pr.html_url,
      comments: pr.comments + pr.review_comments,
      checks,
    };
  }
}
