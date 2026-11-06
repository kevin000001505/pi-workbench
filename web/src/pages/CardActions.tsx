import { Spinner } from "../ui.tsx";

/**
 * One action a card's buttons offers: a column move (Solve all on a spec card, Solve and Split on
 * a plain one) or a direct action on the session (Approve, Stop, Retry, Abandon, Answer on a
 * spec card). A `run` action outranks the move.
 */
export type CardAction = {
  label: string;
  /** A column move; absent for a `run` action. */
  column?: "doing" | "todo";
  title: string;
  /** Primary styling; the card detail wants it on Solve, the board card on none. */
  primary?: boolean;
  /** Danger styling; the board card wants it on Stop and Abandon. */
  danger?: boolean;
  /** A direct action on the session; it outranks the move. */
  run?: () => void;
};

export const SOLVE_ALL: CardAction = { label: "Solve all", column: "doing", title: "Move the card to Doing: start or resume its ticket runs" };
export const SOLVE: CardAction = { label: "Solve", column: "doing", title: "Make the issue the card's only ticket and start work: skips grill, spec and tickets" };
export const SPLIT: CardAction = { label: "Split", column: "todo", title: "Break the issue into ticket sub-issues with to-tickets, then approve the breakdown" };

/**
 * A card's action buttons, shared by the board card and the card detail. A click does only the
 * action: it stops the card's own click and its link to GitHub. A button is disabled while its
 * request runs, so one click makes one session.
 */
export function CardActions({ actions, busy, spinner, flat, onMove }: {
  actions: CardAction[];
  busy: boolean;
  /** Show a spinner in place of the label while busy; the card detail wants it, the board card does not. */
  spinner?: boolean;
  /** Render the buttons without the board card's action wrapper, inside the caller's own flex row. */
  flat?: boolean;
  onMove: (column: "doing" | "todo") => void;
}) {
  const buttons = actions.map((a) => (
    <button
      key={a.label}
      className={`kz-btn${a.primary ? " primary" : ""}${a.danger ? " danger" : ""}`}
      disabled={busy}
      title={a.title}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (a.run) a.run();
        else if (a.column) onMove(a.column);
      }}
    >
      {spinner && busy ? <Spinner small /> : a.label}
    </button>
  ));
  if (flat) return <>{buttons}</>;
  return <span className="kz-card-actions">{buttons}</span>;
}
