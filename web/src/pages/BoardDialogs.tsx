import { useState } from "react";
import { type Card, COLUMNS } from "../../../shared/board.ts";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import type { SessionSummary } from "../types.ts";

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
