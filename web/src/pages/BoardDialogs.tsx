import { useEffect, useState } from "react";
import { type Card, COLUMNS } from "../../../shared/board.ts";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import type { SessionSummary, SkillSource } from "../types.ts";

// The board's dialogs and its search and filter words: New card (n) and Search (/ or ⌘K).

/** The words of a search or filter query, lowercased. */
export const wordsOf = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
/** A card matches when every word is in its title, column, spec ref or attention. */
export function matches(card: Card, words: string[]) {
  const label = COLUMNS.find((c) => c.id === card.column)?.label ?? "";
  const text = [card.title, label, card.specRef ?? "", card.attention ?? "", card.pr ? `#${card.pr.number}` : ""].join(" ").toLowerCase();
  return words.every((w) => text.includes(w));
}

/** A key press on the board itself, not while you type in a field. */
export function typingIn(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el?.closest?.("input, textarea, select, [contenteditable]");
}

/** New card: a title and a description. The grill starts at once on the board's repo. */
export function NewCard({ repoId, onCreated, onClose }: { repoId: string; onCreated: (id: string) => void; onClose: () => void }) {
  const { upsert, toast } = useStore();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (!title.trim() || creating) return;
    setCreating(true);
    try {
      const s = await api.post<SessionSummary>("/api/sessions", {
        repoId,
        title: title.trim(),
        prompt: description.trim() || title.trim(),
        mode: "pipeline",
      });
      upsert(s);
      onCreated(s.id);
    } catch (e) {
      toast((e as Error).message, "error");
      setCreating(false);
    }
  };

  return (
    <>
      <div className="kz-modal-backdrop" onClick={onClose} />
      <form
        className="kz-modal"
        role="dialog"
        aria-label="New card"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void create();
          }
        }}
      >
        <h2>New card</h2>
        <input autoFocus className="kz-field" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea
          className="kz-field"
          rows={6}
          placeholder="Describe the feature. The grill asks its questions in the card detail."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="actions">
          <button type="button" className="kz-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="kz-btn primary" disabled={!title.trim() || creating}>
            {creating ? "Creating…" : "Create card"}
          </button>
        </div>
      </form>
    </>
  );
}

/**
 * Ticket skills (issue #121): the checkbox list that sets one ticket's Ticket skill tags from its card.
 * The names a ticket may carry are the skill library's installed skills that are switched on, so an
 * off skill is offered only when the ticket already carries it: saving never drops a tag behind the
 * user's back. Save sends the chosen names to the ticket's route, which answers with the stored ticket
 * and names back every name it would drop. The cap on a ticket's tags is the server's: a refused save
 * states its reason.
 */
export function TicketTags({
  sessionId,
  ticket,
  carried,
  onClose,
  onSaved,
}: {
  sessionId: string;
  ticket: { num: number; title: string };
  carried: string[];
  onClose: () => void;
  onSaved: (dropped: string[]) => void;
}) {
  const { toast } = useStore();
  const [library, setLibrary] = useState<{ name: string; description: string; enabled: boolean }[] | null>(null);
  const [chosen, setChosen] = useState<string[]>(carried);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .get<SkillSource[]>("/api/skill-sources")
      .then((sources) => {
        if (!live) return;
        const byName = new Map<string, { name: string; description: string; enabled: boolean }>();
        for (const source of sources)
          for (const s of source.skills) if (!byName.has(s.name)) byName.set(s.name, { name: s.name, description: s.description, enabled: s.enabled });
        setLibrary([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => live && setLibrary([]));
    return () => {
      live = false;
    };
  }, []);

  const skills = library ?? [];
  // A tag the library no longer holds has no checkbox: saving drops it, and the dialog says so.
  const stale = carried.filter((n) => !skills.some((s) => s.name === n));
  const toggle = (name: string, on: boolean) => setChosen((cur) => (on ? [...cur.filter((n) => n !== name), name] : cur.filter((n) => n !== name)));

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const r = await api.patch<{ dropped: string[] }>(`/api/sessions/${sessionId}/tickets/${ticket.num}/skills`, { skills: chosen });
      onSaved(r.dropped);
    } catch (e) {
      toast((e as Error).message, "error");
      setSaving(false);
    }
  };

  return (
    <>
      <div className="kz-modal-backdrop" onClick={onClose} />
      <form
        className="kz-modal"
        role="dialog"
        aria-label="Ticket skills"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
      >
        <h2>Ticket skills</h2>
        <div className="small muted">
          #{ticket.num} {ticket.title}: the skills its runs must load.
        </div>
        {library === null && <div className="note">Loading the skills…</div>}
        {library !== null && skills.length === 0 && <div className="note">No skill is installed. Add one on the Skills page.</div>}
        <div className="kz-tag-list">
          {skills.map((s) => {
            // A switched-off skill is offered only when the ticket already carries it.
            const blocked = !s.enabled && !carried.includes(s.name);
            return (
              <label key={s.name} className="row gap small" title={s.description || undefined}>
                <input type="checkbox" checked={chosen.includes(s.name)} disabled={saving || blocked} onChange={(e) => toggle(s.name, e.target.checked)} />
                <span className="mono">{s.name}</span>
                {blocked && <span className="muted small">switched off</span>}
              </label>
            );
          })}
        </div>
        {stale.length > 0 && <div className="note">The ticket carries a tag the library no longer holds: {stale.join(", ")}. Save drops it.</div>}
        <div className="actions">
          <button type="button" className="kz-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="kz-btn primary" disabled={saving || library === null}>
            {saving ? "Saving…" : "Save tags"}
          </button>
        </div>
      </form>
    </>
  );
}

/** Search (`/` or ⌘K): find a card of the board by its words and open its detail. */
export function Search({ cards, onPick, onClose }: { cards: Card[]; onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState(0);
  const words = wordsOf(q);
  const results = cards.filter((c) => matches(c, words)).slice(0, 50);
  const pick = (c: Card | undefined) => c && onPick(c.id);
  return (
    <>
      <div className="kz-modal-backdrop" onClick={onClose} />
      <div className="kz-modal kz-search" role="dialog" aria-label="Search cards">
        <input
          autoFocus
          className="kz-field"
          placeholder="Search cards"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onClose();
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const n = results.length || 1;
              setSelected((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(results[selected]);
            }
          }}
        />
        <div className="results">
          {results.map((c, i) => (
            <button key={c.id} type="button" className={`result ${i === selected ? "selected" : ""}`} onMouseMove={() => setSelected(i)} onClick={() => pick(c)}>
              <span className="title">{c.title}</span>
              <span className="meta">{COLUMNS.find((x) => x.id === c.column)?.label}</span>
            </button>
          ))}
          {results.length === 0 && <div className="note">{cards.length ? "No cards match." : "No cards yet."}</div>}
        </div>
      </div>
    </>
  );
}
