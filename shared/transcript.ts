/**
 * Rebuilds a pi conversation from its RPC event stream. Used by the server (to snapshot sessions for
 * new viewers) and by the browser (to apply live events on top of that snapshot), so both agree.
 *
 * Wire `message_update` records are delta-only; `*_end` events carry the authoritative block and
 * `message_end` the authoritative message, which replace whatever the deltas built.
 */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; redacted?: boolean }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; argsText?: string }
  | { type: "image"; data: string; mimeType: string };

export type Usage = { input: number; output: number; totalTokens: number; cacheRead?: number; cacheWrite?: number };

export type AgentMessage = {
  role: string;
  content: string | ContentBlock[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
  usage?: Usage;
  model?: string;
  [key: string]: unknown;
};

export type ToolRun = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  partial?: { content?: ContentBlock[] };
  startedAt: number;
};

export type Transcript = {
  messages: AgentMessage[];
  streaming: AgentMessage | null;
  tools: Record<string, ToolRun>;
  busy: boolean;
  /** Tokens in the latest assistant request: the context in use. */
  contextTokens: number;
};

export type RpcEvent = { type: string; [key: string]: any };

export const emptyTranscript = (): Transcript => ({ messages: [], streaming: null, tools: {}, busy: false, contextTokens: 0 });

export function withMessages(messages: AgentMessage[]): Transcript {
  const t = emptyTranscript();
  t.messages = messages.filter((m) => m.role !== "system");
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const u = t.messages[i].usage;
    if (t.messages[i].role === "assistant" && u) {
      t.contextTokens = usageContext(u);
      break;
    }
  }
  return t;
}

const usageContext = (u: Usage) => (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);

function blockText(content: unknown, key: "text" | "thinking"): string | undefined {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && typeof (content as any)[key] === "string") return (content as any)[key];
  return undefined;
}

/** Apply one RPC record. Mutates and returns `t`; unknown records are ignored. */
export function applyEvent(t: Transcript, ev: RpcEvent): Transcript {
  switch (ev.type) {
    case "agent_start":
      t.busy = true;
      break;
    case "agent_settled":
      t.busy = false;
      t.streaming = null;
      t.tools = {};
      break;
    case "message_start":
      if (ev.message?.role === "assistant") {
        t.streaming = { ...ev.message, content: Array.isArray(ev.message.content) ? [...ev.message.content] : [] };
      }
      break;
    case "message_update": {
      if (!t.streaming) t.streaming = { role: "assistant", content: [] };
      const blocks = t.streaming.content as ContentBlock[];
      const e = ev.assistantMessageEvent ?? {};
      const i = e.contentIndex as number;
      switch (e.type) {
        case "text_start":
          blocks[i] = { type: "text", text: "" };
          break;
        case "text_delta": {
          const b = blocks[i];
          if (b?.type === "text") b.text += e.delta ?? "";
          else blocks[i] = { type: "text", text: e.delta ?? "" };
          break;
        }
        case "text_end":
          blocks[i] = { type: "text", text: blockText(e.content, "text") ?? (blocks[i] as any)?.text ?? "" };
          break;
        case "thinking_start":
          blocks[i] = { type: "thinking", thinking: "" };
          break;
        case "thinking_delta": {
          const b = blocks[i];
          if (b?.type === "thinking") b.thinking += e.delta ?? "";
          else blocks[i] = { type: "thinking", thinking: e.delta ?? "" };
          break;
        }
        case "thinking_end":
          blocks[i] = { type: "thinking", thinking: blockText(e.content, "thinking") ?? (blocks[i] as any)?.thinking ?? "" };
          break;
        case "toolcall_start":
          blocks[i] = { type: "toolCall", id: e.id, name: e.toolName, arguments: {}, argsText: "" };
          break;
        case "toolcall_delta": {
          const b = blocks[i];
          if (b?.type === "toolCall") b.argsText = (b.argsText ?? "") + (e.delta ?? "");
          break;
        }
        case "toolcall_end":
          if (e.toolCall) blocks[i] = e.toolCall;
          break;
      }
      if (ev.usage && ev.usage.totalTokens) t.contextTokens = usageContext(ev.usage);
      break;
    }
    case "message_end": {
      const m = ev.message as AgentMessage | undefined;
      if (!m) break;
      if (m.role === "assistant") {
        t.streaming = null;
        if (m.usage && m.usage.totalTokens) t.contextTokens = usageContext(m.usage);
      }
      if (m.role !== "system") t.messages.push(m);
      break;
    }
    case "tool_execution_start":
      t.tools[ev.toolCallId] = { toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args ?? {}, startedAt: Date.now() };
      break;
    case "tool_execution_update":
      if (t.tools[ev.toolCallId]) t.tools[ev.toolCallId].partial = ev.partialResult;
      break;
    case "tool_execution_end":
      delete t.tools[ev.toolCallId];
      break;
    case "wb_auto_decision": {
      // A permission auto-approve answered without the user: kept inline as an audit line.
      const { type: _type, ...fields } = ev;
      t.messages.push({ role: "autoDecision", content: "", ...fields });
      break;
    }
    case "compaction_end":
      if (ev.result?.estimatedTokensAfter) t.contextTokens = ev.result.estimatedTokensAfter;
      break;
  }
  return t;
}

/** One-line description of what the agent is doing, for session cards. */
export function activityOf(t: Transcript): string {
  const running = Object.values(t.tools);
  if (running.length > 0) return describeTool(running[running.length - 1].toolName, running[running.length - 1].args);
  const s = t.streaming;
  if (s && Array.isArray(s.content) && s.content.length > 0) {
    const last = s.content[s.content.length - 1];
    if (last?.type === "thinking") return "Thinking…";
    if (last?.type === "toolCall") return `Preparing ${last.name}…`;
    return "Writing…";
  }
  return t.busy ? "Working…" : "";
}

export function describeTool(name: string, args: Record<string, unknown>): string {
  const a = args ?? {};
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "bash":
      return `$ ${s(a.command).split("\n")[0].slice(0, 120)}`;
    case "read":
      return `Reading ${s(a.path)}`;
    case "write":
      return `Writing ${s(a.path)}`;
    case "edit":
      return `Editing ${s(a.path)}`;
    case "ask_user":
      return "Asking you a question";
    default:
      return name;
  }
}
