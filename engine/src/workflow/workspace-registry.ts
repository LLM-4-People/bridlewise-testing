import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HarnessError } from "../kernel/errors.ts";
import { canonicalJson, deepFreeze } from "../kernel/integrity.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { withFileLock } from "../filesystem/file-lock.ts";
import { ensurePrivateStateDirectory } from "../filesystem/private-state.ts";
import {
  assertWorkspaceId, isTerminalWorkspaceState, migrateWorkspaceRecord, OLDER_WORKSPACE_SCHEMA_VERSIONS, parseWorkspaceRecord, WORKSPACE_SCHEMA_VERSION,
  type OlderWorkspaceSchemaVersion, type WorkspaceRecord,
} from "./workspace-contracts.ts";
import { repositoryRegistryArea, type RepositoryRegistry, type RepositoryRegistryArea } from "./repository-registry.ts";

/**
 * THE WORKSPACE RECORDS — PER-VERSION STORAGE in the repository registry
 * (`repository-registry.ts`: `<git common dir>/<product name>/`), so every
 * worktree of the repository reads the same records:
 *
 * - the CURRENT store (`workspaces-v4/<id>.json`): every record this code
 *   writes, of the current version, and the only place it writes;
 * - the OLDER stores, newest first (`workspaces-v3/`: `ws publish`/`ready`
 *   before the land; `workspaces/`: v2, before the forge), which older code
 *   (another checkout of the same repository, another lane) still reads and
 *   writes. An older record is migrated IN MEMORY on every read (the one
 *   chain, `migrateWorkspaceRecord`) and is READ-ONLY to this code: a
 *   workspace known only to an older store belongs to the checkout of the
 *   version that made it, so every save of one is refused
 *   (`workspace_owned_by_v2_checkout`, `workspace_owned_by_v3_checkout`) and
 *   no current twin is ever made of it. The older stores are left exactly as
 *   they are until the recorded cutover that archives them (runbook P7 for
 *   v2).
 *
 * The registry's `locks/` area holds the admission and merge locks and its
 * `timeline/` area the per-workspace shards and the integrator's ledger
 * (`workspace-manager.ts`). Kept apart from the manager so a reader of the
 * registry (the `workspaceGit.workspaces` signal:
 * {@link workspaceRegistrySummary}) loads the records' contract and the
 * filesystem, and nothing that runs a process.
 */

/** Where a workspace known only to an older store lives: its version and its record. */
export type OlderRecord = Readonly<{ version: OlderWorkspaceSchemaVersion; path: string }>;

export type WorkspaceRecordStore = Readonly<{
  /**
   * THE ONE RECORD WRITER, a compare-and-swap: `record` is written only when
   * the current store's revision of it (0 when it has none) is
   * `record.revision`, as revision + 1, which it returns; otherwise it refuses
   * (`workspace_record_changed`) and writes nothing. A workspace known only
   * to an older store is never written (`workspace_owned_by_v<N>_checkout`).
   * The read, the compare and the write are one step under the record's file
   * lock.
   */
  save(record: WorkspaceRecord): WorkspaceRecord;
  load(workspaceId: string): WorkspaceRecord | null;
  list(): readonly WorkspaceRecord[];
  /** The older store holding the workspace when ONLY an older store knows it (older code's: read-only here), else null. */
  olderRecord(workspaceId: string): OlderRecord | null;
}>;

/** The stores' folders: the current one, and each older version's, newest first. */
export type WorkspaceRecordStores = Readonly<{ current: string; older: readonly Readonly<{ version: OlderWorkspaceSchemaVersion; directory: string }>[] }>;

/** The record stores of `registry`: its current area and each older version's. */
export function workspaceRecordStores(registry: RepositoryRegistry): WorkspaceRecordStores {
  const areas: Readonly<Record<OlderWorkspaceSchemaVersion, RepositoryRegistryArea>> = { [OLDER_WORKSPACE_SCHEMA_VERSIONS[0]]: "workspacesV3", [OLDER_WORKSPACE_SCHEMA_VERSIONS[1]]: "workspacesV2" } as Record<OlderWorkspaceSchemaVersion, RepositoryRegistryArea>;
  return deepFreeze({
    current: repositoryRegistryArea(registry, "workspaces"),
    older: OLDER_WORKSPACE_SCHEMA_VERSIONS.map((version) => ({ version, directory: repositoryRegistryArea(registry, areas[version]) })),
  });
}

/** Each older version's refusal code. */
const OWNED_BY: Readonly<Record<OlderWorkspaceSchemaVersion, string>> = {
  [OLDER_WORKSPACE_SCHEMA_VERSIONS[0]]: "workspace_owned_by_v3_checkout",
  [OLDER_WORKSPACE_SCHEMA_VERSIONS[1]]: "workspace_owned_by_v2_checkout",
} as Record<OlderWorkspaceSchemaVersion, string>;

/**
 * THE REFUSAL of a change to a workspace known only to an older store: it
 * belongs to the checkout of the version that made it (its record in that
 * store, its worktree where that checkout made it); this version reads it and
 * never changes it before the recorded cutover.
 */
export function refuseOwnedByOlder(workspaceId: string, older: OlderRecord, worktreePath: string): never {
  throw new HarnessError(
    `workspace ${workspaceId} belongs to the ${older.version} code that made it (its record ${older.path}, its worktree ${worktreePath}): this version reads it and never changes it before the recorded cutover — act on it from that checkout`,
    OWNED_BY[older.version],
    false,
    { workspaceId, version: older.version },
  );
}

export function createWorkspaceRecordStore(stores: WorkspaceRecordStores): WorkspaceRecordStore {
  ensurePrivateStateDirectory(stores.current);
  const busy = (workspaceId: string) => (message: string): HarnessError => new HarnessError(`workspace record ${workspaceId} is being written (${message}); try again`, "workspace_record_busy", true, { workspaceId });
  // A store holds only its own version: a record of another version there was written by no version's own code.
  const parseFile = (path: string, workspaceId: string, version: string): WorkspaceRecord => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new HarnessError(`workspace record ${workspaceId} is not valid JSON`, "workspace_record_corrupt", false, { workspaceId });
    }
    const found = parsed !== null && typeof parsed === "object" ? (parsed as Readonly<Record<string, unknown>>)["schemaVersion"] : undefined;
    if (found !== version) throw new HarnessError(`workspace record ${workspaceId} in the ${version} store is of version ${String(found)}`, "workspace_record_invalid", false, { workspaceId });
    return migrateWorkspaceRecord(parsed).record;
  };
  const currentPath = (workspaceId: string): string => join(stores.current, `${workspaceId}.json`);
  const olderRecord = (workspaceId: string): OlderRecord | null => {
    if (existsSync(currentPath(workspaceId))) return null;
    for (const store of stores.older) {
      const path = join(store.directory, `${workspaceId}.json`);
      if (existsSync(path)) return Object.freeze({ version: store.version, path });
    }
    return null;
  };
  // THE ONE RECORD READER: the current store's record, else the newest older store's, migrated in memory (never written back).
  const load = (workspaceId: string): WorkspaceRecord | null => {
    assertWorkspaceId(workspaceId);
    if (existsSync(currentPath(workspaceId))) return parseFile(currentPath(workspaceId), workspaceId, WORKSPACE_SCHEMA_VERSION);
    const older = olderRecord(workspaceId);
    return older === null ? null : parseFile(older.path, workspaceId, older.version);
  };
  const ids = (directory: string): readonly string[] => (existsSync(directory)
    ? readdirSync(directory).filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -".json".length))
    : []);
  return deepFreeze({
    save(record: WorkspaceRecord): WorkspaceRecord {
      const path = currentPath(record.workspaceId);
      return withFileLock(`${path}.lock`, busy(record.workspaceId), () => {
        const older = olderRecord(record.workspaceId);
        if (older !== null) refuseOwnedByOlder(record.workspaceId, older, record.lease.worktreePath);
        const stored = existsSync(path) ? parseFile(path, record.workspaceId, WORKSPACE_SCHEMA_VERSION).revision : 0;
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
      return deepFreeze([...new Set([stores.current, ...stores.older.map((store) => store.directory)].flatMap(ids))].toSorted().map((workspaceId) => load(workspaceId)!));
    },
    olderRecord,
  });
}

/**
 * One line for the workspaces of `registry` (the `workspaceGit.workspaces`
 * signal's words): `none`, or every workspace that is not finished, by state,
 * with its id. Never writes.
 */
export function workspaceRegistrySummary(registry: RepositoryRegistry): string {
  const stores = workspaceRecordStores(registry);
  if (![stores.current, ...stores.older.map((store) => store.directory)].some((directory) => existsSync(directory))) return "none";
  const live = createWorkspaceRecordStore(stores).list().filter((record) => !isTerminalWorkspaceState(record.state) || record.state === "quarantined");
  if (live.length === 0) return "none";
  const byState = new Map<string, string[]>();
  for (const record of live) byState.set(record.state, [...(byState.get(record.state) ?? []), record.workspaceId]);
  return [...byState].map(([state, ids]) => `${ids.length} ${state} (${ids.join(", ")})`).join("; ");
}
