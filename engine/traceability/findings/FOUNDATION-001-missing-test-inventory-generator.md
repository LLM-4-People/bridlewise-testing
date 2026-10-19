# FOUNDATION-001 — Test inventory authority had no deterministic generator

- Status: **verified removed**
- Owner: `verification-foundation`
- Affected surfaces: builder verification, candidate receipts, artifact admission
- Detected: 2026-07-12
- Closure scope: the missing deterministic generator only; not crash-durable or
  power-loss-atomic two-file publication

## Finding

`traceability/s1-test-inventory.json` and `ROOT_POLICY.verification.testInventoryHash`
were enforced by the loader and S1 checks, but the repository exposed no governed
deterministic generator for rebuilding the inventory after a test-file change.
Earlier updates therefore required a one-off mechanical reconstruction. That is
not a reproducible single source of truth and can produce stale hashes, omitted
tests, or an unverifiable hand-edited cascade.

## Root cause and impact

The initial slice implemented validation and execution before it implemented the
authoritative build path. The missing reverse operation was not covered by a
round-trip or clean-rebuild test. A test change could consequently block all
receipts or tempt an unsafe manual hash update even when the tests themselves
were correct.

## Required permanent repair

1. Add one governed deterministic generator to `scripts/test-inventory.ts` that
   derives every test entry from the complete test-file surface, rejects dynamic
   or duplicate identities it cannot prove, and emits canonical JSON.
2. Make the generator produce the inventory hash used by the central root policy;
   do not maintain a second generation algorithm or manually edit entry hashes.
3. Add control, ordinary-failure, and hostile mutation tests covering repeatable
   rebuild, missing/renamed/duplicate/dynamic tests, stale source hashes, and a
   clean second generation that is byte-identical.
4. Regenerate the artifact manifest only after the inventory and root-policy
   cascade is stable.

## Closure evidence

- `scripts/test-inventory.ts` SHA-256:
  `6c4242cc27e6e245eb5d1ab5b4c9dd26f8e4f646ce970f18d0e3ee22ceea88f4`;
  its seven-export public surface is architecture bound.
- Three independent `inventory:check` executions returned the identical inventory
  hash `5a13b18193005168d04fad07517d64ad431b50accfd9c7f6a30d713cd0e11e82`,
  source-set hash
  `3c82c5b01308bc1492ccd351bc1da84e1d46d95a0a0bc952b7559135191378e0`,
  109 tests, `status=current`, and no transaction journal. These hashes describe
  the exact flat v1 closure subject; they are historical evidence, not claims
  about the later recursive v2 candidate.
- Three independent `S1-B08-HOSTILE-REAL` executions passed. They cover static
  discovery without executing hostile modules, uncovered/dynamic registration
  rejection, duplicate-name rejection, stale/ambiguous root-policy base denial,
  single-transaction exclusion, injected process-exception interruption after
  one renamed file, verified logical rollback, cleanup, and successful
  regeneration under that modeled exception boundary.
- The generated inventory file SHA-256 is
  `bf61a9bf496890c3d2f4c11b1b99345c1500258acd9f460fc489c7be33ec8696`;
  `ROOT_POLICY.verification.testInventoryHash` holds its canonical inventory hash.
- A repository-wide writer search found one production generator/writer only:
  `scripts/test-inventory.ts`; other direct writes occur solely in isolated test
  fixtures. No second generator or manual production hash path remains.

The final artifact-manifest regeneration remains a separate active admission
step because context and extension evidence writers had not closed when this
foundation repair was independently checked. That downstream pending work does
not reopen the missing-generator defect.

Removal was based on generator/recovery behavior and independent replay, not merely
on the current inventory loading.

## Explicit durability boundary

The two-file journal has not passed file/directory `fsync`, `SIGKILL`, machine
crash, filesystem error or power-loss ordering tests. It therefore makes no
crash-durable, all-or-nothing or storage-atomic claim. A process can die between
renames and leave recovery work for a later invocation. The recursive v2
inventory is also intentionally drifted until the current writer set and all
prerequisite repairs close.

Before migration or release evidence may call this publication durable or
atomic, inventory/root-policy publication must route through the qualified
immutable receipt/write authority, bind the exact pre/post identities, exercise
kill/fault boundaries and independently prove recovery or explicit ambiguous
state. That remaining obligation does not reopen the narrowly removed
“generator absent” defect, but it blocks any broader durability claim.
