# pi workbench

Self-hosted web UI that drives the pi coding agent on your repos. This glossary covers the issue-solving flow (reading GitHub issues and turning them into pull requests) the machines the agent can reach, and how the agent's permissions get answered.

## Language

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
The Issues page button on an issue that owns ticket sub-issues: one pipeline session reads every open ticket sub-issue with its blocking edges from GitHub, skips grill/spec/tickets, implements the tickets one fresh run at a time in dependency order, and opens a PR whose merge closes the spec issue and every ticket issue.
_Avoid_: solve all issues (that is the Start session flow, one session per issue)

**Solve**:
To work an issue through a session (grill → spec → tickets → implement → review) and open a PR whose merge closes the issue.
_Avoid_: fix (a fix is one possible outcome; solving covers the whole flow)

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

## Relationships

- Under **Auto-approve**, every **Permission** goes to the **Risk judge** first; a safe rating allows it, any other rating goes to the **Reviewer** with the rating attached
- Only the **Reviewer** produces an **Escalation**; the **Risk judge** never sends a **Permission** to the user
- **Decisions** are never auto-approved
- The **Reviewer's** settings drive the **Reviewer** as well as **Rescue runs** and **Retro runs**; an empty Reviewer model turns all three off
