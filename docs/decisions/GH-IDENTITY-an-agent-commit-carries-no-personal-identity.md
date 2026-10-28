---
id: GH-IDENTITY
date: 2026-10-28
by: coordinator
group: github
status: in-force
implementation: partial
route: P3.2
acted_in: [engine/src/kernel/root-policy.ts, engine/scripts/verification/sign-off.ts, engine/src/workflow/workspace-manager.ts, engine/scripts/tooling/candidate-checkout.ts, .github/workflows/commit-records.yml]
---
# An agent commit carries no personal identity

GitHub publishes every name and address a commit carries: its author, its
committer and every identity trailer (`Signed-off-by`, `Co-authored-by`,
`Reviewed-by` and the like, whatever the spelling of the key). A commit an
agent makes is the project's work, so each of those is the project's
declared agent identity, `ROOT_POLICY.workflow.commitIdentity.agent` (the one
source; nothing else spells it), and never a person's own name or address.

- **Which commits are an agent's.** A commit is an agent's when any identity
  on it is the agent identity or uses its address's domain; when it is made
  in a checkout the harness made for an agent (a workspace, a candidate),
  which carries the `agentCheckoutKey` git config beside the agent identity;
  or when the pull request bringing it was opened by a declared agent account
  (`agentAccounts`). A human outside contributor's commit carries none of
  those marks and keeps the ordinary DCO: their own sign-off as committer.
- **The writers set it, from the one source.** `ws create` writes the agent
  identity and the marker into the workspace worktree's own config
  (`config --worktree`, never the shared config), the candidate tool into the
  candidate's, and the workspace integrator commits under it. No harness
  writer takes `user.name`/`user.email` from the host.
- **Every identity trailer is readable.** Each is exactly `Name <address>`;
  one the judge cannot read is refused by name, never dropped.
- **No name is an exemption.** A committer name is anyone's to set, so no
  commit passes because of who it says committed it. The only unjudged
  commits are the merge queue's own first-parent merges in a merge group,
  which live on a ref only GitHub writes.
- **Where it is judged.** One judge (`engine/scripts/verification/sign-off.ts`)
  at the `commit-msg` hook and in the `Commit records` check
  (`.github/workflows/commit-records.yml`), a required status check in the
  trunk ruleset (#537).

**What is not yet guaranteed.** A `pull_request` run uses the branch's copy of
the workflow, so a branch can change what runs under the check's name, and a
ruleset requiring a workflow from main is Enterprise-only (the plan is Team).
The lasting boundary is the door App (#67, route P3.2): main's code run
out-of-band, posting the check, with the ruleset accepting it only from that
App. Until then this record says so, and so do the workflow and the pull
request.
