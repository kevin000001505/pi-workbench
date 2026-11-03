import { useState } from "react";
import { parseIssueRef } from "../../../shared/board.ts";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import { isResolvedNote, type Phase, type SessionSummary, type Ticket } from "../types.ts";
import { Markdown, Spinner } from "../ui.tsx";

const STEPS: { phase: Phase; label: string }[] = [
  { phase: "setup", label: "Setup" },
  { phase: "grill", label: "Grill" },
  { phase: "spec", label: "Spec" },
  { phase: "tickets", label: "Tickets" },
  { phase: "ready", label: "Ready" },
  { phase: "implement", label: "Implement" },
  { phase: "review", label: "Review" },
  { phase: "retro", label: "Retro" },
  { phase: "done", label: "Done" },
];

export const phaseLabel = (s: SessionSummary) => {
  if (s.mode !== "pipeline") return s.phase === "setup" ? "Setting up skills" : "";
  const running = s.tickets.find((t) => t.status === "running");
  const done = s.tickets.filter((t) => t.status === "done").length;
  switch (s.phase) {
    case "setup":
      return "Setting up skills";
    case "grill":
      return "Grilling the plan";
    case "spec":
      return "Writing the spec";
    case "tickets":
      return "Writing tickets";
    case "ready":
      return `${s.tickets.length} tickets ready · waits for Solve all`;
    case "implement":
      return running ? `Ticket ${running.num} · ${done}/${s.tickets.length} done` : `${done}/${s.tickets.length} tickets done`;
    case "review":
      return `Reviewing all ${s.tickets.length} tickets`;
    case "pr":
      return s.prNumber ? `PR #${s.prNumber} open` : "PR open";
    case "retro":
      return "Retro of the rescued tickets";
    case "done":
      return s.tickets.length ? `All ${s.tickets.length} tickets done` : "Pipeline stopped";
    default:
      return "";
  }
};

/** "#12" for GitHub issues (any ref form parseIssueRef reads), the file name for local ticket files. */
export const refLabel = (ref: string) => {
  const issue = parseIssueRef(ref);
  if (!issue) return ref.split("/").pop() || ref;
  return issue.repo ? `${issue.repo.split("/").pop()}#${issue.number}` : `#${issue.number}`;
};

const RESCUE_LABEL = { diagnosing: "rescue: diagnosing", fixing: "rescue: fixing", rescued: "rescued", failed: "rescue failed" } as const;

function TicketRow({ t, all, viewing, onView }: { t: Ticket; all: Ticket[]; viewing: boolean; onView: (runId: string) => void }) {
  const [open, setOpen] = useState(false);
  const waitingOn = t.blockedBy.filter((b) => all.find((x) => x.num === b)?.status !== "done");
  return (
    <div className={`ticket ticket-${t.status} ${viewing ? "ticket-viewing" : ""}`}>
      <button className="ticket-head" onClick={() => setOpen((o) => !o)}>
        <span className="ticket-state">{t.status === "running" ? <Spinner small /> : t.status === "done" ? "✓" : t.status === "blocked" ? "!" : "○"}</span>
        <span className="ticket-num mono">#{t.num}</span>
        <span className="ticket-title">{t.title}</span>
        {t.status === "ready" && waitingOn.length > 0 && <span className="muted small">after #{waitingOn.join(", #")}</span>}
        {t.rescueState && <span className={`tag ticket-rescue ticket-rescue-${t.rescueState}`} title="The stop rule stopped this ticket; a rescue run on the Reviewer model diagnoses it, then a fix run fixes it">{RESCUE_LABEL[t.rescueState]}</span>}
        {t.trackerRef && <span className="tag mono ticket-ref" title={t.trackerRef}>{refLabel(t.trackerRef)}</span>}
      </button>
      {open && (
        <div className="ticket-body">
          <Markdown text={t.body} />
          {t.note && (
            <p className="ticket-note">
              <strong>Note:</strong> {t.note}
            </p>
          )}
          {t.runId && (
            <button className="btn btn-sm" onClick={() => onView(t.runId!)}>
              {viewing ? "Viewing this run" : "View this ticket's run"}
            </button>
          )}
          {t.rescueRunId && (
            <button className="btn btn-sm" onClick={() => onView(t.rescueRunId!)}>
              View the rescue run
            </button>
          )}
          {t.fixRunId && (
            <button className="btn btn-sm" onClick={() => onView(t.fixRunId!)}>
              View the fix run
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Where a pipeline session stands: phase steps, the attention banner, and the ticket list. */
export function PipelinePanel({ s, viewRun, onView }: { s: SessionSummary; viewRun: string; onView: (runId: string) => void }) {
  const { toast } = useStore();
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const current = STEPS.findIndex((x) => x.phase === s.phase);
  const done = s.tickets.filter((t) => t.status === "done").length;

  const act = async (action: "retry" | "skip" | "stop") => {
    if (action === "stop" && !confirm("Stop the pipeline? The card pauses in Issues with its tickets as they are; Solve all (a move to Doing) continues it.")) return;
    setBusy(true);
    try {
      await api.post(`/api/sessions/${s.id}/pipeline`, { action });
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pipeline">
      <div className="pipeline-bar">
        <ol className="steps">
          {STEPS.map((step, i) => (
            <li key={step.phase} className={i < current ? "step-done" : i === current ? "step-now" : ""}>
              <span className="step-dot" />
              {step.label}
              {step.phase === "implement" && s.tickets.length > 0 && (
                <span className="muted small">
                  {" "}
                  {done}/{s.tickets.length}
                </span>
              )}
            </li>
          ))}
        </ol>
        {s.tickets.length > 0 && (
          <div className="pipeline-progress" title={`${done} of ${s.tickets.length} tickets done`}>
            <span style={{ width: `${(done / s.tickets.length) * 100}%` }} />
          </div>
        )}
        {(s.tickets.length > 0 || s.grillSummary || s.spec) && (
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Show"} plan
          </button>
        )}
        {/* Stop pauses the card to Issues, so it shows only once there are tickets to come back to. */}
        {(s.phase === "implement" || s.phase === "review" || s.phase === "retro") && (
          <button className="btn btn-ghost btn-sm danger" disabled={busy} onClick={() => act("stop")}>
            Stop pipeline
          </button>
        )}
      </div>

      {s.attention && (
        <div className={`attention ${isResolvedNote(s.attention) ? "attention-ok" : ""}`}>
          <span>{isResolvedNote(s.attention) ? "✓" : "⚠"} {s.attention}</span>
          {(s.phase === "implement" || s.phase === "review") && (
            <div className="row gap">
              <button className="btn btn-sm" disabled={busy} onClick={() => act("retry")}>
                {s.phase === "review" ? "Retry review" : "Retry ticket"}
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => act("skip")}>
                Mark done &amp; continue
              </button>
            </div>
          )}
        </div>
      )}
      {s.phase === "done" && s.tickets.length > 0 && !s.prUrl && (
        <div className="attention attention-ok">
          <span>✓ All tickets are done and reviewed on {s.branch}. Check the changes, then Create PR.</span>
        </div>
      )}

      {open && (s.tickets.length > 0 || s.grillSummary || s.spec) && (
        <div className="pipeline-body">
          {s.grillSummary && (
            <details className="grill-summary">
              <summary>Agreed decisions</summary>
              <Markdown text={s.grillSummary} />
            </details>
          )}
          {s.spec && (
            <details className="grill-summary">
              <summary>
                Spec {s.specRef && <span className="tag mono" title={s.specRef}>{refLabel(s.specRef)}</span>}
              </summary>
              <Markdown text={s.spec} />
            </details>
          )}
          {s.tickets.length > 0 && (
            <div className="tickets">
              {s.tickets.map((t) => (
                <TicketRow key={t.num} t={t} all={s.tickets} viewing={viewRun === t.runId} onView={onView} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
