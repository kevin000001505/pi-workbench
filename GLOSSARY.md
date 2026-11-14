# pi workbench

Self-hosted web UI that drives the pi coding agent on your repos. This glossary covers the issue-solving flow (reading GitHub issues and turning them into pull requests) the machines the agent can reach, and how the agent's permissions get answered.

## Language

**Agent-skills setup**:
The one time a tracked repo gets the files the agent skills need (the setup marker file `docs/agents/issue-tracker.md` and its companions). The workbench records `set_up` or `not_set_up` on the repo row, and the Repos page states that, or **setup in progress** while the repo's setup session runs its setup. A repo that is not set up starts its **setup session** when the workbench adds it, and it has a **Run setup** action to start one when no setup session runs: that session runs `/setup-matt-pocock-skills`, and when that run settles the workbench lands its commit on the repo's default branch, records `set_up`, and puts the card in Done. A repo recorded `set_up` starts every card past setup, so no repo runs the setup twice.
_Avoid_: repo setup (say **Run setup** for the action, **setup session** for the session it starts), setup check (the workbench checks the marker file once, then reads the record)

**Issue**:
A GitHub issue (feature request, bug, task) in a repository the workbench tracks.
_Avoid_: pull request (a PR is not an issue; GitHub's issues feed mixes them in and the workbench filters PRs out)

**Origin issue**:
The issue a session was started from; the session's PR body carries a `Closes` line for it, so merging the PR closes it.
_Avoid_: source issue, parent issue

**Ticket issue**:
An issue the pipeline's ticket phase publishes, referenced from a ticket's tracker ref; it too becomes a `Closes` line in the PR body, distinct from the origin issue.
_Avoid_: sub-issue

**Solve all tickets**:
The move of a card from Issues to Doing (for an unclaimed card, it creates the session): one pipeline session reads every open ticket sub-issue with its blocking edges from GitHub, skips grill/spec/tickets, implements the tickets one fresh run at a time in dependency order, and opens a PR whose merge closes the spec issue and every ticket issue.
_Avoid_: solve all issues (that is the **Issue queue**'s button: it starts one card after another, not one session for every issue)

**Solve one ticket**:
The Solve button on a ticket row of a spec card's detail: the card's session runs only that ticket, in a fresh run, and when the ticket is done the card pauses back in Issues (for example 1/3 done). When the last ticket is done, the card goes on to the review and the PR. A Solve on a sub-issue row of an unclaimed spec card's detail creates the spec's session and runs only that sub-issue, as its solo ticket.
_Avoid_: Solve (that is for a plain issue), Solve all (that is the board card's button; it is the move that is **Solve all tickets**)

**Solo ticket**:
The one ticket a card runs on a Solve one ticket, kept in the session while it is set: when the ticket is done the card pauses back in Issues instead of going on to the next ticket. Solve all, a backward move, and Stop clear it.
_Avoid_: single ticket, one ticket, solo run

**SSH host**:
A remote machine registered in the workbench's SSH config, addressed by an alias you can say ("Media"); the agent reaches it with `ssh <alias>` and works code on it from there.
_Avoid_: server (that's the workbench's own server), VM (the transport is plain ssh; the target need not be a VM), machine (too generic; could mean the box the workbench runs on)

### Permissions

**Permission**:
A gated tool call the agent waits on, answered with Allow, Allow for this session, or Deny.
_Avoid_: decision (that is an ask_user question), approval request

**Decision**:
A question the agent puts to the user through `ask_user`, answered by picking an option or typing an answer; only the user answers it.
_Avoid_: permission

**Auto-approve**:
The mode in which permissions are answered by the risk judge and the reviewer instead of the user; on or off globally, overridable per session.
_Avoid_: autopilot, YOLO mode

**Risk judge**:
The model at the judge URL that rates a permission as safe, risky, or dangerous: Jev through TypeSafe's API, or any OpenAI-compatible model, such as a local one.
_Avoid_: decision model, classifier

**Reviewer**:
The frontier model (Claude or OpenAI) that allows, denies, or escalates a permission the risk judge did not rate safe.
_Avoid_: frontier model (as a role name), approver

**Cut-off**:
One of the two thresholds the user sets for the risk judge's yes/no answers: above the yes cut-off an answer counts as yes, below the no cut-off as no, and between them as unsettled.
_Avoid_: threshold (too vague; there are two), confidence

**Escalation**:
The reviewer handing a permission back to the user because it could break something beyond the task.
_Avoid_: fallback (a failed judge or reviewer also lands with the user, but no model chose it)

### Pipeline

**Stop rule**:
The three conditions that stop a run in the implement phase: a time limit, a repeated tool call with the same input, or a tool-call count limit.
_Avoid_: watchdog (that is the mechanism that enforces it), circuit breaker

**Rescue run**:
A run with the Reviewer's model that diagnoses a stuck ticket with `diagnosing-bugs` Phases 1 to 4; it finds the cause but does not fix it.
_Avoid_: escalation (that is the Reviewer handing a permission to the user), fallback

**Fix run**:
A fresh local-model run that fixes a rescued ticket from its diagnosis.
_Avoid_: retry (a retry re-runs the same ticket with the same model; a fix run starts clean from a diagnosis)

**Retro run**:
A run at the end of a spec that reviews the rescued tickets with the `retro` skill and only proposes changes.
_Avoid_: code review (the review phase reads every change; the retro reads only the rescued tickets)

**Setup session**:
The one session the workbench starts when you add a repo recorded as not set up, or when you tap **Run setup** on a repo that has none; it runs only the agent-skills setup skill and holds no task. Its card sits in To do while it works, and lands in Done when the workbench pushes its setup commit to the repo's default branch — no pull request, no Approve.
_Avoid_: setup run (a setup run is the setup step inside any session, not the session whose whole job is setup)

**Setup run**:
The setup step a session runs first, on a repo its recorded setup state does not hold as set up. The record decides it, not the worktree, so no repo runs the setup twice.
_Avoid_: setup session (that is the one session whose whole job is this step, and whose commit lands on the default branch)

### Board

**Board**:
The kanban view of the workbench's features, with one column per stage of the pipeline.
_Avoid_: kanban (the style, not the thing), dashboard

**Card**:
One feature on the board: a pipeline session, a direct session, or an unclaimed card (a plain issue or a spec issue with its open tickets), and the PR that delivers it. A click on a spec card toggles a row of ticket sub-cards under it, one row open at a time: a started card's row is its tickets, with their state, a done card's row is its recorded sub-issues. Every session card keeps its whole-card actions on the card: **Approve** while it is in **Review** and **Abandon** until it is **Done**, on a direct card as on a spec card, and **Stop**, **Retry** and **Answer** on a pipeline card only. An unclaimed card's buttons are the column moves (**Solve all** on a spec card, **Solve** and **Split** on a plain one).
_Avoid_: task (kanzo's word), ticket (a ticket is one part of a card)

**To do**:
The column for a feature that is still being grilled, specced, or cut into tickets, and for a card whose breakdown waits on the user's approval (a split card).
_Avoid_: backlog, draft

**Issues** (column):
The column for every unclaimed card — a plain issue and a spec issue with its open ticket sub-issues alike — and for a card that waits for Solve all.
_Avoid_: ready (as a column name)

**Unclaimed card**:
A card for an open issue that no session claims yet. A plain issue (no open sub-issues, not itself a sub-issue) and a spec issue with open ticket sub-issues both sit in Issues. A plain card's move to Doing is Solve; its move to To do is Split; its detail's **Grill** action starts the pipeline on it. A spec card's move to Doing starts Solve all; a move to To do grills on that spec issue to rework it. A click on the card toggles its open ticket sub-issues as a row of cards under it, which collapses on the next click; each sub-card has a Solve.

**Solve**:
To work a plain issue through a session that skips grill, spec and tickets: the issue becomes the card's only ticket, and the PR's merge closes the issue.
_Avoid_: solve all (that is for a spec card's tickets), fix (a fix is one possible outcome; solving covers the whole flow)

**Issue queue**:
The Issues column header's **Solve all issues** action. One click snapshots every card the Issues column holds at that moment, sorted by issue number, and stores that snapshot; the workbench starts the lowest-numbered card with its own move to Doing (**Solve**, **Solve all tickets**, or **Solve all**), and starts the next card when the card it waits on reaches **Review** with its PR open. Issues that appear after the click are not queued, a queued card that left Issues by hand before its turn is skipped, and a repo has one queue at a time. The queue ends when its last card reaches Review.
_Avoid_: solve all issues batch, bulk solve, auto pipeline, worker

**Split**:
Breaking a plain issue into ticket sub-issues with `to-tickets`, so it becomes a spec issue that waits for Solve all.
_Avoid_: rework

**Grill**:
A plain issue card's action that starts the pipeline on it with grill-with-docs. The grill works from the issue's title and body, the session keeps the issue as its **Origin issue**, and the card goes through spec, tickets and Solve all; the PR's merge closes the issue.
_Avoid_: Solve (Solve skips grill, spec and tickets), Split (Split only cuts the issue into tickets)

**Doing**:
The column for a feature whose tickets are being implemented.

**QA** (column):
The column for a feature whose finished branch is under code review.
_Avoid_: QA as the `qa` skill (the workbench does not run it), test run

**Review** (column):
The column for a feature whose PR is open and waits for the user's Approve.
_Avoid_: code review (that happens in QA), Reviewer (that is the permission reviewer)

**Done**:
The column for a feature whose PR is merged, or whose spec issue was closed by hand on GitHub. The issues a merged card closed — its ticket sub-issues, its spec issue, its origin issue — are recorded with the card that closed them, and a ticket issue with the spec it belongs to as parent. They sit in the merged card's row, not as cards beside it. When the card's session is no longer listed, its spec issue is a card of its own in Done, and its sub-issues sit nested in its row. A done card's row shows its tickets; a ticket not done there is marked Not planned. A hand-closed spec's card keeps its branch and any open PR (a note on the card names them), and a hand-closed unstarted spec becomes a card of its own with its sub-issues in its row. Records from before this change stay flat cards.

**Approve**:
The user's go-ahead on a card in Review: it merges the PR with a merge commit and deletes the branch.
_Avoid_: Allow (that answers a permission), accept

**Abandon**:
Dropping a feature: it stops the card's runs, closes its PR unmerged, deletes its branch, and takes the card off the board; its GitHub issues stay open. A card already in Done keeps its merged PR and its merge commit. A direct card is abandoned the same way.
_Avoid_: stop (a stop pauses the card; the card can resume), delete, cancel

**Not planned**:
The mark on a ticket or sub-issue of a done card that will not be worked: the board closes the open sub-issues of a hand-closed spec as not planned, and a done card marks its not-done tickets as not planned. GitHub carries the close as the state reason `NOT_PLANNED`.
_Avoid_: skipped, dropped, deferred

**Reconcile**:
The GitHub checks a board load runs for a repo: a PR merged on GitHub delivers the card as Approve delivers it, and a spec issue closed by hand on GitHub moves its card to Done — the card's runs stop and its worktree is removed, but its branch and any open PR stay on GitHub (a note on the card names them), and the spec's open sub-issues and the card's not-done ticket issues close as **Not planned**. A hand-closed spec the board watched as an unclaimed card becomes a card of its own in Done with its sub-issues in its row. The checks skip a card the PR-merged rule delivered in the same pass, a card in `pr` whose PR is merged, a card in flight with Approve or a merge run, a card whose PR state cannot be read, and a plain card; a board load that cannot read the open-issue list skips them. At most one runs at a time per repo; an overlapping board load waits for the run in progress, and a moved card sends a board event to every open board.
_Avoid_: sync, poll, catch up

## Relationships

- Under **Auto-approve**, every **Permission** goes to the **Risk judge** first; a safe rating allows it, any other rating goes to the **Reviewer** with the rating attached
- Only the **Reviewer** produces an **Escalation**; the **Risk judge** never sends a **Permission** to the user
- **Decisions** are never auto-approved
- The **Reviewer's** settings drive the **Reviewer** as well as **Rescue runs** and **Retro runs**; an empty Reviewer model turns all three off
- A **Card** from a pipeline session moves through the columns as its phase changes; the user's drag outranks the pipeline
- A **Card** from a direct session sits in **Doing**, and follows its PR: recording the PR puts it in **Review**, and **Approve** or a merged PR puts it in **Done**. Only **Review** to **Done** is a command for it: a backward drag is refused, because it has no tickets to pause and no spec to rework
- Dragging a **Card** from **Issues** to **Doing** starts **Solve** (a plain issue) or **Solve all** (a spec issue or a ready session); dragging it from **Review** to **Done** is **Approve**; any other forward drag is refused
- The **Issue queue** takes the **Cards** the **Issues** column holds at the click, lowest issue number first, and starts each one with its own move to **Doing**: the next card starts when the card the queue waits on reaches **Review**
- A **Solve one ticket** run on a spec card pauses the card in **Issues** when its ticket is done; **Solve all**, a backward drag, and Stop clear the pause, and **Solve all** runs every remaining ticket
- Dragging a plain **Card** in **Issues** to **To do** is **Split**: the issue is cut into ticket sub-issues before any work starts
- Dragging a **Card** back to **Issues** stops its run; dragging it to **Doing** again resumes the same session, and finished tickets stay finished
- Dragging a **Card** back to **To do** stops its run and opens the grill again, so the spec and tickets can change
- A merge conflict at **Approve** gets resolved on the branch, and the **Card** stays in **Review** for a second **Approve**
