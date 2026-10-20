# Flaky burn-down lists

The engine and web suites read one shrink-only burn-down list each. The lists
are a record of the private ledger that produced them, not a second test
result.

The public snapshot does not publish the private web run history. `web.json`
therefore carries only the suspects the public web ledger itself recorded; the
private web lanes remain ordinary work on the task board and do not claim that
a private failure still exists. The engine list keeps the private ledger's
owned entries: the sanitized import carried the entries without their owner
rows, so the public rows were added by the commit that re-owned them
(`entryAddedWithOwner`). A fresh public checkout starts with an empty ledger,
and an absent history can delay a red, never manufacture one.

The list format and the owner rule are owned by
`engine/src/workflow/flaky-burn-down.ts` and
`engine/src/workflow/failure-owners.ts`. Do not hand-add an entry without the
task row that owns it in `docs/trackers/TASKS.md`.
