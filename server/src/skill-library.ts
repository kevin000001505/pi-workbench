/**
 * The skill library (issue #114): the Skill sources the user added, the installed skills they
 * brought, and the install directory under the data volume that holds them.
 *
 * This module owns that directory: no other module walks it, and it is not a skills directory, so pi
 * never scans it and an installed skill reaches no run until it is attached (ADR 0004). An add is
 * all-or-nothing: the clone lands in a temporary directory inside the install directory, validates
 * there, and only then takes its final place, so a refused add installs nothing.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import {
  installedSkillRows,
  recordSkillSource,
  skillSourceRows,
  type Db,
} from "./db.ts";
import { git, type GitEnv } from "./git.ts";
import { scanSkills } from "./skills.ts";

/** An installed skill: what the workbench knows about one SKILL.md the source carried. */
export type InstalledSkill = {
  id: string;
  sourceId: string;
  name: string;
  description: string;
  /** The skill's directory on disk: what a run gets when the skill is attached to its place. */
  dir: string;
  /** The file names under it, relative to the skill's directory. */
  files: string[];
};

/** A Skill source and the skills it installed. */
export type SkillSource = {
  id: string;
  url: string;
  ref: string | null;
  subpath: string | null;
  /** The commit the clone pinned: what every run of this source loaded. */
  commit: string;
  /** Bytes of the tree the install keeps. */
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
  skills: InstalledSkill[];
};

/** The directory one install keeps. It lives in the data volume, so a restart keeps it. */
export const skillInstallDir = (sourceId: string) => path.join(config.installedSkillsDir, sourceId);

/** The library: every Skill source with the skills it installed. */
export function listSkillSources(db: Db): SkillSource[] {
  const bySource = new Map<string, InstalledSkill[]>();
  for (const r of installedSkillRows(db)) {
    const list = bySource.get(r.source_id) ?? [];
    list.push({
      id: r.id,
      sourceId: r.source_id,
      name: r.name,
      description: r.description,
      dir: r.dir,
      files: parseFiles(r.files),
    });
    bySource.set(r.source_id, list);
  }
  return skillSourceRows(db).map((r) => ({
    id: r.id,
    url: r.url,
    ref: r.ref,
    subpath: r.subpath,
    commit: r.commit_sha,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    skills: bySource.get(r.id) ?? [],
  }));
}

/**
 * Add a Skill source: clone it shallowly at the commit its ref resolves to, read the skills it
 * carries, and install them. The answer is the source, or a refusal that names the problem; nothing
 * half-installed survives either way.
 */
export async function addSkillSource(db: Db, input: { url: unknown; ref?: unknown }, env: GitEnv): Promise<SkillSource> {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!url) throw refuse("Add skill needs the source's git URL");
  const ref = typeof input.ref === "string" && input.ref.trim() ? input.ref.trim() : null;

  const id = crypto.randomUUID();
  const temp = path.join(config.installedSkillsDir, `.tmp-${id}`);
  fs.mkdirSync(config.installedSkillsDir, { recursive: true });
  try {
    const commit = await cloneAt(temp, url, ref, env);
    // Validation reads the clone where it lies. The recorded directories are the same paths under
    // the install directory, which is where the tree lands once everything checks out.
    const found = readSkills(temp, id);
    const sizeBytes = treeBytes(temp);

    // The clone's git objects are not part of the install: only the tree of skills moves into place.
    fs.rmSync(path.join(temp, ".git"), { recursive: true, force: true });
    const dir = skillInstallDir(id);
    fs.renameSync(temp, dir);
    const skills = found.map((s) => ({ ...s, dir: path.join(dir, path.relative(temp, s.dir)) }));
    const now = Date.now();
    try {
      recordSkillSource(
        db,
        { id, url, ref, subpath: null, commit_sha: commit, size_bytes: sizeBytes, created_at: now, updated_at: now },
        skills.map((s) => ({ id: s.id, source_id: id, name: s.name, description: s.description, dir: s.dir, files: JSON.stringify(s.files) })),
      );
    } catch (err) {
      // The rows and the directory are one fact: a library that cannot record them installs nothing.
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    return { id, url, ref, subpath: null, commit, sizeBytes, createdAt: now, updatedAt: now, skills };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** A full commit hash. `git ls-remote` lists refs, so a commit named as the ref never appears in it. */
const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * The one commit the source pins: `ref` (a branch, a tag or a full commit hash) resolved through
 * `git ls-remote`, or the source's default head when no ref is named.
 */
async function resolveCommit(url: string, ref: string | null, env: GitEnv): Promise<string> {
  const listed = (await git(config.dataDir, ["ls-remote", url, ref ?? "HEAD"], env))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const sha = listed[0]?.split("\t")[0];
  if (sha) return sha;
  if (ref && FULL_SHA.test(ref)) return ref;
  if (ref) throw refuse(`${url} has no branch or tag named "${ref}"`);
  throw refuse(`${url} has no commits to install`);
}

/**
 * Clone `url` shallowly into `dir` at the commit `ref` resolves to, and answer with that commit.
 * A URL git cannot reach comes back as git's own reason.
 */
async function cloneAt(dir: string, url: string, ref: string | null, env: GitEnv): Promise<string> {
  const commit = await resolveCommit(url, ref, env);
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-q"], env);
  await git(dir, ["remote", "add", "origin", url], env);
  await git(dir, ["fetch", "-q", "--depth", "1", "--no-tags", "origin", commit], env);
  await git(dir, ["checkout", "-q", "--detach", "FETCH_HEAD"], env);
  return commit;
}

/** Every skill directory under `root`, with the file names each one carries. */
function readSkills(root: string, sourceId: string): InstalledSkill[] {
  return scanSkills(root, "installed").map((s) => {
    const dir = path.dirname(s.path);
    return { id: crypto.randomUUID(), sourceId, name: s.name, description: s.description, dir, files: fileNamesOf(dir) };
  });
}

/** The bytes of a tree's files, the git objects aside. */
function treeBytes(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += treeBytes(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

/** The file names under one skill's directory, relative to it and sorted. */
function fileNamesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else if (e.isFile()) out.push(`${rel}${e.name}`);
    }
  };
  walk(dir, "");
  return out.sort();
}

function parseFiles(text: string): string[] {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** A refusal the route answers with 400 and the reason the user has to see. */
function refuse(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}
