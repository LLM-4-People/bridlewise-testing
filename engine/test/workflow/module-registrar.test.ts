import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  scanSourceModules,
  compareModuleRegistrations,
  generateModuleRegistrarReport,
  parseModuleRegistrarReport,
  MODULE_REGISTRAR_SCHEMA_VERSION,
  type ModuleRegistrarReport,
  type ModuleRegistration,
} from "../../src/workflow/module-registrar.ts";
import { ARCHITECTURE_MANIFEST } from "../../src/architecture-manifest.ts";
import { ARCHITECTURE_MODULES } from "../../src/architecture-modules.ts";
import { ARCHITECTURE_MODULES_PATH, architectureModulesText, readArchitectureModuleEntries } from "../../src/workflow/architecture-module-entries.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";
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
    assert.equal(typeof module.registered, "boolean");
    assert.equal(typeof module.compositionRoot, "boolean");
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
    ARCHITECTURE_MODULES_PATH,
    "src/workflow/test-result-collector.ts",
    "src/workflow/module-registrar.ts",
    "src/workflow/auto-generator.ts",
    "src/workflow/harness-commands.ts",
    "src/workflow/resource-lock.ts",
  ]) {
    assert.ok(paths.includes(expected), `missing ${expected}`);
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


// ---------------------------------------------------------------------------
// The entries file (#221): authored decisions only, one entry per line, sorted
// by path, in the one form the registrar writes.
// ---------------------------------------------------------------------------

const ENTRIES_TEXT = (): string => readFileSync(join(ROOT, ARCHITECTURE_MODULES_PATH), "utf8");

/** A new entry for `path`, classified like a fixture. */
const newEntry = (path: string) => ({ id: path.replace(/[^A-Za-z0-9]+/gu, "-"), path, realm: "runtime", layer: "domain", owner: "fixture" } as const);

/** git's own three-way merge of one file: the merged text and the number of conflicts (its exit status). */
function mergeFile(ours: string, base: string, theirs: string): Readonly<{ text: string; conflicts: number }> {
  const directory = createTempDir("registrar-merge-");
  try {
    for (const [name, text] of [["ours", ours], ["base", base], ["theirs", theirs]] as const) writeFileSync(join(directory, name), text);
    const merged = spawnSync("git", ["merge-file", "-p", "ours", "base", "theirs"], { cwd: directory, encoding: "utf8" });
    assert.ok(merged.status !== null && merged.status >= 0, merged.stderr);
    return { text: merged.stdout, conflicts: merged.status };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("ModuleRegistrar: the entries file is in its one form, holds every module and no source-derived aggregate", () => {
  const text = ENTRIES_TEXT();
  const entries = readArchitectureModuleEntries(text);
  assert.equal(architectureModulesText(entries), text, "the committed file is its own canonical rendering (sorted, one entry per line)");
  assert.equal(report().entriesCurrent, true);
  assert.deepEqual(entries.map(({ id, path }) => [id, path]), ARCHITECTURE_MANIFEST.modules.map(({ id, path }) => [id, path]), "the text the registrar reads IS the manifest's modules");
  assert.deepEqual(entries, ARCHITECTURE_MODULES, "the reader and the import agree, entry for entry");
  assert.ok(entries.length >= 700, `the module population collapsed to ${String(entries.length)}`);
  assert.doesNotMatch(text, /namesSha256|exportCount|publicApi|\bdependencies:/u, "a count, name hash or edge list of a module's source is derived by the check, never committed");
  // The composition-root lists are the entries' roles, never a second list.
  for (const [realm, roots] of Object.entries(ARCHITECTURE_MANIFEST.compositionRoots)) {
    assert.deepEqual(roots, entries.filter((entry) => entry.realm === realm && entry.compositionRoot === true).map((entry) => entry.path).toSorted(), realm);
  }
});

test("ModuleRegistrar: two branches registering, removing or reclassifying different modules merge without a conflict", () => {
  const base = ENTRIES_TEXT();
  const entries = readArchitectureModuleEntries(base);
  const ours = [...entries, newEntry("src/kernel/zz-registered-on-one-branch.ts")];
  const theirs = [...entries.filter((entry) => entry.path !== entries[1]!.path), newEntry("src/workflow/zz-registered-on-another.ts")];
  const merged = mergeFile(architectureModulesText(ours), base, architectureModulesText(theirs));
  assert.equal(merged.conflicts, 0, merged.text);
  assert.equal(merged.text, architectureModulesText([...ours.filter((entry) => entry.path !== entries[1]!.path), newEntry("src/workflow/zz-registered-on-another.ts")]), "the merge holds both branches' entries, in the one form");
  // A reclassification is one line too.
  const owner = (index: number) => entries.map((entry, at) => at === index ? { ...entry, owner: `${entry.owner}-moved` } : entry);
  assert.equal(mergeFile(architectureModulesText(owner(10)), base, architectureModulesText(owner(20))).conflicts, 0);
});

test("ModuleRegistrar: the entries are read as data — a non-literal, an unknown field or a missing one is refused by name", () => {
  const one = (line: string) => architectureModulesText([]).replace("];\n", `${line}\n];\n`);
  assert.deepEqual(readArchitectureModuleEntries(one('  { path: "src/a.ts", owner: "o", id: "a", layer: "domain", realm: "runtime" },')),
    [{ id: "a", path: "src/a.ts", realm: "runtime", layer: "domain", owner: "o" }], "any property order");
  for (const [line, said] of [
    ['  { id: "a", path: `src/${"a"}.ts`, realm: "runtime", layer: "domain", owner: "o" },', /not a literal/u],
    ['  { id: "a", path: "src/a.ts", realm: "runtime", layer: "domain", owner: "o", namesSha256: "x" },', /not an architecture module entry/u],
    ['  { id: "a", path: "src/a.ts", realm: "runtime", owner: "o" },', /layer/u],
  ] as const) {
    assert.throws(() => readArchitectureModuleEntries(one(line)), (error: unknown) => (error as { code?: string }).code === "architecture_modules_invalid" && said.test((error as Error).message), line);
  }
  assert.throws(() => architectureModulesText([newEntry("src/a.ts"), newEntry("src/a.ts")]), /two entries register src\/a\.ts/u);
});

test("ModuleRegistrar: write mode removes the entries of absent sources and reports clean", () => {
  // Fixture: only the entries file exists, so every entry but the file's own
  // points at an absent source and is removed.
  const tmpDir = createTempDir("registrar-postwrite-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, ARCHITECTURE_MODULES_PATH), ENTRIES_TEXT());
    const r = generateModuleRegistrarReport(tmpDir, { write: true });
    assert.equal(r.postWrite?.removedModules, ARCHITECTURE_MODULES.length - 1);
    assert.equal(r.postWrite?.addedModules, 0);
    assert.equal(r.postWrite?.clean, true);
    assert.deepEqual(readArchitectureModuleEntries(readFileSync(join(tmpDir, ARCHITECTURE_MODULES_PATH), "utf8")).map((entry) => entry.path), [ARCHITECTURE_MODULES_PATH]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: write mode registers a new source module in its sorted place, classified like its neighbour", () => {
  const tmpDir = createTempDir("registrar-autoreg-");
  try {
    mkdirSync(join(tmpDir, "src", "kernel"), { recursive: true });
    const kernelErrors = engineModuleSourceRelative("kernel/errors.ts");
    const neighbour = ARCHITECTURE_MODULES.find((entry) => entry.path === kernelErrors)!;
    writeFileSync(join(tmpDir, ARCHITECTURE_MODULES_PATH), architectureModulesText(ARCHITECTURE_MODULES.filter((entry) => entry.path === ARCHITECTURE_MODULES_PATH || entry.path === kernelErrors)));
    writeFileSync(join(tmpDir, kernelErrors), readFileSync(join(ROOT, kernelErrors), "utf8"));
    writeFileSync(join(tmpDir, "src", "kernel", "auto-reg-new.ts"), "export const AUTO_REG = 1;\n");
    writeFileSync(join(tmpDir, "src", "kernel", "auto-reg-entry.ts"), 'if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = 0;\n');
    const r = generateModuleRegistrarReport(tmpDir, { write: true });
    assert.equal(r.unregisteredModules, 2);
    assert.equal(r.postWrite?.addedModules, 2);
    assert.equal(r.postWrite?.clean, true);
    const text = readFileSync(join(tmpDir, ARCHITECTURE_MODULES_PATH), "utf8");
    assert.equal(architectureModulesText(readArchitectureModuleEntries(text)), text, "written in the one form");
    const added = readArchitectureModuleEntries(text).filter((entry) => entry.path.includes("auto-reg-"));
    assert.deepEqual(added, [
      { id: "src-kernel-auto-reg-entry", path: "src/kernel/auto-reg-entry.ts", realm: neighbour.realm, layer: neighbour.layer, owner: neighbour.owner, executionBoundary: "composition-root", compositionRoot: true },
      { id: "src-kernel-auto-reg-new", path: "src/kernel/auto-reg-new.ts", realm: neighbour.realm, layer: neighbour.layer, owner: neighbour.owner },
    ]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModuleRegistrar: a file out of its one form is reported and rewritten", () => {
  const copy = createRepositoryWorkingCopy("registrar-form-", { include: engineGeneratorPopulation });
  try {
    const path = join(copy.engineRoot, ARCHITECTURE_MODULES_PATH);
    const current = readFileSync(path, "utf8");
    const lines = current.split("\n");
    const first = lines.findIndex((line) => line.startsWith("  { "));
    [lines[first], lines[first + 1]] = [lines[first + 1]!, lines[first]!];
    writeFileSync(path, lines.join("\n"));
    assert.equal(generateModuleRegistrarReport(copy.engineRoot).entriesCurrent, false, "an unsorted file is not current");
    assert.equal(generateModuleRegistrarReport(copy.engineRoot, { write: true }).postWrite?.clean, true);
    assert.equal(readFileSync(path, "utf8"), current);
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("ModuleRegistrar: a module that BECAME a direct-execution entrypoint after its registration is marked a composition root; declared roots stay", () => {
  // The flag used to be derived at first registration only: `scripts/post-commit.ts`
  // was registered before it gained its entry guard, stayed unmarked, and the
  // command-effect census refused it with no generator able to fix it. The
  // correction is one-directional: the roots the detector cannot see (top-level
  // programs such as the commit guard, worker entries) are declared and kept.
  const entry = "scripts/post-commit.ts";
  assert.equal(ARCHITECTURE_MODULES.find((module) => module.path === entry)?.compositionRoot, true, `${entry} is not marked in the entries this test starts from`);
  const unmarked = ARCHITECTURE_MODULES.map((module) => (module.path === entry ? { ...module, compositionRoot: false, executionBoundary: "pure" } as const : module));
  const detected = compareModuleRegistrations(ROOT, unmarked, modules());
  assert.deepEqual(detected.drift.map((module) => module.path), [entry], "an unmarked entrypoint is drift, and only it");
  const declaredRoot = "scripts/commit-guard.ts";
  assert.equal(ARCHITECTURE_MODULES.find((module) => module.path === declaredRoot)?.compositionRoot, true);
  assert.ok(!detected.drift.some((module) => module.path === declaredRoot), "a declared root the detector cannot see was reported");

  // The correction, on the FILE, the way `harness sync` runs it (a fresh process).
  const copy = createRepositoryWorkingCopy("registrar-entry-", { include: engineGeneratorPopulation });
  try {
    const path = join(copy.engineRoot, ARCHITECTURE_MODULES_PATH);
    const current = readFileSync(path, "utf8");
    writeFileSync(path, architectureModulesText(unmarked));
    assert.notEqual(readFileSync(path, "utf8"), current);
    const register = spawnSync(process.execPath, [join(copy.engineRoot, "src", "cli.ts"), "harness", "register", "--write"], { cwd: copy.engineRoot, encoding: "utf8" });
    assert.equal(register.status, 0, register.stderr);
    assert.equal(readFileSync(path, "utf8"), current, "the correction marks exactly that entry, nothing else");
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});
