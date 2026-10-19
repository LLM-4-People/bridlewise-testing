# FOUNDATION-005 — Configuration contract had multiple handwritten authorities

- Status: **open blocking**
- Owner: `configuration-architecture`
- Affected surfaces: builder preflight, finished runtime, CLI/web configuration,
  extensions, generated schemas, receipts and governed-project enforcement
- Detected: 2026-07-12

## Finding

The required configuration shape grew to include state and alignment-checkpoint
fields while the document still declared schema version 1. Independently, a
candidate could widen a Zod maximum to `Number.MAX_SAFE_INTEGER`; the host
verifier observed only a changed repository hash and the widened candidate
accepted a value above the root ceiling.

The root cause is not the missing hash check. Shape, version, ceilings, runtime
validator, generated artifact, verifier expectations, fixtures and downstream
consumer contracts were separate handwritten truths. Updating several of them
carefully is still duplicate authority and can drift again.

## Temporary diagnostic containment

During foundation testing only, the candidate contract source, generated JSON
Schema and identity may be pinned so mutations fail visibly. Those pins are
diagnostic scaffolding, not the permanent repair and not evidence that this
finding is removed. They must not become a permanent manual cascade.

## Required permanent repair

1. Define one versioned declarative `ConfigContractSpec` as the sole authority
   for field shape, literals, enums, constraints, defaults/requiredness,
   sensitivity, documentation metadata and root ceilings.
2. Generate the runtime validator and inferred TypeScript type, JSON Schema,
   schema/identity hashes, central config template, CLI/web form contract,
   extension-facing schema, documentation tables, preflight receipt binding and
   all valid/invalid fixtures from that one spec. Handwritten parallel field
   lists or limits are forbidden.
3. Make schema identity a first-class transition: any semantic spec change with
   the same version fails; a version change without an admitted migration and
   compatibility decision also fails. Historical versions remain explicitly
   parseable or explicitly unsupported by version, never silently
   reinterpreted.
4. Run the same generated validator/identity path in builder preflight and the
   finished harness. Candidate verification cannot validate candidate JSON with
   the host's schema while ignoring changed candidate semantics.
5. Register one owner and compiler in the architecture manifest. Generated
   projections carry source-spec hash, compiler revision and exact rebuild
   command; no generated projection becomes authority.

## Removal verification

- Mutate every spec field and constraint and prove every generated consumer
  changes or rejects the stale projection.
- Widen/narrow ceilings, add/remove/reorder/rename fields, change requiredness,
  literals, enum members, sensitivity and defaults, with and without version
  changes; stale and coordinated-manual projections must fail.
- Differentially validate the same normal and hostile documents through
  preflight, CLI, future web, extension and direct contract paths.
- Rebuild twice byte-identically, then run at least three repeated and three
  materially distinct project scenarios plus an independent implementation
  oracle.
- Repository-wide architecture and literal searches must find one declarative
  authority and generated/read-only projections only.

This finding blocks any final or release claim for configuration. It cannot be
closed by source hashes, comments, a widened test fixture, or an assurance that
the current manual values happen to agree.
