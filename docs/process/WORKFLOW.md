# Workflow

The floor uses one short loop for every change. The loop is deliberately
smaller than the private coordination process, but the evidence rules are the
same.

## The loop

1. **Brief.** Read the [agent process](AGENTS.md), the task board, and the
   relevant test or design owner. State the acceptance condition.
2. **Reproduce.** Observe the failure or baseline. Capture the exact command
   and the relevant output.
3. **Design.** Find the canonical owner and the existing helper before adding
   code. If the change crosses a boundary, name the boundary and its contract.
4. **Implement.** Make the smallest correct change. Update every consumer and
   remove the old pattern rather than leaving two owners.
5. **Verify.** Run the focused checks after the final edit. For a public
   claim, use a fresh full run or a sharded run whose receipt names the same
   commit.
6. **Record.** Update the task board, the roadmap when the state changes, and
   any public evidence page. Commit one cohesive change.

## Review rules

- A guard must fail for the defect it names. A planted or mutation arm proves
  the guard is not vacuous.
- A test must not depend on a private fixture that the public snapshot does
  not publish. Name the exclusion instead of silently skipping it.
- A shard report is evidence only when it names its commit and the manifest it
  ran. Missing, duplicate, failed, or unexpected files refuse the merge.
- Do not claim a speedup, a green suite, or a release unless the receipt on
  disk supports it.

## Roles

See [roles](ROLES.md) and the [Tier 1 agent contract](TIER1-AGENT-CONTRACT.md)
for the coordinator, writer, and reviewer boundaries.
