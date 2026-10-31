# pi workbench

Self-hosted web UI that drives the pi coding agent on your repos. This glossary covers the issue-solving flow: reading GitHub issues and turning them into pull requests.

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
