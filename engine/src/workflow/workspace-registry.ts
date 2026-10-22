import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HarnessError } from "../kernel/errors.ts";
import { canonicalJson, deepFreeze } from "../kernel/integrity.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { withFileLock } from "../filesystem/file-lock.ts";
import { ensurePrivateStateDirectory } from "../filesystem/private-state.ts";
import { assertWorkspaceId, isTerminalWorkspaceState, LEGACY_WORKSPACE_SCHEMA_VERSION, migrateWorkspaceRecord, parseWorkspaceRecord, type WorkspaceRecord } from "./workspace-contracts.ts";
import { repositoryRegistryArea, type RepositoryRegistry } from "./repository-registry.ts";

/**
 * THE WORKSPACE RECORDS — PER-VERSION STORAGE in the repository registry
 * (`repository-registry.ts`: `<git common dir>/<product name>/`), so every
 * worktree of the repository reads the same records:
 *
 * - the CURRENT store (`workspaces-v3/<id>.json`): every record this code
 *   writes, of the current version;
 * - the LEGACY store (`workspaces/<id>.json`): the records of the version
 *   before the forge (v2), which older code (another checkout of the same
 *   repository, another lane) still reads and writes. This code NEVER writes
 *   there: a legacy record is migrated IN MEMORY on every read
 *   (`migrateWorkspaceRecord`); a legacy workspace this code changes is
 *   written as a NEW record in the current store, noting what it was migrated
 *   from (`migratedFrom`), and the current record wins from then on. The
 *   legacy store is left exactly as it is until Gitea's retirement (runbook
 *   P7), whose recorded cutover archives it.
 *
 * The registry's `locks/` area holds the admission and merge locks and its
 * `timeline/` area the per-workspace shards and the integrator's ledger
 * (`workspace-manager.ts`). Kept apart from the manager so a reader of the
 * registry (the `workspaceGit.workspaces` signal:
 * {@link workspaceRegistrySummary}) loads the records' contract and the
 * filesystem, and nothing that runs a process.
 */

export type WorkspaceRecordStore = Readonly<{
  /**
   * THE ONE RECORD WRITER, a compare-and-swap: `record` is written only when
   * the stored record's revision (the current store's, else the legacy
   * store's, else 0) is `record.revision`, as revision + 1, which it returns;
   * otherwise it refuses (`workspace_record_changed`) and writes nothing. It
   * writes only into the current store. The read, the compare and the write
   * are one step under the record's file lock.
   */
  save(record: WorkspaceRecord): WorkspaceRecord;
  load(workspaceId: string): WorkspaceRecord | null;
  list(): readonly WorkspaceRecord[];
  /** Whether the workspace is known only to the legacy store (older code's: this code never sweeps it). */
  isLegacyOnly(workspaceId: string): boolean;
}>;

/** The two stores' folders. */
export type WorkspaceRecordStores = Readonly<{ current: string; legacy: string }>;

/** The record stores of `registry`: its current and its legacy area. */
export function workspaceRecordStores(registry: RepositoryRegistry): WorkspaceRecordStores {
  return deepFreeze({ current: repositoryRegistryArea(registry, "workspaces"), legacy: repositoryRegistryArea(registry, "legacyWorkspaces") });
}

export function createWorkspaceRecordStore(stores: WorkspaceRecordStores): WorkspaceRecordStore {
  ensurePrivateStateDirectory(stores.current);
  const busy = (workspaceId: string) => (message: string): HarnessError => new HarnessError(`workspace record ${workspaceId} is being written (${message}); try again`, "workspace_record_busy", true, { workspaceId });
  const parseFile = (path: string, workspaceId: string): Readonly<{ record: WorkspaceRecord; migrated: boolean }> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new HarnessError(`workspace record ${workspaceId} is not valid JSON`, "workspace_record_corrupt", false, { workspaceId });
    }
    return migrateWorkspaceRecord(parsed);
  };
  const currentPath = (workspaceId: string): string => join(stores.current, `${workspaceId}.json`);
  const legacyPath = (workspaceId: string): string => join(stores.legacy, `${workspaceId}.json`);
  // A current-store record must BE current: a migrated one there was written by no version of this code.
  const readCurrent = (workspaceId: string): WorkspaceRecord => {
    const parsed = parseFile(currentPath(workspaceId), workspaceId);
    if (parsed.migrated) throw new HarnessError(`workspace record ${workspaceId} in the current store is not of the current version`, "workspace_record_invalid", false, { workspaceId });
    return parsed.record;
  };
  // THE ONE RECORD READER: the current store's record, else the legacy one migrated in memory (never written back).
  const load = (workspaceId: string): WorkspaceRecord | null => {
    assertWorkspaceId(workspaceId);
    if (existsSync(currentPath(workspaceId))) return readCurrent(workspaceId);
    return existsSync(legacyPath(workspaceId)) ? parseFile(legacyPath(workspaceId), workspaceId).record : null;
  };
  const ids = (directory: string): readonly string[] => (existsSync(directory)
    ? readdirSync(directory).filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -".json".length))
    : []);
  return deepFreeze({
    save(record: WorkspaceRecord): WorkspaceRecord {
      const path = currentPath(record.workspaceId);
      return withFileLock(`${path}.lock`, busy(record.workspaceId), () => {
        const legacy = existsSync(path) ? null : existsSync(legacyPath(record.workspaceId)) ? parseFile(legacyPath(record.workspaceId), record.workspaceId).record : null;
        const stored = existsSync(path) ? readCurrent(record.workspaceId).revision : legacy?.revision ?? 0;
        if (stored !== record.revision) {
          throw new HarnessError(
            `workspace record ${record.workspaceId} changed since it was read (revision ${String(record.revision)}, now ${String(stored)}): another command (an extend, an abort, a sweep) wrote it meanwhile — read its status and run the command again`,
            "workspace_record_changed",
            false,
            { workspaceId: record.workspaceId },
          );
        }
        // A legacy workspace's first write here: a NEW current record, noting its origin.
        const migratedFrom = legacy === null ? record.migratedFrom : { schemaVersion: LEGACY_WORKSPACE_SCHEMA_VERSION, revision: legacy.revision };
        const next = parseWorkspaceRecord({ ...record, migratedFrom, revision: record.revision + 1 });
        const written = atomicWriteFile(path, `${canonicalJson(next)}\n`);
        if (!written.success) throw written.error ?? new HarnessError(`could not write workspace record ${record.workspaceId}: ${written.reason ?? "unknown"}`, "workspace_record_write_failed");
        return next;
      });
    },
    load,
    list(): readonly WorkspaceRecord[] {
      return deepFreeze([...new Set([...ids(stores.current), ...ids(stores.legacy)])].toSorted().map((workspaceId) => load(workspaceId)!));
    },
    isLegacyOnly(workspaceId: string): boolean {
      return !existsSync(currentPath(workspaceId)) && existsSync(legacyPath(workspaceId));
    },
  });
}

/**
 * One line for the workspaces of `registry` (the `workspaceGit.workspaces`
 * signal's words): `none`, or every workspace that is not finished, by state,
 * with its id. Never writes.
 */
export function workspaceRegistrySummary(registry: RepositoryRegistry): string {
  const stores = workspaceRecordStores(registry);
  if (!existsSync(stores.current) && !existsSync(stores.legacy)) return "none";
  const live = createWorkspaceRecordStore(stores).list().filter((record) => !isTerminalWorkspaceState(record.state) || record.state === "quarantined");
  if (live.length === 0) return "none";
  const byState = new Map<string, string[]>();
  for (const record of live) byState.set(record.state, [...(byState.get(record.state) ?? []), record.workspaceId]);
  return [...byState].map(([state, ids]) => `${ids.length} ${state} (${ids.join(", ")})`).join("; ");
}
