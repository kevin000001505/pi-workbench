/**
 * The Skills page (issue #116): the skill library and the skills the workbench ships, on one page.
 *
 * Add skill takes a git URL, an optional ref and an optional subpath, and states the refusal inline.
 * Every Skill source is a row that states what it was cloned from, the commit it pinned and how big the
 * install is, with the installed skills listed under it. Each installed skill row carries its on/off
 * switch and its attach checkboxes: the pipeline places whose runs load it (issue #117). Each source row
 * carries Update and Remove (issue #122): Update re-resolves the source's ref and installs the new version
 * only after it validates, so a source whose new version cannot install states why and keeps the version
 * that works; Remove, after a confirm, takes the source, its installed skills and their directory out of
 * the library, and with them every ticket's skill tag that named one of them. The read-only rows state
 * what a session can reach without the library: the built-in optional TypeSafe skill, and the image skills.
 */
import { useCallback, useEffect, useState } from "react";
import { ATTACH_LABELS, ATTACH_POINTS, type AttachPoint } from "../../../shared/attach.ts";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import type { InstalledSkill, Skill, SkillSource } from "../types.ts";
import { PageHeader, Spinner } from "../ui.tsx";

/** The installed size, as the row states it. */
const sizeOf = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;

/** The file names under one skill, as the row states them. */
const fileNames = (s: InstalledSkill) => s.files.join(", ");

/**
 * One installed skill: its declared name, its full description, the files it carries, its on/off
 * switch and its attach checkboxes. Attaching is the only way an installed skill reaches a run, so
 * the row states what the setting means: which runs load it.
 */
function SkillRow({ skill, saving, onSave }: { skill: InstalledSkill; saving: boolean; onSave: (skillId: string, body: { enabled?: boolean; attach?: string[] }) => void }) {
  const off = !skill.enabled;
  const attachOf = (point: AttachPoint, checked: boolean) => ATTACH_POINTS.filter((p) => (p === point ? checked : skill.attach.includes(p)));
  return (
    <div className={`skill-row${off ? " skill-row-off" : ""}`}>
      <div className="row gap wrap">
        <span className="mono">{skill.name}</span>
        <label className="row gap small">
          <input type="checkbox" checked={skill.enabled} disabled={saving} onChange={(e) => onSave(skill.id, { enabled: e.target.checked })} />
          On
        </label>
      </div>
      <p className="small">{skill.description}</p>
      <div className="row gap wrap small skill-attach">
        {ATTACH_POINTS.map((p) => (
          <label key={p} className="row gap">
            <input
              type="checkbox"
              checked={skill.attach.includes(p)}
              disabled={saving}
              onChange={(e) => onSave(skill.id, { attach: attachOf(p, e.target.checked) })}
            />
            {ATTACH_LABELS[p]}
          </label>
        ))}
      </div>
      <span className="muted small">
        {off ? "Switched off: no run loads it, and its attach points stay." : skill.attach.length === 0 ? "Attached to no place: no run loads it." : `Attached to: ${skill.attach.map((p) => ATTACH_LABELS[p]).join(", ")}. Its next run of those places loads it.`}
      </span>
      <span className="muted small">Files: {fileNames(skill)}</span>
    </div>
  );
}

/** The confirm text for Remove, the same for every source. */
const removeSourceQuestion = (source: SkillSource) =>
  `Remove ${source.url}${source.subpath ? ` (${source.subpath})` : ""} from the library? It deletes ${source.skills.length} installed ${source.skills.length === 1 ? "skill" : "skills"}${source.skills.length ? ` (${source.skills.map((s) => s.name).join(", ")})` : ""} and the directory that holds them, and every ticket's skill tag that names one of them — on every card, the done cards included.`;

/** One Skill source, with its Update and Remove and the skills it installed under it. */
function SourceRow({
  source,
  saving,
  busy,
  onSave,
  onUpdate,
  onRemove,
}: {
  source: SkillSource;
  saving: string | null;
  busy: boolean;
  onSave: (skillId: string, body: { enabled?: boolean; attach?: string[] }) => void;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  return (
    <article className="card-list-row">
      <div className="row gap">
        <span className="mono ellipsis grow" title={source.url}>
          {source.url}
        </span>
        <span className="tag" title="The tree the install keeps">
          {sizeOf(source.sizeBytes)}
        </span>
        {busy && <Spinner />}
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={onUpdate} title="Re-read the ref and install the new version">
          Update
        </button>
        <button className="btn btn-sm btn-ghost danger" disabled={busy} onClick={onRemove} title="Take the source and its installed skills out of the library">
          Remove
        </button>
      </div>
      <div className="skill-meta row gap wrap small muted">
        <span>Ref: {source.ref ?? "default head"}</span>
        <span>Subpath: {source.subpath ?? "the whole source"}</span>
        <span className="mono" title={source.commit}>
          Commit: {source.commit.slice(0, 12)}
        </span>
      </div>
      {/* A failed Update states why, and what still works: the source keeps the version it pinned. */}
      {source.lastError && (
        <p className="alert alert-error" role="alert">
          Update failed: {source.lastError} The source keeps the version that works, pinned at {source.commit.slice(0, 12)}.
        </p>
      )}
      <div className="skill-rows">
        {source.skills.map((s) => (
          <SkillRow key={s.id} skill={s} saving={saving === s.id} onSave={onSave} />
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
        <span className="tag">{kind === "optional" ? "Only the sessions that pick it" : "Every run"}</span>
        {skill.manualOnly && <span className="tag">Only when you type /skill:name</span>}
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
  /** The installed skill whose setting is on its way to the server. */
  const [saving, setSaving] = useState<string | null>(null);
  /** The source whose Update or Remove is on its way to the server. */
  const [busySource, setBusySource] = useState<string | null>(null);

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

  /**
   * Store one skill's switch or attach points, and show what the server stored. The change reaches the
   * next run of the place it names: a run going now keeps the skills it started with.
   */
  const saveSkill = async (skillId: string, body: { enabled?: boolean; attach?: string[] }) => {
    const source = sources.find((s) => s.skills.some((k) => k.id === skillId));
    if (!source) return;
    setSaving(skillId);
    try {
      const saved = await api.patch<InstalledSkill>(`/api/skill-sources/${source.id}/skills/${skillId}`, body);
      setSources((list) => list.map((s) => (s.id === source.id ? { ...s, skills: s.skills.map((k) => (k.id === saved.id ? saved : k)) } : s)));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(null);
    }
  };

  /**
   * Update one Skill source (issue #122): the workbench re-reads the source's ref — a branch that moved
   * on, or the source's default head when it names no ref — and installs the new version only after it
   * validates. A refusal leaves the source stating the version that still works, with the reason on its
   * row, so the page reads the library again instead of showing an answer that installed nothing.
   */
  const updateSource = async (sourceId: string) => {
    const source = sources.find((s) => s.id === sourceId);
    if (!source) return;
    setBusySource(sourceId);
    try {
      const updated = await api.post<SkillSource>(`/api/skill-sources/${sourceId}/update`);
      setSources((list) => list.map((s) => (s.id === updated.id ? updated : s)));
      toast(`Updated ${updated.url} to commit ${updated.commit.slice(0, 12)}`);
    } catch (e) {
      toast((e as Error).message, "error");
      load();
    } finally {
      setBusySource(null);
    }
  };

  /**
   * Remove one Skill source, after the confirm (issue #122): the source, the rows of the skills it
   * installed and the directory that holds them go, and with them every ticket's skill tag that named one
   * of them. The answer counts the cards that lost a tag, because the Board and the card detail state
   * those tickets without it.
   */
  const removeSource = async (source: SkillSource) => {
    if (!confirm(removeSourceQuestion(source))) return;
    setBusySource(source.id);
    try {
      const { source: removed, cards } = await api.del<{ source: SkillSource; cards: number }>(`/api/skill-sources/${source.id}`);
      setSources((list) => list.filter((s) => s.id !== removed.id));
      toast(`Removed ${removed.url}${cards ? ` — ${cards} ${cards === 1 ? "card" : "cards"} lost a ticket skill tag` : ""}`);
    } catch (e) {
      toast((e as Error).message, "error");
      load();
    } finally {
      setBusySource(null);
    }
  };

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
        <p className="muted small">
          Tick the pipeline places an installed skill should serve: only the runs of a ticked place load it, and the next run of that place is
          the one a change reaches. Switch it off to reach no run at all. Update re-reads a source and installs its new version in place; Remove
          takes the source and its installed skills out of the library, and with them every ticket tag that names one of them.
        </p>
        {sources.length === 0 ? (
          <p className="muted">No Skill source yet. Add one above: the workbench clones it, records the commit, and lists its skills here.</p>
        ) : (
          <div className="card-list">
            {sources.map((s) => (
              <SourceRow
                key={s.id}
                source={s}
                saving={saving}
                busy={busySource === s.id}
                onSave={(skillId, body) => void saveSkill(skillId, body)}
                onUpdate={() => void updateSource(s.id)}
                onRemove={() => void removeSource(s)}
              />
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
