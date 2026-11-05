import { parseIssueRef, type BoardIssue } from "../../shared/board.ts";
import { type TicketSeed } from "./pipeline.ts";
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

/** The state of one issue and its sub-issues, as the board load's reconcile reads it. */
export type GhIssueState = {
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason: string | null;
  subIssues: { number: number; state: string; stateReason: string | null }[];
};

export class GitHubError extends Error {
  status: number;
  /** GitHub's own message, without the method, path and status; the message when there is none. */
  detail: string;
  constructor(status: number, message: string, detail = message) {
    super(message);
    this.status = status;
    this.detail = detail;
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
      throw new GitHubError(res.status, `GitHub ${method} ${url.replace(config.githubApi, "")}: ${res.status} ${msg}`, msg);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** One GraphQL call, on the same token and host as the REST client. */
  private async gq<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${config.githubApi}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "User-Agent": "pi-workbench", "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const j = (await res.json()) as { data?: T; errors?: { type?: string; message?: string }[]; message?: string };
    if (!res.ok || j.errors?.length) {
      // GitHub's /graphql returns HTTP 200 even when `errors` is populated; never let 200 become GitHubError.status.
      const status = !res.ok ? res.status || 400 : j.errors?.[0]?.type === "NOT_FOUND" ? 404 : 400;
      throw new GitHubError(status, j.errors?.[0]?.message ?? j.message ?? `GraphQL ${res.status} ${res.statusText}`);
    }
    return j.data as T;
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
      sub_issues_summary?: { total: number } | null;
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
        .map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((l) => l.name), updatedAt: i.updated_at, htmlUrl: i.html_url, subIssueTotal: i.sub_issues_summary?.total ?? 0 })),
    );
  }

  /**
   * A spec issue and its open sub-issue tickets. The workbench's one GraphQL call: GitHub's REST
   * API gives no sub-issue list and no dependency edges, only counts. Only open sub-issues come
   * back (closed tickets are already solved), and a ticket's blockedBy keeps only blockers that
   * are open sub-issues of this spec, so a stale edge cannot stall the frontier. `hasParent` is
   * true when the issue is itself a sub-issue of another issue (a ticket issue); the move route
   * refuses such numbers. Cap: 100.
   */
  listTicketSubIssues(owner: string, name: string, number: number): Promise<TicketSeed> {
    type GqIssue = {
      number: number;
      title: string;
      body: string | null;
      url: string;
      parent: { number: number } | null;
      subIssues: {
        nodes: { number: number; title: string; body: string | null; state: string; url: string; blockedBy: { nodes: { number: number; state: string }[] } }[];
      };
    };
    const q = `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issue(number: $number) {
        number title body url parent { number }
        subIssues(first: 100) { nodes { number title body state url blockedBy(first: 100) { nodes { number state } } } }
      } }
    }`;
    return this.gq<{ repository: { issue: GqIssue | null } }>(q, { owner, name, number }).then((d) => {
      const issue = d.repository?.issue;
      if (!issue) throw new GitHubError(404, `No issue ${owner}/${name}#${number} to solve tickets from`);
      const open = issue.subIssues.nodes.filter((n) => n.state === "OPEN");
      const openNumbers = new Set(open.map((n) => n.number));
      return {
        spec: { number: issue.number, title: issue.title, body: issue.body, htmlUrl: issue.url, hasParent: issue.parent !== null },
        subIssues: open.map((n) => ({
          number: n.number,
          title: n.title,
          body: n.body,
          url: n.url,
          blockedBy: n.blockedBy.nodes.filter((b) => openNumbers.has(b.number)).map((b) => b.number),
        })),
      };
    });
  }

  /**
   * The repo's open issues for the board's unclaimed cards, from one GraphQL call: each with its
   * open sub-issue count and its parent, if it is a sub-issue of another issue. Cap: the 100 most
   * recently updated open issues.
   */
  listBoardIssues(owner: string, name: string): Promise<BoardIssue[]> {
    type GqIssue = {
      number: number;
      title: string;
      url: string;
      parent: { number: number } | null;
      subIssuesSummary: { total: number; completed: number } | null;
    };
    const q = `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        issues(first: 100, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { number title url parent { number } subIssuesSummary { total completed } }
        }
      }
    }`;
    return this.gq<{ repository: { issues: { nodes: GqIssue[] } } | null }>(q, { owner, name }).then((d) =>
      (d.repository?.issues.nodes ?? []).map((i) => ({
        number: i.number,
        title: i.title,
        url: i.url,
        openTickets: (i.subIssuesSummary?.total ?? 0) - (i.subIssuesSummary?.completed ?? 0),
        hasParent: i.parent !== null,
      })),
    );
  }

  /** Parse `owner/name#123` (or the issue's URL) and fetch its spec plus ticket sub-issues. */
  async ticketsFromIssueRef(ref: string) {
    const issue = parseIssueRef(ref);
    if (!issue?.repo) throw new GitHubError(400, `Bad issue reference ${ref}; expected owner/name#123`);
    const [owner, name] = issue.repo.split("/");
    return this.listTicketSubIssues(owner, name, issue.number);
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

  /** Merge a PR with a merge commit. GitHub refuses (405) a conflict, red required checks and branch protection. */
  mergePull(owner: string, name: string, number: number) {
    return this.req<{ sha: string; merged: boolean; message: string }>("PUT", `/repos/${owner}/${name}/pulls/${number}/merge`, { merge_method: "merge" });
  }

  /** Close a PR without merging it. */
  closePull(owner: string, name: string, number: number) {
    return this.req<{ number: number; state: string }>("PATCH", `/repos/${owner}/${name}/pulls/${number}`, { state: "closed" });
  }

  /** Delete a branch on GitHub. */
  deleteBranch(owner: string, name: string, branch: string) {
    return this.req<void>("DELETE", `/repos/${owner}/${name}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
  }

  closeIssue(owner: string, name: string, number: number, reason?: string) {
    return this.req<{ number: number; state: string }>("PATCH", `/repos/${owner}/${name}/issues/${number}`, {
      state: "closed",
      ...(reason ? { state_reason: reason } : {}),
    });
  }

  /** One issue's state, with its sub-issues: null when the issue does not resolve or the read fails. */
  issueState(owner: string, name: string, number: number): Promise<GhIssueState | null> {
    type GqIssue = {
      number: number;
      title: string;
      url: string;
      state: string;
      stateReason: string | null;
      subIssues: { nodes: { number: number; state: string; stateReason: string | null }[] };
    };
    const q = `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issue(number: $number) {
        number title url state stateReason
        subIssues(first: 100) { nodes { number state stateReason } }
      } }
    }`;
    return this.gq<{ repository: { issue: GqIssue | null } }>(q, { owner, name, number })
      .then((d) => {
        const i = d.repository?.issue;
        return i
          ? { number: i.number, title: i.title, url: i.url, state: i.state, stateReason: i.stateReason, subIssues: i.subIssues.nodes.map((n) => ({ number: n.number, state: n.state, stateReason: n.stateReason })) }
          : null;
      })
      .catch(() => null);
  }

  /**
   * The state of many issues in one GraphQL call: one aliased `issue(number:)` field per number, the
   * numbers as declared Int variables. GitHub answers a missing issue with an `errors` entry (even
   * when partial data came back) and the client throws on any `errors`, so a batch that cannot
   * resolve every number is retried one read per number; a number whose read fails is null.
   */
  async issueStates(owner: string, name: string, numbers: number[]): Promise<Map<number, GhIssueState | null>> {
    if (!numbers.length) return new Map();
    type GqIssue = {
      number: number;
      title: string;
      url: string;
      state: string;
      stateReason: string | null;
      subIssues: { nodes: { number: number; state: string; stateReason: string | null }[] };
    };
    const toState = (i: GqIssue | null): GhIssueState | null =>
      i
        ? { number: i.number, title: i.title, url: i.url, state: i.state, stateReason: i.stateReason, subIssues: i.subIssues.nodes.map((n) => ({ number: n.number, state: n.state, stateReason: n.stateReason })) }
        : null;
    const q = `query($owner: String!, $name: String!${numbers.map((_, i) => `, $n${i}: Int!`).join("")}) {
      repository(owner: $owner, name: $name) {
${numbers.map((_, i) => `        n${i}: issue(number: $n${i}) { number title url state stateReason subIssues(first: 100) { nodes { number state stateReason } } }`).join("\n")}
      }
    }`;
    const vars: Record<string, unknown> = { owner, name };
    numbers.forEach((n, i) => (vars[`n${i}`] = n));
    try {
      const d = await this.gq<{ repository: Record<string, GqIssue | null> | null }>(q, vars);
      const map = new Map<number, GhIssueState | null>();
      numbers.forEach((n, i) => map.set(n, toState(d.repository?.[`n${i}`] ?? null)));
      return map;
    } catch {
      const map = new Map<number, GhIssueState | null>();
      for (const n of numbers) map.set(n, await this.issueState(owner, name, n));
      return map;
    }
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
