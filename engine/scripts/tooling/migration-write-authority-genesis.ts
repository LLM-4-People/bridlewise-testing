/**
 * MigrationWriteAuthority — one-shot external genesis tool.
 *
 * MWA cannot create its own genesis: the activation lock cannot hash itself
 * (MWA-DESIGN §5.1), and receipts cannot authenticate themselves. This tool is
 * the single-use, separately-reviewed, elevated external
 * `FoundationSeedTransactionAuthority` that creates the authority root, the
 * initial SQLite DB (schema + pragmas + defensive probe), and the first
 * `MigrationWriteAuthorityGenesisRecord` — written as
 * `authority_meta.genesis_record_identity` AND as an external immutable
 * receipt. It refuses to run twice (unless `--force-recovery`) and exits; all
 * subsequent operations go through MWA with fencing.
 *
 * Usage: `npx tsx scripts/migration-write-authority-genesis.ts <repo-path> [--force-recovery]`
 *
 * Design authority: MWA-DESIGN §5.
 */

import { DatabaseSync } from "node:sqlite";
import { statSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { InputError, safeError } from "../../src/kernel/errors.ts";
import { canonicalHash, canonicalJson, deepFreeze, sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import {
  createMigrationRepositoryFactsAdapter,
  type MigrationRepositoryFactsConfig,
} from "../../verification/core/coordination/migration-write-authority/repository-facts.ts";
import {
  createNodeSqliteMigrationBackend,
  probeBackendDefensive,
  MWA_DEFAULT_CONFIG,
} from "../../verification/core/coordination/migration-write-authority/backend-node-sqlite.ts";
import {
  createImmutableReceiptPort,
} from "../../verification/core/coordination/migration-write-authority/receipts.ts";
import {
  GENESIS_SCHEMA_VERSION,
  createGenesisRecordIdentity,
  type MigrationWriteAuthorityGenesisRecord,
} from "../../verification/core/coordination/migration-write-authority/genesis.ts";
import {
  MWA_BACKEND_SCHEMA_VERSION,
  MWA_RECEIPT_AUTHORITY,
  type MigrationAuthorityConfig,
  type MigrationAuthorityRootPolicy,
} from "../../verification/core/coordination/migration-write-authority/contracts.ts";
import { pathIdentityFromPath } from "../../verification/core/coordination/migration-write-authority/internal.ts";
import { ensurePrivateStateDirectory, PRIVATE_STATE_DIRECTORY_MODE } from "../../src/filesystem/private-state.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { runCpuBoundedSync } from "../../src/process/bounded-run-sync.ts";
import { subprocessBounds } from "../../src/workflow/workflow-config.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTHORITY_ROOT_NAME = ROOT_POLICY.paths.migrationAuthorityRoot.childName;
const DB_FILENAME = "authority.db";
const CREATING_AUTHORITY_KIND = "foundation-seed-transaction-authority" as const;

export type GenesisResult =
  | Readonly<{
      outcome: "created";
      genesisIdentity: string;
      authorityRootPath: string;
      sqliteVersion: string;
      sqliteSourceIdentity: string;
      genesisWallIso: string;
      receiptCursor: string;
    }>
  | Readonly<{ outcome: "denied"; error: Readonly<{ code: string; message: string }> }>;

export type GenesisInput = Readonly<{
  repositoryLocator: string;
  forceRecovery?: boolean;
  /**
   * Override the authority root name (defaults to
   * `ROOT_POLICY.paths.migrationAuthorityRoot.childName`). Used in tests to
   * avoid collisions when running multiple genesis operations in the same
   * common directory.
   */
  authorityRootName?: string;
}>;

function mwaRootPolicyView(): MigrationAuthorityRootPolicy {
  const ma = ROOT_POLICY.migrationAuthority;
  return deepFreeze({
    backend: {
      requiredJournalMode: ma.backend.requiredJournalMode,
      requiredSynchronous: ma.backend.requiredSynchronous,
      requiredForeignKeys: ma.backend.requiredForeignKeys,
      requiredDefensive: ma.backend.requiredDefensive,
      walAllowed: ma.backend.walAllowed,
    },
    limits: {
      maxLeaseTtlMs: ma.limits.maxLeaseTtlMs,
      maxHeartbeatIntervalMs: ma.limits.maxHeartbeatIntervalMs,
      maxResourcesPerLease: ma.limits.maxResourcesPerLease,
      maxBusyTimeoutMs: ma.limits.maxBusyTimeoutMs,
      maxFencingGeneration: ma.limits.maxFencingGeneration,
    },
  });
}

function mwaConfigView(): MigrationAuthorityConfig {
  return MWA_DEFAULT_CONFIG;
}

/**
 * Creates the MWA genesis for the repository at `repositoryLocator`. This is
 * the one-shot external authority (MWA-DESIGN §5.3). Steps:
 *  1. Acquire repository facts (read-only).
 *  2. Create the authority root (0700 private child of the Git common dir).
 *  3. Preliminary DB probe for sqlite version/source + defensive.
 *  4. Build the genesis record.
 *  5. Open the backend (creates schema + binds genesis record in authority_meta).
 *  6. Write the genesis record as an external immutable receipt.
 *  7. Refuse to run twice (unless `forceRecovery`).
 */
export async function createMigrationWriteAuthorityGenesis(input: GenesisInput): Promise<GenesisResult> {
  if (typeof input.repositoryLocator !== "string" || input.repositoryLocator.length === 0) {
    return { outcome: "denied", error: { code: "input_invalid", message: "repositoryLocator is required" } };
  }
  const rootName = input.authorityRootName ?? AUTHORITY_ROOT_NAME;
  const gitId = ROOT_POLICY.verification.candidateFormat.gitIdentity;
  const factsConfig: MigrationRepositoryFactsConfig = {
    executablePath: gitId.executablePath,
    processEnvironment: gitId.processEnvironment,
    configurationOverrides: gitId.configurationOverrides,
  };

  // Step 1: acquire repository facts (read-only).
  let facts;
  try {
    const adapter = createMigrationRepositoryFactsAdapter({
      repositoryLocator: input.repositoryLocator,
      config: factsConfig,
    });
    facts = await adapter.acquire();
  } catch (error) {
    return { outcome: "denied", error: { code: "repository-mismatch", message: safeError(error).message } };
  }

  // The facts adapter returns PathIdentity (stat), not the absolute path. The
  // common-directory absolute path is recovered from the locator + rev-parse.
  // Re-run the single rev-parse --git-common-dir here to get the path string.
  // (The facts adapter validates identity but does not expose the path; this
  // is the minimal read-only re-acquisition the genesis tool needs.)
  // The identity's own executable and CLOSED environment, as one bounded run.
  const commonDirResult = runCpuBoundedSync(gitId.executablePath, ["-C", input.repositoryLocator, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: process.cwd(),
    env: gitId.processEnvironment as Record<string, string>,
    bounds: subprocessBounds({}),
  });
  if (commonDirResult.ending !== "exited" || commonDirResult.status !== 0 || commonDirResult.stderr.length > 0) {
    return { outcome: "denied", error: { code: "repository-mismatch", message: "could not resolve git common dir" } };
  }
  const commonDirPath = commonDirResult.stdout.toString("utf8").slice(0, -1); // strip trailing newline
  if (!commonDirPath || !existsSync(commonDirPath)) {
    return { outcome: "denied", error: { code: "repository-mismatch", message: "git common dir does not exist" } };
  }

  // Step 2: create authority root (0700 private child of the common dir).
  const authorityRootPath = join(commonDirPath, rootName);
  const dbPath = join(authorityRootPath, DB_FILENAME);
  const dbExists = existsSync(dbPath);

  if (dbExists && !input.forceRecovery) {
    return {
      outcome: "denied",
      error: { code: "backend-corrupt", message: `authority DB already exists at ${dbPath}; use --force-recovery to re-create` },
    };
  }
  if (dbExists && input.forceRecovery) {
    try {
      rmSync(dbPath, { force: true });
    } catch (error) {
      return { outcome: "denied", error: { code: "backend-corrupt", message: `force-recovery could not remove existing DB: ${safeError(error).message}` } };
    }
  }

  try {
    ensurePrivateStateDirectory(authorityRootPath);
  } catch (error) {
    return { outcome: "denied", error: { code: "filesystem-unsupported", message: `could not create authority root: ${safeError(error).message}` } };
  }
  // Enforce 0700 mode (mkdir may not apply it if the dir already existed).
  const rootStat = statSync(authorityRootPath);
  if ((rootStat.mode & 0o777) !== PRIVATE_STATE_DIRECTORY_MODE) {
    return { outcome: "denied", error: { code: "filesystem-unsupported", message: "authority root is not 0700" } };
  }
  const authorityRootIdentity = pathIdentityFromPath(authorityRootPath);

  // Step 3: preliminary DB probe (sqlite version + source + defensive).
  let sqliteVersion: string;
  let sqliteSourceIdentity: string;
  let defensiveVerified: boolean;
  try {
    const probeDb = new DatabaseSync(dbPath);
    probeDb.enableDefensive(true);
    defensiveVerified = probeBackendDefensive(probeDb);
    const versionRow = probeDb.prepare("SELECT sqlite_version() AS v").get() as { v: string } | undefined;
    sqliteVersion = versionRow === undefined ? "" : versionRow.v;
    const compileOptions = (probeDb.prepare("PRAGMA compile_options").all() as { compile_options: string }[])
      .map((r) => r.compile_options)
      .join("\n");
    sqliteSourceIdentity = sha256(compileOptions);
    probeDb.close();
  } catch (error) {
    return { outcome: "denied", error: { code: "backend-corrupt", message: `preliminary DB probe failed: ${safeError(error).message}` } };
  }
  if (!defensiveVerified) {
    return { outcome: "denied", error: { code: "backend-corrupt", message: "defensive behavior probe failed" } };
  }

  // Step 4: build the genesis record.
  const genesisWallIso = new Date().toISOString();
  const creatingAuthorityIdentity = sha256([
    CREATING_AUTHORITY_KIND,
    facts.repositoryBinding.repositoryIdentity,
    authorityRootPath,
  ].join("\u0000"));
  const genesisRecord: MigrationWriteAuthorityGenesisRecord = deepFreeze({
    schemaVersion: GENESIS_SCHEMA_VERSION,
    repositoryIdentity: facts.repositoryBinding.repositoryIdentity,
    commonDirectoryIdentity: facts.repositoryBinding.commonDirectoryIdentity,
    objectStoreIdentity: facts.repositoryBinding.objectStoreIdentity,
    objectFormat: facts.repositoryBinding.objectFormat,
    authorityRootPath,
    authorityRootIdentity,
    backendSchemaVersion: MWA_BACKEND_SCHEMA_VERSION,
    initialFenceGeneration: "0",
    sqliteVersion,
    sqliteSourceIdentity,
    genesisWallIso,
    creatingAuthorityIdentity,
    creatingAuthorityKind: CREATING_AUTHORITY_KIND,
    receiptAuthority: MWA_RECEIPT_AUTHORITY,
  });
  const genesisIdentity = createGenesisRecordIdentity(genesisRecord);

  // Step 5: open the backend (creates schema + binds genesis in authority_meta).
  const rootPolicyView = mwaRootPolicyView();
  const configView = mwaConfigView();
  try {
    const backend = createNodeSqliteMigrationBackend({
      dbPath,
      rootPolicy: rootPolicyView,
      config: configView,
      genesisRecord,
    });
    const openResult = backend.open();
    if (openResult.outcome === "denied") {
      return { outcome: "denied", error: { code: openResult.error.code, message: openResult.error.message } };
    }
    backend.close();
  } catch (error) {
    if (error instanceof InputError) {
      return { outcome: "denied", error: { code: error.code, message: error.message } };
    }
    return { outcome: "denied", error: { code: "backend-corrupt", message: safeError(error).message } };
  }

  // Step 6: write the genesis record as an external immutable receipt.
  const receipts = createImmutableReceiptPort({ authorityRootPath });
  const genesisBytes = Buffer.from(`${canonicalJson(genesisRecord)}\n`, "utf8");
  const genesisEventHash = sha256(genesisBytes);
  const receiptResult = receipts.createDurableLocal({ eventHash: genesisEventHash, bytes: genesisBytes });
  if (receiptResult.outcome !== "accepted") {
    return { outcome: "denied", error: { code: receiptResult.error.code, message: receiptResult.error.message } };
  }

  return {
    outcome: "created",
    genesisIdentity,
    authorityRootPath,
    sqliteVersion,
    sqliteSourceIdentity,
    genesisWallIso,
    receiptCursor: receiptResult.receipt.cursor,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function runCli(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write("Usage: npx tsx scripts/migration-write-authority-genesis.ts <repo-path> [--force-recovery]\n");
    return 2;
  }
  const forceRecovery = args.includes("--force-recovery");
  const repositoryLocator = args.find((a) => !a.startsWith("-"));
  if (!repositoryLocator) {
    process.stderr.write("error: repository path is required\n");
    return 2;
  }
  const result = await createMigrationWriteAuthorityGenesis({ repositoryLocator, forceRecovery });
  if (result.outcome === "created") {
    process.stdout.write(`${canonicalJson(result)}\n`);
    return 0;
  }
  process.stderr.write(`genesis failed: ${result.error.code}: ${result.error.message}\n`);
  return 1;
}

// Run only when invoked directly as a script.
if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  // The exit code is set and the loop drains: `process.exit()` can deadlock at shutdown (Node #54918, #351).
  runCli().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`genesis crashed: ${safeError(error).message}\n`);
    process.exitCode = 1;
  });
}

// Re-exports for programmatic use and tests.
export { createImmutableReceiptPort, createGenesisRecordIdentity, GENESIS_SCHEMA_VERSION };
export { canonicalHash, canonicalJson };
