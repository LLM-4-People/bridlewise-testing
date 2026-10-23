/**
 * The scan universe and the import universe are ONE census.
 *
 * A repository scan decides what it walks by pruning directory names
 * (`repositoryScanExclusions`) and experiment segments
 * (`experimentSourceExclusions`). The module graph then derived its edges by
 * keeping only the dependencies that were registered modules — that is, by
 * filtering the imports through the very universe the exclusions produced. A
 * module that imported INTO an excluded directory therefore contributed no
 * edge, no violation and no trace: the dependency was not judged and found
 * acceptable, it was discarded before anything could judge it.
 *
 * That is not hypothetical. A production barrel carried
 * `export * as learning from "../../_experiments/auto-learning/index.ts"` — a
 * VALUE re-export, not a type import — into a directory pruned from every
 * scan. The manifest recorded the dependency. Every guard whose universe came
 * from those exclusions was short by it, and nothing in the tree could say so.
 *
 * These tests hold the repaired shape: each dependency the module graph
 * discards must be explained by the SAME census the scanners use, or it is a
 * violation. The plants are supplied from outside the verifier (real
 * exclusion names read from `ROOT_POLICY`, real source text assembled here)
 * and enter through `verifyArchitectureSources` — the function
 * `scripts/s1-verification.ts` calls with the real repository sources, not an
 * inner helper.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ARCHITECTURE_MANIFEST } from "../../src/architecture-manifest.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { repositoryScanExclusionFor } from "../../src/shared/source-scan.ts";
import {
  analyzeArchitectureSource,
  clearArchitectureSourceCache,
  verifyArchitectureSources,
} from "../../scripts/verification/architecture.ts";

const REPOSITORY_ROOT = process.cwd();
const BOUNDARY_PREFIXES = [
  "architecture-scan-excluded-dependency:",
  "architecture-unregistered-dependency:",
] as const;

/**
 * The real repository sources, in the shape `scripts/verification/architecture.ts`
 * is called with by `scripts/s1-verification.ts`. One module's bytes may be
 * substituted, which is how a plant enters the same door a real caller uses
 * instead of being handed to an inner helper.
 */
function repositorySources(
  substitutions: Readonly<Record<string, string>> = {},
): readonly Readonly<{ path: string; source: string }>[] {
  return ARCHITECTURE_MANIFEST.modules.map((module) => ({
    path: module.path,
    source: substitutions[module.path] ?? readFileSync(join(REPOSITORY_ROOT, module.path), "utf8"),
  }));
}

function boundaryViolations(sources: readonly Readonly<{ path: string; source: string }>[]): readonly string[] {
  // The analyzer memoizes on (path, content-hash); a plant changes the content
  // so it cannot collide, but clearing keeps the reading independent of what
  // earlier tests in this process left behind.
  clearArchitectureSourceCache();
  return verifyArchitectureSources(sources, ARCHITECTURE_MANIFEST).violations
    .filter((violation) => BOUNDARY_PREFIXES.some((prefix) => violation.startsWith(prefix)));
}

/**
 * A module under `src/` whose source is short enough to rewrite wholesale, so
 * the plant is a real module's real import list and not a synthetic fixture
 * that the verifier might treat differently. Discovered, never named: the
 * first `src/` module with no dependencies at all, so adding one is the only
 * change the plant makes.
 */
function plantHost(): Readonly<{ path: string; source: string }> {
  const host = repositorySources().find((module) =>
    module.path.startsWith("src/") && module.path.endsWith(".ts") && analyzeArchitectureSource(module.path, module.source).dependencies.length === 0);
  assert.ok(host, "expected at least one dependency-free src/ module to host a plant");
  return host;
}

test("scan census: the clean tree has no dependency the scan refuses to walk", () => {
  const violations = boundaryViolations(repositorySources());
  assert.deepEqual(
    violations,
    [],
    `every module dependency must be a registered module or an external specifier; got:\n${violations.join("\n")}`,
  );
});

test("scan census: the covered population is every registered module, and it is not empty", () => {
  // A guard that names its subject has already chosen how much to check. State
  // the number, and refuse a universe that has collapsed.
  const modules = ARCHITECTURE_MANIFEST.modules.length;
  const dependencyEdges = repositorySources()
    .reduce((total, module) => total + analyzeArchitectureSource(module.path, module.source).dependencies.length, 0);
  assert.ok(modules >= 700, `architecture verification must cover the whole manifest; covered ${modules}`);
  assert.ok(dependencyEdges >= 2500, `dependency census must be populated; got ${dependencyEdges} edges`);
  assert.equal(
    ARCHITECTURE_MANIFEST.sourceRoots.length > 0,
    true,
    "the source-root census must be non-empty or every unregistered dependency passes vacuously",
  );
});

test("scan census: a value import into EVERY excluded directory name is refused", () => {
  // Dynamic discovery: the excluded names come from the policy, so a name
  // added there is covered without editing this test. Each is planted
  // separately, and each must be named in its own diagnostic.
  const host = plantHost();
  const excludedNames = ROOT_POLICY.configuration.repositoryScanExclusions;
  assert.ok(excludedNames.length > 0, "repositoryScanExclusions must be populated");

  // The excluded name is planted at TWO depths. A first-segment-only reading
  // of the policy passes every leading plant while letting `src/x/node_modules/…`
  // straight through, and a guard that only ever sees the name in front cannot
  // tell the two implementations apart. These directory names are pruned
  // WHEREVER they appear, so the refusal is tested wherever they appear.
  const depths = ["", "src/", "scripts/nested/deeper/"] as const;
  let planted = 0;
  for (const excludedName of excludedNames) {
    for (const prefix of depths) {
      const target = `${prefix}${excludedName}/planted-module/index.ts`;
      const exclusion = repositoryScanExclusionFor(target);
      assert.deepEqual(
        exclusion,
        { reason: "repository-scan", segment: excludedName },
        `"${excludedName}" must be excluded at depth ${prefix.split("/").length - 1}, not only in front`,
      );
      const source = `import { plantedValue } from "${
        "../".repeat(host.path.split("/").length - 1)}${target}";\nexport const planted = plantedValue;\n`;
      const violations = boundaryViolations(repositorySources({ [host.path]: source }));
      assert.deepEqual(
        violations,
        [`architecture-scan-excluded-dependency:${host.path}->${target}:repository-scan:${excludedName}`],
        `a value import into "${target}" must be refused by name`,
      );
      planted += 1;
    }
  }
  assert.ok(
    planted >= excludedNames.length * depths.length,
    `every excluded name must be planted at every depth; planted ${planted}`,
  );
});

test("scan census: a value import into an EXPERIMENT segment is refused, and names the segment", () => {
  const host = plantHost();
  const patterns = ROOT_POLICY.configuration.experimentSourceExclusions;
  assert.ok(patterns.length > 0, "experimentSourceExclusions must be populated");
  // A concrete segment per pattern: `exp*` becomes `exp999`, a literal stays.
  const segments = patterns.map((pattern) => pattern.replaceAll("*", "999"));

  for (const segment of segments) {
    const target = `src/${segment}/planted-module.ts`;
    const exclusion = repositoryScanExclusionFor(target);
    assert.ok(exclusion, `src/${segment}/ must be excluded by the experiment census`);
    const source = `import { plantedValue } from "${
      "../".repeat(host.path.split("/").length - 1)}${target}";\nexport const planted = plantedValue;\n`;
    const violations = boundaryViolations(repositorySources({ [host.path]: source }));
    assert.deepEqual(
      violations,
      [`architecture-scan-excluded-dependency:${host.path}->${target}:experiment:${segment}`],
      `a value import into the experiment segment "${segment}" must be refused`,
    );
  }
});

test("scan census: an in-tree path that is not a registered module is refused", () => {
  // The second half of the contradiction: the path is inside a declared source
  // root, so nothing excludes it — which means the manifest is short a module
  // and every verdict derived from it is short with it.
  const host = plantHost();
  const root = ARCHITECTURE_MANIFEST.sourceRoots[0]!;
  const target = `${root}planted-unregistered/module.ts`;
  assert.equal(repositoryScanExclusionFor(target), undefined, "the plant must not be excluded");
  const source = `import { plantedValue } from "${
    "../".repeat(host.path.split("/").length - 1)}${target}";\nexport const planted = plantedValue;\n`;
  const violations = boundaryViolations(repositorySources({ [host.path]: source }));
  assert.deepEqual(
    violations,
    [`architecture-unregistered-dependency:${host.path}->${target}`],
    "a dependency under a source root that is not a registered module must be refused",
  );
});

test("scan census: a TYPE-ONLY import into an excluded directory is refused too", () => {
  // The original defect was a value re-export, and the tempting narrowing is
  // to police only values. A type import is still a claim that the excluded
  // directory is part of the program, and it still makes the declaration
  // emit reach outside the source tree.
  const host = plantHost();
  const target = "_experiments/planted-module/index.ts";
  const source = `import type { PlantedType } from "${
    "../".repeat(host.path.split("/").length - 1)}${target}";\nexport type Planted = PlantedType;\n`;
  const violations = boundaryViolations(repositorySources({ [host.path]: source }));
  assert.deepEqual(
    violations,
    [`architecture-scan-excluded-dependency:${host.path}->${target}:repository-scan:_experiments`],
    "a type-only import into an excluded directory must be refused",
  );
});

test("scan census: external specifiers are not swept up by the refusal", () => {
  // The exemption carries the same evidence burden as the detection: prove the
  // shapes we deliberately ignore are genuinely ignored, rather than asserting
  // it in prose. An absolute path is the sharp case — it can contain a
  // `node_modules` segment while saying nothing about our scan universe.
  const host = plantHost();
  const source = [
    'import { createHash } from "node:crypto";',
    'import { parse } from "@babel/parser";',
    'import sqlite from "/tmp/planted-sandbox/node_modules/better-sqlite3";',
    "export const planted = [createHash, parse, sqlite].length;",
    "",
  ].join("\n");
  assert.deepEqual(
    boundaryViolations(repositorySources({ [host.path]: source })),
    [],
    "node: builtins, scoped packages and absolute sandbox paths are not repository paths",
  );
});

test("scan census: the refusal reads the CURRENT policy, not a copy of it", () => {
  // If the exclusion census were restated inside the verifier, widening the
  // policy would not widen the refusal — the two would drift, which is the
  // exact failure this guard exists to make impossible. Drive the helper with
  // a name the policy owns and one it does not.
  const owned = ROOT_POLICY.configuration.repositoryScanExclusions[0]!;
  assert.deepEqual(
    repositoryScanExclusionFor(`${owned}/x/y.ts`),
    { reason: "repository-scan", segment: owned },
    "an excluded directory name must be reported with the segment that caused it",
  );
  assert.equal(
    repositoryScanExclusionFor("src/shared/source-scan.ts"),
    undefined,
    "a production path must not be reported as excluded",
  );
  assert.equal(
    repositoryScanExclusionFor("@babel/parser"),
    undefined,
    "a bare package specifier is not a repository path",
  );
});

test("scan census: every erased-reference syntax retains exact excluded and unknown targets", () => {
  const host = ARCHITECTURE_MANIFEST.modules.find(module => module.path === "src/kernel/errors.ts")!;
  assert.ok(host);
  const forms = [
    (target: string) => `import type { T } from "${target}";`,
    (target: string) => `export type { T } from "${target}";`,
    (target: string) => `export type * from "${target}";`,
    (target: string) => `export type * as NS from "${target}";`,
    (target: string) => `export type T = import("${target}").T;`,
    (target: string) => `type T = typeof import("${target}");`,
    (target: string) => `import type Alias = require("${target}");`,
  ];
  const targets = [
    ...ROOT_POLICY.configuration.repositoryScanExclusions.flatMap(segment => [`${segment}/probe.ts`, `src/nested/${segment}/probe.ts`]),
    ...ROOT_POLICY.configuration.experimentSourceExclusions.map(pattern => `src/${pattern.replaceAll("*", "999")}/probe.ts`),
    "src/unknown-erased-target.ts",
  ];
  for (const target of targets) for (const form of forms) {
    const source = form(`../../${target}`);
    const result = verifyArchitectureSources([{ path: host.path, source }], { ...ARCHITECTURE_MANIFEST, modules: [host] });
    const exclusion = repositoryScanExclusionFor(target);
    const expected = exclusion
      ? `architecture-scan-excluded-dependency:${host.path}->${target}:${exclusion.reason}:${exclusion.segment}`
      : `architecture-unregistered-dependency:${host.path}->${target}`;
    assert.deepEqual(result.violations.filter(violation => BOUNDARY_PREFIXES.some(prefix => violation.startsWith(prefix))), [expected], source);
    assert.equal(result.violations.some(violation => violation.startsWith("architecture-independent-")), false, source);
  }
  for (const target of ["node:fs", "@types/example", "/tmp/node_modules/example.ts"]) {
    const source = `export type T = import(${JSON.stringify(target)}).T;`;
    const result = verifyArchitectureSources([{ path: host.path, source }], { ...ARCHITECTURE_MANIFEST, modules: [host] });
    assert.deepEqual(result.violations.filter(violation => BOUNDARY_PREFIXES.some(prefix => violation.startsWith(prefix))), []);
  }
});
