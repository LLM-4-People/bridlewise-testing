import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, createSecretKey, randomBytes } from "node:crypto";
import { createEncryptedFieldCodec, authenticatedEncryptedFieldRanges, fieldAad, FIELD_AAD_DOMAINS, ownerSealAad, UNBOUND_FIELD } from "../../src/privacy/encrypted-field.ts";
import { collectContextRedactionCandidates, redactForLLMContext } from "../../src/privacy/redaction-engine.ts";
import { redactOperationalText } from "../../src/privacy/operational-redaction.ts";
import { registerKnownSecret } from "../../src/privacy/secret-intelligence.ts";

test("operational projection preserves only authenticated ciphertext while redacting adjacent plaintext", () => {
  const key = createSecretKey(randomBytes(32)), codec = createEncryptedFieldCodec(key);
  const cipher = codec.encrypt("private field with enough ciphertext for a registered substring", UNBOUND_FIELD);
  const secret = cipher.slice(8, 40);
  registerKnownSecret(secret, "cipher-projection-test");
  assert.notEqual(redactForLLMContext(cipher), cipher, "the ordinary detector actually finds this ciphertext substring");
  const text = `\uFEFF { "b": "${cipher}", "a": "${secret}" } \r\n`;
  const projected = redactOperationalText(text, key);
  assert.ok(projected.startsWith(`\uFEFF { "b": "${cipher}", "a": "`));
  assert.ok(projected.endsWith('" } \r\n'));
  assert.equal(projected.slice(projected.indexOf(', "a"')).includes(secret), false);
  assert.equal(codec.decrypt(cipher, UNBOUND_FIELD), "private field with enough ciphertext for a registered substring");
  const packed = Buffer.from(cipher.slice(4), "base64"); packed[12] = packed[12]! ^ 1;
  const damaged = "enc:" + packed.toString("base64");
  assert.deepEqual(authenticatedEncryptedFieldRanges(damaged, key, UNBOUND_FIELD), []);
  assert.deepEqual(authenticatedEncryptedFieldRanges(cipher, createSecretKey(randomBytes(32)), UNBOUND_FIELD), []);
  const fake = "enc:" + secret;
  assert.equal(redactOperationalText(fake, key).includes(secret), false);
  assert.equal(redactOperationalText(damaged, key), redactForLLMContext(damaged));
});

test("authenticated intervals cannot hide an overlapping secret outside the ciphertext", () => {
  const key = createSecretKey(randomBytes(32)), codec = createEncryptedFieldCodec(key);
  const cipher = codec.encrypt("123", UNBOUND_FIELD);
  assert.ok(cipher.endsWith("=="));
  const inside = cipher.slice(-40), overlap = cipher.slice(-12) + "OUTSIDE_TAIL";
  registerKnownSecret(inside, "inside-cipher-test"); registerKnownSecret(overlap, "outside-cipher-test");
  const input = cipher + "OUTSIDE_TAIL";
  assert.notEqual(redactForLLMContext(input), input);
  const projected = redactOperationalText(input, key);
  assert.ok(projected.startsWith(cipher));
  assert.equal(projected.includes("OUTSIDE_TAIL"), false);
});

test("malformed overpadded encrypted tokens do not obtain a valid-prefix exemption", () => {
  const key = createSecretKey(randomBytes(32)), codec = createEncryptedFieldCodec(key);
  for (const text of ["1", "12", "123"]) {
    const cipher = codec.encrypt(text, UNBOUND_FIELD);
    assert.equal(codec.decrypt(cipher, UNBOUND_FIELD), text);
    assert.equal(authenticatedEncryptedFieldRanges(cipher, key, UNBOUND_FIELD).length, 1);
    const invalid = cipher + "=";
    assert.equal(codec.authenticates(invalid, UNBOUND_FIELD), false);
    assert.deepEqual(authenticatedEncryptedFieldRanges(invalid, key, UNBOUND_FIELD), []);
  }
});

test("a bound field authenticates only under its own binding; the unbound projection gives it no exemption (CRED-F13)", () => {
  const key = createSecretKey(randomBytes(32)), codec = createEncryptedFieldCodec(key);
  const bound = codec.encrypt("alice's project path", 'bw-field-v1["projects","path","p1","alice"]');
  assert.equal(codec.decrypt(bound, 'bw-field-v1["projects","path","p1","alice"]'), "alice's project path");
  for (const other of ['bw-field-v1["projects","path","p2","alice"]', 'bw-field-v1["projects","path","p1","bob"]', 'bw-field-v1["projects","name","p1","alice"]', UNBOUND_FIELD]) {
    assert.throws(() => codec.decrypt(bound, other), { code: "encrypted_field_invalid" }, other);
  }
  assert.deepEqual(authenticatedEncryptedFieldRanges(bound, key, UNBOUND_FIELD), []);
  // GCM with empty associated data is byte-identical to none: pre-binding ciphertext stays readable as UNBOUND_FIELD.
  const nonce = Buffer.alloc(12, 7), legacy = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  const body = Buffer.concat([legacy.update("pre-binding", "utf8"), legacy.final()]);
  assert.equal(codec.decrypt("enc:" + Buffer.concat([nonce, legacy.getAuthTag(), body]).toString("base64"), UNBOUND_FIELD), "pre-binding");
});

test("the codec owns the binding ENCODING: one canonical form over a closed domain registry", () => {
  assert.equal(fieldAad("bw-field-v1", ["messages", "content", "m1", "u1", "c1"]), '["bw-field-v1","messages","content","m1","u1","c1"]');
  assert.equal(fieldAad("bw-memory-v1", ["u1", null]), '["bw-memory-v1","u1",null]');
  assert.deepEqual([...FIELD_AAD_DOMAINS], ["bw-field-v1", "bw-memory-v1", "bw-secret-v1", "bw-setting-v1"]);
  assert.throws(() => fieldAad("bw-other-v1" as never, []), (error: unknown) => (error as { code?: string }).code === "encrypted_field_domain_unknown");
  // Domains separate stores: the same parts under another domain are another binding.
  assert.notEqual(fieldAad("bw-secret-v1", ["x"]), fieldAad("bw-setting-v1", ["x"]));
});

test("a memory entry sealed to its owner stays intact in the operational projection, and a retargeted owner reads nothing (secc-design M6)", () => {
  const key = createSecretKey(randomBytes(32)), codec = createEncryptedFieldCodec(key);
  const document = { id: "mem-1", content: "", metadata: { userId: "alice", sealId: "seal-1" } };
  const aad = ownerSealAad(document)!;
  assert.equal(aad, fieldAad("bw-memory-v1", ["alice", "seal-1"]));
  document.content = codec.encrypt("alice's private memory, long enough to look like a credential to a detector", aad);
  registerKnownSecret(document.content.slice(8, 40), "owner-seal-projection-test");
  const text = JSON.stringify(document);
  assert.equal(redactOperationalText(text, key), text, "authenticated owner-sealed ciphertext survives the projection (a restart reads it back)");
  const stolen = JSON.stringify({ ...document, metadata: { userId: "bob", sealId: "seal-1" } });
  assert.notEqual(redactOperationalText(stolen, key), stolen, "retargeted: no longer authenticates, so no exemption");
  assert.throws(() => codec.decrypt(document.content, ownerSealAad(JSON.parse(stolen))!));
  assert.throws(() => codec.decrypt(document.content, UNBOUND_FIELD), "an owner-sealed value never opens unbound");
  assert.equal(ownerSealAad({ metadata: { userId: "alice" } }), undefined, "no seal id: a legacy entry (unbound)");
});

test("a JSON number is exempt ONLY from the bank-routing grammar, and only when nothing labels it a routing number (REDACT-NUM, MF-A)", () => {
  const key = createSecretKey(randomBytes(32));
  // Byte counts the browser lab found redacted (resource-sampler-redaction-001): each passes the bank-routing check digit.
  for (const value of [245748169, 281848421, 280535764, 646180546, 260932112, 287186132]) {
    assert.ok(collectContextRedactionCandidates(`routing ${String(value)}`).some((span) => span.signalId === "bank-routing"), `${String(value)} is a routing number to the text detector`);
    const sample = JSON.stringify({ metric: "process.rss", value, unit: "bytes" });
    assert.equal(redactOperationalText(sample, key), sample, "a resident-set byte count is kept as written");
    assert.equal(redactOperationalText(JSON.stringify({ note: `routing ${String(value)}` }), key), '{"note":"routing [REDACTED:pii]"}', "inside a string it is text");
    assert.equal(redactOperationalText(`routing ${String(value)} on file`, key), "routing [REDACTED:pii] on file", "free text is redacted as before");
    assert.equal(redactOperationalText(JSON.stringify({ routing: String(value) }), key), '{"routing":"[REDACTED:pii]"}', "a string-typed field is text");
    assert.equal(redactOperationalText(JSON.stringify({ routing_number: value }), key), '{"routing_number":[REDACTED:pii]}', "a number its key names a routing number keeps the detection");
    assert.equal(redactOperationalText(JSON.stringify({ aba: [value] }), key), '{"aba":[[REDACTED:pii]]}', "so does an element of a labelled array");
  }
  // Every other detector still reads a number (the security re-verification's table; each was kept in clear at aaa03534).
  const kept: readonly (readonly [string, string])[] = [
    ['{"password": 84729361528374}', '{"password": [REDACTED:credential]}'],
    ['{"api_key": 123456789012345678}', '{"api_key": [REDACTED:credential]}'],
    ['{"secret": 123456789012345678}', '{"secret": [REDACTED:credential]}'],
    ['{"card_number":4539148803436467,"exp":"12/29"}', '{"card_number":[REDACTED:pii],"exp":"12/29"}'],
    ['{"items":[{"card_number":5555555555554444}]}', '{"items":[{"card_number":[REDACTED:pii]}]}'],
    ['{"social_security_number":219099998}', '{"social_security_number":[REDACTED:pii]}'],
    ['{"card": "4111111111111111"}', '{"card": "[REDACTED:pii]"}'],
    ['{"card":4111111111111111}', '{"card":[REDACTED:pii]}'],
    ['{"k":"x"}\n{"rss":245748169}', '{"k":"x"}\n{"rss":[REDACTED:pii]}'],
  ];
  for (const [document, projected] of kept) assert.equal(redactOperationalText(document, key), projected, document);
});
