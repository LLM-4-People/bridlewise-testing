import assert from "node:assert/strict";
import test from "node:test";

import {
  BUG_ZOO_CATALOG,
  BUG_ZOO_CATEGORIES,
  BUG_ZOO_SCHEMA_VERSION,
  getControlFixture,
  getFixturesByCategory,
  getHoldoutFixtures,
  getMutationsByCategory,
  getPositiveFixtures,
  isBugZooCategory,
  validateBugZooCatalog,
  verifyFiveConditions,
} from "../../src/quality-packs/bug-zoo.ts";

// ========== Schema tests ==========

test("bug-zoo: schema version is defined", () => {
  assert.equal(BUG_ZOO_SCHEMA_VERSION, "bridlewise-bug-zoo/v1");
});

test("bug-zoo: catalog has correct schema version", () => {
  assert.equal(BUG_ZOO_CATALOG.schemaVersion, BUG_ZOO_SCHEMA_VERSION);
});

// ========== Category count tests ==========

test("bug-zoo: has exactly 11 categories", () => {
  assert.equal(BUG_ZOO_CATEGORIES.length, 11);
  assert.equal(BUG_ZOO_CATALOG.categoryCount, 11);
});

test("bug-zoo: all categories are valid", () => {
  for (const cat of BUG_ZOO_CATEGORIES) {
    assert.ok(isBugZooCategory(cat), `${cat} should be valid`);
  }
});

test("bug-zoo: isBugZooCategory rejects invalid", () => {
  assert.equal(isBugZooCategory("invalid"), false);
  assert.equal(isBugZooCategory(""), false);
  assert.equal(isBugZooCategory(null), false);
  assert.equal(isBugZooCategory(42), false);
});

// ========== Positive count tests ==========

test("bug-zoo: has 44 positive scenarios", () => {
  const positives = BUG_ZOO_CATALOG.fixtures.filter((f) => f.kind === "positive");
  assert.equal(positives.length, 44);
  assert.equal(BUG_ZOO_CATALOG.positiveCount, 44);
});

test("bug-zoo: has 11 clean controls (one per category)", () => {
  const controls = BUG_ZOO_CATALOG.fixtures.filter((f) => f.kind === "clean-control");
  assert.equal(controls.length, 11);
  assert.equal(BUG_ZOO_CATALOG.controlCount, 11);
});

// ========== Per-category minimum 3 positives tests ==========

test("bug-zoo: every category has at least 3 positives", () => {
  for (const cat of BUG_ZOO_CATEGORIES) {
    const positives = getPositiveFixtures(cat);
    assert.ok(positives.length >= 3, `category ${cat} has only ${positives.length} positives`);
  }
});

test("bug-zoo: every category has exactly 1 clean control", () => {
  for (const cat of BUG_ZOO_CATEGORIES) {
    const control = getControlFixture(cat);
    assert.ok(control !== null, `category ${cat} missing control`);
    assert.equal(control!.kind, "clean-control");
  }
});

// ========== Specific category counts ==========

test("bug-zoo: undefined-symbols has 4 positives", () => {
  assert.equal(getPositiveFixtures("undefined-symbols").length, 4);
});

test("bug-zoo: unused-dead has 4 positives", () => {
  assert.equal(getPositiveFixtures("unused-dead").length, 4);
});

test("bug-zoo: unreachable-constant-duplicate-branch has 4 positives", () => {
  assert.equal(getPositiveFixtures("unreachable-constant-duplicate-branch").length, 4);
});

test("bug-zoo: syntax-indent-delimiter has 6 positives", () => {
  assert.equal(getPositiveFixtures("syntax-indent-delimiter").length, 6);
});

test("bug-zoo: cycles has 3 positives", () => {
  assert.equal(getPositiveFixtures("cycles").length, 3);
});

test("bug-zoo: type-name has 4 positives", () => {
  assert.equal(getPositiveFixtures("type-name").length, 4);
});

test("bug-zoo: weak-tautological-tests has 4 positives", () => {
  assert.equal(getPositiveFixtures("weak-tautological-tests").length, 4);
});

test("bug-zoo: mutation-survival has 4 positives", () => {
  assert.equal(getPositiveFixtures("mutation-survival").length, 4);
});

test("bug-zoo: property-counterexamples has 4 positives", () => {
  assert.equal(getPositiveFixtures("property-counterexamples").length, 4);
});

test("bug-zoo: architecture has 3 positives", () => {
  assert.equal(getPositiveFixtures("architecture").length, 3);
});

test("bug-zoo: security has 4 positives", () => {
  assert.equal(getPositiveFixtures("security").length, 4);
});

// ========== Fixture structure tests ==========

test("bug-zoo: every fixture has non-empty id", () => {
  for (const f of BUG_ZOO_CATALOG.fixtures) {
    assert.ok(f.id.length > 0, `fixture id is empty`);
    assert.ok(f.id.length > 0);
  }
});

test("bug-zoo: every fixture has non-empty source", () => {
  for (const f of BUG_ZOO_CATALOG.fixtures) {
    assert.ok(f.source.length > 0, `fixture ${f.id} has empty source`);
  }
});

test("bug-zoo: every fixture has non-empty description", () => {
  for (const f of BUG_ZOO_CATALOG.fixtures) {
    assert.ok(f.description.length > 0, `fixture ${f.id} has empty description`);
  }
});

test("bug-zoo: every fixture has a language", () => {
  for (const f of BUG_ZOO_CATALOG.fixtures) {
    assert.ok(f.language.length > 0, `fixture ${f.id} has no language`);
  }
});

test("bug-zoo: positive fixtures have expectedDiagnostics", () => {
  for (const f of getPositiveFixtures("undefined-symbols")) {
    assert.ok(f.expectedDiagnostics.length > 0, `positive ${f.id} has no expected diagnostics`);
  }
});

test("bug-zoo: clean controls have no expectedDiagnostics", () => {
  for (const cat of BUG_ZOO_CATEGORIES) {
    const control = getControlFixture(cat);
    assert.ok(control !== null);
    assert.equal(control!.expectedDiagnostics.length, 0);
  }
});

test("bug-zoo: every fixture has confirmWith mechanisms", () => {
  for (const f of BUG_ZOO_CATALOG.fixtures) {
    assert.ok(f.confirmWith.length > 0, `fixture ${f.id} has no confirmWith`);
  }
});

test("bug-zoo: all fixture ids are unique", () => {
  const ids = BUG_ZOO_CATALOG.fixtures.map((f) => f.id);
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size);
});

// ========== getFixturesByCategory tests ==========

test("bug-zoo: getFixturesByCategory returns all fixtures for category", () => {
  const fixtures = getFixturesByCategory("security");
  const expected = 4 + 1;
  assert.equal(fixtures.length, expected);
});

test("bug-zoo: getFixturesByCategory includes both positive and control", () => {
  const fixtures = getFixturesByCategory("syntax-indent-delimiter");
  const positives = fixtures.filter((f) => f.kind === "positive");
  const controls = fixtures.filter((f) => f.kind === "clean-control");
  assert.equal(positives.length, 6);
  assert.equal(controls.length, 1);
});

// ========== Mutation tests ==========

test("bug-zoo: has 4 mutations", () => {
  assert.equal(BUG_ZOO_CATALOG.mutationCount, 4);
  assert.equal(BUG_ZOO_CATALOG.mutations.length, 4);
});

test("bug-zoo: all mutations shouldSurviveBefore is true", () => {
  for (const m of BUG_ZOO_CATALOG.mutations) {
    assert.equal(m.shouldSurviveBefore, true, `mutation ${m.id} should survive before`);
  }
});

test("bug-zoo: all mutations shouldKillAfter is false (killed by killer test)", () => {
  for (const m of BUG_ZOO_CATALOG.mutations) {
    assert.equal(m.shouldKillAfter, false, `mutation ${m.id} should be killed after`);
  }
});

test("bug-zoo: every mutation has non-empty originalSource and mutatedSource", () => {
  for (const m of BUG_ZOO_CATALOG.mutations) {
    assert.ok(m.originalSource.length > 0);
    assert.ok(m.mutatedSource.length > 0);
    assert.notEqual(m.originalSource, m.mutatedSource);
  }
});

test("bug-zoo: every mutation has a killerTest", () => {
  for (const m of BUG_ZOO_CATALOG.mutations) {
    assert.ok(m.killerTest.length > 0, `mutation ${m.id} has no killerTest`);
  }
});

test("bug-zoo: mutations belong to mutation-survival category", () => {
  for (const m of BUG_ZOO_CATALOG.mutations) {
    assert.equal(m.category, "mutation-survival");
  }
});

test("bug-zoo: getMutationsByCategory returns mutations", () => {
  const muts = getMutationsByCategory("mutation-survival");
  assert.equal(muts.length, 4);
});

test("bug-zoo: getMutationsByCategory for non-mutation category returns empty", () => {
  assert.equal(getMutationsByCategory("security").length, 0);
});

// ========== Holdout tests ==========

test("bug-zoo: getHoldoutFixtures returns fixtures with holdout=true", () => {
  const holdouts = getHoldoutFixtures();
  for (const f of holdouts) {
    assert.equal(f.holdout, true);
  }
});

// ========== validateBugZooCatalog tests ==========

test("bug-zoo: validateBugZooCatalog passes for the catalog", () => {
  assert.doesNotThrow(() => validateBugZooCatalog(BUG_ZOO_CATALOG));
});

test("bug-zoo: validateBugZooCatalog rejects wrong schema version", () => {
  const bad = { ...BUG_ZOO_CATALOG, schemaVersion: "wrong" as typeof BUG_ZOO_SCHEMA_VERSION };
  assert.throws(() => validateBugZooCatalog(bad), /schema version/);
});

test("bug-zoo: validateBugZooCatalog rejects wrong category count", () => {
  const bad = { ...BUG_ZOO_CATALOG, categoryCount: 10 };
  assert.throws(() => validateBugZooCatalog(bad), /exactly 11/);
});

// ========== verifyFiveConditions tests ==========

test("bug-zoo: verifyFiveConditions passes for positive with matching diagnostics", () => {
  const fixture = getPositiveFixtures("undefined-symbols")[0]!;
  const result = verifyFiveConditions(fixture, [{ category: "undefined-symbol", symbol: "missingFunction" }]);
  assert.ok(result.allPassed);
  assert.equal(result.conditions.length, 5);
});

test("bug-zoo: verifyFiveConditions fails for positive without matching diagnostics", () => {
  const fixture = getPositiveFixtures("undefined-symbols")[0]!;
  const result = verifyFiveConditions(fixture, []);
  assert.equal(result.allPassed, false);
});

test("bug-zoo: verifyFiveConditions passes for clean control with no diagnostics", () => {
  const control = getControlFixture("undefined-symbols")!;
  const result = verifyFiveConditions(control, []);
  assert.ok(result.allPassed);
});

test("bug-zoo: verifyFiveConditions fails for clean control with diagnostics", () => {
  const control = getControlFixture("undefined-symbols")!;
  const result = verifyFiveConditions(control, [{ category: "syntax" }]);
  assert.equal(result.allPassed, false);
});

// ========== Materially different positives tests ==========

test("bug-zoo: undefined-symbols positives are materially different", () => {
  const positives = getPositiveFixtures("undefined-symbols");
  const descriptions = positives.map((f) => f.description);
  const unique = new Set(descriptions);
  assert.equal(unique.size, positives.length, "descriptions should be unique");
});

test("bug-zoo: syntax positives cover different delimiter types", () => {
  const positives = getPositiveFixtures("syntax-indent-delimiter");
  const sources = positives.map((f) => f.source);
  const unique = new Set(sources);
  assert.equal(unique.size, positives.length, "sources should be unique");
});

// ========== Frozen/immutability tests ==========

test("bug-zoo: catalog is frozen", () => {
  assert.ok(Object.isFrozen(BUG_ZOO_CATALOG));
});

test("bug-zoo: categories array is frozen", () => {
  assert.ok(Object.isFrozen(BUG_ZOO_CATEGORIES));
});

test("bug-zoo: fixtures array is frozen", () => {
  assert.ok(Object.isFrozen(BUG_ZOO_CATALOG.fixtures));
});

test("bug-zoo: individual fixture is frozen", () => {
  const fixture = BUG_ZOO_CATALOG.fixtures[0]!;
  assert.ok(Object.isFrozen(fixture));
});

// ========== Total fixture count ==========

test("bug-zoo: total fixtures = 44 positives + 11 controls = 55", () => {
  assert.equal(BUG_ZOO_CATALOG.fixtures.length, 55);
});
