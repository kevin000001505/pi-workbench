import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted OpenAI-compatible endpoint for tests and local UI work. It answers by the last message:
 * - a tool result → "Done: <first line of the result>"
 * - user text containing "ssh" → bash `ssh Media true` (hits the approval gate)
 * - "push" → bash `git push origin HEAD` (hits the approval gate)
 * - "nuke" → bash `rm -rf /mnt/data` (the reviewer's scripted deny)
 * - "rm" → bash `rm -rf build`
 * - "twice" → two bash calls in one message, `git push origin HEAD` and `rm -rf build` (both gated)
 * - "ask" → ask_user with two options
 * - "list" → bash `ls`
 * - "load skill" / "load typesafe" → the extension's Skill tool for `tdd` / `typesafe-ai`
 * - "setup-matt-pocock-skills" → writes docs/agents/issue-tracker.md, then commits; a setup skill
 *   body that says SETUP_ASK asks the user a question first
 * - anything else → "Hello from the mock model."
 *
 * It also answers the workbench's local risk judge (issue #20): a non-streaming call for the judge
 * model id (`mock-judge`) gets a level word, by the command in the question's state (queued
 * `judgeReplies` answer first), while every other non-streaming call keeps the PR-draft answer.
 */
export function startMockLlm(port = 0): Promise<{ url: string; requests: any[]; judgeReplies: any[]; close: () => Promise<void> }> {
  const requests: any[] = [];
  const judgeReplies: any[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) {
      requests.push({ path: req.url, auth: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "Qwen3.8-27B-radiance" }, { id: "mock-small" }, { id: "mock-judge" }] }));
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    requests.push({ ...body, path: req.url, auth: req.headers.authorization });
    if (!body.stream && body.model === "mock-judge") {
      // The local risk judge: a non-streaming call for the judge model id gets a level word.
      const queued = judgeReplies.shift();
      if (queued) {
        if (queued.delayMs) await new Promise((r) => setTimeout(r, queued.delayMs));
        if (queued.status && queued.status !== 200) {
          res.writeHead(queued.status, { "Content-Type": "application/json" });
          return res.end(typeof queued.body === "string" ? queued.body : JSON.stringify(queued.body));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: queued.text } }] }));
      }
      const command = /"command"\s*:\s*"([^"]*)"/.exec(textOf((body.messages ?? []).at(-1)?.content))?.[1] ?? "";
      const word = command.includes("rm -rf /mnt") ? "DANGEROUS" : command.includes("rm ") ? "RISKY" : "SAFE";
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: word } }] }));
    }
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
    const tools = reply.tools ?? (reply.tool ? [reply.tool] : []);
    if (tools.length) {
      tools.forEach((tool, index) => {
        const args = JSON.stringify(tool.args);
        send(chunk({ tool_calls: [{ index, id: `call_${requests.length}_${index}`, type: "function", function: { name: tool.name, arguments: "" } }] }));
        for (let i = 0; i < args.length; i += 12) {
          send(chunk({ tool_calls: [{ index, function: { arguments: args.slice(i, i + 12) } }] }));
        }
      });
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
      resolve({ url: `http://127.0.0.1:${p}/v1`, requests, judgeReplies, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

type Tool = { name: string; args: Record<string, unknown> };
type Reply = { text?: string; tool?: Tool; tools?: Tool[] };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("");
  return "";
}

/**
 * The pipeline's phases, scripted by step (assistant replies since the last user message):
 * - grill-with-docs: ask to confirm → save_grill_summary → done
 * - to-spec: ask about seams → write the spec file → save_spec → done (trackerRef: the task's
 *   `SPEC_REF=<ref>`, or the spec file)
 * - to-tickets: ask to approve → write .scratch files → record_tickets (3 tickets) → done; a
 *   "Change it" answer ends the run with a question instead
 * - tdd (a ticket): commit a line for the ticket (and `git push`, a gated call, if the ticket says
 *   PUSHME) → finish_ticket (blocked if the ticket says BLOCKME) → done
 * - code-review: commit a fix and `git push` it (a gated call) → finish_review → done
 * - resolving-merge-conflicts (the base's work.txt keeps every word an earlier test pushed, so the
 *   newest word is checked first): keep both sides of every conflicted hunk in work.txt and commit the
 *   merge → finish_merge resolved → done; a base side that says GIVEUP is left alone → finish_merge failed,
 *   and one that says NOFINISH ends the run with no finish_merge call; one that says HOLDMERGE asks
 *   the user first and leaves the run waiting on that decision; one that says FAKERESOLVE
 *   calls finish_merge resolved with the merge still half done, ABORTRESOLVE after git merge --abort,
 *   and MARKERRESOLVE after committing the merge with its conflict markers in work.txt; one that says COMMITHOLD commits the resolve, then asks the user and waits without finish_merge;
 *   one that says SETEXT keeps both sides and adds a
 *   Markdown heading underlined with `=======` to work.txt
 */
function pipelineScript(userText: string, step: number, lastResult: string, conversation = ""): Reply | undefined {
  if (userText.includes('<skill name="grill-with-docs"')) {
    if (step === 0) return { tool: { name: "ask_user", args: { question: "We build a greeting file plus tests. Have we reached a shared understanding?", options: ["Yes, that's the plan", "Not yet"] } } };
    if (step === 1 && /Yes/.test(lastResult)) return { tool: { name: "save_grill_summary", args: { summary: "Build hello.txt saying Hello, with a test. No UI." } } };
    if (step === 1) return { text: "What is missing?" };
    return { text: "Grilling done." };
  }
  if (userText.includes('<skill name="to-spec"')) {
    if (step === 0) return { tool: { name: "ask_user", args: { question: "Test at the file level, through one seam: the hello.txt contents. OK?", options: ["Yes", "No"] } } };
    if (step === 1) return { tool: { name: "bash", args: { command: "mkdir -p .scratch/greeting && echo spec > .scratch/greeting/spec.md && echo published" } } };
    if (step === 2) {
      // A task that says `SPEC_REF=<ref>` publishes its spec there (an issue ref, as to-spec gives on GitHub);
      // one that says `GHSPEC <url>` publishes it as that GitHub issue.
      const ref = /SPEC_REF=(\S+)/.exec(conversation)?.[1] ?? /GHSPEC (\S+)/.exec(conversation)?.[1];
      return { tool: { name: "save_spec", args: { spec: "## Problem Statement\nNo greeting.\n## Solution\nhello.txt says Hello.", trackerRef: ref ?? ".scratch/greeting/spec.md" } } };
    }
    return { text: "Spec published." };
  }
  if (userText.includes('<skill name="to-tickets"')) {
    if (step === 0) return { tool: { name: "ask_user", args: { question: "Approve: 1. Write hello.txt; 2. Add a test (blocked by 1); 3. Add docs (blocked by 1)?", options: ["Approve", "Change it"] } } };
    if (step === 1 && /Change it/.test(lastResult)) return { text: "What should change in the breakdown?" };
    if (step === 1) return { tool: { name: "bash", args: { command: "mkdir -p .scratch/greeting/issues && for n in 01 02 03; do echo ticket > .scratch/greeting/issues/$n.md; done && echo published" } } };
    if (step === 2) {
      return {
        tool: {
          name: "record_tickets",
          args: {
            tickets: [
              { number: 1, title: "Write hello.txt", body: "Create hello.txt containing Hello. Push it. PUSHME", trackerRef: ".scratch/greeting/issues/01.md" },
              { number: 2, title: "Add a test", body: "Test that hello.txt says Hello.", blockedBy: [1], trackerRef: ".scratch/greeting/issues/02.md" },
              { number: 3, title: "Add docs", body: "Document it. BLOCKME", blockedBy: [1], trackerRef: ".scratch/greeting/issues/03.md" },
            ],
          },
        },
      };
    }
    return { text: "Published 3 tickets." };
  }
  if (userText.includes('<skill name="code-review"')) {
    // LONGREVIEW in the spec: three checks between the commit and finish_review.
    if (userText.includes("LONGREVIEW") && step >= 1 && step <= 3) return { tool: { name: "bash", args: { command: `echo check ${step}` } } };
    if (userText.includes("LONGREVIEW") && step === 4) return { tool: { name: "finish_review", args: { note: "Checked three times" } } };
    if (step === 0) return { tool: { name: "bash", args: { command: 'echo reviewed >> work.txt && git add -A && git commit -qm "Fix review findings" && git push -q origin HEAD && echo fixed' } } };
    if (step === 1) return { tool: { name: "finish_review", args: { note: "Fixed one naming issue" } } };
    return { text: "Review done." };
  }
  if (userText.includes('<skill name="resolving-merge-conflicts"')) {
    if (step === 0) {
      const keepBoth = "grep -v -e '^<<<<<<<' -e '^=======' -e '^>>>>>>>' work.txt > .resolved && mv .resolved work.txt && git add work.txt && git commit -q --no-edit && echo resolved";
      return { tool: { name: "bash", args: { command: `if grep -q COMMITHOLD work.txt; then ${keepBoth} && echo "hold on"; elif grep -q MARKERRESOLVE work.txt; then git add work.txt && git commit -q --no-edit && echo "faked"; elif grep -q ABORTRESOLVE work.txt; then git merge --abort && echo "faked"; elif grep -q FAKERESOLVE work.txt; then echo "faked"; elif grep -q HOLDMERGE work.txt; then echo "hold on"; elif grep -q NOFINISH work.txt; then echo "wandered off"; elif grep -q GIVEUP work.txt; then echo "cannot reconcile"; elif grep -q SETEXT work.txt; then ${keepBoth} && printf 'Notes\\n=======\\n' >> work.txt && git commit -q -a --amend --no-edit; else ${keepBoth}; fi` } } };
    }
    if (step === 1 && lastResult.includes("faked")) return { tool: { name: "finish_merge", args: { status: "resolved", note: "all good" } } };
    if (step === 1 && lastResult.includes("hold on")) return { tool: { name: "ask_user", args: { question: "Keep both sides of work.txt?", options: ["Yes", "No"] } } };
    if (step === 1 && lastResult.includes("wandered off")) return { text: "I looked at it." };
    if (step === 1) {
      return lastResult.includes("cannot reconcile")
        ? { tool: { name: "finish_merge", args: { status: "failed", note: "Both sides rewrote the last line of work.txt, and only a human can pick one" } } }
        : { tool: { name: "finish_merge", args: { status: "resolved", note: "kept both sides' lines in work.txt" } } };
    }
    return { text: "Merge finished." };
  }
  if (userText.includes('<skill name="diagnosing-bugs"')) return rescueScript(userText, step);
  if (userText.includes('<skill name="retro"')) return retroScript(userText, step);
  if (userText.includes('<skill name="tdd"')) {
    const num = /Ticket #(\d+)/.exec(userText)?.[1] ?? "?";
    // A fix run carries the rescue's diagnosis: the stuck-ticket words no longer apply.
    const fixing = userText.includes("## Diagnosis");
    if (fixing && userText.includes("FIXBLOCKME")) return step === 0 ? { tool: { name: "finish_ticket", args: { status: "blocked", note: "The diagnosis did not help" } } } : { text: "Blocked." };
    if (fixing && userText.includes("FIXLOOPME")) return { tool: { name: "bash", args: { command: "echo fixing; exit 1" } } };
    const stuck = fixing ? undefined : stuckTicket(userText, step);
    if (stuck) return stuck;
    const push = userText.includes("PUSHME") ? " && git push -q origin HEAD" : "";
    if (step === 0) return { tool: { name: "bash", args: { command: `echo "ticket ${num}" >> work.txt && git add -A && git commit -qm "Ticket ${num}"${push} && echo committed` } } };
    if (step === 1) {
      const blocked = userText.includes("BLOCKME");
      return { tool: { name: "finish_ticket", args: { status: blocked ? "blocked" : "done", note: blocked ? "Needs a docs folder decision" : `Ticket ${num} appended to work.txt` } } };
    }
    return { text: `Ticket ${num} finished.` };
  }
  return undefined;
}

/**
 * Ticket bodies that drive the stop rule (issue #39):
 * - LOOPME: the same failing bash call forever (the repeat limit); DIRTYME first edits README.md
 * - WANDERME: a different bash call each step (the tool-call limit)
 * - SLOWME: a long `sleep` (the time limit); with ASKME, an ask_user first (the clock pauses)
 * - CYCLEME: test, write, test, write, test, then finish_ticket done (a TDD cycle, never a loop)
 * - QUICKME: finish_ticket done at once
 * - SILENTME: a text reply, no finish_ticket
 */
function stuckTicket(userText: string, step: number): Reply | undefined {
  // DIRTYME: an uncommitted change first, so the rescue handoff has a diff.
  if (userText.includes("DIRTYME") && step === 0) return { tool: { name: "bash", args: { command: "echo half-done >> README.md" } } };
  if (userText.includes("LOOPME")) return { tool: { name: "bash", args: { command: "echo tests failed: expected Hello; exit 1" } } };
  if (userText.includes("WANDERME")) return { tool: { name: "bash", args: { command: `echo call ${step}` } } };
  if (userText.includes("SLOWME")) {
    const ask = userText.includes("ASKME");
    if (ask && step === 0) return { tool: { name: "ask_user", args: { question: "Which greeting?", options: ["Hello", "Hi"] } } };
    if (step === (ask ? 1 : 0)) return { tool: { name: "bash", args: { command: "sleep 30" } } };
    return { text: "Slept." };
  }
  if (userText.includes("CYCLEME")) {
    if (step >= 5) return step === 5 ? { tool: { name: "finish_ticket", args: { status: "done", note: "Cycled" } } } : { text: "Cycled." };
    return step % 2 === 0
      ? { tool: { name: "bash", args: { command: "echo running the tests" } } }
      : { tool: { name: "write", args: { path: "cycle.txt", content: `v${step}\n` } } };
  }
  if (userText.includes("SILENTME")) return { text: "I am not sure what to do." };
  if (userText.includes("QUICKME")) {
    return step === 0 ? { tool: { name: "finish_ticket", args: { status: "done", note: "Quick" } } } : { text: "Quick." };
  }
  return undefined;
}

/**
 * A rescue run (/skill:diagnosing-bugs, issue #40), by words in the ticket body it hands off:
 * - RESCUE_NOLOOP / RESCUE_FAILED: finish_diagnosis no_loop / failed
 * - RESCUE_SILENT: a text reply, no finish_diagnosis
 * - RESCUE_DIRTY: leaves a [DEBUG-1] line in work.txt, then reports diagnosed
 * - RESCUE_LOOP: the same probe forever (the stop rule)
 * - otherwise: one probe, then diagnosed with a command and a file:line chain
 */
function rescueScript(userText: string, step: number): Reply {
  if (userText.includes("RESCUE_LOOP")) return { tool: { name: "bash", args: { command: "echo probe" } } };
  if (userText.includes("RESCUE_SILENT")) return { text: "I looked around." };
  for (const [word, status] of [["RESCUE_NOLOOP", "no_loop"], ["RESCUE_FAILED", "failed"]] as const) {
    if (userText.includes(word)) return step === 0 ? { tool: { name: "finish_diagnosis", args: { status, note: `Rescue says ${status}` } } } : { text: "Reported." };
  }
  const probe = userText.includes("RESCUE_DIRTY") ? 'echo "[DEBUG-1] probe" >> work.txt' : "git log --oneline -1";
  if (step === 0) return { tool: { name: "bash", args: { command: probe } } };
  if (step === 1) {
    return {
      tool: {
        name: "finish_diagnosis",
        args: { status: "diagnosed", command: "echo red", chain: ["work.txt:1 has no greeting", "hello.txt:1 is never written"], note: "Found it" },
      },
    };
  }
  return { text: "Diagnosed." };
}

/**
 * A retro run (/skill:retro, issue #41), by words in the rescued tickets' bodies:
 * - RETRO_SILENT: a text reply, no finish_retro
 * - RETRO_LOOP: the same read forever (the stop rule)
 * - RETRO_DIRTY: writes notes.txt, then reports
 * - RETRO_HOLD: asks the user first (the run waits on a decision), then reports
 * - otherwise: one read, then finish_retro with a proposal
 */
function retroScript(userText: string, step: number): Reply {
  if (userText.includes("RETRO_SILENT")) return { text: "Nothing to add." };
  if (userText.includes("RETRO_LOOP")) return { tool: { name: "bash", args: { command: "git log --oneline -3" } } };
  if (step === 0 && userText.includes("RETRO_HOLD")) return { tool: { name: "ask_user", args: { question: "Is the retro scope right?", options: ["Yes", "No"] } } };
  if (step === 0) return { tool: { name: "bash", args: { command: userText.includes("RETRO_DIRTY") ? "echo retro >> notes.txt" : "git log --oneline -3" } } };
  if (step === 1) return { tool: { name: "finish_retro", args: { report: "Raise the repeat limit to 4 in Settings → Pipeline: the test loop was a real loop." } } };
  return { text: "Retro done." };
}

const writeMarker = () => ({ tool: { name: "bash", args: { command: "mkdir -p docs/agents && printf 'GitHub issues\\n' > docs/agents/issue-tracker.md && echo wrote" } } });
const commitSetup = () => ({ tool: { name: "bash", args: { command: 'git add -A && git commit -qm "Set up agent skills"' } } });
const keepWorking = () => ({ tool: { name: "bash", args: { command: "sleep 6 && echo still setting up" } } });

/**
 * The agent-skills setup run (the session that runs setup-matt-pocock-skills): write the marker file,
 * then commit it. A setup skill whose body says SETUP_ASK — the setup-session tests' skill file —
 * asks the user which issue tracker the repo uses before it writes anything. A body that says
 * SETUP_SLOW keeps the run open after the commit, so a test can stop it between the two.
 */
function setupScript(userText: string, step: number): Reply | undefined {
  if (!userText.includes("setup-matt-pocock-skills")) return undefined;
  const turns: Reply[] = [];
  if (userText.includes("SETUP_ASK")) turns.push({ tool: { name: "ask_user", args: { question: "Which issue tracker does this repo use?", options: ["GitHub Issues", "No tracker"] } } });
  turns.push(writeMarker(), commitSetup());
  if (userText.includes("SETUP_SLOW")) turns.push(keepWorking());
  return turns[step] ?? { text: "Setup done." };
}

function script(messages: { role: string; content: unknown }[]): Reply {
  const last = messages[messages.length - 1];
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const lastUser = messages[lastUserIdx];
  const userText = textOf(lastUser?.content);
  const step = messages.slice(lastUserIdx + 1).filter((m) => m.role === "assistant").length;
  const conversation = messages.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
  const piped = pipelineScript(userText, step, last?.role === "tool" ? textOf(last.content) : "", conversation);
  if (piped) return piped;
  const setup = setupScript(userText, step);
  if (setup) return setup;
  if (last?.role === "tool") {
    const result = textOf(last.content).split("\n")[0].slice(0, 80);
    return { text: `Done: ${result}` };
  }
  if (/\bssh\b/i.test(userText)) return { tool: { name: "bash", args: { command: "ssh Media true" } } };
  if (/\btwice\b/i.test(userText)) {
    return { tools: [{ name: "bash", args: { command: "git push origin HEAD" } }, { name: "bash", args: { command: "rm -rf build" } }] };
  }
  if (/\bpush\b/i.test(userText)) return { tool: { name: "bash", args: { command: "git push origin HEAD" } } };
  if (/\bnuke\b/i.test(userText)) return { tool: { name: "bash", args: { command: "rm -rf /mnt/data" } } };
  if (/\brm\b/i.test(userText)) return { tool: { name: "bash", args: { command: "rm -rf build" } } };
  if (/\bask\b/i.test(userText)) {
    return { tool: { name: "ask_user", args: { question: "Which database should I use?", options: ["SQLite (Recommended)", "Postgres"] } } };
  }
  if (/\bload typesafe\b/i.test(userText)) return { tool: { name: "Skill", args: { skill: "typesafe-ai" } } };
  if (/\bload skill\b/i.test(userText)) return { tool: { name: "Skill", args: { skill: "tdd" } } };
  if (/\blist\b/i.test(userText)) return { tool: { name: "bash", args: { command: "ls" } } };
  return { text: "Hello from the mock model. Everything looks fine." };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_PORT ?? 18080);
  startMockLlm(port).then(({ url }) => console.log(`mock LLM at ${url}`));
}
