/**
 * THE MODULE REGISTRAR AND THE MODULE DECISIONS (#221): every source module
 * under the source roots IS a module (the census), classified by its folder
 * unless a decision says otherwise; the decisions file holds only what is
 * decided, one line each, in one form; nothing a source says is committed; and
 * two branches that add modules, or decide about different modules, merge.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  compareModuleRegistrations,
  generateModuleRegistrarReport,
  parseModuleRegistrarReport,
  MODULE_REGISTRAR_SCHEMA_VERSION,
  type ModuleRegistrarReport,
} from "../../src/workflow/module-registrar.ts";
import { architectureManifestOf, type ArchitectureModuleEntry } from "../../src/architecture-manifest.ts";
import { ARCHITECTURE_DIRECTORY_DEFAULTS, ARCHITECTURE_MODULES } from "../../src/architecture-modules.ts";
import { ARCHITECTURE_MODULES_PATH, architectureModulesText, readArchitectureModuleDecisions } from "../../src/workflow/architecture-module-entries.ts";
import { architectureSourcePaths, repositoryArchitectureManifest } from "../../scripts/verification/architecture.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";
import { createRepositoryWorkingCopy, engineGeneratorPopulation, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";

const ROOT = process.cwd();
const DECISIONS_TEXT = (): string => readFileSync(join(ROOT, ARCHITECTURE_MODULES_PATH), "utf8");
const DECISIONS = { defaults: ARCHITECTURE_DIRECTORY_DEFAULTS, entries: ARCHITECTURE_MODULES } as const;

let cachedReport: ModuleRegistrarReport | null = null;
/** The real project's report, computed once (it analyses every source). */
function report(): ModuleRegistrarReport {
  cachedReport ??= generateModuleRegistrarReport(ROOT);
  return cachedReport;
}

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

test("ModuleRegistrar: the census is every source module under the source roots, sorted and frozen", () => {
  const census = architectureSourcePaths(ROOT);
  assert.ok(census.length >= 700, `the census collapsed to ${String(census.length)}`);
  assert.ok(Object.isFrozen(census));
  assert.deepEqual([...census], [...census].toSorted());
  for (const expected of [
    engineModuleSourceRelative("integrity.ts"),
    engineModuleSourceRelative("kernel/errors.ts"),
    "src/architecture-manifest.ts",
    ARCHITECTURE_MODULES_PATH,
    "src/workflow/module-registrar.ts",
    "src/workflow/harness-commands.ts",
  ]) {
    assert.ok(census.includes(expected), `missing ${expected}`);
  }
  // Every census module is classified: the manifest of the tree derives one module per path.
  assert.deepEqual(repositoryArchitectureManifest(ROOT).modules.map((module) => module.path), [...census]);
});

test("ModuleRegistrar: the real project has no drift and its decisions file is in its one form", () => {
  const r = report();
  assert.equal(r.driftedModules, 0, `drift: ${r.drift.map((entry) => entry.path).join(", ")}`);
  assert.equal(r.entriesCurrent, true);
  assert.equal(r.postWrite, null, "read-only");
  assert.deepEqual(compareModuleRegistrations(ROOT), []);
});

test("ModuleRegistrar: the report is valid, frozen, integrity-checked and parses back", () => {
  const r = report();
  assert.equal(r.schemaVersion, MODULE_REGISTRAR_SCHEMA_VERSION);
  assert.ok(r.totalSourceModules > 0 && r.moduleDecisions > 0);
  assert.ok(Object.isFrozen(r));
  const { integrityHash, ...unsigned } = r;
  assert.equal(sha256(canonicalJson(unsigned)), integrityHash);
  const parsed = parseModuleRegistrarReport(JSON.parse(canonicalJson(r)));
  assert.equal(parsed.totalSourceModules, r.totalSourceModules);
  assert.throws(() => parseModuleRegistrarReport(null), /must be an object/);
  const wrongSchema = JSON.parse(canonicalJson(r));
  wrongSchema.schemaVersion = "wrong";
  assert.throws(() => parseModuleRegistrarReport(wrongSchema), /schema version/);
  const tampered = JSON.parse(canonicalJson(r));
  tampered.integrityHash = "0".repeat(64);
  assert.throws(() => parseModuleRegistrarReport(tampered), /integrity is invalid/);
});

test("ModuleRegistrar: the decisions file is its own one form, holds only decisions, and commits nothing a source says", () => {
  const text = DECISIONS_TEXT();
  const decisions = readArchitectureModuleDecisions(text);
  assert.equal(architectureModulesText(decisions), text, "the committed file is its own canonical rendering");
  assert.deepEqual(decisions, { defaults: [...ARCHITECTURE_DIRECTORY_DEFAULTS], entries: [...ARCHITECTURE_MODULES] }, "the reader and the import agree");
  assert.doesNotMatch(text, /namesSha256|exportCount|publicApi|\bdependencies:/u, "a count, name hash or edge list is derived by the check, never committed");
  const census = architectureSourcePaths(ROOT);
  assert.ok(decisions.entries.length < census.length / 2, `only the exceptions are recorded (${String(decisions.entries.length)} of ${String(census.length)})`);
  // The composition roots are the decisions' roles, never a second list.
  const manifest = repositoryArchitectureManifest(ROOT);
  for (const [realm, roots] of Object.entries(manifest.compositionRoots)) {
    assert.deepEqual(roots, manifest.modules.filter((module) => module.realm === realm && module.compositionRoot).map((module) => module.path), realm);
  }
});

test("ModuleRegistrar: a plain new module needs no decision — adding modules A and B in two branches changes nothing here; decisions about different modules merge", async () => {
  // Two new modules in ONE folder (the worst case for a sorted list): neither changes the decisions.
  const census = architectureSourcePaths(ROOT);
  const withNew = [...census, "src/workflow/zz-added-on-one-branch.ts", "src/workflow/zz-added-on-another.ts"];
  const manifest = architectureManifestOf(withNew);
  const added = manifest.modules.filter((module) => module.path.includes("zz-added"));
  assert.deepEqual(added.map((module) => [module.id, module.owner]), [["src-workflow-zz-added-on-another", architectureManifestOf(["src/workflow/x.ts"]).modules[0]!.owner], ["src-workflow-zz-added-on-one-branch", architectureManifestOf(["src/workflow/x.ts"]).modules[0]!.owner]], "classified by their folder");
  assert.equal(architectureModulesText(DECISIONS), DECISIONS_TEXT(), "the decisions do not depend on the census");
  // Two branches each decide about a different module: one line each, a clean merge.
  const base = DECISIONS_TEXT();
  const decide = (path: string, owner: string): string => architectureModulesText({ ...DECISIONS, entries: [...DECISIONS.entries.filter((entry) => entry.path !== path), { ...(DECISIONS.entries.find((entry) => entry.path === path) ?? { path }), owner }] });
  const ours = decide(DECISIONS.entries[10]!.path, "owner-on-one-branch");
  const theirs = decide(DECISIONS.entries[200]!.path, "owner-on-another");
  const merged = mergeFile(ours, base, theirs);
  assert.equal(merged.conflicts, 0, merged.text);
  assert.equal(merged.text, architectureModulesText({ ...readArchitectureModuleDecisions(ours), entries: readArchitectureModuleDecisions(ours).entries.map((entry) => entry.path === DECISIONS.entries[200]!.path ? { ...entry, owner: "owner-on-another" } : entry) }));
});

test("ModuleRegistrar: decisions are read as data — a non-literal, an unknown or a missing field is refused by name; a module no folder classifies is refused", () => {
  const one = (line: string): string => architectureModulesText({ defaults: [], entries: [] }).replace("export const ARCHITECTURE_MODULES: readonly ArchitectureModuleEntry[] = [\n", `export const ARCHITECTURE_MODULES: readonly ArchitectureModuleEntry[] = [\n${line}\n`);
  assert.deepEqual(readArchitectureModuleDecisions(one('  { owner: "o", path: "src/a.ts" },')).entries, [{ path: "src/a.ts", owner: "o" }], "any property order");
  for (const [line, said] of [
    ['  { path: `src/${"a"}.ts`, owner: "o" },', /not a literal/u],
    ['  { path: "src/a.ts", namesSha256: "x" },', /not a module decision/u],
    ['  { owner: "o" },', /path/u],
  ] as const) {
    assert.throws(() => readArchitectureModuleDecisions(one(line)), (error: unknown) => (error as { code?: string }).code === "architecture_modules_invalid" && said.test((error as Error).message), line);
  }
  assert.throws(() => architectureModulesText({ defaults: [], entries: [{ path: "src/a.ts", owner: "x" }, { path: "src/a.ts", owner: "y" }] }), /two lines decide the path src\/a\.ts/u);
  assert.throws(() => architectureManifestOf(["elsewhere/a.ts"]), (error: unknown) => (error as { code?: string }).code === "architecture_module_unclassified");
  // A field equal to what is derived is never written; an entry left with nothing is dropped.
  const folder = ARCHITECTURE_DIRECTORY_DEFAULTS.find((entry) => entry.directory === "src/workflow/")!;
  assert.equal(architectureModulesText({ defaults: [folder], entries: [{ path: "src/workflow/a.ts", id: "src-workflow-a", owner: folder.owner } as ArchitectureModuleEntry] }), architectureModulesText({ defaults: [folder], entries: [] }));
});

test("ModuleRegistrar: write mode removes the decision of a deleted module and reports clean", () => {
  const tmpDir = createTempDir("registrar-postwrite-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, ARCHITECTURE_MODULES_PATH), DECISIONS_TEXT());
    // Only the decisions file exists: every decision but its own names a deleted module.
    const own = ARCHITECTURE_MODULES.some((entry) => entry.path === ARCHITECTURE_MODULES_PATH) ? 1 : 0;
    const r = generateModuleRegistrarReport(tmpDir, { write: true });
    assert.equal(r.postWrite?.removedModules, ARCHITECTURE_MODULES.length - own);
    assert.equal(r.postWrite?.clean, true);
    assert.deepEqual(readArchitectureModuleDecisions(readFileSync(join(tmpDir, ARCHITECTURE_MODULES_PATH), "utf8")).entries.map((entry) => entry.path), own === 1 ? [ARCHITECTURE_MODULES_PATH] : []);
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
    const first = lines.findIndex((line) => line.startsWith("  { path: "));
    [lines[first], lines[first + 1]] = [lines[first + 1]!, lines[first]!];
    writeFileSync(path, lines.join("\n"));
    assert.equal(generateModuleRegistrarReport(copy.engineRoot).entriesCurrent, false, "an unsorted file is not current");
    assert.equal(generateModuleRegistrarReport(copy.engineRoot, { write: true }).postWrite?.clean, true);
    assert.equal(readFileSync(path, "utf8"), current);
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("ModuleRegistrar: a module that BECAME a direct-execution entrypoint is marked a composition root; declared roots stay", () => {
  // The flag used to be derived at first registration only: `scripts/post-commit.ts`
  // was registered before it gained its entry guard, stayed unmarked, and the
  // command-effect census refused it with no generator able to fix it. The
  // correction is one-directional: the roots the detector cannot see (top-level
  // programs such as the commit guard, worker entries) are declared and kept.
  const entry = "scripts/post-commit.ts";
  assert.equal(ARCHITECTURE_MODULES.find((module) => module.path === entry)?.compositionRoot, true, `${entry} is not marked in the decisions this test starts from`);
  const unmarked = { ...DECISIONS, entries: ARCHITECTURE_MODULES.map((module) => (module.path === entry ? { ...module, compositionRoot: false, executionBoundary: "pure" } as const : module)) };
  const detected = compareModuleRegistrations(ROOT, unmarked);
  assert.deepEqual(detected.map((module) => module.path), [entry], "an unmarked entrypoint is drift, and only it");
  const declaredRoot = "scripts/commit-guard.ts";
  assert.equal(ARCHITECTURE_MODULES.find((module) => module.path === declaredRoot)?.compositionRoot, true);

  // The correction, on the FILE, the way `harness sync` runs it (a fresh process).
  const copy = createRepositoryWorkingCopy("registrar-entry-", { include: engineGeneratorPopulation });
  try {
    const path = join(copy.engineRoot, ARCHITECTURE_MODULES_PATH);
    const current = readFileSync(path, "utf8");
    writeFileSync(path, architectureModulesText(unmarked));
    assert.notEqual(readFileSync(path, "utf8"), current);
    const register = spawnSync(process.execPath, [join(copy.engineRoot, "src", "cli.ts"), "harness", "register", "--write"], { cwd: copy.engineRoot, encoding: "utf8" });
    assert.equal(register.status, 0, register.stderr);
    assert.equal(readFileSync(path, "utf8"), current, "the correction marks exactly that module, nothing else");
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});
