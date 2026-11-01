/**
 * Which pending requests wait on the user. Shared by the server (session status) and the browser
 * (sidebar, tab count, notifications), so both agree.
 */

/** A permission the risk judge is still judging, or the reviewer is still reviewing, does not wait on the user yet. */
export const waitsOnUser = (req: { judge?: { state: string }; review?: { state: string } }) =>
  req.judge?.state !== "judging" && req.review?.state !== "reviewing";
