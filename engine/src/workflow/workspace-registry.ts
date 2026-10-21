import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HarnessError } from "../kernel/errors.ts";
import { canonicalJson, deepFreeze } from "../kernel/integrity.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { withFileLock } from "../filesystem/file-lock.ts";
import { ensurePrivateStateDirectory } from "../filesystem/private-state.ts";
import { assertWorkspaceId, isTerminalWorkspaceState, migrateWorkspaceRecord, parseWorkspaceRecord, type WorkspaceRecord } from "./workspace-contracts.ts";
import { repositoryRegistryArea, type RepositoryRegistry } from "./repository-registry.ts";

/**
 * THE WORKSPACE RECORDS — the `workspaces/` area of the repository registry
 * (`repository-registry.ts`: `<git common dir>/<product name>/`), so every
 * worktree of the repository reads the same records:
 * `workspaces/<id>.json` ({@link createWorkspaceRecordStore}). The registry's
 * `locks/` area holds the admission and merge locks and its `timeline/` area
 * the per-workspace shards and the integrator's ledger (`workspace-manager.ts`).
 *
 * Kept apart from the manager so a reader of the registry (the
 * `workspaceGit.workspaces` signal: {@link workspaceRegistrySummary}) loads
 * the records' contract and the filesystem, and nothing that runs a process.
 */

export type WorkspaceRecordStore = Readonly<{
  /**
   * THE ONE RECORD WRITER, a compare-and-swap: `record` is written only when
   * the stored record's revision is `record.revision` (no stored record for
   * revision 0), as revision + 1, which it returns; otherwise it refuses
   * (`workspace_record_changed`) and writes nothing. The read, the compare and
   * the write are one step under the record's file lock.
   */
  save(record: WorkspaceRecord): WorkspaceRecord;
  load(workspaceId: string): WorkspaceRecord | null;
  list(): readonly WorkspaceRecord[];
}>;

export function createWorkspaceRecordStore(directory: string): WorkspaceRecordStore {
  ensurePrivateStateDirectory(directory);
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
  // THE ONE RECORD READER: a record of an older version is migrated
  // (`migrateWorkspaceRecord`) and written back atomically under its file
  // lock — re-read there, so a concurrent writer's newer record is never
  // overwritten — with its revision unchanged (the same record, re-tagged).
  const read = (path: string, workspaceId: string): WorkspaceRecord => {
    const first = parseFile(path, workspaceId);
    if (!first.migrated) return first.record;
    return withFileLock(`${path}.lock`, busy(workspaceId), () => {
      const current = parseFile(path, workspaceId);
      if (!current.migrated) return current.record;
      const written = atomicWriteFile(path, `${canonicalJson(current.record)}\n`);
      if (!written.success) throw written.error ?? new HarnessError(`could not write the migrated workspace record ${workspaceId}: ${written.reason ?? "unknown"}`, "workspace_record_write_failed");
      return current.record;
    });
  };
  const load = (workspaceId: string): WorkspaceRecord | null => {
    assertWorkspaceId(workspaceId);
    const path = join(directory, `${workspaceId}.json`);
    return existsSync(path) ? read(path, workspaceId) : null;
  };
  return deepFreeze({
    save(record: WorkspaceRecord): WorkspaceRecord {
      const path = join(directory, `${record.workspaceId}.json`);
      return withFileLock(`${path}.lock`, busy(record.workspaceId), () => {
        const stored = existsSync(path) ? parseFile(path, record.workspaceId).record.revision : 0;
        if (stored !== record.revision) {
          throw new HarnessError(
            `workspace record ${record.workspaceId} changed since it was read (revision ${String(record.revision)}, now ${String(stored)}): another command (an extend, an abort, a sweep) wrote it meanwhile — read its status and run the command again`,
            "workspace_record_changed",
            false,
            { workspaceId: record.workspaceId },
          );
        }
        const next = parseWorkspaceRecord({ ...record, revision: record.revision + 1 });
        const written = atomicWriteFile(path, `${canonicalJson(next)}\n`);
        if (!written.success) throw written.error ?? new HarnessError(`could not write workspace record ${record.workspaceId}: ${written.reason ?? "unknown"}`, "workspace_record_write_failed");
        return next;
      });
    },
    load,
    list(): readonly WorkspaceRecord[] {
      return deepFreeze(readdirSync(directory).toSorted()
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => read(join(directory, entry), entry.slice(0, -".json".length))));
    },
  });
}

/**
 * One line for the workspaces of `registry` (the `workspaceGit.workspaces`
 * signal's words): `none`, or every workspace that is not finished, by state,
 * with its id. Never writes.
 */
export function workspaceRegistrySummary(registry: RepositoryRegistry): string {
  const directory = repositoryRegistryArea(registry, "workspaces");
  if (!existsSync(directory)) return "none";
  const live = createWorkspaceRecordStore(directory).list().filter((record) => !isTerminalWorkspaceState(record.state) || record.state === "quarantined");
  if (live.length === 0) return "none";
  const byState = new Map<string, string[]>();
  for (const record of live) byState.set(record.state, [...(byState.get(record.state) ?? []), record.workspaceId]);
  return [...byState].map(([state, ids]) => `${ids.length} ${state} (${ids.join(", ")})`).join("; ");
}
