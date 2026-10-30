import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted OpenAI-compatible endpoint for tests and local UI work. It answers by the last message:
 * - a tool result → "Done: <first line of the result>"
 * - user text containing "push" → bash `git push origin HEAD` (hits the approval gate)
 * - "rm" → bash `rm -rf build`
 * - "ask" → ask_user with two options
 * - "list" → bash `ls`
 * - "setup-matt-pocock-skills" → writes docs/agents/issue-tracker.md, then commits
 * - anything else → "Hello from the mock model."
 */
export function startMockLlm(port = 0): Promise<{ url: string; requests: any[]; close: () => Promise<void> }> {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "Qwen3.8-27B-radiance" }, { id: "mock-small" }] }));
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    const reply = script(body.messages ?? []);
    if (!body.stream) {
      // Non-streaming calls are the workbench's PR drafts.
      const pr = { title: "Add a friendly greeting", body: "## Summary\n- Set up agent skills\n- Greet the user\n\n## Testing\n- Ran it" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `<think>hmm</think>${JSON.stringify(pr)}` } }] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunk = (delta: unknown, finish: string | null = null) => ({
      id: "mock",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    send(chunk({ role: "assistant", content: "" }));
    if (reply.tool) {
      const args = JSON.stringify(reply.tool.args);
      send(chunk({ tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: reply.tool.name, arguments: "" } }] }));
      for (let i = 0; i < args.length; i += 12) {
        send(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 12) } }] }));
      }
      send(chunk({}, "tool_calls"));
    } else {
      for (const word of reply.text!.split(/(?<= )/)) {
        send(chunk({ content: word }));
        await new Promise((r) => setTimeout(r, 5));
      }
      send(chunk({}, "stop"));
    }
    send({ id: "mock", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(port, process.env.MOCK_HOST ?? "127.0.0.1", () => {
      const { port: p } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${p}/v1`, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

type Reply = { text?: string; tool?: { name: string; args: Record<string, unknown> } };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("");
  return "";
}

/**
 * The pipeline's three phases, scripted by step (assistant replies since the last user message):
 * - grill-me: ask to confirm → save_grill_summary → done
 * - to-tickets: ask to approve → write .scratch files → record_tickets (3 tickets) → done
 * - implement: commit a line for the ticket → finish_ticket (blocked if the ticket says BLOCKME) → done
 */
function pipelineScript(userText: string, step: number, lastResult: string): Reply | undefined {
  if (userText.includes('<skill name="grill-me"')) {
    if (step === 0) return { tool: { name: "ask_user", args: { question: "We build a greeting file plus tests. Have we reached a shared understanding?", options: ["Yes, that's the plan", "Not yet"] } } };
    if (step === 1 && /Yes/.test(lastResult)) return { tool: { name: "save_grill_summary", args: { summary: "Build hello.txt saying Hello, with a test. No UI." } } };
    if (step === 1) return { text: "What is missing?" };
    return { text: "Grilling done." };
  }
  if (userText.includes('<skill name="to-tickets"')) {
    if (step === 0) return { tool: { name: "ask_user", args: { question: "Approve: 1. Write hello.txt; 2. Add a test (blocked by 1); 3. Add docs (blocked by 1)?", options: ["Approve", "Change it"] } } };
    if (step === 1) return { tool: { name: "bash", args: { command: "mkdir -p .scratch/greeting/issues && for n in 01 02 03; do echo ticket > .scratch/greeting/issues/$n.md; done && echo published" } } };
    if (step === 2) {
      return {
        tool: {
          name: "record_tickets",
          args: {
            tickets: [
              { number: 1, title: "Write hello.txt", body: "Create hello.txt containing Hello.", trackerRef: ".scratch/greeting/issues/01.md" },
              { number: 2, title: "Add a test", body: "Test that hello.txt says Hello.", blockedBy: [1], trackerRef: ".scratch/greeting/issues/02.md" },
              { number: 3, title: "Add docs", body: "Document it. BLOCKME", blockedBy: [1], trackerRef: ".scratch/greeting/issues/03.md" },
            ],
          },
        },
      };
    }
    return { text: "Published 3 tickets." };
  }
  if (userText.includes('<skill name="implement"')) {
    const num = /Ticket #(\d+)/.exec(userText)?.[1] ?? "?";
    if (step === 0) return { tool: { name: "bash", args: { command: `echo "ticket ${num}" >> work.txt && git add -A && git commit -qm "Ticket ${num}" && echo committed` } } };
    if (step === 1) {
      const blocked = userText.includes("BLOCKME");
      return { tool: { name: "finish_ticket", args: { status: blocked ? "blocked" : "done", note: blocked ? "Needs a docs folder decision" : `Ticket ${num} appended to work.txt` } } };
    }
    return { text: `Ticket ${num} finished.` };
  }
  return undefined;
}

function script(messages: { role: string; content: unknown }[]): Reply {
  const last = messages[messages.length - 1];
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const lastUser = messages[lastUserIdx];
  const userText = textOf(lastUser?.content);
  const step = messages.slice(lastUserIdx + 1).filter((m) => m.role === "assistant").length;
  const piped = pipelineScript(userText, step, last?.role === "tool" ? textOf(last.content) : "");
  if (piped) return piped;
  if (last?.role === "tool") {
    const result = textOf(last.content).split("\n")[0].slice(0, 80);
    if (userText.includes("setup-matt-pocock-skills") && !messages.some((m) => m.role === "assistant" && JSON.stringify(m).includes("git commit"))) {
      return { tool: { name: "bash", args: { command: 'git add -A && git commit -qm "Set up agent skills"' } } };
    }
    return { text: `Done: ${result}` };
  }
  if (userText.includes("setup-matt-pocock-skills")) {
    return {
      tool: {
        name: "bash",
        args: { command: "mkdir -p docs/agents && printf 'GitHub issues\\n' > docs/agents/issue-tracker.md && echo wrote" },
      },
    };
  }
  if (/\bpush\b/i.test(userText)) return { tool: { name: "bash", args: { command: "git push origin HEAD" } } };
  if (/\brm\b/i.test(userText)) return { tool: { name: "bash", args: { command: "rm -rf build" } } };
  if (/\bask\b/i.test(userText)) {
    return { tool: { name: "ask_user", args: { question: "Which database should I use?", options: ["SQLite (Recommended)", "Postgres"] } } };
  }
  if (/\bload skill\b/i.test(userText)) return { tool: { name: "Skill", args: { skill: "implement" } } };
  if (/\blist\b/i.test(userText)) return { tool: { name: "bash", args: { command: "ls" } } };
  return { text: "Hello from the mock model. Everything looks fine." };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_PORT ?? 18080);
  startMockLlm(port).then(({ url }) => console.log(`mock LLM at ${url}`));
}
