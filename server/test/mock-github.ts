import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

/**
 * Just enough of the GitHub REST API for the workbench, backed by bare repos under `root`
 * (`<root>/<owner>/<name>.git`), so GITHUB_CLONE_BASE=file://<root> clones and pushes work.
 */
export function startMockGitHub(root: string, login = "kevin") {
  const pulls: any[] = [];
  const issues: any[] = []; // repo-scoped: { owner, name, ...issue }; the issues feed carries pull-request entries too
  const comments: any[] = []; // { owner, name, issueNumber, ...comment }
  const subIssueSeeds: Record<string, any> = {}; // `${owner}/${name}#${specNumber}` → { spec, subs } for the /graphql route
  // Every PR head's check runs; a test edits it. A pull whose head conflicts with its base is "dirty", as on
  // GitHub; set its `mergeable_state` to force a state, or its `merge_refusal` to a message for a merge that branch protection refuses.
  const checkRuns: { name: string; status: string; conclusion: string | null }[] = [
    { name: "ci", status: "completed", conclusion: "success" },
    { name: "lint", status: "in_progress", conclusion: null },
  ];
  // Every issue a merge or an issue PATCH closed, in order: `{ ref: "owner/name#n", by: "merge" | "api" }`.
  const closed: { ref: string; by: "merge" | "api" }[] = [];
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  /**
   * A pull's mergeable state: its `mergeable_state` switch when a test set one, else what git says
   * about merging its head into its base (a real conflict is "dirty").
   */
  const mergeableState = (owner: string, name: string, pr: any): string => {
    if (pr.mergeable_state) return pr.mergeable_state;
    if (pr.merged) return "clean";
    try {
      sh(path.join(root, owner, `${name}.git`), "merge-tree", "--write-tree", `refs/heads/${pr.base}`, `refs/heads/${pr.head}`);
      return "clean";
    } catch (err) {
      // merge-tree exits 1 on a conflict; any other failure (a ref is gone) is no conflict.
      return (err as { status?: number }).status === 1 ? "dirty" : "clean";
    }
  };

  const createBare = (owner: string, name: string) => {
    const bare = path.join(root, owner, `${name}.git`);
    const seed = fs.mkdtempSync(path.join(root, ".seed-"));
    sh(seed, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(seed, "README.md"), `# ${name}\n`);
    sh(seed, "add", ".");
    sh(seed, "-c", "user.name=gh", "-c", "user.email=gh@x", "commit", "-qm", "Initial commit");
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    sh(root, "clone", "-q", "--bare", seed, bare);
    fs.rmSync(seed, { recursive: true, force: true });
  };
  const repoJson = (owner: string, name: string) => ({
    full_name: `${owner}/${name}`,
    name,
    owner: { login: owner },
    private: true,
    default_branch: "main",
    description: null,
    pushed_at: new Date().toISOString(),
    html_url: `https://github.com/${owner}/${name}`,
  });
  const listBare = () =>
    fs.existsSync(path.join(root, login))
      ? fs.readdirSync(path.join(root, login)).filter((d) => d.endsWith(".git")).map((d) => repoJson(login, d.slice(0, -4)))
      : [];
  /** A tracked repo's issues; a PR entry sits in the feed, like GitHub's issues API returns. */
  const seedIssues = (owner: string, name: string) => {
    const base = `https://github.com/${owner}/${name}`;
    issues.push(
      {
        owner, name, number: 1, title: "Add dark mode", body: "Support a dark theme for the UI.", state: "open",
        labels: [{ name: "enhancement" }], assignees: [{ login, id: 42, name: "Kevin" }],
        updated_at: "2025-01-03T00:00:00Z", html_url: `${base}/issues/1`,
      },
      {
        owner, name, number: 2, title: "Fix login Crash", body: "The app crashes when the login page is reloaded.", state: "open",
        labels: [{ name: "bug" }], assignees: [], updated_at: "2025-01-02T00:00:00Z", html_url: `${base}/issues/2`,
      },
      {
        owner, name, number: 3, title: "Docs: setup guide", body: "Write a setup guide for fresh installs.", state: "open",
        labels: [{ name: "documentation" }], assignees: [], updated_at: "2025-01-01T00:00:00Z", html_url: `${base}/issues/3`,
      },
      {
        owner, name, number: 9, title: "A pull request, not an issue", body: "This entry carries a pull_request key.", state: "open",
        labels: [], assignees: [], updated_at: "2025-01-04T00:00:00Z", html_url: `${base}/pull/9`,
        pull_request: { url: `${base}/pulls/9` },
      },
    );
    comments.push(
      { owner, name, issueNumber: 1, id: 101, user: { login, id: 42, name: "Kevin" }, body: "I agree, this would be great.", created_at: "2025-01-03T01:00:00Z" },
      { owner, name, issueNumber: 1, id: 102, user: { login: "other", id: 43, name: null }, body: "Anyone working on this?", created_at: "2025-01-03T02:00:00Z" },
    );
  };
  const repoIssues = (owner: string, name: string): any[] | null => {
    if (!fs.existsSync(path.join(root, owner, `${name}.git`))) return null;
    if (!issues.some((i) => i.owner === owner && i.name === name)) seedIssues(owner, name);
    return issues.filter((i) => i.owner === owner && i.name === name);
  };

  const seedSubIssues = (owner: string, name: string, spec: any, subs: any[]) => {
    subIssueSeeds[`${owner}/${name}#${spec.number}`] = { spec, subs };
  };

  /** Close an issue wherever the mock knows it: the issues feed, the sub-issue seeds, and `closed`. */
  const closeIssue = (owner: string, name: string, number: number, by: "merge" | "api") => {
    for (const i of issues) if (i.owner === owner && i.name === name && i.number === number) i.state = "closed";
    for (const [key, seed] of Object.entries(subIssueSeeds)) {
      if (!key.startsWith(`${owner}/${name}#`)) continue;
      if (seed.spec.number === number) seed.spec.state = "CLOSED";
      for (const sub of seed.subs) if (sub.number === number) sub.state = "CLOSED";
    }
    closed.push({ ref: `${owner}/${name}#${number}`, by });
  };

  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, v: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (req.headers.authorization !== "Bearer ghp_test") return send(401, { message: "Bad credentials" });
    const p = url.pathname;
    let m: RegExpExecArray | null;
    if (req.method === "GET" && p === "/user") return send(200, { login, id: 42, name: "Kevin" });
    if (req.method === "GET" && p === "/user/repos") return send(200, listBare());
    if (req.method === "POST" && p === "/user/repos") {
      if (fs.existsSync(path.join(root, login, `${body.name}.git`))) return send(422, { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] });
      createBare(login, body.name);
      return send(201, { ...repoJson(login, body.name), private: body.private });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(p)) && req.method === "GET") {
      return fs.existsSync(path.join(root, m[1], `${m[2]}.git`)) ? send(200, repoJson(m[1], m[2])) : send(404, { message: "Not Found" });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(p)) && req.method === "POST") {
      const bare = path.join(root, m[1], `${m[2]}.git`);
      try {
        sh(bare, "rev-parse", "--verify", `refs/heads/${body.head}`);
      } catch {
        return send(422, { message: "Validation Failed", errors: [{ message: `No commits between main and ${body.head}` }] });
      }
      const pr = { number: pulls.length + 1, html_url: `https://github.com/${m[1]}/${m[2]}/pull/${pulls.length + 1}`, ...body };
      pulls.push(pr);
      return send(201, pr);
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(p)) && req.method === "GET") {
      const all = repoIssues(m[1], m[2]);
      return all ? send(200, all) : send(404, { message: "Not Found" });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(p)) && req.method === "GET") {
      const all = repoIssues(m[1], m[2]);
      if (!all) return send(404, { message: "Not Found" });
      const issue = all.find((i) => i.number === Number(m[3]));
      return issue ? send(200, issue) : send(404, { message: "Not Found" });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(p)) && req.method === "GET") {
      const all = repoIssues(m[1], m[2]);
      if (!all) return send(404, { message: "Not Found" });
      return send(200, comments.filter((c) => c.owner === m[1] && c.name === m[2] && c.issueNumber === Number(m[3])));
    }
    // The workbench's GraphQL calls: an issue's sub-issues and their blockedBy edges, and the repo's open issues with sub-issue counts.
    if (req.method === "POST" && p === "/graphql") {
      // GitHub's GraphQL Issue type has `url`, not REST's `html_url`; reject `html_url` with HTTP 200 + errors like GitHub does.
      if (/\bhtml_url\b/.test(String(body.query ?? ""))) {
        return send(200, { errors: [{ message: "Field 'html_url' doesn't exist on type 'Issue'" }] });
      }
      const { variables } = body;
      // The board's repo-wide query: the open issues with their sub-issue counts.
      if (variables.number === undefined) {
        const all = repoIssues(variables.owner, variables.name);
        if (!all) return send(200, { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] });
        const specs = Object.entries(subIssueSeeds)
          .filter(([k]) => k.startsWith(`${variables.owner}/${variables.name}#`))
          .map(([, seed]) => seed)
          .filter((seed) => (seed.spec.state ?? "OPEN") === "OPEN");
        const nodes = [
          ...all.filter((i) => !i.pull_request && i.state === "open").map((i) => ({ number: i.number, title: i.title, url: i.html_url, subIssuesSummary: { total: 0, completed: 0 } })),
          ...specs.map((seed) => ({
            number: seed.spec.number,
            title: seed.spec.title,
            url: seed.spec.url ?? `https://github.com/${variables.owner}/${variables.name}/issues/${seed.spec.number}`,
            subIssuesSummary: { total: seed.subs.length, completed: seed.subs.filter((x: any) => (x.state ?? "OPEN") !== "OPEN").length },
          })),
        ];
        return send(200, { data: { repository: { issues: { nodes } } } });
      }
      const seed = subIssueSeeds[`${variables.owner}/${variables.name}#${variables.number}`];
      if (!seed) {
        return send(200, {
          data: { repository: { issue: null } },
          errors: [{ type: "NOT_FOUND", message: `Could not resolve to an Issue with the number of ${variables.number}.` }],
        });
      }
      return send(200, {
        data: {
          repository: {
            issue: {
              number: seed.spec.number,
              title: seed.spec.title,
              body: seed.spec.body,
              url: seed.spec.url ?? seed.spec.html_url ?? `https://github.com/${variables.owner}/${variables.name}/issues/${seed.spec.number}`,
              subIssues: {
                nodes: seed.subs.map((s: any) => ({
                  number: s.number,
                  title: s.title,
                  body: s.body,
                  state: s.state ?? "OPEN",
                  blockedBy: { nodes: (s.blockedBy ?? []).map((n: number) => ({ number: n, state: "OPEN" })) },
                })),
              },
            },
          },
        },
      });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(p)) && req.method === "PATCH") {
      if (body.state === "closed") closeIssue(m[1], m[2], Number(m[3]), "api");
      return send(200, { number: Number(m[3]), state: body.state ?? "open" });
    }
    // Merge a PR: a set `merge_refusal` (branch protection) or a "dirty" PR is refused with 405, as GitHub does.
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/.exec(p)) && req.method === "PUT") {
      const pr = pulls[Number(m[3]) - 1];
      if (!pr) return send(404, { message: "Not Found" });
      if (pr.merged) return send(405, { message: "Pull Request is not mergeable" });
      if (pr.merge_refusal) return send(405, { message: pr.merge_refusal });
      if (mergeableState(m[1], m[2], pr) === "dirty") return send(405, { message: "Pull Request is not mergeable" });
      const bare = path.join(root, m[1], `${m[2]}.git`);
      const git = (...args: string[]) => sh(bare, "-c", "user.name=gh", "-c", "user.email=gh@x", ...args).toString().trim();
      const baseSha = git("rev-parse", `refs/heads/${pr.base}`);
      const headSha = git("rev-parse", `refs/heads/${pr.head}`);
      const tree = git("merge-tree", "--write-tree", baseSha, headSha);
      const sha = git("commit-tree", tree, "-p", baseSha, "-p", headSha, "-m", `Merge pull request #${pr.number} from ${pr.head}`);
      git("update-ref", `refs/heads/${pr.base}`, sha);
      Object.assign(pr, { merged: true, merge_method: body.merge_method ?? "merge", merge_sha: sha });
      // GitHub honours `Closes #n` only on a merge into the default branch.
      if (pr.base === repoJson(m[1], m[2]).default_branch) {
        for (const c of String(pr.body ?? "").matchAll(/Closes #(\d+)/g)) closeIssue(m[1], m[2], Number(c[1]), "merge");
      }
      return send(200, { sha, merged: true, message: "Pull Request successfully merged" });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/.exec(p)) && req.method === "DELETE") {
      const bare = path.join(root, m[1], `${m[2]}.git`);
      try {
        sh(bare, "rev-parse", "--verify", `refs/heads/${m[3]}`);
      } catch {
        return send(422, { message: "Reference does not exist" });
      }
      sh(bare, "update-ref", "-d", `refs/heads/${m[3]}`);
      res.writeHead(204);
      return res.end();
    }
    // Close (or reopen) a PR: `state` on the pull records it.
    if ((m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(p)) && req.method === "PATCH") {
      const pr = pulls[Number(m[1]) - 1];
      if (!pr) return send(404, { message: "Not Found" });
      if (pr.merged) return send(422, { message: "Validation Failed" });
      if (body.state) pr.state = body.state;
      return send(200, { number: pr.number, state: pr.state ?? "open", html_url: pr.html_url });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(p))) {
      const pr = pulls[Number(m[3]) - 1];
      return pr
        ? send(200, { state: pr.merged ? "closed" : (pr.state ?? "open"), merged: !!pr.merged, draft: !!pr.draft, mergeable_state: mergeableState(m[1], m[2], pr), html_url: pr.html_url, head: { sha: "abc" }, comments: 0, review_comments: 1 })
        : send(404, { message: "Not Found" });
    }
    if (/\/commits\/[^/]+\/check-runs$/.test(p)) {
      return send(200, { check_runs: checkRuns });
    }
    send(404, { message: `mock has no ${req.method} ${p}` });
  });

  return new Promise<{ url: string; pulls: any[]; issues: any[]; comments: any[]; checkRuns: typeof checkRuns; closed: typeof closed; createBare: typeof createBare; seedSubIssues: typeof seedSubIssues; close: () => Promise<void> }>((resolve) => {
    server.listen(Number(process.env.MOCK_GH_PORT ?? 0), "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        pulls,
        issues,
        comments,
        checkRuns,
        closed,
        createBare,
        seedSubIssues,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  fs.mkdirSync(root, { recursive: true });
  startMockGitHub(root).then(({ url }) => console.log(`mock GitHub at ${url}, repos in ${root}`));
}
