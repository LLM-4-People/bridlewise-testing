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
5. **Verify.** Run the focused checks after the final edit; the
   [agent process](AGENTS.md#evidence) owns the evidence bar.
6. **Record.** Update the task board, the roadmap when the state changes, and
   any public evidence page, then commit.

## Roles and review

The [agent process](AGENTS.md#evidence) owns the evidence bar. [Roles](ROLES.md)
owns what a review checks and the coordinator, writer, and reviewer boundaries;
the [Tier 1 agent contract](TIER1-AGENT-CONTRACT.md) owns the agent obligations.
