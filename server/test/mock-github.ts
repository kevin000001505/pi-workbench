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
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

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
    if ((m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(p))) {
      const pr = pulls[Number(m[1]) - 1];
      return pr
        ? send(200, { state: "open", merged: false, draft: !!pr.draft, mergeable_state: "clean", html_url: pr.html_url, head: { sha: "abc" }, comments: 0, review_comments: 1 })
        : send(404, { message: "Not Found" });
    }
    if (/\/commits\/[^/]+\/check-runs$/.test(p)) {
      return send(200, { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }, { name: "lint", status: "in_progress", conclusion: null }] });
    }
    send(404, { message: `mock has no ${req.method} ${p}` });
  });

  return new Promise<{ url: string; pulls: any[]; createBare: typeof createBare; close: () => Promise<void> }>((resolve) => {
    server.listen(Number(process.env.MOCK_GH_PORT ?? 0), "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, pulls, createBare, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  fs.mkdirSync(root, { recursive: true });
  startMockGitHub(root).then(({ url }) => console.log(`mock GitHub at ${url}, repos in ${root}`));
}
