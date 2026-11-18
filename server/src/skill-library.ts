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
  installedSkillRow,
  installedSkillRows,
  recordSkillSource,
  setInstalledSkillSettings,
  skillSourceRows,
  type Db,
  type InstalledSkillRow,
} from "./db.ts";
import { git, redact, type GitEnv } from "./git.ts";
import { ATTACH_POINTS, PIPELINE_SKILL_NAMES, type AttachPoint, isAttachPoint } from "./pipeline.ts";
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
  /** The on/off switch: an off skill reaches no run, whatever its attach points say. */
  enabled: boolean;
  /** The pipeline places it is attached to, in the order pipeline.ts names them. */
  attach: AttachPoint[];
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

/** How much one install may bring: the tree the chosen subpath holds, git's own objects aside. */
export const SKILL_INSTALL_SIZE_LIMIT = 10 * 1024 * 1024;

/** The library: every Skill source with the skills it installed. */
export function listSkillSources(db: Db): SkillSource[] {
  const bySource = new Map<string, InstalledSkill[]>();
  for (const r of installedSkillRows(db)) {
    const list = bySource.get(r.source_id) ?? [];
    list.push(toSkill(r));
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
export async function addSkillSource(
  db: Db,
  input: { url: unknown; ref?: unknown; subpath?: unknown },
  env: GitEnv,
): Promise<SkillSource> {
  const url = sourceUrl(input.url);
  const ref = namedRef(input.ref);
  const subpath = sourceSubpath(input.subpath);

  const id = crypto.randomUUID();
  const temp = path.join(config.installedSkillsDir, `.tmp-${id}`);
  fs.mkdirSync(config.installedSkillsDir, { recursive: true });
  try {
    const commit = await cloneAt(temp, url, ref, env);
    // Validation reads the clone where it lies. The recorded directories are the same paths under
    // the install directory, which is where the tree lands once everything checks out.
    const root = installRoot(temp, url, subpath);
    const found = readSkills(root, id);
    if (!found.length) {
      throw refuse(`${where(url, subpath)} carries no skill: no SKILL.md with a name and a description`);
    }
    // A skill named like a pipeline skill would shadow the workbench's own one silently (ADR 0004):
    // the whole install is refused, and the reason names the colliding skill.
    const shadowed = found.map((s) => s.name).filter((n) => PIPELINE_SKILL_NAMES.includes(n));
    if (shadowed.length) {
      throw refuse(
        `${where(url, subpath)} carries the pipeline skill name ${shadowed.map((n) => `"${n}"`).join(", ")}: the pipeline's own skills are not installable`,
      );
    }
    const sizeBytes = treeBytes(root);
    if (sizeBytes > SKILL_INSTALL_SIZE_LIMIT) {
      throw refuse(`${where(url, subpath)} brings ${megabytes(sizeBytes)}, over the 10 MB install cap`);
    }

    // The clone's git objects are not part of the install: only the tree of skills moves into place.
    fs.rmSync(path.join(temp, ".git"), { recursive: true, force: true });
    const dir = skillInstallDir(id);
    fs.renameSync(root, dir);
    const skills = found.map((s) => ({ ...s, dir: path.join(dir, path.relative(root, s.dir)) }));
    const now = Date.now();
    try {
      recordSkillSource(
        db,
        { id, url, ref, subpath, commit_sha: commit, size_bytes: sizeBytes, created_at: now, updated_at: now },
        skills.map((s) => ({ id: s.id, source_id: id, name: s.name, description: s.description, dir: s.dir, files: JSON.stringify(s.files) })),
      );
    } catch (err) {
      // The rows and the directory are one fact: a library that cannot record them installs nothing.
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    return { id, url, ref, subpath, commit, sizeBytes, createdAt: now, updatedAt: now, skills };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** Something the clone can take: a git URL, `file://` included. An absolute local path is refused. */
const LOCAL_PATH = /^(\.{0,2}[\\/]|[A-Za-z]:[\\/]|~[\\/])/;

function sourceUrl(value: unknown): string {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url) throw refuse("Add skill needs the source's git URL");
  // A leading dash would reach git as an option, not as a source (`--ext::sh -c …` included).
  if (url.startsWith("-")) throw refuse(`Add skill needs the source's git URL; "${url}" is not one`);
  if (LOCAL_PATH.test(url)) {
    throw refuse(`Add skill needs a git URL; "${url}" is a local path — name it as file://${url}`);
  }
  return url;
}

/** The source's ref as the user named it: a branch, a tag or a commit. Null takes the default head. */
function namedRef(value: unknown): string | null {
  const ref = typeof value === "string" ? value.trim() : "";
  return ref || null;
}

/** The directory inside the source whose tree installs, as a path from the source's root. */
function sourceSubpath(value: unknown): string | null {
  const sub = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (!sub) return null;
  // A leading slash, `~`, or a drive letter names a path on the machine, not one inside the clone.
  if (sub.startsWith("/") || sub.startsWith("~") || /^[A-Za-z]:[\\/]/.test(sub)) {
    throw refuse(`The subpath must be a directory inside the source; "${value}" is an absolute path — name it from the source's root`);
  }
  if (sub.split(/[\\/]/).some((p) => p === "..")) {
    throw refuse(`The subpath must be a directory inside the source; "${value}" is outside it`);
  }
  return sub;
}

/** The cloned tree the install keeps: the whole clone, or the clone's `subpath`. */
function installRoot(temp: string, url: string, subpath: string | null): string {
  const root = subpath ? path.join(temp, subpath) : temp;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw refuse(`${where(url, subpath)} has no directory "${subpath}" to install`);
  }
  return root;
}

/** A full commit hash. `git ls-remote` lists refs, so a commit named as the ref never appears in it. */
const FULL_SHA = /^[0-9a-f]{40}$/i;

/** The source, as a refusal names it: never the credentials its URL may carry. */
const where = (url: string, subpath: string | null) => (subpath ? `${redact(url)} (${subpath})` : redact(url));

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * The one commit the source pins: `ref` (a branch, a tag or a full commit hash) resolved through
 * `git ls-remote`, or the source's default head when no ref is named. A source git cannot reach is a
 * refusal that carries git's own reason.
 */
async function resolveCommit(url: string, ref: string | null, env: GitEnv): Promise<string> {
  let listed: string;
  try {
    listed = await git(config.dataDir, ["ls-remote", "--", url, ref ?? "HEAD"], env);
  } catch (err) {
    throw refuse(`Add skill could not read ${where(url, null)}: ${(err as Error).message}`);
  }
  const sha = listed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0]
    ?.split("\t")[0];
  if (sha) return sha;
  if (ref && FULL_SHA.test(ref)) return ref;
  if (ref) throw refuse(`${where(url, null)} has no branch or tag named "${ref}"`);
  throw refuse(`${where(url, null)} has no commits to install`);
}

/**
 * Clone `url` shallowly into `dir` at the commit `ref` resolves to, and answer with that commit.
 */
async function cloneAt(dir: string, url: string, ref: string | null, env: GitEnv): Promise<string> {
  const commit = await resolveCommit(url, ref, env);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await git(dir, ["init", "-q"], env);
    await git(dir, ["remote", "add", "--", "origin", url], env);
    await git(dir, ["fetch", "-q", "--depth", "1", "--no-tags", "origin", commit], env);
    await git(dir, ["checkout", "-q", "--detach", "FETCH_HEAD"], env);
  } catch (err) {
    throw refuse(`Add skill could not clone ${where(url, null)} at ${commit.slice(0, 12)}: ${(err as Error).message}`);
  }
  return commit;
}

/** Every skill directory under `root`, with the file names each one carries, by declared name. */
function readSkills(root: string, sourceId: string): InstalledSkill[] {
  return scanSkills(root, "installed")
    .map((s) => {
      const dir = path.dirname(s.path);
      return { id: crypto.randomUUID(), sourceId, name: s.name, description: s.description, dir, files: fileNamesOf(dir), enabled: true, attach: [] };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
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

/** The row as the library states it. */
function toSkill(r: InstalledSkillRow): InstalledSkill {
  return {
    id: r.id,
    sourceId: r.source_id,
    name: r.name,
    description: r.description,
    dir: r.dir,
    files: parseFiles(r.files),
    enabled: r.enabled === 1,
    attach: parseAttach(r.attach),
  };
}

/** The attach points as stored: only the names pipeline.ts knows, once each, in that order. */
function parseAttach(text: string): AttachPoint[] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return ATTACH_POINTS.filter((p) => v.some((x) => x === p));
}

/** One installed skill of the library, null when the library does not hold it. */
export function installedSkill(db: Db, skillId: string): InstalledSkill | null {
  const r = installedSkillRow(db, skillId);
  return r ? toSkill(r) : null;
}

/** The installed skills attached to one pipeline place and switched on: what a run of that place gets. */
export function listAttachedSkills(db: Db, place: AttachPoint): InstalledSkill[] {
  return installedSkillRows(db)
    .filter((r) => r.enabled === 1 && parseAttach(r.attach).includes(place))
    .map(toSkill)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * The Skills page's on/off switch and attach checkboxes (issue #117): store the switch, the attach
 * points, or both, for one installed skill of one source. A place the attach table does not know is
 * refused, so a typo never reads as a place. The change reaches the next run of that place only:
 * no run of the session manager is touched here.
 */
export function setSkillSettings(db: Db, sourceId: string, skillId: string, body: { enabled?: unknown; attach?: unknown }): InstalledSkill {
  const row = installedSkillRow(db, skillId);
  if (!row || row.source_id !== sourceId) throw Object.assign(new Error(`No installed skill ${skillId} of this Skill source`), { status: 404 });
  if (body.enabled === undefined && body.attach === undefined) throw refuse("Nothing to change: the switch (enabled) or the attach points");
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw refuse("The on/off switch is true or false");
  let attach: AttachPoint[] | null = null;
  if (body.attach !== undefined) {
    if (!Array.isArray(body.attach)) throw refuse(`The attach points are a list of the pipeline places: ${ATTACH_POINTS.join(", ")}`);
    const unknown = body.attach.filter((x) => !isAttachPoint(x));
    if (unknown.length) {
      throw refuse(`Not a pipeline place: ${unknown.map((x) => JSON.stringify(x)).join(", ")}. The attach points are ${ATTACH_POINTS.join(", ")}`);
    }
    attach = ATTACH_POINTS.filter((p) => (body.attach as unknown[]).some((x) => x === p));
  }
  setInstalledSkillSettings(
    db,
    skillId,
    body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
    JSON.stringify(attach ?? parseAttach(row.attach)),
  );
  return installedSkill(db, skillId)!;
}

/** A refusal the route answers with 400 and the reason the user has to see. */
function refuse(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}
