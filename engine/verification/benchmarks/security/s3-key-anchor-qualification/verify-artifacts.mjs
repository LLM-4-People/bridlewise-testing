import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = new URL(".", import.meta.url).pathname;
const rawPath = join(root, "artifacts", "raw", "qualification.json");
const result = JSON.parse(readFileSync(rawPath, "utf8"));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

assert.equal(result.scope.repositoryReadOnly, true);
assert.equal(result.scope.realCredentialsUsed, false);
assert.equal(result.scope.existingSecretCollectionsEnumerated, false);
assert.equal(result.scope.procKeyContentsRead, false);

const keyring = result.native.keyring.result;
assert.equal(keyring.sessionRingCreated, true);
assert.equal(keyring.userPayloadExportable, true);
assert.equal(keyring.inheritedChildCanReadUserPayload, true);
assert.equal(keyring.logonKeyAdded, true);
assert.equal(keyring.logonReadBytes, -1);
assert.equal(keyring.logonReadErrno, 95);

const memory = result.native.memory.result;
for (const field of [
  "mlockSucceeded", "madvDontDumpSucceeded", "madvWipeOnForkSucceeded",
  "childSawZeroes", "setDumpableZeroSucceeded", "memfdSecretSucceeded",
  "memfdSecretMapped", "memfdSecretRoundTrip", "memfdSecretCloseOnExec",
]) assert.equal(memory[field], true, field);
assert.equal(memory.dumpableAfter, 0);

const path = result.native.openat2.result;
assert.equal(path.ordinaryReadAttackerMarker, true);
assert.equal(path.ordinaryNoFollowFinalRejected, true);
assert.equal(path.openat2DirectReadGoodMarker, true);
assert.equal(path.openat2IntermediateSymlinkRejected, true);
const mount = result.native.mountSwap.result;
assert.equal(mount.ordinaryReadAttackerMarker, true);
assert.equal(mount.openat2NoXdevRejected, true);
assert.equal(mount.openat2UnexpectedMarker, false);

const fd = result.inheritedFdAndWebCrypto;
assert.deepEqual(fd.exit, { code: 0, signal: null });
assert.equal(fd.expectedHashMatched, true);
assert.equal(fd.fdClosedAfterRead, true);
assert.equal(fd.result.commandLineContainsKey, false);
assert.equal(fd.result.environmentContainsKey, false);
assert.equal(fd.result.inputBufferZeroed, true);
assert.equal(fd.result.cryptoKeyExtractable, false);
assert.equal(fd.result.exportRejected, true);
assert.equal(fd.result.encryptDecryptRoundTrip, true);
assert.equal(fd.parentObservedKeyInChildCommandLineAfterIntake, false);
assert.equal(fd.parentObservedKeyInChildEnvironmentAfterIntake, false);

assert.equal(result.nodeKeyLibraries.napiKeyringLoaded, true);
assert.equal(result.nodeKeyLibraries.sodiumNativeLoaded, true);
assert.equal(result.nodeKeyLibraries.nativeMemzeroObserved, true);
assert.ok(result.nodeKeyLibraries.vmLckKiBAfterSecureAllocation > result.nodeKeyLibraries.vmLckKiBBefore);
assert.equal(result.nodeKeyLibraries.vmLckKiBAfterUnlock, result.nodeKeyLibraries.vmLckKiBBefore);

assert.equal(result.environment.runtimePaths.userBus.exists, false);
assert.equal(result.environment.tpmPaths["/dev/tpm0"].exists, false);
assert.equal(result.environment.tpmPaths["/dev/tpmrm0"].exists, false);
assert.notEqual(result.systemdCredentials.loadCredential.status, 0);
assert.equal(result.systemdCredentials.hostKeyEncryptionAttempted, false);

const cas = result.anchor.mockAuthorityCas;
assert.equal(cas.attempts, 24);
assert.equal(cas.appliedWinners, 1);
assert.equal(cas.compareFailures, 23);
assert.equal(cas.stale.code, "compare_failed");
assert.equal(cas.idempotentReplay.idempotentReplay, true);
assert.equal(cas.afterRestart.generation, 1);
assert.equal(cas.localStateRollbackSucceeded, true);
assert.equal(cas.stateMetadata.mode, 0o600);
assert.equal(cas.socketMetadata.mode, 0o600);

const ledger = result.anchor.ledgerIntegration;
assert.equal(ledger.staleRollbackClassification, "anchor_ahead_rollback_or_tail_loss");
assert.equal(ledger.tailDeletionClassification, "anchor_ahead_rollback_or_tail_loss");
assert.equal(ledger.beforeCommitCrash.signal, "SIGKILL");
assert.equal(ledger.afterBeforeCommitCrash.classification, "consistent");
assert.equal(ledger.commitBeforeAnchorCrash.signal, "SIGKILL");
assert.equal(ledger.pendingAfterCrash.classification, "one_valid_unacknowledged_successor");
assert.equal(ledger.pendingRecovery.action, "finalized_unacknowledged_successor");
assert.equal(ledger.afterPendingRecovery.classification, "consistent");
assert.deepEqual(ledger.afterPendingRecovery.unanchoredSequences, []);
assert.equal(ledger.anchorBeforeMarkCrash.signal, "SIGKILL");
assert.equal(ledger.responseLossRecovery.action, "marked_after_anchor_response_loss");
assert.deepEqual(ledger.afterResponseLossRecovery.unanchoredSequences, []);
assert.equal(ledger.pairedRollbackAcceptedByLocalMock, true);
assert.equal(ledger.databaseMetadata.mode, 0o600);
assert.equal(ledger.authorityStateMetadata.mode, 0o600);

assert.equal(result.anchor.plainSiblingFile.staleSnapshotAcceptedAsWellFormed, true);
assert.equal(result.anchor.plainSiblingFile.metadata.mode, 0o600);
assert.equal(result.packages.installed.npmLs.status, 0);
assert.equal(result.packages.installed.keyring.integrity,
  result.packages.registry["@napi-rs/keyring"]["dist.integrity"]);
assert.equal(result.packages.installed.sodiumNative.integrity,
  result.packages.registry["sodium-native"]["dist.integrity"]);

const manifestPath = join(root, "SHA256SUMS");
let manifestEntries = 0;
if (existsSync(manifestPath)) {
  for (const line of readFileSync(manifestPath, "utf8").trim().split("\n")) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    assert.ok(match, `invalid manifest line: ${line}`);
    assert.equal(hash(join(root, match[2])), match[1], match[2]);
    manifestEntries += 1;
  }
}

function walk(directory) {
  const findings = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const pathName = join(directory, entry.name);
    if (entry.isDirectory()) findings.push(...walk(pathName));
    else if (/\.(?:sqlite|db)(?:-(?:wal|shm))?$|-(?:wal|shm)$/u.test(entry.name)) findings.push(pathName);
  }
  return findings;
}
assert.deepEqual(walk(root), []);

console.log(JSON.stringify({
  ok: true,
  rawSha256: hash(rawPath),
  manifestEntries,
  semanticAssertionsPassed: true,
  sqliteWorkFiles: 0,
}));
