# COORD-001 — Concurrent research-layout move crossed an active owner

- Status: `open-blocking`
- Owner: `multi-agent-coordination`
- First recorded: `2026-07-12`, `America/Toronto`
- Affected surface: `builder`

## Finding

A repository-wide research-layout move began after a coordination message said
the top-level research paths were safe. A Git-qualification agent was still
moving its owned documentation, schemas, and source-lock evidence concurrently.
The broad move therefore crossed that agent's write set and produced a temporary
split across documentation, verification, and traceability paths.

The Git-qualification owner subsequently reconciled the bundle and published a
final manifest, catalog, source lock, schemas, runner, and tests at the
standardized paths. The obsolete pre-reconciliation source-lock copy was
explicitly rejected in favor of the canonical documentation source lock; its
hash and disposition remain in the artifact manifest rather than becoming a
second authority. This resolves the byte/path collision, but not the missing
coordination control that allowed it.

## Root cause and consequence

The coordination protocol relied on a conversational "safe" signal without an
enforced live write-set lease covering every descendant path. It also lacked a
semantic resource set, fencing token, compare-and-swap base, and automatic
incident-to-fixture learning loop. `DER-031` and `DER-032` now bind those missing
controls, but they remain unimplemented and unqualified.

## Reconciliation evidence

- Git suite manifest:
  `verification/benchmarks/git/MANIFEST.json`,
  historical reconciled SHA-256
  `f73ff33d05dc99ed16c654e33e0856386a1fef6fc6a3313f37899a9c04bbb1c3`,
  then post-`USR-047` source-binding SHA-256
  `bffd7716fa22782f858960d7ddc0d7a0598672a63a0d5909802925d203a45a47`.
- Scenario catalog:
  SHA-256 `8401b2b4a07dfb7be17c2dbe2ca16a8185122742a56b671bb2c815dd3c3671f3`.
- Canonical source lock:
  `docs/research/git/qualification/sources.lock.json`, post-`USR-047`
  SHA-256 `05d7d39457b6c27c078b8ff4adc1eec20042f3c966a845fbab69f6d63910a1b4`.
- Requirements controls:
  `traceability/canonical/harness-requirements.md#DER-031` and
  `traceability/canonical/harness-requirements.md#DER-032`.

## Post-incident qualification milestone

The context qualification suite froze and tested the following immutable inputs:

- canonical requirements SHA-256
  `cf4956d73bc0b50505a52b654ae035679237f70de9d8e5860940d474295cbd83`;
- Architecture v1 SHA-256
  `ffb2e2eae0f9d708c24d832883e71e1aa8063a837a50366cd07d5fd143d88183`;
- this finding's pre-milestone SHA-256
  `b2a97a2ac1e35dba1c0fed3c905048aa95673e9559756717ccfc2f1ddcd7b578`.

Its manifest SHA-256 is
`c0a14d30ccae9effae9d5405baad3e10aaa5b6c833c2313ffcb9424620b63e75`.
The manifest-bound validation receipt is
`traceability/evidence/research/context/qualification-design-validation.json`,
SHA-256
`2496681b924b4054b74679252e8e732927aa59647963de12a08d6abb4af814f6`.
`validate-suite.py --require-manifest` passed with 31 templates, 36 queries,
63 tags, three seeds, 40 metrics, eight gates, 17 automatic hooks, three
memory topologies, two broker dimensions, 12 manifest artifacts, and no
qualification/readiness claim.

This evidence closes only the documentation/migration collision reconciliation
and supplies a governed future regression fixture. It does **not** close this
finding: the production brokered resource sets, leases, heartbeats, TTLs,
fencing, CAS, drift handling, and independent runtime repetitions required by
`DER-032` remain unimplemented.

## Removal condition

1. Preserve the completed exact Git-bundle reconciliation and prove no old path,
   duplicate, shim, or orphan returns.
2. Implement the single brokered hierarchical physical and semantic read/write
   set authority, leases, heartbeat/TTL, fencing, deadlock/orphan recovery, CAS,
   worktree/shared-resource rules, and out-of-band drift invalidation in
   `DER-032`.
3. Convert this incident into the durable fixture/mutant/permanent-regression
   lifecycle required by `DER-031`, including independent recheck.
4. Run the descendant, stale-signal, alias/rename, semantic-overlap, crash,
   fencing, and CAS cases at least three times with useful parallelism retained.
5. Only then mark the finding verified removed; byte reconciliation or a passing
   artifact inventory alone is insufficient.

- Regression: `agent-write-set-descendant-lease-and-stale-signal-mutation-x3`
- Removal verification: `independent-byte-inventory-link-and-lease-replay`
- Deadline: `before-artifact-inventory-freeze-or-research-layout-acceptance`

## Recurrence — migration-review input epoch changed during active review

On 2026-07-12, a migration-plan independent re-review was active while a
parallel admission-cascade task recorded
`CAP-001-runtime-capability-false-absence`. That task added the new open finding
to `src/architecture-manifest.ts`, changing its SHA-256 from
`1548c9e738c00fcf384c325f4916d5df4cc9535d13cd5615bae18db338ed1fdf`
to `363fd9ba975d9ebae2fbb65ef31ca8ca0025025f926950ed92a7f22cecc878bc`.
The active reviewer had not been protected by a frozen-input lease, so any
observations made against the earlier manifest epoch ceased to describe the
candidate under review.

The Architecture document and migration plan were not edited: they remained
`73e3cac84262145027b08cae98039f8ffb4a587d37b1669546ef0340cbe80a78`
and
`e04f93499e5304b7647c04cd1e5b11a7fcc27cab2e6edf8bca93e703df7b4eb9`
respectively. The conflict is nevertheless material because the migration plan
and its reviewer treat the architecture manifest as a governed graph input.

The reviewer and coordinating parent were notified immediately. All reviewed
graph inputs were then frozen; the prior in-progress review epoch is not
admissible as a review of the changed candidate. The review must explicitly
restart or rebind to the final input tuple and preserve its blocked verdicts.
This recurrence adds no readiness evidence and does not close either COORD-001
or CAP-001.

Root cause: parallel work was authorized by task scope but no live hierarchical
read/write-set lease or content-epoch fence prevented a writer from changing a
review input. A conversational notice after mutation detects the conflict but
cannot make the earlier observations current.

Permanent regression extension: while an independent review holds a read lease
over a content-addressed input tuple, mutate one direct input, one generated
dependency and one semantically governed input in separate repetitions. Every
mutation must fence or invalidate the review before verdict publication; a
review bound to any mixed epoch must fail closed. Disjoint derived drafts remain
permitted and cannot silently enter the reviewed tuple.

### Plan-history preservation gap

The remediated plan epoch with SHA-256
`e04f93499e5304b7647c04cd1e5b11a7fcc27cab2e6edf8bca93e703df7b4eb9`
was subsequently edited in place before an immutable governed copy was made.
The independent review records its identity, line count, byte count and
findings, but no exact full-byte copy remains available in the workspace. It is
therefore an unrecoverable historical reproducibility gap: the bytes must not be
reconstructed from quotations, review excerpts, model context, or a claimed
equivalent document, and no later plan may reuse that digest.

Before further remediation, the then-current 1,206-line, 86,752-byte plan was
preserved byte-for-byte as
`docs/architecture/physical-migration-plan-2026-07-12T08-13-40-04-00.superseded.md`.
Both source and preserved copy verified as SHA-256
`6ffba0ac21fc025d6b05b6be8e49c94467e1f8f05b78479ef7ce2f2cae77b629`
with an exact byte comparison. All future plan epochs require preservation
before mutation, and admission must retain this gap rather than representing a
continuous byte history that does not exist.
