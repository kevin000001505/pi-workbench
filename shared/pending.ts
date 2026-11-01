/**
 * Which pending requests wait on the user. Shared by the server (session status) and the browser
 * (sidebar, tab count, notifications), so both agree.
 */

/** A permission being judged or reviewed does not wait on the user yet. */
export const waitsOnUser = (req: { judge?: { state: string }; reviewer?: { state: string } }) =>
  req.judge?.state !== "judging" && req.reviewer?.state !== "reviewing";
