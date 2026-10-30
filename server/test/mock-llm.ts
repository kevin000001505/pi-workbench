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

function script(messages: { role: string; content: unknown }[]): Reply {
  const last = messages[messages.length - 1];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userText = textOf(lastUser?.content);
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
  if (/\blist\b/i.test(userText)) return { tool: { name: "bash", args: { command: "ls" } } };
  return { text: "Hello from the mock model. Everything looks fine." };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_PORT ?? 18080);
  startMockLlm(port).then(({ url }) => console.log(`mock LLM at ${url}`));
}
