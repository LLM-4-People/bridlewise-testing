# test-surface-dispositions

The test-surface disposition records: one file per decided test source, the
exceptions only. A qualified Node test source is canonical by default and has
no record.

## What each file does

Each record is named after the source it decides, its repository path
percent-encoded into the file name (`live%2Fmcp-servers.test.ts.json` decides
`live/mcp-servers.test.ts`). It holds the disposition, its rationale and
evidence, whether it blocks a full-repository claim, and the discovery-policy
hash it was decided under. The source's language is derived from its path.

Two branches that each decide a source write two different files, so they
merge without a conflict. A record decided under another discovery policy is
refused by name when it is read, and nothing re-signs it: re-decide it under the
current policy.

## Where it lives and what consumes it

The folder lives at `engine/traceability/test-surface-dispositions/`
(`ROOT_POLICY.verification.testDiscovery.dispositionRegistry.recordsPath`). The
one reader and writer is `engine/src/workflow/disposition-records.ts`, and the
records' shape and judgement belong to `engine/src/kernel/test-surface-manifest.ts`.
The test inventory, the auto-heal step of the engine runner, `harness sync`,
the hermetic-skips guard and the floor atlas read them.
