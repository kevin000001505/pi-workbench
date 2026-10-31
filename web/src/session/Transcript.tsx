import { useState } from "react";
import { type AgentMessage, type ContentBlock, describeTool, type ToolRun, type Transcript as T } from "../../../shared/transcript.ts";
import { explainModelError } from "../../../shared/endpoint.ts";
import { Markdown, Spinner } from "../ui.tsx";

type ToolResult = AgentMessage & { role: "toolResult" };

const textOf = (content: AgentMessage["content"] | undefined) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className={`thinking ${open ? "open" : ""}`}>
      <button className="thinking-toggle" onClick={() => setOpen((o) => !o)}>
        {live ? <Spinner small /> : <span className="chev">{open ? "▾" : "▸"}</span>}
        {live ? "Thinking…" : "Thought"}
      </button>
      {open && <pre className="thinking-body">{text}</pre>}
    </div>
  );
}

function ToolCard({
  name,
  args,
  result,
  running,
  live,
}: {
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  running?: ToolRun;
  live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const output = result ? textOf(result.content) : running?.partial?.content ? textOf(running.partial.content) : "";
  const isError = result?.isError;
  const active = !result && (!!running || !!live);
  const details = (result?.details ?? {}) as { answer?: string | null };
  if (name === "ask_user") {
    return (
      <div className="tool tool-ask">
        <div className="tool-head">
          <span className="tool-icon">❓</span>
          <span className="tool-title">{String(args.question ?? "Question")}</span>
        </div>
        {result && <div className="tool-answer">{details.answer ? `→ ${details.answer}` : "Dismissed"}</div>}
        {active && <div className="tool-answer muted">Waiting for your answer…</div>}
      </div>
    );
  }
  const diff = name === "edit" && typeof args.oldText === "string" ? args : null;
  return (
    <div className={`tool ${isError ? "tool-error" : ""} ${active ? "tool-running" : ""}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        {active ? <Spinner small /> : <span className="tool-icon">{!result ? "–" : isError ? "✕" : "✓"}</span>}
        <span className="tool-title mono">{describeTool(name, args)}</span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {(open || (active && output)) && (
        <div className="tool-body">
          {name === "write" && typeof args.content === "string" && open && <pre className="code">{args.content}</pre>}
          {diff && open && (
            <pre className="code diff">
              {String(diff.oldText)
                .split("\n")
                .map((l, i) => (
                  <div key={`o${i}`} className="del">
                    - {l}
                  </div>
                ))}
              {String(diff.newText ?? "")
                .split("\n")
                .map((l, i) => (
                  <div key={`n${i}`} className="add">
                    + {l}
                  </div>
                ))}
            </pre>
          )}
          {!["bash", "read", "write", "edit"].includes(name) && open && <pre className="code">{JSON.stringify(args, null, 2)}</pre>}
          {output && <pre className={`code output ${active ? "live" : ""}`}>{output.length > 20000 ? `${output.slice(0, 20000)}\n…` : output}</pre>}
        </div>
      )}
    </div>
  );
}

function AssistantBlocks({
  blocks,
  results,
  running,
  live,
}: {
  blocks: ContentBlock[];
  results: Map<string, ToolResult>;
  running: Record<string, ToolRun>;
  live?: boolean;
}) {
  return (
    <>
      {blocks.map((b, i) => {
        if (!b) return null;
        const last = i === blocks.length - 1;
        if (b.type === "thinking") return <Thinking key={i} text={b.thinking} live={live && last} />;
        if (b.type === "text") return b.text.trim() ? <Markdown key={i} text={b.text} className={live && last ? "streaming" : ""} /> : null;
        if (b.type === "toolCall") {
          let args = b.arguments;
          if (live && b.argsText && Object.keys(args ?? {}).length === 0) {
            try {
              args = JSON.parse(b.argsText);
            } catch {
              args = {};
            }
          }
          return <ToolCard key={b.id || i} name={b.name} args={args ?? {}} result={results.get(b.id)} running={running[b.id]} live={live} />;
        }
        return null;
      })}
    </>
  );
}

/** A failed model call. A web page in place of an API reply gets an explanation, not raw HTML. */
function ModelError({ message }: { message?: string }) {
  const explained = explainModelError(message);
  if (!explained) return <div className="msg-error">⚠ {message ?? "The model returned an error"}</div>;
  return (
    <div className="msg-error">
      ⚠ {explained}{" "}
      <a href="#/settings">Open Settings → Test</a>
      <details>
        <summary className="muted small">Raw reply</summary>
        <pre className="code">{message}</pre>
      </details>
    </div>
  );
}

function Message({ m, results, running }: { m: AgentMessage; results: Map<string, ToolResult>; running: Record<string, ToolRun> }) {
  if (m.role === "user") {
    const text = textOf(m.content);
    // pi expands `/skill:name args` into `<skill name="name" …>body</skill>\n\nargs`; show it as the command.
    const skill = /^<skill name="([\w-]+)"[^>]*>[\s\S]*?<\/skill>\s*/.exec(text) ?? /^\/skill:([\w-]+)\s*/.exec(text);
    const rest = skill ? text.slice(skill[0].length) : text;
    return (
      <div className="msg msg-user">
        {skill && <span className="tag tag-skill">/{skill[1]}</span>}
        {rest && <div className="msg-user-text">{rest}</div>}
      </div>
    );
  }
  if (m.role === "assistant") {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text" as const, text: String(m.content) }];
    return (
      <div className="msg msg-assistant">
        <AssistantBlocks blocks={blocks} results={results} running={running} />
        {m.stopReason === "error" && <ModelError message={m.errorMessage} />}
        {m.stopReason === "aborted" && <div className="msg-note">Stopped.</div>}
      </div>
    );
  }
  if (m.role === "autoAnswer") {
    const by = m.by === "jev" ? "Jev" : String(m.by);
    return (
      <div className="msg msg-note">
        <span className="tag tag-ok">auto-approve</span> <code>{String(m.subject ?? m.tool)}</code>: allowed by {by}
        {typeof m.pSafe === "number" && ` (P(safe)=${m.pSafe.toFixed(2)})`}
      </div>
    );
  }
  if (m.role === "custom" || m.role === "compactionSummary" || m.role === "branchSummary") {
    return <div className="msg msg-note">{m.role === "compactionSummary" ? "Earlier context was compacted." : textOf(m.content)}</div>;
  }
  return null;
}

export function Transcript({ t }: { t: T }) {
  const results = new Map<string, ToolResult>();
  for (const m of t.messages) if (m.role === "toolResult" && m.toolCallId) results.set(m.toolCallId, m as ToolResult);
  return (
    <div className="transcript">
      {t.messages.map((m, i) => (m.role === "toolResult" ? null : <Message key={`${m.timestamp ?? 0}-${i}`} m={m} results={results} running={t.tools} />))}
      {t.streaming && Array.isArray(t.streaming.content) && (
        <div className="msg msg-assistant">
          <AssistantBlocks blocks={t.streaming.content} results={results} running={t.tools} live />
        </div>
      )}
      {/* Tools that are executing after their assistant message ended. */}
      {Object.values(t.tools)
        .filter((r) => !results.has(r.toolCallId) && !inStreaming(t, r.toolCallId))
        .filter((r) => !lastAssistantHas(t, r.toolCallId))
        .map((r) => (
          <ToolCard key={r.toolCallId} name={r.toolName} args={r.args} running={r} />
        ))}
      {t.busy && !t.streaming && Object.keys(t.tools).length === 0 && (
        <div className="msg msg-assistant working">
          <Spinner small /> Working…
        </div>
      )}
    </div>
  );
}

const inStreaming = (t: T, id: string) =>
  Array.isArray(t.streaming?.content) && (t.streaming!.content as ContentBlock[]).some((b) => b?.type === "toolCall" && b.id === id);

function lastAssistantHas(t: T, id: string) {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (m.role === "assistant") return Array.isArray(m.content) && m.content.some((b) => b?.type === "toolCall" && b.id === id);
  }
  return false;
}
