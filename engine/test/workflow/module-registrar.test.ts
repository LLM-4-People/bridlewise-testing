import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  insertModuleContractBlock,
  scanSourceModules,
  compareModuleRegistrations,
  generateModuleRegistrarReport,
  parseModuleRegistrarReport,
  MODULE_REGISTRAR_SCHEMA_VERSION,
  type ModuleRegistrarReport,
  type ModuleRegistration,
} from "../../src/workflow/module-registrar.ts";
import { ARCHITECTURE_MANIFEST } from "../../src/architecture-manifest.ts";
import { declaredModuleContracts } from "../../src/workflow/module-contract-blocks.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { engineModulePath, engineModuleSourceRelative } from "../support/module-resolver.ts";
import { createRepositoryWorkingCopy, engineGeneratorPopulation, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Shared cached repo-wide scans.
//
// scanSourceModules(ROOT) parses every src/*.ts with babel; compareModuleRegistrations
// and generateModuleRegistrarReport each run that scan plus a manifest diff.
// Many tests below assert distinct invariants over the SAME scan output; re-scanning
// per assertion dominates this file's cost. The scans are deterministic and read-only,
// so a single lazy invocation is reused by every assertion that does not specifically
// exercise a temp-project fixture or mutation behavior.
// ---------------------------------------------------------------------------

let cachedModules: readonly ModuleRegistration[] | null = null;
let cachedComparison: ReturnType<typeof compareModuleRegistrations> | null = null;
let cachedReport: ModuleRegistrarReport | null = null;

function modules(): readonly ModuleRegistration[] {
  if (cachedModules) return cachedModules;
  cachedModules = scanSourceModules(ROOT);
  return cachedModules;
}

function comparison(): ReturnType<typeof compareModuleRegistrations> {
  if (cachedComparison) return cachedComparison;
  cachedComparison = compareModuleRegistrations(ROOT);
  return cachedComparison;
}

function report(): ModuleRegistrarReport {
  if (cachedReport) return cachedReport;
  cachedReport = generateModuleRegistrarReport(ROOT);
  return cachedReport;
}

test("ModuleRegistrar: scanSourceModules produces a non-empty, sorted, frozen array of well-formed entries", () => {
  const mods = modules();
  assert.ok(mods.length > 0);
  for (const module of mods) {
    assert.ok(typeof module.path === "string");
    assert.ok(module.path.length > 0);
    assert.ok(typeof module.exportCount === "number");
    assert.ok(typeof module.namesSha256 === "string");
    assert.ok(Array.isArray(module.dependencies));
  }
  assert.ok(Object.isFrozen(mods));
  for (const module of mods) {
    assert.ok(Object.isFrozen(module));
  }
  for (let i = 1; i < mods.length; i++) {
    assert.ok(mods[i - 1]!.path <= mods[i]!.path);
  }
});

test("ModuleRegistrar: scanSourceModules includes known core and workflow modules", () => {
  const paths = modules().map((entry) => entry.path);
  // The kernel modules were moved into src/kernel/ by the fold; resolve their
  // current locations from the resolver (the owner of where a module lives)
  // rather than pinning a pre-fold path. errors.ts is ambiguous (kernel, mcp,
  // shared/llm), so disambiguate by fragment.
  for (const expected of [
    engineModuleSourceRelative("integrity.ts"),
    engineModuleSourceRelative("kernel/errors.ts"),
    engineModuleSourceRelative("root-policy.ts"),
    "src/architecture-manifest.ts",
    "src/workflow/test-result-collector.ts",
    "src/workflow/module-registrar.ts",
    "src/workflow/auto-generator.ts",
    "src/workflow/harness-commands.ts",
    "src/workflow/resource-lock.ts",
  ]) {
    assert.ok(paths.includes(expected), `missing ${expected}`);
  }
});

test("ModuleRegistrar: integrity.ts has correct export count and dependencies", () => {
  const integrityPath = engineModuleSourceRelative("integrity.ts");
  const errorsPath = engineModuleSourceRelative("kernel/errors.ts");
  const integrity = modules().find((entry) => entry.path === integrityPath);
  assert.ok(integrity);
  const manifestEntry = ARCHITECTURE_MANIFEST.modules.find((m) => m.path === integrityPath);
  assert.ok(manifestEntry, `${integrityPath} must be present in the architecture manifest`);
  // Dynamic: compare the computed export count against the manifest's
  // exportCount (the canonical authority kept in sync by `harness
  // regenerate`). A hardcoded literal goes stale when exports are added;
  // comparing against the manifest catches real drift without requiring
  // test edits on every export change.
  assert.equal(integrity!.exportCount, manifestEntry!.publicApi.exportCount);
  // Recompute-and-compare: the manifest's namesSha256 for integrity.ts must
  // match the namesSha256 computed from the source. The broader drift test
  // (compareModuleRegistrations) covers the same invariant for all modules;
  // this is the targeted per-module check.
  assert.equal(integrity!.namesSha256, manifestEntry!.publicApi.namesSha256);
  assert.ok(integrity!.dependencies.includes("node:crypto"));
  assert.ok(integrity!.dependencies.includes(errorsPath));
});

test("ModuleRegistrar: workflow modules have correct export counts", () => {
  const mods = modules();
  const manifestByPath = new Map(ARCHITECTURE_MANIFEST.modules.map((m) => [m.path, m]));
  // Verify each workflow module's computed export count matches its manifest
  // entry (the canonical authority kept in sync by `harness register --write`).
  // Hardcoded counts go stale when exports are added; comparing against the
  // manifest catches real drift without requiring test edits on every export.
  const workflowPaths = [
    "src/workflow/test-result-collector.ts",
    "src/workflow/module-registrar.ts",
    "src/workflow/auto-generator.ts",
    "src/workflow/harness-commands.ts",
    "src/workflow/resource-lock.ts",
  ];
  for (const path of workflowPaths) {
    const computed = mods.find((entry) => entry.path === path);
    assert.ok(computed, `${path} must be scanned`);
    const manifestEntry = manifestByPath.get(path);
    assert.ok(manifestEntry, `${path} must be in the manifest`);
    assert.equal(
      computed!.exportCount,
      manifestEntry!.publicApi.exportCount,
      `${path} export count drift: computed ${computed!.exportCount} vs manifest ${manifestEntry!.publicApi.exportCount}`,
    );
    assert.equal(
      computed!.namesSha256,
      manifestEntry!.publicApi.namesSha256,
      `${path} names hash drift`,
    );
  }
});

test("ModuleRegistrar: compareModuleRegistrations returns empty drift and unregistered arrays for the real project", () => {
  const result = comparison();
  assert.ok(Array.isArray(result.drift));
  assert.ok(Array.isArray(result.unregistered));
  assert.equal(result.drift.length, 0, `drift: ${result.drift.map((entry) => entry.path).join(", ")}`);
  assert.equal(result.unregistered.length, 0, `unregistered: ${result.unregistered.map((entry) => entry.path).join(", ")}`);
});

test("ModuleRegistrar: generateModuleRegistrarReport produces a valid, frozen, integrity-checked report", () => {
  const r = report();
  assert.equal(r.schemaVersion, MODULE_REGISTRAR_SCHEMA_VERSION);
  assert.ok(r.totalSourceModules > 0);
  assert.ok(r.totalRegisteredModules > 0);
  assert.ok(typeof r.integrityHash === "string");
  assert.ok(Object.isFrozen(r));
  const { integrityHash, ...unsigned } = r;
  assert.equal(sha256(canonicalJson(unsigned)), integrityHash);
  const parsed = new Date(r.generatedAt);
  assert.ok(!Number.isNaN(parsed.getTime()));
});

test("ModuleRegistrar: parseModuleRegistrarReport parses valid report and rejects invalid inputs", () => {
  const r = report();
  const parsed = parseModuleRegistrarReport(JSON.parse(canonicalJson(r)));
  assert.equal(parsed.schemaVersion, r.schemaVersion);
  assert.equal(parsed.totalSourceModules, r.totalSourceModules);

  assert.throws(() => parseModuleRegistrarReport(null), /must be an object/);
  assert.throws(() => parseModuleRegistrarReport("str"), /must be an object/);
  assert.throws(() => parseModuleRegistrarReport(42), /must be an object/);

  const wrongSchema = JSON.parse(canonicalJson(r));
  wrongSchema.schemaVersion = "wrong";
  assert.throws(() => parseModuleRegistrarReport(wrongSchema), /schema version/);

  const tampered = JSON.parse(canonicalJson(r));
  tampered.integrityHash = "0".repeat(64);
  assert.throws(() => parseModuleRegistrarReport(tampered), /integrity is invalid/);

  const missing = JSON.parse(canonicalJson(r));
  delete missing.integrityHash;
  assert.throws(() => parseModuleRegistrarReport(missing), /integrity hash/);
});

test("ModuleRegistrar: report determinism - same root produces same report (ignoring timestamp)", () => {
  const report1 = generateModuleRegistrarReport(ROOT);
  const report2 = generateModuleRegistrarReport(ROOT);
  assert.equal(report1.totalSourceModules, report2.totalSourceModules);
  assert.equal(report1.unregisteredModules, report2.unregisteredModules);
  assert.equal(report1.driftedModules, report2.driftedModules);
  assert.deepEqual(report1.drift, report2.drift);
  assert.deepEqual(report1.unregistered, report2.unregistered);
});

test("ModuleRegistrar: report has zero drift for the real project (write mode would not throw)", () => {
  const r = report();
  assert.equal(r.driftedModules, 0, `drift: ${r.drift.map((entry) => entry.path).join(", ")}`);
});

test("ModuleRegistrar: postWrite is null in read-only mode", () => {
  const r = report();
  assert.equal(r.postWrite, null);
});

test("ModuleRegistrar: write mode removes missing-source entries and reports clean", () => {
  // Fixture: only the manifest file exists. Every manifest entry points at an
  // absent source file. The auto-registration now REMOVES those entries
  // (previously they were marked uncorrectable). The report must surface the
  // POST-WRITE reality: all missing-source entries removed, manifest clean.
  const tmpDir = createTempDir("registrar-postwrite-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "architecture-manifest.ts"), readFileSync(join(ROOT, "src", "architecture-manifest.ts"), "utf8"));
    const before = readFileSync(join(tmpDir, "src", "architecture-manifest.ts"), "utf8");
    const r = generateModuleRegistrarReport(tmpDir, { write: true });
    assert.ok(r.postWrite !== null);
    // Every manifest entry except the copied architecture-manifest.ts module
    // itself points at an absent source file and is now REMOVED by the
    // auto-registration (not marked uncorrectable).
    assert.equal(r.postWrite!.removedModules, ARCHITECTURE_MANIFEST.modules.length - 1);
    assert.equal(r.postWrite!.driftedModules, 0);
    assert.equal(r.postWrite!.unregisteredModules, 0);
    assert.equal(r.postWrite!.addedModules, 0);
    assert.equal(r.postWrite!.clean, true);
    // The manifest IS modified — missing-source blocks were removed.
    const after = readFileSync(join(tmpDir, "src", "architecture-manifest.ts"), "utf8");
    assert.notEqual(after, before);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: write mode auto-registers unregistered source files", () => {
  // Fixture: a temp project with the real manifest plus two new source files
  // not in the manifest. The auto-registration must ADD moduleContract blocks
  // for both, and the post-write state must be clean.
  const tmpDir = createTempDir("registrar-autoreg-");
  try {
    for (const dir of ["src", "src/kernel", "scripts"]) {
      mkdirSync(join(tmpDir, dir), { recursive: true });
    }
    // Copy the real manifest + a few real source files so the classification
    // has neighbors to inherit realm/layer/owner from.
    writeFileSync(join(tmpDir, "src", "architecture-manifest.ts"), readFileSync(join(ROOT, "src", "architecture-manifest.ts"), "utf8"));
    writeFileSync(join(tmpDir, engineModuleSourceRelative("integrity.ts")), readFileSync(join(ROOT, engineModuleSourceRelative("integrity.ts")), "utf8"));
    writeFileSync(join(tmpDir, engineModuleSourceRelative("kernel/errors.ts")), readFileSync(join(ROOT, engineModuleSourceRelative("kernel/errors.ts")), "utf8"));
    // Two NEW source files not in the manifest.
    writeFileSync(join(tmpDir, "src", "auto-reg-new-a.ts"), `export const AUTO_REG_A = 1;\n`);
    writeFileSync(join(tmpDir, "src", "auto-reg-new-b.ts"), `export const AUTO_REG_B = 2;\nexport function autoRegB() { return 2; }\n`);

    const r = generateModuleRegistrarReport(tmpDir, { write: true });
    assert.ok(r.postWrite !== null);
    assert.equal(r.postWrite!.addedModules, 2);
    assert.equal(r.postWrite!.unregisteredModules, 0);
    assert.equal(r.postWrite!.driftedModules, 0);
    assert.equal(r.postWrite!.clean, true);
    // The manifest now contains blocks for both new files.
    const after = readFileSync(join(tmpDir, "src", "architecture-manifest.ts"), "utf8");
    assert.ok(after.includes(`path: "src/auto-reg-new-a.ts"`), "auto-reg-new-a.ts must be registered");
    assert.ok(after.includes(`path: "src/auto-reg-new-b.ts"`), "auto-reg-new-b.ts must be registered");
    // The ids must be deterministic and path-derived.
    assert.ok(after.includes(`id: "src-auto-reg-new-a"`), "id for auto-reg-new-a.ts must be path-derived");
    assert.ok(after.includes(`id: "src-auto-reg-new-b"`), "id for auto-reg-new-b.ts must be path-derived");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: two branches that each add a module merge cleanly — a new block goes before its successor by path, never at the tail (#221)", () => {
  // The real manifest is the base; one branch adds module A, the other module B. Merged three-way by git, the two
  // additions must merge with no conflict and equal the manifest that added both.
  const base = readFileSync(join(ROOT, "src", "architecture-manifest.ts"), "utf8");
  const block = (path: string): string => `    moduleContract({\n      id: "${path.replace(/[^A-Za-z0-9]+/gu, "-")}", path: "${path}", realm: "engine", layer: "kernel",\n      owner: "kernel", publicApi: { exportCount: 1, namesSha256: "${"0".repeat(64)}" },\n      dependencies: [],\n    }),`;
  const add = (content: string, path: string): string => {
    const next = insertModuleContractBlock(content, block(path), path);
    assert.ok(next !== null, "the modules array close was found");
    return next;
  };
  const pathA = "src/kernel/sorted-new-a.ts";
  const pathB = "src/workflow/sorted-new-b.ts";
  const withA = add(base, pathA);
  const withB = add(base, pathB);
  const withBoth = add(withA, pathB);
  assert.equal(withBoth, add(withB, pathA), "the order the two arrive in does not matter");
  assert.equal(withA.trimEnd().endsWith("});"), true);
  assert.ok(!/sorted-new-a[\s\S]*\n  \],\n\}\);\n?$/u.test(withA.slice(-400)), "the new block is not appended at the tail");
  const dir = createTempDir("registrar-merge-");
  try {
    writeFileSync(join(dir, "ours"), withA);
    writeFileSync(join(dir, "base"), base);
    writeFileSync(join(dir, "theirs"), withB);
    const merged = spawnSync("git", ["merge-file", "-p", join(dir, "ours"), join(dir, "base"), join(dir, "theirs")], { encoding: "utf8" });
    assert.equal(merged.status, 0, `the two additions conflicted:\n${merged.stdout.slice(0, 2000)}`);
    assert.equal(merged.stdout, withBoth, "the clean merge is exactly the manifest that registered both");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: detect unregistered module in temp project", () => {
  const tmpDir = createTempDir("registrar-unreg-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "existing.ts"), `export const FOO = 1;\n`);
    writeFileSync(join(tmpDir, "src", "new.ts"), `export const BAR = 2;\n`);
    writeFileSync(join(tmpDir, "test", "run.test.ts"), `
import test from "node:test";
import assert from "node:assert/strict";
test("passing", () => { assert.equal(1, 1); });
`);
    const result = compareModuleRegistrations(tmpDir);
    assert.ok(result.unregistered.length >= 2);
    const unregPaths = result.unregistered.map((entry) => entry.path);
    assert.ok(unregPaths.some((path) => path.includes("existing.ts")));
    assert.ok(unregPaths.some((path) => path.includes("new.ts")));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: detects export count in temp project", () => {
  const tmpDir = createTempDir("registrar-drift-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "mod.ts"), `export const A = 1;\nexport const B = 2;\nexport const C = 3;\n`);
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "x.test.ts"), `import test from "node:test";\ntest("x", () => {});\n`);
    const mods = scanSourceModules(tmpDir);
    const mod = mods.find((entry) => entry.path === "src/mod.ts");
    assert.ok(mod);
    assert.equal(mod!.exportCount, 3);
    assert.equal(mod!.registered, false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: handles module with zero exports", () => {
  const tmpDir = createTempDir("registrar-zero-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "empty.ts"), `const INTERNAL = 1;\n`);
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "t.test.ts"), `import test from "node:test";\ntest("t", () => {});\n`);
    const mods = scanSourceModules(tmpDir);
    const empty = mods.find((entry) => entry.path === "src/empty.ts");
    assert.ok(empty);
    assert.equal(empty!.exportCount, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: handles default export", () => {
  const tmpDir = createTempDir("registrar-default-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "default.ts"), `export default function() { return 1; }\n`);
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "t.test.ts"), `import test from "node:test";\ntest("t", () => {});\n`);
    const mods = scanSourceModules(tmpDir);
    const def = mods.find((entry) => entry.path === "src/default.ts");
    assert.ok(def);
    assert.equal(def!.exportCount, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: handles re-exports", () => {
  const tmpDir = createTempDir("registrar-reexport-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "base.ts"), `export const X = 1;\n`);
    writeFileSync(join(tmpDir, "src", "reexport.ts"), `export { X } from "./base.ts";\n`);
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "t.test.ts"), `import test from "node:test";\ntest("t", () => {});\n`);
    const mods = scanSourceModules(tmpDir);
    const reexport = mods.find((entry) => entry.path === "src/reexport.ts");
    assert.ok(reexport);
    assert.equal(reexport!.exportCount, 1);
    assert.ok(reexport!.dependencies.includes("src/base.ts"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: handles namespace imports", () => {
  const tmpDir = createTempDir("registrar-ns-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "ns.ts"), `import * as fs from "node:fs";\nexport const USE = fs;\n`);
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "t.test.ts"), `import test from "node:test";\ntest("t", () => {});\n`);
    const mods = scanSourceModules(tmpDir);
    const ns = mods.find((entry) => entry.path === "src/ns.ts");
    assert.ok(ns);
    assert.ok(ns!.dependencies.includes("node:fs"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: handles type-only imports (not counted as dependencies)", () => {
  const tmpDir = createTempDir("registrar-type-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "types.ts"), `export type MyType = string;\n`);
    writeFileSync(join(tmpDir, "src", "consumer.ts"), `import type { MyType } from "./types.ts";\nexport const X: MyType = "hello";\n`);
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "t.test.ts"), `import test from "node:test";\ntest("t", () => {});\n`);
    const mods = scanSourceModules(tmpDir);
    const consumer = mods.find((entry) => entry.path === "src/consumer.ts");
    assert.ok(consumer);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: handles dynamic import in source", () => {
  const tmpDir = createTempDir("registrar-dynamic-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "dynamic.ts"), `export async function load() { return import("./base.ts"); }\n`);
    writeFileSync(join(tmpDir, "src", "base.ts"), `export const X = 1;\n`);
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "t.test.ts"), `import test from "node:test";\ntest("t", () => {});\n`);
    const mods = scanSourceModules(tmpDir);
    const dynamic = mods.find((entry) => entry.path === "src/dynamic.ts");
    assert.ok(dynamic);
    assert.ok(dynamic!.dependencies.includes("src/base.ts"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: handles multiple export types (const, function, class, type, interface, enum)", () => {
  const tmpDir = createTempDir("registrar-multi-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "multi.ts"), `
export const C = 1;
export function F() {}
export class K {}
export type T = string;
export interface I {}
export enum E { A, B }
`);
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "t.test.ts"), `import test from "node:test";\ntest("t", () => {});\n`);
    const mods = scanSourceModules(tmpDir);
    const multi = mods.find((entry) => entry.path === "src/multi.ts");
    assert.ok(multi);
    assert.equal(multi!.exportCount, 6);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: handles export with rename", () => {
  const tmpDir = createTempDir("registrar-rename-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "rename.ts"), `const INTERNAL = 1;\nexport { INTERNAL as PUBLIC };\n`);
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "t.test.ts"), `import test from "node:test";\ntest("t", () => {});\n`);
    const mods = scanSourceModules(tmpDir);
    const rename = mods.find((entry) => entry.path === "src/rename.ts");
    assert.ok(rename);
    assert.equal(rename!.exportCount, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: handles export * from", () => {
  const tmpDir = createTempDir("registrar-star-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "base.ts"), `export const A = 1;\nexport const B = 2;\n`);
    writeFileSync(join(tmpDir, "src", "star.ts"), `export * from "./base.ts";\n`);
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "t.test.ts"), `import test from "node:test";\ntest("t", () => {});\n`);
    const mods = scanSourceModules(tmpDir);
    const star = mods.find((entry) => entry.path === "src/star.ts");
    assert.ok(star);
    assert.ok(star!.dependencies.includes("src/base.ts"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: 30 modules in temp project are all scanned", () => {
  const tmpDir = createTempDir("registrar-bulk-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(tmpDir, "src", `mod${i}.ts`), `export const V${i} = ${i};\nexport function F${i}() { return ${i}; }\n`);
    }
    writeFileSync(join(tmpDir, "test", "t.test.ts"), `import test from "node:test";\ntest("t", () => {});\n`);
    const mods = scanSourceModules(tmpDir);
    const srcModules = mods.filter((entry) => entry.path.startsWith("src/"));
    assert.ok(srcModules.length >= 30);
    for (let i = 0; i < 30; i++) {
      const mod = srcModules.find((entry) => entry.path === `src/mod${i}.ts`);
      assert.ok(mod, `mod${i}.ts not found`);
      assert.equal(mod!.exportCount, 2);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: runtime reference profile and source type API survive registration", () => {
  const directory = createTempDir("registrar-reference-");
  try {
    mkdirSync(join(directory, "src"), { recursive: true });
    const path = join(directory, "src", "reference.tsx");
    writeFileSync(path, 'export type * as Types from "./types.ts"; import { type RuntimeType } from "./live.ts"; export const view = <div>import("./text.ts"){import("./dynamic.ts")}</div>;');
    const rows = scanSourceModules(directory);
    const row = rows.find(entry => entry.path === "src/reference.tsx");
    assert.ok(row);
    assert.deepEqual(row.dependencies, ["src/dynamic.ts", "src/live.ts"]);
    assert.equal(row.exportCount, 2);
    assert.equal(row.namesSha256, sha256(canonicalJson(["Types", "view"])));
    const unsupportedPath = join(directory, "src", "unsupported.ts");
    for (const [source, construct] of [['import Alias = require("./target.ts");', "import-equals"], ['export = 1;', "export assignment"], ['const value = <unknown>import("./target.ts");', "angle-bracket assertion"]] as const) {
      writeFileSync(unsupportedPath, source);
      assert.throws(() => scanSourceModules(directory), { message: `unsupported TypeScript ${construct} in strip-only profile` });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("ModuleRegistrar: the manifest's blocks are read as data — any property order, only moduleContract calls", () => {
  const planted = [
    "export const ARCHITECTURE_MANIFEST = deepFreeze({",
    '  benchmarks: [{ id: "bench-row", path: "verification/benchmarks/x.py" }],',
    "  modules: [",
    '    moduleContract({\n      id: "a-mod", path: "src/a.ts", realm: "runtime", layer: "domain",\n    }),',
    '    moduleContract({ path: "src/b.ts", compositionRoot: true, realm: "tooling", id: "b-mod" }),',
    "  ],",
    "});",
  ].join("\n");
  assert.deepEqual(declaredModuleContracts(planted), [
    { id: "a-mod", path: "src/a.ts", realm: "runtime", compositionRoot: false },
    { id: "b-mod", path: "src/b.ts", realm: "tooling", compositionRoot: true },
  ]);
  // …and the real manifest's blocks ARE its modules, id for id.
  const real = declaredModuleContracts(readFileSync(engineModulePath("architecture-manifest.ts"), "utf8"));
  assert.deepEqual(real.map(({ id, path }) => [id, path]), ARCHITECTURE_MANIFEST.modules.map(({ id, path }) => [id, path]));
});

test("ModuleRegistrar: a module that BECAME a direct-execution entrypoint after its registration is marked a composition root; declared roots stay", () => {
  // The flag used to be derived at first registration only: `scripts/post-commit.ts`
  // was registered before it gained its entry guard, stayed unmarked, and the
  // command-effect census refused it with no generator able to fix it. The
  // correction is one-directional: the roots the detector cannot see (top-level
  // programs such as the commit guard, worker entries) are declared and kept,
  // which the byte equality below also proves.
  const entry = "scripts/post-commit.ts";
  assert.equal(ARCHITECTURE_MANIFEST.modules.find((module) => module.path === entry)?.compositionRoot, true, `${entry} is not marked in the manifest this test starts from`);
  const unmarkedManifest = { ...ARCHITECTURE_MANIFEST, modules: ARCHITECTURE_MANIFEST.modules.map((module) => (module.path === entry ? { ...module, compositionRoot: false } : module)) };
  const detected = compareModuleRegistrations(ROOT, unmarkedManifest as typeof ARCHITECTURE_MANIFEST, modules());
  assert.deepEqual(detected.drift.map((module) => module.path), [entry], "an unmarked entrypoint is drift, and only it");
  const declaredRoot = "scripts/commit-guard.ts";
  assert.equal(ARCHITECTURE_MANIFEST.modules.find((module) => module.path === declaredRoot)?.compositionRoot, true);
  assert.ok(!detected.drift.some((module) => module.path === declaredRoot), "a declared root the detector cannot see was reported");

  // The correction, on the manifest FILE, the way `harness sync` runs it (a
  // fresh process, so the file is the truth it reads).
  const copy = createRepositoryWorkingCopy("registrar-entry-", { include: engineGeneratorPopulation });
  try {
    const manifestPath = join(copy.engineRoot, "src", "architecture-manifest.ts");
    const current = readFileSync(manifestPath, "utf8");
    const flag = '\n      executionBoundary: "composition-root", compositionRoot: true,';
    const at = current.indexOf(`path: "${entry}"`);
    const flagAt = current.indexOf(flag, at);
    assert.ok(at >= 0 && flagAt > at && flagAt < current.indexOf("\n    }),", at), `${entry}'s block carries no composition-root fields`);
    const listed = `\n      "${entry}",`;
    assert.ok(current.includes(listed), `${entry} is not in the derived composition-root lists`);
    writeFileSync(manifestPath, `${current.slice(0, flagAt)}${current.slice(flagAt + flag.length)}`.replace(listed, ""));
    const register = spawnSync(process.execPath, [join(copy.engineRoot, "src", "cli.ts"), "harness", "register", "--write"], { cwd: copy.engineRoot, encoding: "utf8" });
    assert.equal(register.status, 0, register.stderr);
    assert.equal(readFileSync(manifestPath, "utf8"), current, "the correction marks exactly that block and lists it, nothing else");
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("ModuleRegistrar: a ONE-LINE block is marked a composition root too — its range never reaches into the next block", () => {
  // A block written on one line (`moduleContract({ … }),`) used to be read up
  // to the next MULTI-line block's end: it borrowed that block's
  // `compositionRoot: true`, the correction wrote nothing, and `harness sync`
  // failed on its own drift (scripts/tooling/planned-node-test-evidence.ts
  // after it gained its entry guard).
  const copy = createRepositoryWorkingCopy("registrar-one-line-", { include: engineGeneratorPopulation });
  try {
    const manifestPath = join(copy.engineRoot, "src", "architecture-manifest.ts");
    const current = readFileSync(manifestPath, "utf8");
    const marked = 'executionBoundary: "composition-root", compositionRoot: true }),';
    const line = current.split("\n").find((candidate) => candidate.trimStart().startsWith("moduleContract({") && candidate.endsWith(marked));
    assert.ok(line !== undefined, "the manifest holds no one-line composition-root block to exercise");
    const entry = /path: "([^"]+)"/u.exec(line)?.[1] ?? "";
    const listed = `\n      "${entry}",`;
    assert.ok(current.includes(listed), `${entry} is not in the derived composition-root lists`);
    const unmarked = line.replace(marked, 'executionBoundary: "effect-adapter" }),');
    writeFileSync(manifestPath, current.replace(line, unmarked).replace(listed, ""));
    const register = spawnSync(process.execPath, [join(copy.engineRoot, "src", "cli.ts"), "harness", "register", "--write"], { cwd: copy.engineRoot, encoding: "utf8" });
    assert.equal(register.status, 0, register.stderr);
    assert.equal(readFileSync(manifestPath, "utf8"), current, "the correction marks exactly that one-line block and lists it, nothing else");
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("ModuleRegistrar: the composition-root lists are derived from the module blocks — a dangling root is reported and rewritten", () => {
  // Deleting an entry-point script used to leave its path in
  // `compositionRoots.<realm>`: the registrar removed the module block but no
  // generator owned the lists, and `harness check` did not notice.
  const copy = createRepositoryWorkingCopy("registrar-roots-", { include: engineGeneratorPopulation });
  try {
    const manifestPath = join(copy.engineRoot, "src", "architecture-manifest.ts");
    const current = readFileSync(manifestPath, "utf8");
    assert.equal(generateModuleRegistrarReport(copy.engineRoot).compositionRootsCurrent, true);
    const dangling = "scripts/tooling/no-such-entry-point.mjs";
    writeFileSync(manifestPath, current.replace("  compositionRoots: {\n    builder: [\n", `  compositionRoots: {\n    builder: [\n      "${dangling}",\n`));
    assert.equal(generateModuleRegistrarReport(copy.engineRoot).compositionRootsCurrent, false);
    const written = generateModuleRegistrarReport(copy.engineRoot, { write: true });
    assert.equal(written.postWrite?.clean, true);
    assert.equal(readFileSync(manifestPath, "utf8"), current, "the regenerated lists are exactly the derived ones");
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});
