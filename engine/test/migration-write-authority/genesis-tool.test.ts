import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createMigrationWriteAuthorityGenesis } from "../../scripts/tooling/migration-write-authority-genesis.ts";
import { mkTempDir } from "../support/temp-dir.ts";

// Closed environment mirroring ROOT_POLICY.verification.candidateFormat.gitIdentity.
const CLOSED_ENV = Object.freeze({
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ATTR_NOSYSTEM: "1",
  HOME: "/nonexistent/bridlewise-verification-home",
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
  TZ: "UTC",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GIT_AUTHOR_NAME: "Code Harness",
  GIT_AUTHOR_EMAIL: "harness@example.invalid",
  GIT_COMMITTER_NAME: "Code Harness",
  GIT_COMMITTER_EMAIL: "harness@example.invalid",
} as Record<string, string>);

function git(args: readonly string[], cwd: string): void {
  const result = spawnSync("/usr/bin/git", ["-C", cwd, ...args], { env: CLOSED_ENV, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
}

function commitFile(cwd: string, name: string, content: string): void {
  writeFileSync(join(cwd, name), content);
  git(["add", name], cwd);
  git(["commit", "-m", `add ${name}`], cwd);
}

function commonDir(repo: string): string {
  const result = spawnSync("/usr/bin/git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    env: CLOSED_ENV,
    encoding: "utf8",
  });
  if (result.status !== 0 || result.stderr !== "") {
    throw new Error(`could not resolve git common dir: ${result.stderr}`);
  }
  return result.stdout.slice(0, -1);
}

test("genesis-tool: creates the authority root + DB + genesis record on a disposable repo", async () => {
  const repo = mkTempDir("mwa-genesis-");
  try {
    git(["init", "--initial-branch=main", repo], "/");
    commitFile(repo, "a.txt", "a\n");
    const result = await createMigrationWriteAuthorityGenesis({ repositoryLocator: repo });
    assert.equal(result.outcome, "created", `genesis must succeed, got: ${JSON.stringify(result)}`);
    if (result.outcome !== "created") return;
    const cd = commonDir(repo);
    const authorityRoot = join(cd, "bridlewise-migration-authority");
    assert.equal(result.authorityRootPath, authorityRoot);
    assert.ok(existsSync(authorityRoot), "authority root must exist");
    const st = statSync(authorityRoot);
    assert.equal(st.mode & 0o777, 0o700, "authority root must be 0700");
    assert.ok(existsSync(join(authorityRoot, "authority.db")), "authority DB must exist");
    assert.match(result.genesisIdentity, /^[0-9a-f]{64}$/u, "genesis identity must be a sha256");
    assert.ok(result.sqliteVersion.length > 0, "sqlite version must be recorded");
    assert.match(result.sqliteSourceIdentity, /^[0-9a-f]{64}$/u, "sqlite source identity must be a sha256");
    // The genesis record must also be written as an external immutable receipt.
    assert.ok(existsSync(join(authorityRoot, "receipts", "sha256", `${result.receiptCursor}.bin`)), "genesis receipt must exist");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("genesis-tool: refuses to run twice (backend-corrupt) without --force-recovery", async () => {
  const repo = mkTempDir("mwa-genesis-");
  try {
    git(["init", "--initial-branch=main", repo], "/");
    commitFile(repo, "a.txt", "a\n");
    const first = await createMigrationWriteAuthorityGenesis({ repositoryLocator: repo });
    assert.equal(first.outcome, "created");
    const second = await createMigrationWriteAuthorityGenesis({ repositoryLocator: repo });
    assert.equal(second.outcome, "denied", "second genesis without --force-recovery must be denied");
    if (second.outcome !== "denied") return;
    assert.equal(second.error.code, "backend-corrupt", "must fail with backend-corrupt");
    assert.ok(
      second.error.message.includes("--force-recovery"),
      "the message must instruct the operator to use --force-recovery",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("genesis-tool: --force-recovery re-creates the authority DB", async () => {
  const repo = mkTempDir("mwa-genesis-");
  try {
    git(["init", "--initial-branch=main", repo], "/");
    commitFile(repo, "a.txt", "a\n");
    const first = await createMigrationWriteAuthorityGenesis({ repositoryLocator: repo });
    assert.equal(first.outcome, "created");
    const forced = await createMigrationWriteAuthorityGenesis({ repositoryLocator: repo, forceRecovery: true });
    assert.equal(forced.outcome, "created", "force-recovery must re-create the DB");
    if (forced.outcome !== "created") return;
    assert.ok(existsSync(join(forced.authorityRootPath, "authority.db")), "DB must exist after force-recovery");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("genesis-tool: the DB schema is correct (authority_meta + genesis binding)", async () => {
  const repo = mkTempDir("mwa-genesis-");
  try {
    git(["init", "--initial-branch=main", repo], "/");
    commitFile(repo, "a.txt", "a\n");
    const result = await createMigrationWriteAuthorityGenesis({ repositoryLocator: repo });
    assert.equal(result.outcome, "created");
    if (result.outcome !== "created") return;
    // Reopen the DB and verify the authority_meta row binds the genesis identity.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(result.authorityRootPath, "authority.db"));
    try {
      const meta = db.prepare("SELECT genesis_record_identity, schema_version FROM authority_meta WHERE singleton = 1").get() as
        | { genesis_record_identity: string; schema_version: string } | undefined;
      assert.ok(meta !== undefined, "authority_meta must have a row");
      assert.equal(meta!.schema_version, "bridlewise-migration-authority-backend/v1");
      assert.equal(meta!.genesis_record_identity, result.genesisIdentity, "genesis_record_identity must match");
      // The schema tables must exist.
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
        .map((r) => r.name);
      for (const expected of ["authority_meta", "leases", "repository_bindings", "fencing_sequence", "resource_reservations", "journal", "checkpoints", "pending_fences", "idempotency_keys", "schema_migrations"]) {
        assert.ok(tables.includes(expected), `schema must include table ${expected}`);
      }
      // The fencing sequence must start at 1 (genesis generation is 0).
      const fence = db.prepare("SELECT next_generation FROM fencing_sequence WHERE singleton = 1").get() as { next_generation: string };
      assert.equal(fence.next_generation, "1", "fencing_sequence must start at 1");
    } finally {
      db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("genesis-tool: the genesis record matches live repository facts", async () => {
  const repo = mkTempDir("mwa-genesis-");
  try {
    git(["init", "--initial-branch=main", repo], "/");
    commitFile(repo, "a.txt", "a\n");
    const result = await createMigrationWriteAuthorityGenesis({ repositoryLocator: repo });
    assert.equal(result.outcome, "created");
    if (result.outcome !== "created") return;
    // The genesis receipt bytes must round-trip to a record whose
    // schemaVersion/backendSchemaVersion/receiptAuthority are the closed constants.
    const { readFileSync } = await import("node:fs");
    const receiptPath = join(result.authorityRootPath, "receipts", "sha256", `${result.receiptCursor}.bin`);
    const receiptBytes = readFileSync(receiptPath, "utf8").trimEnd();
    const record = JSON.parse(receiptBytes) as Record<string, unknown>;
    assert.equal(record.schemaVersion, "bridlewise-migration-authority-genesis/v1");
    assert.equal(record.backendSchemaVersion, "bridlewise-migration-authority-backend/v1");
    assert.equal(record.receiptAuthority, "evidence-only-not-a-bearer-capability");
    assert.equal(record.creatingAuthorityKind, "foundation-seed-transaction-authority");
    assert.equal(record.initialFenceGeneration, "0");
    assert.equal(record.authorityRootPath, result.authorityRootPath);
    assert.ok(typeof record.repositoryIdentity === "string" && /^[0-9a-f]{64}$/u.test(record.repositoryIdentity as string));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
