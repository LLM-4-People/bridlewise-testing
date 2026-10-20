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
