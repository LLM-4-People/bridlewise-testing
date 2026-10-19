import assert from "node:assert/strict";
import test from "node:test";

import {
  compareTiers,
  getTierCheckIds,
  getTiersForCheckId,
  isQualityTier,
  QUALITY_TIERS,
  runAllTiers,
  runTier,
  tierIncludesCheck,
  findTierCoverageGaps,
  type QualityTier,
} from "../../src/quality-packs/tiers.ts";
import {
  createDiagnostic,
  type QualityPack,
  type Diagnostic,
} from "../../src/quality-packs/quality-pack.ts";
import { typescriptPack } from "../../src/quality-packs/typescript-pack.ts";
import { makeQualityContext } from "../support/factories.ts";

const TS_FILE = `function foo(): number { return 42; }
export { foo };
`;

const SYNTAX_ERROR_FILE = `function broken(): number {
  return 42;
`;

// ========== Tier validation tests ==========

test("tiers: QUALITY_TIERS has 4 tiers", () => {
  assert.equal(QUALITY_TIERS.length, 4);
  assert.deepEqual([...QUALITY_TIERS], ["fast", "incremental", "full", "holdout"]);
});

test("tiers: isQualityTier returns true for valid tiers", () => {
  for (const tier of QUALITY_TIERS) {
    assert.ok(isQualityTier(tier), `${tier} should be valid`);
  }
});

test("tiers: isQualityTier returns false for invalid", () => {
  assert.equal(isQualityTier("invalid"), false);
  assert.equal(isQualityTier(""), false);
  assert.equal(isQualityTier(null), false);
  assert.equal(isQualityTier(42), false);
});

// ========== Tier check mapping tests ==========

test("tiers: fast tier runs syntax + type", () => {
  const checkIds = getTierCheckIds("fast");
  assert.deepEqual([...checkIds], ["syntax-errors", "type-errors"]);
});

test("tiers: incremental adds dead-symbols + unused-exports", () => {
  const checkIds = getTierCheckIds("incremental");
  assert.ok(checkIds.includes("syntax-errors"));
  assert.ok(checkIds.includes("dead-symbols"));
  assert.ok(checkIds.includes("unused-exports"));
  assert.ok(checkIds.includes("type-errors"));
  assert.equal(checkIds.length, 4);
});

test("tiers: full adds dead-branches + duplicate-logic + schema-drift + config-outside-contract", () => {
  const checkIds = getTierCheckIds("full");
  assert.ok(checkIds.includes("dead-branches"));
  assert.ok(checkIds.includes("duplicate-logic"));
  assert.ok(checkIds.includes("schema-drift"));
  assert.ok(checkIds.includes("config-outside-contract"));
  // A floor, not an equality — see the note on compareTiers below.
  assert.ok(checkIds.length >= 8, `full names ${checkIds.length} checks`);
  assert.equal(new Set(checkIds).size, checkIds.length, "no id may be named twice");
});

test("tiers: holdout adds undefined-symbols and is the widest tier", () => {
  const checkIds = getTierCheckIds("holdout");
  assert.ok(checkIds.includes("undefined-symbols"));
  assert.ok(checkIds.length > getTierCheckIds("full").length);
  assert.equal(new Set(checkIds).size, checkIds.length, "no id may be named twice");
});

test("tiers: getTierCheckIds throws for invalid tier", () => {
  assert.throws(() => getTierCheckIds("invalid" as QualityTier), /Invalid quality tier/);
});

// ========== getTiersForCheckId tests ==========

test("tiers: getTiersForCheckId returns tiers that include a check", () => {
  const tiers = getTiersForCheckId("syntax-errors");
  assert.deepEqual([...tiers], ["fast", "incremental", "full", "holdout"]);
});

test("tiers: getTiersForCheckId for dead-symbols returns incremental, full, holdout", () => {
  const tiers = getTiersForCheckId("dead-symbols");
  assert.deepEqual([...tiers], ["incremental", "full", "holdout"]);
});

test("tiers: getTiersForCheckId for undefined-symbols returns only holdout", () => {
  const tiers = getTiersForCheckId("undefined-symbols");
  assert.deepEqual([...tiers], ["holdout"]);
});

test("tiers: getTiersForCheckId for unknown check returns empty", () => {
  const tiers = getTiersForCheckId("unknown-check");
  assert.equal(tiers.length, 0);
});

// ========== tierIncludesCheck tests ==========

test("tiers: tierIncludesCheck returns true for included check", () => {
  assert.ok(tierIncludesCheck("fast", "syntax-errors"));
  assert.ok(tierIncludesCheck("full", "duplicate-logic"));
  assert.ok(tierIncludesCheck("holdout", "undefined-symbols"));
});

test("tiers: tierIncludesCheck returns false for excluded check", () => {
  assert.equal(tierIncludesCheck("fast", "dead-symbols"), false);
  assert.equal(tierIncludesCheck("fast", "duplicate-logic"), false);
  assert.equal(tierIncludesCheck("incremental", "dead-branches"), false);
});

// ========== compareTiers tests ==========

test("tiers: compareTiers fast vs incremental adds 2 checks", () => {
  const result = compareTiers("fast", "incremental");
  assert.equal(result.addedChecks.length, 2);
  assert.ok(result.addedChecks.includes("dead-symbols"));
  assert.ok(result.addedChecks.includes("unused-exports"));
  assert.ok(result.isSuperset);
});

test("tiers: compareTiers incremental vs full adds the whole-repo checks", () => {
  const result = compareTiers("incremental", "full");
  // The count is a FLOOR, not an equality: an exact number here is a list that
  // has to be edited every time a check is added to the full tier, and a test
  // that must be edited to stay green is the mechanism by which a real
  // regression gets waved through as "just the count moving".
  assert.ok(result.addedChecks.length >= 4, `full adds ${result.addedChecks.length} checks over incremental`);
  for (const id of ["dead-branches", "duplicate-logic", "schema-drift", "config-outside-contract"]) {
    assert.ok(result.addedChecks.includes(id), `full must add ${id}`);
  }
  assert.ok(result.isSuperset);
});

test("tiers: compareTiers full vs holdout adds 1 check", () => {
  const result = compareTiers("full", "holdout");
  assert.equal(result.addedChecks.length, 1);
  assert.ok(result.addedChecks.includes("undefined-symbols"));
  assert.ok(result.isSuperset);
});

// ========== runTier tests ==========

test("tiers: runTier with clean TS file returns exitCode 0", () => {
  const context = makeQualityContext({ "test.ts": TS_FILE });
  const result = runTier("full", [typescriptPack], context);
  assert.equal(result.exitCode, 0);
  assert.equal(result.tier, "full");
  assert.equal(result.summary.totalPacks, 1);
  assert.ok(result.summary.totalChecks > 0);
});

test("tiers: runTier with syntax error returns exitCode 1", () => {
  const context = makeQualityContext({ "test.ts": SYNTAX_ERROR_FILE });
  const result = runTier("fast", [typescriptPack], context);
  assert.equal(result.exitCode, 1);
  assert.ok(result.summary.errors > 0);
});

test("tiers: runTier with empty files returns exitCode 0", () => {
  const context = makeQualityContext({});
  const result = runTier("full", [typescriptPack], context);
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.totalPacks, 0);
});

test("tiers: runTier with non-TS files returns exitCode 0", () => {
  const context = makeQualityContext({ "test.md": "# markdown" });
  const result = runTier("full", [typescriptPack], context);
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.totalPacks, 0);
});

test("tiers: runTier fast tier runs fewer checks than full", () => {
  const context = makeQualityContext({ "test.ts": TS_FILE });
  const fastResult = runTier("fast", [typescriptPack], context);
  const fullResult = runTier("full", [typescriptPack], context);
  assert.ok(fastResult.summary.totalChecks < fullResult.summary.totalChecks);
});

test("tiers: runTier incremental runs more checks than fast", () => {
  const context = makeQualityContext({ "test.ts": TS_FILE });
  const fastResult = runTier("fast", [typescriptPack], context);
  const incrementalResult = runTier("incremental", [typescriptPack], context);
  assert.ok(incrementalResult.summary.totalChecks > fastResult.summary.totalChecks);
});

test("tiers: runTier full runs more checks than incremental", () => {
  const context = makeQualityContext({ "test.ts": TS_FILE });
  const incrementalResult = runTier("incremental", [typescriptPack], context);
  const fullResult = runTier("full", [typescriptPack], context);
  assert.ok(fullResult.summary.totalChecks > incrementalResult.summary.totalChecks);
});

test("tiers: runTier holdout runs all checks", () => {
  const context = makeQualityContext({ "test.ts": TS_FILE });
  const result = runTier("holdout", [typescriptPack], context);
  assert.ok(result.summary.totalChecks >= 9);
});

test("tiers: runTier throws for invalid tier", () => {
  const context = makeQualityContext({ "test.ts": TS_FILE });
  assert.throws(() => runTier("invalid" as QualityTier, [typescriptPack], context), /Invalid quality tier/);
});

test("tiers: runTier result is frozen", () => {
  const context = makeQualityContext({ "test.ts": TS_FILE });
  const result = runTier("full", [typescriptPack], context);
  assert.ok(Object.isFrozen(result));
});

// ========== runAllTiers tests ==========

test("tiers: runAllTiers returns all 4 tiers", () => {
  const context = makeQualityContext({ "test.ts": TS_FILE });
  const results = runAllTiers([typescriptPack], context);
  assert.ok(results.fast);
  assert.ok(results.incremental);
  assert.ok(results.full);
  assert.ok(results.holdout);
  assert.equal(results.fast.tier, "fast");
  assert.equal(results.incremental.tier, "incremental");
  assert.equal(results.full.tier, "full");
  assert.equal(results.holdout.tier, "holdout");
});

test("tiers: runAllTiers is frozen", () => {
  const context = makeQualityContext({ "test.ts": TS_FILE });
  const results = runAllTiers([typescriptPack], context);
  assert.ok(Object.isFrozen(results));
});

// ========== Hostile tests ==========

test("tiers: fast tier does not include dead-branches check", () => {
  assert.equal(tierIncludesCheck("fast", "dead-branches"), false);
});

test("tiers: fast tier does not include duplicate-logic check", () => {
  assert.equal(tierIncludesCheck("fast", "duplicate-logic"), false);
});

test("tiers: incremental tier does not include undefined-symbols check", () => {
  assert.equal(tierIncludesCheck("incremental", "undefined-symbols"), false);
});

test("tiers: full tier does not include undefined-symbols check", () => {
  assert.equal(tierIncludesCheck("full", "undefined-symbols"), false);
});

test("tiers: only holdout includes undefined-symbols", () => {
  for (const tier of QUALITY_TIERS) {
    if (tier === "holdout") {
      assert.ok(tierIncludesCheck(tier, "undefined-symbols"));
    } else {
      assert.equal(tierIncludesCheck(tier, "undefined-symbols"), false);
    }
  }
});

// ========== Custom pack tier tests ==========

function makeCustomPack(): QualityPack {
  const errorDiag: Diagnostic = createDiagnostic({
    packId: "custom", checkId: "syntax-errors", category: "syntax",
    severity: "error", code: "E1", message: "err",
  });
  return {
    id: "custom", language: "custom-lang", version: "1.0.0",
    detect: (f) => Object.keys(f).length > 0,
    checks: [{
      id: "syntax-errors",
      description: "syntax check",
      category: "syntax",
      defaultSeverity: "error",
      run: () => [errorDiag],
    }],
  };
}

test("tiers: runTier with custom pack", () => {
  const pack = makeCustomPack();
  const context = makeQualityContext({ "f.custom": "content" });
  const result = runTier("fast", [pack], context);
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.errors, 1);
});

test("tiers: runTier with pack that has no matching checks for tier", () => {
  const pack: QualityPack = {
    id: "no-match", language: "ts", version: "1",
    detect: (f) => Object.keys(f).length > 0,
    checks: [{
      id: "custom-check-not-in-any-tier",
      description: "custom",
      category: "syntax",
      defaultSeverity: "error",
      run: () => [],
    }],
  };
  const context = makeQualityContext({ "test.ts": TS_FILE });
  const result = runTier("fast", [pack], context);
  assert.equal(result.summary.totalChecks, 0);
  assert.equal(result.exitCode, 0);
});

// ========== Summary accuracy tests ==========

test("tiers: summary counts are accurate for multiple packs", () => {
  const context = makeQualityContext({ "test.ts": SYNTAX_ERROR_FILE });
  const result = runTier("full", [typescriptPack, makeCustomPack()], context);
  assert.ok(result.summary.totalPacks >= 1);
  assert.ok(result.summary.errors >= 1);
});

// ========== Tier coverage: no check may be unreachable ==========

/**
 * `TIER_CHECK_MAP` is an allowlist, and the filter that consumes it
 * (`runQualityPackWithCheckIds`) is a `Set.has` — so a check the pack declares
 * but no tier names is skipped by every run, and a tier id matching no check is
 * a typo, and BOTH are silent. Three checks were unreachable this way:
 * `duplicate-body`, `esm-cjs-mismatch` and `duplicated-literals` were
 * implemented, registered on the pack, tested, and could not be run.
 *
 * The subject is discovered from the pack rather than listed here, so a check
 * added tomorrow is covered without anyone remembering to extend this test.
 */
test("tiers: every check a pack declares is reachable from at least one tier", () => {
  const gaps = findTierCoverageGaps([typescriptPack]);
  // Liveness: the population this verdict covers, as a runtime number with a
  // floor. Without it, a pack whose `checks` array became empty would satisfy
  // the assertions below by having nothing to check.
  const declared = typescriptPack.checks.map((c) => c.id);
  assert.ok(declared.length >= 12, `pack declares ${declared.length} checks, expected at least 12`);
  assert.deepEqual(gaps.checksInNoTier, [], "checks declared by a pack that no tier can run");
  assert.deepEqual(gaps.tierIdsMatchingNoCheck, [], "tier ids that name no declared check");
});

test("tiers: a planted unreachable check is detected, and a planted ghost id is detected", () => {
  // A count proves the detector is awake; only a plant proves it still reaches
  // the right verdict. Both halves are planted, because they fail differently.
  const withExtraCheck: QualityPack = {
    ...typescriptPack,
    checks: [
      ...typescriptPack.checks,
      {
        id: "a-check-no-tier-names",
        description: "planted",
        category: "syntax",
        defaultSeverity: "error",
        run: (): readonly Diagnostic[] => [],
      },
    ],
  };
  const planted = findTierCoverageGaps([withExtraCheck]);
  assert.deepEqual(planted.checksInNoTier, ["a-check-no-tier-names"]);

  // The other half: a pack that declares FEWER checks than the tiers name makes
  // every missing id a ghost, which is what a renamed check looks like.
  const strippedPack: QualityPack = { ...typescriptPack, checks: [typescriptPack.checks[0]!] };
  const ghosts = findTierCoverageGaps([strippedPack]);
  assert.ok(ghosts.tierIdsMatchingNoCheck.length >= 10, "a stripped pack must expose the tier ids that now match nothing");
  assert.ok(!ghosts.tierIdsMatchingNoCheck.includes(typescriptPack.checks[0]!.id));
});

test("tiers: the three checks that were unreachable really run now", () => {
  // The fix asserted on the checks' OWN evidence — they appear in the tier's
  // executed set — rather than on the map's contents, which is the thing that
  // was wrong and could be wrong again in a different place.
  const context = makeQualityContext({ "test.ts": TS_FILE });
  const result = runTier("full", [typescriptPack], context);
  const ran = new Set(result.results.flatMap((r) => r.checkResults.map((c) => c.checkId)));
  for (const id of ["duplicate-body", "esm-cjs-mismatch", "duplicated-literals"]) {
    assert.ok(ran.has(id), `${id} did not run in the full tier`);
  }
});
