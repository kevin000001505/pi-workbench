/**
 * The pipeline places an installed skill can be attached to (issue #117), in the order the pipeline
 * runs them: a skill is attached to some of these, and a run belongs to exactly one of them.
 */
export const ATTACH_POINTS = ["grill", "spec", "tickets", "implement", "review", "direct"] as const;

export type AttachPoint = (typeof ATTACH_POINTS)[number];

export function isAttachPoint(v: unknown): v is AttachPoint {
  return typeof v === "string" && (ATTACH_POINTS as readonly string[]).includes(v);
}

/** The attach points as the page and the server name them, in the pipeline's order. */
export const ATTACH_LABELS: Record<AttachPoint, string> = {
  grill: "Grill",
  spec: "Spec",
  tickets: "Tickets",
  implement: "Implement",
  review: "Review",
  direct: "Direct session",
};
