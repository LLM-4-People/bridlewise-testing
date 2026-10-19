# Migration write-authority author qualification

This isolated tree contains candidate-neutral, author-only contracts and
qualification evidence. It does not implement or admit
`MigrationWriteAuthority`, select a backend or placement, or claim readiness.

The current single sources are:

- `qualification-contract.v2.json`, validated by the closed
  `schemas/qualification-contract.schema.json`;
- `schemas/authority-protocol.schema.json` and the generated projection
  `fixtures/authority-protocol-fixtures.v2.json`, whose source is
  `build-protocol-fixtures.mjs`;
- `repository-facts-contract.mjs`, shared by the disposable repository runner
  and the independent-shaped validator;
- `author-receipt.v2.json`, whose SHA-256 must be supplied from outside the
  validator invocation. The receipt pins the contract, schemas, fixtures,
  validators and test sources so they cannot be co-weakened without invalidating
  the external hash. It also binds the exact Node executable, root package and
  lock metadata, project integrity/error helpers, and every file in the
internally resolved Ajv runtime dependency closure. Trust-bound hashing reuses
the pinned shared qualification authority and project integrity helpers. Those
helpers currently use Node crypto internally; this benchmark does not own a
separate direct-crypto implementation.

Serialized protocol values are evidence only. They never contain or reconstruct
the process-private live grant required by an implementation. Every method has
one positive request and accepted-result control. The author validator also
checks lifecycle state, resource/base/expected/intended/result bindings,
recovery generation/fence supersession, and canonical journal predecessor and
transition chains.

`repository-facts.mjs` creates only disposable Git repositories and invokes an
explicit absolute Git executable under a closed environment. The validator
recomputes reported facts from exact command argv/status/signal/stdout/stderr,
recomputes scenario assertions and roles, and verifies current Node/Git
executable bytes and path-stat identities.

The repository identity observations are explicitly only `lstat` plus
`realpath` path snapshots. They are not held-descriptor `fstat` evidence and do
not prove rename/ABA resistance. `MWA-GAP-003` therefore remains blocked.

Raw hostile evidence is published only as an exclusive-create content-addressed
object under `protocol-failures/objects/sha256/`. Existing byte-identical content
is accepted without a write; a collision, corrupted object or overwrite blocks.
The shared immutable-receipt owner is reused for disposable qualification. Its
preflight rejects the current governed research parents as unsafe, and this
isolated benchmark may not change their modes. The governed object therefore
uses the preregistered local exclusive-create fallback and records shared durable
receipt publication and immutable admission as unavailable.

The normal validation commands are:

```text
node build-author-receipt.mjs
node build-author-receipt.mjs --effect-mode=check
node repository-facts.mjs run --git-executable=/absolute/path/to/git
node validate-repository-facts.mjs --evidence=<governed-relative-path>
node validate-contracts.mjs --author-receipt=verification/benchmarks/coordination/migration-write-authority/author-receipt.v2.json --expected-author-receipt-sha256=<external-sha256>
node test-contracts.mjs --expected-author-receipt-sha256=<external-sha256>
```

The builder default and explicit `derive` mode are read-only and write only the
derived receipt bytes to standard output. `check` is read-only. The explicit
`--effect-mode=write` contract is unavailable and fails closed because no
production `MigrationWriteAuthority` exists. Receipt publication must not be
replaced by an unleased overwrite or an ad hoc local writer.

All executable sources, receipts and outputs in this tree remain unregistered
and unadmitted until the repository-wide architecture and evidence cascade is
run by its authority. Do not freeze these sources from this local tranche.

<!-- authority-claims:v1 BEGIN -->
```json
{
  "authorityOwner": "verification/benchmarks/shared/qualification-authority.mjs",
  "inventoryPath": "verification/benchmarks/shared/qualification-authority-inventory.v5.json",
  "inventorySchemaPath": "verification/benchmarks/shared/qualification-authority-inventory.schema.json",
  "inventorySchemaVersion": "bridlewise-qualification-authority-inventory/v5",
  "contractSchemaVersion": "bridlewise-qualification-authority-contract/v5",
  "parserBoundarySchemaVersion": "bridlewise-qualification-parser-boundary/v1",
  "auditSchemaVersion": "bridlewise-qualification-authority-audit/v5",
  "receiptPath": "verification/benchmarks/coordination/migration-write-authority/author-receipt.v2.json",
  "receiptSha256": "638ca6ae1315832776b82a4a6908b205a1fa721ca936982aa15c318cc658c300"
}
```
<!-- authority-claims:v1 END -->
