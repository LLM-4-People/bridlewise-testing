---
id: DEPS-ADOPT
date: 2026-10-29
by: coordinator
group: github
status: in-force
implementation: partial
route: GH-2
acted_in: [engine/src/workflow/deps-adopt.ts, engine/src/workflow/deps-cli.ts, engine/src/workflow/forge/repository-reads.ts, engine/bridlewise.config.json]
---
# Dependabot is a signal, never a committer

A Dependabot commit has the Dependabot app as its author, GitHub as its
committer and no sign-off. It can never pass Commit records, and landing one
would break the identity and sign-off rule in force (GH-IDENTITY).

- **One command adopts a bump.** `harness deps adopt <pr>` re-applies it as
  the agent.
- **The bump is derived from the pull request's files, never its title.**
  - npm: each `package.json` dependency-spec change.
  - GitHub Actions: each `uses:` pin that moves to another commit of the same
    action.
  - Any other changed file or line is refused (`deps_bump_unrecognized`).
  - So is a pull request that is not Dependabot's, or is closed.
- **It is applied to the trunk as it is now.** A spec or pin the trunk moved
  since Dependabot read it is refused (`deps_bump_drifted`).
- **The lockfile is never copied.** The declared lockfile command (the real
  resolver) writes it, then the declared install command runs.
- **Action pins have one owner.** An Actions bump moves the pin in the
  external-surface registry, and the workflows that use the action are
  rewritten from it.
- **The agent commits and publishes.** `harness sync` regenerates every pin and
  inventory. The change is committed as the agent identity with sign-off
  through the hooks, and published as the agent's pull request.
- **Dependabot's pull request is closed only after the agent's is open,** with
  a note linking it. A failed publish leaves it open.

**What is not yet guaranteed.** The command has been tested against fakes of
GitHub and the workspace. Its first real adoptions are the queued bumps (#620,
#551, and #618 with #619).
