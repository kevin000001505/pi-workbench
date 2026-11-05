/**
 * The Board: one Card per pipeline session and one Card per unclaimed issue, in the columns
 * To do → Issues → Doing → QA → Review → Done. The column is computed from the session, never
 * stored. The server (GET /api/board) and the web board both use this module, like
 * shared/transcript.ts. Keep it free of server and browser imports.
 */

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

/** The column a session's phase puts its card in; null for the `direct` phase, which has no pipeline
 * column. A direct session's card sits in Doing all the while (see sessionColumn). */
export function columnOf(phase: string): Column | null {
  return BY_PHASE[phase] ?? null;
}

/**
 * The column the board puts a session's card in: a pipeline card follows its phase, and a direct
 * card sits in Doing all the while (even while it sets up, and even with a PR badge), because a
 * direct session never goes through grill, spec or tickets.
 */
export function sessionColumn(mode: string, phase: string): Column | null {
  return mode === "pipeline" ? columnOf(phase) : "doing";
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
  tickets: { status: string }[];
};

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
  };
}

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

/**
 * The refs (issue ref and spec ref) that the sessions claim. Only a pipeline card that is not Done
 * claims its issues: a direct session or a merged card leaves them free for a new card.
 */
export function claimRefs(sessions: { mode: string; phase: string; issueRef: string | null; specRef: string | null }[]): (string | null)[] {
  return sessions.filter((s) => s.mode === "pipeline" && s.phase !== "done").flatMap((s) => [s.issueRef, s.specRef]);
}

/**
 * The unclaimed cards: the open issues that no claim (see claimRefs) names, minus sub-issues of
 * another issue (a ticket issue stays inside its spec's card). A spec issue (it has open tickets)
 * and a plain issue (none) both show in Issues. A move of either card to Doing or To do gives it
 * its session; a stale move of a sub-issue's number is refused (409), as its spec's card owns it.
 */
export function unclaimedCards(issues: BoardIssue[], claims: (string | null)[], repoId: string): Card[] {
  const claimed = new Set(claims.map((r) => issueNumberOf(r, repoId)));
  return issues
    .filter((i) => !claimed.has(i.number) && !i.hasParent)
    .map((i) => ({
      id: unclaimedId(i.number),
      title: i.title,
      column: "issues" as const,
      tickets: { done: 0, total: i.openTickets },
      attention: null,
      pr: null,
      specRef: i.url,
      doneAt: null,
    }));
}

/** An issue a merged card closed, as the board's Done column reads it. */
export type DoneIssue = { number: number; title: string; url: string; closedAt: number };

/**
 * The issues a merged card closed, as cards in Done: one per issue, with the time it closed so
 * Done lists them newest first, beside the merged cards. The id is the unclaimed card's id, so
 * an issue reopened on GitHub keeps its card identity.
 */
export function doneIssueCards(issues: DoneIssue[]): Card[] {
  return issues.map((i) => ({
    id: unclaimedId(i.number),
    title: i.title,
    column: "done" as const,
    tickets: { done: 0, total: 0 },
    attention: null,
    pr: null,
    specRef: i.url,
    doneAt: i.closedAt,
  }));
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
