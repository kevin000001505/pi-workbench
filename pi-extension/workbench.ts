/**
 * pi-workbench extension, loaded into every pi process the workbench starts.
 *
 * - Known SSH hosts: on every run the "wb_ssh" system prompt section names the hosts from the
 *   non-secret hosts file, so "fix the code in Media" means `ssh Media` and work there.
 * - Approval gate: tool calls matching the rules in workbench-rules.json wait for the user. A
 *   `Deny` click, a typed note, or a malformed `"wb": "deny"` value block with the user's wording;
 *   a well-formed `{"wb": "deny", "by", "reason"}` value (the auto-approve reviewer's answer,
 *   ADR 0002) blocks with the reviewer's wording, so the agent knows the reviewer denied the
 *   call and can choose another approach.
 * - ask_user tool: lets the model put a question or choice to the user as a decision card.
 *
 * Both go through ctx.ui.select / ctx.ui.input, which RPC mode turns into extension_ui_request
 * records. The title is a JSON envelope ({"wb": ...}) so the workbench can tell a permission from a
 * decision. No timeout is set: a session waits until the user answers.
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Rule = { id: string; tool: string; pattern: string; label: string; enabled: boolean };
type Rules = { rules: Rule[]; outsideWorktree: boolean };

export const ALLOW = "Allow";
export const ALLOW_SESSION = "Allow for this session";
export const DENY = "Deny";

function rulesPath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent");
  return process.env.PI_WORKBENCH_RULES ?? path.join(agentDir, "workbench-rules.json");
}

type SshHost = { alias: string; user: string; hostname: string; port?: number; keyName: string };

/** The non-secret hosts file the workbench materializes into the agent dir (names only, never values). */
function sshHostsPath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent");
  return process.env.PI_WORKBENCH_SSH ?? path.join(agentDir, "workbench-ssh.json");
}

function loadSshHosts(): SshHost[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(sshHostsPath(), "utf8")) as { hosts?: SshHost[] };
    return Array.isArray(parsed.hosts) ? parsed.hosts : [];
  } catch {
    return [];
  }
}

/** The wb_ssh system prompt section: one line per host plus how to work there. */
function sshSection(hosts: SshHost[]): string {
  const lines = hosts.map((h) => `- ${h.alias} → ${h.user}@${h.hostname}${h.keyName ? ` (key: ${h.keyName})` : ""}`);
  return [
    "Known SSH hosts",
    "",
    "The user has registered these remote machines; their keys are already configured for the aliases:",
    ...lines,
    "",
    "When the user names one of these hosts, work on that machine via `ssh <alias>`: run commands as",
    "`ssh <alias> <cmd>` and move files with `scp` (`scp <alias>:path .` and `scp path <alias>:path`).",
  ].join("\n");
}

function loadRules(): Rules {
  try {
    return JSON.parse(fs.readFileSync(rulesPath(), "utf8")) as Rules;
  } catch {
    return { rules: [], outsideWorktree: true };
  }
}

function subjectOf(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" && typeof input.command === "string") return input.command;
  return JSON.stringify(input);
}

function isOutside(cwd: string, target: string): boolean {
  const resolved = path.resolve(cwd, target);
  const rel = path.relative(cwd, resolved);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * The reviewer-deny envelope the server answers with (ADR 0002): `{"wb": "deny", "by": <name>,
 * "reason": <text>}`. A non-object, a different wb, or a missing by/reason reads as a plain deny,
 * never as an allow. `reason` may be undefined (a plain deny); a well-formed one always has both.
 */
function denyEnvelope(choice: unknown): { by?: string; reason?: string } | null {
  if (typeof choice !== "string" || !choice.startsWith("{")) return null;
  try {
    const v = JSON.parse(choice);
    if (!v || typeof v !== "object" || v.wb !== "deny") return null;
    return {
      by: typeof v.by === "string" && v.by.trim() ? v.by.trim() : undefined,
      reason: typeof v.reason === "string" ? v.reason : undefined,
    };
  } catch {
    return null;
  }
}

export default function workbench(pi: ExtensionAPI) {
  const allowedForSession = new Set<string>();

  pi.on("before_agent_start", async (event) => {
    const hosts = loadSshHosts();
    if (hosts.length === 0) return;
    // A section (not a forced prompt) so pi can diff it: it appears in every run while hosts
    // exist and is removed from the transcript once they are deleted.
    event.systemPromptOptions.sections.wb_ssh = sshSection(hosts);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "ask_user") return undefined;
    const input = (event.input ?? {}) as Record<string, unknown>;
    const { rules, outsideWorktree } = loadRules();
    const subject = subjectOf(event.toolName, input);

    const matched: { id: string; label: string }[] = [];
    for (const rule of rules) {
      if (!rule.enabled || allowedForSession.has(rule.id)) continue;
      if (rule.tool !== "*" && rule.tool !== event.toolName) continue;
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, "i");
      } catch {
        continue;
      }
      if (re.test(subject)) matched.push({ id: rule.id, label: rule.label });
    }
    const target = typeof input.path === "string" ? input.path : undefined;
    if (
      outsideWorktree &&
      !allowedForSession.has("outside-worktree") &&
      (event.toolName === "write" || event.toolName === "edit") &&
      target &&
      isOutside(ctx.cwd, target)
    ) {
      matched.push({ id: "outside-worktree", label: "write outside the worktree" });
    }
    if (matched.length === 0) return undefined;

    const title = JSON.stringify({
      wb: "permission",
      tool: event.toolName,
      subject,
      reasons: matched.map((m) => m.label),
    });
    const choice = await ctx.ui.select(title, [ALLOW, ALLOW_SESSION, DENY]);
    if (choice === ALLOW) return undefined;
    if (choice === ALLOW_SESSION) {
      for (const m of matched) allowedForSession.add(m.id);
      return undefined;
    }
    const labels = matched.map((m) => m.label).join(", ");
    // The server's reviewer-deny envelope. A malformed one is a plain deny, never an allow.
    const deny = denyEnvelope(choice);
    if (deny?.by && deny.reason !== undefined) {
      return { block: true, reason: `The auto-approve reviewer (${deny.by}) denied this ${event.toolName} call (${labels}): ${deny.reason}. You can choose another approach, or ask the user with ask_user.` };
    }
    if (deny) return { block: true, reason: `The user denied this ${event.toolName} call (${labels}).` };
    const why = typeof choice === "string" && choice !== DENY && choice.trim() ? ` The user said: ${choice}` : "";
    return { block: true, reason: `The user denied this ${event.toolName} call (${labels}).${why}` };
  });

  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "Ask the user a question and wait for the answer. Give `options` when there are clear choices; the user can always type their own answer instead.",
    promptSnippet: "Ask the user a question or put a decision to them, and wait for the answer",
    promptGuidelines: [
      "When you need the user to make a decision or answer a question before you can continue, call ask_user instead of asking in plain text and ending your turn.",
      "Ask ask_user one question at a time. Put the recommended choice first in its options and say why in the question.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      question: Type.String({ description: "The question, with enough context to answer it without scrolling back" }),
      options: Type.Optional(Type.Array(Type.String(), { description: "Choices to offer; recommended first" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const options = (params.options ?? []).filter((o) => o.trim());
      const title = JSON.stringify({ wb: "decision", question: params.question, options });
      const answer = options.length > 0 ? await ctx.ui.select(title, options) : await ctx.ui.input(title, "");
      if (answer === undefined || answer === null || String(answer).trim() === "") {
        return {
          content: [{ type: "text", text: "The user dismissed the question without answering. Use your best judgement, or ask again later." }],
          details: { question: params.question, options, answer: null },
        };
      }
      return {
        content: [{ type: "text", text: `The user answered: ${answer}` }],
        details: { question: params.question, options, answer },
      };
    },
  });

  // Skills written for Claude Code hand off with "call the Skill tool with <name>"; this makes that work in pi.
  pi.registerTool({
    name: "Skill",
    label: "Skill",
    description: "Load a skill's instructions by name (e.g. grilling, tdd, code-review) and follow them.",
    parameters: Type.Object({
      skill: Type.String({ description: "The skill name" }),
      args: Type.Optional(Type.String({ description: "Arguments for the skill" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const file = findSkill(params.skill.replace(/^\//, "").replace(/^skill:/, ""), ctx.cwd);
      if (!file) return { content: [{ type: "text", text: `No skill named "${params.skill}".` }], details: {}, isError: true };
      const body = fs.readFileSync(file, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
      const text = `<skill name="${params.skill}" location="${file}">\nReferences are relative to ${path.dirname(file)}.\n\n${body}\n</skill>${params.args ? `\n\n${params.args}` : ""}`;
      return { content: [{ type: "text", text }], details: { file } };
    },
  });

  // Pipeline tools. They only record; the workbench reads their arguments from the event stream.
  pi.registerTool({
    name: "save_grill_summary",
    label: "Save grill summary",
    description:
      "pi-workbench pipeline: call once grilling is over and the user confirmed a shared understanding. Saves the agreed decisions for the ticket and implement phases.",
    parameters: Type.Object({ summary: Type.String({ description: "Every decision made: what to build, what not, and why" }) }),
    async execute(_id, params) {
      if (!params.summary.trim()) return { content: [{ type: "text", text: "summary is empty" }], details: {}, isError: true };
      return { content: [{ type: "text", text: "Saved. Stop here; the workbench starts the ticket phase." }], details: {} };
    },
  });

  pi.registerTool({
    name: "save_spec",
    label: "Save spec",
    description: "pi-workbench pipeline: after /to-spec published the spec, record its full text and where it was published.",
    parameters: Type.Object({
      spec: Type.String({ description: "The full spec, as published" }),
      trackerRef: Type.Optional(Type.String({ description: "Spec file path or issue number/URL" })),
    }),
    async execute(_id, params) {
      if (!params.spec.trim()) return { content: [{ type: "text", text: "spec is empty" }], details: {}, isError: true };
      return { content: [{ type: "text", text: "Saved. Stop here; the workbench starts the ticket phase." }], details: {} };
    },
  });

  pi.registerTool({
    name: "finish_review",
    label: "Finish review",
    description: "pi-workbench pipeline: report that the final code review is done and its fixes are committed.",
    parameters: Type.Object({ note: Type.String({ description: "What the review found and what you fixed" }) }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: `Review recorded. Stop here.` }], details: { note: params.note } };
    },
  });

  pi.registerTool({
    name: "record_tickets",
    label: "Record tickets",
    description:
      "pi-workbench pipeline: after the user approved the ticket breakdown and you published it, record every ticket so the workbench can run them in order.",
    parameters: Type.Object({
      tickets: Type.Array(
        Type.Object({
          number: Type.Integer({ description: "Ticket number, from 1, blockers first" }),
          title: Type.String(),
          body: Type.String({ description: "What to build and the acceptance criteria" }),
          blockedBy: Type.Optional(Type.Array(Type.Integer(), { description: "Numbers of the tickets that must finish first" })),
          trackerRef: Type.Optional(Type.String({ description: "Ticket file path or issue number/URL" })),
        }),
      ),
    }),
    async execute(_id, params) {
      const problem = checkTickets(params.tickets);
      if (problem) return { content: [{ type: "text", text: `Not recorded: ${problem}. Fix it and call record_tickets again.` }], details: {}, isError: true };
      return { content: [{ type: "text", text: `Recorded ${params.tickets.length} tickets. Stop here; the workbench runs them.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "finish_ticket",
    label: "Finish ticket",
    description: "pi-workbench pipeline: report the current ticket as done (committed) or blocked, with a short note for the next tickets.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("done"), Type.Literal("blocked")]),
      note: Type.String({ description: "What changed, or why it is blocked" }),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: `Ticket marked ${params.status}. Stop here.` }], details: {} };
    },
  });
}

function findSkill(name: string, cwd: string): string | undefined {
  const roots = [path.join(cwd, ".agents", "skills"), path.join(cwd, ".pi", "skills"), process.env.PI_WORKBENCH_SKILLS ?? ""].filter(Boolean);
  for (const root of roots) {
    const found = walk(root, name, 0);
    if (found) return found;
  }
  return undefined;
}

function walk(dir: string, name: string, depth: number): string | undefined {
  if (depth > 6) return undefined;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const skill = path.join(dir, "SKILL.md");
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    const m = /^name:\s*["']?([\w-]+)/m.exec(fs.readFileSync(skill, "utf8"));
    return (m?.[1] ?? path.basename(dir)) === name ? skill : undefined;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    const found = walk(path.join(dir, e.name), name, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Same rules as the server's validateTickets, so the model hears about mistakes and retries. */
function checkTickets(tickets: { number: number; title: string; body: string; blockedBy?: number[] }[]): string | null {
  if (tickets.length === 0) return "no tickets";
  const nums = new Set(tickets.map((t) => t.number));
  if (nums.size !== tickets.length) return "ticket numbers must be unique";
  for (const t of tickets) {
    if (!t.title.trim() || !t.body.trim()) return `ticket ${t.number} needs a title and body`;
    for (const b of t.blockedBy ?? []) if (!nums.has(b) || b === t.number) return `ticket ${t.number} has an invalid blocker ${b}`;
  }
  const blockers = new Map(tickets.map((t) => [t.number, t.blockedBy ?? []]));
  const state = new Map<number, number>();
  const cyclic = (n: number): boolean => {
    if (state.get(n) === 2) return false;
    if (state.get(n) === 1) return true;
    state.set(n, 1);
    const c = blockers.get(n)!.some(cyclic);
    state.set(n, 2);
    return c;
  };
  return tickets.some((t) => cyclic(t.number)) ? "the blocking edges form a cycle" : null;
}
