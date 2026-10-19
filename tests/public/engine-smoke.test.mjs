import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalJson, canonicalHash } from "../../engine/src/kernel/integrity.ts";
import { DEFAULT_PRIVACY_POLICY } from "../../engine/src/privacy/privacy-policy.ts";
import { redactText } from "../../engine/src/privacy/redaction-engine.ts";

test("canonical JSON is stable across key order and hashes the same value", () => {
  const a = canonicalJson({ b: 1, a: 2 });
  const b = canonicalJson({ a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(canonicalHash({ a: 2, b: 1 }), canonicalHash({ b: 1, a: 2 }));
});

test("the privacy owner redacts a provider-shaped key before display", () => {
  const secret = `sk-${"A".repeat(24)}`;
  const result = redactText(`api_key = "${secret}"`, DEFAULT_PRIVACY_POLICY);
  assert.equal(result.spanCount > 0, true);
  assert.equal(result.redactedText.includes(secret), false);
});
