---
id: WS-RECORDS
date: 2026-10-22
by: coordinator
group: github
status: in-force
implementation: done
acted_in: [engine/src/workflow/workspace-registry.ts, engine/src/workflow/workspace-contracts.ts, engine/src/workflow/workspace-manager.ts, engine/src/workflow/repository-registry.ts]
---
# Older workspace records are read-only, upcast in memory, and never written

A workspace record is stored in the store of the version that wrote it. The
stores share the repository registry (`<git common dir>/bridlewise/`):

| Version | What it added | Store |
|---|---|---|
| v2 | the record before the forge | `workspaces/` |
| v3 | `ws publish` and `ready` | `workspaces-v3/` |
| v4 | `ws land` | `workspaces-v4/` |
| v5 | stacks (`stackedOn`) | `workspaces-v5/` (current) |

Code of a given version writes only its own store. It reads every older
store and upcasts each record through the one migration chain
(v2 → v3 → v4 → v5, `migrateWorkspaceRecord`). The upcast is in memory only.
It never writes a migrated copy, never writes back to the older store, and
never writes anything derived from an older record. Older code, in another
checkout of the same repository, keeps reading and writing its own store
unchanged.

A workspace known only to an older store belongs to the checkout of the
version that made it. It stays read-only to newer code until its recorded
cutover (runbook P7):
- the store refuses a save of it, as does every saving or destructive verb,
  before touching anything (`workspace_owned_by_v<N>_checkout`, naming its
  record and its worktree);
- `sweep` never ends it.

Each store holds only its own version: a record of another version found in
a store is refused, never silently migrated. A version that changes the
record's shape adds its own store and one step to the chain. It never
rewrites the stores before it.
