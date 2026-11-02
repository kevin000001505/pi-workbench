import type { PipelineSettings } from "./settings.ts";

/** Which stop-rule condition fired, what it saw, and when (GLOSSARY: Stop rule). */
export type StopReason = { condition: "time" | "repeat" | "toolCalls"; detail: string; at: number };

/** The stop reason in words, for flags and notifications. */
export function describeStopReason(r: StopReason): string {
  const at = new Date(r.at).toISOString().slice(11, 19);
  const what = r.condition === "time" ? "the time limit" : r.condition === "repeat" ? "the repeat limit" : "the tool-call limit";
  return `${what} (${r.detail}) at ${at} UTC`;
}

/**
 * The stop rule for one run: it counts the run's tool calls and its working time, and returns a
 * StopReason when a pipeline limit is passed. It only decides; the SessionManager aborts the run and
 * picks the outcome (a ticket run's differs from a retro run's).
 *
 * - repeat: `repeatLimit` consecutive calls with the same tool name and the same JSON input. Any
 *   other call (a write or edit between two test runs, say) resets the count.
 * - toolCalls: more than `toolCallLimit` calls in the run.
 * - time: more than `timeLimitMinutes` of working time; `tick` with `paused` (a permission or a
 *   decision waits for the user, or the run is idle) stops the clock.
 */
export class StopRule {
  private limits: PipelineSettings;
  private minuteMs: number;
  private workedMs = 0;
  private lastTick: number;
  private lastCall = "";
  private repeats = 0;
  private calls = 0;
  /** The condition that fired; set once, and the run is aborted after it. */
  reason?: StopReason;

  constructor(limits: PipelineSettings, minuteMs: number, now = Date.now()) {
    this.limits = limits;
    this.minuteMs = minuteMs;
    this.lastTick = now;
  }

  toolCall(name: string, args: unknown, now = Date.now()): StopReason | undefined {
    if (this.reason) return undefined;
    const call = `${name} ${JSON.stringify(args ?? {})}`;
    this.repeats = call === this.lastCall ? this.repeats + 1 : 1;
    this.lastCall = call;
    this.calls += 1;
    if (this.repeats >= this.limits.repeatLimit) {
      return this.fire("repeat", `${this.repeats} identical calls in a row: ${call.length > 200 ? `${call.slice(0, 200)}…` : call}`, now);
    }
    if (this.calls > this.limits.toolCallLimit) return this.fire("toolCalls", `${this.calls} tool calls, limit ${this.limits.toolCallLimit}`, now);
    return undefined;
  }

  tick(paused: boolean, now = Date.now()): StopReason | undefined {
    if (!paused) this.workedMs += now - this.lastTick;
    this.lastTick = now;
    if (this.reason) return undefined;
    if (this.workedMs > this.limits.timeLimitMinutes * this.minuteMs) {
      return this.fire("time", `${this.limits.timeLimitMinutes} min of work, the clock paused while the user was asked`, now);
    }
    return undefined;
  }

  private fire(condition: StopReason["condition"], detail: string, at: number): StopReason {
    this.reason = { condition, detail, at };
    return this.reason;
  }
}
