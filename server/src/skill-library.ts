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
  deleteSkillSource,
  installedSkillRow,
  installedSkillRows,
  recordSkillSource,
  recordSkillSourceFailure,
  recordSkillSourceUpdate,
  setInstalledSkillSettings,
  skillSourceRow,
  skillSourceRows,
  type Db,
  type InstalledSkillRow,
  type SkillSourceRow,
  type TicketTagCard,
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
  /** Why the last Update of this source failed, or null when nothing is failing (issue #122). */
  lastError: string | null;
  skills: InstalledSkill[];
};

/** One card whose ticket tags a library write changed: its Board and its card detail read again. */
export type ChangedCard = TicketTagCard;

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
  return skillSourceRows(db).map((r) => ({ ...toSource(r), skills: bySource.get(r.id) ?? [] }));
}

/** A source row as the library states it, its skills aside. */
function toSource(r: SkillSourceRow) {
  return {
    id: r.id,
    url: r.url,
    ref: r.ref,
    subpath: r.subpath,
    commit: r.commit_sha,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastError: r.last_error,
  };
}

/** An installed skill as the library's row holds it. */
function toSkillRow(s: InstalledSkill): InstalledSkillRow {
  return {
    id: s.id,
    source_id: s.sourceId,
    name: s.name,
    description: s.description,
    dir: s.dir,
    files: JSON.stringify(s.files),
    enabled: s.enabled ? 1 : 0,
    attach: JSON.stringify(s.attach),
  };
}

/**
 * Take a Skill source out of the library (issue #122, Remove): its row, the rows of the skills it
 * installed, the directory that holds them, and every ticket's Ticket skill tag that named one of them.
 * Nothing else walks the install directory, and every read of the library goes through these rows, so a
 * removed skill reaches no run and no card again.
 */
export function removeSkillSource(db: Db, sourceId: string): { source: SkillSource; changed: ChangedCard[] } {
  const row = skillSourceRow(db, sourceId);
  if (!row) throw notFound(`No Skill source ${sourceId} in the library`);
  // A Remove that went under a clone in flight would leave the new version's rows stated for a source the
  // library no longer holds.
  if (updating.has(sourceId)) throw alreadyRunning(row.url, row.subpath);
  const prior = installedSkillRows(db).filter((r) => r.source_id === sourceId);
  const source: SkillSource = { ...toSource(row), skills: prior.map(toSkill) };
  // The rows go first: a library that cannot drop them keeps stating the source, and its tree with it.
  const changed = deleteSkillSource(db, sourceId, prior.map((r) => r.id));
  fs.rmSync(skillInstallDir(sourceId), { recursive: true, force: true });
  return { source, changed };
}

/**
 * Add a Skill source: clone it shallowly at the commit its ref resolves to, read the skills it carries,
 * and install them. The answer is the source, or a refusal that names the problem; nothing
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

  // One Skill source per (url, ref, subpath) (issue #122): adding the same source again would clone the
  // same tree a second time and leave two rows that read identically on the Skills page, each holding its
  // own copy of every skill — so a switch, an attach point and a ticket tag would belong to one of them
  // for no reason the user can see. Update is the action that takes a new version of a source the library
  // already holds, and it keeps the installed skills' identities while it does.
  const held = skillSourceRows(db).find((r) => r.url === url && r.ref === ref && r.subpath === subpath);
  if (held) {
    throw Object.assign(
      new Error(`${where(url, subpath)} is already in the library, pinned at ${held.commit_sha.slice(0, 12)}: Update takes its new version`),
      { status: 409 },
    );
  }

  const plan: InstallPlan = { id: crypto.randomUUID(), url, ref, subpath, createdAt: Date.now(), action: "Add skill" };
  return installInPlace(db, plan, env, [], (facts, storedAt) => {
    recordSkillSource(
      db,
      { id: plan.id, url, ref, subpath, commit_sha: facts.commit, size_bytes: facts.sizeBytes, created_at: plan.createdAt, updated_at: storedAt },
      facts.skills.map(toSkillRow),
    );
  });
}

/**
 * Update a Skill source (issue #122): re-resolve the source's ref — a branch that moved on, a tag, the
 * commit a full hash names, or the source's default head when the source names no ref — clone that
 * commit, validate it, and only then put the new version in place.
 *
 * A clone or validation failure changes nothing that works: the source keeps the commit it pinned, the
 * tree it installed and its skills' rows, and `lastError` states why the new version is not installed, so
 * the Skills page says the source is failing instead of looking up to date. The user can Update again
 * once the source is fixed, and an Update that gets through clears the failure it stated.
 *
 * An installed skill the new version carries too keeps its identity, its on/off switch and its attach
 * points: a Ticket skill tag names an installed skill's identifier (issue #119), so new identifiers on
 * every Update would orphan every card that carries one. A skill the new version no longer carries goes,
 * and with it every ticket tag that named it — no run and no card is left told to load a skill the library
 * no longer holds.
 */
export async function updateSkillSource(db: Db, sourceId: string, env: GitEnv): Promise<{ source: SkillSource; changed: ChangedCard[] }> {
  const row = skillSourceRow(db, sourceId);
  if (!row) throw notFound(`No Skill source ${sourceId} in the library`);
  // One clone per source at a time (issue #122): two Update clicks write the same place, and the second
  // would answer for a version the first already replaced.
  if (updating.has(sourceId)) throw alreadyRunning(row.url, row.subpath);
  updating.add(sourceId);
  const prior = installedSkillRows(db).filter((r) => r.source_id === sourceId);
  const plan: InstallPlan = { id: row.id, url: row.url, ref: row.ref, subpath: row.subpath, createdAt: row.created_at, action: "Update" };
  let changed: ChangedCard[] = [];
  try {
    const source = await installInPlace(db, plan, env, prior, (facts, storedAt) => {
      changed = recordSkillSourceUpdate(
        db,
        sourceId,
        { commit_sha: facts.commit, size_bytes: facts.sizeBytes, updated_at: storedAt },
        facts.skills.map(toSkillRow),
        facts.droppedSkillIds,
      );
    });
    return { source, changed };
  } catch (err) {
    // The version that works is still installed. What the library adds is the reason this one is not.
    recordSkillSourceFailure(db, sourceId, (err as Error).message);
    throw err;
  } finally {
    updating.delete(sourceId);
  }
}

/** The sources whose Update is on its way (issue #122): one clone per source at a time. */
const updating = new Set<string>();

/** A source already being updated: the second write waits instead of writing over the clone. */
function alreadyRunning(url: string, subpath: string | null): Error {
  return Object.assign(new Error(`Update already runs for ${where(url, subpath)}: try again when it finishes`), { status: 409 });
}

/** What a validated install knows, before any of it is recorded. */
type InstallFacts = { commit: string; sizeBytes: number; skills: InstalledSkill[]; droppedSkillIds: string[] };

/** The source an install writes for: as Add skill named it, or as the library holds it for Update. */
type InstallPlan = { id: string; url: string; ref: string | null; subpath: string | null; createdAt: number; action: SkillAction };

/**
 * The install Add skill and Update share: clone the source shallowly at the commit its ref resolves to —
 * no ref resolves to the source's default head — validate the tree where it lies, and only then move it
 * into the source's place, so a refusal installs nothing.
 *
 * `prior` is what the library held for this source, by declared name: a skill the new version carries too
 * keeps its identifier, its switch and its attach points, because a Ticket skill tag names an identifier
 * and new identifiers would orphan every card that carries one.
 *
 * The version an Update replaces moves to a stashed directory beside the source's place, which this
 * function always removes: the source's place is never empty, and a new version whose rows cannot be
 * recorded is put back where it was. A failure before the tree is moved leaves the old tree untouched.
 */
async function installInPlace(
  db: Db,
  plan: InstallPlan,
  env: GitEnv,
  prior: InstalledSkillRow[],
  write: (facts: InstallFacts, storedAt: number) => void,
): Promise<SkillSource> {
  const temp = path.join(config.installedSkillsDir, `.tmp-${plan.id}`);
  const stash = path.join(config.installedSkillsDir, `.replaced-${plan.id}`);
  const dir = skillInstallDir(plan.id);
  fs.mkdirSync(config.installedSkillsDir, { recursive: true });
  try {
    const commit = await cloneAt(temp, plan.url, plan.ref, env, plan.action);
    // Validation reads the clone where it lies. The recorded directories are the same paths under the
    // install directory, which is where the tree lands once every check passes.
    const root = installRoot(temp, plan.url, plan.subpath);
    const found = readSkills(root, plan.id).map((s) => {
      const held = prior.find((r) => r.name === s.name);
      return held ? { ...s, id: held.id, enabled: held.enabled === 1, attach: parseAttach(held.attach) } : s;
    });
    if (!found.length) {
      throw refuse(`${where(plan.url, plan.subpath)} carries no skill: no SKILL.md with a name and a description`);
    }
    // A skill named like a pipeline skill would shadow the workbench's own one silently (ADR 0004):
    // the whole install is refused, and the reason names the colliding skill.
    const shadowed = found.map((s) => s.name).filter((n) => PIPELINE_SKILL_NAMES.includes(n));
    if (shadowed.length) {
      throw refuse(
        `${where(plan.url, plan.subpath)} carries the pipeline skill name ${shadowed.map((n) => `"${n}"`).join(", ")}: the pipeline's own skills are not installable`,
      );
    }
    const sizeBytes = treeBytes(root);
    if (sizeBytes > SKILL_INSTALL_SIZE_LIMIT) {
      throw refuse(`${where(plan.url, plan.subpath)} brings ${megabytes(sizeBytes)}, over the 10 MB install cap`);
    }

    // The clone's git objects are not part of the install: only the tree of skills moves into place.
    fs.rmSync(path.join(temp, ".git"), { recursive: true, force: true });

    const replaces = fs.existsSync(dir);
    try {
      if (replaces) fs.renameSync(dir, stash);
      fs.renameSync(root, dir);
      const skills = found.map((s) => ({ ...s, dir: path.join(dir, path.relative(root, s.dir)) }));
      const droppedSkillIds = prior.map((r) => r.id).filter((id) => !skills.some((s) => s.id === id));
      const storedAt = Date.now();
      write({ commit, sizeBytes, skills, droppedSkillIds }, storedAt);
      return {
        id: plan.id,
        url: plan.url,
        ref: plan.ref,
        subpath: plan.subpath,
        commit,
        sizeBytes,
        createdAt: plan.createdAt,
        updatedAt: storedAt,
        lastError: null,
        skills,
      };
    } catch (err) {
      // The tree and its rows are one fact: the new version goes, and the version that worked is put back
      // where it was.
      fs.rmSync(dir, { recursive: true, force: true });
      if (replaces && fs.existsSync(stash)) fs.renameSync(stash, dir);
      throw err;
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(stash, { recursive: true, force: true });
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
 * `git ls-remote`, or the source's default head when no ref is named — so an Update of a source with no
 * ref takes the head the source has now. A source git cannot reach is a refusal that carries git's own
 * reason.
 */
async function resolveCommit(url: string, ref: string | null, env: GitEnv, action: SkillAction): Promise<string> {
  let listed: string;
  try {
    listed = await git(config.dataDir, ["ls-remote", "--", url, ref ?? "HEAD"], env);
  } catch (err) {
    throw refuse(`${action} could not read ${where(url, null)}: ${(err as Error).message}`);
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
 * Clone `url` shallowly into `dir` at the commit `ref` resolves to, and answer with that commit. The
 * refusal names the action the user asked for: the same clone answers for Add skill and for Update, and a
 * source that states a failure has to say which of them failed.
 */
async function cloneAt(dir: string, url: string, ref: string | null, env: GitEnv, action: SkillAction): Promise<string> {
  const commit = await resolveCommit(url, ref, env, action);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await git(dir, ["init", "-q"], env);
    await git(dir, ["remote", "add", "--", "origin", url], env);
    await git(dir, ["fetch", "-q", "--depth", "1", "--no-tags", "origin", commit], env);
    await git(dir, ["checkout", "-q", "--detach", "FETCH_HEAD"], env);
  } catch (err) {
    throw refuse(`${action} could not clone ${where(url, null)} at ${commit.slice(0, 12)}: ${(err as Error).message}`);
  }
  return commit;
}

/** The action an install answers for: the refusal a source states names it. */
type SkillAction = "Add skill" | "Update";

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

/** Every installed skill of the library, switched on or off: what a stored Ticket skill tag may stand for. */
export function listInstalledSkills(db: Db): InstalledSkill[] {
  return installedSkillRows(db)
    .map(toSkill)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * The installed skills a ticket may be tagged with (issue #121): every skill of the library that is
 * switched on. A Ticket skill tag reaches its ticket's runs whatever pipeline place the skill is
 * attached to, so the attach points do not limit the names; a switched-off skill reaches no run at all,
 * so it names nothing to tag with.
 */
export function listTaggableSkills(db: Db): InstalledSkill[] {
  return listInstalledSkills(db).filter((s) => s.enabled);
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

/** A source the library does not hold: the route answers 404, as every other write route does. */
function notFound(message: string): Error {
  return Object.assign(new Error(message), { status: 404 });
}
