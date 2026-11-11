/**
 * Which pending requests wait on the user. Shared by the server (session status) and the browser
 * (sidebar, tab count, notifications), so both agree.
 */

/** The part of a pending request `waitsOnUser` reads: the risk judge's, the reviewer pass's, and the
 * reviewer model's state. A session's pending request carries more than this, and need not carry it.
 */
export type WaitingState = { judge?: { state: string }; review?: { state: string }; reviewer?: { state: string } };

/** A permission the risk judge is still judging, or the reviewer is still reviewing, does not wait on the user yet. */
export const waitsOnUser = (req: WaitingState) =>
  req.judge?.state !== "judging" && req.review?.state !== "reviewing" && req.reviewer?.state !== "reviewing";
