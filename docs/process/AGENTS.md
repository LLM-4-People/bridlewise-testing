# Agent process

This is the public agent process for the Bridlewise development floor. It is a
short public surface, not the private coordination record. The product is an
experimental developer preview and is not production ready.

## Start

Read the [repository briefing](../../AGENTS.md). Every change follows the
[workflow](WORKFLOW.md); the rules on this page bind it.

## Evidence

- Focused checks for the area you changed must pass after the final edit. A
  subset run is not evidence for a full-suite claim.
- A reproduced bug needs a regression test that fails before the fix and
  passes after it when a test is feasible.
- A guard must fail for the defect it names. A planted or mutation arm proves
  the guard is not vacuous.
- A test must not depend on a private fixture that the public snapshot does
  not publish. Name the exclusion instead of silently skipping it; a visible
  block is better than a quiet omission.
- A shard report is evidence only when it names its commit and the manifest it
  ran. Missing, duplicate, failed, or unexpected files refuse the merge.
- Record the command, the environment, and the observed result. Do not turn an
  unknown into a pass, and do not claim a speedup, a green suite, or a release
  unless the receipt on disk supports it.
- A "pre-existing" claim is checked against history before it is used.
- Generated values come from their generators; never hand-edit a hash, pin, or
  manifest.
- Do not skip or weaken a test to make a red run green; if coverage is
  removed, name it.
- Commit only after the focused checks pass, with one cohesive change and the
  verification you actually ran.
- Public evidence follows the
  [public boundary](../../AGENTS.md#public-boundary-and-publishing).

## Agent operating rules

- **One worktree at a time.** Agents can share this checkout: two
  branch-creating agents at once move the tree under each other, and commits
  land on the wrong branch. Give each concurrent agent its own worktree
  (`git worktree add`) or run them one after another. Before switching
  branches, check `git status --porcelain` and never carry another agent's
  uncommitted work.
- **A check's exit status gates the push.** Never pipe a guard into
  `grep`/`tail` and chain `&& git commit && git push`: the pipeline's status is
  its last command's, so a failing guard reads as success. Run the check on its
  own line and capture `$?`, or use `set -o pipefail`.
- **Watch every push.** After a push, watch the CI run to completion
  (`gh run list`, `gh run view <id> --log-failed`) and fix any failure before
  starting the next task. A green local run is not a green pull request: the
  sharded gate, the docs guards and the secret scan can fail on a tree that
  passed locally.
- **Cancel a superseded run.** The workflow is grouped on the ref with
  `cancel-in-progress: true`, so a second push or a re-run cancels the run in
  flight: watch a run rather than trigger beside it. When you supersede a run
  on purpose, cancel the older one by hand (`gh run cancel <id>`): while the
  newer run is still `pending` it does not displace the in-progress one, and
  both sit in the same group looking stuck.
- **Keep the checkout config at mode 0600.** `engine/bridlewise.config.json`
  must be 0600; the [setup commands](../../CONTRIBUTING.md#setup) include the
  repair, and the runtime refuses an insecure mode with `config_mode_insecure`
  instead of starting.
- **Keep `TMPDIR` outside the floor.** Scratch work runs under a private temp
  root outside the safety floor; a temp root inside it is refused
  (`TMPDIR-KEEPOUT-001`,
  [D-19](../decisions/D-19-temp-root-outside-the-safety-floor.md)).

## Mandatory engineering rules

These bind every change in this repository and everything built from it. This
section is their single owner; the briefing and the agent rules point here
rather than restating them.

**Always.** Seek and follow DRY, KISS, YAGNI and the best coding practice.
Create, edit and reuse shared functions, logic, tests and configurables, and
build in blocks and modules. Refactor and clean up fully, then verify the parts
are unified and work together. Delegate to agents so context stays small — one
writer at a time, as many readers as you like in parallel. Research anything you
are not certain of. Acknowledge, analyse, evaluate and act on every finding,
reproducing it where possible: no assumptions, not even for low-impact
findings. Keep one single source of truth for everything, implemented at the
lowest chokepoint. Expose settings, signals, actions and customisation wherever
the thing is built. Seek gaps and improvements in the workflows and in the app.
Everything must be modular, resilient, reliable, agnostic, dynamic, efficient
and performant. Write broad, deterministic, mechanical, dynamic and intelligent
tests, and test improper and unexpected use as well as the expected path, so
every finding is caught by a test next time. Keep the global vision, goals,
expectations and results in view. Maintain real documentation and a record of
progress and problems. Log debug, error and warning through one centralised
logging system at the lowest chokepoint, and route everything through it. Reuse
and improve the things used to build as well as the things built. Prefer
background commands so work continues while they run.

**Never.** Monolithic files, functions or logic. Static configurables inside
the codebase. Band-aids or workarounds. Over-engineering unless it is required.
Similar or duplicate logic, constants, variables or functions. External
dependencies unless they are worth it. `pkill`/`kill`: use a script.

**Triple check.** Repeat until a round comes back clean: eight check agents
examine disjoint areas and report proven findings; one agent rechecks those
findings and drops the unproven; one writer fixes what is confirmed; one agent
rechecks the fixes. Then start again. Every finding carries its reproduction —
a claim without one is not a finding.

## Measurement contract

For every signal the app, its build tooling or a third party produces and the
floor judges, records or quotes: it is DYNAMIC (computed from the run's own
conditions, never a table of per-machine constants), RESILIENT (absent, never
zero, when a signal is unreadable — and never silently substituted by a
different quantity), LOAD-AGNOSTIC or explicitly declaring its load sensitivity
and deferring when that bound is exceeded, and SINGLE-OWNER: computed once at
the lowest chokepoint that can see the raw facts, exposed through the shared
signals, settings and judgement layers, and read by every consumer from there.
A second derivation of the same number is a defect. Each clause needs a broad
mechanical guard, not a convention: a rule that only lives in prose is not a
rule. The contract's jurisdiction is the whole app: a build step's timing, a CI
runner's duration, a registry's response and a third-party version are signals
like any other, and anything the floor depends on from outside it must be
pinned or measured rather than assumed. A signal that was not measured is
absent, never zero; a vacuous population refuses rather than skipping.

## Review

[Roles](ROLES.md#reviewer) owns what a review checks; [Evidence](#evidence)
owns the bar it applies. The
[public boundary](../../AGENTS.md#public-boundary-and-publishing) owns what may
be published.
