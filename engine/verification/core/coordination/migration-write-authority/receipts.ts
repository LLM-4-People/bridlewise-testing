/**
 * MigrationWriteAuthority — `ImmutableReceiptPort` adapter.
 *
 * Separates durable local creation, repository-artifact admission, and
 * canonical-ledger admission (MWA-DESIGN §2.9). Content-addressed, append-only,
 * 0600 exclusive. Reuses the exclusive-create + fsync + content-addressed
 * pattern from `engine/src/filesystem/immutable-receipt.ts` (no second receipt
 * writer); the authority root is a 0700 private directory created by the
 * one-shot genesis tool, so the adapter writes content-addressed files beneath
 * it without re-implementing the full descriptor-chain verification.
 *
 * `admitCanonicalLedger` returns a typed `blocked-canonical-ledger-unavailable`
 * blocker — never a silent skip or fake success. The canonical-ledger port is
 * blocked until S3.2 (storage architecture).
 *
 * Design authority: MWA-DESIGN §2.9.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deepFreeze, sha256, SHA256_HEX_REGEX } from "../../../../src/kernel/integrity.ts";
import { bestEffort } from "../../../../src/shared/best-effort.ts";
import { reportBestEffortFailure } from "../../../../src/shared/debug/debug-system.ts";
import {
  type AppendReceipt,
  type BackendError,
  type ImmutableReceiptPort,
  type ReceiptResult,
  type Sha256,
} from "./contracts.ts";

/**
 * Input for the durable-local receipt port. The authority root is the 0700
 * private directory created by the genesis tool (a child of the Git common
 * directory). Receipts are stored content-addressed beneath
 * `<authorityRoot>/receipts/sha256/<digest>`.
 */
export type ImmutableReceiptPortInput = Readonly<{
  authorityRootPath: string;
  /**
   * Root for repository-artifact admission (outside the worktree). Defaults to
   * `<authorityRootPath>/evidence` when not supplied.
   */
  evidenceRootPath?: string;
}>;

const RECEIPTS_NAMESPACE = "receipts";
const SHA256_SUBDIR = "sha256";
const FILE_EXTENSION = ".bin";

function blocked(error: BackendError): ReceiptResult {
  return deepFreeze({ outcome: "blocked" as const, error, partialReservationRetained: false as const });
}

function accepted(receiptHash: Sha256, cursor: Sha256): ReceiptResult {
  const receipt: AppendReceipt = deepFreeze({ receiptHash, cursor });
  return deepFreeze({ outcome: "accepted" as const, receipt });
}

function ensureDirectory(path: string): void {
  bestEffort(() => mkdirSync(path, { recursive: true, mode: 0o700 }));
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  bestEffort(() => {
    const f = openSync(path, "r");
    fsyncSync(f);
    fd = f;
  });
  if (fd !== undefined) {
    const fdClose = fd;
    bestEffort(() => closeSync(fdClose));
  }
}

function writeContentAddressed(
  rootPath: string,
  namespace: string,
  bytes: Uint8Array,
  expectedHash: Sha256,
): ReceiptResult {
  if (!SHA256_HEX_REGEX.test(expectedHash)) {
    return blocked({ code: "backend-corrupt", message: "receipt eventHash is not a sha256" });
  }
  const digest = sha256(bytes);
  if (digest !== expectedHash) {
    return blocked({ code: "cas-mismatch", message: "receipt bytes do not hash to eventHash" });
  }
  const namespaceDir = join(rootPath, namespace, SHA256_SUBDIR);
  ensureDirectory(namespaceDir);
  const targetPath = join(namespaceDir, `${digest}${FILE_EXTENSION}`);
  // Content-addressed: if the file already exists with identical bytes, the
  // receipt is already durable (idempotent admission). Verify identity.
  try {
    const existing = statSync(targetPath);
    if (existing.isFile()) {
      const existingBytes = readFileSync(targetPath);
      if (Buffer.from(existingBytes).equals(Buffer.from(bytes))) {
        return accepted(digest, digest);
      }
      return blocked({ code: "cas-mismatch", message: "content-addressed receipt collision" });
    }
    return blocked({ code: "backend-corrupt", message: "receipt path is not a file" });
  } catch (error) {
    // Missing content is ordinary exclusive-create control flow. Other stat
    // or read failures do not establish absence and must not authorize writes.
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      reportBestEffortFailure();
      return blocked({ code: "backend-corrupt", message: "receipt inspection failed" });
    }
  }
  // Exclusive create with 0600.
  let fd: number | undefined;
  try {
    fd = openSync(targetPath, "wx", 0o600);
    writeFileSync(fd, Buffer.from(bytes));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(namespaceDir);
    return accepted(digest, digest);
  } catch {
    if (fd !== undefined) {
      const fdErr = fd;
      bestEffort(() => closeSync(fdErr));
    }
    reportBestEffortFailure();
    return blocked({ code: "backend-corrupt", message: "receipt write failed" });
  }
}

function readContentAddressed(
  rootPath: string,
  namespace: string,
  cursor: Sha256,
): Readonly<{ receiptHash: Sha256; cursor: Sha256 }> | undefined {
  if (!SHA256_HEX_REGEX.test(cursor)) return undefined;
  const targetPath = join(rootPath, namespace, SHA256_SUBDIR, `${cursor}${FILE_EXTENSION}`);
  try {
    const bytes = readFileSync(targetPath);
    const digest = sha256(bytes);
    if (digest !== cursor) return undefined;
    return deepFreeze({ receiptHash: digest, cursor: digest });
  } catch {
    return undefined;
  }
}

/**
 * Creates an `ImmutableReceiptPort` backed by the given authority root. The
 * authority root must be a 0700 private directory (created by the genesis
 * tool). All durable-local receipts are content-addressed beneath
 * `<authorityRoot>/receipts/sha256/`. Repository-artifact admissions go to the
 * evidence root (outside the worktree).
 */
export function createImmutableReceiptPort(input: ImmutableReceiptPortInput): ImmutableReceiptPort {
  if (typeof input.authorityRootPath !== "string" || input.authorityRootPath.length === 0) {
    throw new Error("authorityRootPath is required");
  }
  const authorityRootPath = input.authorityRootPath;
  const evidenceRootPath = input.evidenceRootPath ?? join(authorityRootPath, "evidence");

  return deepFreeze({
    createDurableLocal(receiptInput: Readonly<{ eventHash: Sha256; bytes: Uint8Array }>): ReceiptResult {
      return writeContentAddressed(authorityRootPath, RECEIPTS_NAMESPACE, receiptInput.bytes, receiptInput.eventHash);
    },
    admitRepositoryArtifact(receiptInput: Readonly<{ eventHash: Sha256; bytes: Uint8Array; namespace: string }>): ReceiptResult {
      const namespace = receiptInput.namespace;
      if (typeof namespace !== "string" || namespace.length === 0 || /[/\\]/u.test(namespace)) {
        return blocked({ code: "backend-corrupt", message: "receipt namespace is invalid" });
      }
      return writeContentAddressed(evidenceRootPath, namespace, receiptInput.bytes, receiptInput.eventHash);
    },
    admitCanonicalLedger(_receiptInput: Readonly<{ eventHash: Sha256; bytes: Uint8Array }>): ReceiptResult {
      // The canonical-ledger port is blocked until S3.2 (storage architecture).
      // This is a typed blocker, never a silent skip or fake success.
      return blocked({ code: "operation-unsupported", message: "blocked-canonical-ledger-unavailable" });
    },
    readHead(cursor: Sha256): Readonly<{ receiptHash: Sha256; cursor: Sha256 }> | undefined {
      return readContentAddressed(authorityRootPath, RECEIPTS_NAMESPACE, cursor);
    },
  }) as ImmutableReceiptPort;
}

// Re-export the evidence-root join helper for the genesis tool.
export function defaultEvidenceRootPath(authorityRootPath: string): string {
  return join(authorityRootPath, "evidence");
}

export function receiptPathFor(authorityRootPath: string, namespace: string, digest: Sha256): string {
  return join(authorityRootPath, namespace, SHA256_SUBDIR, `${digest}${FILE_EXTENSION}`);
}
