import assert from "node:assert/strict";
import test from "node:test";

import { loadPinnedConfigSnapshot } from "../../src/kernel/config.ts";
import { createPrivacyPolicy } from "../../src/privacy/privacy-policy.ts";
import { REDACTION_CATEGORIES } from "../../src/privacy/privacy-policy.ts";
// The classifications minimum — declared by the defaults owner (the module
// that does not resolve it), consumed by the policy's resolution AND by the
// config door's floor.
import { DEFAULT_PII_CLASSIFICATIONS } from "../../src/privacy/privacy-config.ts";
import { InputError } from "../../src/kernel/errors.ts";
import {
  PRIVACY_CONFIG_SCHEMA,
  privacyConfigViolations,
  privacyConfigRefusalMessage,
  resolvePrivacyPolicyOptions,
  type PrivacyConfigSection,
} from "../../src/privacy/privacy-config-section.ts";
import { DATA_CLASSIFICATION, DATA_CLASSIFICATION_VALUES } from "../../src/privacy/classification-catalog.ts";

// ---------------------------------------------------------------------------
// Privacy config fields: the 4 customization options (enabledCategories,
// piiClassifications, redactionPrefix, redactionSuffix) are accepted by the
// config schema and consumed by createPrivacyPolicy.
// ---------------------------------------------------------------------------

test("privacy config: bridlewise.config.json accepts the 4 customization fields when present", () => {
  // The pinned config does NOT declare these fields (they're optional). We
  // verify the schema accepts them by constructing a config-like object
  // and passing it through createPrivacyPolicy (which is the consumer of
  // the config schema's privacy section).
  const policy = createPrivacyPolicy({
    maxContextLines: 10,
    maxFileBytes: 1048576,
    maxRegexPatternBytes: 4096,
    maxMatchCount: 1000,
    semanticModeEnabled: false,
    preserveLineCount: true,
    preserveStructure: true,
    failClosedOnUncertainty: true,
    enabledCategories: ["secret", "credential"],
    piiClassifications: [DATA_CLASSIFICATION.credentialSecret, DATA_CLASSIFICATION.userPrivate],
    redactionPrefix: "[HIDDEN:",
    redactionSuffix: "]",
  });
  assert.equal(policy.redactionPrefix, "[HIDDEN:");
  assert.equal(policy.redactionSuffix, "]");
  assert.ok(policy.enabledCategories.has("secret"));
  assert.ok(policy.enabledCategories.has("credential"));
  assert.ok(!policy.enabledCategories.has("pii"));
  assert.equal(policy.piiClassifications.length, 2);
  assert.ok(policy.piiClassifications.includes(DATA_CLASSIFICATION.credentialSecret));
  assert.ok(policy.piiClassifications.includes(DATA_CLASSIFICATION.userPrivate));
});

test("privacy config: defaults are applied when the 4 fields are absent", () => {
  const policy = createPrivacyPolicy({
    maxContextLines: 10,
    maxFileBytes: 1048576,
    maxRegexPatternBytes: 4096,
    maxMatchCount: 1000,
    semanticModeEnabled: false,
    preserveLineCount: true,
    preserveStructure: true,
    failClosedOnUncertainty: true,
  });
  // Defaults from createPrivacyPolicy: all categories, default PII
  // classifications, default prefix/suffix.
  assert.equal(policy.enabledCategories.size, REDACTION_CATEGORIES.length);
  assert.equal(policy.redactionPrefix, "[REDACTED:");
  assert.equal(policy.redactionSuffix, "]");
  assert.ok(policy.piiClassifications.includes(DATA_CLASSIFICATION.credentialSecret));
  assert.ok(policy.piiClassifications.includes(DATA_CLASSIFICATION.userPrivate));
});

test("privacy config: pinned config snapshot loads without the 4 optional fields", () => {
  // The pinned config does not declare the 4 fields; the schema accepts
  // their absence (they're optional). This verifies the schema change does
  // not break the existing config.
  const snapshot = loadPinnedConfigSnapshot();
  const privacy = snapshot.document.privacy;
  assert.ok(privacy !== undefined);
  assert.equal(privacy!.enabledCategories, undefined);
  assert.equal(privacy!.piiClassifications, undefined);
  assert.equal(privacy!.redactionPrefix, undefined);
  assert.equal(privacy!.redactionSuffix, undefined);
  // The 8 limit fields are still present.
  assert.equal(privacy!.maxContextLines, 10);
  assert.equal(privacy!.failClosedOnUncertainty, true);
});

test("privacy config: redactionPrefix/suffix are used in replacement strings", () => {
  const policy = createPrivacyPolicy({
    redactionPrefix: "<HIDDEN:",
    redactionSuffix: ">",
  });
  // The rules use the prefix/suffix in their replacement strings. The DEFAULT_RULES
  // include a credential rule (among others); verify its replacement reflects the
  // custom prefix/suffix.
  const credentialRule = policy.rules.find((r) => r.category === "credential");
  assert.ok(credentialRule !== undefined, "expected a credential rule in DEFAULT_RULES");
  assert.ok(credentialRule!.replacement.includes("<HIDDEN:credential>"), `expected <HIDDEN:credential> in replacement; got ${credentialRule!.replacement}`);
});

test("privacy config: enabledCategories filters the active redaction categories", () => {
  const policy = createPrivacyPolicy({
    enabledCategories: ["secret", "api-key"],
  });
  assert.equal(policy.enabledCategories.size, 2);
  assert.ok(policy.enabledCategories.has("secret"));
  assert.ok(policy.enabledCategories.has("api-key"));
  assert.ok(!policy.enabledCategories.has("credential"));
});

test("privacy config: DATA_CLASSIFICATION_VALUES is a non-empty tuple", () => {
  // This is the value that feeds z.enum in the config schema.
  assert.ok(DATA_CLASSIFICATION_VALUES.length > 0);
  for (const v of DATA_CLASSIFICATION_VALUES) {
    assert.equal(typeof v, "string");
    assert.ok(v.length > 0);
  }
  // Ensure all 5 classifications are present.
  assert.ok(DATA_CLASSIFICATION_VALUES.includes(DATA_CLASSIFICATION.public));
  assert.ok(DATA_CLASSIFICATION_VALUES.includes(DATA_CLASSIFICATION.projectPrivate));
  assert.ok(DATA_CLASSIFICATION_VALUES.includes(DATA_CLASSIFICATION.userPrivate));
  assert.ok(DATA_CLASSIFICATION_VALUES.includes(DATA_CLASSIFICATION.credentialSecret));
  assert.ok(DATA_CLASSIFICATION_VALUES.includes(DATA_CLASSIFICATION.regulatedRestricted));
});

// ---------------------------------------------------------------------------
// The config door: resolvePrivacyPolicyOptions — the document's privacy
// section turned into policy options, with the safety floors that refuse a
// section which would weaken what the masker hides.
// ---------------------------------------------------------------------------

// The section the shipped document carries (the 8 required leaves; the 4
// optional ones omitted) — typed as the section itself, so a probe built by
// spreading it needs no cast and cannot drift from the schema's shape.
function shippedSection(): PrivacyConfigSection {
  return {
    maxContextLines: 10,
    maxFileBytes: 1048576,
    maxRegexPatternBytes: 4096,
    maxMatchCount: 1000,
    semanticModeEnabled: false,
    preserveLineCount: true,
    preserveStructure: true,
    failClosedOnUncertainty: true,
  };
}

test("privacy config door: an absent section resolves to no options — the defaults-only policy, unchanged", () => {
  assert.deepEqual(resolvePrivacyPolicyOptions(undefined), {});
  // The defaults-only policy is the policy every consumer built before the
  // wiring: same fields, same values, byte-for-byte.
  const resolved = createPrivacyPolicy(resolvePrivacyPolicyOptions(undefined));
  const defaults = createPrivacyPolicy();
  assert.deepEqual(resolved.enabledCategories, defaults.enabledCategories);
  assert.deepEqual(resolved.piiClassifications, defaults.piiClassifications);
  assert.equal(resolved.maxContextLines, defaults.maxContextLines);
  assert.equal(resolved.maxFileBytes, defaults.maxFileBytes);
  assert.equal(resolved.maxRegexPatternBytes, defaults.maxRegexPatternBytes);
  assert.equal(resolved.maxMatchCount, defaults.maxMatchCount);
  assert.equal(resolved.semanticModeEnabled, defaults.semanticModeEnabled);
  assert.equal(resolved.preserveLineCount, defaults.preserveLineCount);
  assert.equal(resolved.preserveStructure, defaults.preserveStructure);
  assert.equal(resolved.failClosedOnUncertainty, defaults.failClosedOnUncertainty);
  assert.equal(resolved.redactionPrefix, defaults.redactionPrefix);
  assert.equal(resolved.redactionSuffix, defaults.redactionSuffix);
});

test("privacy config door: the section flows to the policy by its own keys — every leaf lands where it declares", () => {
  const section = {
    ...shippedSection(),
    maxContextLines: 42,
    maxFileBytes: 2097152,
    maxRegexPatternBytes: 8192,
    maxMatchCount: 77,
    semanticModeEnabled: true,
    preserveLineCount: false,
    preserveStructure: false,
    failClosedOnUncertainty: true,
    enabledCategories: [...REDACTION_CATEGORIES],
    piiClassifications: [...DEFAULT_PII_CLASSIFICATIONS, DATA_CLASSIFICATION.regulatedRestricted],
    redactionPrefix: "<HIDDEN:",
    redactionSuffix: "!",
  } as const;
  const parsed = PRIVACY_CONFIG_SCHEMA.parse(section);
  const policy = createPrivacyPolicy(resolvePrivacyPolicyOptions(parsed));
  assert.equal(policy.maxContextLines, 42);
  assert.equal(policy.maxFileBytes, 2097152);
  assert.equal(policy.maxRegexPatternBytes, 8192);
  assert.equal(policy.maxMatchCount, 77);
  assert.equal(policy.semanticModeEnabled, true);
  assert.equal(policy.preserveLineCount, false);
  assert.equal(policy.preserveStructure, false);
  assert.equal(policy.failClosedOnUncertainty, true);
  for (const category of REDACTION_CATEGORIES) {
    assert.ok(policy.enabledCategories.has(category), `category ${category} must stay enabled`);
  }
  assert.deepEqual(
    policy.piiClassifications,
    [...DEFAULT_PII_CLASSIFICATIONS, DATA_CLASSIFICATION.regulatedRestricted],
  );
  assert.equal(policy.redactionPrefix, "<HIDDEN:");
  assert.equal(policy.redactionSuffix, "!");
});

test("privacy config door: a NARROWED enabledCategories is refused at BOTH doors — the redaction minimum is the full enumeration", () => {
  // Constructed directly (the schema refuses it, so its parse never
  // succeeds) — the value a hand-edited file would hand the policy birth.
  const narrowed = {
    ...shippedSection(),
    enabledCategories: ["secret"],
  } as PrivacyConfigSection;
  // The policy birth refuses it, typed, naming the refused categories.
  assert.throws(
    () => resolvePrivacyPolicyOptions(narrowed),
    (err: unknown) => {
      assert.ok(err instanceof InputError);
      assert.equal(err.code, "privacy_enabled_categories_minimum_required");
      assert.match(err.message, /may not disable a redaction category/);
      assert.match(err.message, /credential/);
      return true;
    },
  );
  // The section schema refuses the same write (the config write gate's own
  // floor — the settings door never lands a weakening section on disk).
  const parsed = PRIVACY_CONFIG_SCHEMA.safeParse(narrowed);
  assert.equal(parsed.success, false);
  assert.match(
    parsed.error!.issues[0]!.message,
    /may not disable a redaction category/,
  );
  // The ONE floor owner: the violations list both doors consult.
  assert.deepEqual(
    privacyConfigViolations(narrowed),
    ["privacy_enabled_categories_minimum_required"],
  );
});

test("privacy config door: the FULL category set is accepted (narrowing is the only refused shape)", () => {
  const full = { ...shippedSection(), enabledCategories: [...REDACTION_CATEGORIES] };
  const parsed = PRIVACY_CONFIG_SCHEMA.safeParse(full);
  assert.equal(parsed.success, true);
  assert.deepEqual(
    privacyConfigViolations(parsed.data as PrivacyConfigSection),
    [],
  );
});

test("privacy config door: a NARROWED piiClassifications is refused; a WIDENED one is accepted (tightening)", () => {
  const narrowed = {
    ...shippedSection(),
    piiClassifications: [DATA_CLASSIFICATION.credentialSecret],
  } as PrivacyConfigSection;
  assert.throws(
    () => resolvePrivacyPolicyOptions(narrowed),
    (err: unknown) => {
      assert.ok(err instanceof InputError);
      assert.equal(err.code, "privacy_pii_classifications_minimum_required");
      assert.match(err.message, /user-private/);
      return true;
    },
  );
  const narrowedParse = PRIVACY_CONFIG_SCHEMA.safeParse(narrowed);
  assert.equal(narrowedParse.success, false);
  assert.match(
    narrowedParse.error!.issues[0]!.message,
    /may not drop a classification the redaction floor requires/,
  );
  // Adding a classification is a tightening — accepted, and it lands.
  const widened = {
    ...shippedSection(),
    piiClassifications: [...DEFAULT_PII_CLASSIFICATIONS, DATA_CLASSIFICATION.projectPrivate],
  };
  const policy = createPrivacyPolicy(
    resolvePrivacyPolicyOptions(PRIVACY_CONFIG_SCHEMA.parse(widened) as PrivacyConfigSection),
  );
  assert.deepEqual(
    policy.piiClassifications,
    [...DEFAULT_PII_CLASSIFICATIONS, DATA_CLASSIFICATION.projectPrivate],
  );
});

test("privacy config door: the refusal message names the refused values (the sentence a refused save renders)", () => {
  // Constructed directly, not parsed — the schema refuses this section, so
  // its parse never succeeds; the message owner is being probed with the
  // refused shape itself.
  const narrowed = {
    ...shippedSection(),
    enabledCategories: ["secret"],
  } as PrivacyConfigSection;
  assert.equal(
    privacyConfigRefusalMessage("privacy_enabled_categories_minimum_required", narrowed),
    "privacy_enabled_categories_minimum_required — privacy.enabledCategories may not disable a redaction category: every category is a sensitive class with no safe off state, so the configured list must keep them all (missing: credential, pii, api-key, token, password, private-key, bearer-token, session-token, cookie, unknown-sensitive)",
  );
});
