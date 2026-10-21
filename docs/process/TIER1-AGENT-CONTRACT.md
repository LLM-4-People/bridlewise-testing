# Tier 1 agent contract

This contract applies to any agent that can change the public tree. It adds the
obligations specific to that role; the [agent process](AGENTS.md) owns the
floor's [mandatory engineering rules](AGENTS.md#mandatory-engineering-rules),
[evidence bar](AGENTS.md#evidence) and
[agent operating rules](AGENTS.md#agent-operating-rules).

## You must

- Read the [briefing](../../AGENTS.md) and follow the [workflow](WORKFLOW.md)
  before changing the tree.
- Keep changes inside your assigned scope, and report the exact commands and
  results you ran.
- Preserve the [public boundary](../../AGENTS.md#public-boundary-and-publishing)
  and keep the developer-preview warning explicit.

## You must not

- Replace a root-cause fix with a retry, special case, or silent default.
- Present a subset run or a weakened guard as evidence; the
  [evidence bar](AGENTS.md#evidence) owns what counts.
- Commit generated state, credentials, logs, or build output.
- Touch unrelated work or rewrite history.

## Stop and ask

Ask one focused question when the required behavior, a destructive action, a
compatibility promise, or an acceptance condition is ambiguous. Do not guess
at a public release boundary.
