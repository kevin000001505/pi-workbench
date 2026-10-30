/**
 * pi-workbench extension, loaded into every pi process the workbench starts.
 *
 * - Approval gate: tool calls matching the rules in workbench-rules.json wait for the user.
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

export default function workbench(pi: ExtensionAPI) {
  const allowedForSession = new Set<string>();

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
    const why = typeof choice === "string" && choice !== DENY && choice.trim() ? ` The user said: ${choice}` : "";
    return { block: true, reason: `The user denied this ${event.toolName} call (${matched.map((m) => m.label).join(", ")}).${why}` };
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
}
