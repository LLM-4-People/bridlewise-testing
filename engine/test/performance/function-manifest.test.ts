import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { z } from "zod";

import {
  generateFunctionManifest,
  validateFunctionManifest,
  functionManifestCoverage,
  FUNCTION_MANIFEST_SCHEMA_VERSION,
  type FunctionManifestExclusion,
} from "../../src/performance/function-manifest.ts";
import { ARCHITECTURE_MANIFEST, type ArchitectureModule } from "../../src/architecture-manifest.ts";
import { DEFAULT_PERFORMANCE_CONFIG, parsePerformanceConfig } from "../../src/performance/performance-config.ts";
import { makePerfConfig } from "../support/factories.ts";

const sampleModules: readonly ArchitectureModule[] = [
  { id: "mod-a", path: "src/a.ts", realm: "shared", layer: "domain", owner: "owner-a",
    allowedDependencyLayers: ["domain"], compositionRoot: false, executionBoundary: "pure" as const,
    ports: { requires: [], provides: ["port-a"] },
    effects: ["filesystem-read" as const], configPaths: [], stateOwners: [], projectionOwners: [],
    authorityFamilies: [], authorityIdentifiers: ["AUTH_A"], responsibilities: ["resp-a"] },
  { id: "mod-b", path: "src/b.ts", realm: "runtime", layer: "infrastructure", owner: "owner-b",
    allowedDependencyLayers: ["infrastructure"], compositionRoot: false, executionBoundary: "effect-adapter" as const,
    ports: { requires: [], provides: ["port-b"] },
    effects: ["network" as const], configPaths: [], stateOwners: [], projectionOwners: [],
    authorityFamilies: [], authorityIdentifiers: ["AUTH_B"], responsibilities: ["resp-b"] },
];

// Real source text for sampleModules. The function manifest must enumerate
// REAL exported functions parsed from source, not metadata proxies synthesized
// from responsibilities/ports/effects/authorityIdentifiers.
const MOD_A_SOURCE = [
  "export function processA(): void {}",
  "export function validateA(value: unknown): boolean { return !!value; }",
  "function internalHelper(): void {}",
].join("\n");
const MOD_B_SOURCE = [
  "export function handleB(): void {}",
].join("\n");
const sampleSources = new Map<string, string>([
  ["src/a.ts", MOD_A_SOURCE],
  ["src/b.ts", MOD_B_SOURCE],
]);

function repositoryModuleSources(modules: readonly ArchitectureModule[] = ARCHITECTURE_MANIFEST.modules): Map<string, string> {
  const map = new Map<string, string>();
  for (const module of modules) {
    map.set(module.path, readFileSync(module.path, "utf8"));
  }
  return map;
}

test("function-manifest: schema version is correct", () => {
  assert.equal(FUNCTION_MANIFEST_SCHEMA_VERSION, "bridlewise-function-manifest/v1");
});

test("function-manifest: generates manifest from modules", () => {
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
  });
  assert.equal(manifest.totalFunctions, 3);
  assert.equal(manifest.includedFunctions, 3);
  assert.equal(manifest.excludedFunctions, 0);
  assert.ok(manifest.manifestHash.length === 64);
  assert.ok(manifest.architectureManifestHash.length === 64);
});

test("function-manifest: manifest entries include module metadata", () => {
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
  });
  assert.ok(manifest.entries.length > 0);
  for (const entry of manifest.entries) {
    assert.ok(entry.moduleId.length > 0);
    assert.ok(entry.modulePath.length > 0);
    assert.ok(entry.realm.length > 0);
    assert.ok(entry.owner.length > 0);
    assert.equal(entry.excluded, false);
  }
});

test("function-manifest: entries are real exported functions from source, not metadata proxies", () => {
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
  });
  const ids = manifest.entries.map((e) => e.functionId).toSorted();
  assert.deepEqual(ids, ["handleB", "processA", "validateA"]);
  // Metadata concepts must NOT appear as pseudo-functions.
  assert.equal(ids.includes("resp-a"), false);
  assert.equal(ids.includes("port-a"), false);
  assert.equal(ids.includes("effect:filesystem-read"), false);
  assert.equal(ids.includes("AUTH_A"), false);
  // Local (non-exported) functions must NOT appear.
  assert.equal(ids.includes("internalHelper"), false);
});

test("function-manifest: manifest hash is deterministic", () => {
  const m1 = generateFunctionManifest({ config: makePerfConfig(), architectureModules: sampleModules, moduleSources: sampleSources });
  const m2 = generateFunctionManifest({ config: makePerfConfig(), architectureModules: sampleModules, moduleSources: sampleSources });
  assert.equal(m1.manifestHash, m2.manifestHash);
});

test("function-manifest: different modules produce different hashes", () => {
  const m1 = generateFunctionManifest({ config: makePerfConfig(), architectureModules: sampleModules, moduleSources: sampleSources });
  const m2 = generateFunctionManifest({ config: makePerfConfig(), architectureModules: [sampleModules[0]!], moduleSources: sampleSources });
  assert.notEqual(m1.manifestHash, m2.manifestHash);
});

test("function-manifest: exclusions are recorded in manifest", () => {
  const exclusion: FunctionManifestExclusion = {
    moduleId: "mod-a",
    functionId: "processA",
    rationale: "Not applicable to performance measurement",
    owner: "performance-observability",
    evidence: ["docs/research/performance-exclusion.md"],
    scope: "performance-observability",
  };
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
    exclusions: [exclusion],
  });
  assert.ok(manifest.excludedFunctions > 0);
  const excludedEntry = manifest.entries.find((e) => e.excluded);
  assert.ok(excludedEntry !== undefined);
  assert.equal(excludedEntry.functionId, "processA");
  assert.equal(excludedEntry.exclusionRationale, "Not applicable to performance measurement");
});

test("function-manifest: validateFunctionManifest detects stale architecture", () => {
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
  });
  const result = validateFunctionManifest(manifest, [sampleModules[0]!]);
  assert.equal(result.stale, true);
  assert.ok(result.violations.includes("function_manifest_stale_architecture_hash"));
  assert.equal(result.valid, false);
});

test("function-manifest: validateFunctionManifest passes for current architecture", () => {
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
  });
  const result = validateFunctionManifest(manifest, sampleModules);
  assert.equal(result.stale, false);
  assert.equal(result.valid, true);
  assert.deepEqual([...result.violations], []);
});

test("function-manifest: validateFunctionManifest detects exclusion without entry", () => {
  const exclusion: FunctionManifestExclusion = {
    moduleId: "mod-a",
    functionId: "nonexistent-function",
    rationale: "test",
    owner: "test",
    evidence: ["evidence"],
    scope: "test",
  };
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
    exclusions: [exclusion],
  });
  const result = validateFunctionManifest(manifest, sampleModules);
  assert.ok(result.violations.some((v) => v.includes("function_manifest_exclusion_without_entry")));
});

test("function-manifest: validateFunctionManifest detects exclusion without evidence", () => {
  const exclusion: FunctionManifestExclusion = {
    moduleId: "mod-a",
    functionId: "processA",
    rationale: "test",
    owner: "test",
    evidence: [],
    scope: "test",
  };
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
    exclusions: [exclusion],
  });
  const result = validateFunctionManifest(manifest, sampleModules);
  assert.ok(result.violations.some((v) => v.includes("function_manifest_exclusion_no_evidence")));
});

test("function-manifest: validateFunctionManifest detects exclusion without rationale", () => {
  const exclusion: FunctionManifestExclusion = {
    moduleId: "mod-a",
    functionId: "processA",
    rationale: "",
    owner: "test",
    evidence: ["evidence"],
    scope: "test",
  };
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
    exclusions: [exclusion],
  });
  const result = validateFunctionManifest(manifest, sampleModules);
  assert.ok(result.violations.some((v) => v.includes("function_manifest_exclusion_no_rationale")));
});

test("function-manifest: coverage returns correct percentages", () => {
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
  });
  const coverage = functionManifestCoverage(manifest);
  assert.equal(coverage.totalFunctions, manifest.totalFunctions);
  assert.equal(coverage.includedFunctions, manifest.includedFunctions);
  assert.equal(coverage.excludedFunctions, manifest.excludedFunctions);
  assert.ok(coverage.coveragePercent > 0);
});

test("function-manifest: coverage with exclusions reduces percentage", () => {
  const exclusion: FunctionManifestExclusion = {
    moduleId: "mod-a",
    functionId: "processA",
    rationale: "excluded",
    owner: "test",
    evidence: ["evidence"],
    scope: "test",
  };
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
    exclusions: [exclusion],
  });
  const coverage = functionManifestCoverage(manifest);
  assert.ok(coverage.coveragePercent < 100);
});

test("function-manifest: the include-list is gone — scope is exclude-only", () => {
  // The allowlist filter this replaces silently narrowed coverage to the
  // hand-listed modules. The posture is now deny-by-default: every declared
  // module is in scope, `excludedModules` is the only way out, and populating
  // the dead `includedModules` field FAILS schema validation rather than
  // resurrecting the allowlist.
  // Built raw, not through makePerfConfig (which parses — the parse refusal
  // is the assertion, not an accident).
  const resurrect = {
    ...DEFAULT_PERFORMANCE_CONFIG,
    scope: { excludedModules: [], includedModules: ["mod-a"] },
  };
  assert.throws(
    () => parsePerformanceConfig(resurrect),
    (err: unknown) => {
      assert.ok(err instanceof z.ZodError, "refusal must be a ZodError");
      assert.equal(err.issues[0]!.code, "unrecognized_keys");
      assert.match(err.issues[0]!.message, /"includedModules"/u,
        "the refusal must name the resurrected allowlist field");
      return true;
    },
  );
  // And an UNLISTED module is in scope by default — the manifest generates
  // every declared module's functions without any include-list to update.
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
  });
  assert.ok(manifest.entries.length > 0);
  const moduleIds = new Set(manifest.entries.map((e) => e.moduleId));
  for (const module of sampleModules) {
    assert.ok(moduleIds.has(module.id), `${module.id} must be in scope by default`);
  }
});

test("function-manifest: scope excludedModules filters entries", () => {
  const config = makePerfConfig({ scope: { ...DEFAULT_PERFORMANCE_CONFIG.scope, excludedModules: ["mod-a"] } });
  const manifest = generateFunctionManifest({
    config,
    architectureModules: sampleModules,
    moduleSources: sampleSources,
  });
  for (const entry of manifest.entries) {
    assert.notEqual(entry.moduleId, "mod-a");
  }
  assert.ok(manifest.entries.length > 0);
});

test("function-manifest: generates from real ARCHITECTURE_MANIFEST", () => {
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: ARCHITECTURE_MANIFEST.modules,
    moduleSources: repositoryModuleSources(),
  });
  assert.ok(manifest.totalFunctions > 100);
  assert.equal(manifest.includedFunctions, manifest.totalFunctions);
});

test("function-manifest: entries have unique keys", () => {
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
  });
  const keys = manifest.entries.map((e) => `${e.moduleId}:${e.functionId}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("function-manifest: generatedAt is a valid timestamp", () => {
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
    clock: () => "2026-07-17T00:00:00.000Z",
  });
  assert.equal(manifest.generatedAt, "2026-07-17T00:00:00.000Z");
});

test("function-manifest: validateFunctionManifest detects duplicate entries", () => {
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
    moduleSources: sampleSources,
  });
  const tampered = {
    ...manifest,
    entries: [...manifest.entries, manifest.entries[0]!],
  };
  const result = validateFunctionManifest(tampered, sampleModules);
  assert.ok(result.violations.some((v) => v.includes("function_manifest_duplicate")));
});

test("function-manifest: a module with known exports yields those exports as functions", () => {
  const module: ArchitectureModule = {
    id: "exported-fns", path: "src/exported-fns.ts", realm: "shared", layer: "domain", owner: "owner",
    allowedDependencyLayers: ["domain"], compositionRoot: false, executionBoundary: "pure" as const,
    ports: { requires: [], provides: [] }, effects: [], configPaths: [], stateOwners: [],
    projectionOwners: [], authorityFamilies: [], authorityIdentifiers: [], responsibilities: ["exported-fns"],
  };
  const source = "export function alpha(): void {}\nexport function beta(): void {}\nfunction localOnly(): void {}\n";
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: [module],
    moduleSources: new Map([["src/exported-fns.ts", source]]),
  });
  const ids = manifest.entries.map((e) => e.functionId).toSorted();
  assert.deepEqual(ids, ["alpha", "beta"]);
  assert.equal(ids.includes("localOnly"), false);
  assert.equal(manifest.totalFunctions, 2);
});

test("function-manifest: a module with no exports yields zero functions", () => {
  const module: ArchitectureModule = {
    id: "no-exports", path: "src/no-exports.ts", realm: "shared", layer: "domain", owner: "owner",
    allowedDependencyLayers: ["domain"], compositionRoot: false, executionBoundary: "pure" as const,
    ports: { requires: [], provides: [] }, effects: [], configPaths: [], stateOwners: [],
    projectionOwners: [], authorityFamilies: [], authorityIdentifiers: [], responsibilities: ["no-exports"],
  };
  const source = "function localHelper(): void {}\nconst value = 1;\n";
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: [module],
    moduleSources: new Map([["src/no-exports.ts", source]]),
  });
  assert.equal(manifest.totalFunctions, 0);
  assert.equal(manifest.entries.length, 0);
});

test("function-manifest: a module without provided source yields zero functions", () => {
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: sampleModules,
  });
  assert.equal(manifest.totalFunctions, 0);
  assert.equal(manifest.entries.length, 0);
});

// ── The manifest as the auto-instrumentation coverage gate ───────────────────
//
// The manifest used to be inert: it inventories every in-scope exported
// function and validates its own exclusions, but nothing consumed it. The
// engine-span decoration made the hub's re-exports self-instrumenting, and the
// decoration's reviewed exclusions are the manifest's own exclusion mechanism
// — so the manifest now gates them: every exclusion the decoration owner
// declares must name a REAL function the manifest inventories, with the
// review fields the validator enforces. A stale or evidence-free exclusion
// reds here, and the hub-side guard (tests/prevention/recording-choke-points.test.ts
// class G) holds the other half: no value re-export bypasses the decoration.
import { ENGINE_SPAN_EXCLUSIONS } from "../../src/performance/engine-instrumentation.ts";

test("function-manifest: every engine-span exclusion names a real inventoried function with the review fields", () => {
  const exclusions: FunctionManifestExclusion[] = Object.entries(ENGINE_SPAN_EXCLUSIONS).map(([key, entry]) => {
    const [moduleId, functionId] = key.split(":");
    return {
      moduleId: moduleId!,
      functionId: functionId!,
      rationale: entry.rationale,
      owner: entry.owner,
      evidence: [...entry.evidence],
      scope: entry.scope,
    };
  });
  // The manifest inventories function DECLARATIONS per module. An exclusion
  // may name a function the module RE-EXPORTS (an index barrel's surface),
  // which source extraction cannot see — that class is held by the runtime
  // half of the next test, never silently tolerated.
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: ARCHITECTURE_MANIFEST.modules,
    moduleSources: repositoryModuleSources(),
    exclusions,
  });
  const result = validateFunctionManifest(manifest, ARCHITECTURE_MANIFEST.modules);
  // An entry-less exclusion is expected for the re-exported class; every
  // OTHER violation (no evidence, no rationale, not marked) is a defect.
  const real = result.violations.filter((v) => !v.includes("function_manifest_exclusion_without_entry"));
  assert.deepEqual([...real], []);
  // Every exclusion that MARKED an entry carries the review fields.
  const marked = manifest.entries.filter((e) => e.excluded);
  assert.equal(manifest.excludedFunctions, marked.length);
  for (const entry of marked) {
    assert.equal(entry.exclusionOwner, "performance-observability");
    assert.ok(entry.exclusionRationale !== undefined && entry.exclusionRationale.length > 0);
  }
  // And the coverage report counts them honestly.
  const coverage = functionManifestCoverage(manifest);
  assert.equal(coverage.excludedFunctions, marked.length);
  assert.ok(coverage.coveragePercent < 100);
});

test("function-manifest: an exclusion naming nothing the tree really exports is refused", async () => {
  // THE DENY DIRECTION, both halves. (a) An exclusion naming a function the
  // manifest DOES inventory must mark a real entry — planted here with a
  // never-exported name. (b) The re-exported class is held at RUNTIME: an
  // exclusion may only name something the hub really re-exports as a
  // function, because the manifest's source extractor cannot see re-exports.
  const bogus: FunctionManifestExclusion[] = [
    {
      moduleId: "timeline-types",
      functionId: "no-such-function-anywhere",
      rationale: "planted for the mutation: a stale exclusion must red",
      owner: "performance-observability",
      evidence: ["this test"],
      scope: "engine-auto-instrumentation",
    },
  ];
  const timelineTypesModule = ARCHITECTURE_MANIFEST.modules.find((m) => m.id === "timeline-types")!;
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: [timelineTypesModule],
    moduleSources: repositoryModuleSources([timelineTypesModule]),
    exclusions: bogus,
  });
  const result = validateFunctionManifest(manifest, [timelineTypesModule]);
  assert.equal(result.valid, false);
  assert.ok(
    result.violations.some((v) => v.includes("function_manifest_exclusion_without_entry")),
    `the refusal must name the entry-less exclusion, got: ${result.violations.join("; ")}`,
  );
  // (b) The runtime half: every exclusion names a declared architecture
  // module, and the hub really re-exports that name as a function.
  const hub = await import("../../../server/kernel/canonical.ts");
  for (const [key] of Object.entries(ENGINE_SPAN_EXCLUSIONS)) {
    const [moduleId, functionId] = key.split(":") as [string, string];
    assert.ok(
      ARCHITECTURE_MANIFEST.modules.some((m) => m.id === moduleId),
      `exclusion ${key} names an architecture module the manifest does not declare`,
    );
    const value = (hub as unknown as Record<string, unknown>)[functionId];
    assert.equal(
      typeof value,
      "function",
      `exclusion ${key} names something the hub does not re-export as a function`,
    );
  }
});
