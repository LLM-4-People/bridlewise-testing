# v2-records

The `engine/test/workspaces/fixtures/v2-records/` folder of the development surface.

## What each file does

Each file is one workspace record of version `bridlewise-workspace/v2`, copied from a host's registry (the shared
`<git common dir>/bridlewise/workspaces/`) with its arrays trimmed to four entries, long strings cut and home paths
replaced by `/home/user`; it holds no credential. One file per shape the host held:

- `active-read-only.json` — an active verifier workspace (no lease, no forge state after migration);
- `active-feature.json` — an active feature workspace (the legacy forge marker after migration);
- `aborted-feature-validated.json` — an aborted feature workspace with its validation report;
- `merged-feature-receipt.json` — a merged feature workspace with its v2 merge receipt (kept verbatim);
- `quarantined-overlay.json` — a quarantined feature workspace started from an overlay.

## Where it lives and what consumes it

The folder lives at `engine/test/workspaces/fixtures/v2-records/`. `engine/test/workspaces/workspace-migration.test.ts`
reads every file through the one record reader (`createWorkspaceRecordStore`'s legacy store, migrated in memory by
`migrateWorkspaceRecord`) and proves no file is ever rewritten.
