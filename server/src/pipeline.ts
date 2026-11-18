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
import { SETUP_SKILL } from "./config.ts";
import { ATTACH_POINTS, isAttachPoint, type AttachPoint } from "../../shared/attach.ts";

/**
 * The skills the pipeline prompts call, one per run kind: every phase, the setup run, and the special
 * runs (rescue, review-fix, merge, retro). The skill library's install check refuses a Skill source
 * that carries one of these names (issue #114), and the prompt builders write their `/skill:` call
 * from this list, so the two read one source of truth.
 */
export const PIPELINE_SKILLS = {
  setup: SETUP_SKILL,
  grill: "grill-with-docs",
  spec: "to-spec",
  tickets: "to-tickets",
  implement: "tdd",
  review: "code-review",
  rescue: "diagnosing-bugs",
  retro: "retro",
  merge: "resolving-merge-conflicts",
} as const;

/** The names an installed skill may not take: a shadowed `tdd` silently changes every ticket run. */
export const PIPELINE_SKILL_NAMES: readonly string[] = Object.values(PIPELINE_SKILLS);

/** `ready`: the tickets are recorded and the session waits for Solve all. `pr`: reviewed, PR open. */
export type Phase = "setup" | "grill" | "spec" | "tickets" | "ready" | "implement" | "review" | "retro" | "pr" | "done" | "direct";

/**
 * The pipeline places an installed skill can attach to (issue #117, ADR 0004). The library stores
 * these names, so a setting outside them is refused rather than quietly ignored. They live in
 * shared/attach.ts, so the page that sets them and the server that reads them name them the same way.
 */
export { ATTACH_POINTS, isAttachPoint } from "../../shared/attach.ts";
export type { AttachPoint } from "../../shared/attach.ts";

/** What a run is, as the attach table reads it. `ticketRun` and `specialRun` name a run with its own
 * pi session id; the session's own conversation run is named by its `mode` and `phase`. */
export type RunFacts = {
  mode: "pipeline" | "direct";
  phase: Phase;
  /** The run is one ticket's own run: its first run, its fix run, or its rescue run. */
  ticketRun: "ticket" | "fix" | "rescue" | null;
  /** The run is the session's review run, its retro run, or its merge run. */
  specialRun: "review" | "retro" | "merge" | null;
};

/** A run with a pi session id of its own: one ticket's runs, and the session's review, retro and merge runs. */
export type OwnRunKind = "ticket" | "fix" | "rescue" | "review" | "retro" | "merge";

/** The place of a run that is not the session's own conversation. */
const RUN_ATTACH: Record<OwnRunKind, AttachPoint | null> = {
  ticket: "implement",
  fix: "implement",
  rescue: null,
  review: "review",
  retro: null,
  merge: null,
};

/** The place the session's own conversation serves, by the pipeline step its phase is in. A card in
 * Review or Done has no step running, so its conversation serves no place; the setup run has a narrow
 * job of its own and serves none. */
const CONVERSATION_ATTACH: Record<Phase, AttachPoint | null> = {
  setup: null,
  grill: "grill",
  spec: "spec",
  tickets: "tickets",
  ready: "tickets",
  implement: "implement",
  review: "review",
  retro: null,
  pr: null,
  done: null,
  direct: "direct",
};

/**
 * The one mapping from a run to the pipeline place it serves (issue #117): an installed skill reaches
 * the runs of the places it is attached to, and no other run. A ticket's run, its fix run and a solo
 * ticket run are the implement place; a split card's held prompt and the tickets step are the tickets
 * place; every run of a direct session is the direct place; the setup, rescue, retro and merge runs
 * are attached to nothing.
 */
export function attachPointOf(f: RunFacts): AttachPoint | null {
  if (f.ticketRun) return RUN_ATTACH[f.ticketRun];
  if (f.specialRun) return RUN_ATTACH[f.specialRun];
  // A direct session runs no pipeline phases: its card's phase only says where its card sits.
  if (f.mode === "direct") return f.phase === "setup" ? null : "direct";
  return CONVERSATION_ATTACH[f.phase] ?? null;
}

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
  /** The library ids of the skills this ticket's runs load (its Ticket skill tags); empty when it carries none (issue #119). */
  skills: string[];
  /** Those tags as the names the user reads (issue #121), in the ticket's own order; empty with no tags. */
  skillTags: string[];
};

export type RescueState = "diagnosing" | "fixing" | "rescued" | "failed";

/** A spec gets at most this many rescues; each ticket gets one. */
export const RESCUES_PER_SPEC = 3;

/**
 * A ticket as the tickets step records it. `skills` is its Ticket skill tags: the *names* the agent
 * kept, which the recording site stores as the library's identifiers (issue #119). A card that never
 * ran the tickets step (Solve, a Solve on a sub-issue) records no tags, so it carries none.
 */
export type TicketInput = { number: number; title: string; body: string; blockedBy?: number[]; trackerRef?: string; skills?: string[] };

/** One ticket loads at most this many tagged skills: a run buried in instruction sets stops working. */
export const TICKET_SKILL_TAG_LIMIT = 3;

/**
 * A ticket's Ticket skill tags, as the agent passed them (issue #119). The names it may tag with are
 * the installed skills attached to the tickets place. A name outside that set is dropped and reported
 * in `dropped`, so the tool result can name it and the agent can retry; more than the limit is a
 * validation error. The extension applies the same rules, as `checkDiagnosis` mirrors `validateDiagnosis`.
 */
export function validateSkillTags(tags: unknown, attached: readonly string[]): { skills: string[]; dropped: string[] } {
  if (tags === undefined || tags === null) return { skills: [], dropped: [] };
  if (!Array.isArray(tags)) throw new Error(`a ticket's skills must be a list of skill names (got ${JSON.stringify(tags)})`);
  const names: string[] = [];
  for (const t of tags) {
    const name = typeof t === "string" ? t.trim() : "";
    if (!name) throw new Error(`a ticket's skills are skill names (got ${JSON.stringify(t)})`);
    if (!names.includes(name)) names.push(name);
  }
  if (names.length > TICKET_SKILL_TAG_LIMIT) throw new Error(`a ticket carries at most ${TICKET_SKILL_TAG_LIMIT} skill tags (it names ${names.length})`);
  const skills = names.filter((n) => attached.includes(n));
  return { skills, dropped: names.filter((n) => !skills.includes(n)) };
}

/**
 * The library identifiers a ticket's tag names stand for, in the order the agent named them. Stored as
 * identifiers, so a renamed skill keeps its tags and removing a source clears exactly its own tags.
 * A name the library does not hold is dropped.
 */
export function skillTagIds(names: readonly string[], skills: { id: string; name: string }[]): string[] {
  const byName = new Map<string, string>();
  for (const s of skills) if (!byName.has(s.name)) byName.set(s.name, s.id);
  return [...new Set(names.map((n) => byName.get(n)).filter((id): id is string => !!id))];
}

/**
 * The names a ticket's stored tags stand for (issue #121), in the ticket's own order, each name stated
 * once. A tag whose skill the library no longer holds names nothing: nothing states a skill that is gone.
 */
export function skillTagNames(tagIds: readonly string[], nameOf: (tagId: string) => string | null): string[] {
  const names: string[] = [];
  for (const tagId of tagIds) {
    const name = nameOf(tagId);
    if (!name || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

/**
 * The Ticket skill tags of the ticket this run belongs to (issue #120): a ticket run, its fix run and a
 * solo ticket run are their ticket's own run, so they carry its tags. Another run id — a rescue run, the
 * review run, the retro run, the merge run, the plan conversation — is no ticket's own run, so it names
 * no tag. The stored tags are installed skill identifiers.
 */
export function ticketRunTagIds(tickets: { runId: string | null; fixRunId: string | null; skills: readonly string[] }[], runId: string): string[] {
  if (!runId) return [];
  const ticket = tickets.find((t) => t.runId === runId || t.fixRunId === runId);
  return ticket?.skills ?? [];
}

/**
 * Those tags as prompt skills, in the order the ticket carries them, each name stated once. A tag whose
 * skill the library no longer holds names nothing: a run is never told to load a skill that is gone.
 */
export function requiredTagSkills(
  tickets: { runId: string | null; fixRunId: string | null; skills: readonly string[] }[],
  runId: string,
  skillFor: (tagId: string) => { name: string; description: string | null } | null,
): PromptSkill[] {
  const skills: PromptSkill[] = [];
  for (const tagId of ticketRunTagIds(tickets, runId)) {
    const skill = skillFor(tagId);
    if (!skill || skills.some((s) => s.name === skill.name)) continue;
    skills.push({ name: skill.name, description: skill.description ?? "" });
  }
  return skills;
}

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

/**
 * Check what the agent passed to record_tickets: unique numbers, known blockers, no cycles. With the
 * tickets place's attached names, each ticket's tags go through `validateSkillTags`: a name outside
 * that set is dropped, and the kept names come back on the ticket (issue #119).
 */
export function validateTickets(input: unknown, attachedSkillNames?: readonly string[]): TicketInput[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("tickets must be a non-empty array");
  const tickets = input.map((t: any, i) => {
    const number = Number(t?.number);
    if (!Number.isInteger(number) || number < 1) throw new Error(`ticket ${i + 1}: number must be a positive integer`);
    if (typeof t.title !== "string" || !t.title.trim()) throw new Error(`ticket ${number}: title is required`);
    if (typeof t.body !== "string" || !t.body.trim()) throw new Error(`ticket ${number}: body is required`);
    const blockedBy = Array.isArray(t.blockedBy) ? t.blockedBy.map(Number) : [];
    const tags = attachedSkillNames ? validateSkillTags(t.skills, attachedSkillNames).skills : undefined;
    return {
      number,
      title: t.title.trim(),
      body: t.body.trim(),
      blockedBy,
      trackerRef: typeof t.trackerRef === "string" ? t.trackerRef : undefined,
      ...(tags ? { skills: tags } : {}),
    };
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

/** One installed skill a prompt names: the name the agent types into the `Skill` tool, and the line that says what it is for. */
export type PromptSkill = { name: string; description: string };

/**
 * The installed skills one run's prompt names (issue #118).
 * `required` is the run's own list — the ticket's tags — and `advertised` is what the place carries
 * without naming it for this run.
 */
export type RunSkills = { required?: readonly PromptSkill[]; advertised?: readonly PromptSkill[] };

/** A skill line: `- <name>: <description>`, on one line whatever the description holds. */
const skillLine = (s: PromptSkill) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").trim() || "(no description)"}`;

/**
 * The prompt section that names the installed skills of the run's pipeline place, or "" when nothing
 * is attached to it, so a run with nothing attached keeps its prompt exactly as it is today. A
 * required skill is named with the instruction to load it before any code; an advertised one with the
 * instruction to load it when it fits the work.
 * `place` names the place this prompt serves: only the tickets place records Ticket skill tags, so only
 * there does the section ask for a tag list per ticket (issue #119).
 */
export function skillsSection(skills?: RunSkills, place?: AttachPoint): string {
  const required = [...new Map((skills?.required ?? []).map((s) => [s.name, s])).values()];
  const advertised = (skills?.advertised ?? []).filter((s) => !required.some((r) => r.name === s.name));
  if (!required.length && !advertised.length) return "";
  const parts = ["## Skills attached to this pipeline place"];
  if (required.length) parts.push("Required. Load each one with the Skill tool before you write any code:", ...required.map(skillLine));
  if (advertised.length) parts.push("Advertised. Load the ones that fit this work with the Skill tool:", ...advertised.map(skillLine));
  // The tickets step does the matching (issue #119): it proposes each ticket's tags from the list above,
  // and the user approves them with the breakdown they already answer. Another place asks for none.
  if (place === "tickets") parts.push(tagInstruction());
  return parts.join("\n");
}

/** The tickets step's tag instruction: the names above are what a ticket may be tagged with. */
function tagInstruction(): string {
  return (
    `Ticket skill tags: give every ticket a \`skills\` list of at most ${TICKET_SKILL_TAG_LIMIT} of the names above, each name exactly as written. ` +
    "State every ticket's tags in the breakdown question you ask with ask_user, so the user approves or corrects them before any ticket runs. " +
    "Call record_tickets with each ticket's `skills` list."
  );
}

/**
 * Add the place's skills section to a prompt that is already built. The held prompts (Split, a plain
 * issue card's grill, a rework) go through this at the moment they are sent or released, never when
 * they are stored: a card that waits for a setup run releases with the skills attached then.
 */
export function withSkills(prompt: string, skills?: RunSkills, place?: AttachPoint): string {
  const section = skillsSection(skills, place);
  return section ? `${prompt}\n\n${section}` : prompt;
}

export function grillPrompt(task: string, skills?: RunSkills) {
  return withSkills(`/skill:${PIPELINE_SKILLS.grill} ${task}

[pi-workbench pipeline: grill-with-docs → to-spec → to-tickets → implement → review]
Ask your questions with the ask_user tool. Keep going until the user explicitly confirms, through ask_user, that we have reached a shared understanding.
Commit any docs you wrote along the way (glossary, ADRs) to the current branch. Do not push.
Then call save_grill_summary with a short summary of the decisions made, and stop. Do not write the spec, tickets or code yet.`, skills);
}

/**
 * A plain issue card's Grill: grill-with-docs on the issue's own words. The issue is the session's
 * origin, not its spec: the grill and the to-spec step that follows write the spec, and the PR closes
 * the issue through the session's issue ref. It is a held prompt, so its place's skills come from
 * `withSkills` when the prompt is sent (issue #118).
 */
export function grillIssuePrompt(issue: TicketSeed["spec"]) {
  const body = (issue.body ?? "").trim() || "(the issue has no description)";
  return grillPrompt(`Issue #${issue.number} (${issue.htmlUrl}): ${issue.title.trim()}\n\n${body}`);
}

export function specPrompt(skills?: RunSkills) {
  // pi only expands "/skill:name" when an argument follows on the same line.
  return withSkills(`/skill:${PIPELINE_SKILLS.spec} Write the spec from what we just agreed.

[pi-workbench pipeline]
Check the testing seams with the user using ask_user. After you publish the spec to the tracker,
call save_spec with the full spec text and trackerRef (the file path or issue number/URL). Then stop.`, skills);
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

export function ticketsPrompt(specRef: string | null, contextWindow: number, skills?: RunSkills) {
  return withSkills(`/skill:${PIPELINE_SKILLS.tickets} ${specRef ? `Break the spec (${specRef}) into tickets.` : "Break the spec we just wrote into tickets."}

[pi-workbench pipeline]
${ticketSizeRule(contextWindow)}
Present the breakdown and ask the user to approve it with ask_user before publishing. After you publish the approved tickets to the tracker,
call record_tickets with every ticket: its number, title, full body (what to build and acceptance criteria), blockedBy (ticket numbers) and trackerRef (the file path or issue number/URL).
Then stop. Do not start implementing.`, skills, "tickets");
}

/**
 * A plain issue is too big for one ticket: break it into tickets with to-tickets, publishing each
 * as a sub-issue of the issue with its blocking edges, so it becomes a spec issue that waits in
 * Issues for Solve all. The issue itself is not changed or closed. It is a held prompt, so its place's
 * skills come from `withSkills` when the prompt is sent (issue #118).
 */
export function splitPrompt(issueUrl: string, contextWindow: number) {
  return `/skill:${PIPELINE_SKILLS.tickets} Split the issue (${issueUrl}) into tickets: it is too big for one ticket.

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

export function implementPrompt(ticket: Ticket, spec: string | null, specRef: string | null, finished: Ticket[], skills?: RunSkills) {
  const notes = finished.length
    ? finished.map((t) => `- #${t.num} ${t.title}: ${t.note ?? "(no note)"}`).join("\n")
    : "- none yet";
  return withSkills(`/skill:${PIPELINE_SKILLS.implement} Ticket #${ticket.num}: ${ticket.title}${ticket.trackerRef ? ` (${ticket.trackerRef})` : ""}

${ticket.body}

## Spec
${specSection(spec, specRef)}

## Tickets already finished (see their commits on this branch)
${notes}

[pi-workbench pipeline: you are the implementer for this one ticket]
Build it test-first. Work only on this ticket, in this worktree, and commit to the current branch. Do not push.
When it is complete, call finish_ticket with status "done" and a short note: what changed, and anything the next tickets should know.
If you cannot complete it, call finish_ticket with status "blocked" and explain why.`, skills);
}

export function reviewPrompt(base: string, spec: string | null, specRef: string | null, tickets: Ticket[], skills?: RunSkills) {
  return withSkills(`/skill:${PIPELINE_SKILLS.review} Review every change on this branch since origin/${base}.

## Spec
${specSection(spec, specRef)}

## Tickets
${tickets.map((t) => `- #${t.num} ${t.title}${t.trackerRef ? ` (${t.trackerRef})` : ""}`).join("\n")}

[pi-workbench pipeline: final review of the whole branch]
Fix every issue the review raises, run the tests, and commit the fixes to the current branch. Do not push.
Then call finish_review with a short note of what you found and fixed.`, skills);
}

/** The grill again, after a card is moved back to To do: grill → spec → tickets rework what is already published. */
export function reworkPrompt(specRef: string | null, skills?: RunSkills) {
  const spec = specRef ? `the spec (${specRef})` : "the spec we wrote";
  return withSkills(`/skill:${PIPELINE_SKILLS.grill} Rework the spec${specRef ? ` (${specRef})` : ""} and its tickets: the user moved this feature back to plan it again.

[pi-workbench pipeline: rework of grill-with-docs → to-spec → to-tickets]
Ask the user with the ask_user tool what must change. Keep going until the user explicitly confirms, through ask_user, that we have reached a shared understanding.
Commit any docs you changed (glossary, ADRs) to the current branch. Do not push.
Then call save_grill_summary with a short summary of the new decisions, and stop.
In the to-spec and to-tickets steps that follow, do not publish new issues for this feature: update the existing spec issue, ${spec}, in place, and update its ticket issues.
Close every ticket issue that the new breakdown drops. record_tickets lists the full new breakdown.`, skills);
}

/** The merge run: Approve found a conflict, and `git merge origin/<base>` stopped on these files. */
export function mergePrompt(base: string, reason: string, files: string[]) {
  return `/skill:${PIPELINE_SKILLS.merge} Finish the merge of origin/${base} into this branch: ${reason}.

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
  return `/skill:${PIPELINE_SKILLS.rescue} Ticket #${h.ticket.num}: ${h.ticket.title} is stuck: the local model hit the stop rule. Find the cause; do not fix it.

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
export function fixPrompt(ticket: Ticket, spec: string | null, specRef: string | null, finished: Ticket[], d: Diagnosis, skills?: RunSkills) {
  return `${implementPrompt(ticket, spec, specRef, finished, skills)}

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
  return `/skill:${PIPELINE_SKILLS.retro} Review the ${rescued.length} rescued ticket${rescued.length === 1 ? "" : "s"} of this spec: why the local model got stuck, and what would stop it next time.

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
