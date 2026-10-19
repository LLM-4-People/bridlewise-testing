import assert from "node:assert/strict";
import test from "node:test";

import { InputError, SecurityError } from "../../src/kernel/errors.ts";
import { inspectProjectionLeakage, projectForensicEvent } from "../../src/forensics/forensic-projection.ts";

// A structurally-valid projection shape with empty blind indexes. It is NOT
// issued by projectForensicEvent (so it cannot carry non-empty blind indexes),
// but with empty blind indexes the leakage oracle must consider it safe.
function validProjection(blindIndexes: readonly unknown[] = []): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "bridlewise-forensic-projection/v1",
    eventId: "evt-1",
    timeBucket: "2026-01-01T00:00:00Z",
    eventKind: "provider.frame_received",
    outcome: "succeeded",
    classification: "public",
    retention: "standard",
    protocolFamily: "openai-compatible",
    sizeBucket: "empty",
    blindIndexes,
    policy: { rootPolicyHash: "0".repeat(64), projectionRevision: "s3.1-redacted-projection/v2" },
  };
}

// ---------------------------------------------------------------------------
// inspectProjectionLeakage — independent deny-list oracle
// ---------------------------------------------------------------------------

test("forensic-projection: inspectProjectionLeakage returns safe for a valid projection with empty blind indexes", () => {
  const result = inspectProjectionLeakage(validProjection([]));
  assert.equal(result.safe, true);
  assert.deepEqual(result.violations, []);
});

test("forensic-projection: inspectProjectionLeakage flags a Proxy candidate", () => {
  const proxied = new Proxy({ a: 1 }, {});
  const result = inspectProjectionLeakage(proxied);
  assert.equal(result.safe, false);
  assert.ok(result.violations.includes("projection-proxy-forbidden"));
});

test("forensic-projection: inspectProjectionLeakage flags a forbidden field (content)", () => {
  const result = inspectProjectionLeakage({ content: "x" });
  assert.equal(result.safe, false);
  assert.ok(result.violations.some((v) => v.endsWith(":forbidden-field")));
});

test("forensic-projection: inspectProjectionLeakage flags forbidden fields case-insensitively and punctuation-stripped", () => {
  const result = inspectProjectionLeakage({ "Content-Base64": "x" });
  assert.equal(result.safe, false);
  assert.ok(result.violations.some((v) => v.endsWith(":forbidden-field")));
});

test("forensic-projection: inspectProjectionLeakage flags a secret canary leak", () => {
  const result = inspectProjectionLeakage({ x: "my-secret-value" }, ["my-secret-value"]);
  assert.equal(result.safe, false);
  assert.ok(result.violations.some((v) => v.startsWith("canary-leaked:")));
});

test("forensic-projection: inspectProjectionLeakage flags a base64-encoded canary leak", () => {
  const canary = "leakme";
  const b64 = Buffer.from(canary, "utf8").toString("base64");
  const result = inspectProjectionLeakage({ enc: b64 }, [canary]);
  assert.equal(result.safe, false);
  assert.ok(result.violations.some((v) => v.startsWith("canary-leaked:")));
});

test("forensic-projection: inspectProjectionLeakage flags an empty canary", () => {
  const result = inspectProjectionLeakage({ a: 1 }, [""]);
  assert.equal(result.safe, false);
  assert.ok(result.violations.some((v) => v.startsWith("canary-empty:")));
});

test("forensic-projection: inspectProjectionLeakage rejects a class instance as structure-invalid", () => {
  class Custom { x = 1; }
  const result = inspectProjectionLeakage(new Custom());
  assert.equal(result.safe, false);
  assert.ok(result.violations.includes("projection-structure-invalid"));
});

test("forensic-projection: inspectProjectionLeakage rejects a symbol-keyed object as structure-invalid", () => {
  const sym = Symbol("s");
  const obj: Record<symbol, unknown> = {};
  obj[sym] = 1;
  const result = inspectProjectionLeakage(obj);
  assert.equal(result.safe, false);
  assert.ok(result.violations.includes("projection-structure-invalid"));
});

test("forensic-projection: inspectProjectionLeakage rejects a cyclic object as structure-invalid", () => {
  const obj: Record<string, unknown> = { a: 1 };
  obj.self = obj;
  const result = inspectProjectionLeakage(obj);
  assert.equal(result.safe, false);
  assert.ok(result.violations.includes("projection-structure-invalid"));
});

test("forensic-projection: inspectProjectionLeakage recurses into arrays for forbidden fields", () => {
  const result = inspectProjectionLeakage({ list: [{ secret: "x" }] });
  assert.equal(result.safe, false);
  assert.ok(result.violations.some((v) => v.endsWith(":forbidden-field")));
});

test("forensic-projection: inspectProjectionLeakage flags a non-issued projection carrying blind indexes", () => {
  const fake = validProjection([{ purpose: "actor-correlation", digest: "0".repeat(64) }]);
  const result = inspectProjectionLeakage(fake);
  assert.equal(result.safe, false);
  assert.ok(result.violations.includes("blind-index-unissued"));
});

test("forensic-projection: inspectProjectionLeakage returns violations deduplicated and sorted", () => {
  const result = inspectProjectionLeakage({ content: "a", secret: "b" });
  const codes = result.violations;
  assert.equal(codes.length, [...new Set(codes)].length, "violations must be deduplicated");
  assert.deepEqual([...codes], [...codes].sort(), "violations must be sorted");
});

// ---------------------------------------------------------------------------
// projectForensicEvent — untrusted-input rejection
// ---------------------------------------------------------------------------

test("forensic-projection: projectForensicEvent rejects a non-object event", () => {
  assert.throws(() => projectForensicEvent("not-an-event"), InputError);
});

test("forensic-projection: projectForensicEvent rejects null", () => {
  assert.throws(() => projectForensicEvent(null), InputError);
});

test("forensic-projection: projectForensicEvent rejects a Proxy event", () => {
  const proxied = new Proxy({}, {});
  assert.throws(() => projectForensicEvent(proxied), InputError);
});

test("forensic-projection: projectForensicEvent rejects an event missing required fields", () => {
  assert.throws(() => projectForensicEvent({ schemaVersion: "bridlewise-forensic-event/v1" }), InputError);
});

test("forensic-projection: projectForensicEvent does not throw SecurityError for mere schema invalidity", () => {
  // Schema failures surface as InputError, not SecurityError.
  try {
    projectForensicEvent({ bogus: true });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof InputError);
    assert.ok(!(error instanceof SecurityError));
  }
});
