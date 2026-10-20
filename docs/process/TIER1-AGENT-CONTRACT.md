# Tier 1 agent contract

This contract applies to any agent that can change the public tree. It is a
short public version of the floor's operating rules.

## You must

- Read the [agent process](AGENTS.md) and [workflow](WORKFLOW.md) first.
- Reproduce or directly observe the behavior you are changing.
- Search for the existing owner before creating a new module, constant, or
  document.
- Keep changes inside your assigned scope and serialize writers.
- Run focused checks after the final edit, and report what you ran.
- Preserve the public boundary: no secrets, private trackers, raw corpus, or
  personal data.
- Keep the developer preview warning explicit. Never claim production
  readiness.

## You must not

- Replace a root-cause fix with a retry, special case, or silent default.
- Weaken a guard to make a red test green without naming the removed coverage.
- Commit generated state, credentials, logs, or build output.
- Treat a subset run as evidence for the full suite.
- Touch unrelated work or rewrite history.

## Stop and ask

Ask one focused question when the required behavior, a destructive action, a
compatibility promise, or an acceptance condition is ambiguous. Do not guess
at a public release boundary.
