import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Card, type Column, COLUMNS, DONE_PAGE, isPlainUnclaimedCard, unclaimedNumber } from "../../../shared/board.ts";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import { approveQuestion, CardDetail, issueParts } from "./CardDetail.tsx";
import { CardActions, SOLVE, SOLVE_ALL, SPLIT } from "./CardActions.tsx";
import { matches, NewCard, Search, typingIn, wordsOf } from "./BoardDialogs.tsx";
import { isResolvedNote, type Repo, type UnclaimedSpecTickets } from "../types.ts";
import { Spinner } from "../ui.tsx";
import "../board.css";

/** The repo whose board opened last; the start page opens it again. */
const LAST_REPO_KEY = "wb.board.repo";
export function lastBoardRepo(): string | null {
  try {
    return localStorage.getItem(LAST_REPO_KEY);
  } catch {
    return null;
  }
}
function rememberBoardRepo(id: string) {
  try {
    localStorage.setItem(LAST_REPO_KEY, id);
  } catch {}
}

// From kanzo's app.js: one color per step, from To do on.
const STATUS_COLORS = ["#8a8a83", "#3b82f6", "#e8a317", "#2f9e44", "#ae3ec9", "#e8590c"];

/** kanzo's status icon: a ring that fills as the column gets closer to Done. */
function StatusIcon({ column }: { column: Column }) {
  const step = COLUMNS.findIndex((c) => c.id === column);
  const f = step / (COLUMNS.length - 1);
  const color = STATUS_COLORS[step % STATUS_COLORS.length];
  let inside = null;
  if (f >= 1) {
    inside = (
      <>
        <circle cx="7" cy="7" r="6" fill={color} />
        <path d="m4.4 7.2 1.8 1.8 3.4-3.6" fill="none" stroke="var(--kz-bg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </>
    );
  } else if (f > 0) {
    const r = 3.4;
    const a = f * 2 * Math.PI;
    const x = (7 + r * Math.sin(a)).toFixed(2);
    const y = (7 - r * Math.cos(a)).toFixed(2);
    inside = <path d={`M7 7L7 ${7 - r}A${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x} ${y}Z`} fill={color} />;
  }
  return (
    <span className="status-icon">
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="6" fill="none" stroke={color} strokeWidth="1.5" />
        {inside}
      </svg>
    </span>
  );
}

// From Lucide (ISC licence), as kanzo uses them.
const ICONS = {
  plus: <path d="M5 12h14M12 5v14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8.5V19l-4 2v-7.5z" />,
  github: (
    <>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.1-1.3-.3-2.5-1-3.5.3-1.2.3-2.4 0-3.5 0 0-1 0-3 1.5a12 12 0 0 0-8 0C6 2 5 2 5 2c-.3 1.2-.3 2.4 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.4.5-.7 1-.8 1.7-.2.6-.3 1.2-.2 1.8v4" />
      <path d="M9 18c-4.5 2-5-2-7-2" />
    </>
  ),
};
function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <span className="icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {ICONS[name]}
      </svg>
    </span>
  );
}

function BoardCard({
  card,
  activity,
  onDrag,
  onOpen,
  onMove,
  onToggleExpand,
  busy,
}: {
  card: Card;
  activity: string;
  onDrag: (card: Card | null) => void;
  onOpen: () => void;
  onMove: (column: Column) => void;
  /** An unclaimed spec card's click toggles its row of ticket sub-issue cards instead of opening the detail. */
  onToggleExpand?: () => void;
  busy: boolean;
}) {
  const issue = unclaimedNumber(card.id);
  const unclaimed = issue !== null;
  // A plain unclaimed card (no open ticket sub-issues) and a spec unclaimed card both sit in Issues.
  const plain = isPlainUnclaimedCard(card);
  const prState = card.pr?.state ?? null;
  // Every Issues card that is not a plain unclaimed card gets Solve all: an unclaimed spec issue,
  // or a session paused in `ready`.
  const solveAll = card.column === "issues" && !plain;
  const expandable = unclaimed && !plain;
  const line =
    card.attention ??
    (unclaimed
      ? plain
        ? `Issue #${issue}: Solve makes it the card's only ticket; Split breaks it into tickets when it is too big.`
        : `Spec issue #${issue}: Solve all starts its tickets; drag it to To do to rework it`
      : activity);
  return (
    // A click opens the card detail; a modified click still opens the session in a new tab.
    // An unclaimed card (plain or spec) opens its issue on GitHub with a modified click.
    <a
      className="kz-card"
      href={unclaimed ? (card.specRef ?? undefined) : `#/session/${card.id}`}
      target={unclaimed ? "_blank" : undefined}
      rel={unclaimed ? "noopener" : undefined}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.id);
        onDrag(card);
      }}
      onDragEnd={() => onDrag(null)}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        if (expandable) onToggleExpand?.();
        else onOpen();
      }}
    >
      <div className="head">
        <div className="title">{card.title}</div>
        {card.tickets.total > 0 && (
          <span className="num" title={`${card.tickets.done} of ${card.tickets.total} tickets done`}>
            {card.tickets.done}/{card.tickets.total}
          </span>
        )}
      </div>
      {line && <span className={`desc ${card.attention && !isResolvedNote(card.attention) ? "attention" : ""}`}>{line}</span>}
      {(solveAll || plain) && (
        <CardActions actions={[...(solveAll ? [SOLVE_ALL] : []), ...(plain ? [SOLVE, SPLIT] : [])]} busy={busy} onMove={(column) => onMove(column)} />
      )}
      {card.pr && (
        <span className="tags">
          <span className={`kz-tag ${prState ? `pr-${prState}` : ""}`} title={card.pr.url ?? undefined}>
            <span className="dot" />
            PR #{card.pr.number}
            {prState ? ` · ${prState}` : ""}
          </span>
        </span>
      )}
    </a>
  );
}

/**
 * One row of an unclaimed spec card's ticket sub-issues, as cards under the spec card. A sub-issue
 * with an open blocker shows "waits on #n" and disables Solve; Solve creates the spec's session
 * with that sub-issue as the solo ticket, and the row goes with the claimed card.
 */
function SpecSubcards({ card, toast, onSolved }: { card: Card; toast: (text: string, level?: "info" | "warning" | "error") => void; onSolved: () => void }) {
  const part = issueParts(card.specRef);
  const [subs, setSubs] = useState<UnclaimedSpecTickets["subIssues"] | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!part) {
      setSubs(null);
      return;
    }
    let live = true;
    api.get<UnclaimedSpecTickets>(`/api/repos/${part.owner}/${part.name}/issues/${part.number}/tickets`).then(
      (t) => live && setSubs(t.subIssues),
      () => live && setSubs(null),
    );
    return () => {
      live = false;
    };
  }, [part?.owner, part?.name, part?.number]);
  if (!part) return null;
  const solve = async (sub: number) => {
    setBusy(true);
    try {
      await api.post(`/api/repos/${part.owner}/${part.name}/issues/${part.number}/tickets/${sub}/solve`, {});
      onSolved();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  if (subs === undefined) {
    return (
      <div className="kz-sublist">
        <span className="kz-card kz-subcard muted">
          <div className="head">
            <div className="title">
              <Spinner small /> Loading the tickets…
            </div>
          </div>
        </span>
      </div>
    );
  }
  if (subs === null) {
    return (
      <div className="kz-sublist">
        <span className="kz-card kz-subcard muted">
          <div className="head">
            <div className="title">The tickets could not be read from GitHub.</div>
          </div>
        </span>
      </div>
    );
  }
  return (
    <div className="kz-sublist">
      {subs.map((s) => (
        <a key={s.number} className="kz-card kz-subcard" href={s.url} target="_blank" rel="noopener">
          <div className="head">
            <div className="title">#{s.number} {s.title}</div>
          </div>
          {s.blockedBy.length > 0 && <span className="desc">waits on {s.blockedBy.map((b) => `#${b}`).join(", ")}</span>}
          <span className="kz-card-actions">
            <button
              className="kz-btn"
              disabled={busy || s.blockedBy.length > 0}
              title={s.blockedBy.length === 0 ? "Create this spec's session and run only this ticket" : "Solve waits for the sub-issues that block it"}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                void solve(s.number);
              }}
            >
              {busy ? <Spinner small /> : "Solve"}
            </button>
          </span>
        </a>
      ))}
    </div>
  );
}

/** The kanban view of one repo's features: one card per pipeline session, in kanzo's look. */
export function Board({ repoId }: { repoId?: string }) {
  const { sessions, boardChanges, toast } = useStore();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragged, setDragged] = useState<Card | null>(null);
  const [over, setOver] = useState<Column | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refetch, setRefetch] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  // The unclaimed spec card whose row of ticket sub-issues is open; a click toggles it.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [doneHidden, setDoneHidden] = useState(0);
  const [doneLimit, setDoneLimit] = useState(DONE_PAGE);
  const [creating, setCreating] = useState(false);
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<Repo[]>("/api/repos").then(setRepos, (e) => setError(e.message));
  }, []);

  const repo = repos && (repos.find((r) => r.id === repoId) ?? repos.find((r) => r.id === lastBoardRepo()) ?? repos[0]);
  useEffect(() => {
    if (repo) rememberBoardRepo(repo.id);
  }, [repo?.id]);

  // Refetch the board when one of this repo's sessions changes what its card shows (direct cards too).
  const mine = Object.values(sessions).filter((s) => s.repoId === repo?.id);
  const key = mine
    .map((s) => `${s.id}:${s.phase}:${s.attention ?? ""}:${s.tickets.map((t) => t.status).join(",")}:${s.prNumber ?? ""}:${s.title}`)
    .sort()
    .join("|");
  // A drag or open dialog pauses refetching: a refetch would snap the dragged card back or reset
  // the dialog. The ref keeps the effects' dep lists stable, so a drag or dialog never triggers a
  // refetch of its own; it only stops the next one from running.
  const paused = dragged !== null || openId !== null || creating || searching;
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    if (!repo || pausedRef.current) return;
    let live = true;
    api.get<{ cards: Card[]; doneHidden: number }>(`/api/board?repo=${encodeURIComponent(repo.id)}&done=${doneLimit}`).then(
      (b) => live && (setCards(b.cards), setDoneHidden(b.doneHidden), setError(null)),
      (e) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [repo?.id, key, doneLimit, refetch, repo ? boardChanges[repo.id] : 0]);

  // Auto refetch: about every 30 seconds while the tab is visible, and at once when the tab comes
  // back (window focus or visibilitychange). A hidden tab and a paused board make no GitHub calls.
  useEffect(() => {
    const auto = () => {
      if (document.visibilityState !== "visible" || pausedRef.current) return;
      setRefetch((n) => n + 1);
    };
    const timer = setInterval(auto, 30_000);
    document.addEventListener("visibilitychange", auto);
    window.addEventListener("focus", auto);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", auto);
      window.removeEventListener("focus", auto);
    };
  }, []);

  // A move is a command to the server. The card changes column only when the server accepts it;
  // a refused move leaves it where it was (it snaps back) and shows why. A drag and a card button
  // move the same way, through the same routes.
  const moveCard = (card: Card, column: Column) => {
    if (card.column === column || !repo) return;
    setBusyId(card.id);
    // An unclaimed card's move creates its session; the server answers with that session.
    const issue = unclaimedNumber(card.id);
    const url = issue !== null ? `/api/repos/${repo.id}/issues/${issue}/move` : `/api/sessions/${card.id}/move`;
    api.post(url, { column }).then(
      () => (setError(null), setRefetch((n) => n + 1)),
      (e) => setError(e.message),
    ).finally(() => setBusyId(null));
  };

  const drop = (column: Column) => {
    const card = dragged;
    setDragged(null);
    setOver(null);
    if (!card) return;
    // Review → Done is Approve: it merges the PR, so it asks first.
    if (card.column === "review" && column === "done" && !confirm(approveQuestion(card))) return;
    moveCard(card, column);
  };

  // A board of another repo starts again with the first page of Done.
  useEffect(() => setDoneLimit(DONE_PAGE), [repo?.id]);

  // The board's keys: n new card, / or ⌘K search, f filter. None fires while you type in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (creating || searching || !repo) return;
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearching(true);
        return;
      }
      if (typingIn(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        setSearching(true);
      } else if (e.key === "n") {
        e.preventDefault();
        setCreating(true);
      } else if (e.key === "f") {
        e.preventDefault();
        filterRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creating, searching, repo?.id]);

  const words = wordsOf(filter);
  const byColumn = useMemo(() => {
    const m = new Map<Column, Card[]>(COLUMNS.map((c) => [c.id, []]));
    for (const c of cards ?? []) if (matches(c, words)) m.get(c.column)?.push(c);
    return m;
  }, [cards, filter]);

  const open = openId ? (cards ?? []).find((c) => c.id === openId) : undefined;
  const closeDetail = useCallback(() => setOpenId(null), []);

  if (repos && repos.length === 0) {
    return (
      <div className="kz-board">
        <div className="kz-empty">
          <h1>Welcome to the board</h1>
          <p>Add a GitHub token on Secrets, then track a repo. Each repo gets its own board.</p>
          <a className="kz-btn primary" href="#/repos">
            Track a repo
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="kz-board">
      <header className="kz-header">
        <div className="info">
          <h1>{repo?.name ?? "Board"}</h1>
          {/* Every card, the Done cards behind "Show more" included, as the Done column counts them. */}
          {cards && <span className="sub">{`${cards.length + doneHidden} card${cards.length + doneHidden === 1 ? "" : "s"}`}</span>}
          {repo && (
            <a className="repo-link" href={`https://github.com/${repo.id}`} target="_blank" rel="noopener" title={`Open ${repo.id} on GitHub`}>
              <Icon name="github" />
              {repo.id}
            </a>
          )}
        </div>
        {repo && (
          <div className="kz-tools">
            <label className={`kz-filter ${words.length ? "on" : ""}`} title="Filter the board (f)">
              <Icon name="filter" />
              <input
                ref={filterRef}
                placeholder="Filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setFilter("");
                    e.currentTarget.blur();
                  }
                }}
              />
            </label>
            <button className="kz-btn" onClick={() => setSearching(true)} title="Search cards (/ or ⌘K)" aria-label="Search cards">
              <Icon name="search" />
            </button>
            <button className="kz-btn primary" onClick={() => setCreating(true)} title="New card (n)">
              <Icon name="plus" />
              New card
            </button>
          </div>
        )}
      </header>
      {/* Over the board, not in the header, so a long refusal does not push the columns down. */}
      {error && (
        <div className="kz-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      <div className="kz-columns">
        {COLUMNS.map((col) => {
          const list = byColumn.get(col.id) ?? [];
          return (
            <section
              key={col.id}
              className={`kz-column ${over === col.id && dragged?.column !== col.id ? "drop-target" : ""}`}
              data-column={col.id}
              onDragOver={(e) => {
                if (!dragged) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (over !== col.id) setOver(col.id);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(col.id);
              }}
            >
              <h2>
                <StatusIcon column={col.id} />
                {col.label}
                <span className="count">{(list.length + (col.id === "done" && !words.length ? doneHidden : 0)) || ""}</span>
              </h2>
              <div className="kz-cards">
                {list.map((c) => (
                  <Fragment key={c.id}>
                    <BoardCard
                      card={c}
                      activity={sessions[c.id]?.activity ?? ""}
                      onDrag={setDragged}
                      onOpen={() => setOpenId(c.id)}
                      onMove={(column) => moveCard(c, column)}
                      onToggleExpand={() => setExpandedId(expandedId === c.id ? null : c.id)}
                      busy={busyId === c.id}
                    />
                    {expandedId === c.id && unclaimedNumber(c.id) !== null && !isPlainUnclaimedCard(c) && (
                      <SpecSubcards
                        card={c}
                        toast={toast}
                        onSolved={() => {
                          setExpandedId(null);
                          setRefetch((n) => n + 1);
                        }}
                      />
                    )}
                  </Fragment>
                ))}
                {col.id === "done" && doneHidden > 0 && (
                  <button className="kz-more" onClick={() => setDoneLimit((n) => n + DONE_PAGE)}>
                    Show {Math.min(doneHidden, DONE_PAGE)} more
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {open && <CardDetail card={open} onClose={closeDetail} />}
      {creating && repo && (
        <NewCard
          repoId={repo.id}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
        />
      )}
      {searching && (
        <Search
          cards={cards ?? []}
          onClose={() => setSearching(false)}
          onPick={(id) => {
            setSearching(false);
            setOpenId(id);
          }}
        />
      )}
    </div>
  );
}
