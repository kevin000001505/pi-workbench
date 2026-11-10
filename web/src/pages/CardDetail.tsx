import { useEffect, useState } from "react";
import type { Card } from "../../../shared/board.ts";
import { COLUMNS, isPlainUnclaimedCard, issueNumberOf, parseIssueRef, refLabel, unclaimedNumber } from "../../../shared/board.ts";
import { api } from "../api.ts";
import { PendingCard } from "../session/PendingCard.tsx";
import { phaseLabel } from "../session/PipelinePanel.tsx";
import { useStore } from "../store.tsx";
import { isResolvedNote, type SessionSummary, type Ticket, type UnclaimedSpecTickets } from "../types.ts";
import { Markdown, Spinner } from "../ui.tsx";
import { CardActions, SOLVE, SPLIT } from "./CardActions.tsx";

/** The TICKET_STATE labels for a card's tickets; the board's ticket sub-cards use the same map. */
export const TICKET_STATE: Record<Ticket["status"], string> = { ready: "Ready", running: "Running", done: "Done", blocked: "Blocked" };

/**
 * The issue behind a card's spec ref, split for the /api/repos routes; null when the ref is not
 * an issue link (a file path, or nothing).
 */
export const issueParts = (specRef: string | null) => {
  const ref = parseIssueRef(specRef);
  if (!ref?.repo) return null;
  const [owner, name] = ref.repo.split("/");
  return { owner, name, number: ref.number };
};

/**
 * One ticket row of a card detail: the state, a live dot on the running ticket, "waits on #n" for
 * blockers that are not done, Solve on a ticket the card can solve (disabled otherwise), and a link:
 * the run link for a ticket with a run, the GitHub issue for a tracker ref that names an issue of
 * this repo, no link for any other ticket.
 */
function TicketRow({ s, t, busy, onSolve }: { s: SessionSummary; t: Ticket; busy: boolean; onSolve: (num: number) => void }) {
  const done = new Set(s.tickets.filter((x) => x.status === "done").map((x) => x.num));
  const waitingOn = t.blockedBy.filter((b) => !done.has(b));
  const issue = issueNumberOf(t.trackerRef, s.repoId);
  const link = t.runId
    ? `#/session/${s.id}?run=${t.runId}`
    : issue !== null
      ? `https://github.com/${s.repoId}/issues/${issue}`
      : undefined;
  // A card in Issues can solve a ticket that is not done or blocked and has every blocker done;
  // a ticket a stopped run left `running` counts as ready and gets a fresh run.
  const solveShown = s.phase === "ready" && (t.status === "ready" || t.status === "running");
  const canSolve = solveShown && waitingOn.length === 0;
  return (
    <li className={`t-${t.status}`}>
      <div className="row">
        <span className="state">{TICKET_STATE[t.status]}</span>
        {t.status === "running" && <span className="live-dot" />}
        <span className="title">
          {link ? (
            <a href={link} target="_blank" rel="noopener">
              #{t.num} {t.title}
            </a>
          ) : (
            `#${t.num} ${t.title}`
          )}
        </span>
        {t.trackerRef && !link && <span className="mono">{refLabel(t.trackerRef)}</span>}
        {waitingOn.length > 0 && <span className="waits">waits on {waitingOn.map((b) => `#${b}`).join(", ")}</span>}
        {solveShown && (
          <button
            className="kz-btn ticket-solve"
            disabled={!canSolve || busy}
            title={canSolve ? "Run only this ticket; the card waits in Issues again when it is done" : "Solve waits for the tickets that block it"}
            onClick={() => onSolve(t.num)}
          >
            {busy ? <Spinner small /> : "Solve"}
          </button>
        )}
      </div>
      {t.note && <p className="note">{t.note}</p>}
    </li>
  );
}

/**
 * One row of an unclaimed spec card's ticket list: every open sub-issue is Ready. A row with an
 * open blocker shows "waits on #n" and disables Solve; the row's link opens the sub-issue on
 * GitHub in a new tab. Solve creates the spec's session with that sub-issue as the solo ticket.
 */
function UnclaimedTicketRow({ t, busy, onSolve }: { t: { number: number; title: string; url: string; blockedBy: number[] }; busy: boolean; onSolve: (sub: number) => void }) {
  const canSolve = t.blockedBy.length === 0;
  return (
    <li className="t-ready">
      <div className="row">
        <span className="state">Ready</span>
        <span className="title">
          <a href={t.url} target="_blank" rel="noopener">
            #{t.number} {t.title}
          </a>
        </span>
        {t.blockedBy.length > 0 && <span className="waits">waits on {t.blockedBy.map((b) => `#${b}`).join(", ")}</span>}
        <button
          className="kz-btn ticket-solve"
          disabled={!canSolve || busy}
          title={canSolve ? "Create this spec's session and run only this ticket" : "Solve waits for the sub-issues that block it"}
          onClick={() => onSolve(t.number)}
        >
          {busy ? <Spinner small /> : "Solve"}
        </button>
      </div>
    </li>
  );
}

/**
 * A card's detail, beside the board: the spec, the tickets with their notes, the review note, the
 * PR, the attention with retry and skip, and the session's pending decisions and permissions, which
 * you answer here with the same PendingCard as the session view. The link opens the full transcript.
 */
export function CardDetail({ card, onClose }: { card: Card; onClose: () => void }) {
  const { sessions, toast } = useStore();
  const s = sessions[card.id];
  const plain = isPlainUnclaimedCard(card);
  const unclaimedSpec = unclaimedNumber(card.id) !== null && !plain;
  const [busy, setBusy] = useState(false);

  // An unclaimed spec card has no session yet: its ticket list comes from the spec's open sub-issues.
  const [specTickets, setSpecTickets] = useState<UnclaimedSpecTickets | null | undefined>(undefined);
  useEffect(() => {
    if (!unclaimedSpec) return;
    const part = issueParts(card.specRef);
    if (!part) {
      setSpecTickets(null);
      return;
    }
    let live = true;
    api.get<UnclaimedSpecTickets>(`/api/repos/${part.owner}/${part.name}/issues/${part.number}/tickets`).then(
      (t) => live && setSpecTickets(t),
      () => live && setSpecTickets(null),
    );
    return () => {
      live = false;
    };
  }, [unclaimedSpec, card.specRef]);

  // A plain unclaimed card has no session: read its issue body from the API it was read from.
  const [issueBody, setIssueBody] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!plain) return;
    const part = issueParts(card.specRef);
    if (!part) {
      setIssueBody(null);
      return;
    }
    let live = true;
    api.get<{ body: string | null }>(`/api/github/issues/${part.owner}/${part.name}/${part.number}`).then(
      (i) => live && setIssueBody(i.body),
      () => live && setIssueBody(null),
    );
    return () => {
      live = false;
    };
  }, [plain, card.specRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The same pipeline actions as the session view's pipeline panel.
  const act = async (action: "retry" | "skip") => {
    setBusy(true);
    try {
      await api.post(`/api/sessions/${card.id}/pipeline`, { action });
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  // Approve merges the PR; GitHub's refusal or a conflict comes back as the card's attention.
  const approve = async () => {
    if (!confirm(approveQuestion(card))) return;
    setBusy(true);
    try {
      await api.post(`/api/sessions/${card.id}/approve`, {});
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  // A plain card's move creates its session: the unclaimed card goes, and this detail closes with it.
  const movePlain = async (column: "doing" | "todo") => {
    setBusy(true);
    const part = issueParts(card.specRef);
    try {
      if (!part) throw new Error("The card has no issue link to move");
      await api.post(`/api/repos/${part.owner}/${part.name}/issues/${part.number}/move`, { column });
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  // Solve one sub-issue of an unclaimed spec card: it creates the spec's session with that
  // sub-issue as the solo ticket. The unclaimed card goes, and this detail closes with it.
  const solveUnclaimed = async (sub: number) => {
    setBusy(true);
    const part = issueParts(card.specRef);
    try {
      if (!part) throw new Error("The card has no issue link to solve");
      await api.post(`/api/repos/${part.owner}/${part.name}/issues/${part.number}/tickets/${sub}/solve`, {});
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  // Abandon drops the feature: the server closes the PR, deletes the branch, the worktree and the
  // card, and a wb_board makes every board refetch, so this panel closes as the card goes.
  const abandon = async () => {
    if (!confirm(abandonQuestion(card))) return;
    setBusy(true);
    try {
      await api.post(`/api/sessions/${card.id}/abandon`, {});
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  // Solve one ticket: the card's session runs only that ticket, then waits in Issues again.
  const solveTicket = async (num: number) => {
    setBusy(true);
    try {
      await api.post(`/api/sessions/${s!.id}/tickets/${num}/solve`, {});
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const column = COLUMNS.find((c) => c.id === card.column)?.label ?? card.column;
  const specRef = s?.specRef ?? card.specRef;
  const prUrl = card.pr?.url ?? s?.prUrl ?? null;
  const attention = s?.attention ?? card.attention;
  const canAct = s && (s.phase === "implement" || s.phase === "review");

  return (
    <>
      <div className="kz-detail-backdrop" onClick={onClose} />
      <aside className="kz-detail" role="dialog" aria-label={card.title}>
        <header className="kz-detail-head">
          <div className="info">
            <h2>{card.title}</h2>
            <span className="sub">
              {column}
              {s && phaseLabel(s) ? ` · ${phaseLabel(s)}` : ""}
            </span>
          </div>
          <button className="kz-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="kz-detail-links">
          {!plain && !unclaimedSpec && (
            <a className="kz-btn" href={`#/session/${card.id}`} target="_blank" rel="noopener">
              Open the full transcript
            </a>
          )}
          {(plain || unclaimedSpec) && (
            <a className="kz-btn" href={card.specRef ?? undefined} target="_blank" rel="noopener">
              Open on GitHub
            </a>
          )}
          {plain && (
            <CardActions actions={[{ ...SOLVE, primary: true }, SPLIT]} busy={busy} spinner flat onMove={(column) => movePlain(column)} />
          )}
          {card.pr && (
            <a className={`kz-tag kz-pr ${card.pr.state ? `pr-${card.pr.state}` : ""}`} href={prUrl ?? undefined} target="_blank" rel="noopener">
              <span className="dot" />
              PR #{card.pr.number}
              {card.pr.state ? ` · ${card.pr.state}` : ""}
            </a>
          )}
          {s?.phase === "pr" && (
            <button className="kz-btn primary" disabled={busy} onClick={approve} title="Merge the PR, delete the branch and the worktree">
              {busy ? <Spinner small /> : null} Approve
            </button>
          )}
          {!plain && !unclaimedSpec && card.column !== "done" && (
            <button className="kz-btn danger" disabled={busy} onClick={abandon} title="Stop the runs, close the PR, delete the branch, the worktree and the card; the issues stay open">
              Abandon
            </button>
          )}
        </div>

        {attention && (
          <section className={`kz-detail-attention ${isResolvedNote(attention) ? "info" : ""}`}>
            <p>{attention}</p>
            {canAct && (
              <div className="actions">
                <button className="kz-btn" disabled={busy} onClick={() => act("retry")}>
                  {s.phase === "review" ? "Retry review" : "Retry ticket"}
                </button>
                <button className="kz-btn" disabled={busy} onClick={() => act("skip")}>
                  Mark done &amp; continue
                </button>
              </div>
            )}
          </section>
        )}

        {plain ? (
          <section className="kz-detail-section">
            <h3>Issue {unclaimedNumber(card.id)}</h3>
            {issueBody === undefined ? (
              <p className="kz-detail-muted">
                <Spinner small /> Loading the issue…
              </p>
            ) : issueBody ? (
              <Markdown text={issueBody} />
            ) : (
              <p className="kz-detail-muted">The issue has no body.</p>
            )}
          </section>
        ) : unclaimedSpec ? (
          <section className="kz-detail-section">
            <h3>
              Tickets <span className="kz-detail-muted">{specTickets ? `${specTickets.subIssues.length} open` : ""}</span>
            </h3>
            {specTickets === undefined ? (
              <p className="kz-detail-muted">
                <Spinner small /> Loading the tickets…
              </p>
            ) : specTickets === null ? (
              <p className="kz-detail-muted">The tickets could not be read from GitHub.</p>
            ) : specTickets.subIssues.length === 0 ? (
              <p className="kz-detail-muted">This spec has no open tickets.</p>
            ) : (
              <ol className="kz-detail-tickets">
                {specTickets.subIssues.map((t) => (
                  <UnclaimedTicketRow key={t.number} t={t} busy={busy} onSolve={solveUnclaimed} />
                ))}
              </ol>
            )}
          </section>
        ) : !s ? (
          <p className="kz-detail-muted">
            <Spinner small /> Loading the session…
          </p>
        ) : (
          <>
            {s.pending.length > 0 && (
              <section className="kz-detail-pending">
                {s.pending.map((r) => (
                  <PendingCard key={r.id} sessionId={s.id} req={r} />
                ))}
              </section>
            )}

            {s.grillSummary && (
              <details className="kz-detail-section">
                <summary>Agreed decisions</summary>
                <Markdown text={s.grillSummary} />
              </details>
            )}

            {(s.spec || specRef) && (
              <details className="kz-detail-section" open={!!s.spec}>
                <summary>
                  Spec{" "}
                  {specRef &&
                    (/^https?:\/\//.test(specRef) ? (
                      <a href={specRef} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>
                        {refLabel(specRef)}
                      </a>
                    ) : (
                      <span className="mono">{refLabel(specRef)}</span>
                    ))}
                </summary>
                {s.spec ? <Markdown text={s.spec} /> : <p className="kz-detail-muted">The spec text is on the tracker.</p>}
              </details>
            )}

            {s.tickets.length > 0 && (
              <section className="kz-detail-section">
                <h3>
                  Tickets <span className="kz-detail-muted">{card.tickets.done}/{card.tickets.total} done</span>
                </h3>
                <ol className="kz-detail-tickets">
                  {s.tickets.map((t) => (
                    <TicketRow key={t.num} s={s} t={t} busy={busy} onSolve={solveTicket} />
                  ))}
                </ol>
              </section>
            )}

            {s.reviewNote && (
              <section className="kz-detail-section">
                <h3>Review note</h3>
                <p>{s.reviewNote}</p>
              </section>
            )}
          </>
        )}
      </aside>
    </>
  );
}

/** The confirm text for Abandon, the same from the board card and the card detail. */
export const abandonQuestion = (card: Card) =>
  `Abandon "${card.title}"? This stops its runs${card.pr ? `, closes PR #${card.pr.number} without merging it` : ""}, and deletes its branch, its worktree and the card. The GitHub issues stay open.`;

/** The confirm text for Approve, the same from the drag and from the card detail. */
export const approveQuestion = (card: Card) =>
  `Approve "${card.title}"? This merges PR #${card.pr?.number ?? "?"} with a merge commit, then deletes its branch and worktree.`;
