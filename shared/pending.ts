/**
 * Which pending requests wait on the user. Shared by the server (session status) and the browser
 * (sidebar, tab count, notifications), so both agree.
 */

/** A permission the risk judge is still judging does not wait on the user yet. */
export const waitsOnUser = (req: { judge?: { state: string } }) => req.judge?.state !== "judging";
