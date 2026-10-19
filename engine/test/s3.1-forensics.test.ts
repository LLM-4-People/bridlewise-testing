import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHmac, createSecretKey } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FORENSIC_EVENT_SCHEMA,
  FORENSIC_LEDGER_VERIFICATION_ANCHOR_SCHEMA,
  FORENSIC_LEDGER_VERIFICATION_RECORD_SCHEMA,
  FORENSIC_RAW_CAPTURE_SCHEMA,
  FORENSIC_RECEIPT_SCHEMA,
  FORENSIC_SEQUENCE_SCHEMA,
  FORENSIC_TOOL_SCHEMA,
  GENERATED_FORENSIC_SCHEMAS,
  type ForensicEvent,
  type ForensicLedgerVerificationRecord,
  type ForensicOutboxCommand,
} from "../src/forensics/forensic-contracts.ts";
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
  type AeadKeyOperations,
  type BlindIndexCapability,
  type LedgerMacCapability,
} from "../src/forensics/forensic-crypto.ts";
import {
  normalizeBytesCapture,
  normalizeOrderedHeaders,
  normalizePlainErrorCapture,
  normalizeStreamCapture,
  normalizeToolJsonCapture,
} from "../src/forensics/forensic-normalization.ts";
import { inspectProjectionLeakage, projectForensicEvent } from "../src/forensics/forensic-projection.ts";
import {
  createForensicOutboxState,
  forensicOutboxCanForward,
  reduceForensicOutbox,
} from "../src/forensics/forensic-state.ts";
import { canonicalHash, sha256 } from "../src/kernel/integrity.ts";
import {
  canonicalizeLedgerJsonText,
  parseAndCanonicalizeLedgerJson,
  type LedgerCanonicalLimits,
} from "../src/kernel/ledger-canonical.ts";
import { S3_OFFLINE_FORENSIC_HASH, S3_OFFLINE_FORENSIC_IDENTITY } from "../src/forensics/offline-forensics.ts";
import { ROOT_POLICY } from "../src/kernel/root-policy.ts";
import { analyzeStaticSource, verifyS1Repository, verifyS1Structure } from "../scripts/tooling/s1-verification.ts";
import { CANDIDATE_MANIFEST_SCHEMA_VERSION } from "../scripts/tooling/candidate-manifest.ts";
import { validateTestReceipt } from "../scripts/tooling/test-receipt.ts";
import { createCanonicalNodeTestInventoryFixture } from "./support/test-inventory-fixture.ts";

const ZERO_HASH = "0".repeat(64);

test("S3.1-B01 canonical intake rejects ambiguity, hostile structures, and every bound breach", () => {
  const canonical = parseAndCanonicalizeLedgerJson(
    '{"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/","numbers":[333333333.33333329,1e30,4.50,2e-3,1e-27],"literals":[null,true,false]}',
  ).canonicalUtf8.toString("utf8");
  assert.equal(canonical, '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  assert.notEqual(canonicalizeLedgerJsonText({ value: "é" }), canonicalizeLedgerJsonText({ value: "e\u0301" }));
  assert.equal(canonicalizeLedgerJsonText({ "\ud83d\ude00": 1, "\ufb33": 2 }), '{"😀":1,"דּ":2}');
  for (const fixture of ["values", "unicode"]) {
    const input = readSourceFragment(`jcs-${fixture}-input.json`);
    const expected = readSourceFragment(`jcs-${fixture}-output.json`).trimEnd();
    assert.equal(parseAndCanonicalizeLedgerJson(input).canonicalUtf8.toString("utf8"), expected);
  }

  for (const text of ['{"x":1,"x":2}', '{"outer":{"x":1,"\\u0078":2}}']) {
    assert.throws(() => parseAndCanonicalizeLedgerJson(text), { code: "ledger_json_duplicate_key" });
  }
  for (const text of ['-0', '-0.0', '-0e9', '-0E-9']) {
    assert.throws(() => parseAndCanonicalizeLedgerJson(text), { code: "ledger_json_negative_zero" });
  }
  assert.throws(() => canonicalizeLedgerJsonText(-0), { code: "ledger_json_negative_zero" });
  assert.throws(() => parseAndCanonicalizeLedgerJson('{"x":"\\uDEAD"}'), { code: "ledger_json_unicode_invalid" });
  assert.throws(() => canonicalizeLedgerJsonText("\udead"), { code: "ledger_json_unicode_invalid" });
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => canonicalizeLedgerJsonText(value), { code: "ledger_json_number_invalid" });
  }

  const limits = (overrides: Partial<LedgerCanonicalLimits>): LedgerCanonicalLimits => ({
    maximumInputBytes: 128,
    maximumCanonicalBytes: 128,
    maximumDepth: 8,
    maximumNodes: 32,
    ...overrides,
  });
  assert.throws(() => parseAndCanonicalizeLedgerJson('"12345678"', limits({ maximumInputBytes: 4 })), {
    code: "ledger_json_input_too_large",
  });
  assert.throws(() => canonicalizeLedgerJsonText("12345678", limits({ maximumCanonicalBytes: 4 })), {
    code: "ledger_json_output_too_large",
  });
  assert.throws(() => canonicalizeLedgerJsonText({ a: { b: 1 } }, limits({ maximumDepth: 1 })), {
    code: "ledger_json_depth_exceeded",
  });
  assert.throws(() => canonicalizeLedgerJsonText([1, 2, 3], limits({ maximumNodes: 3 })), {
    code: "ledger_json_nodes_exceeded",
  });

  const sparse = new Array<unknown>(2);
  sparse[1] = "present";
  assert.throws(() => canonicalizeLedgerJsonText(sparse), { code: "ledger_json_sparse_array" });
  assert.throws(() => canonicalizeLedgerJsonText(new Date()), { code: "ledger_json_object_invalid" });
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
  assert.throws(() => canonicalizeLedgerJsonText(accessor), { code: "ledger_json_object_invalid" });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeLedgerJsonText(cyclic), { code: "ledger_json_cycle" });
  assert.equal(FORENSIC_EVENT_SCHEMA.safeParse({ ...sampleEvent(), eventKind: "made.up" }).success, false);
  assert.equal(FORENSIC_EVENT_SCHEMA.safeParse({ ...sampleEvent(), unknown: true }).success, false);
  assert.equal(FORENSIC_EVENT_SCHEMA.safeParse({
    ...sampleEvent(), timestamp: { wallTime: "2026-13-11T12:00:00Z" },
  }).success, false);
  assert.equal(FORENSIC_EVENT_SCHEMA.safeParse({
    ...sampleEvent(), timestamp: { wallTime: "2026-02-31T12:00:00Z" },
  }).success, false);
  for (const sequence of [
    "9007199254740991", "9007199254740992", "9007199254740993", "9223372036854775807",
  ]) assert.equal(FORENSIC_SEQUENCE_SCHEMA.safeParse(sequence).success, true);
  for (const sequence of ["0", "-1", "01", "x", "9223372036854775808"]) {
    assert.equal(FORENSIC_SEQUENCE_SCHEMA.safeParse(sequence).success, false);
  }

  const rootProxy = countedHostileProxy({ value: 1 });
  assert.throws(() => canonicalizeLedgerJsonText(rootProxy.proxy), { code: "ledger_json_object_invalid" });
  assert.equal(rootProxy.trapCount(), 0);
  const nestedProxy = countedHostileProxy({ value: 1 });
  assert.throws(() => canonicalizeLedgerJsonText({ nested: nestedProxy.proxy }), {
    code: "ledger_json_object_invalid",
  });
  assert.equal(nestedProxy.trapCount(), 0);
  const limitsProxy = countedHostileProxy(limits({}));
  assert.throws(() => canonicalizeLedgerJsonText({}, limitsProxy.proxy), { code: "ledger_json_limits_invalid" });
  assert.equal(limitsProxy.trapCount(), 0);
  class NestedArray extends Array<unknown> {}
  assert.throws(() => canonicalizeLedgerJsonText({ nested: new NestedArray(1) }), {
    code: "ledger_json_array_invalid",
  });
  let nestedGetterCalls = 0;
  const nestedAccessor = Object.defineProperty({}, "value", { enumerable: true, get: () => {
    nestedGetterCalls += 1;
    return 1;
  } });
  assert.throws(() => canonicalizeLedgerJsonText({ nested: nestedAccessor }), {
    code: "ledger_json_object_invalid",
  });
  assert.equal(nestedGetterCalls, 0);

  const maximumHeader = "é".repeat(ROOT_POLICY.forensics.limits.maximumHeaderValueBytes / 2);
  assert.equal(FORENSIC_EVENT_SCHEMA.safeParse({
    ...sampleEvent(), headers: { entries: [{ name: "X-Test", value: maximumHeader }] },
  }).success, true);
  assert.equal(FORENSIC_EVENT_SCHEMA.safeParse({
    ...sampleEvent(), headers: { entries: [{ name: "X-Test", value: `${maximumHeader}é` }] },
  }).success, false);
  assert.equal(FORENSIC_EVENT_SCHEMA.safeParse({
    ...sampleEvent(), timestamp: {
      wallTime: "2026-07-11T12:00:00Z",
      monotonicNanoseconds: ROOT_POLICY.forensics.limits.maximumMonotonicNanosecondsDecimal,
    },
  }).success, true);
  assert.equal(FORENSIC_EVENT_SCHEMA.safeParse({
    ...sampleEvent(), timestamp: { wallTime: "2026-07-11T12:00:00Z", monotonicNanoseconds: "9223372036854775808" },
  }).success, false);

  const oneByte = Buffer.from([0]);
  const exactCapture = {
    kind: "bytes",
    mediaType: "application/octet-stream",
    contentBase64: oneByte.toString("base64"),
    byteLength: oneByte.byteLength,
    contentSha256: sha256(oneByte),
  } as const;
  assert.equal(FORENSIC_RAW_CAPTURE_SCHEMA.safeParse(exactCapture).success, true);
  for (const invalid of [
    { ...exactCapture, byteLength: 2 },
    { ...exactCapture, contentSha256: "f".repeat(64) },
    { ...exactCapture, contentBase64: "AB==" },
    {
      ...exactCapture,
      contentBase64: Buffer.alloc(ROOT_POLICY.forensics.limits.maximumTextBytes + 1).toString("base64"),
    },
  ]) assert.equal(FORENSIC_RAW_CAPTURE_SCHEMA.safeParse(invalid).success, false);

  const toolBase = { callId: "call-1", name: "read", protocol: "mcp", phase: "completed" } as const;
  assert.equal(FORENSIC_TOOL_SCHEMA.safeParse(toolBase).success, true);
  const toolPayload = {
    ...toolBase,
    mediaType: "application/octet-stream",
    contentBase64: oneByte.toString("base64"),
    byteLength: 1,
    contentSha256: sha256(oneByte),
  } as const;
  assert.equal(FORENSIC_TOOL_SCHEMA.safeParse(toolPayload).success, true);
  for (const partial of [
    { ...toolBase, mediaType: toolPayload.mediaType },
    { ...toolBase, contentBase64: toolPayload.contentBase64, byteLength: toolPayload.byteLength },
    { ...toolPayload, contentSha256: undefined },
  ]) assert.equal(FORENSIC_TOOL_SCHEMA.safeParse(partial).success, false);
});

test("S3.1-B02 normalization preserves exact bytes, duplicate headers, causes, and rejects object smuggling", () => {
  const raw = Buffer.from([0, 255, 13, 10, 65]);
  const bytes = normalizeBytesCapture(raw, "application/octet-stream");
  assert.equal(bytes.kind, "bytes");
  if (bytes.kind !== "bytes") assert.fail("wrong capture type");
  assert.deepEqual(Buffer.from(bytes.contentBase64, "base64"), raw);
  raw[0] = 99;
  assert.equal(Buffer.from(bytes.contentBase64, "base64")[0], 0);

  const headers = normalizeOrderedHeaders([
    ["Set-Cookie", "first=1"],
    ["set-cookie", "second=2"],
    ["X-Empty", ""],
  ]);
  assert.equal(headers.kind, "headers");
  if (headers.kind !== "headers") assert.fail("wrong capture type");
  assert.deepEqual(headers.entries, [
    { name: "Set-Cookie", value: "first=1" },
    { name: "set-cookie", value: "second=2" },
    { name: "X-Empty", value: "" },
  ]);

  const error = normalizePlainErrorCapture({
    category: "tool",
    code: "tool_failed",
    message: " exact message \n",
    stack: "frame:1\nframe:2",
    retryable: false,
    causes: [
      { name: "TypeError", message: "cause one", code: "bad_type" },
      { name: "Error", message: "cause two", stack: "cause-frame" },
    ],
  });
  assert.equal(error.kind, "error");
  if (error.kind !== "error") assert.fail("wrong capture type");
  assert.equal(error.error.message, " exact message \n");
  assert.deepEqual(error.error.causes.map((cause) => cause.message), ["cause one", "cause two"]);

  assert.deepEqual(normalizeStreamCapture("stderr", Buffer.from("boom\0", "utf8")), {
    kind: "stream",
    stream: "stderr",
    mediaType: "application/octet-stream",
    contentBase64: Buffer.from("boom\0", "utf8").toString("base64"),
    byteLength: 5,
    contentSha256: "ce1bf9b1cdb84f7738669ce9c1823cf905bf66b37608088912b326b9da5b48c1",
  });
  const tool = normalizeToolJsonCapture("arguments", "call-1", { z: 1, a: [true, false] });
  assert.equal(tool.kind, "tool-payload");
  if (tool.kind !== "tool-payload") assert.fail("wrong capture type");
  assert.equal(Buffer.from(tool.contentBase64, "base64").toString("utf8"), '{"a":[true,false],"z":1}');

  class SmuggledError {
    category = "internal";
    code = "smuggled";
    message = "hidden";
    retryable = false;
  }
  assert.throws(() => normalizePlainErrorCapture(new Error("native")), { code: "forensic_class_forbidden" });
  assert.throws(() => normalizePlainErrorCapture(new SmuggledError()), { code: "forensic_class_forbidden" });
  assert.throws(() => normalizePlainErrorCapture({
    category: "internal", code: "bad", message: "x", retryable: false, arbitrary: "field",
  }), { code: "forensic_object_invalid" });
  assert.throws(() => normalizeOrderedHeaders([["X-Test", "line\r\ninjection"]]), {
    code: "forensic_capture_invalid",
  });
  class HeaderList extends Array<readonly [string, string]> {}
  assert.throws(() => normalizeOrderedHeaders(new HeaderList(["X-Test", "value"])), {
    code: "forensic_class_forbidden",
  });
  let getterCalled = false;
  const accessorPair = ["X-Test", "value"];
  Object.defineProperty(accessorPair, "1", { enumerable: true, get: () => {
    getterCalled = true;
    return "hidden";
  } });
  assert.throws(() => normalizeOrderedHeaders([accessorPair as unknown as readonly [string, string]]), {
    code: "forensic_class_forbidden",
  });
  assert.equal(getterCalled, false);

  const headerProxy = countedHostileProxy([["X-Test", "value"]] as readonly (readonly [string, string])[]);
  assert.throws(() => normalizeOrderedHeaders(headerProxy.proxy), { code: "forensic_headers_invalid" });
  assert.equal(headerProxy.trapCount(), 0);
  const pairProxy = countedHostileProxy(["X-Test", "value"]);
  assert.throws(() => normalizeOrderedHeaders([
    pairProxy.proxy as unknown as readonly [string, string],
  ]), { code: "forensic_headers_invalid" });
  assert.equal(pairProxy.trapCount(), 0);
  const errorProxy = countedHostileProxy({
    category: "internal", code: "bad", message: "x", retryable: false,
  });
  assert.throws(() => normalizePlainErrorCapture(errorProxy.proxy), { code: "forensic_object_invalid" });
  assert.equal(errorProxy.trapCount(), 0);
  const bytesProxy = countedHostileProxy(new Uint8Array([1]));
  assert.throws(() => normalizeBytesCapture(bytesProxy.proxy, "application/octet-stream"), {
    code: "forensic_class_forbidden",
  });
  assert.equal(bytesProxy.trapCount(), 0);
  const forgedBytes = Object.create(Uint8Array.prototype) as Uint8Array;
  assert.throws(() => normalizeBytesCapture(forgedBytes, "application/octet-stream"), {
    code: "forensic_class_forbidden",
  });
});

test("S3.1-B03 projection removes every raw surface and the independent oracle catches bypass variants", () => {
  const canaries = [
    "raw-byte-canary",
    "header-canary",
    "tool-argument-canary",
    "error-message-canary",
    "tool-name-canary",
  ];
  const event = sampleEvent({
    classification: "credential-secret",
    captures: [
      normalizeBytesCapture(Buffer.from(canaries[0]!, "utf8"), "text/plain"),
      normalizeOrderedHeaders([["X-Synthetic", canaries[1]!], ["X-Synthetic", "duplicate"]]),
      normalizeToolJsonCapture("arguments", "call-1", { nested: [canaries[2]!] }),
      normalizePlainErrorCapture({
        category: "tool", code: "tool_failed", message: canaries[3]!, retryable: false, causes: [],
      }),
    ],
    tool: {
      callId: "call-1",
      name: canaries[4]!,
      protocol: "openai-responses",
      phase: "failed",
    },
    error: {
      category: "tool",
      code: canaries[3]!,
      message: canaries[3]!,
      retryable: false,
      causes: [],
    },
  });
  const { blindIndex } = createForensicHmacCapabilities(createSecretKey(Buffer.alloc(32, 0x55)));
  const projection = projectForensicEvent(event, blindIndex);
  assert.equal(projection.retention, "secret");
  assert.equal(projection.protocolFamily, "openai-compatible");
  assert.deepEqual(projection.safeError, { category: "tool", code: "tool_error", retryable: false });
  assert.deepEqual(projection.blindIndexes, [
    {
      purpose: "request-correlation",
      digest: computeBlindIndex("request-correlation", "request-1", blindIndex),
    },
    {
      purpose: "actor-correlation",
      digest: computeBlindIndex("actor-correlation", "harness-1", blindIndex),
    },
  ]);
  assert.deepEqual(inspectProjectionLeakage(projection, canaries), { safe: true, violations: [] });

  const bypasses: unknown[] = [
    { ...projection, message: canaries[3] },
    { ...projection, Content_Base64: Buffer.from(canaries[0]!, "utf8").toString("base64") },
    { ...projection, nested: [{ RAW: encodeURIComponent(canaries[2]!) }] },
    { ...projection, value: 42 },
    Object.assign(new Date(), projection),
  ];
  for (const bypass of bypasses) assert.equal(inspectProjectionLeakage(bypass, canaries).safe, false);

  const injectedDigest = {
    ...projection,
    blindIndexes: [{ purpose: "request-correlation", digest: "a".repeat(64) }],
  };
  assert.deepEqual(inspectProjectionLeakage(injectedDigest).violations, ["blind-index-unissued"]);
  const clonedRealDigest = { ...projection, blindIndexes: [...projection.blindIndexes] };
  assert.equal(inspectProjectionLeakage(clonedRealDigest).safe, false);
  assert.ok(inspectProjectionLeakage(clonedRealDigest).violations.includes("blind-index-unissued"));
  assert.deepEqual(projectForensicEvent(event).blindIndexes, []);

  const eventProxy = countedHostileProxy({ ...event });
  assert.throws(() => projectForensicEvent(eventProxy.proxy, blindIndex), {
    code: "forensic_projection_invalid",
  });
  assert.equal(eventProxy.trapCount(), 0);
  let actorGetterCalls = 0;
  const actorAccessor = Object.defineProperty({}, "id", { enumerable: true, get: () => {
    actorGetterCalls += 1;
    return "harness-1";
  } });
  assert.throws(() => projectForensicEvent({ ...event, actor: actorAccessor }, blindIndex), {
    code: "forensic_projection_invalid",
  });
  assert.equal(actorGetterCalls, 0);
  class CaptureList extends Array<unknown> {}
  assert.throws(() => projectForensicEvent({ ...event, captures: new CaptureList() }, blindIndex), {
    code: "forensic_projection_invalid",
  });

  const candidateProxy = countedHostileProxy({ ...projection });
  assert.deepEqual(inspectProjectionLeakage(candidateProxy.proxy), {
    safe: false, violations: ["projection-proxy-forbidden"],
  });
  assert.equal(candidateProxy.trapCount(), 0);
  const canaryProxy = countedHostileProxy(["secret"]);
  assert.deepEqual(inspectProjectionLeakage(projection, canaryProxy.proxy), {
    safe: false, violations: ["projection-structure-invalid"],
  });
  assert.equal(canaryProxy.trapCount(), 0);
});

test("S3.1-B04 AEAD authenticates ciphertext, tag, nonce, AAD, event binding, and issued ports", () => {
  const operations = createAes256GcmKeyOperations(createSecretKey(Buffer.alloc(32, 0x11)));
  const wrongOperations = createAes256GcmKeyOperations(createSecretKey(Buffer.alloc(32, 0x22)));
  const nonce = Buffer.from("000102030405060708090a0b", "hex");
  const fields = {
    ledgerId: "ledger-1",
    eventId: "event-1",
    sequence: "1",
    classification: "sensitive",
    purpose: "raw-event",
  } as const;
  const plaintext = Buffer.from([0, 1, 2, 255, 13, 10, 88]);
  const sealed = sealForensicPayload(plaintext, fields, nonce, operations);
  assert.deepEqual(openForensicPayload(sealed, fields, operations), plaintext);
  assert.equal(Object.keys(operations).toSorted().join(","), "open,seal");
  assert.equal(JSON.stringify(operations), "{}");
  assert.equal(Object.keys(sealed).some((name) => name.toLowerCase().includes("key")), false);
  assert.equal("plaintextSha256" in sealed, false);

  const vectorOperations = createAes256GcmKeyOperations(createSecretKey(Buffer.from(
    "31bdadd96698c204aa9ce1448ea94ae1fb4a9a0b3c9d773b51bb1822666b8f22",
    "hex",
  )));
  const vector = vectorOperations.seal(
    Buffer.from("0d18e06c7c725ac9e362e1ce", "hex"),
    Buffer.from("2db5168e932556f8089a0622981d017d", "hex"),
    Buffer.alloc(0),
  );
  assert.equal(vector.ciphertext.toString("hex"), "fa4362189661d163fcd6a56d8bf0405a");
  assert.equal(vector.authenticationTag.toString("hex"), "d636ac1bbedd5cc3ee727dc2ab4a9489");

  const ciphertext = flipBase64(sealed.ciphertextBase64);
  const tag = flipBase64(sealed.authenticationTagBase64);
  const changedNonce = flipBase64(sealed.nonceBase64);
  assert.throws(() => openForensicPayload({ ...sealed, ciphertextBase64: ciphertext }, fields, operations), {
    code: "forensic_ciphertext_digest_failed",
  });
  for (const offset of [0, Math.floor(plaintext.byteLength / 2), plaintext.byteLength - 1]) {
    const mutatedCiphertext = flipBase64At(sealed.ciphertextBase64, offset);
    assert.throws(() => openForensicPayload({
      ...sealed,
      ciphertextBase64: mutatedCiphertext,
      ciphertextSha256: sha256(Buffer.from(mutatedCiphertext, "base64")),
    }, fields, operations), { code: "forensic_aead_authentication_failed" });
  }
  assert.throws(() => openForensicPayload({ ...sealed, authenticationTagBase64: tag }, fields, operations), {
    code: "forensic_aead_authentication_failed",
  });
  assert.throws(() => openForensicPayload({ ...sealed, nonceBase64: changedNonce }, fields, operations), {
    code: "forensic_aead_authentication_failed",
  });
  assert.throws(() => openForensicPayload(sealed, { ...fields, eventId: "event-2" }, operations), {
    code: "forensic_aad_digest_failed",
  });
  const changedFields = [
    { ...fields, eventId: "event-2" },
    { ...fields, sequence: "2" },
    { ...fields, purpose: "raw-capture" },
  ] as const;
  for (const changed of changedFields) {
    assert.throws(() => openForensicPayload({
      ...sealed,
      aadSha256: sha256(buildSealedPayloadAad(changed)),
    }, changed, operations), { code: "forensic_aead_authentication_failed" });
  }
  assert.throws(() => openForensicPayload(sealed, fields, wrongOperations), {
    code: "forensic_aead_authentication_failed",
  });
  assert.throws(() => sealForensicPayload(plaintext, fields, Buffer.alloc(11), operations), {
    code: "forensic_nonce_invalid",
  });
  const forged = {
    seal: operations.seal,
    open: operations.open,
  } as unknown as AeadKeyOperations;
  assert.throws(() => sealForensicPayload(plaintext, fields, nonce, forged), { code: "forensic_aead_port_invalid" });
  assert.throws(() => openForensicPayload(sealed, Object.assign(new Date(), fields), operations), {
    code: "forensic_crypto_object_invalid",
  });

  const secretProxy = countedHostileProxy(createSecretKey(Buffer.alloc(32, 0x77)));
  assert.throws(() => createAes256GcmKeyOperations(secretProxy.proxy), { code: "forensic_aead_secret_invalid" });
  assert.equal(secretProxy.trapCount(), 0);
  const forgedSecret = Object.defineProperty(
    Object.create(Object.getPrototypeOf(createSecretKey(Buffer.alloc(32)))),
    "type",
    { get: () => assert.fail("forged KeyObject getter executed") },
  );
  assert.throws(() => createAes256GcmKeyOperations(forgedSecret), { code: "forensic_aead_secret_invalid" });
  const plaintextProxy = countedHostileProxy(Buffer.from(plaintext));
  assert.throws(() => sealForensicPayload(plaintextProxy.proxy, fields, nonce, operations), {
    code: "forensic_crypto_input_invalid",
  });
  assert.equal(plaintextProxy.trapCount(), 0);
  const fieldsProxy = countedHostileProxy({ ...fields });
  assert.throws(() => openForensicPayload(sealed, fieldsProxy.proxy, operations), {
    code: "forensic_aad_fields_invalid",
  });
  assert.equal(fieldsProxy.trapCount(), 0);
  const sealedProxy = countedHostileProxy({ ...sealed });
  assert.throws(() => openForensicPayload(sealedProxy.proxy, fields, operations), {
    code: "forensic_sealed_metadata_invalid",
  });
  assert.equal(sealedProxy.trapCount(), 0);
  const operationsProxy = countedHostileProxy(operations);
  assert.throws(() => openForensicPayload(sealed, fields, operationsProxy.proxy), {
    code: "forensic_aead_port_invalid",
  });
  assert.equal(operationsProxy.trapCount(), 0);
  let sealedGetterCalls = 0;
  const sealedAccessor = Object.defineProperty({ ...sealed }, "ciphertextBase64", {
    enumerable: true,
    get: () => {
      sealedGetterCalls += 1;
      return sealed.ciphertextBase64;
    },
  });
  assert.throws(() => openForensicPayload(
    sealedAccessor as typeof sealed, fields, operations,
  ), { code: "forensic_sealed_metadata_invalid" });
  assert.equal(sealedGetterCalls, 0);
  class NonceSubclass extends Uint8Array {}
  assert.throws(() => sealForensicPayload(plaintext, fields, new NonceSubclass(12), operations), {
    code: "forensic_crypto_input_invalid",
  });
  assert.throws(() => sealForensicPayload(
    Object.create(Uint8Array.prototype) as Uint8Array, fields, nonce, operations,
  ), { code: "forensic_crypto_input_invalid" });
});

test("S3.1-B05 hash and HMAC verification identifies mutation, gaps, reorder, recomputation, and transplant", () => {
  const masterSecret = Buffer.alloc(32, 0x33);
  const operations = createForensicHmacCapabilities(createSecretKey(masterSecret));
  const wrongOperations = createForensicHmacCapabilities(createSecretKey(Buffer.alloc(32, 0x44)));
  const forgedHmacSecret = Object.defineProperty(
    Object.create(Object.getPrototypeOf(createSecretKey(Buffer.alloc(32)))),
    "type",
    { get: () => assert.fail("forged HMAC KeyObject getter executed") },
  );
  assert.throws(() => createForensicHmacCapabilities(forgedHmacSecret), {
    code: "forensic_hmac_secret_invalid",
  });
  const records = buildChain(operations.ledgerMac, [{ value: "one" }, { value: "two" }, { value: "three" }]);
  const expected = {
    kind: "genesis",
    ledgerId: "ledger-1",
    segmentId: "segment-1",
    nextSequence: "1",
    previousEntryHash: ZERO_HASH,
    previousEntryMac: ZERO_HASH,
  } as const;
  assert.deepEqual(verifyLedgerChain(records, expected, operations.ledgerMac), { valid: true, verifiedEntries: 3 });

  const mutated = records.map((record, index) => index === 1 ? { ...record, envelope: { value: "changed" } } : record);
  assert.deepEqual(verifyLedgerChain(mutated, expected, operations.ledgerMac), {
    valid: false, verifiedEntries: 1, firstBadSequence: "2", code: "entry-hash",
  });
  assert.equal(verifyLedgerChain([records[1]!, records[0]!], expected, operations.ledgerMac).code, "sequence");
  assert.deepEqual(verifyLedgerChain([records[0]!, records[2]!], expected, operations.ledgerMac), {
    valid: false, verifiedEntries: 1, firstBadSequence: "3", code: "sequence",
  });

  const forgedHash = computeLedgerEntryHash(records[1]!.previousEntryHash, { value: "attacker-recomputed" });
  const unkeyedRecompute = records.map((record, index) => index === 1 ? {
    ...record,
    envelope: { value: "attacker-recomputed" },
    entryHash: forgedHash,
  } : record);
  assert.equal(verifyLedgerChain(unkeyedRecompute, expected, operations.ledgerMac).code, "entry-mac");
  assert.equal(verifyLedgerChain(records, expected, wrongOperations.ledgerMac).code, "entry-mac");
  assert.equal(verifyLedgerChain([{ ...records[0]!, ledgerId: "ledger-2" }], expected, operations.ledgerMac).code, "coordinate");
  assert.equal(verifyLedgerChain([{ ...records[0]!, segmentId: "segment-2" }], expected, operations.ledgerMac).code, "coordinate");
  assert.equal(verifyLedgerEntryMac(
    "ledger-2", "segment-1", "1", ZERO_HASH, records[0]!.entryHash, records[0]!.entryMac, operations.ledgerMac,
  ), false);
  assert.throws(() => computeLedgerEntryMac(
    "ledger-1", "segment-1", "1", ZERO_HASH, records[0]!.entryHash,
    operations.blindIndex as unknown as LedgerMacCapability,
  ), { code: "forensic_hmac_port_invalid" });
  assert.throws(() => computeBlindIndex(
    "request-correlation", "request-1", operations.ledgerMac as unknown as BlindIndexCapability,
  ), { code: "forensic_hmac_port_invalid" });

  const vectorEntryHash = "11".repeat(32);
  const manualPreimage = Buffer.concat([
    Buffer.from("bridlewise/ledger-mac/v1\0", "utf8"),
    uint32be(Buffer.byteLength("ledger-1", "utf8")),
    Buffer.from("ledger-1", "utf8"),
    uint32be(Buffer.byteLength("segment-1", "utf8")),
    Buffer.from("segment-1", "utf8"),
    Buffer.from("0000000000000001", "hex"),
    Buffer.from(ZERO_HASH, "hex"),
    Buffer.from(vectorEntryHash, "hex"),
  ]);
  assert.equal(manualPreimage.toString("hex"),
    "627269646c65776973652f6c65646765722d6d61632f763100000000086c65646765722d31000000097365676d656e742d31000000000000000100000000000000000000000000000000000000000000000000000000000000001111111111111111111111111111111111111111111111111111111111111111");
  assert.deepEqual(buildLedgerMacPreimage(
    "ledger-1", "segment-1", "1", ZERO_HASH, vectorEntryHash,
  ), manualPreimage);
  const ledgerDerivedKey = createHmac("sha256", masterSecret)
    .update("bridlewise/key-derivation/ledger-mac/v1\0", "utf8").digest();
  assert.equal(ledgerDerivedKey.toString("hex"), "0f6d5fb3401dcf0b40bf1fa7e9fff6ace5b4a7137c9f9279faa1f7e09bbef496");
  const independentMac = createHmac("sha256", ledgerDerivedKey).update(manualPreimage).digest("hex");
  assert.equal(independentMac, "929cdea8cfecf141896a06bfe6266bab52e74d5055a34e22041068088dfcbc28");
  assert.equal(computeLedgerEntryMac(
    "ledger-1", "segment-1", "1", ZERO_HASH, vectorEntryHash, operations.ledgerMac,
  ), independentMac);

  const oldAmbiguousLeft = Buffer.from("abc", "utf8");
  const oldAmbiguousRight = Buffer.from("abc", "utf8");
  assert.deepEqual(oldAmbiguousLeft, oldAmbiguousRight);
  assert.notDeepEqual(
    buildLedgerMacPreimage("a", "bc", "1", ZERO_HASH, records[0]!.entryHash),
    buildLedgerMacPreimage("ab", "c", "1", ZERO_HASH, records[0]!.entryHash),
  );
  const splitMac = computeLedgerEntryMac(
    "a", "bc", "1", ZERO_HASH, records[0]!.entryHash, operations.ledgerMac,
  );
  assert.equal(verifyLedgerEntryMac(
    "ab", "c", "1", ZERO_HASH, records[0]!.entryHash, splitMac, operations.ledgerMac,
  ), false);

  assert.equal(FORENSIC_LEDGER_VERIFICATION_ANCHOR_SCHEMA.safeParse(expected).success, true);
  assert.equal(FORENSIC_LEDGER_VERIFICATION_RECORD_SCHEMA.safeParse(records[0]).success, true);
  assert.deepEqual(verifyLedgerChain([], expected, operations.ledgerMac), { valid: true, verifiedEntries: 0 });
  const continuation = {
    kind: "continuation",
    ledgerId: "ledger-1",
    segmentId: "segment-1",
    nextSequence: "2",
    previousEntryHash: records[0]!.entryHash,
    previousEntryMac: records[0]!.entryMac,
  } as const;
  assert.deepEqual(verifyLedgerChain(records.slice(1), continuation, operations.ledgerMac), {
    valid: true, verifiedEntries: 2,
  });
  assert.deepEqual(verifyLedgerChain([], continuation, operations.ledgerMac), {
    valid: true, verifiedEntries: 0,
  });

  const invalidAnchors: unknown[] = [
    null,
    { ...expected, nextSequence: "2" },
    { ...expected, previousEntryHash: "1".repeat(64) },
    { ...expected, previousEntryMac: "1".repeat(64) },
    { ...continuation, nextSequence: "1" },
    { ...continuation, nextSequence: "9223372036854775808" },
  ];
  for (const anchor of invalidAnchors) {
    assert.deepEqual(verifyLedgerChain([], anchor, operations.ledgerMac), {
      valid: false, verifiedEntries: 0, code: "anchor-invalid",
    });
  }

  const first = records[0]!;
  const invalidRecordInputs: unknown[] = [
    null,
    [null],
    [{ ...first, entryHash: undefined }],
    [{ ...first, entryHash: Buffer.alloc(32) }],
    [{ ...first, sequence: 1 }],
    [{ ...first, extra: true }],
    [{ ...first, envelope: undefined }],
    [{ ...first, envelope: { value: Number.NaN } }],
  ];
  for (const invalidRecords of invalidRecordInputs) {
    const result = verifyLedgerChain(invalidRecords, expected, operations.ledgerMac);
    assert.deepEqual(result, { valid: false, verifiedEntries: 0, code: "records-invalid" });
    assert.ok(Object.isFrozen(result));
  }
  class RecordList extends Array<unknown> {}
  assert.deepEqual(verifyLedgerChain(new RecordList(first), expected, operations.ledgerMac), {
    valid: false, verifiedEntries: 0, code: "records-invalid",
  });

  const recordsProxy = countedHostileProxy([first]);
  assert.deepEqual(verifyLedgerChain(recordsProxy.proxy, expected, operations.ledgerMac), {
    valid: false, verifiedEntries: 0, code: "records-invalid",
  });
  assert.equal(recordsProxy.trapCount(), 0);
  const recordProxy = countedHostileProxy({ ...first });
  assert.deepEqual(verifyLedgerChain([recordProxy.proxy], expected, operations.ledgerMac), {
    valid: false, verifiedEntries: 0, code: "records-invalid",
  });
  assert.equal(recordProxy.trapCount(), 0);
  const envelopeProxy = countedHostileProxy({ value: "one" });
  assert.deepEqual(verifyLedgerChain([{ ...first, envelope: envelopeProxy.proxy }], expected, operations.ledgerMac), {
    valid: false, verifiedEntries: 0, code: "records-invalid",
  });
  assert.equal(envelopeProxy.trapCount(), 0);
  const anchorProxy = countedHostileProxy({ ...expected });
  assert.deepEqual(verifyLedgerChain([], anchorProxy.proxy, operations.ledgerMac), {
    valid: false, verifiedEntries: 0, code: "anchor-invalid",
  });
  assert.equal(anchorProxy.trapCount(), 0);

  let recordGetterCalls = 0;
  const getterRecord = Object.defineProperty({ ...first }, "entryHash", {
    enumerable: true,
    get: () => {
      recordGetterCalls += 1;
      return recordGetterCalls % 2 === 0 ? first.entryHash : "f".repeat(64);
    },
  });
  assert.deepEqual(verifyLedgerChain([getterRecord], expected, operations.ledgerMac), {
    valid: false, verifiedEntries: 0, code: "records-invalid",
  });
  assert.equal(recordGetterCalls, 0);
  let envelopeGetterCalls = 0;
  const getterEnvelope = Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => {
      envelopeGetterCalls += 1;
      return "one";
    },
  });
  assert.deepEqual(verifyLedgerChain([{ ...first, envelope: getterEnvelope }], expected, operations.ledgerMac), {
    valid: false, verifiedEntries: 0, code: "records-invalid",
  });
  assert.equal(envelopeGetterCalls, 0);

  assert.deepEqual(Object.keys(operations.ledgerMac), []);
  assert.deepEqual(Object.keys(operations.blindIndex), []);
  assert.equal(JSON.stringify(operations.ledgerMac), "{}");
  assert.equal(JSON.stringify(operations.blindIndex), "{}");
  const forgedCapability = Object.defineProperty({}, "mac", { enumerable: true, get: () => {
    assert.fail("forged capability getter executed");
  } });
  assert.throws(() => computeLedgerEntryMac(
    "ledger-1", "segment-1", "1", ZERO_HASH, first.entryHash,
    forgedCapability as unknown as LedgerMacCapability,
  ), { code: "forensic_hmac_port_invalid" });
  const capabilityProxy = countedHostileProxy(operations.ledgerMac);
  assert.throws(() => computeLedgerEntryMac(
    "ledger-1", "segment-1", "1", ZERO_HASH, first.entryHash, capabilityProxy.proxy,
  ), { code: "forensic_hmac_port_invalid" });
  assert.equal(capabilityProxy.trapCount(), 0);
  assert.deepEqual(verifyLedgerChain(records, expected, {} as LedgerMacCapability), {
    valid: false, verifiedEntries: 0, code: "capability-invalid",
  });
});

test("S3.1-B06 outbox contracts enforce persist-before-forward, binding, idempotency, and no authority", () => {
  const inputHash = "1".repeat(64);
  const evidence = {
    ledgerId: "ledger-1",
    segmentId: "segment-1",
    sequence: "1",
    projectionHash: "2".repeat(64),
    sealedPayloadHash: "3".repeat(64),
    entryHash: "4".repeat(64),
    entryMac: "5".repeat(64),
  };
  const command = (value: ForensicOutboxCommand): ForensicOutboxCommand => value;
  let state = createForensicOutboxState("event-1", inputHash);
  assert.equal(forensicOutboxCanForward(state), false);
  assert.throws(() => reduceForensicOutbox(state, command({
    type: "authorize-forward", eventId: "event-1", inputHash,
  })), { code: "forensic_outbox_transition_invalid" });
  assert.throws(() => reduceForensicOutbox(state, command({
    type: "commit", eventId: "event-1", inputHash, evidence,
  })), { code: "forensic_outbox_transition_invalid" });

  state = reduceForensicOutbox(state, command({ type: "prepare", eventId: "event-1", inputHash }));
  assert.deepEqual(reduceForensicOutbox(state, command({ type: "prepare", eventId: "event-1", inputHash })), state);
  state = reduceForensicOutbox(state, command({ type: "commit", eventId: "event-1", inputHash, evidence }));
  assert.equal(forensicOutboxCanForward(state), false);
  assert.throws(() => reduceForensicOutbox(state, command({
    type: "commit", eventId: "event-1", inputHash, evidence: { ...evidence, entryHash: "9".repeat(64) },
  })), { code: "forensic_outbox_commit_conflict" });

  const receipt = FORENSIC_RECEIPT_SCHEMA.parse({
    schemaVersion: "bridlewise-forensic-receipt/v1",
    eventId: "event-1",
    ...evidence,
    committedAt: { wallTime: "2026-07-11T12:00:00Z" },
    integrityClaim: "cryptographic-correlation-not-external-authenticity",
    effectAuthorized: false,
  });
  assert.throws(() => reduceForensicOutbox(state, command({
    type: "record-receipt", eventId: "event-1", inputHash, receipt,
  })), { code: "forensic_outbox_transition_invalid" });
  state = reduceForensicOutbox(state, command({ type: "authorize-forward", eventId: "event-1", inputHash }));
  assert.equal(forensicOutboxCanForward(state), true);
  assert.throws(() => reduceForensicOutbox(state, command({
    type: "record-receipt",
    eventId: "event-1",
    inputHash,
    receipt: { ...receipt, entryMac: "8".repeat(64) },
  })), { code: "forensic_receipt_binding_conflict" });
  state = reduceForensicOutbox(state, command({ type: "record-receipt", eventId: "event-1", inputHash, receipt }));
  assert.equal(state.phase, "receipted");
  assert.equal(forensicOutboxCanForward(state), false);
  assert.deepEqual(reduceForensicOutbox(state, command({
    type: "record-receipt", eventId: "event-1", inputHash, receipt,
  })), state);
  assert.throws(() => reduceForensicOutbox(state, command({
    type: "prepare", eventId: "event-1", inputHash: "0".repeat(64),
  })), { code: "forensic_outbox_correlation_conflict" });

  const stateProxy = countedHostileProxy({ ...state });
  assert.throws(() => forensicOutboxCanForward(stateProxy.proxy), { code: "forensic_outbox_state_invalid" });
  assert.equal(stateProxy.trapCount(), 0);
  const commandProxy = countedHostileProxy({ type: "prepare", eventId: "event-1", inputHash });
  assert.throws(() => reduceForensicOutbox(state, commandProxy.proxy), {
    code: "forensic_outbox_command_invalid",
  });
  assert.equal(commandProxy.trapCount(), 0);
  let receiptGetterCalls = 0;
  const receiptAccessor = Object.defineProperty({ ...receipt }, "entryMac", {
    enumerable: true,
    get: () => {
      receiptGetterCalls += 1;
      return receipt.entryMac;
    },
  });
  assert.throws(() => reduceForensicOutbox(state, {
    type: "record-receipt", eventId: "event-1", inputHash, receipt: receiptAccessor,
  }), { code: "forensic_outbox_command_invalid" });
  assert.equal(receiptGetterCalls, 0);
});

test("S3.1-B07 schemas, bundle, root policy, and receipts expose no secret-key or runtime authority", () => {
  assert.match(S3_OFFLINE_FORENSIC_HASH, /^[0-9a-f]{64}$/u);
  assert.equal(S3_OFFLINE_FORENSIC_HASH, canonicalHash(S3_OFFLINE_FORENSIC_IDENTITY));
  assert.ok(Object.isFrozen(S3_OFFLINE_FORENSIC_IDENTITY));
  assert.ok(Object.isFrozen(GENERATED_FORENSIC_SCHEMAS));
  assert.deepEqual(Object.keys(GENERATED_FORENSIC_SCHEMAS).toSorted(), [
    "actor", "agent", "correlation", "error", "event", "header", "headers",
    "ledgerVerificationAnchor", "ledgerVerificationRecord", "outboxCommand", "outboxState",
    "projection", "rawCapture", "receipt", "sequence", "timestamp", "tool", "turn", "usage",
  ]);
  for (const schema of Object.values(GENERATED_FORENSIC_SCHEMAS)) {
    assert.equal((schema as Readonly<Record<string, unknown>>).$schema, ROOT_POLICY.forensics.schemaDialect);
  }
  assert.deepEqual([...declaredPropertyNames(GENERATED_FORENSIC_SCHEMAS)].filter((name) =>
    /(?:^|[-_])(key|secret)(?:$|[-_])/iu.test(name) || /(?:key|secret)(?:id|ref|handle|material)$/iu.test(name)
  ), []);
  assert.deepEqual(ROOT_POLICY.capabilities, {
    preflight: true,
    mutableState: false,
    modelInvocation: false,
    modelTools: false,
    retryDispatch: false,
    repositoryMutation: false,
    processExecution: false,
    networkEgress: false,
    sensitiveInput: false,
    durableAudit: false,
  });
  assert.deepEqual({
    effectsAuthorized: S3_OFFLINE_FORENSIC_IDENTITY.effectsAuthorized,
    durableAuditAvailable: S3_OFFLINE_FORENSIC_IDENTITY.durableAuditAvailable,
    storageAvailable: S3_OFFLINE_FORENSIC_IDENTITY.storageAvailable,
    transportAvailable: S3_OFFLINE_FORENSIC_IDENTITY.transportAvailable,
    modelInvocationAvailable: S3_OFFLINE_FORENSIC_IDENTITY.modelInvocationAvailable,
    toolExecutionAvailable: S3_OFFLINE_FORENSIC_IDENTITY.toolExecutionAvailable,
  }, {
    effectsAuthorized: false,
    durableAuditAvailable: false,
    storageAvailable: false,
    transportAvailable: false,
    modelInvocationAvailable: false,
    toolExecutionAvailable: false,
  });

  const sourceProxy = countedHostileProxy({ source: "import('node:fs')" });
  assert.deepEqual(analyzeStaticSource(sourceProxy.proxy as unknown as string, "fixture.ts"), {
    moduleAcquisitions: [],
    typeOnlyModuleReferences: [],
    unmodeledModuleAcquisition: true,
    environmentAcquisitions: [],
    unmodeledEnvironmentAccess: true,
  });
  assert.equal(sourceProxy.trapCount(), 0);
  const profileProxy = countedHostileProxy({ path: "source.ts" });
  assert.equal(analyzeStaticSource('import("node:fs")', profileProxy.proxy as unknown as string).unmodeledModuleAcquisition, true);
  assert.equal(profileProxy.trapCount(), 0);
  const rootProxy = countedHostileProxy({ root: "." });
  assert.deepEqual(verifyS1Structure(rootProxy.proxy as unknown as string).violations, ["candidate-root-invalid"]);
  assert.equal(rootProxy.trapCount(), 0);
  const receiptProxy = countedHostileProxy({ receipt: true });
  const expectedInventory = createCanonicalNodeTestInventoryFixture({
    sourceId: "test/example.test.ts",
    sourceHash: "2".repeat(64),
    name: "example",
  }).inventory;
  assert.deepEqual(validateTestReceipt(receiptProxy.proxy, {
    manifestSchemaVersion: CANDIDATE_MANIFEST_SCHEMA_VERSION,
    formatPolicyRevision: ROOT_POLICY.verification.candidateFormat.revision,
    semanticTreeHash: "3".repeat(64),
    formatVerificationHash: "4".repeat(64),
  }, expectedInventory), [
    "test-receipt-schema-invalid",
  ]);
  assert.equal(receiptProxy.trapCount(), 0);
  const repositoryReceiptProxy = countedHostileProxy({ receipt: true });
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  assert.equal(verifyS1Repository(repositoryRoot, repositoryReceiptProxy.proxy).ok, false);
  assert.equal(repositoryReceiptProxy.trapCount(), 0);
});

function sampleEvent(overrides: Partial<ForensicEvent> = {}): ForensicEvent {
  return FORENSIC_EVENT_SCHEMA.parse({
    schemaVersion: "bridlewise-forensic-event/v1",
    ledgerId: "ledger-1",
    eventId: "event-1",
    sequence: "1",
    eventKind: "tool.recorded",
    timestamp: { wallTime: "2026-07-11T12:34:56.123Z", monotonicNanoseconds: "123456" },
    actor: { kind: "harness", id: "harness-1" },
    correlation: { requestId: "request-1", turnId: "turn-1" },
    classification: "project-private",
    outcome: "succeeded",
    captures: [],
    ...overrides,
  });
}

function flipBase64(value: string): string {
  return flipBase64At(value, 0);
}

function flipBase64At(value: string, offset: number): string {
  const bytes = Buffer.from(value, "base64");
  bytes[offset] = (bytes[offset] ?? 0) ^ 1;
  return bytes.toString("base64");
}

function uint32be(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function countedHostileProxy<T extends object>(target: T): Readonly<{
  proxy: T;
  trapCount: () => number;
}> {
  let count = 0;
  const trapped = (): never => {
    count += 1;
    throw new Error("A hostile Proxy trap was invoked");
  };
  return {
    proxy: new Proxy(target, {
      defineProperty: trapped,
      deleteProperty: trapped,
      get: trapped,
      getOwnPropertyDescriptor: trapped,
      getPrototypeOf: trapped,
      has: trapped,
      isExtensible: trapped,
      ownKeys: trapped,
      preventExtensions: trapped,
      set: trapped,
      setPrototypeOf: trapped,
    }),
    trapCount: () => count,
  };
}

function buildChain(
  operations: LedgerMacCapability,
  envelopes: readonly unknown[],
): readonly ForensicLedgerVerificationRecord[] {
  let previousEntryHash = ZERO_HASH;
  let previousEntryMac = ZERO_HASH;
  return envelopes.map((envelope, index) => {
    const sequence = String(index + 1);
    const entryHash = computeLedgerEntryHash(previousEntryHash, envelope);
    const entryMac = computeLedgerEntryMac(
      "ledger-1", "segment-1", sequence, previousEntryMac, entryHash, operations,
    );
    const record = {
      ledgerId: "ledger-1",
      segmentId: "segment-1",
      sequence,
      previousEntryHash,
      entryHash,
      previousEntryMac,
      entryMac,
      envelope,
    };
    previousEntryHash = entryHash;
    previousEntryMac = entryMac;
    return record;
  });
}

function declaredPropertyNames(value: unknown, names = new Set<string>()): ReadonlySet<string> {
  if (value === null || typeof value !== "object") return names;
  if (Array.isArray(value)) {
    for (const child of value) declaredPropertyNames(child, names);
    return names;
  }
  for (const [name, child] of Object.entries(value)) {
    if (name === "properties" && child !== null && typeof child === "object" && !Array.isArray(child)) {
      for (const propertyName of Object.keys(child)) names.add(propertyName);
    }
    declaredPropertyNames(child, names);
  }
  return names;
}

function readSourceFragment(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../traceability/sources/s3.1/${name}`, import.meta.url)), "utf8");
}
