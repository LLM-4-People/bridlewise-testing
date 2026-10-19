import assert from "node:assert/strict";
import { createSecretKey, type KeyObject } from "node:crypto";
import test from "node:test";

import { InputError, SecurityError } from "../../src/kernel/errors.ts";
import {
  buildLedgerMacPreimage,
  buildSealedPayloadAad,
  computeBlindIndex,
  computeLedgerEntryHash,
  computeLedgerEntryMac,
  createAes256GcmKeyOperations,
  createForensicHmacCapabilities,
  openForensicPayload,
  sealForensicPayload,
  verifyLedgerChain,
  verifyLedgerEntryMac,
  type SealedPayloadAadFields,
} from "../../src/forensics/forensic-crypto.ts";
import { sha256 } from "../../src/kernel/integrity.ts";

const SECRET = createSecretKey(Buffer.alloc(32, 0x07));
const ZERO_HASH = "0".repeat(64);

function aad(overrides: Partial<Record<string, string>> = {}): SealedPayloadAadFields {
  return {
    ledgerId: "ledger-1",
    eventId: "evt-1",
    sequence: "1",
    classification: "project-private",
    purpose: "raw-event",
    ...overrides,
  } as SealedPayloadAadFields;
}

// ---------------------------------------------------------------------------
// createAes256GcmKeyOperations
// ---------------------------------------------------------------------------

test("forensic-crypto: createAes256GcmKeyOperations seal/open round-trips", () => {
  const ops = createAes256GcmKeyOperations(SECRET);
  const nonce = Buffer.alloc(12, 1);
  const plaintext = Buffer.from("secret message", "utf8");
  const aadBuf = Buffer.from("aad", "utf8");
  const sealed = ops.seal(nonce, plaintext, aadBuf);
  assert.ok(sealed.ciphertext.byteLength > 0);
  assert.equal(sealed.authenticationTag.byteLength, 16);
  const opened = ops.open(nonce, sealed.ciphertext, sealed.authenticationTag, aadBuf);
  assert.deepEqual([...opened], [...plaintext]);
});

test("forensic-crypto: AEAD open fails with a tampered ciphertext", () => {
  const ops = createAes256GcmKeyOperations(SECRET);
  const nonce = Buffer.alloc(12, 1);
  const sealed = ops.seal(nonce, Buffer.from("plain"), Buffer.from("a"));
  const tampered = Buffer.from(sealed.ciphertext);
  tampered[0] = tampered[0]! ^ 0xff;
  assert.throws(() => ops.open(nonce, tampered, sealed.authenticationTag, Buffer.from("a")), SecurityError);
});

test("forensic-crypto: AEAD open fails with tampered AAD", () => {
  const ops = createAes256GcmKeyOperations(SECRET);
  const nonce = Buffer.alloc(12, 1);
  const sealed = ops.seal(nonce, Buffer.from("plain"), Buffer.from("a"));
  assert.throws(() => ops.open(nonce, sealed.ciphertext, sealed.authenticationTag, Buffer.from("b")), SecurityError);
});

test("forensic-crypto: AEAD open fails with a wrong nonce", () => {
  const ops = createAes256GcmKeyOperations(SECRET);
  const sealed = ops.seal(Buffer.alloc(12, 1), Buffer.from("plain"), Buffer.from("a"));
  assert.throws(() => ops.open(Buffer.alloc(12, 2), sealed.ciphertext, sealed.authenticationTag, Buffer.from("a")), SecurityError);
});

test("forensic-crypto: createAes256GcmKeyOperations rejects a non-256-bit key", () => {
  assert.throws(() => createAes256GcmKeyOperations(createSecretKey(Buffer.alloc(16))), InputError);
});

test("forensic-crypto: createAes256GcmKeyOperations rejects a non-KeyObject secret", () => {
  assert.throws(() => createAes256GcmKeyOperations({} as KeyObject), InputError);
});

test("forensic-crypto: AEAD seal rejects a wrong-size nonce", () => {
  const ops = createAes256GcmKeyOperations(SECRET);
  assert.throws(() => ops.seal(Buffer.alloc(11), Buffer.from("p"), Buffer.alloc(0)), InputError);
});

test("forensic-crypto: AEAD open rejects a wrong-size authentication tag", () => {
  const ops = createAes256GcmKeyOperations(SECRET);
  const sealed = ops.seal(Buffer.alloc(12, 1), Buffer.from("p"), Buffer.alloc(0));
  assert.throws(() => ops.open(Buffer.alloc(12, 1), sealed.ciphertext, Buffer.alloc(15), Buffer.alloc(0)), InputError);
});

// ---------------------------------------------------------------------------
// createForensicHmacCapabilities + blind index
// ---------------------------------------------------------------------------

test("forensic-crypto: createForensicHmacCapabilities returns ledgerMac and blindIndex capabilities", () => {
  const caps = createForensicHmacCapabilities(SECRET);
  assert.ok(caps.ledgerMac);
  assert.ok(caps.blindIndex);
});

test("forensic-crypto: createForensicHmacCapabilities rejects a too-short secret", () => {
  assert.throws(() => createForensicHmacCapabilities(createSecretKey(Buffer.alloc(16))), InputError);
});

test("forensic-crypto: computeBlindIndex is deterministic for the same purpose+value", () => {
  const caps = createForensicHmacCapabilities(SECRET);
  const a = computeBlindIndex("request-correlation", "req-1", caps.blindIndex);
  const b = computeBlindIndex("request-correlation", "req-1", caps.blindIndex);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/u);
});

test("forensic-crypto: computeBlindIndex differs across purposes and values", () => {
  const caps = createForensicHmacCapabilities(SECRET);
  const reqA = computeBlindIndex("request-correlation", "req-1", caps.blindIndex);
  const reqB = computeBlindIndex("request-correlation", "req-2", caps.blindIndex);
  const sessA = computeBlindIndex("session-correlation", "req-1", caps.blindIndex);
  const actor = computeBlindIndex("actor-correlation", "req-1", caps.blindIndex);
  assert.notEqual(reqA, reqB);
  assert.notEqual(reqA, sessA);
  assert.notEqual(reqA, actor);
});

test("forensic-crypto: computeBlindIndex rejects a non-string value", () => {
  const caps = createForensicHmacCapabilities(SECRET);
  assert.throws(() => computeBlindIndex("request-correlation", 42 as unknown as string, caps.blindIndex), InputError);
});

// ---------------------------------------------------------------------------
// buildSealedPayloadAad + seal/openForensicPayload
// ---------------------------------------------------------------------------

test("forensic-crypto: buildSealedPayloadAad is deterministic for the same fields", () => {
  const a = buildSealedPayloadAad(aad());
  const b = buildSealedPayloadAad(aad());
  assert.deepEqual([...a], [...b]);
});

test("forensic-crypto: buildSealedPayloadAad changes when a field changes", () => {
  const a = buildSealedPayloadAad(aad());
  const b = buildSealedPayloadAad(aad({ eventId: "evt-2" }));
  assert.notDeepEqual([...a], [...b]);
});

test("forensic-crypto: sealForensicPayload/openForensicPayload round-trips", () => {
  const ops = createAes256GcmKeyOperations(SECRET);
  const nonce = Buffer.alloc(12, 2);
  const plaintext = Buffer.from("payload bytes", "utf8");
  const sealed = sealForensicPayload(plaintext, aad(), nonce, ops);
  assert.equal(sealed.schemaVersion, "bridlewise-sealed-forensic-payload/v1");
  assert.equal(sealed.algorithm, "AES-256-GCM");
  assert.equal(sealed.ciphertextBytes, plaintext.byteLength);
  assert.equal(sealed.ciphertextSha256, sha256(Buffer.from(sealed.ciphertextBase64, "base64")));
  const opened = openForensicPayload(sealed, aad(), ops);
  assert.deepEqual([...opened], [...plaintext]);
});

test("forensic-crypto: openForensicPayload fails with tampered AAD fields", () => {
  const ops = createAes256GcmKeyOperations(SECRET);
  const sealed = sealForensicPayload(Buffer.from("p"), aad(), Buffer.alloc(12, 3), ops);
  assert.throws(() => openForensicPayload(sealed, aad({ eventId: "evt-other" }), ops), SecurityError);
});

test("forensic-crypto: openForensicPayload fails with a different key", () => {
  const ops = createAes256GcmKeyOperations(SECRET);
  const other = createAes256GcmKeyOperations(createSecretKey(Buffer.alloc(32, 0x09)));
  const sealed = sealForensicPayload(Buffer.from("p"), aad(), Buffer.alloc(12, 3), ops);
  assert.throws(() => openForensicPayload(sealed, aad(), other), SecurityError);
});

test("forensic-crypto: sealForensicPayload rejects a wrong-size nonce", () => {
  const ops = createAes256GcmKeyOperations(SECRET);
  assert.throws(() => sealForensicPayload(Buffer.from("p"), aad(), Buffer.alloc(10), ops), InputError);
});

// ---------------------------------------------------------------------------
// Ledger entry hash + MAC + chain verification
// ---------------------------------------------------------------------------

test("forensic-crypto: computeLedgerEntryHash is deterministic and depends on previous + envelope", () => {
  const h1 = computeLedgerEntryHash(ZERO_HASH, { a: 1 });
  const h2 = computeLedgerEntryHash(ZERO_HASH, { a: 1 });
  const h3 = computeLedgerEntryHash(ZERO_HASH, { a: 2 });
  const h4 = computeLedgerEntryHash("1".repeat(64), { a: 1 });
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/u);
  assert.notEqual(h1, h3);
  assert.notEqual(h1, h4);
});

test("forensic-crypto: computeLedgerEntryHash rejects a non-hex previous hash", () => {
  assert.throws(() => computeLedgerEntryHash("nothex", { a: 1 }), InputError);
});

test("forensic-crypto: computeLedgerEntryMac and verifyLedgerEntryMac round-trip", () => {
  const caps = createForensicHmacCapabilities(SECRET);
  const entryHash = computeLedgerEntryHash(ZERO_HASH, { x: 1 });
  const mac = computeLedgerEntryMac("ledger-1", "seg-1", "1", ZERO_HASH, entryHash, caps.ledgerMac);
  assert.match(mac, /^[0-9a-f]{64}$/u);
  assert.equal(verifyLedgerEntryMac("ledger-1", "seg-1", "1", ZERO_HASH, entryHash, mac, caps.ledgerMac), true);
});

test("forensic-crypto: verifyLedgerEntryMac rejects a wrong MAC", () => {
  const caps = createForensicHmacCapabilities(SECRET);
  const entryHash = computeLedgerEntryHash(ZERO_HASH, { x: 1 });
  assert.equal(verifyLedgerEntryMac("ledger-1", "seg-1", "1", ZERO_HASH, entryHash, "1".repeat(64), caps.ledgerMac), false);
});

test("forensic-crypto: verifyLedgerEntryMac rejects a non-hex MAC", () => {
  const caps = createForensicHmacCapabilities(SECRET);
  const entryHash = computeLedgerEntryHash(ZERO_HASH, { x: 1 });
  assert.equal(verifyLedgerEntryMac("ledger-1", "seg-1", "1", ZERO_HASH, entryHash, "nothex", caps.ledgerMac), false);
});

test("forensic-crypto: buildLedgerMacPreimage is deterministic", () => {
  const a = buildLedgerMacPreimage("l", "s", "1", ZERO_HASH, "1".repeat(64));
  const b = buildLedgerMacPreimage("l", "s", "1", ZERO_HASH, "1".repeat(64));
  assert.deepEqual([...a], [...b]);
});

test("forensic-crypto: verifyLedgerChain accepts a valid single-record chain", () => {
  const caps = createForensicHmacCapabilities(SECRET);
  const envelope = { event: "e1" };
  const entryHash = computeLedgerEntryHash(ZERO_HASH, envelope);
  const entryMac = computeLedgerEntryMac("ledger-1", "seg-1", "1", ZERO_HASH, entryHash, caps.ledgerMac);
  const anchor = {
    kind: "genesis" as const,
    ledgerId: "ledger-1",
    segmentId: "seg-1",
    nextSequence: "1",
    previousEntryHash: ZERO_HASH,
    previousEntryMac: ZERO_HASH,
  };
  const records = [{
    ledgerId: "ledger-1",
    segmentId: "seg-1",
    sequence: "1",
    previousEntryHash: ZERO_HASH,
    entryHash,
    previousEntryMac: ZERO_HASH,
    entryMac,
    envelope,
  }];
  const result = verifyLedgerChain(records, anchor, caps.ledgerMac);
  assert.equal(result.valid, true);
  assert.equal(result.verifiedEntries, 1);
});

test("forensic-crypto: verifyLedgerChain rejects a tampered entry MAC", () => {
  const caps = createForensicHmacCapabilities(SECRET);
  const envelope = { event: "e1" };
  const entryHash = computeLedgerEntryHash(ZERO_HASH, envelope);
  const anchor = {
    kind: "genesis" as const, ledgerId: "ledger-1", segmentId: "seg-1",
    nextSequence: "1", previousEntryHash: ZERO_HASH, previousEntryMac: ZERO_HASH,
  };
  const records = [{
    ledgerId: "ledger-1", segmentId: "seg-1", sequence: "1",
    previousEntryHash: ZERO_HASH, entryHash, previousEntryMac: ZERO_HASH,
    entryMac: "f".repeat(64), envelope,
  }];
  const result = verifyLedgerChain(records, anchor, caps.ledgerMac);
  assert.equal(result.valid, false);
  assert.equal(result.code, "entry-mac");
});

test("forensic-crypto: verifyLedgerChain rejects a sequence gap", () => {
  const caps = createForensicHmacCapabilities(SECRET);
  const envelope = { event: "e1" };
  const entryHash = computeLedgerEntryHash(ZERO_HASH, envelope);
  const entryMac = computeLedgerEntryMac("ledger-1", "seg-1", "2", ZERO_HASH, entryHash, caps.ledgerMac);
  const anchor = {
    kind: "genesis" as const, ledgerId: "ledger-1", segmentId: "seg-1",
    nextSequence: "1", previousEntryHash: ZERO_HASH, previousEntryMac: ZERO_HASH,
  };
  const records = [{
    ledgerId: "ledger-1", segmentId: "seg-1", sequence: "2",
    previousEntryHash: ZERO_HASH, entryHash, previousEntryMac: ZERO_HASH, entryMac, envelope,
  }];
  const result = verifyLedgerChain(records, anchor, caps.ledgerMac);
  assert.equal(result.valid, false);
  assert.equal(result.code, "sequence");
});

test("forensic-crypto: verifyLedgerChain rejects a coordinate mismatch", () => {
  const caps = createForensicHmacCapabilities(SECRET);
  const envelope = { event: "e1" };
  const entryHash = computeLedgerEntryHash(ZERO_HASH, envelope);
  const entryMac = computeLedgerEntryMac("ledger-1", "seg-1", "1", ZERO_HASH, entryHash, caps.ledgerMac);
  const anchor = {
    kind: "genesis" as const, ledgerId: "ledger-1", segmentId: "seg-1",
    nextSequence: "1", previousEntryHash: ZERO_HASH, previousEntryMac: ZERO_HASH,
  };
  const records = [{
    ledgerId: "ledger-other", segmentId: "seg-1", sequence: "1",
    previousEntryHash: ZERO_HASH, entryHash, previousEntryMac: ZERO_HASH, entryMac, envelope,
  }];
  const result = verifyLedgerChain(records, anchor, caps.ledgerMac);
  assert.equal(result.valid, false);
  assert.equal(result.code, "coordinate");
});

test("forensic-crypto: verifyLedgerChain returns capability-invalid for a non-issued capability", () => {
  // A plain object that was never registered by createForensicHmacCapabilities is not a valid capability.
  const result = verifyLedgerChain([], { kind: "genesis", ledgerId: "l", segmentId: "s", nextSequence: "1", previousEntryHash: ZERO_HASH, previousEntryMac: ZERO_HASH }, {} as never);
  assert.equal(result.valid, false);
  assert.equal(result.code, "capability-invalid");
});
