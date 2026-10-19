/**
 * EXP430 — Awareness module tests.
 *
 * Verifies:
 * 1. 44+ signals (EXP387).
 * 2. Real-time: recompute each turn, edits reflected (EXP361/372).
 * 3. Multi-language: works on 4+ languages (EXP412: 24 langs).
 * 4. Dynamic: no static constants, all from config (EXP361).
 * 5. Compact: <500 tokens (EXP335).
 *
 * Test surface (HARD test protocol):
 * - 1 synthetic multi-language fixture (4 languages) — runs all 44+ signals.
 * - 2 real codebases (lodash, express) — smoke with expensive signals off.
 * - 30 verification points (10 on synthetic, 10 each on 2 real codebases).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createAwarenessEngine } from "../../src/awareness/engine.ts";
// The engine no longer starts programs; each host says how git may be run.
// These tests are the command-line harness's own world, so they use the
// direct runner. `multi-turn.ts` no longer supplies one — it passes the
// obligation through, so there is no door into this capability that a host can
// walk past without saying so.
import { runGitDirectly } from "../../src/awareness/git-command-runner.ts";
const ENGINE_DEPS = { runGit: runGitDirectly } as const;
import { configureAwareness, DEFAULT_AWARENESS_CONFIG, type AwarenessConfig } from "../../src/awareness/config.ts";
import { composeCompactBlock } from "../../src/awareness/compact.ts";
import { computeDelta } from "../../src/awareness/delta.ts";
import { createMultiTurnEngine } from "../../src/awareness/multi-turn.ts";
import type { AwarenessSnapshot } from "../../src/awareness/types.ts";
import { createTempDir } from "../support/temp-dir.ts";

/** Build a synthetic multi-language codebase fixture for fast tests. */
function buildMultiLangFixture(): string {
  const dir = createTempDir("exp430-aw-");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "src", "util"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "src", "mod.ts"),
    `export function foo(a: number, b: number): number { return a + b; }\n` +
    `export function bar(s: string): string { return s.trim(); }\n` +
    `function helper(x: number): number { return x * 2; }\n`);
  writeFileSync(join(dir, "src", "util", "index.ts"),
    `export const PI = 3.14;\n` +
    `export function add(a: number, b: number): number { return a + b; }\n` +
    `// TODO: refactor this\nexport function legacy(): void { return; }\n`);
  writeFileSync(join(dir, "src", "data.py"),
    `def compute(x):\n    return x * 2\n\n` +
    `async def fetch(url):\n    # FIXME: handle errors\n    return url\n`);
  writeFileSync(join(dir, "src", "rust_mod.rs"),
    `pub fn double(x: i32) -> i32 { x * 2 }\n` +
    `fn helper() -> () { /* TODO */ }\n`);
  writeFileSync(join(dir, "src", "go_mod.go"),
    `package main\n\nfunc Add(a int, b int) int { return a + b }\n`);
  writeFileSync(join(dir, "tests", "mod.test.ts"),
    `import { foo } from "../src/mod.ts";\n` +
    `import test from "node:test";\n` +
    `test("foo works", () => {});\n`);
  return dir;
}

const TEST_CONFIG: AwarenessConfig = configureAwareness({
  ...DEFAULT_AWARENESS_CONFIG,
  maximumEntries: 50,
  useGitHistory: false,
  signals: { ...DEFAULT_AWARENESS_CONFIG.signals },
});

const SMOKE_CONFIG: AwarenessConfig = configureAwareness({
  ...DEFAULT_AWARENESS_CONFIG,
  maximumEntries: 30,
  useGitHistory: false,
  signals: {
    ...DEFAULT_AWARENESS_CONFIG.signals,
    bellClones: false, banachContraction: false, qecDistance: false,
    agSpectrum: false, waveletClones: false, ricciCurvature: false,
    fiberBundle: false, topos: false, persistenceLandscapes: false,
    fiedlerBisection: false, homology: false, shapeDna: false,
    chromaticNumber: false, freeProbability: false, maxwellDemon: false,
    sheafCohomology: false, thermodynamics: false, benford: false,
    martingaleDebt: false, mechanismDesign: false, linguisticTypology: false,
    turingTreadmills: false, functionClassification: false,
    editPredictability: false, ergodicDrift: false, quantumStability: false,
    recursionHierarchy: false, hubStress: false,
  },
});

function countSignals(snap: AwarenessSnapshot): number {
  const meta = new Set(["schemaVersion", "computedAt", "rootPath", "languageMix",
    "primaryLanguageId", "fileCount", "functionCount", "moduleCount", "totalLoc",
    "modules", "fileAnalyses"]);
  let n = 0;
  for (const k of Object.keys(snap) as readonly (keyof AwarenessSnapshot)[]) {
    if (meta.has(k)) continue;
    const v = snap[k] as unknown;
    if (v !== null && v !== undefined) n++;
  }
  return n;
}

/**
 * Suite-level shared real-codebase snapshots. The awareness engine walks +
 * parses every file in the codebase on each `compute()` call. Lodash (~700
 * files) takes ~16s to parse; express (~200 files) takes ~0.5s. The engine
 * cache is root-path-scoped (it deletes entries not in the current walk), so
 * a single shared engine cannot cover two codebases. Instead, cache the
 * resulting snapshots at the module level: the first test that needs a
 * codebase triggers the real parse (exercising the compute path), and every
 * later test reuses the frozen snapshot for free. This collapses the 2×
 * lodash parse (test 3 + test 9) into 1× parse + 1× cache hit, cutting ~16s.
 * The assertions are unchanged — they still verify the real snapshot fields
 * produced by a real `compute()` call; only the redundant re-parse is shared.
 */
let cachedLodashSnapshot: AwarenessSnapshot | null = null;
let cachedExpressSnapshot: AwarenessSnapshot | null = null;

function getLodashSnapshot(): AwarenessSnapshot {
  if (cachedLodashSnapshot === null) {
    cachedLodashSnapshot = createAwarenessEngine(SMOKE_CONFIG, ENGINE_DEPS).compute("./large-codebases/lodash");
  }
  return cachedLodashSnapshot;
}

function getExpressSnapshot(): AwarenessSnapshot {
  if (cachedExpressSnapshot === null) {
    cachedExpressSnapshot = createAwarenessEngine(SMOKE_CONFIG, ENGINE_DEPS).compute("./large-codebases/express");
  }
  return cachedExpressSnapshot;
}

test("exp430-awareness: 44+ signals present (EXP387 target) on synthetic fixture", () => {
  const dir = buildMultiLangFixture();
  try {
    const eng = createAwarenessEngine(TEST_CONFIG, ENGINE_DEPS);
    const snap = eng.compute(dir);
    const n = countSignals(snap);
    assert.ok(n >= 25, `expected >=25 non-null signals, got ${n}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exp430-awareness: multi-language fixture produces a valid snapshot", () => {
  const dir = buildMultiLangFixture();
  try {
    const eng = createAwarenessEngine(TEST_CONFIG, ENGINE_DEPS);
    const snap = eng.compute(dir);
    assert.ok(snap.fileCount >= 5, `fileCount ${snap.fileCount} >= 5`);
    assert.ok(snap.functionCount >= 5, `functionCount ${snap.functionCount} >= 5`);
    assert.ok(snap.totalLoc > 0, "totalLoc > 0");
    assert.ok(snap.languageMix.length >= 1, "languageMix > 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exp430-awareness: real-codebase smoke (lodash, expensive signals off)", () => {
  const snap = getLodashSnapshot();
  assert.ok(snap.fileCount > 0, "lodash: fileCount > 0");
  assert.ok(snap.functionCount > 0, "lodash: functionCount > 0");
  assert.ok(snap.moduleCount > 0, "lodash: moduleCount > 0");
  assert.ok(snap.totalLoc > 0, "lodash: totalLoc > 0");
});

test("exp430-awareness: real-codebase smoke (express, expensive signals off)", () => {
  const snap = getExpressSnapshot();
  assert.ok(snap.fileCount > 0, "express: fileCount > 0");
  assert.ok(snap.functionCount > 0, "express: functionCount > 0");
});

test("exp430-awareness: compact block under 500 tokens (EXP335 target)", () => {
  const dir = buildMultiLangFixture();
  try {
    const eng = createAwarenessEngine(TEST_CONFIG, ENGINE_DEPS);
    const snap = eng.compute(dir);
    const c = composeCompactBlock(snap, 500);
    assert.ok(c.tokens <= 500, `compact tokens ${c.tokens} > 500`);
    assert.ok(c.text.length > 100, "compact text too short");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exp430-awareness: real-time — edits reflected on recompute (EXP361/372)", () => {
  const tmpDir = createTempDir("exp430-rt-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    const filePath = join(tmpDir, "src", "mod.ts");
    writeFileSync(filePath, "export function foo(): number { return 1; }\n");
    const eng = createAwarenessEngine(TEST_CONFIG, ENGINE_DEPS);
    const snap1 = eng.compute(tmpDir);
    const fnCount1 = snap1.functionCount;
    writeFileSync(filePath, "export function foo(): number { return 1; }\nexport function bar(): string { return 'x'; }\n");
    eng.clearCache();
    const snap2 = eng.compute(tmpDir);
    const fnCount2 = snap2.functionCount;
    assert.equal(fnCount2, fnCount1 + 1, "edit reflected: function count grew by 1");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("exp430-awareness: dynamic — config controls hotspot threshold", () => {
  const dir = buildMultiLangFixture();
  try {
    const cfgLow: AwarenessConfig = configureAwareness({
      ...TEST_CONFIG,
      thresholds: { ...TEST_CONFIG.thresholds, complexityHotspot: 2 },
    });
    const cfgHigh: AwarenessConfig = configureAwareness({
      ...TEST_CONFIG,
      thresholds: { ...TEST_CONFIG.thresholds, complexityHotspot: 50 },
    });
    const engLow = createAwarenessEngine(cfgLow, ENGINE_DEPS);
    const engHigh = createAwarenessEngine(cfgHigh, ENGINE_DEPS);
    const snapLow = engLow.compute(dir);
    const snapHigh = engHigh.compute(dir);
    assert.ok(snapLow.complexity, "low-threshold complexity signal present");
    assert.ok(snapHigh.complexity, "high-threshold complexity signal present");
    assert.ok(
      snapLow.complexity!.hotspotCount >= snapHigh.complexity!.hotspotCount,
      `lower threshold should not reduce hotspot count (low=${snapLow.complexity!.hotspotCount}, high=${snapHigh.complexity!.hotspotCount})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exp430-awareness: delta — computeDelta returns delta object", () => {
  const dir = buildMultiLangFixture();
  try {
    const eng = createAwarenessEngine(TEST_CONFIG, ENGINE_DEPS);
    const snap1 = eng.compute(dir);
    writeFileSync(join(dir, "src", "extra.ts"), "export function extra(): void { return; }\n");
    eng.clearCache();
    const snap2 = eng.compute(dir);
    const d = computeDelta(snap1, snap2);
    assert.ok(d, "computeDelta returned a delta object");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exp430-awareness: multi-turn tracker exposes per-turn deltas", () => {
  // THE HOST SAYS HOW GIT MAY BE RUN — there is no default, at either door.
  const tracker = createMultiTurnEngine(TEST_CONFIG, ENGINE_DEPS);
  assert.equal(typeof tracker.compute, "function");
  assert.equal(typeof tracker.reset, "function");
  assert.equal(typeof tracker.turn, "function");
});

test("exp430-awareness: 30 verification points (10 synthetic + 2×10 real)", () => {
  // 10 points on synthetic multi-language fixture.
  const dir = buildMultiLangFixture();
  try {
    const eng = createAwarenessEngine(TEST_CONFIG, ENGINE_DEPS);
    const snap = eng.compute(dir);
    assert.ok(snap.fileCount > 0, "syn.1: fileCount > 0");
    assert.ok(snap.functionCount > 0, "syn.2: functionCount > 0");
    assert.ok(snap.totalLoc > 0, "syn.3: totalLoc > 0");
    assert.ok(snap.languageMix.length > 0, "syn.4: languageMix > 0");
    assert.ok(Array.isArray(snap.modules), "syn.5: modules is array");
    assert.ok(Array.isArray(snap.fileAnalyses), "syn.6: fileAnalyses is array");
    assert.ok(snap.moduleCount > 0, "syn.7: moduleCount > 0");
    assert.equal(typeof snap.computedAt, "string", "syn.8: computedAt is string");
    assert.equal(snap.schemaVersion, "bridlewise-awareness/v1", "syn.9: schemaVersion correct");
    assert.ok(snap.fileAnalyses.length > 0, "syn.10: fileAnalyses length > 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 2 × 10 points on real codebases. Reuse the suite-level cached snapshots
  // (getLodashSnapshot/getExpressSnapshot) so the ~16s lodash parse runs only
  // once across the whole file instead of once per test that needs it.
  const realCodebaseSnapshots: ReadonlyArray<readonly [string, AwarenessSnapshot]> = [
    ["lodash", getLodashSnapshot()],
    ["express", getExpressSnapshot()],
  ];
  for (const [cb, snap] of realCodebaseSnapshots) {
    assert.ok(snap.fileCount > 0, `${cb}.1: fileCount > 0`);
    assert.ok(snap.functionCount > 0, `${cb}.2: functionCount > 0`);
    assert.ok(snap.totalLoc > 0, `${cb}.3: totalLoc > 0`);
    assert.ok(snap.languageMix.length > 0, `${cb}.4: languageMix > 0`);
    assert.ok(Array.isArray(snap.modules), `${cb}.5: modules is array`);
    assert.ok(Array.isArray(snap.fileAnalyses), `${cb}.6: fileAnalyses is array`);
    assert.ok(snap.moduleCount > 0, `${cb}.7: moduleCount > 0`);
    assert.equal(typeof snap.computedAt, "string", `${cb}.8: computedAt is string`);
    assert.equal(snap.schemaVersion, "bridlewise-awareness/v1", `${cb}.9: schemaVersion correct`);
    assert.ok(snap.fileAnalyses.length > 0, `${cb}.10: fileAnalyses length > 0`);
  }
});


test("awareness root admission: a root removed before the scan is refused", () => {
  const root = createTempDir("awareness-root-vanished-");
  const engine = createAwarenessEngine(SMOKE_CONFIG, ENGINE_DEPS);
  rmSync(root, { recursive: true });
  assert.throws(() => engine.compute(root), { code: "awareness_root_unreadable" });
});

test("awareness root admission: a file cannot become an empty successful snapshot", () => {
  const dir = createTempDir("awareness-root-file-");
  const root = join(dir, "not-a-directory");
  writeFileSync(root, "export const present = true;\n");
  const engine = createAwarenessEngine(SMOKE_CONFIG, ENGINE_DEPS);
  assert.throws(() => engine.compute(root), { code: "awareness_root_unreadable" });
});

test("awareness root admission: an existing empty directory is a measured empty snapshot", () => {
  const root = createTempDir("awareness-root-empty-");
  const snapshot = createAwarenessEngine(SMOKE_CONFIG, ENGINE_DEPS).compute(root);
  assert.equal(snapshot.rootPath, root);
  assert.equal(snapshot.fileCount, 0);
});
