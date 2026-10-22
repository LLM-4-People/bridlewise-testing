---
id: QUALITY-PRINCIPLES
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: standing
---
# The universal quality principles

One short list of qualities every part of Bridlewise is judged by, so a
newcomer knows what "good" means here before reading any other rule: every
writer checks their work against the whole list, and every reviewer checks it
again. The list applies to the whole codebase, past, current and future.

The user's rule of 2026-10-10 ("everything, the whole codebase, past, current
and future"):

- a single source of truth;
- the lowest choke point;
- ultra modular (plugins and declarative extension points);
- expose ALL signals, configurations and functions/logic through the one
  registry and manifest ([UR-05](UR-05-expose-settings-signals-actions.md));
- very fast; lightweight;
- secure (core cannot be bypassed,
  [UD-CORE-NO-BYPASS](UD-CORE-NO-BYPASS-a-module-cannot-bypass-core.md));
- easy to use and smart;
- resilient.

They are retroactive ([UR-19](UR-19-every-rule-is-retroactive.md)): existing
code that violates one is a finding to fix, never grandfathered. Three further
rules were stated with the list:
[MIN-DEPS](MIN-DEPS-minimal-external-dependencies.md),
[BUILD-ITERATE-REUSE](BUILD-ITERATE-REUSE-extend-the-existing-owner.md) and
[RULES-ENFORCED](RULES-ENFORCED-rules-are-mechanically-enforced.md).

How it is enforced: through the guards of the individual rules each principle
maps to. The list as a whole has no single mechanical check; review against
it is part of every verification ([UR-09](UR-09-independent-verification-before-commit.md)).
