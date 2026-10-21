---
id: RULES-ENFORCED
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: standing
---
# Rules are mechanically enforced whenever possible

A rule that only lives in a document is forgotten the first time someone is
in a hurry. So every rule, decision and principle names the mechanism that
enforces it, and a rule without one is treated as a gap to close.

The user's rule of 2026-10-10 ("rules are mechanically enforced whenever
possible"), which generalizes [UR-18](UR-18-every-issue-class-gets-a-mechanical-guard.md)
from issue classes to every rule:

- Every rule, decision and principle (the UR-* rules, the D-* decisions, the
  [universal principles](QUALITY-PRINCIPLES-the-universal-quality-principles.md))
  maps to its enforcing mechanism: a guard, a check, a hook, a schema, a type
  or a kernel boundary.
- A rule with no mechanism is a gap to close, unless it is recorded as truly
  unmechanizable, with the review that covers it instead.
- A writer adding a rule adds its guard in the same change.

How it is enforced: the decision records themselves are checked
(`tests/prevention/decisions-format.test.ts`), and many rules have their own
guards, but the map from each rule to its enforcer is not yet part of the
records: no field names a rule's enforcer, and nothing refuses a rule that has
none. That is the missing mechanism.
