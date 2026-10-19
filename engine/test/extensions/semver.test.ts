import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSemver,
  compareSemver,
  semverEqual,
  isPrerelease,
  parseComparator,
  satisfiesComparator,
  parseVersionRange,
  satisfiesRange,
  isValidSemver,
  isValidRange,
  type Comparator,
} from "../../src/extensions/semver.ts";
import { InputError } from "../../src/kernel/errors.ts";

// ============================================================================
// parseSemver
// ============================================================================

test("Semver: parseSemver parses a simple version", () => {
  const v = parseSemver("1.2.3");
  assert.deepEqual({ major: v.major, minor: v.minor, patch: v.patch }, { major: 1, minor: 2, patch: 3 });
  assert.equal(v.prerelease, null);
});

test("Semver: parseSemver parses version with prerelease", () => {
  const v = parseSemver("1.2.3-alpha.1");
  assert.equal(v.prerelease, "alpha.1");
});

test("Semver: parseSemver parses zero versions", () => {
  assert.deepEqual(parseSemver("0.0.0"), { major: 0, minor: 0, patch: 0, prerelease: null });
});

test("Semver: parseSemver trims whitespace", () => {
  const v = parseSemver("  1.2.3  ");
  assert.equal(v.major, 1);
});

test("Semver: parseSemver throws on empty string", () => {
  assert.throws(() => parseSemver(""), (e: Error) => e instanceof InputError && e.code === "semver_invalid");
});

test("Semver: parseSemver throws on non-string", () => {
  assert.throws(() => parseSemver(123 as unknown as string));
});

test("Semver: parseSemver throws on malformed version", () => {
  for (const bad of ["1", "1.2", "1.2.3.4", "v1.2.3", "1.2.3-", "1.2.3-", "01.2.3", "1.02.3", "1.2.03", "1.2.x"]) {
    assert.throws(() => parseSemver(bad), InputError, `expected throw for '${bad}'`);
  }
});

test("Semver: parseSemver accepts numeric prerelease", () => {
  assert.equal(parseSemver("1.0.0-0").prerelease, "0");
});

test("Semver: parseSemver accepts hyphen-only prerelease identifiers", () => {
  assert.equal(parseSemver("1.0.0-a-b").prerelease, "a-b");
});

// ============================================================================
// compareSemver
// ============================================================================

test("Semver: compareSemver returns 0 for equal versions", () => {
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
});

test("Semver: compareSemver compares major", () => {
  assert.equal(compareSemver("2.0.0", "1.0.0"), 1);
  assert.equal(compareSemver("1.0.0", "2.0.0"), -1);
});

test("Semver: compareSemver compares minor", () => {
  assert.equal(compareSemver("1.3.0", "1.2.0"), 1);
  assert.equal(compareSemver("1.2.0", "1.3.0"), -1);
});

test("Semver: compareSemver compares patch", () => {
  assert.equal(compareSemver("1.2.4", "1.2.3"), 1);
  assert.equal(compareSemver("1.2.3", "1.2.4"), -1);
});

test("Semver: compareSemver prerelease has lower precedence", () => {
  assert.equal(compareSemver("1.0.0", "1.0.0-alpha"), 1);
  assert.equal(compareSemver("1.0.0-alpha", "1.0.0"), -1);
});

test("Semver: compareSemver numeric prerelease identifiers compared numerically", () => {
  assert.equal(compareSemver("1.0.0-2", "1.0.0-10"), -1);
  assert.equal(compareSemver("1.0.0-10", "1.0.0-2"), 1);
});

test("Semver: compareSemver numeric prerelease lower than alphanumeric", () => {
  assert.equal(compareSemver("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareSemver("1.0.0-alpha", "1.0.0-1"), 1);
});

test("Semver: compareSemver alphanumeric prerelease compared lexically", () => {
  assert.equal(compareSemver("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(compareSemver("1.0.0-beta", "1.0.0-alpha"), 1);
});

test("Semver: compareSemver larger prerelease field set wins", () => {
  assert.equal(compareSemver("1.0.0-alpha.1", "1.0.0-alpha"), 1);
  assert.equal(compareSemver("1.0.0-alpha", "1.0.0-alpha.1"), -1);
});

test("Semver: compareSemver is transitive", () => {
  assert.equal(compareSemver("1.0.0", "2.0.0"), -1);
  assert.equal(compareSemver("2.0.0", "3.0.0"), -1);
  assert.equal(compareSemver("1.0.0", "3.0.0"), -1);
});

// ============================================================================
// semverEqual / isPrerelease
// ============================================================================

test("Semver: semverEqual true for equal", () => {
  assert.ok(semverEqual("1.2.3", "1.2.3"));
});

test("Semver: semverEqual false for different", () => {
  assert.ok(!semverEqual("1.2.3", "1.2.4"));
});

test("Semver: isPrerelease true for prerelease", () => {
  assert.ok(isPrerelease("1.0.0-alpha"));
});

test("Semver: isPrerelease false for release", () => {
  assert.ok(!isPrerelease("1.0.0"));
});

// ============================================================================
// parseComparator / satisfiesComparator
// ============================================================================

test("Semver: parseComparator parses >=", () => {
  const c = parseComparator(">=1.2.3");
  assert.equal(c.operator, ">=");
  assert.equal(c.version, "1.2.3");
});

test("Semver: parseComparator defaults to = when no operator", () => {
  const c = parseComparator("1.2.3");
  assert.equal(c.operator, "=");
});

test("Semver: parseComparator parses all operators", () => {
  for (const op of [">=", ">", "<=", "<", "="] as const) {
    const c = parseComparator(`${op}1.0.0`);
    assert.equal(c.operator, op);
  }
});

test("Semver: parseComparator throws on invalid", () => {
  for (const bad of ["", "abc", "1.2", ">>1.0.0", "1.2.3.4"]) {
    assert.throws(() => parseComparator(bad), InputError, `expected throw for '${bad}'`);
  }
});

test("Semver: satisfiesComparator = exact", () => {
  const c: Comparator = { operator: "=", version: "1.2.3" };
  assert.ok(satisfiesComparator("1.2.3", c));
  assert.ok(!satisfiesComparator("1.2.4", c));
});

test("Semver: satisfiesComparator > greater", () => {
  const c: Comparator = { operator: ">", version: "1.2.3" };
  assert.ok(satisfiesComparator("1.2.4", c));
  assert.ok(!satisfiesComparator("1.2.3", c));
  assert.ok(!satisfiesComparator("1.2.2", c));
});

test("Semver: satisfiesComparator >= greater-or-equal", () => {
  const c: Comparator = { operator: ">=", version: "1.2.3" };
  assert.ok(satisfiesComparator("1.2.3", c));
  assert.ok(satisfiesComparator("1.2.4", c));
  assert.ok(!satisfiesComparator("1.2.2", c));
});

test("Semver: satisfiesComparator < less", () => {
  const c: Comparator = { operator: "<", version: "1.2.3" };
  assert.ok(satisfiesComparator("1.2.2", c));
  assert.ok(!satisfiesComparator("1.2.3", c));
});

test("Semver: satisfiesComparator <= less-or-equal", () => {
  const c: Comparator = { operator: "<=", version: "1.2.3" };
  assert.ok(satisfiesComparator("1.2.3", c));
  assert.ok(satisfiesComparator("1.2.2", c));
  assert.ok(!satisfiesComparator("1.2.4", c));
});

// ============================================================================
// parseVersionRange / satisfiesRange
// ============================================================================

test("Semver: satisfiesRange exact version", () => {
  assert.ok(satisfiesRange("1.2.3", "1.2.3"));
  assert.ok(!satisfiesRange("1.2.4", "1.2.3"));
});

test("Semver: satisfiesRange caret ^1.2.3 admits compatible patch", () => {
  assert.ok(satisfiesRange("1.2.3", "^1.2.3"));
  assert.ok(satisfiesRange("1.2.9", "^1.2.3"));
  assert.ok(satisfiesRange("1.3.0", "^1.2.3"));
  assert.ok(!satisfiesRange("2.0.0", "^1.2.3"));
  assert.ok(!satisfiesRange("1.2.2", "^1.2.3"));
});

test("Semver: satisfiesRange caret ^0.2.3 admits only patch", () => {
  assert.ok(satisfiesRange("0.2.3", "^0.2.3"));
  assert.ok(satisfiesRange("0.2.9", "^0.2.3"));
  assert.ok(!satisfiesRange("0.3.0", "^0.2.3"));
});

test("Semver: satisfiesRange caret ^0.0.3 admits only that patch", () => {
  assert.ok(satisfiesRange("0.0.3", "^0.0.3"));
  assert.ok(!satisfiesRange("0.0.4", "^0.0.3"));
  assert.ok(!satisfiesRange("0.0.2", "^0.0.3"));
});

test("Semver: satisfiesRange tilde ~1.2.3 admits patch only", () => {
  assert.ok(satisfiesRange("1.2.3", "~1.2.3"));
  assert.ok(satisfiesRange("1.2.9", "~1.2.3"));
  assert.ok(!satisfiesRange("1.3.0", "~1.2.3"));
});

test("Semver: satisfiesRange comparator >=", () => {
  assert.ok(satisfiesRange("1.3.0", ">=1.2.0"));
  assert.ok(satisfiesRange("1.2.0", ">=1.2.0"));
  assert.ok(!satisfiesRange("1.1.0", ">=1.2.0"));
});

test("Semver: satisfiesRange AND combination", () => {
  assert.ok(satisfiesRange("1.2.5", ">=1.2.0 <2.0.0"));
  assert.ok(!satisfiesRange("2.0.0", ">=1.2.0 <2.0.0"));
  assert.ok(!satisfiesRange("1.1.0", ">=1.2.0 <2.0.0"));
});

test("Semver: satisfiesRange OR combination", () => {
  assert.ok(satisfiesRange("1.0.0", "1.0.0 || 2.0.0"));
  assert.ok(satisfiesRange("2.0.0", "1.0.0 || 2.0.0"));
  assert.ok(!satisfiesRange("1.5.0", "1.0.0 || 2.0.0"));
});

test("Semver: satisfiesRange OR of AND sets", () => {
  assert.ok(satisfiesRange("1.5.0", ">=1.0.0 <2.0.0 || >=3.0.0 <4.0.0"));
  assert.ok(satisfiesRange("3.5.0", ">=1.0.0 <2.0.0 || >=3.0.0 <4.0.0"));
  assert.ok(!satisfiesRange("2.5.0", ">=1.0.0 <2.0.0 || >=3.0.0 <4.0.0"));
});

test("Semver: satisfiesRange returns false for prerelease outside explicit", () => {
  assert.ok(!satisfiesRange("1.2.3-alpha", "^1.2.3"));
});

test("Semver: satisfiesRange empty string throws", () => {
  assert.throws(() => satisfiesRange("1.0.0", ""), InputError);
});

test("Semver: parseVersionRange preserves raw", () => {
  const r = parseVersionRange(">=1.2.0 <2.0.0");
  assert.equal(r.raw, ">=1.2.0 <2.0.0");
  assert.equal(r.orSets.length, 1);
  assert.equal(r.orSets[0]!.length, 2);
});

// ============================================================================
// isValidSemver / isValidRange
// ============================================================================

test("Semver: isValidSemver true for valid", () => {
  assert.ok(isValidSemver("1.2.3"));
  assert.ok(isValidSemver("0.0.0"));
  assert.ok(isValidSemver("1.0.0-alpha"));
});

test("Semver: isValidSemver false for invalid", () => {
  assert.ok(!isValidSemver("1.2"));
  assert.ok(!isValidSemver(""));
  assert.ok(!isValidSemver("v1.2.3"));
});

test("Semver: isValidRange true for valid ranges", () => {
  assert.ok(isValidRange("1.2.3"));
  assert.ok(isValidRange("^1.2.3"));
  assert.ok(isValidRange("~1.2.3"));
  assert.ok(isValidRange(">=1.2.0 <2.0.0"));
  assert.ok(isValidRange("1.0.0 || 2.0.0"));
});

test("Semver: isValidRange false for invalid", () => {
  assert.ok(!isValidRange(""));
  assert.ok(!isValidRange("abc"));
});
