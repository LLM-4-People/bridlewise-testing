---
id: MIN-DEPS
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: standing
---
# Minimal external dependencies

Every package Bridlewise depends on is code it does not control: a security,
licence, size and maintenance risk that ships to every user. So a dependency
is taken only when its benefit is large compared with building the thing
in-house.

The user, 2026-10-10: "rely as little as possible on external deps, unless it
has huge pros vs building ourself".

- Every new dependency carries a written justification: what it does, the cost
  of building it in-house, why its pros are huge (security-critical
  cryptography, a mature parser grammar, a browser engine, …), its size, its
  transitive count, its licence and its maintenance.
- Retroactive ([UR-19](UR-19-every-rule-is-retroactive.md)): the existing
  dependencies are audited the same way.

How it is enforced: `.github/workflows/dependency-review.yml` reviews the
dependency changes of a pull request, but nothing yet requires the written
justification, and the audit of the existing dependencies is not recorded in
this repository. No mechanical guard for the justification yet.
