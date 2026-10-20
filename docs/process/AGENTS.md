# Agent process

This is the public agent process for the Bridlewise development floor. It is a
short public surface, not the private coordination record. The product is an
experimental developer preview and is not production ready.

## Start

1. Read the repository [agent briefing](../../AGENTS.md) and the
   [workflow](WORKFLOW.md).
2. Identify the owner of the fact or behavior you are changing. Prefer the
   existing module, guard, or document over a parallel one.
3. Reproduce the failure or observe the current behavior before editing. If
   you cannot reproduce it, say so.
4. Work in a focused scope. Keep one writer per file set and do not rewrite
   unrelated work.

## Evidence

- Focused checks must pass after the final edit. A subset run is not evidence
  for a full-suite claim.
- A reproduced bug needs a regression test that fails before the fix and
  passes after it when a test is feasible.
- Record the command, the environment, and the observed result. Do not turn an
  unknown into a pass.
- Public evidence must not contain credentials, private trackers, the raw
  corpus, or personal data.

## Review

Read the complete diff. Check that every consumer was updated, that no dead
code or duplicate owner remains, and that the change matches the roadmap's
exit criteria. Keep the developer preview warning explicit in public prose.

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
