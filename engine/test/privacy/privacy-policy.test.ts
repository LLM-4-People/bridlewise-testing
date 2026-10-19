import assert from "node:assert/strict";
import test from "node:test";

import { DATA_CLASSIFICATION } from "../../src/privacy/classification-catalog.ts";
import {
  classificationRequiresRedaction,
  classificationToCategory,
  createPrivacyPolicy,
  DEFAULT_PRIVACY_POLICY,
  PRIVACY_POLICY_SCHEMA_VERSION,
  REDACTION_CATEGORIES,
  redactionReplacement,
  signalIdToCategory,
} from "../../src/privacy/privacy-policy.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { PII_TYPES, piiTypeCategory } from "../../src/privacy/pii-registry.ts";

// ---------------------------------------------------------------------------
// Section 1: Schema version and category registry
// ---------------------------------------------------------------------------

test("PRIVACY_POLICY_SCHEMA_VERSION is a stable versioned string", () => {
  assert.equal(typeof PRIVACY_POLICY_SCHEMA_VERSION, "string");
  assert.ok(PRIVACY_POLICY_SCHEMA_VERSION.startsWith("bridlewise-privacy-policy/v"));
});

test("REDACTION_CATEGORIES is a frozen readonly array with expected entries", () => {
  assert.ok(Object.isFrozen(REDACTION_CATEGORIES));
  assert.ok(REDACTION_CATEGORIES.includes("secret"));
  assert.ok(REDACTION_CATEGORIES.includes("credential"));
  assert.ok(REDACTION_CATEGORIES.includes("pii"));
  assert.ok(REDACTION_CATEGORIES.includes("api-key"));
  assert.ok(REDACTION_CATEGORIES.includes("token"));
  assert.ok(REDACTION_CATEGORIES.includes("password"));
  assert.ok(REDACTION_CATEGORIES.includes("private-key"));
  assert.ok(REDACTION_CATEGORIES.includes("bearer-token"));
  assert.ok(REDACTION_CATEGORIES.includes("session-token"));
  assert.ok(REDACTION_CATEGORIES.includes("cookie"));
  assert.ok(REDACTION_CATEGORIES.includes("unknown-sensitive"));
});

test("REDACTION_CATEGORIES has no duplicates", () => {
  const set = new Set<string>(REDACTION_CATEGORIES);
  assert.equal(set.size, REDACTION_CATEGORIES.length);
});

// The marker's default value is asserted through the only door that can now
// supply it — the resolved policy — in section 4 below. The constants
// themselves are module-private to their owner on purpose: a default is an
// input to resolution, and a test that reads it directly is the same read a
// consumer must never make.

// ---------------------------------------------------------------------------
// Section 2: signalIdToCategory mapping
// ---------------------------------------------------------------------------

test("signalIdToCategory maps makora-key to api-key", () => {
  assert.equal(signalIdToCategory("makora-key"), "api-key");
});

test("signalIdToCategory maps token-prefix to token", () => {
  assert.equal(signalIdToCategory("token-prefix"), "token");
});

test("signalIdToCategory maps aws-access-key to api-key", () => {
  assert.equal(signalIdToCategory("aws-access-key"), "api-key");
});

test("signalIdToCategory maps bearer-token to bearer-token", () => {
  assert.equal(signalIdToCategory("bearer-token"), "bearer-token");
});

test("an id no catalog or registry holds is a TYPED error, never a fallback category (wf1b2-design SC-1/SC-2)", () => {
  const unknown = (error: unknown): boolean => error instanceof InputError && error.code === "redaction_signal_unknown";
  assert.throws(() => signalIdToCategory("no-such-signal"), unknown);
  assert.throws(() => piiTypeCategory("no-such-type"), unknown);
});

test("every registered type declares its redaction category (a real one), and the intelligence spans' types map as before", () => {
  for (const type of PII_TYPES) assert.ok((REDACTION_CATEGORIES as readonly string[]).includes(type.category), `${type.id}: ${type.category}`);
  assert.equal(piiTypeCategory("known-secret"), "secret");
  for (const id of ["payment-card", "bank-account", "bank-routing", "national-id", "email-address", "ip-address", "phone-number", "declared-personal-identifier"]) {
    assert.equal(piiTypeCategory(id), "pii", id);
  }
  for (const id of ["high-entropy-value", "declared-credential"]) assert.equal(piiTypeCategory(id), "credential", id);
});

test("signalIdToCategory maps private-key to private-key", () => {
  assert.equal(signalIdToCategory("private-key"), "private-key");
});

test("signalIdToCategory maps credential-assignment to credential", () => {
  assert.equal(signalIdToCategory("credential-assignment"), "credential");
});

test("signalIdToCategory refuses a signal id the catalog does not hold — a typed error, never a fallback category", () => {
  // A new signal that forgot its catalog entry used to become
  // `unknown-sensitive` here and `credential` in the redactor (wf1b2-design SC-2).
  for (const id of ["nonexistent-signal", ""]) {
    assert.throws(() => signalIdToCategory(id), (error: unknown) => error instanceof InputError && error.code === "redaction_signal_unknown", id);
  }
});

// ---------------------------------------------------------------------------
// Section 3: classificationToCategory mapping
// ---------------------------------------------------------------------------

test("classificationToCategory maps credentialSecret to secret", () => {
  assert.equal(classificationToCategory(DATA_CLASSIFICATION.credentialSecret), "secret");
});

test("classificationToCategory maps userPrivate to pii", () => {
  assert.equal(classificationToCategory(DATA_CLASSIFICATION.userPrivate), "pii");
});

test("classificationToCategory maps regulatedRestricted to pii", () => {
  assert.equal(classificationToCategory(DATA_CLASSIFICATION.regulatedRestricted), "pii");
});

test("classificationToCategory maps public to unknown-sensitive", () => {
  assert.equal(classificationToCategory(DATA_CLASSIFICATION.public), "unknown-sensitive");
});

test("classificationToCategory maps projectPrivate to unknown-sensitive", () => {
  assert.equal(classificationToCategory(DATA_CLASSIFICATION.projectPrivate), "unknown-sensitive");
});

// ---------------------------------------------------------------------------
// Section 4: createPrivacyPolicy defaults
// ---------------------------------------------------------------------------

test("createPrivacyPolicy returns a frozen object", () => {
  const policy = createPrivacyPolicy();
  assert.ok(Object.isFrozen(policy));
});

test("createPrivacyPolicy has correct schema version", () => {
  const policy = createPrivacyPolicy();
  assert.equal(policy.schemaVersion, PRIVACY_POLICY_SCHEMA_VERSION);
});

test("default policy has all redaction categories enabled", () => {
  const policy = createPrivacyPolicy();
  for (const cat of REDACTION_CATEGORIES) {
    assert.ok(policy.enabledCategories.has(cat), `category ${cat} should be enabled`);
  }
});

test("default policy has credentialSecret and userPrivate as PII classifications", () => {
  const policy = createPrivacyPolicy();
  assert.ok(policy.piiClassifications.includes(DATA_CLASSIFICATION.credentialSecret));
  assert.ok(policy.piiClassifications.includes(DATA_CLASSIFICATION.userPrivate));
});

test("default policy maxContextLines is 10", () => {
  const policy = createPrivacyPolicy();
  assert.equal(policy.maxContextLines, 10);
});

test("default policy maxFileBytes is 1MB", () => {
  const policy = createPrivacyPolicy();
  assert.equal(policy.maxFileBytes, 1_048_576);
});

test("default policy maxRegexPatternBytes is 4096", () => {
  const policy = createPrivacyPolicy();
  assert.equal(policy.maxRegexPatternBytes, 4_096);
});

test("default policy maxMatchCount is 1000", () => {
  const policy = createPrivacyPolicy();
  assert.equal(policy.maxMatchCount, 1_000);
});

test("default policy semanticModeEnabled is false (disabled before qualification)", () => {
  const policy = createPrivacyPolicy();
  assert.equal(policy.semanticModeEnabled, false);
});

test("default policy preserveLineCount is true", () => {
  const policy = createPrivacyPolicy();
  assert.equal(policy.preserveLineCount, true);
});

test("default policy preserveStructure is true", () => {
  const policy = createPrivacyPolicy();
  assert.equal(policy.preserveStructure, true);
});

test("default policy failClosedOnUncertainty is TRUE — the secure default, the same as the config document's", () => {
  // The code default used to be false while bridlewise.config.json said true
  // (cfg-audit §0): a caller without the config silently ran fail-open.
  assert.equal(createPrivacyPolicy().failClosedOnUncertainty, true);
  assert.equal(createPrivacyPolicy({ failClosedOnUncertainty: false }).failClosedOnUncertainty, false, "fail-open is written down, never defaulted");
});

test("default policy redactionPrefix is [REDACTED:", () => {
  const policy = createPrivacyPolicy();
  assert.equal(policy.redactionPrefix, "[REDACTED:");
});

test("default policy redactionSuffix is ]", () => {
  const policy = createPrivacyPolicy();
  assert.equal(policy.redactionSuffix, "]");
});

// ---------------------------------------------------------------------------
// Section 5: createPrivacyPolicy custom options
// ---------------------------------------------------------------------------

test("createPrivacyPolicy accepts custom enabledCategories", () => {
  const policy = createPrivacyPolicy({ enabledCategories: ["secret", "pii"] });
  assert.ok(policy.enabledCategories.has("secret"));
  assert.ok(policy.enabledCategories.has("pii"));
  assert.ok(!policy.enabledCategories.has("api-key"));
});

test("createPrivacyPolicy accepts custom maxContextLines", () => {
  const policy = createPrivacyPolicy({ maxContextLines: 5 });
  assert.equal(policy.maxContextLines, 5);
});

test("createPrivacyPolicy accepts custom maxFileBytes", () => {
  const policy = createPrivacyPolicy({ maxFileBytes: 65536 });
  assert.equal(policy.maxFileBytes, 65536);
});

test("createPrivacyPolicy accepts custom maxRegexPatternBytes", () => {
  const policy = createPrivacyPolicy({ maxRegexPatternBytes: 512 });
  assert.equal(policy.maxRegexPatternBytes, 512);
});

test("createPrivacyPolicy accepts custom maxMatchCount", () => {
  const policy = createPrivacyPolicy({ maxMatchCount: 100 });
  assert.equal(policy.maxMatchCount, 100);
});

test("createPrivacyPolicy accepts semanticModeEnabled true", () => {
  const policy = createPrivacyPolicy({ semanticModeEnabled: true });
  assert.equal(policy.semanticModeEnabled, true);
});

test("createPrivacyPolicy accepts custom redactionPrefix and suffix", () => {
  const policy = createPrivacyPolicy({ redactionPrefix: "<HIDDEN:", redactionSuffix: ">" });
  assert.equal(policy.redactionPrefix, "<HIDDEN:");
  assert.equal(policy.redactionSuffix, ">");
});

test("createPrivacyPolicy rules use custom prefix and suffix", () => {
  const policy = createPrivacyPolicy({ redactionPrefix: "<HIDDEN:", redactionSuffix: ">" });
  const rule = policy.rules.find((r) => r.signalId === "makora-key");
  assert.ok(rule);
  assert.equal(rule!.replacement, "<HIDDEN:api-key>");
});

test("createPrivacyPolicy accepts custom piiClassifications", () => {
  const policy = createPrivacyPolicy({
    piiClassifications: [DATA_CLASSIFICATION.credentialSecret],
  });
  assert.equal(policy.piiClassifications.length, 1);
  assert.equal(policy.piiClassifications[0], DATA_CLASSIFICATION.credentialSecret);
});

// ---------------------------------------------------------------------------
// Section 6: createPrivacyPolicy floor validation
// R49-V1: strengthened from bare `assert.throws(..., RangeError)` to assert the SPECIFIC typed `InputError` + its
// code + the offending field name, so a DIFFERENT RangeError cannot pass.
// ---------------------------------------------------------------------------

test("createPrivacyPolicy rejects maxContextLines below floor", () => {
  assert.throws(
    () => createPrivacyPolicy({ maxContextLines: 0 }),
    (e: unknown) => e instanceof InputError && (e as InputError).code === "privacy_policy_floor_violation" && /maxContextLines/.test((e as Error).message),
  );
});

test("createPrivacyPolicy rejects negative maxContextLines", () => {
  assert.throws(
    () => createPrivacyPolicy({ maxContextLines: -1 }),
    (e: unknown) => e instanceof InputError && (e as InputError).code === "privacy_policy_floor_violation" && /maxContextLines/.test((e as Error).message),
  );
});

test("createPrivacyPolicy rejects non-integer maxContextLines", () => {
  assert.throws(
    () => createPrivacyPolicy({ maxContextLines: 1.5 }),
    (e: unknown) => e instanceof InputError && (e as InputError).code === "privacy_policy_floor_violation" && /maxContextLines/.test((e as Error).message),
  );
});

test("createPrivacyPolicy rejects maxFileBytes below floor", () => {
  assert.throws(
    () => createPrivacyPolicy({ maxFileBytes: 0 }),
    (e: unknown) => e instanceof InputError && (e as InputError).code === "privacy_policy_floor_violation" && /maxFileBytes/.test((e as Error).message),
  );
});

test("createPrivacyPolicy rejects maxRegexPatternBytes below floor", () => {
  assert.throws(
    () => createPrivacyPolicy({ maxRegexPatternBytes: 0 }),
    (e: unknown) => e instanceof InputError && (e as InputError).code === "privacy_policy_floor_violation" && /maxRegexPatternBytes/.test((e as Error).message),
  );
});

test("createPrivacyPolicy rejects maxMatchCount below floor", () => {
  assert.throws(
    () => createPrivacyPolicy({ maxMatchCount: 0 }),
    (e: unknown) => e instanceof InputError && (e as InputError).code === "privacy_policy_floor_violation" && /maxMatchCount/.test((e as Error).message),
  );
});

// ---------------------------------------------------------------------------
// Section 7: redactionReplacement
// ---------------------------------------------------------------------------

test("redactionReplacement produces [REDACTED:secret] for secret category", () => {
  const policy = createPrivacyPolicy();
  assert.equal(redactionReplacement("secret", policy), "[REDACTED:secret]");
});

test("redactionReplacement produces [REDACTED:api-key] for api-key category", () => {
  const policy = createPrivacyPolicy();
  assert.equal(redactionReplacement("api-key", policy), "[REDACTED:api-key]");
});

test("redactionReplacement uses custom prefix and suffix", () => {
  const policy = createPrivacyPolicy({ redactionPrefix: "<H:", redactionSuffix: ">" });
  assert.equal(redactionReplacement("secret", policy), "<H:secret>");
});

test("redactionReplacement handles all category types", () => {
  const policy = createPrivacyPolicy();
  for (const cat of REDACTION_CATEGORIES) {
    const replacement = redactionReplacement(cat, policy);
    assert.ok(replacement.includes(cat), `replacement should contain category: ${cat}`);
    assert.ok(replacement.startsWith(policy.redactionPrefix));
    assert.ok(replacement.endsWith(policy.redactionSuffix));
  }
});

// ---------------------------------------------------------------------------
// Section 8: classificationRequiresRedaction
// ---------------------------------------------------------------------------

test("classificationRequiresRedaction returns true for credentialSecret", () => {
  const policy = createPrivacyPolicy();
  assert.equal(classificationRequiresRedaction(DATA_CLASSIFICATION.credentialSecret, policy), true);
});

test("classificationRequiresRedaction returns true for userPrivate", () => {
  const policy = createPrivacyPolicy();
  assert.equal(classificationRequiresRedaction(DATA_CLASSIFICATION.userPrivate, policy), true);
});

test("classificationRequiresRedaction returns false for public", () => {
  const policy = createPrivacyPolicy();
  assert.equal(classificationRequiresRedaction(DATA_CLASSIFICATION.public, policy), false);
});

test("classificationRequiresRedaction returns false for projectPrivate by default", () => {
  const policy = createPrivacyPolicy();
  assert.equal(classificationRequiresRedaction(DATA_CLASSIFICATION.projectPrivate, policy), false);
});

test("classificationRequiresRedaction returns true for projectPrivate when included", () => {
  const policy = createPrivacyPolicy({
    piiClassifications: [DATA_CLASSIFICATION.projectPrivate],
  });
  assert.equal(classificationRequiresRedaction(DATA_CLASSIFICATION.projectPrivate, policy), true);
});

// ---------------------------------------------------------------------------
// Section 9: DEFAULT_PRIVACY_POLICY singleton
// ---------------------------------------------------------------------------

test("DEFAULT_PRIVACY_POLICY is a frozen PrivacyPolicy", () => {
  assert.ok(Object.isFrozen(DEFAULT_PRIVACY_POLICY));
  assert.equal(DEFAULT_PRIVACY_POLICY.schemaVersion, PRIVACY_POLICY_SCHEMA_VERSION);
});

test("DEFAULT_PRIVACY_POLICY has semanticModeEnabled false", () => {
  assert.equal(DEFAULT_PRIVACY_POLICY.semanticModeEnabled, false);
});

test("DEFAULT_PRIVACY_POLICY has rules for all default signals", () => {
  const signalIds = DEFAULT_PRIVACY_POLICY.rules.map((r) => r.signalId);
  assert.ok(signalIds.includes("makora-key"));
  assert.ok(signalIds.includes("token-prefix"));
  assert.ok(signalIds.includes("aws-access-key"));
  assert.ok(signalIds.includes("bearer-token"));
  assert.ok(signalIds.includes("private-key"));
  assert.ok(signalIds.includes("credential-assignment"));
});

test("DEFAULT_PRIVACY_POLICY rules all have [REDACTED:...] replacements", () => {
  for (const rule of DEFAULT_PRIVACY_POLICY.rules) {
    assert.ok(
      rule.replacement.startsWith("[REDACTED:"),
      `rule ${rule.signalId} replacement should start with [REDACTED:`,
    );
    assert.ok(
      rule.replacement.endsWith("]"),
      `rule ${rule.signalId} replacement should end with ]`,
    );
  }
});
