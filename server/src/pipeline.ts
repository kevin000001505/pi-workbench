/**
 * The grill → tickets → implement pipeline: phase prompts and ticket bookkeeping. Pure functions;
 * SessionManager drives the transitions.
 *
 * - grill: /skill:grill-me on the task; ends when the agent calls save_grill_summary.
 * - tickets: /skill:to-tickets in the same conversation; ends when the agent calls record_tickets.
 * - implement: one fresh pi run per ticket, in dependency order; each ends with finish_ticket.
 */

export type Phase = "setup" | "grill" | "tickets" | "implement" | "done" | "direct";

export type Ticket = {
  num: number;
  title: string;
  body: string;
  blockedBy: number[];
  trackerRef: string | null;
  status: "ready" | "running" | "done" | "blocked";
  note: string | null;
  runId: string | null;
};

export type TicketInput = { number: number; title: string; body: string; blockedBy?: number[]; trackerRef?: string };

export const PIPELINE_TOOLS = ["save_grill_summary", "record_tickets", "finish_ticket"] as const;

/** Check what the agent passed to record_tickets: unique numbers, known blockers, no cycles. */
export function validateTickets(input: unknown): TicketInput[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("tickets must be a non-empty array");
  const tickets = input.map((t: any, i) => {
    const number = Number(t?.number);
    if (!Number.isInteger(number) || number < 1) throw new Error(`ticket ${i + 1}: number must be a positive integer`);
    if (typeof t.title !== "string" || !t.title.trim()) throw new Error(`ticket ${number}: title is required`);
    if (typeof t.body !== "string" || !t.body.trim()) throw new Error(`ticket ${number}: body is required`);
    const blockedBy = Array.isArray(t.blockedBy) ? t.blockedBy.map(Number) : [];
    return { number, title: t.title.trim(), body: t.body.trim(), blockedBy, trackerRef: typeof t.trackerRef === "string" ? t.trackerRef : undefined };
  });
  const nums = new Set(tickets.map((t) => t.number));
  if (nums.size !== tickets.length) throw new Error("ticket numbers must be unique");
  for (const t of tickets) {
    for (const b of t.blockedBy) {
      if (!nums.has(b)) throw new Error(`ticket ${t.number} is blocked by unknown ticket ${b}`);
      if (b === t.number) throw new Error(`ticket ${t.number} cannot block itself`);
    }
  }
  // A cycle would leave the frontier empty forever.
  const state = new Map<number, "visiting" | "done">();
  const byNum = new Map(tickets.map((t) => [t.number, t]));
  const visit = (n: number, path: number[]) => {
    if (state.get(n) === "done") return;
    if (state.get(n) === "visiting") throw new Error(`blocking cycle: ${[...path, n].join(" → ")}`);
    state.set(n, "visiting");
    for (const b of byNum.get(n)!.blockedBy) visit(b, [...path, n]);
    state.set(n, "done");
  };
  for (const t of tickets) visit(t.number, []);
  return tickets.sort((a, b) => a.number - b.number);
}

/** The next ticket to run: the lowest-numbered ready ticket whose blockers are all done. */
export function nextTicket(tickets: Ticket[]): Ticket | undefined {
  const done = new Set(tickets.filter((t) => t.status === "done").map((t) => t.num));
  return tickets
    .filter((t) => t.status === "ready" && t.blockedBy.every((b) => done.has(b)))
    .sort((a, b) => a.num - b.num)[0];
}

export const allDone = (tickets: Ticket[]) => tickets.length > 0 && tickets.every((t) => t.status === "done");

export function grillPrompt(task: string) {
  return `/skill:grill-me ${task}

[pi-workbench pipeline: grill → tickets → implement]
Ask your questions with the ask_user tool. Keep going until the user explicitly confirms, through ask_user, that we have reached a shared understanding.
Then call save_grill_summary with a complete summary of every decision made (what to build, what not to build, and why), and stop. Do not write tickets or code yet.`;
}

export function ticketsPrompt() {
  return `/skill:to-tickets Break the plan we just agreed into tickets.

[pi-workbench pipeline]
Present the breakdown and ask the user to approve it with ask_user before publishing. After you publish the approved tickets to the tracker,
call record_tickets with every ticket: its number, title, full body (what to build and acceptance criteria), blockedBy (ticket numbers) and trackerRef (the file path or issue number/URL).
Then stop. Do not start implementing.`;
}

export function implementPrompt(ticket: Ticket, summary: string | null, finished: Ticket[]) {
  const notes = finished.length
    ? finished.map((t) => `- #${t.num} ${t.title}: ${t.note ?? "(no note)"}`).join("\n")
    : "- none yet";
  return `/skill:implement Ticket #${ticket.num}: ${ticket.title}${ticket.trackerRef ? ` (${ticket.trackerRef})` : ""}

${ticket.body}

## Agreed decisions for this feature
${summary ?? "(none recorded)"}

## Tickets already finished
${notes}

[pi-workbench pipeline]
Work only on this ticket, in this worktree, and commit to the current branch. Do not push.
When it is complete, call finish_ticket with status "done" and a short note: what changed, and anything the next tickets should know.
If you cannot complete it, call finish_ticket with status "blocked" and explain why.`;
}
