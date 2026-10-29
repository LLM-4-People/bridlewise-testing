---
id: DEPS-ADOPT
date: 2026-10-29
by: coordinator
group: github
status: in-force
implementation: partial
route: GH-2
acted_in: [engine/src/workflow/deps-adopt.ts, engine/src/workflow/deps-cli.ts, engine/src/workflow/forge/repository-reads.ts, engine/src/workflow/checkout-setup.ts, engine/src/kernel/root-policy.ts, engine/bridlewise.config.json]
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
  - A spec moves only between plain registry semver versions of the same
    package, exact or under the same `^`/`~` operator. An alias (`npm:`), a
    git or GitHub ref, a file, a link, a URL tarball, a workspace, a dist-tag
    or a wider range is refused by its form (`deps_spec_unsupported`).
- **Dependabot is known by its account, never its login.** The author must be
  a Bot whose numeric user id is the one the root policy declares
  (`workflow.dependabot`); anything else is refused (`deps_not_dependabot`),
  whatever its login says. So is a closed pull request.
- **It forks from the trunk itself.** A checkout holding commits its upstream
  trunk lacks is refused before anything exists (`deps_checkout_not_on_trunk`):
  the workspace forks from the invoking checkout, and those commits would ride
  along unleased.
- **It is applied to the trunk as it is now.** A spec or pin the trunk moved
  since Dependabot read it is refused (`deps_bump_drifted`).
- **The lockfile is never copied, and nothing is installed on the host.** The
  declared lockfile command (the real resolver) writes it, resolution only:
  `--package-lock-only --ignore-scripts`, judged before the workspace exists
  (`deps_resolution_executes`), so resolution never executes package code. An
  install, which runs the new package's lifecycle scripts, happens only in
  the sandboxed runs that judge the agent's pull request.
- **A bump built into the bundle regenerates it only inside the sandbox.**
  An `/engine` bump changes `dist/bundle.js`, and regenerating it needs the
  real install (esbuild's install script included). The coordinator chose
  option (a): that install and the bundle regeneration run inside the
  guardian sandbox (no credentials, the checkout's write door only), never on
  the host, and never in a CI job holding the App token (GH-5's #747). The
  step is refusal-checked: where the sandbox cannot run it, the adoption
  refuses (`deps_sandbox_unavailable`) before anything exists. **Today it
  always refuses:** the guardian has no confined-install mode yet (a
  confined checkout is writable and never executable, and its network can
  only be refused, not scoped to the registry).
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
