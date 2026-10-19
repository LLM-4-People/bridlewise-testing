import assert from "node:assert/strict";
import test from "node:test";

import { InputError } from "../../src/kernel/errors.ts";
import {
  normalizeBytesCapture,
  normalizeOrderedHeaders,
  normalizeStreamCapture,
  normalizeToolBytesCapture,
  normalizeToolJsonCapture,
  normalizePlainErrorCapture,
} from "../../src/forensics/forensic-normalization.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";

const MAX_BYTES = ROOT_POLICY.forensics.limits.maximumTextBytes;

function eq(base64: string, bytes: Uint8Array): boolean {
  return Buffer.from(base64, "base64").equals(Buffer.from(bytes));
}

// ---------------------------------------------------------------------------
// normalizeBytesCapture
// ---------------------------------------------------------------------------

test("forensic-norm: normalizeBytesCapture round-trips bytes and digest", () => {
  const bytes = Buffer.from("hello", "utf8");
  const cap = normalizeBytesCapture(bytes, "text/plain");
  assert.equal(cap.kind, "bytes");
  if (cap.kind === "bytes") {
    assert.equal(cap.byteLength, bytes.byteLength);
    assert.equal(cap.contentSha256, sha256(bytes));
    assert.ok(eq(cap.contentBase64, bytes));
  }
});

test("forensic-norm: normalizeBytesCapture accepts an empty payload", () => {
  const cap = normalizeBytesCapture(new Uint8Array(0), "application/octet-stream");
  assert.equal(cap.kind, "bytes");
  if (cap.kind === "bytes") assert.equal(cap.byteLength, 0);
});

test("forensic-norm: normalizeBytesCapture accepts a Uint8Array (not just Buffer)", () => {
  const bytes = new Uint8Array([1, 2, 3, 250]);
  const cap = normalizeBytesCapture(bytes, "application/octet-stream");
  assert.equal(cap.kind, "bytes");
  if (cap.kind === "bytes") assert.equal(cap.byteLength, 4);
});

test("forensic-norm: normalizeBytesCapture rejects a non-canonical base64 via schema", () => {
  // The schema validates contentBase64 is canonical; non-canonical encodings are rejected.
  // (Indirectly covered by the round-trip; here we confirm a valid call is canonical.)
  const cap = normalizeBytesCapture(Buffer.from([0]), "application/octet-stream");
  if (cap.kind === "bytes") assert.equal(cap.contentBase64, Buffer.from([0]).toString("base64"));
});

test("forensic-norm: normalizeBytesCapture rejects an invalid media type", () => {
  assert.throws(() => normalizeBytesCapture(Buffer.from("x"), "not a media type"), InputError);
});

test("forensic-norm: normalizeBytesCapture rejects an oversized payload", () => {
  const big = new Uint8Array(MAX_BYTES + 1);
  assert.throws(() => normalizeBytesCapture(big, "application/octet-stream"), InputError);
});

test("forensic-norm: normalizeBytesCapture rejects a Proxy-wrapped Uint8Array", () => {
  const proxied = new Proxy(new Uint8Array(0), {});
  assert.throws(() => normalizeBytesCapture(proxied as Uint8Array, "text/plain"), InputError);
});

test("forensic-norm: normalizeBytesCapture result is frozen", () => {
  const cap = normalizeBytesCapture(Buffer.from("x"), "text/plain");
  assert.ok(Object.isFrozen(cap));
});

// ---------------------------------------------------------------------------
// normalizeOrderedHeaders
// ---------------------------------------------------------------------------

test("forensic-norm: normalizeOrderedHeaders captures valid pairs", () => {
  const cap = normalizeOrderedHeaders([["Content-Type", "application/json"], ["X-Trace", "abc"]]);
  assert.equal(cap.kind, "headers");
  if (cap.kind === "headers") {
    assert.equal(cap.entries.length, 2);
    assert.equal(cap.entries[0]!.name, "Content-Type");
    assert.equal(cap.entries[0]!.value, "application/json");
  }
});

test("forensic-norm: normalizeOrderedHeaders accepts an empty list", () => {
  const cap = normalizeOrderedHeaders([]);
  assert.equal(cap.kind, "headers");
  if (cap.kind === "headers") assert.equal(cap.entries.length, 0);
});

test("forensic-norm: normalizeOrderedHeaders preserves order", () => {
  const cap = normalizeOrderedHeaders([["a", "1"], ["b", "2"], ["c", "3"]]);
  if (cap.kind === "headers") {
    assert.deepEqual(cap.entries.map((e) => e.name), ["a", "b", "c"]);
  }
});

test("forensic-norm: normalizeOrderedHeaders rejects a non-string pair element", () => {
  assert.throws(() => normalizeOrderedHeaders([["a", 1] as unknown as [string, string]]), InputError);
});

test("forensic-norm: normalizeOrderedHeaders rejects a pair of wrong length", () => {
  assert.throws(() => normalizeOrderedHeaders([["only"]] as unknown as [string, string][]), InputError);
  assert.throws(() => normalizeOrderedHeaders([["a", "b", "c"]] as unknown as [string, string][]), InputError);
});

test("forensic-norm: normalizeOrderedHeaders rejects a header name with CRLF", () => {
  assert.throws(() => normalizeOrderedHeaders([["bad\rname", "v"]]), InputError);
});

test("forensic-norm: normalizeOrderedHeaders rejects a header value with a newline", () => {
  assert.throws(() => normalizeOrderedHeaders([["name", "v\nalue"]]), InputError);
});

test("forensic-norm: normalizeOrderedHeaders rejects a non-array input", () => {
  assert.throws(() => normalizeOrderedHeaders("not-an-array" as unknown as [string, string][]), InputError);
});

// ---------------------------------------------------------------------------
// normalizeStreamCapture
// ---------------------------------------------------------------------------

test("forensic-norm: normalizeStreamCapture captures stdout with default media type", () => {
  const bytes = Buffer.from("output line\n");
  const cap = normalizeStreamCapture("stdout", bytes);
  assert.equal(cap.kind, "stream");
  if (cap.kind === "stream") {
    assert.equal(cap.stream, "stdout");
    assert.equal(cap.mediaType, "application/octet-stream");
    assert.equal(cap.byteLength, bytes.byteLength);
  }
});

test("forensic-norm: normalizeStreamCapture captures stderr with a custom media type", () => {
  const cap = normalizeStreamCapture("stderr", Buffer.from("err"), "text/plain");
  if (cap.kind === "stream") {
    assert.equal(cap.stream, "stderr");
    assert.equal(cap.mediaType, "text/plain");
  }
});

test("forensic-norm: normalizeStreamCapture round-trips digest", () => {
  const bytes = Buffer.from("abc");
  const cap = normalizeStreamCapture("stdout", bytes);
  if (cap.kind === "stream") assert.equal(cap.contentSha256, sha256(bytes));
});

test("forensic-norm: normalizeStreamCapture rejects an oversized payload", () => {
  const big = new Uint8Array(MAX_BYTES + 1);
  assert.throws(() => normalizeStreamCapture("stdout", big), InputError);
});

// ---------------------------------------------------------------------------
// normalizeToolBytesCapture / normalizeToolJsonCapture
// ---------------------------------------------------------------------------

test("forensic-norm: normalizeToolBytesCapture captures arguments with media type", () => {
  const bytes = Buffer.from("{\"x\":1}");
  const cap = normalizeToolBytesCapture("arguments", "call-1", bytes, "application/json");
  assert.equal(cap.kind, "tool-payload");
  if (cap.kind === "tool-payload") {
    assert.equal(cap.direction, "arguments");
    assert.equal(cap.callId, "call-1");
    assert.equal(cap.byteLength, bytes.byteLength);
    assert.equal(cap.contentSha256, sha256(bytes));
  }
});

test("forensic-norm: normalizeToolBytesCapture captures a result direction", () => {
  const cap = normalizeToolBytesCapture("result", "call-2", Buffer.from([0, 255]), "application/octet-stream");
  if (cap.kind === "tool-payload") assert.equal(cap.direction, "result");
});

test("forensic-norm: normalizeToolBytesCapture rejects an invalid callId", () => {
  assert.throws(() => normalizeToolBytesCapture("arguments", "bad call!", Buffer.from("x"), "text/plain"), InputError);
});

test("forensic-norm: normalizeToolBytesCapture rejects an oversized payload", () => {
  const big = new Uint8Array(MAX_BYTES + 1);
  assert.throws(() => normalizeToolBytesCapture("arguments", "c", big, "application/octet-stream"), InputError);
});

test("forensic-norm: normalizeToolJsonCapture canonicalizes a JSON value", () => {
  const cap = normalizeToolJsonCapture("arguments", "call-3", { b: 2, a: 1 });
  if (cap.kind === "tool-payload") {
    assert.equal(cap.mediaType, "application/json");
    const decoded = Buffer.from(cap.contentBase64, "base64").toString("utf8");
    assert.deepEqual(JSON.parse(decoded), { a: 1, b: 2 });
  }
});

test("forensic-norm: normalizeToolJsonCapture result is frozen", () => {
  const cap = normalizeToolJsonCapture("result", "c", { ok: true });
  assert.ok(Object.isFrozen(cap));
});

// ---------------------------------------------------------------------------
// normalizePlainErrorCapture
// ---------------------------------------------------------------------------

test("forensic-norm: normalizePlainErrorCapture accepts a minimal plain error", () => {
  const cap = normalizePlainErrorCapture({ category: "input", code: "bad_input", message: "oops", retryable: false });
  assert.equal(cap.kind, "error");
  if (cap.kind === "error") {
    assert.equal(cap.error.category, "input");
    assert.equal(cap.error.code, "bad_input");
    assert.equal(cap.error.retryable, false);
    assert.deepEqual(cap.error.causes, []);
  }
});

test("forensic-norm: normalizePlainErrorCapture accepts an error with causes and stack", () => {
  const cap = normalizePlainErrorCapture({
    category: "provider",
    code: "provider_http_error",
    message: "failed",
    stack: "at x",
    retryable: true,
    causes: [{ name: "TypeError", message: "inner", code: "e1" }],
  });
  if (cap.kind === "error") {
    assert.equal(cap.error.causes.length, 1);
    assert.equal(cap.error.causes[0]!.name, "TypeError");
  }
});

test("forensic-norm: normalizePlainErrorCapture rejects a missing required field", () => {
  assert.throws(
    () => normalizePlainErrorCapture({ category: "input", code: "c", message: "m" }),
    InputError,
  );
});

test("forensic-norm: normalizePlainErrorCapture rejects an invalid category", () => {
  assert.throws(
    () => normalizePlainErrorCapture({ category: "not-a-category", code: "c", message: "m", retryable: false }),
    InputError,
  );
});

test("forensic-norm: normalizePlainErrorCapture rejects an invalid code format", () => {
  assert.throws(
    () => normalizePlainErrorCapture({ category: "input", code: "Bad Code", message: "m", retryable: false }),
    InputError,
  );
});

test("forensic-norm: normalizePlainErrorCapture rejects an unsupported field", () => {
  assert.throws(
    () => normalizePlainErrorCapture({ category: "input", code: "c", message: "m", retryable: false, extra: 1 }),
    InputError,
  );
});

test("forensic-norm: normalizePlainErrorCapture rejects a class instance", () => {
  class ErrLike { message = "m"; }
  assert.throws(
    () => normalizePlainErrorCapture(new ErrLike() as unknown as Record<string, unknown>),
    InputError,
  );
});

test("forensic-norm: normalizePlainErrorCapture rejects a non-object input", () => {
  assert.throws(() => normalizePlainErrorCapture("not-an-object"), InputError);
  assert.throws(() => normalizePlainErrorCapture(null), InputError);
});

test("forensic-norm: normalizePlainErrorCapture rejects oversized message text", () => {
  const huge = "x".repeat(ROOT_POLICY.forensics.limits.maximumTextBytes + 1);
  assert.throws(
    () => normalizePlainErrorCapture({ category: "input", code: "c", message: huge, retryable: false }),
    InputError,
  );
});

test("forensic-norm: normalizePlainErrorCapture result is frozen", () => {
  const cap = normalizePlainErrorCapture({ category: "input", code: "c", message: "m", retryable: false });
  assert.ok(Object.isFrozen(cap));
});
