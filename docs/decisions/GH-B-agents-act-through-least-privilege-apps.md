---
id: GH-B
date: 2026-10-21
by: user
group: github
status: in-force
implementation: pending
route: P3.9
---
# Agents act only through least-privilege GitHub Apps

A personal owner token left on a development machine can do anything to the
whole organization, and every agent that can read it can too. So once GitHub
is set up, that token leaves the machine, and agents act only through GitHub
Apps that each hold just the permissions their role needs.

The user's decision B of 2026-10-21 (GITHUB DECISIONS):

- The owner credential leaves the development host after setup.
- Agents act only through least-privilege GitHub Apps (one per role: the
  door, the verifier, the publisher;
  [GITHUB-200](GITHUB-200-exploit-github-fully.md)).
- Two-factor authentication is required for the organization.

## What is live (checked 2026-10-22, not asserted)

- **Decided, not implemented.** Two-factor authentication is **not yet
  required** for the organization: `gh api orgs/LLM-4-People --jq
  .two_factor_requirement_enabled` answers `false`. Turning it on is the
  user's own step in the first setup session.
- **The one App installed today is broad.** `gh api orgs/LLM-4-People/installations`
  lists a single installation, the App `claude`, on **all** repositories
  (`repository_selection: all`), with write access to contents, workflows,
  actions, repository hooks, pull requests, issues, checks and discussions
  (read on members, metadata and statuses). That is the opposite of least
  privilege, and it is the pending state this decision closes: the user's
  first setup session restricts it (setup runbook step P1.9), and the second
  session removes it once the per-role Apps carry its work.
- The per-role Apps (door, verifier, publisher) and their manifests do not
  exist yet (P1.2), and the owner credential is still on the development host;
  its removal is the setup's last user step (P3.9).
