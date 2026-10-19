/**
 * MigrationWriteAuthority — node:sqlite backend implementing
 * `MigrationAuthorityBackendPort`.
 *
 * Owns lease state and monotonic fencing generations. Uses `node:sqlite`
 * `DatabaseSync` with rollback-journal (`DELETE`) mode + `synchronous=EXTRA`
 * + `foreign_keys=ON` + a defensive behavior probe. Every state-mutating
 * method runs inside `BEGIN IMMEDIATE` so the RESERVED write lock serializes
 * the read-modify-write (matching `src/timeline/timeline-store.ts`).
 *
 * Design authority: MWA-DESIGN §3. The schema follows §3.3 (all STRICT tables)
 * with one Tranche-1 addition: `pending_fences` durably records each granted
 * per-effect fence so `compareAndCommit` can crash-safely compare-and-swap the
 * effect observation against the fence-time expected state (see deviation
 * note below). Resource conflicts are enforced by the `resource_write_unique`
 * partial unique index (one writer per resource) plus a read-vs-write check.
 * Idempotency is enforced by the `idempotency_keys` table. The journal is
 * append-only, predecessor-linked, and hash-chained via `computeChainHash`
 * with the MWA ledger domain. `partialReservationRetained` is always `false`.
 *
 * Deviation note (pending_fences): MWA-DESIGN §3.3 lists nine tables and leaves
 * the fence→CAS protocol's durable state implicit. A crash-safe compare-and-
 * swap requires recording the fence-time `expectedState` so a caller cannot
 * swap it between `fence` and `compareAndCommit`. `pending_fences` is the
 * minimal durable owner for that record; it is removed on commit. This is a
 * faithful extension, not a second lease store.
 */

import { DatabaseSync } from "node:sqlite";

import { extractErrorMessage, InputError, SecurityError } from "../../../../src/kernel/errors.ts";
import { bestEffort } from "../../../../src/shared/best-effort.ts";
import { canonicalHash, deepFreeze, generateId, sha256 } from "../../../../src/kernel/integrity.ts";
import {
  computeChainHash,
  ZERO_CHAIN_HASH,
} from "../../../../src/timeline/ledger-primitives.ts";
import {
  createLiveGrant,
  isBackendErrorCode,
  isLiveGrant,
  MWA_BACKEND_SCHEMA_VERSION,
  MWA_LEDGER_DOMAIN,
  MWA_LEASE_EVIDENCE_AUTHORITY,
  MWA_PROTOCOL_SCHEMA_VERSION,
  MWA_RECEIPT_AUTHORITY,
  type AcquireInput,
  type BackendAcquireResult,
  type BackendError,
  type BackendFenceResult,
  type BackendInspectResult,
  type BackendOpenFacts,
  type BackendOpenResult,
  type BackendResult,
  type CheckpointInput,
  type CompareAndCommitInput,
  type FenceInput,
  type HeartbeatInput,
  type InspectInput,
  type LeaseEvidence,
  type LeaseState,
  type LeaseTransition,
  type LiveGrant,
  type MigrationAuthorityConfig,
  type MigrationAuthorityRootPolicy,
  type MigrationResource,
  type RecoverInput,
  type ReleaseInput,
  type ReleaseDisposition,
  type ReserveInput,
} from "./contracts.ts";
import { migrationResourcesConflict } from "./resources.ts";
import { denied } from "./internal.ts";
import type { MigrationWriteAuthorityGenesisRecord } from "./genesis.ts";
import { createGenesisRecordIdentity } from "./genesis.ts";

type Stmt = ReturnType<DatabaseSync["prepare"]>;
type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Schema DDL (all STRICT tables)
// ---------------------------------------------------------------------------

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS authority_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version TEXT NOT NULL,
  sqlite_version TEXT NOT NULL,
  sqlite_source_identity TEXT NOT NULL,
  genesis_record_identity TEXT NOT NULL,
  created_wall_iso TEXT NOT NULL,
  upgraded_wall_iso TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS repository_bindings (
  repository_identity TEXT PRIMARY KEY,
  common_directory_identity TEXT NOT NULL,
  object_store_identity TEXT NOT NULL,
  object_format TEXT NOT NULL CHECK(object_format IN ('sha1','sha256'))
) STRICT;

CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  fence_identity TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('active','quiescing','reconciling','released','expired','fenced','blocked-unknown-effect')),
  actor_json TEXT NOT NULL,
  base_json TEXT NOT NULL,
  plan_identity TEXT NOT NULL,
  repository_identity TEXT NOT NULL,
  common_directory_identity TEXT NOT NULL,
  resource_registry_identity TEXT NOT NULL,
  requested_ttl_ms INTEGER NOT NULL,
  acquired_monotonic_ns TEXT NOT NULL,
  acquired_wall_iso TEXT NOT NULL,
  last_heartbeat_monotonic_ns TEXT NOT NULL,
  last_heartbeat_wall_iso TEXT NOT NULL,
  process_identity TEXT NOT NULL,
  journal_cursor TEXT NOT NULL,
  FOREIGN KEY (repository_identity) REFERENCES repository_bindings(repository_identity)
) STRICT;

CREATE TABLE IF NOT EXISTS fencing_sequence (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  next_generation TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS resource_reservations (
  resource_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  access TEXT NOT NULL CHECK(access IN ('read','write')),
  reservation_ordinal INTEGER NOT NULL,
  reserved_monotonic_ns TEXT NOT NULL,
  resource_json TEXT NOT NULL,
  PRIMARY KEY (resource_id, lease_id),
  FOREIGN KEY (lease_id) REFERENCES leases(lease_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS resource_write_unique
  ON resource_reservations(resource_id) WHERE access = 'write';

CREATE TABLE IF NOT EXISTS journal (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  previous_entry_identity TEXT,
  entry_identity TEXT NOT NULL UNIQUE,
  repository_identity TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  transition TEXT NOT NULL CHECK(transition IN
    ('requested-active','active-quiescing','active-expired','active-fenced',
     'quiescing-reconciling','reconciling-released',
     'reconciling-blocked-unknown-effect','active-released')),
  request_identity TEXT NOT NULL,
  effect_identity TEXT,
  observed_state_identity TEXT,
  created_monotonic_ns TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS journal_lease_idx ON journal(lease_id, sequence);

CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  completed_effect_identities_json TEXT NOT NULL,
  remaining_write_resource_ids_json TEXT NOT NULL,
  next_safe_action TEXT NOT NULL CHECK(next_safe_action IN
    ('none','revalidate','fence-next-effect','reconcile-external-state','release')),
  journal_cursor TEXT NOT NULL,
  created_monotonic_ns TEXT NOT NULL,
  FOREIGN KEY (lease_id) REFERENCES leases(lease_id)
) STRICT;

CREATE TABLE IF NOT EXISTS pending_fences (
  lease_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  fence_identity TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  expected_state_identity TEXT NOT NULL,
  intended_state_identity TEXT NOT NULL,
  granted_monotonic_ns TEXT NOT NULL,
  PRIMARY KEY (lease_id, effect_id),
  FOREIGN KEY (lease_id) REFERENCES leases(lease_id)
) STRICT;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  request_identity TEXT NOT NULL,
  lease_id TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','denied')),
  error_code TEXT,
  created_monotonic_ns TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO fencing_sequence (singleton, next_generation) VALUES (1, '1');
`;

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

function nowMonotonicNs(): string {
  return process.hrtime.bigint().toString(10);
}

function nowWallIso(): string {
  return new Date().toISOString();
}

/** fence_identity = sha256(leaseId \u0000 generation \u0000 repository \u0000 registry). */
function computeFenceIdentity(leaseId: string, generation: string, repositoryIdentity: string, resourceRegistryIdentity: string): string {
  return sha256([leaseId, generation, repositoryIdentity, resourceRegistryIdentity].join("\u0000"));
}

/**
 * Canonical request identity. Excludes the `idempotencyKey` (self-reference)
 * and the opaque in-process `LiveGrant` (Symbol-branded, non-serializable). The
 * serializable `leaseEvidence` already carries the lease binding (leaseId,
 * generation, fenceIdentity), so stripping `liveGrant` does not weaken the
 * identity: two requests for the same lease produce the same identity, and
 * two requests for different leases differ via `leaseEvidence`.
 */
function computeRequestIdentity(input: Readonly<Record<string, unknown>>): string {
  const { idempotencyKey, liveGrant, ...rest } = input;
  void idempotencyKey;
  void liveGrant;
  return canonicalHash(rest);
}

function acceptedResult(leaseEvidence: LeaseEvidence, journalCursor: string): BackendResult {
  return deepFreeze({ outcome: "accepted", leaseEvidence, journalCursor });
}

function makeLeaseEvidence(row: Row): LeaseEvidence {
  return deepFreeze({
    leaseId: String(row.lease_id),
    generation: String(row.generation),
    fenceIdentity: String(row.fence_identity),
    state: String(row.state) as LeaseState,
    receiptAuthority: MWA_LEASE_EVIDENCE_AUTHORITY,
  });
}

function backendErrorFrom(error: unknown, fallback: BackendError["code"]): BackendError {
  if (error instanceof InputError && isBackendErrorCode(error.code)) {
    return deepFreeze({ code: error.code, message: error.message });
  }
  const message = extractErrorMessage(error);
  return deepFreeze({ code: fallback, message });
}

// ---------------------------------------------------------------------------
// Defensive behavior probe
// ---------------------------------------------------------------------------

/**
 * Defensive behavior probe (MWA-DESIGN §3.4 option B). `PRAGMA defensive` has
 * no getter on the bundled SQLite (returns no row), so we verify defensive is
 * active by testing BOTH directions of a known-dangerous schema write:
 *
 *  1. WITHOUT defensive: `PRAGMA writable_schema=ON` + `INSERT INTO
 *     sqlite_master` must SUCCEED. This proves the operation is genuinely
 *     dangerous and CAN distinguish defensive state. If the write is rejected
 *     even without defensive (baseline protection), the probe is tautological
 *     and returns `false` (fail closed).
 *  2. WITH defensive: the same write must be REJECTED. If it succeeds,
 *     defensive is not enforced → return `false`.
 *
 * The probe enables defensive on `db` (the authority DB) as a persistent
 * side-effect, but tests both directions on SEPARATE in-memory DBs to avoid
 * corrupting the authority DB with a successful dangerous write.
 *
 * The two verification DBs are created by `probeDbFactory` (default: real
 * `DatabaseSync(":memory:")`). Injecting a fake factory allows the regression
 * test to catch a tautological mutant (`db.enableDefensive(true); return true;`)
 * that keeps the side-effect but skips verification: the fake makes the
 * "without-defensive" dangerous write REJECTED, so the correct probe returns
 * `false` (baseline cannot be established); the tautological mutant returns
 * `true` and is caught.
 *
 * Probed runtime fact (2026-07-17, Node v24.18.0, SQLite 3.53.1): the
 * `INSERT INTO sqlite_master` with `writable_schema=ON` succeeds without
 * defensive and is rejected with defensive, so the probe reliably
 * distinguishes the two states. A mutant that replaces the probe body with
 * `return true` would NOT enable defensive on `db`; the regression test
 * catches this by verifying the probe leaves defensive enabled on `db`.
 */

/** Narrow interface the probe needs from its verification DBs. */
export type ProbeDb = Pick<DatabaseSync, "enableDefensive" | "exec" | "close">;

/** Factory that creates a fresh verification DB for the probe. */
export type ProbeDbFactory = () => ProbeDb;

const DEFAULT_PROBE_DB_FACTORY: ProbeDbFactory = () => new DatabaseSync(":memory:");

export function probeBackendDefensive(db: DatabaseSync, probeDbFactory: ProbeDbFactory = DEFAULT_PROBE_DB_FACTORY): boolean {
  // Enable defensive on the authority DB (persistent side-effect).
  db.enableDefensive(true);

  // Step 1: WITHOUT defensive, the dangerous write must SUCCEED (proving
  // the operation is genuinely dangerous and can distinguish defensive state).
  const probeDbNoDef = probeDbFactory();
  try {
    probeDbNoDef.enableDefensive(false);
    try {
      probeDbNoDef.exec("PRAGMA writable_schema=ON");
      probeDbNoDef.exec(
        "INSERT INTO sqlite_master (type,name,tbl_name,rootpage,sql) VALUES ('table','evil','evil',0,'CREATE TABLE evil(id)')",
      );
    } catch {
      // Rejected even without defensive → the probe is tautological and
      // cannot verify defensive mode on this build → fail closed.
      return false;
    }
  } finally {
    bestEffort(() => probeDbNoDef.close());
  }

  // Step 2: WITH defensive, the dangerous write must be REJECTED.
  const probeDbDef = probeDbFactory();
  try {
    probeDbDef.enableDefensive(true);
    try {
      probeDbDef.exec("PRAGMA writable_schema=ON");
      probeDbDef.exec(
        "INSERT INTO sqlite_master (type,name,tbl_name,rootpage,sql) VALUES ('table','evil','evil',0,'CREATE TABLE evil(id)')",
      );
      // The dangerous write succeeded WITH defensive → defensive is not enforced.
      return false;
    } catch {
      // Rejected with defensive → defensive is enforced.
      return true;
    }
  } finally {
    bestEffort(() => probeDbDef.close());
  }
}

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

export class NodeSqliteMigrationBackend {
  private readonly db: DatabaseSync;
  private readonly rootPolicy: MigrationAuthorityRootPolicy;
  private readonly genesisIdentity: string;
  private readonly probeDbFactory: ProbeDbFactory;

  // Prepared statements (created lazily after open).
  private stmtLeaseById: Stmt | undefined;
  private stmtReservationsByLease: Stmt | undefined;
  private stmtJournalLast: Stmt | undefined;
  private stmtIdempotencyGet: Stmt | undefined;
  private stmtIdempotencyPut: Stmt | undefined;
  private stmtReservationByResource: Stmt | undefined;
  private stmtFenceGet: Stmt | undefined;

  constructor(input: Readonly<{
    dbPath: string;
    rootPolicy: MigrationAuthorityRootPolicy;
    config: MigrationAuthorityConfig;
    genesisRecord: MigrationWriteAuthorityGenesisRecord;
    probeDbFactory?: ProbeDbFactory;
  }>) {
    if (typeof input.dbPath !== "string" || input.dbPath.length === 0) {
      throw new InputError("dbPath is required", "backend_corrupt");
    }
    this.rootPolicy = input.rootPolicy;
    this.genesisIdentity = createGenesisRecordIdentity(input.genesisRecord);
    // The busy timeout is a CONNECTION option, so it governs the very first
    // statement: `open()`'s journal-mode pragma needs a lock too, and set
    // later (as a pragma after it) a second process opening while the first
    // commits failed at once with "database is locked" — a race a tmpfs hid
    // (fast commits) and a real disk exposed (hostile-01 under a disk TMPDIR).
    this.db = new DatabaseSync(input.dbPath, { timeout: input.config.busyTimeoutMs });
    this.probeDbFactory = input.probeDbFactory ?? DEFAULT_PROBE_DB_FACTORY;
  }

  // ----- lifecycle -----

  open(): BackendOpenResult {
    const rp = this.rootPolicy;
    const requiredJournalMode = rp.backend.requiredJournalMode;
    const requiredSynchronous = rp.backend.requiredSynchronous;
    const requiredForeignKeys = rp.backend.requiredForeignKeys;
    const requiredDefensive = rp.backend.requiredDefensive;
    if (rp.backend.walAllowed !== false) {
      return denied({ code: "schema-unsupported", message: "WAL must be disallowed by root policy" });
    }
    // Apply durability pragmas.
    this.db.exec(`PRAGMA journal_mode = ${requiredJournalMode.toUpperCase()}`);
    this.db.exec(`PRAGMA synchronous = ${requiredSynchronous.toUpperCase()}`);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA temp_store = MEMORY");

    // Capability probe: read back the durability settings.
    const journalRow = this.db.prepare("PRAGMA journal_mode").get() as Row | undefined;
    const syncRow = this.db.prepare("PRAGMA synchronous").get() as Row | undefined;
    const fkRow = this.db.prepare("PRAGMA foreign_keys").get() as Row | undefined;
    const journalMode = journalRow === undefined ? "" : String(journalRow.journal_mode);
    const synchronousRaw = syncRow === undefined ? "" : String(syncRow.synchronous);
    const foreignKeys = fkRow === undefined ? false : Number(fkRow.foreign_keys) === 1;
    const synchronous = synchronousRaw === "3" ? "extra" : (synchronousRaw.toLowerCase() as "extra" | string);
    if (journalMode !== requiredJournalMode) {
      return denied({ code: "schema-unsupported", message: `journal_mode readback ${journalMode} != ${requiredJournalMode}` });
    }
    if (synchronous !== requiredSynchronous) {
      return denied({ code: "schema-unsupported", message: `synchronous readback ${synchronousRaw} != ${requiredSynchronous}` });
    }
    if (foreignKeys !== requiredForeignKeys) {
      return denied({ code: "schema-unsupported", message: "foreign_keys readback off" });
    }

    // Defensive behavior probe.
    const defensiveVerified = probeBackendDefensive(this.db, this.probeDbFactory);
    if (requiredDefensive && !defensiveVerified) {
      return denied({ code: "backend-corrupt", message: "defensive behavior probe failed: dangerous schema write succeeded" });
    }

    // SQLite version + source identity.
    const versionRow = this.db.prepare("SELECT sqlite_version() AS v").get() as Row | undefined;
    const sqliteVersion = versionRow === undefined ? "" : String(versionRow.v);
    const compileOptions = (this.db.prepare("PRAGMA compile_options").all() as Row[])
      .map((r) => String(r.compile_options))
      .join("\n");
    const sqliteSourceIdentity = sha256(compileOptions);

    // Create schema (idempotent).
    this.db.exec(SCHEMA_DDL);

    // Bind or verify the genesis record.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const meta = this.db.prepare("SELECT genesis_record_identity FROM authority_meta WHERE singleton = 1").get() as Row | undefined;
      if (meta === undefined) {
        this.db.prepare(
          "INSERT INTO authority_meta (singleton, schema_version, sqlite_version, sqlite_source_identity, genesis_record_identity, created_wall_iso, upgraded_wall_iso) VALUES (1, ?, ?, ?, ?, ?, ?)",
        ).run(
          MWA_BACKEND_SCHEMA_VERSION,
          sqliteVersion,
          sqliteSourceIdentity,
          this.genesisIdentity,
          nowWallIso(),
          nowWallIso(),
        );
      } else if (String(meta.genesis_record_identity) !== this.genesisIdentity) {
        throw new SecurityError("genesis record identity mismatch on reopen", "backend_corrupt");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      return denied(backendErrorFrom(error, "backend-corrupt"));
    }

    // Prepare reusable statements.
    this.stmtLeaseById = this.db.prepare("SELECT * FROM leases WHERE lease_id = ?");
    this.stmtReservationsByLease = this.db.prepare("SELECT resource_id, access FROM resource_reservations WHERE lease_id = ? ORDER BY reservation_ordinal");
    this.stmtJournalLast = this.db.prepare("SELECT entry_identity FROM journal ORDER BY sequence DESC LIMIT 1");
    this.stmtIdempotencyGet = this.db.prepare("SELECT request_identity, lease_id, outcome, error_code FROM idempotency_keys WHERE idempotency_key = ?");
    this.stmtIdempotencyPut = this.db.prepare(
      "INSERT OR REPLACE INTO idempotency_keys (idempotency_key, request_identity, lease_id, outcome, error_code, created_monotonic_ns) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.stmtReservationByResource = this.db.prepare("SELECT lease_id, access FROM resource_reservations WHERE resource_id = ?");
    this.stmtFenceGet = this.db.prepare("SELECT fence_identity, expected_state_identity, intended_state_identity FROM pending_fences WHERE lease_id = ? AND effect_id = ?");

    const facts: BackendOpenFacts = deepFreeze({
      schemaVersion: MWA_BACKEND_SCHEMA_VERSION,
      sqliteVersion,
      sqliteSourceIdentity,
      journalMode: requiredJournalMode,
      synchronous: requiredSynchronous,
      foreignKeys: true,
      defensiveVerified,
      platform: process.platform,
    });
    return deepFreeze({ outcome: "accepted", facts });
  }

  close(): void {
    bestEffort(() => this.db.close());
  }

  // ----- idempotency -----

  private checkIdempotency(idempotencyKey: string, requestIdentity: string): Readonly<{ replay: boolean; leaseId: string | null; outcome: "accepted" | "denied"; errorCode: string | null }> | undefined {
    const row = this.stmtIdempotencyGet!.get(idempotencyKey) as Row | undefined;
    if (row === undefined) return undefined;
    const storedRequest = String(row.request_identity);
    if (storedRequest !== requestIdentity) {
      throw new InputError("idempotency key reused with a different request", "idempotency-conflict");
    }
    return {
      replay: true,
      leaseId: row.lease_id === null ? null : String(row.lease_id),
      outcome: String(row.outcome) as "accepted" | "denied",
      errorCode: row.error_code === null ? null : String(row.error_code),
    };
  }

  private recordIdempotency(idempotencyKey: string, requestIdentity: string, leaseId: string | null, outcome: "accepted" | "denied", errorCode: string | null): void {
    this.stmtIdempotencyPut!.run(idempotencyKey, requestIdentity, leaseId, outcome, errorCode, nowMonotonicNs());
  }

  private journalTip(): string {
    const row = this.stmtJournalLast!.get() as Row | undefined;
    return row === undefined ? ZERO_CHAIN_HASH : String(row.entry_identity);
  }

  private appendJournal(entry: Readonly<{
    previousEntryIdentity: string | null;
    repositoryIdentity: string;
    leaseId: string;
    generation: string;
    transition: LeaseTransition;
    requestIdentity: string;
    effectIdentity: string | null;
    observedStateIdentity: string | null;
  }>): string {
    const envelope = deepFreeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION,
      messageKind: "journal-entry",
      previousEntryIdentity: "",
      repositoryIdentity: entry.repositoryIdentity,
      leaseId: entry.leaseId,
      generation: entry.generation,
      transition: entry.transition,
      requestIdentity: entry.requestIdentity,
      effectIdentity: entry.effectIdentity,
      observedStateIdentity: entry.observedStateIdentity,
      receiptAuthority: MWA_RECEIPT_AUTHORITY,
    });
    const previousHash = entry.previousEntryIdentity === null ? ZERO_CHAIN_HASH : entry.previousEntryIdentity;
    const entryIdentity = computeChainHash(MWA_LEDGER_DOMAIN, previousHash, envelope);
    this.db.prepare(
      "INSERT INTO journal (previous_entry_identity, entry_identity, repository_identity, lease_id, generation, transition, request_identity, effect_identity, observed_state_identity, created_monotonic_ns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      entry.previousEntryIdentity,
      entryIdentity,
      entry.repositoryIdentity,
      entry.leaseId,
      entry.generation,
      entry.transition,
      entry.requestIdentity,
      entry.effectIdentity,
      entry.observedStateIdentity,
      nowMonotonicNs(),
    );
    return entryIdentity;
  }

  // ----- grant validation -----

  private validateGrant(grant: LiveGrant, leaseRow: Row, repositoryIdentity: string): void {
    if (!isLiveGrant(grant)) {
      throw new InputError("live grant is invalid", "grant-invalid");
    }
    if (grant.leaseId !== String(leaseRow.lease_id)) {
      throw new InputError("grant leaseId does not match lease", "grant-invalid");
    }
    if (grant.generation !== String(leaseRow.generation)) {
      throw new InputError("grant generation is stale", "generation-stale");
    }
    if (grant.fenceIdentity !== String(leaseRow.fence_identity)) {
      throw new InputError("grant fenceIdentity does not match lease", "grant-invalid");
    }
    if (grant.repositoryIdentity !== repositoryIdentity) {
      throw new InputError("grant repositoryIdentity does not match request", "repository-mismatch");
    }
    if (grant.repositoryIdentity !== String(leaseRow.repository_identity)) {
      throw new InputError("grant repositoryIdentity does not match lease", "repository-mismatch");
    }
    if (grant.processIdentity !== String(leaseRow.process_identity)) {
      throw new InputError("grant processIdentity does not match lease", "process-identity-ambiguous");
    }
  }

  private getLeaseRow(leaseId: string): Row {
    const row = this.stmtLeaseById!.get(leaseId) as Row | undefined;
    if (row === undefined) {
      throw new InputError("lease not found", "lease-missing");
    }
    return row;
  }

  // ----- repository binding -----

  private ensureRepositoryBinding(repository: Readonly<{ repositoryIdentity: string; commonDirectoryIdentity: string; objectStoreIdentity: string; objectFormat: "sha1" | "sha256" }>): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO repository_bindings (repository_identity, common_directory_identity, object_store_identity, object_format) VALUES (?, ?, ?, ?)",
    ).run(repository.repositoryIdentity, repository.commonDirectoryIdentity, repository.objectStoreIdentity, repository.objectFormat);
    const row = this.db.prepare("SELECT * FROM repository_bindings WHERE repository_identity = ?").get(repository.repositoryIdentity) as Row;
    if (String(row.common_directory_identity) !== repository.commonDirectoryIdentity
      || String(row.object_store_identity) !== repository.objectStoreIdentity
      || String(row.object_format) !== repository.objectFormat) {
      throw new InputError("repository binding drift", "repository-mismatch");
    }
  }

  // ----- conflict check -----

  private checkResourceConflicts(leaseId: string, resources: readonly MigrationResource[], excludeOwnLease: boolean): void {
    for (const resource of resources) {
      if (excludeOwnLease) {
        // For reserve: check against all OTHER leases' reservations.
        const rows = this.db.prepare(
          "SELECT lease_id, access FROM resource_reservations WHERE resource_id = ? AND lease_id != ?",
        ).all(resource.resourceId, leaseId) as Row[];
        for (const row of rows) {
          const otherAccess = String(row.access) as "read" | "write";
          if (resource.access === "write" || otherAccess === "write") {
            throw new InputError(`resource ${resource.resourceId} conflicts with lease ${String(row.lease_id)}`, "resource-conflict");
          }
        }
      } else {
        // For acquire: rely on the resource_write_unique index + explicit read/write check.
        const existing = this.stmtReservationByResource!.get(resource.resourceId) as Row | undefined;
        if (existing !== undefined) {
          const otherAccess = String(existing.access) as "read" | "write";
          if (resource.access === "write" || otherAccess === "write") {
            throw new InputError(`resource ${resource.resourceId} conflicts with lease ${String(existing.lease_id)}`, "resource-conflict");
          }
        }
      }
      // Cross-lease natural-key conflict detection (Tranche 4 hostile-matrix
      // root-cause fix). The per-resourceId check above only catches same-id
      // conflicts. Two leases can contend on the same physical path via
      // ancestor/descendant directories, the same semantic owner via ancestor
      // edges, the same git-ref family, or the same package surface — all with
      // DIFFERENT resourceIds. Reuse the pure `migrationResourcesConflict`
      // predicate against every existing reservation's stored resource JSON.
      // This is the same conflict logic the authority runs intra-set; the
      // backend now enforces it cross-lease inside the same `BEGIN IMMEDIATE`
      // transaction that grants the reservation (MWA-DESIGN §4.7).
      const crossRows = excludeOwnLease
        ? (this.db.prepare("SELECT resource_json FROM resource_reservations WHERE lease_id != ?").all(leaseId) as Row[])
        : (this.db.prepare("SELECT resource_json FROM resource_reservations").all() as Row[]);
      for (const row of crossRows) {
        const other = JSON.parse(String(row.resource_json)) as MigrationResource;
        if (migrationResourcesConflict(resource, other) === "conflict") {
          throw new InputError(`resource ${resource.resourceId} conflicts with existing reservation ${other.resourceId}`, "resource-conflict");
        }
      }
    }
  }

  // ----- acquire -----

  acquire(input: AcquireInput): BackendAcquireResult {
    const requestIdentity = computeRequestIdentity(input as Readonly<Record<string, unknown>>);
    return this.runInTransaction(() => {
      const replay = this.checkIdempotency(input.idempotencyKey, requestIdentity);
      if (replay !== undefined) {
        return this.replayAcquire(replay);
      }
      // Validate repository binding.
      this.ensureRepositoryBinding(input.repository);
      // Validate resources against ceilings.
      if (input.resources.length > this.rootPolicy.limits.maxResourcesPerLease) {
        throw new InputError("resource count exceeds ceiling", "resource-order-invalid");
      }
      // Check conflicts (acquire: excludeOwnLease=false, the lease doesn't exist yet).
      const leaseId = generateId("mwa-lease");
      this.checkResourceConflicts(leaseId, input.resources, false);
      // Increment fencing generation. `fencing_sequence.next_generation` is the
      // next generation to assign (starts at 1; genesis generation is 0).
      const genRow = this.db.prepare("SELECT next_generation FROM fencing_sequence WHERE singleton = 1").get() as Row;
      const generation = String(genRow.next_generation);
      if (BigInt(generation) > BigInt(this.rootPolicy.limits.maxFencingGeneration)) {
        throw new SecurityError("fencing generation exhausted", "generation-stale");
      }
      const nextGeneration = (BigInt(generation) + 1n).toString(10);
      this.db.prepare("UPDATE fencing_sequence SET next_generation = ? WHERE singleton = 1").run(nextGeneration);
      const fenceIdentity = computeFenceIdentity(leaseId, generation, input.repository.repositoryIdentity, input.resourceRegistryIdentity);
      // Validate clock: monotonic must not be negative.
      if (BigInt(input.clock.monotonicNanoseconds) < 0n) {
        throw new InputError("clock monotonic is negative", "clock-regression");
      }
      // Insert lease.
      const journalCursor = ZERO_CHAIN_HASH;
      this.db.prepare(
        `INSERT INTO leases (
          lease_id, generation, fence_identity, state, actor_json, base_json, plan_identity,
          repository_identity, common_directory_identity, resource_registry_identity,
          requested_ttl_ms, acquired_monotonic_ns, acquired_wall_iso,
          last_heartbeat_monotonic_ns, last_heartbeat_wall_iso, process_identity, journal_cursor
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        leaseId, generation, fenceIdentity,
        JSON.stringify(input.actor),
        JSON.stringify(input.base),
        input.planIdentity,
        input.repository.repositoryIdentity,
        input.repository.commonDirectoryIdentity,
        input.resourceRegistryIdentity,
        input.requestedTtlMs,
        input.clock.monotonicNanoseconds,
        input.clock.wallClockIso,
        input.clock.monotonicNanoseconds,
        input.clock.wallClockIso,
        input.clock.processIdentity.executableIdentity,
        journalCursor,
      );
      // Insert reservations.
      let ordinal = 0;
      for (const resource of input.resources) {
        this.db.prepare(
          "INSERT INTO resource_reservations (resource_id, lease_id, access, reservation_ordinal, reserved_monotonic_ns, resource_json) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(resource.resourceId, leaseId, resource.access, ordinal, nowMonotonicNs(), JSON.stringify(resource));
        ordinal += 1;
      }
      // Append genesis journal entry.
      const tip = this.journalTip();
      const entryIdentity = this.appendJournal({
        previousEntryIdentity: tip === ZERO_CHAIN_HASH ? null : tip,
        repositoryIdentity: input.repository.repositoryIdentity,
        leaseId,
        generation: generation,
        transition: "requested-active",
        requestIdentity,
        effectIdentity: null,
        observedStateIdentity: null,
      });
      this.db.prepare("UPDATE leases SET journal_cursor = ? WHERE lease_id = ?").run(entryIdentity, leaseId);
      // Record idempotency.
      this.recordIdempotency(input.idempotencyKey, requestIdentity, leaseId, "accepted", null);
      const leaseRow = this.getLeaseRow(leaseId);
      const leaseEvidence = makeLeaseEvidence(leaseRow);
      const grant = createLiveGrant({
        leaseId,
        generation: generation,
        fenceIdentity,
        repositoryIdentity: input.repository.repositoryIdentity,
        resourceRegistryIdentity: input.resourceRegistryIdentity,
        processIdentity: input.clock.processIdentity.executableIdentity,
      });
      return deepFreeze({ outcome: "accepted", liveGrant: grant, leaseEvidence, journalCursor: entryIdentity }) as BackendAcquireResult;
    }, requestIdentity, input.idempotencyKey) as BackendAcquireResult;
  }

  private replayAcquire(replay: Readonly<{ leaseId: string | null; outcome: "accepted" | "denied"; errorCode: string | null }>): BackendAcquireResult {
    if (replay.outcome === "denied") {
      return denied({ code: (replay.errorCode ?? "backend-corrupt") as BackendError["code"], message: "prior acquire was denied" });
    }
    if (replay.leaseId === null) {
      return denied({ code: "backend-corrupt", message: "idempotent acquire has no lease" });
    }
    const leaseRow = this.getLeaseRow(replay.leaseId);
    const leaseEvidence = makeLeaseEvidence(leaseRow);
    const grant = createLiveGrant({
      leaseId: String(leaseRow.lease_id),
      generation: String(leaseRow.generation),
      fenceIdentity: String(leaseRow.fence_identity),
      repositoryIdentity: String(leaseRow.repository_identity),
      resourceRegistryIdentity: String(leaseRow.resource_registry_identity),
      processIdentity: String(leaseRow.process_identity),
    });
    return deepFreeze({ outcome: "accepted", liveGrant: grant, leaseEvidence, journalCursor: String(leaseRow.journal_cursor) });
  }

  // ----- reserve -----

  reserve(input: ReserveInput): BackendResult {
    const requestIdentity = computeRequestIdentity(input as Readonly<Record<string, unknown>>);
    return this.runInTransaction(() => {
      const replay = this.checkIdempotency(input.idempotencyKey, requestIdentity);
      if (replay !== undefined) {
        return this.replaySimple(replay);
      }
      const leaseRow = this.getLeaseRow(input.leaseEvidence.leaseId);
      this.validateGrant(input.liveGrant, leaseRow, input.repository.repositoryIdentity);
      if (String(leaseRow.state) !== "active") {
        throw new InputError("lease is not active", "lease-state-invalid");
      }
      if (input.completeResourceUnion.length > this.rootPolicy.limits.maxResourcesPerLease) {
        throw new InputError("resource count exceeds ceiling", "resource-order-invalid");
      }
      // Check conflicts against OTHER leases (excludeOwnLease=true).
      this.checkResourceConflicts(input.leaseEvidence.leaseId, input.completeResourceUnion, true);
      // Insert only NEW reservations (never drops). Roll back the whole
      // addition on any conflict (partialReservationRetained=false).
      let ordinal = this.db.prepare("SELECT COUNT(*) AS c FROM resource_reservations WHERE lease_id = ?").get(input.leaseEvidence.leaseId) as { c: number | bigint };
      let nextOrdinal = Number(ordinal.c);
      for (const resource of input.completeResourceUnion) {
        const exists = this.db.prepare("SELECT 1 FROM resource_reservations WHERE resource_id = ? AND lease_id = ?").get(resource.resourceId, input.leaseEvidence.leaseId);
        if (exists !== undefined) continue;
        this.db.prepare(
          "INSERT INTO resource_reservations (resource_id, lease_id, access, reservation_ordinal, reserved_monotonic_ns, resource_json) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(resource.resourceId, input.leaseEvidence.leaseId, resource.access, nextOrdinal, nowMonotonicNs(), JSON.stringify(resource));
        nextOrdinal += 1;
      }
      this.recordIdempotency(input.idempotencyKey, requestIdentity, input.leaseEvidence.leaseId, "accepted", null);
      const leaseEvidence = makeLeaseEvidence(leaseRow);
      return acceptedResult(leaseEvidence, String(leaseRow.journal_cursor));
    }, requestIdentity, input.idempotencyKey) as BackendResult;
  }

  // ----- heartbeat -----

  heartbeat(input: HeartbeatInput): BackendResult {
    const requestIdentity = computeRequestIdentity(input as Readonly<Record<string, unknown>>);
    return this.runInTransaction(() => {
      const replay = this.checkIdempotency(input.idempotencyKey, requestIdentity);
      if (replay !== undefined) {
        return this.replaySimple(replay);
      }
      const leaseRow = this.getLeaseRow(input.leaseEvidence.leaseId);
      this.validateGrant(input.liveGrant, leaseRow, input.repository.repositoryIdentity);
      const state = String(leaseRow.state);
      if (state !== "active") {
        throw new InputError("lease is not active", "lease-state-invalid");
      }
      // Clock regression: monotonic must not move backward.
      const lastMonotonic = BigInt(String(leaseRow.last_heartbeat_monotonic_ns));
      const newMonotonic = BigInt(input.clock.monotonicNanoseconds);
      if (newMonotonic < lastMonotonic) {
        throw new InputError("clock monotonic regressed", "clock-regression");
      }
      if (input.requestedTtlMs > this.rootPolicy.limits.maxLeaseTtlMs) {
        throw new InputError("requested TTL exceeds ceiling", "resource-order-invalid");
      }
      this.db.prepare(
        "UPDATE leases SET last_heartbeat_monotonic_ns = ?, last_heartbeat_wall_iso = ?, requested_ttl_ms = ? WHERE lease_id = ?",
      ).run(input.clock.monotonicNanoseconds, input.clock.wallClockIso, input.requestedTtlMs, input.leaseEvidence.leaseId);
      this.recordIdempotency(input.idempotencyKey, requestIdentity, input.leaseEvidence.leaseId, "accepted", null);
      const leaseEvidence = makeLeaseEvidence(leaseRow);
      return acceptedResult(leaseEvidence, String(leaseRow.journal_cursor));
    }, requestIdentity, input.idempotencyKey) as BackendResult;
  }

  // ----- checkpoint -----

  checkpoint(input: CheckpointInput): BackendResult {
    const requestIdentity = computeRequestIdentity(input as Readonly<Record<string, unknown>>);
    return this.runInTransaction(() => {
      const replay = this.checkIdempotency(input.idempotencyKey, requestIdentity);
      if (replay !== undefined) {
        return this.replaySimple(replay);
      }
      const leaseRow = this.getLeaseRow(input.leaseEvidence.leaseId);
      this.validateGrant(input.liveGrant, leaseRow, input.repository.repositoryIdentity);
      const state = String(leaseRow.state);
      if (state !== "active" && state !== "quiescing" && state !== "reconciling") {
        throw new InputError("lease state does not allow checkpoint", "lease-state-invalid");
      }
      if (String(leaseRow.journal_cursor) !== input.journalCursor) {
        throw new InputError("journal cursor mismatch", "journal-mismatch");
      }
      const checkpointId = generateId("mwa-checkpoint");
      this.db.prepare(
        "INSERT INTO checkpoints (checkpoint_id, lease_id, completed_effect_identities_json, remaining_write_resource_ids_json, next_safe_action, journal_cursor, created_monotonic_ns) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        checkpointId,
        input.leaseEvidence.leaseId,
        JSON.stringify(input.completedEffectIdentities),
        JSON.stringify(input.remainingWriteResourceIds),
        input.nextSafeAction,
        input.journalCursor,
        nowMonotonicNs(),
      );
      this.recordIdempotency(input.idempotencyKey, requestIdentity, input.leaseEvidence.leaseId, "accepted", null);
      const leaseEvidence = makeLeaseEvidence(leaseRow);
      return acceptedResult(leaseEvidence, String(leaseRow.journal_cursor));
    }, requestIdentity, input.idempotencyKey) as BackendResult;
  }

  // ----- fence -----

  fence(input: FenceInput): BackendFenceResult {
    const requestIdentity = computeRequestIdentity(input as Readonly<Record<string, unknown>>);
    return this.runInTransaction(() => {
      const replay = this.checkIdempotency(input.idempotencyKey, requestIdentity);
      if (replay !== undefined) {
        if (replay.outcome === "denied") {
          return denied({ code: (replay.errorCode ?? "backend-corrupt") as BackendError["code"], message: "prior fence was denied" }) as BackendFenceResult;
        }
        return this.replayFence(replay, input) as BackendFenceResult;
      }
      const leaseRow = this.getLeaseRow(input.leaseEvidence.leaseId);
      this.validateGrant(input.liveGrant, leaseRow, input.repository.repositoryIdentity);
      if (String(leaseRow.state) !== "active") {
        throw new InputError("lease is not active", "lease-state-invalid");
      }
      if (String(leaseRow.journal_cursor) !== input.journalCursor) {
        throw new InputError("journal cursor mismatch", "journal-mismatch");
      }
      // Validate base matches the lease's recorded base.
      const leaseBase = JSON.parse(String(leaseRow.base_json)) as Record<string, unknown>;
      if (canonicalHash(leaseBase) !== canonicalHash(input.base)) {
        throw new InputError("base drift", "base-drift");
      }
      // Validate the resource is owned by this lease.
      const owned = this.db.prepare("SELECT 1 FROM resource_reservations WHERE resource_id = ? AND lease_id = ?").get(input.resourceId, input.leaseEvidence.leaseId);
      if (owned === undefined) {
        throw new InputError("resource not owned by lease", "resource-unresolved");
      }
      const expectedId = canonicalHash(input.expectedState);
      const intendedId = canonicalHash(input.intendedState);
      // Record the pending fence (durable, crash-safe).
      this.db.prepare(
        "INSERT OR REPLACE INTO pending_fences (lease_id, effect_id, fence_identity, resource_id, expected_state_identity, intended_state_identity, granted_monotonic_ns) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        input.leaseEvidence.leaseId,
        input.effectId,
        input.liveGrant.fenceIdentity,
        input.resourceId,
        expectedId,
        intendedId,
        nowMonotonicNs(),
      );
      this.recordIdempotency(input.idempotencyKey, requestIdentity, input.leaseEvidence.leaseId, "accepted", null);
      const leaseEvidence = makeLeaseEvidence(leaseRow);
      const fenceToken = deepFreeze({
        leaseId: input.leaseEvidence.leaseId,
        effectId: input.effectId,
        generation: String(leaseRow.generation),
        fenceIdentity: String(leaseRow.fence_identity),
      });
      return deepFreeze({ outcome: "accepted", fenceToken, leaseEvidence, journalCursor: String(leaseRow.journal_cursor) }) as BackendFenceResult;
    }, requestIdentity, input.idempotencyKey) as BackendFenceResult;
  }

  private replayFence(replay: Readonly<{ leaseId: string | null; outcome: "accepted" | "denied" }>, input: FenceInput): BackendFenceResult {
    if (replay.leaseId === null) {
      return denied({ code: "backend-corrupt", message: "idempotent fence has no lease" }) as BackendFenceResult;
    }
    const leaseRow = this.getLeaseRow(replay.leaseId);
    const leaseEvidence = makeLeaseEvidence(leaseRow);
    const fenceToken = deepFreeze({
      leaseId: replay.leaseId,
      effectId: input.effectId,
      generation: String(leaseRow.generation),
      fenceIdentity: String(leaseRow.fence_identity),
    });
    return deepFreeze({ outcome: "accepted", fenceToken, leaseEvidence, journalCursor: String(leaseRow.journal_cursor) }) as BackendFenceResult;
  }

  // ----- compareAndCommit -----

  compareAndCommit(input: CompareAndCommitInput): BackendResult {
    const requestIdentity = computeRequestIdentity(input as Readonly<Record<string, unknown>>);
    return this.runInTransaction(() => {
      const replay = this.checkIdempotency(input.idempotencyKey, requestIdentity);
      if (replay !== undefined) {
        return this.replaySimple(replay);
      }
      const leaseRow = this.getLeaseRow(input.leaseEvidence.leaseId);
      this.validateGrant(input.liveGrant, leaseRow, input.repository.repositoryIdentity);
      if (String(leaseRow.state) !== "active") {
        throw new InputError("lease is not active", "lease-state-invalid");
      }
      // Find the pending fence for this effect.
      const fenceRow = this.stmtFenceGet!.get(input.leaseEvidence.leaseId, input.effectId) as Row | undefined;
      if (fenceRow === undefined) {
        throw new InputError("no pending fence for effect", "effect-unknown");
      }
      if (String(fenceRow.fence_identity) !== input.fenceIdentity) {
        throw new InputError("fenceIdentity does not match pending fence", "cas-mismatch");
      }
      const expectedId = canonicalHash(input.expectedState);
      if (String(fenceRow.expected_state_identity) !== expectedId) {
        throw new InputError("expectedState does not match fence-time state", "cas-mismatch");
      }
      // CAS: the observed state must equal the intended state (the effect
      // produced exactly what was planned).
      const observedId = canonicalHash(input.observedState);
      const intendedId = canonicalHash(input.intendedState);
      if (observedId !== intendedId) {
        throw new InputError("observed state does not match intended state", "cas-mismatch");
      }
      // Commit: remove the pending fence.
      this.db.prepare("DELETE FROM pending_fences WHERE lease_id = ? AND effect_id = ?").run(input.leaseEvidence.leaseId, input.effectId);
      this.recordIdempotency(input.idempotencyKey, requestIdentity, input.leaseEvidence.leaseId, "accepted", null);
      const leaseEvidence = makeLeaseEvidence(leaseRow);
      return acceptedResult(leaseEvidence, String(leaseRow.journal_cursor));
    }, requestIdentity, input.idempotencyKey) as BackendResult;
  }

  // ----- release -----

  release(input: ReleaseInput): BackendResult {
    const requestIdentity = computeRequestIdentity(input as Readonly<Record<string, unknown>>);
    return this.runInTransaction(() => {
      const replay = this.checkIdempotency(input.idempotencyKey, requestIdentity);
      if (replay !== undefined) {
        return this.replaySimple(replay);
      }
      const leaseRow = this.getLeaseRow(input.leaseEvidence.leaseId);
      this.validateGrant(input.liveGrant, leaseRow, input.repository.repositoryIdentity);
      const state = String(leaseRow.state) as LeaseState;
      if (String(leaseRow.journal_cursor) !== input.journalCursor) {
        throw new InputError("journal cursor mismatch", "journal-mismatch");
      }
      const { transition, toState } = this.resolveReleaseTransition(state, input.disposition);
      this.db.prepare("UPDATE leases SET state = ? WHERE lease_id = ?").run(toState, input.leaseEvidence.leaseId);
      // Append the terminal journal entry.
      const tip = this.journalTip();
      const entryIdentity = this.appendJournal({
        previousEntryIdentity: tip === ZERO_CHAIN_HASH ? null : tip,
        repositoryIdentity: input.repository.repositoryIdentity,
        leaseId: input.leaseEvidence.leaseId,
        generation: String(leaseRow.generation),
        transition,
        requestIdentity,
        effectIdentity: null,
        observedStateIdentity: null,
      });
      this.db.prepare("UPDATE leases SET journal_cursor = ? WHERE lease_id = ?").run(entryIdentity, input.leaseEvidence.leaseId);
      this.recordIdempotency(input.idempotencyKey, requestIdentity, input.leaseEvidence.leaseId, "accepted", null);
      const updatedRow = this.getLeaseRow(input.leaseEvidence.leaseId);
      const leaseEvidence = makeLeaseEvidence(updatedRow);
      return acceptedResult(leaseEvidence, entryIdentity);
    }, requestIdentity, input.idempotencyKey) as BackendResult;
  }

  private resolveReleaseTransition(state: LeaseState, disposition: ReleaseDisposition): { transition: LeaseTransition; toState: LeaseState } {
    if (disposition === "blocked-unknown-effect") {
      if (state === "reconciling") return { transition: "reconciling-blocked-unknown-effect", toState: "blocked-unknown-effect" };
      throw new InputError("blocked-unknown-effect requires reconciling state", "lease-state-invalid");
    }
    if (state === "active") return { transition: "active-released", toState: "released" };
    if (state === "reconciling") return { transition: "reconciling-released", toState: "released" };
    throw new InputError(`cannot release from state ${state}`, "lease-state-invalid");
  }

  // ----- inspect -----

  inspect(input: InspectInput): BackendInspectResult {
    const row = this.stmtLeaseById!.get(input.leaseId) as Row | undefined;
    if (row === undefined) {
      return denied({ code: "lease-missing", message: "lease not found" });
    }
    const reservations = (this.stmtReservationsByLease!.all(input.leaseId) as Row[]).map((r) =>
      deepFreeze({ resourceId: String(r.resource_id), access: String(r.access) as "read" | "write" }),
    );
    const lease = deepFreeze({
      leaseId: String(row.lease_id),
      state: String(row.state) as LeaseState,
      generation: String(row.generation),
      fenceIdentity: String(row.fence_identity),
      repositoryIdentity: String(row.repository_identity),
      resourceRegistryIdentity: String(row.resource_registry_identity),
      planIdentity: String(row.plan_identity),
      acquiredWallIso: String(row.acquired_wall_iso),
      acquiredMonotonicNs: String(row.acquired_monotonic_ns),
      lastHeartbeatWallIso: String(row.last_heartbeat_wall_iso),
      lastHeartbeatMonotonicNs: String(row.last_heartbeat_monotonic_ns),
      requestedTtlMs: Number(row.requested_ttl_ms),
      processIdentity: String(row.process_identity),
      journalCursor: String(row.journal_cursor),
      reservations: Object.freeze(reservations),
    });
    return deepFreeze({ outcome: "accepted", lease, journalCursor: String(row.journal_cursor) });
  }

  // ----- recover -----

  recover(input: RecoverInput): BackendResult {
    const requestIdentity = computeRequestIdentity(input as Readonly<Record<string, unknown>>);
    return this.runInTransaction(() => {
      const replay = this.checkIdempotency(input.idempotencyKey, requestIdentity);
      if (replay !== undefined) {
        return this.replaySimple(replay);
      }
      // The recovery fence must be strictly newer than the current sequence.
      const genRow = this.db.prepare("SELECT next_generation FROM fencing_sequence WHERE singleton = 1").get() as Row;
      const currentNext = BigInt(String(genRow.next_generation));
      const recoveryGen = BigInt(input.recoveryFence.generation);
      if (recoveryGen <= currentNext) {
        throw new InputError("recovery generation is not newer", "generation-stale");
      }
      if (recoveryGen > BigInt(this.rootPolicy.limits.maxFencingGeneration)) {
        throw new SecurityError("recovery generation exceeds ceiling", "generation-stale");
      }
      // The recovery fence must supersede the lease's current fence.
      const leaseRow = this.getLeaseRow(input.leaseEvidence.leaseId);
      // Validate the live grant against the persisted lease row. Recovery is
      // by a new process, but it must present a grant whose processIdentity
      // (executable identity) matches the lease's recorded process identity —
      // otherwise a process that reused the PID but runs a different binary
      // could recover a lease it does not own (process-identity-ambiguous).
      // The recovery fence's strictly-newer generation is the primary
      // authority, but the grant binding (leaseId/generation/fenceIdentity/
      // repository/processIdentity) is still validated inside this
      // transaction. (Tranche 4 hostile-matrix root-cause fix: recover must
      // validateGrant, not just the recovery fence.)
      this.validateGrant(input.liveGrant, leaseRow, input.repository.repositoryIdentity);
      if (input.recoveryFence.supersedesGeneration !== String(leaseRow.generation)) {
        throw new InputError("recovery supersedesGeneration does not match lease", "grant-invalid");
      }
      if (input.recoveryFence.supersedesFenceIdentity !== String(leaseRow.fence_identity)) {
        throw new InputError("recovery supersedesFenceIdentity does not match lease", "grant-invalid");
      }
      const state = String(leaseRow.state) as LeaseState;
      if (state !== "active" && state !== "expired") {
        throw new InputError(`cannot recover lease in state ${state}`, "lease-state-invalid");
      }
      // Transition the old lease to fenced (if active) and bump the generation.
      // An already-expired lease is terminal; recovery only advances the
      // fencing sequence so new acquires get a strictly newer generation.
      let entryIdentity = String(leaseRow.journal_cursor);
      if (state === "active") {
        this.db.prepare("UPDATE leases SET state = 'fenced' WHERE lease_id = ?").run(input.leaseEvidence.leaseId);
        const tip = this.journalTip();
        entryIdentity = this.appendJournal({
          previousEntryIdentity: tip === ZERO_CHAIN_HASH ? null : tip,
          repositoryIdentity: input.repository.repositoryIdentity,
          leaseId: input.leaseEvidence.leaseId,
          generation: input.recoveryFence.generation,
          transition: "active-fenced",
          requestIdentity,
          effectIdentity: null,
          observedStateIdentity: null,
        });
        this.db.prepare("UPDATE leases SET journal_cursor = ? WHERE lease_id = ?").run(entryIdentity, input.leaseEvidence.leaseId);
      }
      this.db.prepare("UPDATE fencing_sequence SET next_generation = ? WHERE singleton = 1").run(input.recoveryFence.generation);
      this.recordIdempotency(input.idempotencyKey, requestIdentity, input.leaseEvidence.leaseId, "accepted", null);
      const updatedRow = this.getLeaseRow(input.leaseEvidence.leaseId);
      const leaseEvidence = makeLeaseEvidence(updatedRow);
      return acceptedResult(leaseEvidence, entryIdentity);
    }, requestIdentity, input.idempotencyKey) as BackendResult;
  }

  // ----- transaction wrapper -----

  private runInTransaction<T extends BackendResult | BackendAcquireResult | BackendFenceResult>(
    body: () => T,
    requestIdentity: string,
    idempotencyKey: string,
  ): T | BackendResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      const backendError = backendErrorFrom(error, "backend-corrupt");
      // Record the denied outcome for idempotency (inside a fresh transaction
      // since the outer one was rolled back).
      try {
        this.db.exec("BEGIN IMMEDIATE");
        this.recordIdempotency(idempotencyKey, requestIdentity, null, "denied", backendError.code);
        this.db.exec("COMMIT");
      } catch {
        bestEffort(() => this.db.exec("ROLLBACK"));
      }
      return denied(backendError) as T;
    }
  }

  private replaySimple(replay: Readonly<{ leaseId: string | null; outcome: "accepted" | "denied"; errorCode: string | null }>): BackendResult {
    if (replay.outcome === "denied") {
      return denied({ code: (replay.errorCode ?? "backend-corrupt") as BackendError["code"], message: "prior request was denied" });
    }
    if (replay.leaseId === null) {
      return denied({ code: "backend-corrupt", message: "idempotent replay has no lease" });
    }
    const leaseRow = this.getLeaseRow(replay.leaseId);
    const leaseEvidence = makeLeaseEvidence(leaseRow);
    return acceptedResult(leaseEvidence, String(leaseRow.journal_cursor));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNodeSqliteMigrationBackend(input: Readonly<{
  dbPath: string;
  rootPolicy: MigrationAuthorityRootPolicy;
  config: MigrationAuthorityConfig;
  genesisRecord: MigrationWriteAuthorityGenesisRecord;
  probeDbFactory?: ProbeDbFactory;
}>): NodeSqliteMigrationBackend {
  return new NodeSqliteMigrationBackend(input);
}

// ---------------------------------------------------------------------------
// Default root-policy view (Tranche 1). Tranche 3 wires this into
// ROOT_POLICY.migrationAuthority; until then this explicit view keeps the
// foundation cascade's ROOT_POLICY_HASH literal stable.
// ---------------------------------------------------------------------------

export const MWA_DEFAULT_ROOT_POLICY: MigrationAuthorityRootPolicy = deepFreeze({
  backend: {
    requiredJournalMode: "delete",
    requiredSynchronous: "extra",
    requiredForeignKeys: true,
    requiredDefensive: true,
    walAllowed: false,
  },
  limits: {
    maxLeaseTtlMs: 600_000,
    maxHeartbeatIntervalMs: 30_000,
    maxResourcesPerLease: 4096,
    maxBusyTimeoutMs: 300_000,
    maxFencingGeneration: "9223372036854775807",
  },
});

export const MWA_DEFAULT_CONFIG: MigrationAuthorityConfig = deepFreeze({
  leaseTtlMs: 600_000,
  heartbeatIntervalMs: 30_000,
  busyTimeoutMs: 30_000,
  checkpointCadenceMs: 10_000,
  recoveryDirectionPreference: "next",
});
