/**
 * The pipeline: phase prompts and ticket bookkeeping. Pure functions; SessionManager drives the
 * transitions. The workbench plays implement-spec's orchestrator (pi has no subagents): each ticket
 * and the final review get a fresh pi run on the session's single branch.
 *
 * - grill: /skill:grill-with-docs on the task; ends when the agent calls save_grill_summary.
 * - spec: /skill:to-spec in the same conversation; ends when the agent calls save_spec.
 * - tickets: /skill:to-tickets in the same conversation; ends when the agent calls record_tickets.
 * - implement: one fresh run per ticket with /skill:tdd, in dependency order; each ends with finish_ticket.
 * - review: one fresh /skill:code-review run over the whole branch that fixes what it finds; ends with finish_review.
 */

export type Phase = "setup" | "grill" | "spec" | "tickets" | "implement" | "review" | "done" | "direct";

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

export const PIPELINE_TOOLS = ["save_grill_summary", "save_spec", "record_tickets", "finish_ticket", "finish_review"] as const;

/** Specs longer than this go to ticket runs as a pointer only (implement-spec: "communicate through context pointers"). */
const SPEC_INLINE_LIMIT = 40_000;

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
  return `/skill:grill-with-docs ${task}

[pi-workbench pipeline: grill-with-docs → to-spec → to-tickets → implement → review]
Ask your questions with the ask_user tool. Keep going until the user explicitly confirms, through ask_user, that we have reached a shared understanding.
Commit any docs you wrote along the way (glossary, ADRs) to the current branch. Do not push.
Then call save_grill_summary with a short summary of the decisions made, and stop. Do not write the spec, tickets or code yet.`;
}

export function specPrompt() {
  // pi only expands "/skill:name" when an argument follows on the same line.
  return `/skill:to-spec Write the spec from what we just agreed.

[pi-workbench pipeline]
Check the testing seams with the user using ask_user. After you publish the spec to the tracker,
call save_spec with the full spec text and trackerRef (the file path or issue number/URL). Then stop.`;
}

export function ticketsPrompt(specRef: string | null) {
  return `/skill:to-tickets ${specRef ? `Break the spec (${specRef}) into tickets.` : "Break the spec we just wrote into tickets."}

[pi-workbench pipeline]
Present the breakdown and ask the user to approve it with ask_user before publishing. After you publish the approved tickets to the tracker,
call record_tickets with every ticket: its number, title, full body (what to build and acceptance criteria), blockedBy (ticket numbers) and trackerRef (the file path or issue number/URL).
Then stop. Do not start implementing.`;
}

function specSection(spec: string | null, specRef: string | null) {
  if (!spec) return specRef ? `Read the spec first: ${specRef}` : "(no spec recorded)";
  if (spec.length > SPEC_INLINE_LIMIT) return `The spec is long; read it at ${specRef ?? "the tracker"} before starting.`;
  return `${specRef ? `(${specRef})\n\n` : ""}${spec}`;
}

export function implementPrompt(ticket: Ticket, spec: string | null, specRef: string | null, finished: Ticket[]) {
  const notes = finished.length
    ? finished.map((t) => `- #${t.num} ${t.title}: ${t.note ?? "(no note)"}`).join("\n")
    : "- none yet";
  return `/skill:tdd Ticket #${ticket.num}: ${ticket.title}${ticket.trackerRef ? ` (${ticket.trackerRef})` : ""}

${ticket.body}

## Spec
${specSection(spec, specRef)}

## Tickets already finished (see their commits on this branch)
${notes}

[pi-workbench pipeline: you are the implementer for this one ticket]
Build it test-first. Work only on this ticket, in this worktree, and commit to the current branch. Do not push.
When it is complete, call finish_ticket with status "done" and a short note: what changed, and anything the next tickets should know.
If you cannot complete it, call finish_ticket with status "blocked" and explain why.`;
}

export function reviewPrompt(base: string, spec: string | null, specRef: string | null, tickets: Ticket[]) {
  return `/skill:code-review Review every change on this branch since origin/${base}.

## Spec
${specSection(spec, specRef)}

## Tickets
${tickets.map((t) => `- #${t.num} ${t.title}${t.trackerRef ? ` (${t.trackerRef})` : ""}`).join("\n")}

[pi-workbench pipeline: final review of the whole branch]
Fix every issue the review raises, run the tests, and commit the fixes to the current branch. Do not push.
Then call finish_review with a short note of what you found and fixed.`;
}
