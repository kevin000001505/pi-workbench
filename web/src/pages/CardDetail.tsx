import { useEffect, useState } from "react";
import type { Card } from "../../../shared/board.ts";
import { COLUMNS, isPlainUnclaimedCard, parseIssueRef, refLabel, unclaimedNumber } from "../../../shared/board.ts";
import { api } from "../api.ts";
import { PendingCard } from "../session/PendingCard.tsx";
import { phaseLabel } from "../session/PipelinePanel.tsx";
import { useStore } from "../store.tsx";
import { isResolvedNote, type Ticket } from "../types.ts";
import { Markdown, Spinner } from "../ui.tsx";

/** The TICKET_STATE labels for a card's tickets. */
const TICKET_STATE: Record<Ticket["status"], string> = { ready: "Ready", running: "Running", done: "Done", blocked: "Blocked" };

/**
 * A card's detail, beside the board: the spec, the tickets with their notes, the review note, the
 * PR, the attention with retry and skip, and the session's pending decisions and permissions, which
 * you answer here with the same PendingCard as the session view. The link opens the full transcript.
 */
export function CardDetail({ card, onClose }: { card: Card; onClose: () => void }) {
  const { sessions, toast } = useStore();
  const s = sessions[card.id];
  const plain = isPlainUnclaimedCard(card);
  const [busy, setBusy] = useState(false);

  // A plain unclaimed card has no session: read its issue body from the API it was read from.
  const [issueBody, setIssueBody] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!plain) return;
    const ref = parseIssueRef(card.specRef);
    if (!ref?.repo) {
      setIssueBody(null);
      return;
    }
    const [owner, name] = ref.repo.split("/");
    let live = true;
    api.get<{ body: string | null }>(`/api/github/issues/${owner}/${name}/${ref.number}`).then(
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
  const movePlain = async () => {
    setBusy(true);
    const ref = parseIssueRef(card.specRef);
    try {
      if (!ref?.repo) throw new Error("The card has no issue link to move");
      await api.post(`/api/repos/${ref.repo}/issues/${ref.number}/move`, { column: "doing" });
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
          {!plain && <a className="kz-btn" href={`#/session/${card.id}`}>Open the full transcript</a>}
          {plain && (
            <a className="kz-btn" href={card.specRef ?? undefined} target="_blank" rel="noopener">
              Open on GitHub
            </a>
          )}
          {plain && (
            <button className="kz-btn primary" disabled={busy} onClick={() => movePlain()} title="Make the issue the card's only ticket and start work: skips grill, spec and tickets">
              {busy ? <Spinner small /> : null} Solve
            </button>
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
          {!plain && card.column !== "done" && (
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
                    <li key={t.num} className={`t-${t.status}`}>
                      <div className="row">
                        <span className="state">{TICKET_STATE[t.status]}</span>
                        <span className="title">
                          #{t.num} {t.title}
                        </span>
                        {t.trackerRef &&
                          (/^https?:\/\//.test(t.trackerRef) ? (
                            <a href={t.trackerRef} target="_blank" rel="noopener">
                              {refLabel(t.trackerRef)}
                            </a>
                          ) : (
                            <span className="mono">{refLabel(t.trackerRef)}</span>
                          ))}
                      </div>
                      {t.note && <p className="note">{t.note}</p>}
                    </li>
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

/** The confirm text for Abandon. */
const abandonQuestion = (card: Card) =>
  `Abandon "${card.title}"? This stops its runs${card.pr ? `, closes PR #${card.pr.number} without merging it` : ""}, and deletes its branch, its worktree and the card. The GitHub issues stay open.`;

/** The confirm text for Approve, the same from the drag and from the card detail. */
export const approveQuestion = (card: Card) =>
  `Approve "${card.title}"? This merges PR #${card.pr?.number ?? "?"} with a merge commit, then deletes its branch and worktree.`;
