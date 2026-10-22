/**
 * THE PLAN AND THE POPULATIONS — what one run of a tree runs:
 *
 *   - longest-first packing is deterministic (ties by path, then the lowest
 *     shard), balances weight, and refuses an impossible count;
 *   - the cell budget is shared by weight, at least one cell per split suite,
 *     never more cells than files;
 *   - a plan's cells cover each population exactly once, a `whole` suite is
 *     one cell, the plan says its weights are `unmeasured`, and a plan of
 *     another shape is refused;
 *   - the web population is the tree's files the runner's globs select, less
 *     the catalogue's exclusions; a stale exclusion and an empty population
 *     are refusals; the engine population is the inventory's sources.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { VERIFICATION_PATHS } from "../../../src/kernel/verification-paths.ts";
import { ENGINE_FOLDER, GATE_CATALOGUE, MAX_SHARDS, POPULATION_EXCLUSIONS } from "../../../src/workflow/gates/catalogue.ts";
import { allocateShards, catalogueDigest, matrixCells, packShards, parsePlan, planGates } from "../../../src/workflow/gates/plan.ts";
import { listPopulation, webPopulation, type PopulationListing } from "../../../src/workflow/gates/populations.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { plantedKey } from "./gate-fixtures.ts";

const HEAD = "a".repeat(40);
const TREE = "b".repeat(40);

function refusedWith(code: string): (error: unknown) => boolean {
  return (error: unknown) => (error as { code?: string }).code === code;
}

function listing(population: "web-tests" | "engine-tests", count: number): PopulationListing {
  const prefix = population === "web-tests" ? "tests/unit" : "engine/test";
  return { population, source: "planted", files: Array.from({ length: count }, (_, index) => `${prefix}/f${String(index).padStart(3, "0")}.test.ts`), excluded: [] };
}

test("packing is longest-first, ties by path then the lowest shard, and balances weight", () => {
  const files = [
    { path: "d", weight: 5 },
    { path: "a", weight: 3 },
    { path: "c", weight: 3 },
    { path: "b", weight: 2 },
    { path: "e", weight: 1 },
  ];
  assert.deepEqual(packShards(files, 2), [
    { index: 1, weight: 7, files: ["b", "d"] },
    { index: 2, weight: 7, files: ["a", "c", "e"] },
  ]);
  assert.deepEqual(packShards([...files].reverse(), 2), packShards(files, 2), "input order does not change the packing");
  assert.throws(() => packShards(files, 0), refusedWith("gate_plan_invalid"));
  assert.throws(() => packShards(files, 6), refusedWith("gate_plan_invalid"));
});

test("the cell budget is shared by weight: at least one each, never more than a suite's files", () => {
  const counts = allocateShards([{ id: "big", weight: 900, files: 900 }, { id: "small", weight: 100, files: 100 }], 10);
  assert.equal(counts.get("big"), 9);
  assert.equal(counts.get("small"), 1);
  const capped = allocateShards([{ id: "tiny", weight: 50, files: 2 }, { id: "big", weight: 10, files: 100 }], 10);
  assert.equal(capped.get("tiny"), 2, "never more cells than files");
  assert.equal(capped.get("big"), 8);
  assert.throws(() => allocateShards([{ id: "a", weight: 1, files: 1 }, { id: "b", weight: 1, files: 1 }], 1), refusedWith("gate_plan_invalid"));
});

test("a plan covers each population exactly once, the cells shared by weight; weights say unmeasured", () => {
  const plan = planGates({ headSha: HEAD, treeId: TREE, key: plantedKey(TREE), populations: [listing("web-tests", 534), listing("engine-tests", 513)] });
  assert.equal(plan.weights.basis, "unmeasured");
  assert.equal(plan.catalogueDigest, catalogueDigest());
  assert.equal(plan.cells.length, MAX_SHARDS);
  const web = plan.cells.filter((cell) => cell.gate === "web-suite");
  const engine = plan.cells.filter((cell) => cell.gate === "engine-suite");
  assert.equal(engine.length + web.length, MAX_SHARDS);
  assert.equal(web.length, 6, "534 of 1047 unit-weight files: six of the twelve cells");
  assert.equal(engine.length, 6);
  for (const [cells, total] of [[web, 534], [engine, 513]] as const) {
    const covered = cells.flatMap((cell) => cell.files);
    assert.equal(new Set(covered).size, total);
    assert.equal(covered.length, total);
  }
  const sizes = web.map((cell) => cell.files.length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, "equal weights split evenly");
  assert.deepEqual(plan.gates.map((gate) => gate.id), GATE_CATALOGUE.map((gate) => gate.id));
  assert.deepEqual(matrixCells(plan)[0], { cell: "web-suite-1", gate: "web-suite", title: "Web suite 1/6" });
  assert.deepEqual(parsePlan(JSON.parse(JSON.stringify(plan))), plan);
  assert.deepEqual(planGates({ headSha: HEAD, treeId: TREE, key: plantedKey(TREE), populations: [listing("engine-tests", 513), listing("web-tests", 534)] }), plan, "the plan does not depend on listing order");
});

test("a plan is refused without a full sha and tree, without a listed population, and in another shape", () => {
  assert.throws(() => planGates({ headSha: "abc", treeId: TREE, key: plantedKey(TREE), populations: [] }), refusedWith("gate_plan_invalid"));
  assert.throws(() => planGates({ headSha: HEAD, treeId: TREE, key: plantedKey(TREE), populations: [listing("web-tests", 3)] }), refusedWith("gate_plan_invalid"));
  const plan = planGates({ headSha: HEAD, treeId: TREE, key: plantedKey(TREE), populations: [listing("web-tests", 30), listing("engine-tests", 3)] });
  for (const broken of [
    null,
    { ...plan, schemaVersion: "bridlewise-gate-plan/v0" },
    { ...plan, catalogueVersion: "x" },
    { ...plan, headSha: "zz" },
    { ...plan, cells: [...plan.cells, plan.cells[0]] },
    { ...plan, cells: [{ ...plan.cells[0]!, files: [] }] },
  ]) {
    assert.throws(() => parsePlan(broken), refusedWith("gate_plan_invalid"));
  }
});

/** A scratch git repository with `files` (untracked files still belong to the tree a clone would hold). */
function scratchRepository(files: readonly string[]): string {
  const root = createTempDir("gates-population-");
  const init = spawnSync("git", ["init", "-q"], { cwd: root });
  assert.equal(init.status, 0);
  for (const path of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "");
  }
  return root;
}

const GLOBS = ["tests/unit/**/*.test.ts", "tests/prevention/**/*.test.ts", "tests/cockpit/**/*.test.ts", "tests/performance/**/*.test.ts"];
const EXCLUDED = POPULATION_EXCLUSIONS["web-tests"].map((entry) => entry.path);

test("the web population is the tree's files the globs select, less the named exclusions", () => {
  const root = scratchRepository([...EXCLUDED, "tests/unit/a.test.ts", "tests/unit/deep/b.test.ts", "tests/unit/helper.ts", "tests/cockpit/e2e/x.spec.ts", "src/c.test.ts"]);
  const population = webPopulation(root, GLOBS);
  assert.deepEqual(population.files, ["tests/unit/a.test.ts", "tests/unit/deep/b.test.ts"]);
  assert.deepEqual(population.excluded.map((entry) => entry.path), EXCLUDED);
  assert.ok(population.excluded.every((entry) => entry.reason.length > 20 && entry.evidence.length > 0));
});

test("an exclusion the globs no longer select is refused, and so is an empty population", () => {
  const root = scratchRepository([...EXCLUDED.slice(1), "tests/unit/a.test.ts"]);
  assert.throws(() => webPopulation(root, GLOBS), refusedWith("gate_population_stale_exclusion"));
  const empty = scratchRepository([...EXCLUDED]);
  assert.throws(() => webPopulation(empty, GLOBS), refusedWith("gate_population_empty"));
});

test("the CLI reads the runner's own globs from the tree; the engine population is the inventory's sources", async () => {
  const root = scratchRepository([...EXCLUDED, "tests/unit/a.test.ts"]);
  writeFileSync(join(root, "tests/test-include.ts"), `export const TEST_INCLUDE = ${JSON.stringify(GLOBS)};\n`);
  assert.deepEqual((await listPopulation(root, "web-tests")).files, ["tests/unit/a.test.ts"]);
  mkdirSync(join(root, "engine/traceability"), { recursive: true });
  writeFileSync(join(root, ENGINE_FOLDER, VERIFICATION_PATHS.testInventory), JSON.stringify({ tests: [{ sourceId: "test/b.test.ts" }, { sourceId: "test/a.test.ts" }, { sourceId: "test/a.test.ts" }] }));
  assert.deepEqual((await listPopulation(root, "engine-tests")).files, ["engine/test/a.test.ts", "engine/test/b.test.ts"]);
  writeFileSync(join(root, ENGINE_FOLDER, VERIFICATION_PATHS.testInventory), JSON.stringify({ tests: [{ sourceId: "../escape.test.ts" }] }));
  await assert.rejects(listPopulation(root, "engine-tests"), refusedWith("gate_population_unreadable"));
  // A tree whose runner declares no glob is refused (a fresh tree: the module loader keeps the first one it read).
  const noGlobs = scratchRepository(["tests/unit/a.test.ts"]);
  writeFileSync(join(noGlobs, "tests/test-include.ts"), "export const TEST_INCLUDE = [];\n");
  await assert.rejects(listPopulation(noGlobs, "web-tests"), refusedWith("gate_population_unreadable"));
});

test("the plan carries the reuse key K: its document's digest, for the planned tree and catalogue only", () => {
  const plan = planGates({ headSha: HEAD, treeId: TREE, key: plantedKey(TREE), populations: [listing("web-tests", 4), listing("engine-tests", 2)] });
  assert.match(plan.keyDigest, /^[0-9a-f]{64}$/u);
  assert.throws(() => planGates({ headSha: HEAD, treeId: TREE, key: plantedKey("c".repeat(40)), populations: [listing("web-tests", 4), listing("engine-tests", 2)] }), refusedWith("gate_plan_invalid"));
  assert.throws(() => parsePlan({ ...JSON.parse(JSON.stringify(plan)), keyDigest: "0".repeat(64) }), refusedWith("gate_plan_invalid"));
  const relocked = planGates({ headSha: HEAD, treeId: TREE, key: plantedKey(TREE, { "engine/package-lock.json": "{\"v\":2}\n" }), populations: [listing("web-tests", 4), listing("engine-tests", 2)] });
  assert.notEqual(relocked.keyDigest, plan.keyDigest, "a lockfile is part of K");
});
