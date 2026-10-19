import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resetDebugSystem, getDebugSignals } from "../../src/shared/debug/debug-system.ts";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { sha256, SHA256_HEX_REGEX } from "../../src/kernel/integrity.ts";
import { createImmutableReceiptPort } from "../../verification/core/coordination/migration-write-authority/receipts.ts";
import { mkTempDir, createTempDir } from "../support/temp-dir.ts";

test("receipts: createDurableLocal writes a 0600 content-addressed file and returns the cursor", () => {
  const root = mkTempDir("mwa-receipts-");
  try {
    const port = createImmutableReceiptPort({ authorityRootPath: root });
    const bytes = Buffer.from("hello genesis\n", "utf8");
    const eventHash = sha256(bytes);
    const result = port.createDurableLocal({ eventHash, bytes });
    assert.equal(result.outcome, "accepted");
    if (result.outcome !== "accepted") return;
    assert.match(result.receipt.receiptHash, SHA256_HEX_REGEX);
    assert.equal(result.receipt.cursor, result.receipt.receiptHash);
    const path = join(root, "receipts", "sha256", `${result.receipt.cursor}.bin`);
    assert.ok(existsSync(path), "content-addressed file must exist");
    const st = statSync(path);
    assert.equal(st.mode & 0o777, 0o600, "receipt file must be 0600");
    assert.deepEqual(readFileSync(path), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipts: createDurableLocal is idempotent (already-exists returns identical cursor)", () => {
  const root = mkTempDir("mwa-receipts-");
  try {
    const port = createImmutableReceiptPort({ authorityRootPath: root });
    const bytes = Buffer.from("idempotent\n", "utf8");
    const eventHash = sha256(bytes);
    const first = port.createDurableLocal({ eventHash, bytes });
    assert.equal(first.outcome, "accepted");
    const second = port.createDurableLocal({ eventHash, bytes });
    assert.equal(second.outcome, "accepted");
    if (first.outcome !== "accepted" || second.outcome !== "accepted") return;
    assert.equal(first.receipt.cursor, second.receipt.cursor, "idempotent cursor must match");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipts: createDurableLocal rejects a content-hash mismatch (cas-mismatch)", () => {
  const root = mkTempDir("mwa-receipts-");
  try {
    const port = createImmutableReceiptPort({ authorityRootPath: root });
    const bytes = Buffer.from("mismatch\n", "utf8");
    const wrongHash = sha256(Buffer.from("different\n", "utf8"));
    const result = port.createDurableLocal({ eventHash: wrongHash, bytes });
    assert.equal(result.outcome, "blocked");
    if (result.outcome !== "blocked") return;
    assert.equal(result.error.code, "cas-mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipts: createDurableLocal rejects an invalid eventHash (backend-corrupt)", () => {
  const root = mkTempDir("mwa-receipts-");
  try {
    const port = createImmutableReceiptPort({ authorityRootPath: root });
    const result = port.createDurableLocal({ eventHash: "not-a-sha256", bytes: Buffer.from("x\n") });
    assert.equal(result.outcome, "blocked");
    if (result.outcome !== "blocked") return;
    assert.equal(result.error.code, "backend-corrupt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipts: readHead returns the receipt at the cursor, undefined when missing", () => {
  const root = mkTempDir("mwa-receipts-");
  try {
    const port = createImmutableReceiptPort({ authorityRootPath: root });
    const bytes = Buffer.from("readhead\n", "utf8");
    const eventHash = sha256(bytes);
    const result = port.createDurableLocal({ eventHash, bytes });
    assert.equal(result.outcome, "accepted");
    if (result.outcome !== "accepted") return;
    const head = port.readHead(result.receipt.cursor);
    assert.ok(head !== undefined, "readHead must find the cursor");
    assert.equal(head!.receiptHash, result.receipt.receiptHash);
    assert.equal(head!.cursor, result.receipt.cursor);
    const missing = port.readHead("0".repeat(64));
    assert.equal(missing, undefined, "readHead returns undefined for a missing cursor");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipts: admitRepositoryArtifact writes outside the authority root under the evidence root", () => {
  const root = mkTempDir("mwa-receipts-");
  try {
    const evidenceRoot = createTempDir("mwa-evidence-");
    try {
      const port = createImmutableReceiptPort({ authorityRootPath: root, evidenceRootPath: evidenceRoot });
      const bytes = Buffer.from("artifact\n", "utf8");
      const eventHash = sha256(bytes);
      const result = port.admitRepositoryArtifact({ eventHash, bytes, namespace: "genesis" });
      assert.equal(result.outcome, "accepted");
      if (result.outcome !== "accepted") return;
      const path = join(evidenceRoot, "genesis", "sha256", `${result.receipt.cursor}.bin`);
      assert.ok(existsSync(path), "artifact must be written under the evidence root");
      assert.ok(!existsSync(join(root, "genesis")), "artifact must NOT be under the authority root");
    } finally {
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipts: admitRepositoryArtifact rejects a namespace with path separators", () => {
  const root = mkTempDir("mwa-receipts-");
  try {
    const port = createImmutableReceiptPort({ authorityRootPath: root });
    const result = port.admitRepositoryArtifact({
      eventHash: sha256(Buffer.from("x\n")),
      bytes: Buffer.from("x\n"),
      namespace: "evil/../escape",
    });
    assert.equal(result.outcome, "blocked");
    if (result.outcome !== "blocked") return;
    assert.equal(result.error.code, "backend-corrupt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipts: admitCanonicalLedger returns a typed blocker (never a silent skip)", () => {
  const root = mkTempDir("mwa-receipts-");
  try {
    const port = createImmutableReceiptPort({ authorityRootPath: root });
    const result = port.admitCanonicalLedger({ eventHash: sha256(Buffer.from("x\n")), bytes: Buffer.from("x\n") });
    assert.equal(result.outcome, "blocked", "admitCanonicalLedger must never succeed before S3.2");
    if (result.outcome !== "blocked") return;
    assert.equal(result.error.code, "operation-unsupported");
    assert.ok(
      result.error.message.includes("blocked-canonical-ledger-unavailable"),
      "the typed blocker must name the blocked reason",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const operation of ["statSync", "readFileSync", "writeFileSync"] as const) {
  test(`receipts: failed ${operation} blocks safely without treating it as absent`, () => {
    const root = mkTempDir("mwa-private-");
    const port = createImmutableReceiptPort({ authorityRootPath: root });
    const bytes = Buffer.from("receipt");
    const eventHash = sha256(bytes);
    if (operation === "readFileSync") assert.equal(port.createDurableLocal({ bytes, eventHash }).outcome, "accepted");
    const original = fs[operation];
    const open = fs.openSync;
    const warn = console.warn;
    const diagnostics: unknown[][] = [];
    let opens = 0;
    resetDebugSystem();
    console.warn = (...args: unknown[]) => { diagnostics.push(args); };
    Object.assign(fs, { [operation]: () => { throw Object.assign(new Error("fixture-secret"), { code: "EACCES" }); } });
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { opens++; return open(...args); }) as typeof open;
    syncBuiltinESMExports();
    try {
      const result = port.createDurableLocal({ bytes, eventHash });
      assert.equal(result.outcome, "blocked");
      if (result.outcome !== "blocked") assert.fail("must refuse the failed receipt operation");
      assert.equal(result.error.code, "backend-corrupt");
      assert.equal(result.error.message, operation === "writeFileSync" ? "receipt write failed" : "receipt inspection failed");
      assert.equal(opens, operation === "writeFileSync" ? 1 : 0);
      assert.equal(getDebugSignals().bestEffortFailures, 1);
      assert.equal(diagnostics.length, 1);
      assert.equal(JSON.stringify({ diagnostics, result }).includes("fixture-secret"), false);
    } finally {
      Object.assign(fs, { [operation]: original, openSync: open });
      syncBuiltinESMExports();
      console.warn = warn;
      resetDebugSystem();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("receipts: absent content-addressed file is normal creation without failure diagnostic", () => {
  const root = mkTempDir("mwa-absent-");
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => { warnings++; };
  resetDebugSystem();
  try {
    const bytes = Buffer.from("absent");
    assert.equal(createImmutableReceiptPort({ authorityRootPath: root }).createDurableLocal({ bytes, eventHash: sha256(bytes) }).outcome, "accepted");
    assert.equal(getDebugSignals().bestEffortFailures, 0);
    assert.equal(getDebugSignals().fallbackAttempts, 0);
    assert.equal(warnings, 0, "normal absence must not emit any diagnostic");
  } finally { console.warn = warn; resetDebugSystem(); rmSync(root, { recursive: true, force: true }); }
});
