/**
 * The pipeline: phase prompts and ticket bookkeeping. Pure functions; SessionManager drives the
 * transitions. The workbench plays implement-spec's orchestrator (pi has no subagents): each ticket
 * and the final review get a fresh pi run on the session's single branch.
 *
 * - grill: /skill:grill-with-docs on the task; ends when the agent calls save_grill_summary.
 * - spec: /skill:to-spec in the same conversation; ends when the agent calls save_spec.
 * - tickets: /skill:to-tickets in the same conversation; ends when the agent calls record_tickets.
 * - implement: one fresh run per ticket with /skill:tdd, in dependency order; each ends with finish_ticket.
 *   A ticket run the stop rule stops gets a rescue run (/skill:diagnosing-bugs on the Reviewer's
 *   model; ends with finish_diagnosis), and a diagnosed result a fix run (/skill:tdd plus the diagnosis).
 * - review: one fresh /skill:code-review run over the whole branch that fixes what it finds; ends with finish_review.
 * - merge: when Approve finds a conflict that `git merge` cannot settle, one fresh
 *   /skill:resolving-merge-conflicts run finishes the merge in the worktree; ends with finish_merge.
 * - retro: when a ticket had a rescue, one fresh /skill:retro run on the Reviewer's model that only
 *   proposes changes; ends with finish_retro. It never blocks the PR.
 */

/** `ready`: the tickets are recorded and the session waits for Solve all. `pr`: reviewed, PR open. */
export type Phase = "setup" | "grill" | "spec" | "tickets" | "ready" | "implement" | "review" | "retro" | "pr" | "done" | "direct";

export type Ticket = {
  num: number;
  title: string;
  body: string;
  blockedBy: number[];
  trackerRef: string | null;
  status: "ready" | "running" | "done" | "blocked";
  note: string | null;
  runId: string | null;
  /** The rescue of a ticket the stop rule stopped: null, diagnosing, fixing, rescued or failed. */
  rescueState: RescueState | null;
  rescueRunId: string | null;
  fixRunId: string | null;
};

export type RescueState = "diagnosing" | "fixing" | "rescued" | "failed";

/** A spec gets at most this many rescues; each ticket gets one. */
export const RESCUES_PER_SPEC = 3;

export type TicketInput = { number: number; title: string; body: string; blockedBy?: number[]; trackerRef?: string };

/** An open sub-issue of a spec, as GitHub returns it: its own blockers' issue numbers. */
export type SubIssueSeed = { number: number; title: string; body: string | null; url: string; blockedBy: number[] };

/**
 * A spec issue and the tickets it owns, ready to feed into a session. `hasParent` is true when
 * the issue is itself a sub-issue of another issue: its spec's card owns it, so moves refuse it.
 */
export type TicketSeed = {
  spec: { number: number; title: string; body: string | null; htmlUrl: string; hasParent: boolean };
  subIssues: SubIssueSeed[];
};

/**
 * A spec's open sub-issues become pipeline tickets: local numbers run 1..N in sub-issue number
 * order, each ticket's trackerRef is its issue number, and blockedBy edges are remapped to
 * local numbers. An edge to an issue outside the set (closed or unrelated) is dropped, so it
 * cannot leave a ticket blocked forever.
 */
export function ticketsFromSubIssues(subs: SubIssueSeed[]): TicketInput[] {
  const sorted = subs.slice().sort((a, b) => a.number - b.number);
  const local = new Map(sorted.map((s, i) => [s.number, i + 1]));
  return sorted.map((s, i) => ({
    number: i + 1,
    title: s.title.trim(),
    body: (s.body ?? "").trim() || `No description for #${s.number}`,
    blockedBy: (s.blockedBy ?? []).filter((b) => local.has(b)).map((b) => local.get(b)!),
    trackerRef: String(s.number),
  }));
}

export const PIPELINE_TOOLS = ["save_grill_summary", "save_spec", "record_tickets", "finish_ticket", "finish_review", "finish_diagnosis", "finish_retro", "finish_merge"] as const;

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

/**
 * True when a prompt already names the skill pi must expand: it starts with a `/skill:name ...`
 * call that has an argument. Such a prompt goes out as it is; a bare task goes through grillPrompt.
 */
export const isSkillCall = (prompt: string) => /^\/skill:[\w-]+ \S/.test(prompt);

export function grillPrompt(task: string) {
  return `/skill:grill-with-docs ${task}

[pi-workbench pipeline: grill-with-docs → to-spec → to-tickets → implement → review]
Ask your questions with the ask_user tool. Keep going until the user explicitly confirms, through ask_user, that we have reached a shared understanding.
Commit any docs you wrote along the way (glossary, ADRs) to the current branch. Do not push.
Then call save_grill_summary with a short summary of the decisions made, and stop. Do not write the spec, tickets or code yet.`;
}

/**
 * A plain issue card's Grill: grill-with-docs on the issue's own words. The issue is the session's
 * origin, not its spec: the grill and the to-spec step that follows write the spec, and the PR closes
 * the issue through the session's issue ref.
 */
export function grillIssuePrompt(issue: TicketSeed["spec"]) {
  const body = (issue.body ?? "").trim() || "(the issue has no description)";
  return grillPrompt(`Issue #${issue.number} (${issue.htmlUrl}): ${issue.title.trim()}\n\n${body}`);
}

export function specPrompt() {
  // pi only expands "/skill:name" when an argument follows on the same line.
  return `/skill:to-spec Write the spec from what we just agreed.

[pi-workbench pipeline]
Check the testing seams with the user using ask_user. After you publish the spec to the tracker,
call save_spec with the full spec text and trackerRef (the file path or issue number/URL). Then stop.`;
}

/**
 * The to-tickets skill sizes each ticket "to fit in a single fresh context window" but does not
 * know how big that window is. Each ticket's tdd run uses the workbench model, so the prompt names
 * its context window (Model settings) and asks for tickets whose whole run fits in about half of it.
 */
export function ticketSizeRule(contextWindow: number) {
  const k = (tokens: number) => `${Math.round(tokens / 1024)}K`;
  return `Ticket size: one fresh run of the coding model solves each ticket, and its context window is ${k(contextWindow)} tokens.
That one run reads the ticket and the spec, explores the code, writes the tests and the code, reads the test output and fixes the failures.
Make each ticket small enough that this whole run uses at most about half of the window (${k(contextWindow / 2)} tokens), so that retries and long test output still fit.
A ticket is too big when it delivers more than one behaviour, changes more than about 5 files or more than one module, has more than about 5 acceptance criteria, or needs large files or long logs read in full.
Split a ticket that is too big, or that you are not sure fits, into smaller tickets with blocking edges.
In the breakdown you present, give each ticket a size estimate in tokens against this budget.`;
}

export function ticketsPrompt(specRef: string | null, contextWindow: number) {
  return `/skill:to-tickets ${specRef ? `Break the spec (${specRef}) into tickets.` : "Break the spec we just wrote into tickets."}

[pi-workbench pipeline]
${ticketSizeRule(contextWindow)}
Present the breakdown and ask the user to approve it with ask_user before publishing. After you publish the approved tickets to the tracker,
call record_tickets with every ticket: its number, title, full body (what to build and acceptance criteria), blockedBy (ticket numbers) and trackerRef (the file path or issue number/URL).
Then stop. Do not start implementing.`;
}

/**
 * A plain issue is too big for one ticket: break it into tickets with to-tickets, publishing each
 * as a sub-issue of the issue with its blocking edges, so it becomes a spec issue that waits in
 * Issues for Solve all. The issue itself is not changed or closed.
 */
export function splitPrompt(issueUrl: string, contextWindow: number) {
  return `/skill:to-tickets Split the issue (${issueUrl}) into tickets: it is too big for one ticket.

[pi-workbench pipeline: split of a plain issue]
${ticketSizeRule(contextWindow)}
Present the breakdown and ask the user to approve it with ask_user before publishing. After approval,
publish every ticket as a sub-issue of this issue, with its blocking edges. Do not change or close the issue itself.
Call record_tickets with every ticket: its number, title, full body (what to build and acceptance criteria), blockedBy (ticket numbers) and trackerRef (the sub-issue's number or URL).
Then stop. Do not start implementing.`;
}

/** A plain issue becomes the card's only ticket: its title, body (or a fallback) and number as the tracker ref. */
export function ticketFromIssue(spec: { number: number; title: string; body: string | null }): TicketInput[] {
  return [{ number: 1, title: spec.title.trim(), body: (spec.body ?? "").trim() || `No description for #${spec.number}`, blockedBy: [], trackerRef: String(spec.number) }];
}

/** The start a session takes from an unclaimed card's move or action, picked by the issue's open ticket sub-issues. */
export type StartFrom = "tickets" | "spec" | "issue" | "split" | "grill";

/**
 * What one StartFrom begins a session with: its phase, the prompt held until setup is done
 * (or sent at once), the tickets recorded at once, and its spec bookkeeping. The one table for
 * the unclaimed-card starts, so the move route, the grill route and SessionManager read them the
 * same way. A held prompt is always a full skill call (see isSkillCall): SessionManager sends it
 * as it is.
 */
export type StartPlan = {
  phase: Phase;
  /** Held until setup is done, then released: the rework grill or the split (sized to the model's context window). */
  held?: (seed: TicketSeed, contextWindow: number) => string;
  /** Recorded at once, so the first ticket run starts after setup. */
  tickets?: (seed: TicketSeed) => TicketInput[];
  /** The seed must have open sub-issues (404 without); the plain starts refuse them (409 with). */
  needsSubIssues: boolean;
  /** True when the issue's body becomes the session's spec text. A rework re-saves its spec in the to-spec step. */
  spec: boolean;
  /** True when the seed issue is the session's spec from the start, so its URL is the session's spec ref.
   * A Grill starts from the issue as its origin only: grill and to-spec write the spec. */
  specRefFromSeed: boolean;
};

export const START_PLANS: Record<StartFrom, StartPlan> = {
  tickets: {
    phase: "implement",
    tickets: (seed) => validateTickets(ticketsFromSubIssues(seed.subIssues)),
    needsSubIssues: true,
    spec: true,
    specRefFromSeed: true,
  },
  issue: {
    phase: "implement",
    tickets: (seed) => ticketFromIssue(seed.spec),
    needsSubIssues: false,
    spec: true,
    specRefFromSeed: true,
  },
  split: {
    phase: "tickets",
    held: (seed, contextWindow) => splitPrompt(seed.spec.htmlUrl, contextWindow),
    needsSubIssues: false,
    spec: true,
    specRefFromSeed: true,
  },
  spec: {
    phase: "grill",
    held: (seed) => reworkPrompt(seed.spec.htmlUrl),
    needsSubIssues: true,
    spec: false,
    specRefFromSeed: true,
  },
  grill: {
    phase: "grill",
    held: (seed) => grillIssuePrompt(seed.spec),
    needsSubIssues: false,
    spec: false,
    specRefFromSeed: false,
  },
};

/** True when an unchecked create body's startFrom names one of the unclaimed-card starts. */
export const isStartFrom = (v: unknown): v is StartFrom => typeof v === "string" && v in START_PLANS;

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

/** The grill again, after a card is moved back to To do: grill → spec → tickets rework what is already published. */
export function reworkPrompt(specRef: string | null) {
  const spec = specRef ? `the spec (${specRef})` : "the spec we wrote";
  return `/skill:grill-with-docs Rework the spec${specRef ? ` (${specRef})` : ""} and its tickets: the user moved this feature back to plan it again.

[pi-workbench pipeline: rework of grill-with-docs → to-spec → to-tickets]
Ask the user with the ask_user tool what must change. Keep going until the user explicitly confirms, through ask_user, that we have reached a shared understanding.
Commit any docs you changed (glossary, ADRs) to the current branch. Do not push.
Then call save_grill_summary with a short summary of the new decisions, and stop.
In the to-spec and to-tickets steps that follow, do not publish new issues for this feature: update the existing spec issue, ${spec}, in place, and update its ticket issues.
Close every ticket issue that the new breakdown drops. record_tickets lists the full new breakdown.`;
}

/** The merge run: Approve found a conflict, and `git merge origin/<base>` stopped on these files. */
export function mergePrompt(base: string, reason: string, files: string[]) {
  return `/skill:resolving-merge-conflicts Finish the merge of origin/${base} into this branch: ${reason}.

## Conflicted files
${files.map((f) => `- ${f}`).join("\n")}

[pi-workbench pipeline: merge conflict on Approve]
The merge is in progress in this worktree. Resolve every conflicted hunk, run the checks, and commit the merge to the current branch. Do not push; the workbench pushes. Do not run \`git merge --abort\`.
Then call finish_merge with status "resolved" and a short note of how you reconciled each side.
Only when a hunk truly needs a human decision (the two sides' intents cannot both be kept, and the merge's goal does not pick one), leave the merge as it is and call finish_merge with status "failed", naming the hunk and why. The workbench, not you, then aborts the merge.`;
}

/** What a rescue run reports with finish_diagnosis. */
export type Diagnosis = {
  status: "diagnosed" | "no_loop" | "failed";
  /** diagnosed: one command that goes red on the bug. */
  command?: string;
  /** diagnosed: the causal chain, one `file:line` step each. */
  chain?: string[];
  /** Optional harness files the rescue wrote and removed, as text, for the fix run to recreate. */
  harness?: string;
  note: string;
};

const FILE_LINE = /\S+:\d+/;

/** Check finish_diagnosis's arguments; the extension applies the same rules, so the model can retry. */
export function validateDiagnosis(input: any): Diagnosis {
  const status = input?.status;
  if (status !== "diagnosed" && status !== "no_loop" && status !== "failed") throw new Error("status must be diagnosed, no_loop or failed");
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (status !== "diagnosed") return { status, note };
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Error("a diagnosis needs the red-capable command");
  const chain = Array.isArray(input.chain) ? input.chain.map((c: unknown) => String(c).trim()).filter(Boolean) : [];
  if (chain.length === 0) throw new Error("a diagnosis needs the causal chain");
  const bad = chain.find((c: string) => !FILE_LINE.test(c));
  if (bad) throw new Error(`every causal chain step needs a file:line (got "${bad}")`);
  const harness = typeof input.harness === "string" && input.harness.trim() ? input.harness.trim() : undefined;
  return { status, command, chain, ...(harness ? { harness } : {}), note };
}

/** The facts the server hands a rescue run: nothing from the stuck model's own summary. */
export type RescueHandoff = {
  ticket: Ticket;
  spec: string | null;
  specRef: string | null;
  stopReason: string;
  startCommit: string | null;
  diff: string;
  toolErrors: string[];
  sessionFile: string | null;
};

const DIFF_LIMIT = 20_000;

export function rescuePrompt(h: RescueHandoff) {
  const diff = h.diff.length > DIFF_LIMIT ? `${h.diff.slice(0, DIFF_LIMIT)}\n… (cut; run the git diff yourself for the rest)` : h.diff;
  return `/skill:diagnosing-bugs Ticket #${h.ticket.num}: ${h.ticket.title} is stuck: the local model hit the stop rule. Find the cause; do not fix it.

## Ticket${h.ticket.trackerRef ? ` (${h.ticket.trackerRef})` : ""}
${h.ticket.body}

## Spec
${h.specRef ? `See ${h.specRef}.` : specSection(h.spec, h.specRef)}

## Stop reason
${h.stopReason}

## Start commit
${h.startCommit ?? "(not recorded)"}

## Diff since the start commit, uncommitted changes included
${diff.trim() ? `\`\`\`diff\n${diff}\n\`\`\`` : "(no changes)"}

## The stuck run's last tool errors
${h.toolErrors.length ? h.toolErrors.map((e) => `- ${e}`).join("\n") : "- none"}

## The stuck run's session file
${h.sessionFile ?? "(not found)"}

[pi-workbench pipeline: rescue run]
The user is away: do not use ask_user. Rank your hypotheses yourself and go on.
Follow diagnosing-bugs Phases 1 to 4 only: build the feedback loop, reproduce, rank hypotheses, instrument. Do not fix the bug. Do not commit.
Remove every [DEBUG-...] log you add, and leave the worktree as you found it. The server checks.
Then call finish_diagnosis: status "diagnosed" with one red-capable command and the causal chain (one file:line step each), and the harness files as text if the fix run needs them;
"no_loop" if you cannot build a feedback loop (an unclear ticket, a broken environment); "failed" if every hypothesis failed. Add a short note.`;
}

/** A fix run: the ticket's implement prompt, plus the rescue run's diagnosis. */
export function fixPrompt(ticket: Ticket, spec: string | null, specRef: string | null, finished: Ticket[], d: Diagnosis) {
  return `${implementPrompt(ticket, spec, specRef, finished)}

## Diagnosis
An earlier run on this ticket got stuck. A rescue run found the cause. Write the regression test first, with tdd: it must go red with this command, then fix the cause.

Command: ${d.command}

Causal chain:
${(d.chain ?? []).map((c) => `- ${c}`).join("\n")}
${d.harness ? `\nHarness files:\n${d.harness}\n` : ""}${d.note ? `\nNote: ${d.note}\n` : ""}`;
}

/** One rescued ticket, as the retro run sees it: the server's facts and the three runs' session files. */
export type RetroTicket = {
  ticket: Ticket;
  stopReason: string | null;
  diagnosis: string | null;
  fixResult: string;
  sessionFiles: { stuck: string | null; rescue: string | null; fix: string | null };
};

/** Where the retro may point its proposals: the settings it can name, with their values now. */
export type RetroPointers = { pipeline: Record<string, unknown>; model: Record<string, unknown> };

export function retroPrompt(rescued: RetroTicket[], p: RetroPointers) {
  const tickets = rescued
    .map((r) => {
      const t = r.ticket;
      return `### Ticket #${t.num}: ${t.title}${t.trackerRef ? ` (${t.trackerRef})` : ""}
${t.body}

- Stop rule: ${r.stopReason ?? "(not recorded)"}
- Diagnosis: ${r.diagnosis ?? "(none)"}
- Fix result: ${r.fixResult}
- Session files: stuck run ${r.sessionFiles.stuck ?? "(not found)"}; rescue run ${r.sessionFiles.rescue ?? "(not found)"}; fix run ${r.sessionFiles.fix ?? "(none)"}`;
    })
    .join("\n\n");
  return `/skill:retro Review the ${rescued.length} rescued ticket${rescued.length === 1 ? "" : "s"} of this spec: why the local model got stuck, and what would stop it next time.

## Rescued tickets
${tickets}

## What a proposal can change
- This repository: its code, tests, docs, and agent skills.
- The pi-workbench pipeline prompts: server/src/pipeline.ts in the pi-workbench repository (grill, spec, tickets, implement, rescue, fix, review).
- The pipeline stop-rule settings (Settings → Pipeline), now: ${JSON.stringify(p.pipeline)}
- The local model settings (Settings → Model), now: ${JSON.stringify(p.model)}
- The llama.cpp sampling settings (temperature, top-p, repeat penalty, and so on): these are outside this repository and outside the workbench, on the llama.cpp server's command line.

[pi-workbench pipeline: retro run]
The user is away: do not use ask_user. Propose only: name the exact file or setting each change touches, and why.
Do not edit any file, and do not commit. The server checks that the worktree is unchanged.
Then call finish_retro with the report.`;
}
