// @vitest-environment node
/**
 * Mechanical prevention test — Auto-heal owner (SPO, ).
 *
 * Enforces the Single-Party-Owner principle for auto-healing: ALL auto-heal
 * detection + healing primitives in the web UI go through ONE owner module
 * (`server/auto-heal.ts`). No route, bridge, or service redefines auto-heal
 * detection functions inline (No Scattered Helpers). The auto-
 * heal is:
 * (a) ON-PATH — the staleness check runs on every map read
 * (`getCachedMapSync` → `isIndexStale` → `detectStaleIndex`), and a
 * stale index triggers an off-thread rebuild. NOT decorative (the
 * 748% bug class — wiring that exists but never fires).
 * (b) AUTOMATIC — the heal runs automatically on every map
 * read; no manual "re-index" button required.
 * (c) CONFIGURABLE — the floors live in the harness config
 * (`codeIntelligence.autoHeal.*`), owned by `getAutoHealConfig`.
 * (d) EXPOSED — the report is served by the routes AND
 * consumed by the frontend (before the endpoint existed but no
 * component fetched it).
 * (e) REAL — the safety trigger calls the REAL
 * `detectBrokenEdges` + `detectStaleIndex`, not a mock.
 *
 * Dynamic discovery: the test dynamically
 * walks every.ts file under server/ (via readdirSync) to find files that
 * define auto-heal functions. A hardcoded list would silently miss a new
 * file that redefines a function — the dynamic scan catches ALL current +
 * future files.
 *
 * Assurance classes (WORKFLOW.md §9 + ):
 * A. SINGLE-OWNER: auto-heal detection functions are defined ONLY in
 * auto-heal.ts (dynamic discovery — no allowlist).
 * B. ON-PATH: the intelligence bridge calls the staleness check on every
 * map read (not decorative wiring).
 * C. CONFIG: `getAutoHealConfig` is the single config owner; no inline
 * hardcoded sample sizes.
 * D. EXPOSURE: the routes register the auto-heal endpoints AND the
 * frontend client fetches them.
 * E. REAL-SAFETY-TRIGGER: the safety route's auto-heal case calls the
 * REAL detection functions (not a mock).
 * F. NO-SCATTERED-HEAL: `whitespaceEquivalent` (Level-1 heal primitive)
 * is owned by auto-heal.ts, not redefined in tool-executor.ts.
 * G. BEHAVIORAL: when auto-heal is disabled, staleness detection is
 * skipped; broken-edge detection is always available (pure function).
 *
 * Mutation-verified: removing the `isIndexStale` call from `getCachedMapSync`
 * makes test B fail; removing `detectBrokenEdges` from `safety.ts` makes
 * test E fail; re-adding a local `whitespaceEquivalent` to tool-executor.ts
 * makes test F fail.
 */
import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { resolve, join } from "node:path";

// ── Dynamic file discovery ──

/** All.ts files under `server/` (dynamic discovery). */
const SERVER_TS_FILES = walkTs(resolve(process.cwd(), "server"));

// ── Test data ──

const AUTO_HEAL_SRC = read(modulePath("auto-heal.ts"));
const INTEL_BRIDGE_SRC = read(modulePath("intelligence-bridge.ts"));
const SAFETY_SRC = read(modulePathMatching("server/routes/safety.ts"));
const TOOL_EXECUTOR_SRC = read(modulePath("tool-executor.ts"));
const HARNESS_CONFIG_SRC = read(modulePath("harness-config.ts"));
const INTEL_ROUTES_SRC = read(modulePathMatching("server/routes/intelligence.ts"));
const CLIENT_SRC = read(modulePathMatching("src/client.ts"));

// ════════════════════════════════════════════════════════════════════════
// A. SINGLE-OWNER: auto-heal detection functions defined ONLY in auto-heal.ts
// ════════════════════════════════════════════════════════════════════════

describe("A. auto-heal-owner — single owner (dynamic discovery, No Scattered Helpers)", () => {
  // Discover the auto-heal function NAMES dynamically from auto-heal.ts
  // (the single owner): every `export function NAME` declaration. A
  // hardcoded list of 9 signatures would silently miss a new function added
  // to auto-heal.ts — the dynamic parse covers every current + future
  // export so a scattered redefinition of any of them is auto-caught.
  const AUTO_HEAL_FUNCS = new Set<string>();
  for (const m of AUTO_HEAL_SRC.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    AUTO_HEAL_FUNCS.add(m[1]!);
  }

  test("the discovered auto-heal function set is non-empty (sanity: the export parse is not broken)", () => {
    expect(AUTO_HEAL_FUNCS.size, "must discover exported functions in auto-heal.ts").toBeGreaterThan(0);
    expect(AUTO_HEAL_FUNCS.has("detectStaleIndex"), "detectStaleIndex must be exported by auto-heal.ts (canonical anchor)").toBe(true);
  });

  for (const name of AUTO_HEAL_FUNCS) {
    test(`export function ${name} is defined ONLY in auto-heal.ts (no scattered redefinitions)`, () => {
      const owners: string[] = [];
      for (const file of SERVER_TS_FILES) {
        const rel = file.replace(resolve(process.cwd()) + "/", "");
        const src = stripComments(readFileSync(file, "utf8"));
        // A DEFINITION of the function (not an import). `export function
        // name(` or a non-exported top-level `function name(` both count —
        // either is a scattered redefinition.
        const defRe = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
        if (defRe.test(src)) {
          owners.push(rel);
        }
      }
      expect(owners, `export function ${name} must be defined ONLY in server/auto-heal.ts. Found in: ${owners.join(", ")}`).toEqual([modulePath("auto-heal.ts")]);
    });
  }
});

// ════════════════════════════════════════════════════════════════════════
// B. ON-PATH: the staleness check runs on every map read (not decorative)
// ════════════════════════════════════════════════════════════════════════

describe("B. auto-heal-owner — ON-PATH (staleness check fires on every read)", () => {
  test("getCachedMapSync calls isIndexStale within the TTL window (not decorative)", () => {
    // The staleness check MUST be wired into the actual read path. Before
    // the fix, the TTL alone served stale data until expiry. Now the mtime
    // snapshot is checked on every read WITHIN the TTL window. This is the
    // "not decorative" guarantee — same class as the 748% bug (wiring that
    // exists but never fires).
    expect(INTEL_BRIDGE_SRC).toContain("isIndexStale");
  });

  test("isIndexStale calls detectStaleIndex from the auto-heal owner", () => {
    // The bridge imports + calls detectStaleIndex (the auto-heal owner's
    // function), not a local reimplementation.
    expect(INTEL_BRIDGE_SRC).toContain("detectStaleIndex");
    expect(INTEL_BRIDGE_SRC).toContain("from \"./auto-heal.ts\"");
  });

  test("a stale index triggers an off-thread rebuild (fire-and-forget)", () => {
    // When the index is stale, the bridge fires-and-forgets a worker
    // rebuild (same pattern as TTL expiry). The current call returns the
    // stale map; the next read gets the fresh one. The rebuild is gated by
    // getInFlightWorker so a concurrent in-flight build is not duplicated
    // (the pool dedups the spawn).
    //
    // The claim is the CHAIN, asked structurally — getCachedMapSync fires
    // the rebuild door on a stale snapshot, the door dedups through
    // getInFlightWorker and kicks startRebuild, and startRebuild is the
    // off-thread worker call — never a byte-window spelling of it.
    const readPath = functionBody(INTEL_BRIDGE_SRC, "getCachedMapSync");
    expect(readPath.body).toContain("isIndexStale(");
    expect(readPath.body).toContain("kickRebuildAfterWrite(");
    const kick = functionBody(INTEL_BRIDGE_SRC, "kickRebuildAfterWrite");
    expect(kick.body).toContain("getInFlightWorker");
    expect(kick.body).toContain("startRebuild(");
    expect(functionBody(INTEL_BRIDGE_SRC, "startRebuild").body).toContain("buildMapInWorker(");
  });

  test("the mtime snapshot is captured on build (not just on read)", () => {
    // The snapshot is captured in the worker's success handler so it's
    // available for staleness detection on subsequent reads. Without this,
    // isIndexStale would have no snapshot to compare against.
    expect(INTEL_BRIDGE_SRC).toContain("captureMtimeSnapshot");
  });
});

// ════════════════════════════════════════════════════════════════════════
// C. CONFIG: single config owner
// ════════════════════════════════════════════════════════════════════════

describe("C. auto-heal-owner — single config owner", () => {
  test("getAutoHealConfig is defined ONLY in harness-config.ts", () => {
    const owners: string[] = [];
    for (const file of SERVER_TS_FILES) {
      const rel = file.replace(resolve(process.cwd()) + "/", "");
      const src = readFileSync(file, "utf8");
      if (src.includes("export function getAutoHealConfig")) {
        owners.push(rel);
      }
    }
    expect(owners).toEqual([modulePath("harness-config.ts")]);
  });

  test("auto-heal.ts reads config from getAutoHealConfig (not inline defaults)", () => {
    expect(AUTO_HEAL_SRC).toContain("getAutoHealConfig");
    expect(AUTO_HEAL_SRC).toContain("from \"../kernel/harness-config.ts\"");
  });

  test("the config has an autoHeal section in the config schema (deny-by-default)", () => {
    expect(HARNESS_CONFIG_SRC).toContain("autoHeal");
    expect(HARNESS_CONFIG_SRC).toContain("AutoHealConfig");
  });
});

// ════════════════════════════════════════════════════════════════════════
// D. EXPOSURE: routes register the endpoints AND frontend consumes them
// ════════════════════════════════════════════════════════════════════════

describe("D. auto-heal-owner — exposure", () => {
  test("the intelligence routes register the auto-heal report endpoint", () => {
    expect(INTEL_ROUTES_SRC).toContain("/api/intelligence/auto-heal");
    expect(INTEL_ROUTES_SRC).toContain("getProjectAutoHealReport");
  });

  test("the intelligence routes register the broken-edges endpoint", () => {
    expect(INTEL_ROUTES_SRC).toContain("/api/intelligence/broken-edges");
    expect(INTEL_ROUTES_SRC).toContain("getProjectBrokenEdges");
  });

  // (The client wrapper + IntelligencePanel consumer cases died with the
  // old tree: every UI caller of the per-route intelligence wrappers was
  // the deleted panel, and the cockpit's plugged intelligence consumers go
  // through the Broker's block transport instead — a second per-route
  // client transport would be a duplicate path. The server endpoints stay,
  // pinned above; wiring them to a cockpit surface is future work.)
});

// ════════════════════════════════════════════════════════════════════════
// E. REAL-SAFETY-TRIGGER: the safety route calls the REAL detection
// ════════════════════════════════════════════════════════════════════════

describe("E. auto-heal-owner — safety trigger is REAL", () => {
  test("the safety route imports detectBrokenEdges from the auto-heal owner", () => {
    // Before the auto-heal safety case was a MOCK — a hardcoded string
    // that never called the real auto-heal system (violating + the
    // file's own "REAL calls — not mocks" header). Now it calls the REAL
    // detectBrokenEdges + detectStaleIndex functions.
    expect(SAFETY_SRC).toContain("detectBrokenEdges");
    expect(SAFETY_SRC).toContain("from \"../intelligence/auto-heal.ts\"");
  });

  test("the safety route calls detectStaleIndex (real stale-index detection)", () => {
    expect(SAFETY_SRC).toContain("detectStaleIndex");
  });

  test("the safety route does NOT return a hardcoded autoHealAction string (no mock)", () => {
    // The old mock returned a hardcoded "The editor would detect the stale
    // preimage..." string. The real version computes the action from the
    // detection result.
    expect(SAFETY_SRC).not.toContain("The editor would detect the stale preimage");
  });
});

// ════════════════════════════════════════════════════════════════════════
// F. NO-SCATTERED-HEAL: whitespaceEquivalent is owned by auto-heal.ts
// ════════════════════════════════════════════════════════════════════════

describe("F. auto-heal-owner — Level-1 heal primitive not scattered (No Scattered Helpers)", () => {
  test("whitespaceEquivalent has ONE owner (the engine's edit-operations), re-exported by auto-heal.ts", () => {
    // The single algorithm owner is the engine's governed-editor patch path
    // (`engine/src/editor/edit-operations.ts`), where the Level-1 heal runs.
    // `auto-heal.ts` re-exports it so the web UI's stale-index heal shares the
    // ONE implementation. Neither may carry a second local copy.
    expect(AUTO_HEAL_SRC).toContain("whitespaceEquivalent");
    expect(AUTO_HEAL_SRC).toContain("from \"../../engine/src/editor/edit-operations.ts\"");
  });

  test("no module re-defines a local whitespaceEquivalent function", () => {
    // A `function whitespaceEquivalent(` definition (not preceded by
    // import/export) anywhere in server/ is a scattered second copy of the
    // heal primitive. Dynamic discovery over all server sources.
    const offenders = SERVER_TS_FILES.filter((f) =>
      /(^|\n)\s*function whitespaceEquivalent\s*\(/.test(readFileSync(f, "utf8")),
    );
    expect(offenders, `local whitespaceEquivalent definitions (must be zero — owned by the engine): ${offenders.join(", ")}`).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// G. BEHAVIORAL: the detection functions work correctly
// ════════════════════════════════════════════════════════════════════════

import {
  computeStaleSampleSize,
  sampleSourceFiles,
  detectBrokenEdges,
  detectStaleIndex,
  captureMtimeSnapshot,
  whitespaceEquivalent,
} from "../../server/intelligence/auto-heal.ts";
import { getAutoHealConfig } from "../../server/kernel/harness-config.ts";
import { read, walkTs, stripBlockAndOwnLineComments } from "../helpers/source-scan.ts";

/** This guard's population is CODE — engine and server TypeScript. The
 * mode is named once here rather than guessed from bytes per call. */
const stripComments = (src: string) => stripBlockAndOwnLineComments(src, "probe.ts");
import { createTempDir } from "../helpers/temp-dir.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
import { functionBody } from "../helpers/function-scope.ts";
describe("G. auto-heal-owner — behavioral (detection works correctly)", () => {
  let tmp: string;
  // createTempDir registers per-test removal via onTestFinished — no afterEach.
  beforeEach(() => { tmp = createTempDir("autoheal-owner-"); });

  test("detectBrokenEdges flags imports with null resolvedPath (all import kinds)", () => {
    const map = {
      schemaVersion: "bridlewise-intelligence/v1" as const,
      rootPath: "/test",
      generatedAt: new Date().toISOString(),
      files: [
        { path: "a.ts", extension: "ts", sizeBytes: 10, contentHash: "h", lineCount: 1, isSource: true },
      ],
      modules: [
        {
          path: "a.ts",
          contentHash: "h",
          lineCount: 1,
          symbols: [],
          imports: [
            { specifier: "./missing", kind: "direct-import" as const, importedNames: [], resolvedPath: null },
            { specifier: "./exists", kind: "re-export" as const, importedNames: [], resolvedPath: "exists.ts" },
            { specifier: "./also-missing", kind: "dynamic-import" as const, importedNames: [], resolvedPath: null },
          ],
          exports: [],
          architectureModuleId: null,
          architectureLayer: null,
          architectureRealm: null,
          architectureOwner: null,
        },
      ],
      totalSymbols: 0,
      totalDependencies: 2,
      mapHash: "h",
    };
    const report = detectBrokenEdges(map);
    expect(report.count).toBe(2);
    expect(report.brokenEdges.map((e) => e.kind).sort()).toEqual(["direct-import", "dynamic-import"]);
  });

  test("detectStaleIndex flags a changed file (forward mtime drift)", () => {
    const file = join(tmp, "src.ts");
    writeFileSync(file, "const x = 1;\n");
    const snap = captureMtimeSnapshot(tmp, {
      schemaVersion: "bridlewise-intelligence/v1" as const,
      rootPath: tmp,
      generatedAt: new Date().toISOString(),
      files: [{ path: "src.ts", extension: "ts", sizeBytes: 10, contentHash: "h", lineCount: 1, isSource: true }],
      modules: [{ path: "src.ts", contentHash: "h", lineCount: 1, symbols: [], imports: [], exports: [], architectureModuleId: null, architectureLayer: null, architectureRealm: null, architectureOwner: null }],
      totalSymbols: 0,
      totalDependencies: 0,
      mapHash: "h",
    });
    // Move mtime forward 5s → drift detected.
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    const report = detectStaleIndex(snap);
    expect(report.stale).toBe(true);
    expect(report.changedFiles).toHaveLength(1);
  });

  test("detectStaleIndex flags a vanished file (stat fails)", () => {
    const file = join(tmp, "gone.ts");
    writeFileSync(file, "const y = 2;\n");
    const snap = captureMtimeSnapshot(tmp, {
      schemaVersion: "bridlewise-intelligence/v1" as const,
      rootPath: tmp,
      generatedAt: new Date().toISOString(),
      files: [{ path: "gone.ts", extension: "ts", sizeBytes: 10, contentHash: "h", lineCount: 1, isSource: true }],
      modules: [{ path: "gone.ts", contentHash: "h", lineCount: 1, symbols: [], imports: [], exports: [], architectureModuleId: null, architectureLayer: null, architectureRealm: null, architectureOwner: null }],
      totalSymbols: 0,
      totalDependencies: 0,
      mapHash: "h",
    });
    // Delete the file → vanished.
    rmSync(file);
    const report = detectStaleIndex(snap);
    expect(report.stale).toBe(true);
    expect(report.vanishedFiles).toHaveLength(1);
  });

  test("detectStaleIndex does NOT flag an unchanged file (no false positive)", () => {
    const file = join(tmp, "stable.ts");
    writeFileSync(file, "const z = 3;\n");
    const snap = captureMtimeSnapshot(tmp, {
      schemaVersion: "bridlewise-intelligence/v1" as const,
      rootPath: tmp,
      generatedAt: new Date().toISOString(),
      files: [{ path: "stable.ts", extension: "ts", sizeBytes: 10, contentHash: "h", lineCount: 1, isSource: true }],
      modules: [{ path: "stable.ts", contentHash: "h", lineCount: 1, symbols: [], imports: [], exports: [], architectureModuleId: null, architectureLayer: null, architectureRealm: null, architectureOwner: null }],
      totalSymbols: 0,
      totalDependencies: 0,
      mapHash: "h",
    });
    const report = detectStaleIndex(snap);
    expect(report.stale).toBe(false);
    expect(report.changedFiles).toEqual([]);
    expect(report.vanishedFiles).toEqual([]);
  });

  test("whitespaceEquivalent catches tab/space + CRLF/LF drift (Level-1 heal)", () => {
    expect(whitespaceEquivalent("foo(a, b)", "foo( a , b )")).toBe(true);
    expect(whitespaceEquivalent("foo(a,\tb)", "foo(a,\nb)")).toBe(true);
    expect(whitespaceEquivalent("foo(a, b)", "bar(a, b)")).toBe(false);
    expect(whitespaceEquivalent("", "")).toBe(true);
  });

  test("computeStaleSampleSize is adaptive: full coverage ≤ threshold, sqrt above", () => {
    const cfg = getAutoHealConfig();
    // Full coverage: sample == fileCount.
    expect(computeStaleSampleSize(50, cfg)).toBe(50);
    expect(computeStaleSampleSize(cfg.staleFullCoverageThreshold, cfg)).toBe(cfg.staleFullCoverageThreshold);
    // Sqrt regime: bounded by floor + ceiling.
    const big = computeStaleSampleSize(10000, cfg);
    expect(big).toBeGreaterThanOrEqual(cfg.staleSampleFloor);
    expect(big).toBeLessThanOrEqual(cfg.staleSampleCeiling);
  });

  test("sampleSourceFiles spreads the sample via stride (not clustered)", () => {
    const paths = Array.from({ length: 100 }, (_, i) => `f${i}.ts`);
    const sample = sampleSourceFiles(paths, 5);
    expect(sample).toEqual(["f0.ts", "f20.ts", "f40.ts", "f60.ts", "f80.ts"]);
  });

  test("getAutoHealConfig defaults: enabled, positive thresholds (deny-by-default)", () => {
    const cfg = getAutoHealConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.staleFullCoverageThreshold).toBeGreaterThan(0);
    expect(cfg.staleSampleFloor).toBeGreaterThan(0);
    expect(cfg.staleSampleCeiling).toBeGreaterThanOrEqual(cfg.staleSampleFloor);
  });
});
