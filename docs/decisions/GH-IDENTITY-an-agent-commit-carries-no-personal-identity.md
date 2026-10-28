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
- **Every identity trailer is judged by its key.** A trailer whose key ends
  in `-by`, in any case, names a person. One that carries an address is
  exactly `Name <address>`, or it is refused by name, never dropped. On an
  agent commit, any `-by` trailer that is not the agent identity is refused,
  a name-only one (`Co-authored-by: A Name`) included; a human's commit keeps
  its own co-authors.
- **The whole message is judged.** On an agent commit the subject, the body,
  every trailer and every comment line git records name no address but the
  agent's; only the `git commit -v` diff, which git always cuts, is not.
- **One normalisation, at both doors.** Every judged text, the idents
  included, is NFKC-normalised, its default-ignorable code points removed and
  its ideographic full stops read as `.`; an address is recognised by the one
  bounded address grammar (`engine/src/privacy/identity-grammars.ts`), with
  Unicode labels. So a homoglyph or a hidden character hides nothing, and a
  human whose name has a ZWNJ, an NFD accent or fullwidth letters passes the
  DCO at the hook and in CI alike.
- **No name is an exemption.** A committer name is anyone's to set, so no
  commit passes because of who it says committed it. The only unjudged
  commits are the merge queue's own first-parent merges in a merge group,
  which live on a ref only GitHub writes.
- **Where it is judged.** One judge (`engine/scripts/verification/sign-off.ts`)
  at the `commit-msg` hook and in the `Commit records` check
  (`.github/workflows/commit-records.yml`). A refusal names the role and the
  trailer key, and an address only as a token keyed by the run's random,
  never-printed key: two addresses are told apart within one log, and nothing
  of a person — name, mailbox or domain — is printed, because the log is
  public.
- **The merge queue.** In a merge group the judge verifies the group's ref is
  in GitHub's `refs/heads/gh-readonly-queue/` namespace and held at the
  group's head; that namespace and the event's ref name are what is trusted,
  and only the queue's first-parent merges then go unjudged.

**What is not yet guaranteed, at landing.** `Commit records` is not a
required check yet: GH-1 declares it in the trunk ruleset (#537), and it
counts only once that is applied. A `pull_request` run uses the branch's copy
of the workflow, so a branch can change what runs under the check's name,
and a ruleset requiring a workflow from main is Enterprise-only (the plan is
Team). The lasting boundary is the door App (#67, route P3.2): main's code
run out-of-band, posting the check, with the ruleset accepting it only from
that App.
