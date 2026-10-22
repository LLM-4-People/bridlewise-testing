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

## Workspaces

A writer works in a workspace (`npm run ws -- create …`), which lands on
GitHub only. GitHub is the one repository host. A workspace's target must be a branch
whose upstream is the GitHub trunk, `main` of the configured trunk
repository (`workspaceIsolation.landTargets`). A target that tracks another
host's branch is refused at create (`workspace_forge_remote_unknown`), and
so is the retired Gitea `testing`. The refusal names the GitHub trunk as the
remedy. A target that tracks another branch of the trunk repository is
refused too (`workspace_target_not_landable`). A workspace lands through its
pull request and the merge queue (`ws land`), or through the local
integrator (`ws merge`). The [merge guide](MERGE-GUIDE.md) owns the steps
and refusals of both (§1b and §1c).

## Roles and review

The [agent process](AGENTS.md#evidence) owns the evidence bar. [Roles](ROLES.md)
owns what a review checks and the coordinator, writer, and reviewer boundaries;
the [Tier 1 agent contract](TIER1-AGENT-CONTRACT.md) owns the agent obligations.
