/**
 * The Board: one Card per pipeline session and one Card per unclaimed issue, in the columns
 * To do → Issues → Doing → QA → Review → Done. The column is computed from the session, never
 * stored. The server (GET /api/board) and the web board both use this module, like
 * shared/transcript.ts. Keep it free of server and browser imports; only other shared modules
 * (pending.ts) belong here.
 */

import { waitsOnUser, type WaitingState } from "./pending.ts";

export type Column = "todo" | "issues" | "doing" | "qa" | "review" | "done";

/** The columns in board order, with the names the board shows. */
export const COLUMNS: { id: Column; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "issues", label: "Issues" },
  { id: "doing", label: "Doing" },
  { id: "qa", label: "QA" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

const BY_PHASE: Record<string, Column> = {
  setup: "todo",
  grill: "todo",
  spec: "todo",
  tickets: "todo",
  ready: "issues",
  implement: "doing",
  review: "qa",
  retro: "qa",
  pr: "review",
  done: "done",
};

/** The column a pipeline session's phase puts its card in; null for the `direct` phase, which has no
 * pipeline column (a direct card follows only its `pr` and `done` phases, see sessionColumn). */
export function columnOf(phase: string): Column | null {
  return BY_PHASE[phase] ?? null;
}

/** The columns of a direct session: `pr` is its Review, `done` its Done, every other phase its Doing. */
const BY_DIRECT_PHASE: Record<string, Column> = { pr: "review", done: "done" };

/**
 * The column the board puts a session's card in: a pipeline card follows its phase. A direct card
 * follows only its last two phases, because a direct session never goes through grill, spec or
 * tickets: its phase `pr` (its PR is recorded) puts it in Review, `done` in Done, and every other
 * phase — setup included — keeps it in Doing.
 */
export function sessionColumn(mode: string, phase: string): Column | null {
  if (mode === "pipeline") return columnOf(phase);
  return BY_DIRECT_PHASE[phase] ?? "doing";
}

/** What a card is built from: the fields of a session summary that the board reads. */
export type CardSource = {
  id: string;
  title: string;
  mode: string;
  phase: string;
  attention: string | null;
  prNumber: number | null;
  prUrl: string | null;
  specRef: string | null;
  /** When the card reached Done; Done lists the newest first. */
  doneAt?: number | null;
  /** Each ticket's status and tracker ref: the ref tells a plain card (its only ticket is its own
   * spec issue) from a spec card. */
  tickets: { status: string; trackerRef: string | null }[];
};

/** A sub-card of a done spec issue in Done, linking to the sub-issue on GitHub. */
export type SubCard = { number: number; title: string; url: string; notPlanned: boolean };

export type Card = {
  id: string;
  title: string;
  column: Column;
  tickets: { done: number; total: number };
  attention: string | null;
  /** The card's PR; `state` is null until the workbench reads it from GitHub. */
  pr: { number: number; url: string | null; state: PrState | null } | null;
  specRef: string | null;
  /** When the card reached Done (a session card's doneAt, a done issue's close time); null for any other card. */
  doneAt: number | null;
  /** A click on the card opens a row of ticket sub-cards. */
  specCard: boolean;
  /** The sub-cards of a done spec issue card in Done; null for every other card (a started card's row comes from its session's tickets). */
  subs: SubCard[] | null;
};

/** The PR badge: open, checks (a check runs or failed), conflict (the branch does not merge), or merged. */
export type PrState = "open" | "checks" | "conflict" | "merged";

/** What the badge reads from GitHub's pull request status. */
export type PrStatus = { state: string; mergeableState: string; checks: { pending: number; failed: number } };

export function prState(s: PrStatus): PrState {
  if (s.state === "merged") return "merged";
  if (s.mergeableState === "dirty") return "conflict";
  if (s.checks.pending > 0 || s.checks.failed > 0) return "checks";
  return "open";
}

/**
 * Whether a ticket's tracker ref names the card's own spec issue: both refs resolve to the same
 * issue number, a bare number read in the card's own repo. A card whose only ticket is its own
 * issue (Solve made the issue the card's only ticket) is a plain card, not a spec card.
 */
const isOwnIssue = (ticketRef: string | null, specRef: string | null): boolean => {
  const t = parseIssueRef(ticketRef);
  const s = parseIssueRef(specRef);
  if (!t || !s) return false;
  return t.number === s.number && (t.repo === null || (s.repo !== null && t.repo.toLowerCase() === s.repo.toLowerCase()));
};

/** The card for a session, or null for a pipeline phase that has no column. */
export function cardOf(s: CardSource): Card | null {
  const column = sessionColumn(s.mode, s.phase);
  if (!column) return null;
  return {
    id: s.id,
    title: s.title,
    column,
    tickets: { done: s.tickets.filter((t) => t.status === "done").length, total: s.tickets.length },
    attention: s.attention,
    pr: s.prNumber ? { number: s.prNumber, url: s.prUrl, state: null } : null,
    specRef: s.specRef,
    doneAt: s.doneAt ?? null,
    /** More than one ticket, or one ticket that is not the card's own issue, opens a row. */
    specCard: s.tickets.length > 1 || (s.tickets.length === 1 && !isOwnIssue(s.tickets[0].trackerRef, s.specRef)),
    subs: null,
  };
}

/**
 * A whole-card action a card's buttons offer on its session, in button order. The column moves
 * (Solve all, Solve, Split) are not here: they start or rework an unclaimed card.
 */
export type BoardAction = "approve" | "stop" | "retry" | "abandon" | "answer";

/** The session facts a card's whole-card actions read. A browser's session summary satisfies it. */
export type SessionActionSource = {
  mode: string;
  phase: string;
  status: string;
  attention: string | null;
  /** The session's pending requests, read by waitsOnUser (shared/pending.ts). */
  pending: WaitingState[];
};

/**
 * The whole-card actions of a session card — the actions on the card itself, a direct card included:
 *
 * - `approve` — the card is in Review, so it can merge its PR.
 * - `abandon` — the card is not in Done, so it can still be dropped.
 * - `stop`, `retry`, `answer` — the pipeline card's own controls: a direct card has no tickets to
 *   pause and no review or retro to re-run, and it answers a decision in the card detail.
 *
 * A card with no session (an unclaimed card, a done issue card) has none.
 */
export function boardCardActions(card: { column: Column }, s: SessionActionSource | undefined): BoardAction[] {
  if (!s) return [];
  const pipeline = s.mode === "pipeline";
  const actions: BoardAction[] = [];
  if (s.phase === "pr") actions.push("approve");
  if (pipeline && (s.phase === "implement" || s.phase === "review" || s.phase === "retro") && (s.status === "running" || s.status === "waiting"))
    actions.push("stop");
  if (pipeline && (s.phase === "review" || s.phase === "retro") && s.attention) actions.push("retry");
  if (card.column !== "done") actions.push("abandon");
  if (pipeline && s.pending.some(waitsOnUser)) actions.push("answer");
  return actions;
}

/**
 * Whether dragging this card into `column` is Approve — it merges the card's PR, so the board asks
 * for a confirmation first. Only Review to Done is Approve, for a direct card as for a spec card.
 */
export const isApproveMove = (card: { column: Column }, column: Column) => card.column === "review" && column === "done";

/** How many Done cards the board shows at first, and how many more each "show more" adds. */
export const DONE_PAGE = 20;

/** Keep the newest `limit` Done cards of a board (cards in boardCards order); say how many are hidden. */
export function limitDone(cards: Card[], limit: number): { cards: Card[]; doneHidden: number } {
  let done = 0;
  const kept = cards.filter((c) => c.column !== "done" || ++done <= limit);
  return { cards: kept, doneHidden: cards.length - kept.length };
}

/**
 * The cards of these sessions in column order, then the unclaimed cards (which sit in Issues);
 * inside a column, in the order given, except Done, which lists the newest first by when
 * each card got there (a session card's doneAt, a done issue card's close time).
 */
export function boardCards(sessions: CardSource[], unclaimed: Card[] = []): Card[] {
  const order = new Map(COLUMNS.map((c, i) => [c.id, i]));
  return [...sessions.map(cardOf).filter((c): c is Card => c !== null), ...unclaimed]
    .sort((a, b) => order.get(a.column)! - order.get(b.column)! || (a.column === "done" ? (b.doneAt ?? 0) - (a.doneAt ?? 0) : 0));
}

/**
 * An open issue on GitHub as the board reads it: a spec issue (it has open ticket sub-issues) or a
 * plain issue. `hasParent` says whether it is a sub-issue of another issue, as a ticket issue is.
 */
export type BoardIssue = { number: number; title: string; url: string; openTickets: number; hasParent: boolean };

/** An unclaimed card's id: `issue:<number>` of its issue, as it has no session yet. */
export const unclaimedId = (number: number) => `issue:${number}`;

/** The issue number of an unclaimed card's id (`issue:<number>`); null for a session's card. */
export function unclaimedNumber(id: string): number | null {
  const m = /^issue:(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/**
 * A plain unclaimed card: an unclaimed card for an open issue without tickets (`tickets.total === 0`);
 * a spec unclaimed card has open ticket sub-issues. Both sit in Issues; a session card is never plain.
 */
export const isPlainUnclaimedCard = (card: { id: string; tickets: { total: number } }) => {
  const n = unclaimedNumber(card.id);
  return n !== null && card.tickets.total === 0;
};

/**
 * The issue an issue ref names: `owner/name#12` or the issue's GitHub URL (with its repo), or
 * `#12` and `12` (no repo: the repo the ref is read in). Null for any other ref (a spec file path).
 */
export function parseIssueRef(ref: string | null): { repo: string | null; number: number } | null {
  const r = (ref ?? "").trim();
  const bare = /^#?(\d+)$/.exec(r);
  if (bare) return { repo: null, number: Number(bare[1]) };
  const m = /^([^/\s]+\/[^/#\s]+)#(\d+)$/.exec(r) ?? /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/.exec(r);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/**
 * A ref's short label: `name#12` for an issue ref that names a repo (`owner/name#12` or the
 * issue's URL), `#12` for one that does not, and the file name for any other ref (a local ticket
 * or spec file).
 */
export function refLabel(ref: string): string {
  const issue = parseIssueRef(ref);
  if (!issue) return ref.split("/").pop() || ref;
  return issue.repo ? `${issue.repo.split("/").pop()}#${issue.number}` : `#${issue.number}`;
}

/**
 * The issue number in `repoId` that a session's issue or spec ref names (see parseIssueRef).
 * Null for any other ref (a spec file path, another repo's issue).
 */
export function issueNumberOf(ref: string | null, repoId: string): number | null {
  const issue = parseIssueRef(ref);
  if (!issue || (issue.repo !== null && issue.repo.toLowerCase() !== repoId.toLowerCase())) return null;
  return issue.number;
}

/** What a session carries for its issue claims: mode and phase decide whether it claims at all. */
export type IssueClaimSource = { mode: string; phase: string; issueRef: string | null; specRef: string | null };

/**
 * The refs (issue ref and spec ref) that the sessions claim. Only a pipeline card that is not Done
 * claims its issues: a direct session or a merged card leaves them free for a new card.
 */
export function claimRefs(sessions: IssueClaimSource[]): (string | null)[] {
  return sessions.filter((s) => s.mode === "pipeline" && s.phase !== "done").flatMap((s) => [s.issueRef, s.specRef]);
}

/**
 * The unclaimed cards: the open issues that no claim (see claimRefs) names, minus sub-issues of
 * another issue (a ticket issue stays inside its spec's card) and minus the numbers this board
 * load recorded as done (they are on the board in Done, not in Issues). A spec issue (it has open
 * tickets) and a plain issue (none) both show in Issues. A move of either card to Doing or To do
 * gives it its session; a stale move of a sub-issue's number is refused (409), as its spec's card
 * owns it.
 */
export function unclaimedCards(issues: BoardIssue[], claims: (string | null)[], repoId: string, doneNumbers: number[] = []): Card[] {
  const claimed = new Set(claims.map((r) => issueNumberOf(r, repoId)));
  const done = new Set(doneNumbers);
  return issues
    .filter((i) => !claimed.has(i.number) && !i.hasParent && !done.has(i.number))
    .map((i) => ({
      id: unclaimedId(i.number),
      title: i.title,
      column: "issues" as const,
      tickets: { done: 0, total: i.openTickets },
      attention: null,
      pr: null,
      specRef: i.url,
      doneAt: null,
      specCard: i.openTickets > 0,
      subs: null,
    }));
}

/**
 * The Issue queue's snapshot (issue #103): the issue numbers of the cards the Issues column holds
 * now, lowest first. An unclaimed card is its own number; a card the pipeline paused in Issues is
 * the issue its session works on. A card outside Issues, a card with no GitHub issue to order by,
 * and another repo's issue are not in it. "Solve all issues" starts the cards one at a time in this
 * order, and an issue that appears after the snapshot is not in it.
 */
export function queueNumbers(unclaimed: Card[], sessions: IssueClaimSource[], repoId: string): number[] {
  const numbers = new Set<number>();
  for (const c of unclaimed) {
    const n = unclaimedNumber(c.id);
    if (n !== null) numbers.add(n);
  }
  for (const s of sessions) {
    if (sessionColumn(s.mode, s.phase) !== "issues") continue;
    const n = issueNumberOf(s.issueRef, repoId) ?? issueNumberOf(s.specRef, repoId);
    if (n !== null) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}

/** The Issue queue's state, as the board reads it: the numbers it still has to start, plus the card it waits on. */
export type IssueQueueState = { running: boolean; numbers: number[]; paused: number | null };

/**
 * The Issue queue's state from its stored steps (the issue_queue rows): a queue runs while it has a
 * card to start — one waiting, or the one it waits on — and its numbers are those cards, still in
 * issue-number order. A card the queue waits on that is stuck holds its place in the numbers and is
 * the `paused` number (issue #104): the queue starts no next card until the user resolves it or drops
 * it. A step that reached Review (done) or was skipped is not one of them, and a queue with no steps
 * left states nothing.
 */
export function issueQueueState(steps: { number: number; state: string }[]): IssueQueueState {
  const live = steps.filter((s) => s.state === "waiting" || s.state === "running" || s.state === "paused");
  return {
    running: live.length > 0,
    numbers: live.map((s) => s.number),
    paused: steps.find((s) => s.state === "paused")?.number ?? null,
  };
}

/** An issue a merged card closed, as the board's Done column reads it. */
export type DoneIssue = {
  number: number;
  title: string;
  url: string;
  closedAt: number;
  /** The spec issue this issue is a ticket of, when the delivery recorded one. */
  parent?: number | null;
  /** The card that closed this issue, when the delivery recorded one. */
  sessionId?: string | null;
  /** Closed as "not planned" by the board, when a hand-closed spec dropped it. */
  notPlanned?: boolean;
};

/**
 * The issues a merged card closed, as cards in Done: one per issue, with the time it closed so
 * Done lists them newest first, beside the merged cards. The id is the unclaimed card's id, so
 * an issue reopened on GitHub keeps its card identity.
 *
 * An issue whose closing session is on the board is not a card: it sits in that card's row. An
 * issue whose parent is a card of its own nests under it as a sub-card, and a done spec with
 * recorded sub-issues is a spec card. Rows from before the parent and session columns are flat
 * cards of their own, as before.
 */
export function doneIssueCards(issues: DoneIssue[], sessionIds: string[] = []): Card[] {
  const listed = new Set(sessionIds);
  const own = issues.filter((i) => !(i.sessionId && listed.has(i.sessionId)));
  const numbers = new Set(own.map((i) => i.number));
  const parentOf = (n: number) => own.find((i) => i.number === n)?.parent;
  const nested = own.filter((i) => {
    const p = i.parent;
    return p !== null && p !== undefined && numbers.has(p) && !numbers.has(parentOf(p) ?? -1);
  });
  const nestedNumbers = new Set(nested.map((i) => i.number));
  const cards = own.filter((i) => !nestedNumbers.has(i.number));
  const subsOf = (n: number): SubCard[] | null => {
    const subs = nested.filter((i) => i.parent === n);
    return subs.length ? subs.map((i) => ({ number: i.number, title: i.title, url: i.url, notPlanned: !!i.notPlanned })) : null;
  };
  return cards.map((i) => {
    const subs = subsOf(i.number);
    return {
      id: unclaimedId(i.number),
      title: i.title,
      column: "done" as const,
      tickets: { done: 0, total: 0 },
      attention: null,
      pr: null,
      specRef: i.url,
      doneAt: i.closedAt,
      specCard: !!subs,
      subs,
    };
  });
}

/**
 * The card's note after a resolved merge conflict is pushed (SessionManager.pushResolved): it
 * asks for a second Approve. `note` is the merge run's own word on the resolution, if any.
 */
export const resolvedNote = (base: string, note?: string | null) =>
  `The merge conflict with ${base} is resolved and pushed${note ? ` (${note})` : ""}. Read the resolution, then approve again.`;

/** Whether a card's note is the resolvedNote: not an error, so the UI shows it in the neutral style. */
export const isResolvedNote = (text: string | null | undefined) =>
  !!text && text.startsWith("The merge conflict with ") && text.includes(" is resolved and pushed");
