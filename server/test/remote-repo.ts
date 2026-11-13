/**
 * Local bare repos the tests use as git remotes. `root` is the directory GITHUB_CLONE_BASE points
 * at (`file://<root>`), so the workbench clones exactly what these write: `seedBareRepo` makes one
 * repo with its files on the default branch, `editRemoteFile` puts a file on that branch afterwards
 * or takes it off, as another developer's push does.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
const commit = (cwd: string, ...args: string[]) => sh(cwd, "-c", "user.name=git-remote", "-c", "user.email=git-remote@test", ...args);

/** What `setup-matt-pocock-skills` commits: the body tests put in the setup marker file. */
export const ISSUE_TRACKER_DOC = "# Issue tracker\n\nGitHub Issues.\n";

/** A bare repo at `<root>/<owner>/<name>.git` whose default branch (`main`) carries `seedFiles`. */
export function seedBareRepo(root: string, owner: string, name: string, seedFiles: Record<string, string> = {}) {
  const bare = path.join(root, owner, `${name}.git`);
  const seed = fs.mkdtempSync(path.join(root, ".seed-"));
  sh(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "README.md"), `# ${name}\n`);
  for (const [rel, content] of Object.entries(seedFiles)) {
    fs.mkdirSync(path.join(seed, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(seed, rel), content);
  }
  sh(seed, "add", ".");
  commit(seed, "commit", "-qm", "Initial commit");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  sh(root, "clone", "-q", "--bare", seed, bare);
  fs.rmSync(seed, { recursive: true, force: true });
  return bare;
}

/** Put `rel` on that repo's default branch (`content`), or take it off (`null`). */
export function editRemoteFile(root: string, owner: string, name: string, rel: string, content: string | null) {
  const work = fs.mkdtempSync(path.join(root, ".edit-"));
  sh(root, "clone", "-q", path.join(root, owner, `${name}.git`), work);
  if (content === null) fs.rmSync(path.join(work, rel));
  else {
    fs.mkdirSync(path.join(work, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), content);
  }
  sh(work, "add", "-A");
  commit(work, "commit", "-qm", content === null ? `Remove ${rel}` : `Add ${rel}`);
  sh(work, "push", "-q", "origin", "main");
  fs.rmSync(work, { recursive: true, force: true });
}
