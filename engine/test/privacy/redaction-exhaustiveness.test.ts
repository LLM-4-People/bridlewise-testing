import assert from "node:assert/strict";
import test from "node:test";

import { detectSensitiveSpans } from "../../src/privacy/redaction-engine.ts";
import {
  REDACTION_CATEGORIES,
  createPrivacyPolicy,
  signalIdToCategory,
  type RedactionCategory,
} from "../../src/privacy/privacy-policy.ts";
import { SECRET_TEXT_SIGNAL_CATALOG } from "../../src/privacy/secret-signals.ts";

/**
 * Redaction pattern exhaustiveness (GAP-15).
 *
 * The redaction engine consumes `SECRET_TEXT_SIGNAL_CATALOG` and maps each
 * signal id to a `RedactionCategory` via `signalIdToCategory`. This test
 * verifies two invariants:
 *
 * 1. Every category that the text detector CAN produce is exercised by at
 * least one input pattern, and is suppressed when that category is
 * disabled in the policy (`enabledCategories`).
 * 2. The set of categories reachable from the catalog is exactly the set
 * derived from `signalIdToCategory`. Categories present in
 * `REDACTION_CATEGORIES` but with no producing signal (secret, pii,
 * password, session-token, cookie, unknown-sensitive) are encoded as
 * a known, typed gap so that any future signal addition requires an
 * explicit test update rather than silently widening the surface.
 */

// One input per catalog signal that matches its admission regex. Each is
// chosen to match exactly one signal so the category attribution is
// unambiguous (overlap resolution does not merge categories here).
const SIGNAL_SAMPLES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["makora-key", "key = mbh_1234567890abcdefghijk"],
  ["token-prefix", "value sk_abcdefghijklmnopqrstuvwx"],
  ["aws-access-key", "AKIAIOSFODNN7EXAMPLE"],
  ["bearer-token", "Bearer abcdefghijklmnopqrstuv1234567890"],
  ["private-key", "-----BEGIN RSA PRIVATE KEY-----"],
  ["credential-assignment", 'api_key = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA=="'],
]);

const ALL_POLICY = createPrivacyPolicy();

function policyWith(categories: readonly RedactionCategory[]): ReturnType<typeof createPrivacyPolicy> {
  return createPrivacyPolicy({ enabledCategories: categories });
}

function categoriesFromSpans(spans: readonly { category: RedactionCategory }[]): Set<RedactionCategory> {
  return new Set(spans.map((s) => s.category));
}

test("Redaction exhaustiveness: every catalog signal maps to a known RedactionCategory", () => {
  for (const signal of SECRET_TEXT_SIGNAL_CATALOG) {
    const category = signalIdToCategory(signal.id);
    assert.ok(
      (REDACTION_CATEGORIES as readonly string[]).includes(category),
      `signal ${signal.id} maps to unknown category ${category}`,
    );
  }
});

test("Redaction exhaustiveness: each reachable category is produced by a sample input when enabled", () => {
  const reachable = new Set<RedactionCategory>();
  for (const [signalId, sample] of SIGNAL_SAMPLES) {
    const category = signalIdToCategory(signalId);
    reachable.add(category);
    const spans = detectSensitiveSpans(sample, ALL_POLICY);
    assert.ok(
      spans.some((s) => s.category === category),
      `sample for signal ${signalId} (category ${category}) produced no span; got: ${spans.map((s) => s.category).join(",")}`,
    );
  }
  assert.deepEqual(
    [...reachable].sort(),
    ["api-key", "bearer-token", "credential", "private-key", "token"],
  );
});

test("Redaction exhaustiveness: disabling a category suppresses its spans", () => {
  for (const [signalId, sample] of SIGNAL_SAMPLES) {
    const category = signalIdToCategory(signalId);
    const withoutIt = policyWith((REDACTION_CATEGORIES as readonly RedactionCategory[]).filter((c) => c !== category));
    const spans = detectSensitiveSpans(sample, withoutIt);
    assert.ok(
      !spans.some((s) => s.category === category),
      `disabling category ${category} (signal ${signalId}) still produced a span`,
    );
  }
});

test("Redaction exhaustiveness: enabling only one category yields only that category's spans", () => {
  const sample = "value sk_abcdefghijklmnopqrstuvwx and AKIAIOSFODNN7EXAMPLE";
  // sk_... -> token; AKIA... -> api-key. Enable only token.
  const tokenOnly = policyWith(["token"]);
  const spans = detectSensitiveSpans(sample, tokenOnly);
  assert.deepEqual([...categoriesFromSpans(spans)], ["token"]);
  // Enable only api-key.
  const apiKeyOnly = policyWith(["api-key"]);
  const spans2 = detectSensitiveSpans(sample, apiKeyOnly);
  assert.deepEqual([...categoriesFromSpans(spans2)], ["api-key"]);
});

test("Redaction exhaustiveness: no signal produces the unreachable categories (typed gap)", () => {
  const reachable = new Set<RedactionCategory>();
  for (const signal of SECRET_TEXT_SIGNAL_CATALOG) {
    reachable.add(signalIdToCategory(signal.id));
  }
  const unreachable = (REDACTION_CATEGORIES as readonly RedactionCategory[])
    .filter((c) => !reachable.has(c));
  // Encode the known gap: these categories exist in REDACTION_CATEGORIES but
  // no secret-text signal produces them via the text detector. secret/pii
  // come from the data-classification pathway; password/session-token/cookie
  // are listed as sensitive key parts but have no producing signal; and
  // unknown-sensitive is the fallback that no current signal hits.
  assert.deepEqual(
    [...unreachable].sort(),
    ["cookie", "password", "pii", "secret", "session-token", "unknown-sensitive"],
  );
});
