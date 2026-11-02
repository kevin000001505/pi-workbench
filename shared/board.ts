/**
 * The Board: one Card per pipeline session, in the columns To do → Issues → Doing → QA → Review → Done.
 * The column is computed from the session, never stored. The server (GET /api/board) and the web
 * board both use this module, like shared/transcript.ts. Keep it free of server and browser imports.
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

/** The column a session's phase puts its card in; null for a phase that is no card (direct). */
export function columnOf(phase: string): Column | null {
  return BY_PHASE[phase] ?? null;
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
};

/** The PR badge: open, checks (a check runs or failed), or conflict (the branch does not merge). */
export type PrState = "open" | "checks" | "conflict";

/** What the badge reads from GitHub's pull request status. */
export type PrStatus = { state: string; mergeableState: string; checks: { pending: number; failed: number } };

export function prState(s: PrStatus): PrState {
  if (s.mergeableState === "dirty") return "conflict";
  if (s.checks.pending > 0 || s.checks.failed > 0) return "checks";
  return "open";
}

export function cardOf(s: CardSource): Card | null {
  const column = s.mode === "pipeline" ? columnOf(s.phase) : null;
  if (!column) return null;
  return {
    id: s.id,
    title: s.title,
    column,
    tickets: { done: s.tickets.filter((t) => t.status === "done").length, total: s.tickets.length },
    attention: s.attention,
    pr: s.prNumber ? { number: s.prNumber, url: s.prUrl, state: null } : null,
    specRef: s.specRef,
  };
}

/** The cards of these sessions in column order; inside a column, in the order given. */
export function boardCards(sessions: CardSource[]): Card[] {
  const order = new Map(COLUMNS.map((c, i) => [c.id, i]));
  return sessions
    .map(cardOf)
    .filter((c): c is Card => c !== null)
    .sort((a, b) => order.get(a.column)! - order.get(b.column)!);
}
