import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { readSourceView } from "../../scripts/verification/source-view.ts";
import { SENSITIVE_KEY_PARTS } from "../../src/privacy/secret-signals.ts";
import {
  PERFORMANCE_CONFIG_SCHEMA,
  PERFORMANCE_CONFIG_SCHEMA_VERSION,
  DEFAULT_PERFORMANCE_CONFIG,
  parsePerformanceConfig,
  performanceConfigViolations,
  performanceConfigRefusalMessage,
  performanceConfigHash,
  isLabelAllowed,
  redactLabelValue,
  DIAGNOSTIC_MODE_IDS,
  EXPORTER_KINDS,
  BACKPRESSURE_POLICIES,
  COLLECTOR_FAILURE_BEHAVIORS,
  ATTRIBUTION_LEVELS,
  DEFAULT_RESOURCE_DELTAS_ENABLED,
  DEFAULT_RESOURCE_SAMPLER_ENABLED,
  DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS,
  type PerformanceConfig,
  type PerformanceConfigViolationCode,
} from "../../src/performance/performance-config.ts";
import { walk } from "../../scripts/verification/source-walk.ts";
import { createDiagnosticRunner } from "../../src/performance/diagnostic-modes.ts";

test("performance-config: default config parses and has correct schema version", () => {
  const config = parsePerformanceConfig(DEFAULT_PERFORMANCE_CONFIG);
  assert.equal(config.schemaVersion, PERFORMANCE_CONFIG_SCHEMA_VERSION);
  assert.equal(config.enabled, true);
});

test("performance-config: default config has no violations", () => {
  const violations = performanceConfigViolations(DEFAULT_PERFORMANCE_CONFIG);
  assert.deepEqual([...violations], []);
});

test("performance-config: schema rejects unknown keys", () => {
  const bad = { ...DEFAULT_PERFORMANCE_CONFIG, unknownKey: true };
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse(bad));
});

test("performance-config: schema rejects negative sampling rate", () => {
  const bad = { ...DEFAULT_PERFORMANCE_CONFIG, sampling: { ...DEFAULT_PERFORMANCE_CONFIG.sampling, traceSamplingRate: -0.1 } };
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse(bad));
});

test("performance-config: schema rejects sampling rate > 1", () => {
  const bad = { ...DEFAULT_PERFORMANCE_CONFIG, sampling: { ...DEFAULT_PERFORMANCE_CONFIG.sampling, traceSamplingRate: 1.5 } };
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse(bad));
});

test("performance-config: schema rejects zero bucket count", () => {
  const bad = { ...DEFAULT_PERFORMANCE_CONFIG, histograms: { ...DEFAULT_PERFORMANCE_CONFIG.histograms, bucketCount: 0 } };
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse(bad));
});

test("performance-config: schema rejects bucket count > 1024", () => {
  const bad = { ...DEFAULT_PERFORMANCE_CONFIG, histograms: { ...DEFAULT_PERFORMANCE_CONFIG.histograms, bucketCount: 1025 } };
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse(bad));
});

test("performance-config: schema rejects negative regression budget", () => {
  const bad = { ...DEFAULT_PERFORMANCE_CONFIG, budgets: { ...DEFAULT_PERFORMANCE_CONFIG.budgets, regressionBudgetPercent: -1 } };
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse(bad));
});

test("performance-config: schema rejects regression budget > 100", () => {
  const bad = { ...DEFAULT_PERFORMANCE_CONFIG, budgets: { ...DEFAULT_PERFORMANCE_CONFIG.budgets, regressionBudgetPercent: 101 } };
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse(bad));
});

test("performance-config: semantic check detects minReps > maxReps", () => {
  const bad = { ...DEFAULT_PERFORMANCE_CONFIG, budgets: { ...DEFAULT_PERFORMANCE_CONFIG.budgets, minBenchmarkRepetitions: 50, maxBenchmarkRepetitions: 40 } };
  const parsed = PERFORMANCE_CONFIG_SCHEMA.parse(bad);
  const violations = performanceConfigViolations(parsed);
  assert.ok(violations.includes("performance_config_benchmark_repetition_range_invalid"));
});

test("performance-config: schema rejects invalid diagnostic mode ids", () => {
  const bad = { ...DEFAULT_PERFORMANCE_CONFIG, diagnosticModes: { ...DEFAULT_PERFORMANCE_CONFIG.diagnosticModes, excludedModes: ["invalid-mode"] } };
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse(bad));
});

test("performance-config: schema rejects invalid exporter kinds", () => {
  const bad = { ...DEFAULT_PERFORMANCE_CONFIG, exporters: { ...DEFAULT_PERFORMANCE_CONFIG.exporters, enabledExporters: ["invalid-exporter"] } };
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse(bad));
});

test("performance-config: schema rejects invalid backpressure policy", () => {
  const bad = { ...DEFAULT_PERFORMANCE_CONFIG, backpressure: { ...DEFAULT_PERFORMANCE_CONFIG.backpressure, policy: "invalid-policy" } };
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse(bad));
});

test("performance-config: the allowlist fields are GONE — populating them fails validation", () => {
  // Deny-by-default posture: `scope.includedModules`,
  // `scope.includeArchitectureManifestFunctions`, `labelSchema.allowedLabelKeys`
  // and `diagnosticModes.enabledModes` were allowlists — a module, label or
  // mode not named in them was silently out of scope. The strict schema now
  // REFUSES each field by name, so an operator (or a stale config) cannot
  // resurrect the allowlist posture by accident.
  const resurrections: readonly { section: string; field: string; value: unknown }[] = [
    { section: "scope", field: "includedModules", value: ["kernel"] },
    { section: "scope", field: "includeArchitectureManifestFunctions", value: true },
    { section: "labelSchema", field: "allowedLabelKeys", value: ["runId"] },
    { section: "diagnosticModes", field: "enabledModes", value: ["cpu"] },
  ];
  for (const { section, field, value } of resurrections) {
    const bad = {
      ...DEFAULT_PERFORMANCE_CONFIG,
      [section]: { ...(DEFAULT_PERFORMANCE_CONFIG as unknown as Record<string, Record<string, unknown>>)[section]!, [field]: value },
    };
    assert.throws(
      () => PERFORMANCE_CONFIG_SCHEMA.parse(bad),
      (err: unknown) => {
        assert.ok(err instanceof z.ZodError, `${field}: refusal must be a ZodError`);
        assert.equal(err.issues[0]!.code, "unrecognized_keys", `${field}: refused as an unknown key`);
        assert.deepEqual(err.issues[0]!.path, [section], `${field}: the refusal names the section`);
        assert.match(err.issues[0]!.message, new RegExp(`"${field}"`, "u"),
          `${field}: the refusal message names the resurrected allowlist field`);
        return true;
      },
      `populating ${section}.${field} must fail config load`,
    );
  }
});

test("performance-config: explicit histogram bounds missing when strategy is explicit", () => {
  const config = {
    ...DEFAULT_PERFORMANCE_CONFIG,
    histograms: {
      ...DEFAULT_PERFORMANCE_CONFIG.histograms,
      bucketStrategy: "explicit",
    },
  };
  const parsed = parsePerformanceConfig(config);
  const violations = performanceConfigViolations(parsed);
  assert.ok(violations.includes("performance_config_histogram_explicit_bounds_missing"));
});

test("performance-config: explicit histogram bounds must be monotonic", () => {
  const config = {
    ...DEFAULT_PERFORMANCE_CONFIG,
    histograms: {
      ...DEFAULT_PERFORMANCE_CONFIG.histograms,
      bucketStrategy: "explicit",
      explicitBounds: [10, 5, 20],
    },
  };
  const parsed = parsePerformanceConfig(config);
  const violations = performanceConfigViolations(parsed);
  assert.ok(violations.includes("performance_config_histogram_bounds_not_monotonic"));
});

test("performance-config: explicit histogram bounds must not exceed bucket count", () => {
  const config = {
    ...DEFAULT_PERFORMANCE_CONFIG,
    histograms: {
      ...DEFAULT_PERFORMANCE_CONFIG.histograms,
      bucketCount: 3,
      bucketStrategy: "explicit",
      explicitBounds: [1, 2, 3, 4, 5],
    },
  };
  const parsed = parsePerformanceConfig(config);
  const violations = performanceConfigViolations(parsed);
  assert.ok(violations.includes("performance_config_histogram_bounds_exceed_bucket_count"));
});

test("performance-config: label length exceeding privacy cap is detected", () => {
  const config = {
    ...DEFAULT_PERFORMANCE_CONFIG,
    labelSchema: {
      ...DEFAULT_PERFORMANCE_CONFIG.labelSchema,
      maxLabelLength: 500,
    },
    privacy: {
      ...DEFAULT_PERFORMANCE_CONFIG.privacy,
      maxLabelValueLength: 256,
    },
  };
  const parsed = parsePerformanceConfig(config);
  const violations = performanceConfigViolations(parsed);
  assert.ok(violations.includes("performance_config_label_length_exceeds_privacy_cap"));
});

test("performance-config: duplicate exporters are detected", () => {
  const config = {
    ...DEFAULT_PERFORMANCE_CONFIG,
    exporters: {
      ...DEFAULT_PERFORMANCE_CONFIG.exporters,
      enabledExporters: ["timeline", "timeline"],
    },
  };
  const parsed = parsePerformanceConfig(config);
  const violations = performanceConfigViolations(parsed);
  assert.ok(violations.includes("performance_config_exporters_not_unique"));
});

test("performance-config: duplicate diagnostic modes are detected", () => {
  const config = {
    ...DEFAULT_PERFORMANCE_CONFIG,
    diagnosticModes: {
      ...DEFAULT_PERFORMANCE_CONFIG.diagnosticModes,
      excludedModes: ["cpu", "cpu"],
    },
  };
  const parsed = parsePerformanceConfig(config);
  const violations = performanceConfigViolations(parsed);
  assert.ok(violations.includes("performance_config_diagnostic_modes_not_unique"));
});

test("performance-config: disabled config has no violations", () => {
  const config = { ...DEFAULT_PERFORMANCE_CONFIG, enabled: false, scope: { ...DEFAULT_PERFORMANCE_CONFIG.scope, excludedModules: ["x"] } };
  const violations = performanceConfigViolations(config);
  assert.deepEqual([...violations], []);
});

test("performance-config: every cross-field refusal carries its machine code and the rule's own words", () => {
  // The config write gate renders the zod issue message verbatim in the
  // settings sheet, so `performanceConfigRefusalMessage` is the refusal a
  // person reads. Each rule in the checker's table must speak its sentence
  // BESIDE the machine code — a bare code named who refused and never said
  // why in the reader's words. Every rule is exercised by a firing fixture
  // and its message asserted on all three halves: the code, the separator,
  // and the sentence's own words naming the conflicting values.
  const cases: readonly {
    how: string;
    config: PerformanceConfig;
    code: PerformanceConfigViolationCode;
    words: readonly string[];
  }[] = [
    {
      // Hand-built, not parsed: the leaf schema keeps maxTracesPerScope
      // positive, so a zero quota cannot pass a parse — the checker still
      // guards the pair in case the leaf ever loosens.
      how: "sampling on with a zero trace quota",
      config: {
        ...DEFAULT_PERFORMANCE_CONFIG,
        sampling: { ...DEFAULT_PERFORMANCE_CONFIG.sampling, traceSamplingRate: 0.5, maxTracesPerScope: 0 },
      },
      code: "performance_config_sampling_rate_without_quota",
      words: ["trace sampling is on at rate 0.5", '"performance.sampling.maxTracesPerScope" is 0'],
    },
    {
      how: "explicit bucket strategy without explicit bounds",
      config: parsePerformanceConfig({
        ...DEFAULT_PERFORMANCE_CONFIG,
        histograms: { ...DEFAULT_PERFORMANCE_CONFIG.histograms, bucketStrategy: "explicit" },
      }),
      code: "performance_config_histogram_explicit_bounds_missing",
      words: ['"performance.histograms.explicitBounds" is not set'],
    },
    {
      how: "non-monotonic explicit bounds",
      config: parsePerformanceConfig({
        ...DEFAULT_PERFORMANCE_CONFIG,
        histograms: { ...DEFAULT_PERFORMANCE_CONFIG.histograms, bucketStrategy: "explicit", explicitBounds: [10, 5, 20] },
      }),
      code: "performance_config_histogram_bounds_not_monotonic",
      words: ["must rise strictly", "5 at position 1 does not exceed 10"],
    },
    {
      how: "more explicit bounds than buckets",
      config: parsePerformanceConfig({
        ...DEFAULT_PERFORMANCE_CONFIG,
        histograms: { ...DEFAULT_PERFORMANCE_CONFIG.histograms, bucketCount: 3, bucketStrategy: "explicit", explicitBounds: [1, 2, 3, 4, 5] },
      }),
      code: "performance_config_histogram_bounds_exceed_bucket_count",
      words: ["holds 5 bounds", '"performance.histograms.bucketCount" allows only 3'],
    },
    {
      how: "fewest repetitions above most repetitions",
      config: parsePerformanceConfig({
        ...DEFAULT_PERFORMANCE_CONFIG,
        budgets: { ...DEFAULT_PERFORMANCE_CONFIG.budgets, minBenchmarkRepetitions: 50, maxBenchmarkRepetitions: 40 },
      }),
      code: "performance_config_benchmark_repetition_range_invalid",
      words: [
        "the fewest benchmark repetitions",
        '"performance.budgets.minBenchmarkRepetitions" = 50',
        '"performance.budgets.maxBenchmarkRepetitions" = 40',
        "the floor must stay at or below the ceiling",
      ],
    },
    {
      how: "label maximum above the privacy cap",
      config: parsePerformanceConfig({
        ...DEFAULT_PERFORMANCE_CONFIG,
        labelSchema: { ...DEFAULT_PERFORMANCE_CONFIG.labelSchema, maxLabelLength: 500 },
        privacy: { ...DEFAULT_PERFORMANCE_CONFIG.privacy, maxLabelValueLength: 256 },
      }),
      code: "performance_config_label_length_exceeds_privacy_cap",
      words: ['"performance.labelSchema.maxLabelLength" (500)', '"performance.privacy.maxLabelValueLength" (256)'],
    },
    {
      how: "the same exporter enabled twice",
      config: parsePerformanceConfig({
        ...DEFAULT_PERFORMANCE_CONFIG,
        exporters: { ...DEFAULT_PERFORMANCE_CONFIG.exporters, enabledExporters: ["timeline", "timeline"] },
      }),
      code: "performance_config_exporters_not_unique",
      words: ["more than once (timeline)", "each exporter may be enabled only once"],
    },
    {
      how: "the same diagnostic mode excluded twice",
      config: parsePerformanceConfig({
        ...DEFAULT_PERFORMANCE_CONFIG,
        diagnosticModes: { ...DEFAULT_PERFORMANCE_CONFIG.diagnosticModes, excludedModes: ["cpu", "cpu"] },
      }),
      code: "performance_config_diagnostic_modes_not_unique",
      words: ["more than once (cpu)", "each mode may be excluded only once"],
    },
  ];
  assert.equal(cases.length, 8, "one firing fixture per cross-field rule");
  for (const { how, config, code, words } of cases) {
    const violations = performanceConfigViolations(config);
    assert.ok(violations.includes(code), `${how}: the checker fires`);
    const message = performanceConfigRefusalMessage(code, config);
    assert.ok(
      message.startsWith(`${code} — `),
      `${how}: the machine code rides beside the sentence, never alone`,
    );
    for (const word of words) {
      assert.ok(message.includes(word), `${how}: the sentence names "${word}"`);
    }
  }
});

test("performance-config: config hash is deterministic", () => {
  const hash1 = performanceConfigHash(DEFAULT_PERFORMANCE_CONFIG);
  const hash2 = performanceConfigHash(DEFAULT_PERFORMANCE_CONFIG);
  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64);
});

test("performance-config: different configs produce different hashes", () => {
  const config2 = { ...DEFAULT_PERFORMANCE_CONFIG, enabled: false };
  assert.notEqual(performanceConfigHash(DEFAULT_PERFORMANCE_CONFIG), performanceConfigHash(config2));
});

test("performance-config: isLabelAllowed admits arbitrary benign keys by default", () => {
  // Keys are admitted by default — there is no allowlist a future producer
  // can be forgotten out of. The keys below were never on any list.
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "runId", "run-123"), true);
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "toolName", "read-file"), true);
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "aKeyNobodyListed", "value-1"), true);
});

test("performance-config: isLabelAllowed rejects credential-named keys", () => {
  // Exclusion, not admission: the credential vocabulary owns this verdict,
  // so an innocent value under a credential-named key is still refused.
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "apiKey", "secret-value"), false);
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "password", "secret"), false);
});

test("performance-config: isLabelAllowed rejects oversized values", () => {
  const longValue = "x".repeat(257);
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "runId", longValue), false);
});

test("performance-config: isLabelAllowed rejects oversized keys", () => {
  const longKey = "k".repeat(257);
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, longKey, "value"), false);
});

test("performance-config: isLabelAllowed rejects key matching forbidden pattern", () => {
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "Authorization", "Bearer xxx"), false);
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "api-key", "secret"), false);
});

test("performance-config: isLabelAllowed rejects value matching forbidden pattern", () => {
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "runId", "Bearer secret-token"), false);
});

test("performance-config: redactLabelValue redacts sensitive values", () => {
  assert.equal(redactLabelValue(DEFAULT_PERFORMANCE_CONFIG, "Bearer secret-token"), "[redacted]");
  assert.equal(redactLabelValue(DEFAULT_PERFORMANCE_CONFIG, "password123"), "[redacted]");
});

test("performance-config: redactLabelValue preserves non-sensitive values", () => {
  assert.equal(redactLabelValue(DEFAULT_PERFORMANCE_CONFIG, "run-123"), "run-123");
  assert.equal(redactLabelValue(DEFAULT_PERFORMANCE_CONFIG, "read-file"), "read-file");
});

test("performance-config: redactLabelValue does not redact when redactCredentials is false", () => {
  const config = { ...DEFAULT_PERFORMANCE_CONFIG, privacy: { ...DEFAULT_PERFORMANCE_CONFIG.privacy, redactCredentials: false } };
  assert.equal(redactLabelValue(config, "Bearer secret-token"), "Bearer secret-token");
});

test("performance-config: DIAGNOSTIC_MODE_IDS has 6 modes", () => {
  assert.equal(DIAGNOSTIC_MODE_IDS.length, 6);
  assert.deepEqual([...DIAGNOSTIC_MODE_IDS], ["cpu", "memory", "io", "event-loop", "process", "cgroup"]);
});

test("performance-config: EXPORTER_KINDS has valid values", () => {
  assert.ok(EXPORTER_KINDS.includes("timeline"));
  assert.ok(EXPORTER_KINDS.includes("json-file"));
  assert.ok(EXPORTER_KINDS.includes("otlp-http"));
  assert.ok(EXPORTER_KINDS.includes("prometheus"));
});

test("performance-config: BACKPRESSURE_POLICIES has valid values", () => {
  assert.ok(BACKPRESSURE_POLICIES.includes("drop-oldest"));
  assert.ok(BACKPRESSURE_POLICIES.includes("block"));
  assert.ok(BACKPRESSURE_POLICIES.includes("sample"));
});

test("performance-config: COLLECTOR_FAILURE_BEHAVIORS has valid values", () => {
  assert.ok(COLLECTOR_FAILURE_BEHAVIORS.includes("fail-closed"));
  assert.ok(COLLECTOR_FAILURE_BEHAVIORS.includes("continue-with-error-event"));
  assert.ok(COLLECTOR_FAILURE_BEHAVIORS.includes("disable-collector"));
});

test("performance-config: ATTRIBUTION_LEVELS has valid values", () => {
  assert.ok(ATTRIBUTION_LEVELS.includes("exact"));
  assert.ok(ATTRIBUTION_LEVELS.includes("shared"));
  assert.ok(ATTRIBUTION_LEVELS.includes("estimated"));
});

test("performance-config: linear histogram bounds strategy is accepted", () => {
  const config = { ...DEFAULT_PERFORMANCE_CONFIG, histograms: { ...DEFAULT_PERFORMANCE_CONFIG.histograms, bucketStrategy: "linear" } };
  const parsed = parsePerformanceConfig(config);
  assert.equal(parsed.histograms.bucketStrategy, "linear");
  assert.deepEqual([...performanceConfigViolations(parsed)], []);
});

test("performance-config: log-linear histogram bounds strategy is accepted", () => {
  const config = { ...DEFAULT_PERFORMANCE_CONFIG, histograms: { ...DEFAULT_PERFORMANCE_CONFIG.histograms, bucketStrategy: "log-linear" } };
  const parsed = parsePerformanceConfig(config);
  assert.equal(parsed.histograms.bucketStrategy, "log-linear");
  assert.deepEqual([...performanceConfigViolations(parsed)], []);
});

test("performance-config: explicit histogram with valid monotonic bounds is accepted", () => {
  const config = {
    ...DEFAULT_PERFORMANCE_CONFIG,
    histograms: {
      ...DEFAULT_PERFORMANCE_CONFIG.histograms,
      bucketCount: 5,
      bucketStrategy: "explicit",
      explicitBounds: [10, 20, 30, 40, 50],
    },
  };
  const parsed = parsePerformanceConfig(config);
  assert.deepEqual([...performanceConfigViolations(parsed)], []);
});

test("performance-config: frozen config cannot be mutated", () => {
  const config = parsePerformanceConfig(DEFAULT_PERFORMANCE_CONFIG);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.scope));
  assert.ok(Object.isFrozen(config.sampling));
});

test("performance-config: every declared diagnostic mode id is accepted as an exclusion", () => {
  // Default-all: each mode id may be EXCLUDED, and the parsed config carries
  // the exclusion verbatim. The ids are DERIVED from the declared vocabulary,
  // never restated — a mode added to DIAGNOSTIC_MODE_IDS joins this test
  // unedited.
  for (const mode of DIAGNOSTIC_MODE_IDS) {
    const config = { ...DEFAULT_PERFORMANCE_CONFIG, diagnosticModes: { ...DEFAULT_PERFORMANCE_CONFIG.diagnosticModes, excludedModes: [mode] } };
    const parsed = parsePerformanceConfig(config);
    assert.deepEqual([...parsed.diagnosticModes.excludedModes], [mode]);
  }
});

test("performance-config: an empty exclusion list means every mode stays on", () => {
  const parsed = parsePerformanceConfig(DEFAULT_PERFORMANCE_CONFIG);
  assert.deepEqual([...parsed.diagnosticModes.excludedModes], []);
  const runner = createDiagnosticRunner({ config: parsed });
  // Default-all: with nothing excluded, the runner supports the FULL declared
  // vocabulary — derived from DIAGNOSTIC_MODE_IDS, not restated here.
  assert.deepEqual([...runner.supportedModes()].sort(), [...DIAGNOSTIC_MODE_IDS].sort());
});

test("performance-config: exporter timeline is accepted", () => {
  const config = { ...DEFAULT_PERFORMANCE_CONFIG, exporters: { ...DEFAULT_PERFORMANCE_CONFIG.exporters, enabledExporters: ["timeline"] } };
  const parsed = parsePerformanceConfig(config);
  assert.deepEqual([...parsed.exporters.enabledExporters], ["timeline"]);
});

test("performance-config: exporter json-file is accepted", () => {
  const config = { ...DEFAULT_PERFORMANCE_CONFIG, exporters: { ...DEFAULT_PERFORMANCE_CONFIG.exporters, enabledExporters: ["json-file"] } };
  const parsed = parsePerformanceConfig(config);
  assert.deepEqual([...parsed.exporters.enabledExporters], ["json-file"]);
});

test("performance-config: exporter otlp-http is accepted", () => {
  const config = { ...DEFAULT_PERFORMANCE_CONFIG, exporters: { ...DEFAULT_PERFORMANCE_CONFIG.exporters, enabledExporters: ["otlp-http"] } };
  const parsed = parsePerformanceConfig(config);
  assert.deepEqual([...parsed.exporters.enabledExporters], ["otlp-http"]);
});

test("performance-config: exporter prometheus is accepted", () => {
  const config = { ...DEFAULT_PERFORMANCE_CONFIG, exporters: { ...DEFAULT_PERFORMANCE_CONFIG.exporters, enabledExporters: ["prometheus"] } };
  const parsed = parsePerformanceConfig(config);
  assert.deepEqual([...parsed.exporters.enabledExporters], ["prometheus"]);
});

test("performance-config: backpressure policy drop-oldest is accepted", () => {
  const config = { ...DEFAULT_PERFORMANCE_CONFIG, backpressure: { ...DEFAULT_PERFORMANCE_CONFIG.backpressure, policy: "drop-oldest" } };
  const parsed = parsePerformanceConfig(config);
  assert.equal(parsed.backpressure.policy, "drop-oldest");
});

test("performance-config: backpressure policy block is accepted", () => {
  const config = { ...DEFAULT_PERFORMANCE_CONFIG, backpressure: { ...DEFAULT_PERFORMANCE_CONFIG.backpressure, policy: "block" } };
  const parsed = parsePerformanceConfig(config);
  assert.equal(parsed.backpressure.policy, "block");
});

test("performance-config: backpressure policy sample is accepted", () => {
  const config = { ...DEFAULT_PERFORMANCE_CONFIG, backpressure: { ...DEFAULT_PERFORMANCE_CONFIG.backpressure, policy: "sample" } };
  const parsed = parsePerformanceConfig(config);
  assert.equal(parsed.backpressure.policy, "sample");
});

test("performance-config: collector failure behavior fail-closed is accepted for onCollectorError", () => {
  const config = { ...DEFAULT_PERFORMANCE_CONFIG, failureBehavior: { ...DEFAULT_PERFORMANCE_CONFIG.failureBehavior, onCollectorError: "fail-closed" } };
  const parsed = parsePerformanceConfig(config);
  assert.equal(parsed.failureBehavior.onCollectorError, "fail-closed");
});

test("performance-config: collector failure behavior continue-with-error-event is accepted for onCollectorError", () => {
  const config = { ...DEFAULT_PERFORMANCE_CONFIG, failureBehavior: { ...DEFAULT_PERFORMANCE_CONFIG.failureBehavior, onCollectorError: "continue-with-error-event" } };
  const parsed = parsePerformanceConfig(config);
  assert.equal(parsed.failureBehavior.onCollectorError, "continue-with-error-event");
});

test("performance-config: collector failure behavior disable-collector is accepted for onCollectorError", () => {
  const config = { ...DEFAULT_PERFORMANCE_CONFIG, failureBehavior: { ...DEFAULT_PERFORMANCE_CONFIG.failureBehavior, onCollectorError: "disable-collector" } };
  const parsed = parsePerformanceConfig(config);
  assert.equal(parsed.failureBehavior.onCollectorError, "disable-collector");
});

// ═════════════════════════════════════════════════════════════════════════
// THE LABEL GATES: one predicate, casing-invariance as a PROPERTY, and the
// config field that can no longer carry a pattern.
//
// The defect these pin: `labelSchema.forbiddenLabelPatterns` held 13
// single-casing regexes (`[Ss]ecret` … `[Ss]k[-_]`) behind a bare
// `z.string()`, and the ONE list was compiled at TWO sites with different
// flags — `"u"` in `isLabelAllowed`, `"giu"` in `redactLabelValue` — so the
// admission gate ALLOWED `SECRET=…`/`TOKEN=…`/`SK-…` while the redactor
// dropped them. Driven at the parent commit: five of seven SCREAMING
// credential values passed `isLabelAllowed` under the allowed key `module`.
// ═════════════════════════════════════════════════════════════════════════

/**
 * INERT canary — matches no vocabulary entry, no separator-decided pattern
 * and no value-format signal, so any refusal of `form + CANARY` is
 * attributable to `form` and nothing else. Inertness is PROVEN in-run below
 * (the first canary tried in this hunt matched `[Ss]k[-_]` itself and
 * produced a false "already fixed").
 */
const LABEL_CANARY = "XQ2V9ZR4WD8YF6KH3JN5";

test("label gates: the canary is INERT — proven before any refusal below is trusted", () => {
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "module", LABEL_CANARY), true,
    "the canary alone must be allowed, or every refusal below is unattributable");
  assert.equal(redactLabelValue(DEFAULT_PERFORMANCE_CONFIG, LABEL_CANARY), LABEL_CANARY,
    "and it must survive redaction byte-identical");
});

test("★ rung 2, witnessed: every one of the 13 shipped single-casing patterns is REFUSED by the schema — a pattern cannot be WRITTEN into the config", () => {
  const shippedPatterns = [
    "[Aa]uthorization", "[Bb]earer", "[Aa]pi[-_]?[Kk]ey", "[Ss]ecret",
    "[Pp]assword", "[Tt]oken", "[Cc]redential", "[Pp]rompt",
    "[Cc]ontent", "[Pp]ayload", "[Dd]iff", "[Ss]ource[-_]?[Cc]ode",
    "[Ss]k[-_]",
  ];
  for (const pattern of shippedPatterns) {
    const bad = {
      ...DEFAULT_PERFORMANCE_CONFIG,
      labelSchema: { ...DEFAULT_PERFORMANCE_CONFIG.labelSchema, forbiddenLabelNames: [pattern] },
    };
    assert.throws(
      () => PERFORMANCE_CONFIG_SCHEMA.parse(bad),
      (err: unknown) => {
        assert.ok(err instanceof z.ZodError, `${pattern}: refusal must be a ZodError`);
        const issue = err.issues[0]!;
        assert.equal(issue.code, "invalid_format", `${pattern}: refused as a format violation`);
        assert.deepEqual(issue.path, ["labelSchema", "forbiddenLabelNames", 0]);
        assert.match(issue.message, /must be a NAME/u, `${pattern}: the message says what IS accepted`);
        return true;
      },
      `single-casing pattern ${pattern} must fail config load`,
    );
  }
  // The negative twin: a plain NAME is accepted, so the refusal above is the
  // regex syntax being refused, not the field being dead.
  const ok = {
    ...DEFAULT_PERFORMANCE_CONFIG,
    labelSchema: { ...DEFAULT_PERFORMANCE_CONFIG.labelSchema, forbiddenLabelNames: ["quota sign"] },
  };
  assert.deepEqual([...parsePerformanceConfig(ok).labelSchema.forbiddenLabelNames], ["quota sign"]);
});

test("★ casing-invariance as a PROPERTY: every effective vocabulary entry gets the SAME verdict in lower/UPPER/Mixed/SCREAMING_SNAKE — and that verdict is refusal, from BOTH gates", () => {
  // The vocabulary is DERIVED, never restated: the shared owner's parts, the
  // config's payload names, and the separator-decided sk- prefix the owner
  // matches by pattern. Adding an entry anywhere extends this test unedited.
  const vocabulary = [
    ...SENSITIVE_KEY_PARTS,
    ...DEFAULT_PERFORMANCE_CONFIG.labelSchema.forbiddenLabelNames,
    "sk-", "sk_",
  ];
  assert.ok(vocabulary.length >= 18, `witness: the vocabulary was actually derived (${vocabulary.length} entries)`);
  const formsOf = (entry: string): readonly string[] => [
    entry.toLowerCase(),
    entry.toUpperCase(),
    entry[0]!.toUpperCase() + entry.slice(1).toLowerCase(),
    entry.replace(/[ .-]/gu, "_").toUpperCase(), // SCREAMING_SNAKE
  ];
  for (const entry of vocabulary) {
    const verdicts = formsOf(entry).map((form) => {
      const label = `${form}${LABEL_CANARY}`;
      return {
        form,
        allowed: isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "module", label),
        redacted: redactLabelValue(DEFAULT_PERFORMANCE_CONFIG, label),
      };
    });
    for (const v of verdicts) {
      assert.equal(v.allowed, false,
        `${entry} as ${JSON.stringify(v.form)}: the admission gate must refuse EVERY casing — one casing slipping through IS the defect`);
      assert.equal(v.redacted, "[redacted]",
        `${entry} as ${JSON.stringify(v.form)}: the redactor must agree with the admission gate`);
    }
  }
});

test("★ the driven U-36 corpus: SCREAMING credential values are refused AND redacted — the two gates cannot disagree", () => {
  const attack = [
    "SECRET=abc123", "TOKEN=xyz", "API_KEY=k", "PASSWORD=p",
    "AUTHORIZATION: Bearer x", "SK-1234567890",
  ];
  const harmless = ["disk-usage", "task-id", "run-123", "read-file", LABEL_CANARY];
  for (const value of attack) {
    assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "module", value), false,
      `${value}: allowed by the gate at the parent commit — the FATAL class, live in performance`);
    assert.equal(redactLabelValue(DEFAULT_PERFORMANCE_CONFIG, value), "[redacted]", value);
  }
  // The negative half: the gate did not become "refuse everything", and the
  // old `[Ss]k[-_]` bigram false positives (`disk-`, `task_`) are GONE — the
  // sk- prefix is separator-bounded at the owner, exactly as the owner's
  // token-prefix comment promises for `risk-`/`desk-`.
  for (const value of harmless) {
    assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "module", value), true, value);
    assert.equal(redactLabelValue(DEFAULT_PERFORMANCE_CONFIG, value), value, value);
  }
  // The CLASS property, stated once over the whole corpus: for any in-length
  // value under an allowed key, admission and redaction are ONE verdict.
  for (const value of [...attack, ...harmless]) {
    assert.equal(
      isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "module", value),
      redactLabelValue(DEFAULT_PERFORMANCE_CONFIG, value) !== "[redacted]",
      `${value}: the two gates disagreeing is U-36 — both now consume isForbiddenLabelText`,
    );
  }
});

test("★ the class guard: `forbiddenLabelNames` has exactly ONE interpreting reader in src/ — the fork that compiled one list two ways cannot re-form", () => {
  // Deny-by-default over the whole source tree: a second consumer reading the
  // raw config list (however it spells its helper) reds this until it
  // consumes `isForbiddenLabelText` instead. Comments are blanked by the
  // sanctioned view, so prose mentions do not count; this looks for the field
  // being READ AS CODE.
  const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
  const files = walk(SRC_ROOT, { exts: [".ts"] });
  assert.ok(files.length > 100, `witness: src/ was actually walked (${files.length} files)`);

  const readers = new Map<string, number>();
  for (const file of files) {
    const hits = readSourceView(file).code().match(/\bforbiddenLabelNames\b/gu);
    if (hits !== null) readers.set(relative(SRC_ROOT, file), hits.length);
  }
  assert.deepEqual(
    [...readers.keys()],
    [join("performance", "performance-config.ts")],
    "every reader of the raw list other than its one owner is a second interpretation waiting to drift",
  );
  assert.ok(
    (readers.get(join("performance", "performance-config.ts")) ?? 0) >= 3,
    "witness: the owner really declares, defaults and consumes the field — a scan finding less is a scan gone blind",
  );
});

// ---------------------------------------------------------------------------
// Resource knobs — the per-effect delta gate + the process sampler's config.
// ---------------------------------------------------------------------------

test("performance-config: resource knobs default ON with the declared sampler period", () => {
  assert.equal(DEFAULT_RESOURCE_DELTAS_ENABLED, true, "deltas are cheap — the declared default is on");
  assert.equal(DEFAULT_RESOURCE_SAMPLER_ENABLED, true);
  assert.equal(DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS, 5000);
  const config = parsePerformanceConfig(DEFAULT_PERFORMANCE_CONFIG);
  assert.deepEqual(config.resourceDeltas, { enabled: true });
  assert.deepEqual(config.resourceSampler, { enabled: true, intervalMs: 5000 });
});

test("performance-config: a document omitting the resource sections gets the declared defaults", () => {
  const v = structuredClone(DEFAULT_PERFORMANCE_CONFIG) as Record<string, unknown>;
  delete v.resourceDeltas;
  delete v.resourceSampler;
  const config = parsePerformanceConfig(v);
  assert.equal(config.resourceDeltas.enabled, DEFAULT_RESOURCE_DELTAS_ENABLED);
  assert.equal(config.resourceSampler.enabled, DEFAULT_RESOURCE_SAMPLER_ENABLED);
  assert.equal(config.resourceSampler.intervalMs, DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS);
});

test("performance-config: sampler interval must be a positive integer", () => {
  const bad = structuredClone(DEFAULT_PERFORMANCE_CONFIG) as Record<string, unknown>;
  (bad.resourceSampler as Record<string, unknown>) = { enabled: true, intervalMs: 0 };
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse(bad));
  (bad.resourceSampler as Record<string, unknown>) = { enabled: true, intervalMs: 1.5 };
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse(bad));
  (bad.resourceSampler as Record<string, unknown>) = { enabled: true, intervalMs: -5000 };
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse(bad));
});

test("performance-config: unknown keys inside the resource sections are refused", () => {
  const bad = structuredClone(DEFAULT_PERFORMANCE_CONFIG) as Record<string, unknown>;
  (bad.resourceDeltas as Record<string, unknown>) = { enabled: true, sampleEvery: 2 };
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse(bad));
});
