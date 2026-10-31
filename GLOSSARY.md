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
The model that rates a permission as safe, risky, or dangerous: Jev, or a local model on the agent's own endpoint.
_Avoid_: decision model, classifier

**Reviewer**:
The frontier model (Claude or OpenAI) that allows, denies, or escalates a permission the risk judge did not rate safe.
_Avoid_: frontier model (as a role name), approver

**Escalation**:
The reviewer handing a permission back to the user because it could break something beyond the task.
_Avoid_: fallback (a failed judge or reviewer also lands with the user, but no model chose it)

## Relationships

- Under **Auto-approve**, every **Permission** goes to the **Risk judge** first; a safe rating allows it, any other rating goes to the **Reviewer** with the rating attached
- Only the **Reviewer** produces an **Escalation**; the **Risk judge** never sends a **Permission** to the user
- **Decisions** are never auto-approved
