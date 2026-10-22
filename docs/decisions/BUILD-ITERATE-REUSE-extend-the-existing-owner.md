---
id: BUILD-ITERATE-REUSE
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: standing
---
# Build, iterate, reuse and improve

Two pieces of code that do almost the same thing drift apart, and every fix
then has to be made twice. So before writing anything new, a writer finds the
code that already owns the concern and extends or improves it.

The user, 2026-10-10: "we must build, iterate, reuse and improve things, avoid
duplicate or similar logics".

- Before writing anything new, search for the existing owner and EXTEND or
  IMPROVE it.
- NEAR-duplicates (similar logic, renamed copies, parallel implementations of
  the same idea) are violations, not only identical code.
- Every writer's report names the existing owners it reused or extended; every
  reviewer checks for similar logic.
- Retroactive ([UR-19](UR-19-every-rule-is-retroactive.md)). It sharpens
  [UR-01](UR-01-dry-kiss-yagni-one-owner.md) and
  [UR-16](UR-16-one-thing-for-everything.md).

How it is enforced: `tests/prevention/no-duplicate-code.test.ts` refuses
exact duplicate function bodies in the web, server and scripts trees, and
`engine/test/prevention/no-duplicate-function-bodies.test.ts` adds a
normalized-similarity pass over the engine's source. Structural
near-duplicates (renamed copies, parallel implementations) are not caught
mechanically yet; review covers them.
