/**
 * The Skills page (issue #116): the skill library and the skills the workbench ships, on one page.
 *
 * Add skill takes a git URL, an optional ref and an optional subpath, and states the refusal inline.
 * Every Skill source is a row that states what it was cloned from, the commit it pinned and how big the
 * install is, with the installed skills listed under it. The read-only rows state what a session can
 * reach without the library: the built-in optional TypeSafe skill, and the image skills.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import type { InstalledSkill, Skill, SkillSource } from "../types.ts";
import { PageHeader, Spinner } from "../ui.tsx";

/** The installed size, as the row states it. */
const sizeOf = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;

/** The file names under one skill, as the row states them. */
const fileNames = (s: InstalledSkill) => (s.files.length ? s.files.join(", ") : "no files");

/** One installed skill: its declared name, its full description, and the files it carries. */
function SkillRow({ skill }: { skill: InstalledSkill }) {
  return (
    <div className="skill-row">
      <span className="mono">{skill.name}</span>
      <p className="small">{skill.description}</p>
      <span className="muted small">Files: {fileNames(skill)}</span>
    </div>
  );
}

/** One Skill source, with the skills it installed under it. */
function SourceRow({ source }: { source: SkillSource }) {
  return (
    <article className="card-list-row">
      <div className="row gap">
        <span className="mono ellipsis grow" title={source.url}>
          {source.url}
        </span>
        <span className="tag" title="The tree the install keeps">
          {sizeOf(source.sizeBytes)}
        </span>
      </div>
      <div className="skill-meta row gap wrap small muted">
        <span>Ref: {source.ref ?? "default head"}</span>
        <span>Subpath: {source.subpath ?? "the whole source"}</span>
        <span className="mono" title={source.commit}>
          Commit: {source.commit.slice(0, 12)}
        </span>
      </div>
      <div className="skill-rows">
        {source.skills.map((s) => (
          <SkillRow key={s.id} skill={s} />
        ))}
      </div>
    </article>
  );
}

/** A read-only row for a skill the workbench ships: an image skill, or the built-in optional one. */
function BuiltInRow({ skill, kind }: { skill: Skill; kind: "optional" | "image" }) {
  return (
    <div className="skill-row">
      <div className="row gap">
        <span className="mono">{skill.name}</span>
        <span className="tag">{kind === "optional" ? "Sessions that pick it" : "Every run"}</span>
        {skill.manualOnly && <span className="tag">Load it by name</span>}
      </div>
      <p className="small">{skill.description}</p>
    </div>
  );
}

export function Skills() {
  const { toast } = useStore();
  const [sources, setSources] = useState<SkillSource[]>([]);
  /** The skills a session can reach with the built-in optional skill: null until the read answers. */
  const [reachable, setReachable] = useState<Skill[] | null>(null);
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [subpath, setSubpath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api
      .get<SkillSource[]>("/api/skill-sources")
      .then(setSources)
      .catch((e) => toast((e as Error).message, "error"));
    api
      .get<Skill[]>("/api/skills?typesafe=1")
      .then(setReachable)
      .catch(() => setReachable(null));
  }, [toast]);
  useEffect(load, [load]);

  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      const created = await api.post<SkillSource>("/api/skill-sources", {
        url: url.trim(),
        ref: ref.trim() || undefined,
        subpath: subpath.trim() || undefined,
      });
      toast(`Added ${created.url}${created.subpath ? ` (${created.subpath})` : ""}`);
      setUrl("");
      setRef("");
      setSubpath("");
      // Reread the library, so the page shows what the server installed, not what the add answered.
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const optionalSkills = (reachable ?? []).filter((s) => s.source === "optional");
  const imageSkills = (reachable ?? []).filter((s) => s.source !== "optional");
  const skillCount = sources.reduce((n, s) => n + s.skills.length, 0);

  return (
    <div className="page page-narrow">
      <PageHeader title="Skills" sub="What a session can load: the skill library — git sources you added — and the skills the workbench ships." />

      <form
        className="card form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <h3>Add skill</h3>
        <label>
          Git URL
          <input
            className="input mono"
            placeholder="https://github.com/you/skills"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="grid2">
          <label>
            Ref (branch, tag or commit)
            <input className="input mono" placeholder="main" value={ref} onChange={(e) => setRef(e.target.value)} spellCheck={false} />
          </label>
          <label>
            Subpath (directory inside the source)
            <input className="input mono" placeholder="frontend" value={subpath} onChange={(e) => setSubpath(e.target.value)} spellCheck={false} />
          </label>
        </div>
        <p className="muted small">
          The workbench clones the source shallowly at the commit the ref names, keeps at most 10 MB, and refuses the whole add when a skill
          carries a pipeline skill name. It pins the commit, so every run loads the same version.
        </p>
        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        <div className="row end">
          {adding && <Spinner />}
          <button className="btn btn-primary" disabled={adding || !url.trim()}>
            Add skill
          </button>
        </div>
      </form>

      <section>
        <h2>
          Skill library <span className="muted small">({sources.length} {sources.length === 1 ? "source" : "sources"}, {skillCount} installed)</span>
        </h2>
        {sources.length === 0 ? (
          <p className="muted">No Skill source yet. Add one above: the workbench clones it, records the commit, and lists its skills here.</p>
        ) : (
          <div className="card-list">
            {sources.map((s) => (
              <SourceRow key={s.id} source={s} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>Built-in optional skill</h2>
        <p className="muted small">Read-only. The workbench ships it, and only the sessions that pick it in New session load it.</p>
        {reachable === null ? (
          <p className="muted">The skills a session can reach could not be read.</p>
        ) : optionalSkills.length === 0 ? (
          <p className="muted">The TypeSafe skill is not installed in this image.</p>
        ) : (
          <div className="card">
            {optionalSkills.map((s) => (
              <BuiltInRow key={s.name} skill={s} kind="optional" />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>
          Image skills <span className="muted small">(read-only, every run of every session scans them)</span>
        </h2>
        {reachable === null ? (
          <p className="muted">The skills a session can reach could not be read.</p>
        ) : imageSkills.length === 0 ? (
          <p className="muted">This image ships no skill.</p>
        ) : (
          <div className="card">
            {imageSkills.map((s) => (
              <BuiltInRow key={s.name} skill={s} kind="image" />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
