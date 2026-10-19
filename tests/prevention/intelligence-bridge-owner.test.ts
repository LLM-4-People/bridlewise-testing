// @vitest-environment node
/**
 * Mechanical enforcement: intelligence bridge owner (Single-Party-Owner
 * INTELLIGENCE BRIDGE).
 *
 * ("Single-Party-Owner Principle" + "Deny-by-
 * Default"): intelligence operations (repository map, dependency graph,
 * symbol search, reuse, impact, quick-view, file-slice, auto-heal
 * signals) must have ONE owner module (`server/intelligence-bridge.ts`).
 * ALL intelligence queries go through the bridge — no route or service
 * calls the canonical intelligence subsystem (`integration/src/
 * intelligence/*`) directly. The bridge enforces the fs-gate (
 * ownership) at the choke point for every public function that takes a
 * project path, so a route that forgets to pass the gate cannot leak.
 *
 * This test pins the architecture across 7 assurance classes:
 * A. source-scan — the bridge is the single intelligence owner; the
 * canonical source is imported ONLY by the bridge + its workers;
 * canonical.ts does NOT re-export intelligence VALUE forms (deny-by-
 * default — no parallel import path that bypasses the bridge).
 * B. single-owner — the bridge's public functions are defined ONLY in
 * intelligence-bridge.ts (no scattered intelligence helpers).
 * C. bridge uses fs-gate — imports assertProjectPathOwnership +
 * resolveWithinProject; every public project-scoped function calls
 * the ownership gate.
 * D. behavioral — the gate runs FIRST (ForbiddenError before
 * MapNotReadyError — the cross-user fix at the lowest level); the
 * impact/deps filePath is normalized (a `./`-prefixed path matches
 * the graph key — was a silent empty result); an escaping path is
 * denied (PathTraversalError); the deps `dir` param is validated.
 * E. route-level — routes/intelligence.ts imports every op from the
 * bridge (not the canonical source) + constructs + passes the gate.
 * F. config — the search/retrieve result limits are config-owned (one
 * accessor in harness-config.ts; no scattered hardcoded 50/500/15/
 * 100 in the bridge, route, or tool-executor).
 * G. adaptive — the repository-map summary derives languages via
 * `extname` (dynamic), not a hardcoded `endsWith` chain.
 *
 * Dynamic discovery: file lists are discovered via
 * `readdirSync` — NO hardcoded route/bridge/source file lists. A new
 * route or bridge that bypasses the owner is automatically caught.
 *
 * Mutation-verified: key assertions FAIL when the violation is
 * reintroduced (removing the gate from a bridge function, re-exporting
 * the canonical value form, re-hardcoding a limit, reverting the
 * filePath normalization, reverting the dir validation).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { bodyCallsWith, exportedFunctionParameters, functionBody } from "../helpers/function-scope.ts";
import { join, relative, sep } from "node:path";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";

import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { walkTs, valueReferencesModule, reExportedValuesFrom } from "../helpers/source-scan.ts";
import {
  getRepositoryMapAsync,
  getRepositoryMapSummary,
  getImpactAnalysis,
  getForwardDeps,
  getReverseDeps,
  invalidateProjectCache,
} from "../../server/intelligence/intelligence-bridge.ts";
import { makeFsGate, type FsGate } from "../../server/filesystem/fs-gate.ts";
import { ForbiddenError, PathTraversalError, MapNotReadyError, BadRequestError } from "../../server/kernel/errors.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const SERVER_DIR = join(process.cwd(), "server");
const ROUTES_DIR = join(SERVER_DIR, "routes");
const CANONICAL_INTEL_PREFIX = "engine/src/intelligence/";

// ── Test DB + project setup (for behavioral tests) ──

let tmpRoot: string;
let db: DbClient;
let userA: { userId: string };
let userB: { userId: string };
let projectAPath: string;
let gateA: FsGate;
let gateB: FsGate;

beforeAll(async () => {
  tmpRoot = createTempDir("ch-intel-owner-");
  db = new DbClient({ path: join(tmpRoot, "web.db") });
  userA = createTestUser(db, "alice-intel");
  userB = createTestUser(db, "bob-intel");
  projectAPath = join(tmpRoot, "alice-project");
  mkdirSync(join(projectAPath, "src"), { recursive: true });
  // Two files with a real import so the dependency graph has an edge
  // (a.ts → b.ts); getImpactAnalysis(path, "src/b.ts") returns ["src/a.ts"].
  writeFileSync(join(projectAPath, "src", "b.ts"), "export const B = 1;\n");
  writeFileSync(join(projectAPath, "src", "a.ts"), "import { B } from './b';\nexport const A = B;\n");
  db.createProject({ name: "A-intel", path: projectAPath }, userA.userId);
  const adb = AsyncDbClient.inline(db);
  gateA = await makeFsGate(userA.userId, adb, projectAPath);
  gateB = await makeFsGate(userB.userId, adb, projectAPath);
  // Build the repository map OFF the event loop (the bridge's worker) so
  // the behavioral tests can exercise the graph lookups against a ready map.
  await getRepositoryMapAsync(projectAPath, gateA);
});

afterAll(() => {
  if (projectAPath) {
    try { invalidateProjectCache(projectAPath); } catch { /* ok */ }
  }
  if (db) db.close();
});

// ── A. source-scan: the bridge is the single intelligence owner ──

describe("A. source-scan: intelligence-bridge is the single owner", () => {
  test("intelligence-bridge.ts exports the public intelligence functions", () => {
    const src = readFileSync(join(SERVER_DIR, "intelligence/intelligence-bridge.ts"), "utf8");
    expect(src).toContain("export function getRepositoryMap");
    expect(src).toContain("export async function getRepositoryMapAsync");
    expect(src).toContain("export function getRepositoryMapSummary");
    expect(src).toContain("export function getDependencyGraph");
    expect(src).toContain("export function getImpactAnalysis");
    expect(src).toContain("export function getForwardDeps");
    expect(src).toContain("export function getReverseDeps");
    expect(src).toContain("export function searchCodeSymbols");
    expect(src).toContain("export function findReuse");
    expect(src).toContain("export function findCodeDuplicates");
    expect(src).toContain("export function retrieveRelevantFiles");
    expect(src).toContain("export function quickView");
    expect(src).toContain("export function fileSlice");
    expect(src).toContain("export function fileViewport");
    expect(src).toContain("export function fileSkeleton");
    expect(src).toContain("export function injectRepositoryMapIntoPrompt");
    expect(src).toContain("export function getProjectAutoHealReport");
    expect(src).toContain("export function getProjectBrokenEdges");
  });

  test("the canonical intelligence source is imported ONLY by the bridge + its workers (no route/service bypass)", () => {
    // Dynamic discovery: scan EVERY.ts file under server/ (incl.
    // routes/) for a direct import of the canonical intelligence subsystem.
    // The allowed importers are the bridge + its off-thread worker entry
    // points — recognized DYNAMICALLY by the delegation naming convention
    // (`*-bridge.ts` / `*-worker.ts`), NOT a hardcoded 3-name set. A new
    // worker added for off-thread intelligence work is auto-allowed (its
    // `-worker.ts` name is the explicit grant); a route/service that imports
    // the canonical source directly (bypassing the bridge, not named as a
    // worker) is auto-caught. harness-config.ts imports a TYPE only
    // (Exp474RetrievalOptions) — type-only imports create no runtime path, so
    // they are allowed regardless of name.
    // `canonical.ts` joins the bridges and workers here because it is the
    // same kind of thing: the server's single declared import point for the
    // canonical source, whose whole job is to own the relative path so no
    // route spells it out. It is not exempt from the real constraint — the
    // test below denies it every intelligence FUNCTION, dynamically — it is
    // exempt from "reaching the subsystem at all", which is its purpose.
    const isDelegation = (rel: string): boolean =>
      /-bridge\.ts$/.test(rel) || /-worker\.ts$/.test(rel) || rel === "kernel/canonical.ts";
    const offenders: string[] = [];
    // The shared tree walk, not a private copy of it: the copy that used to
    // live here differed from the shared one in its symlink handling, which
    // is the kind of drift two implementations of one walk always produce.
    for (const file of walkTs(SERVER_DIR)) {
      const rel = relative(SERVER_DIR, file).split(sep).join("/");
      const src = readFileSync(file, "utf8");
      // A VALUE reference to the canonical intelligence subsystem (not a
      // type-only one). `import type {... }` is allowed (erased at runtime);
      // a value `import { generateRepositoryMap }` is a bypass — and so are
      // `import * as`, `await import(...)` and `export * from`, which the
      // brace-list regex this replaced could not see. Verified by mutation:
      // a route reaching the subsystem by namespace import, and another
      // reaching it by dynamic import, both left this green.
      if (valueReferencesModule(src, CANONICAL_INTEL_PREFIX) && !isDelegation(rel)) {
        // Config floors (`DEFAULT_FARM_*`) live in intelligence-config —
        // harness-config is the config owner reading those floors, not an
        // extract bypass. Any other intelligence module from harness-config
        // is still a bypass.
        const configFloorsOnly =
          rel === "kernel/harness-config.ts" &&
          valueReferencesModule(src, "intelligence/intelligence-config.ts") &&
          !valueReferencesModule(src, "intelligence/repository-map") &&
          !valueReferencesModule(src, "intelligence/symbol-extractor") &&
          !valueReferencesModule(src, "intelligence/process-farm");
        if (!configFloorsOnly) offenders.push(rel);
      }
    }
    expect(offenders, `non-bridge files must not import the canonical intelligence subsystem as a value: ${offenders.join(", ")}`).toEqual([]);
  });

  test("canonical.ts re-exports no intelligence BEHAVIOUR, whatever module it lives in", () => {
    // The bridge is the single owner of every gated intelligence operation.
    // A value re-export from canonical.ts is a parallel import path that
    // reaches those operations without the fs-gate or the worker.
    //
    // The rule is enforced against the intelligence subsystem DISCOVERED on
    // disk, not against a written-out list of seven module names. That list
    // was the whole weakness: `intelligence/` holds eighteen modules, so
    // eleven of them — and every module added after the list was typed —
    // could be re-exported wholesale and this test would still pass. The
    // guard's universe has to be the real one.
    //
    // What is denied is BEHAVIOUR, not values in general: a re-exported
    // function or class is a bypass; a schema-version constant is a fact
    // about the format and gates nothing.
    const src = readFileSync(join(SERVER_DIR, "kernel/canonical.ts"), "utf8");
    const intelDir = join(
      process.cwd(), "engine", "src", "intelligence",
    );
    const modules = readdirSync(intelDir).filter((f) => f.endsWith(".ts"));
    expect(modules.length, "the intelligence subsystem walk found nothing — the scan is looking in the wrong place")
      .toBeGreaterThan(10);

    const behaviourReExports: string[] = [];
    for (const moduleFile of modules) {
      const exported = reExportedValuesFrom(src, `intelligence/${moduleFile}`);
      if (exported.length === 0) continue;
      const ownerSrc = readFileSync(join(intelDir, moduleFile), "utf8");
      for (const name of exported) {
        // `export * from` names nothing and re-exports everything, so it is
        // behaviour whenever the owner declares any. Spelled out because a
        // star that fell through a per-name lookup was the quietest bypass
        // of all: it is the ONE form that grows on its own as the owner
        // module gains functions, and no assertion mentions it.
        const declaresBehaviour = name === "*"
          ? /\bexport\s+(?:async\s+)?(?:function|class)\s+\w/.test(ownerSrc)
          : new RegExp(
              `export\\s+(?:async\\s+)?(?:function|class)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
            ).test(ownerSrc);
        if (declaresBehaviour) behaviourReExports.push(`${moduleFile}:${name}`);
      }
    }
    expect(
      behaviourReExports,
      "canonical.ts re-exports intelligence behaviour, which is an import path that reaches it without the bridge",
    ).toEqual([]);
    // The TYPE re-exports ARE present (consumed by the bridge + auto-heal).
    expect(src).toMatch(/export type \{ RepositoryMap/);
  });
});

// ── B. single-owner: bridge functions defined ONLY in intelligence-bridge.ts ──

describe("B. single-owner: bridge functions defined ONLY in intelligence-bridge.ts", () => {
  // Dynamic discovery: scan ALL.ts files in server/ + routes/.
  // Recursive: domain subfolders (intelligence/, run/, …) hold source too, so a
  // top-level readdirSync would silently miss them. walkTs is the shared walk.
  const SERVER_FILES: string[] = walkTs(SERVER_DIR).map((f) => relative(SERVER_DIR, f).split(sep).join("/"));
  // Dynamic discovery: parse EVERY exported function name from
  // the bridge source — NEVER hardcode the list. A new bridge function is
  // automatically checked (the old hardcoded BRIDGE_FUNCTIONS list of 19
  // names would silently miss a 20th export).
  const BRIDGE_SRC = readFileSync(join(SERVER_DIR, "intelligence/intelligence-bridge.ts"), "utf8");
  const BRIDGE_FUNCTIONS = [...BRIDGE_SRC.matchAll(/^export (?:async )?function (\w+)\b/gm)].map((m) => m[1]!);

  for (const fn of BRIDGE_FUNCTIONS) {
    test(`${fn} is defined ONLY in intelligence-bridge.ts`, () => {
      const definers: string[] = [];
      for (const f of SERVER_FILES) {
        const src = readFileSync(join(SERVER_DIR, f), "utf8");
        const re = new RegExp(`export (?:async )?function ${fn}\\b`);
        if (re.test(src)) definers.push(f);
      }
      expect(definers, `${fn} must be defined ONLY in intelligence-bridge.ts (no scattered intelligence helpers)`).toEqual(["intelligence/intelligence-bridge.ts"]);
    });
  }
});

// ── C. bridge uses fs-gate ──

describe("C. intelligence bridge uses fs-gate (ownership gate at the choke point)", () => {
  test("intelligence-bridge.ts imports assertProjectPathOwnership + resolveWithinProject from fs-gate", () => {
    const src = readFileSync(join(SERVER_DIR, "intelligence/intelligence-bridge.ts"), "utf8");
    expect(src).toContain("../filesystem/fs-gate.ts");
    expect(src).toContain("assertProjectPathOwnership");
    // resolveWithinProject is used by the impact/deps filePath normalizer.
    expect(src).toContain("resolveWithinProject");
  });

  test("every public bridge function that takes a projectPath calls assertProjectPathOwnership", () => {
    // Dynamic discovery: parse the bridge's exported functions
    // that take a `projectPath` parameter + an optional `gate?`. Each MUST
    // call `assertProjectPathOwnership(projectPath, gate)` (the ownership
    // gate at the choke point). A new bridge function that takes a project
    // path but forgets the gate is auto-caught.
    const src = readFileSync(join(SERVER_DIR, "intelligence/intelligence-bridge.ts"), "utf8");
    // THE PUBLIC PROJECT-SCOPED ACCESSORS, from the parser. `buildMapInWorker`
    // and `requireCachedMap` are private (not exported) — they are guarded by
    // their public callers, so they are excluded by the same property.
    //
    // MEASURED WHEN THIS WAS CONVERTED: the line-anchored regex this replaces
    // saw **16** of these functions; the parser sees **21**. Five declare their
    // parameters one per line, so the signature never appeared on a single line
    // and the guard that exists to auto-catch a forgotten gate was inspecting
    // three quarters of the population and reporting clean.
    const checked: string[] = [];
    for (const [name, parameters] of exportedFunctionParameters(src, "intelligence/intelligence-bridge.ts")) {
      if (!parameters.startsWith("projectPath: string") || !parameters.includes("gate?: FsGate")) continue;
      expect(
        bodyCallsWith(functionBody(src, name, `intelligence-bridge.ts ${name}`), "assertProjectPathOwnership", ["projectPath", "gate"]),
        `${name} must call assertProjectPathOwnership(projectPath, gate) (the ownership gate at the choke point)`,
      ).toBe(true);
      checked.push(name);
    }
    expect(checked.length, `public project-scoped bridge functions checked: ${checked.length}`).toBeGreaterThanOrEqual(21);
  });
});

// ── D. behavioral: the bridge enforces the gate + normalization ──

describe("D. behavioral: gate-first + filePath normalization + dir validation", () => {
  test("getRepositoryMapSummary throws ForbiddenError when gate passed + path not owned (gate runs FIRST, before the map)", () => {
    // User B does not own User A's project. The bridge enforces ownership
    // at the CHOKE POINT — ForbiddenError (403) is thrown BEFORE the map
    // is read (MapNotReadyError would be thrown if the gate were absent).
    // This is the cross-user fix at the LOWEST level — even if a route
    // forgot to check, the bridge catches it.
    expect(() => getRepositoryMapSummary(projectAPath, gateB)).toThrow(ForbiddenError);
    try {
      getRepositoryMapSummary(projectAPath, gateB);
    } catch (err) {
      expect((err as ForbiddenError).code).toBe("project_path_not_owned");
    }
  });

  test("getImpactAnalysis throws ForbiddenError when gate passed + path not owned (gate before map + graph)", () => {
    // The gate runs before requireCachedMap + buildDependencyGraph. B's
    // gate on A's project → ForbiddenError (not MapNotReadyError).
    expect(() => getImpactAnalysis(projectAPath, "src/a.ts", gateB)).toThrow(ForbiddenError);
  });

  test("getImpactAnalysis normalizes a `./`-prefixed filePath to the graph key (was a silent empty result)", () => {
    // The graph nodes are keyed by relative paths (`src/b.ts`). Before 
    // a caller-supplied `./src/b.ts` SILENTLY returned an empty result
    // (exact-key Map.get missed the `./` prefix). After  the bridge
    // normalizes the filePath via resolveWithinProject + relative, so
    // `./src/b.ts` matches the graph key `src/b.ts`. b is imported by a →
    // the impact analysis returns ["src/a.ts"] for BOTH forms.
    const raw = getImpactAnalysis(projectAPath, "src/b.ts", gateA);
    const dotted = getImpactAnalysis(projectAPath, "./src/b.ts", gateA);
    expect(raw.directlyAffected.length, "raw 'src/b.ts' should have a reverse dep (a imports b)").toBeGreaterThan(0);
    expect(dotted.directlyAffected, "'./src/b.ts' must normalize to the same result as 'src/b.ts' (no silent empty)").toEqual(raw.directlyAffected);
  });

  test("getImpactAnalysis accepts an absolute filePath within the project root (normalized to the graph key)", () => {
    const raw = getImpactAnalysis(projectAPath, "src/b.ts", gateA);
    const abs = getImpactAnalysis(projectAPath, join(projectAPath, "src/b.ts"), gateA);
    expect(abs.directlyAffected, "an absolute path within the root must normalize to the graph key").toEqual(raw.directlyAffected);
  });

  test("getImpactAnalysis denies an escaping filePath (PathTraversalError — deny-by-default)", () => {
    expect(() => getImpactAnalysis(projectAPath, "../../etc/passwd", gateA)).toThrow(PathTraversalError);
  });

  test("getForwardDeps + getReverseDeps normalize the filePath the same way", () => {
    const fwdRaw = getForwardDeps(projectAPath, "src/a.ts", gateA);
    const fwdDotted = getForwardDeps(projectAPath, "./src/a.ts", gateA);
    expect(fwdDotted, "getForwardDeps must normalize a ./-prefixed path").toEqual(fwdRaw);
    const revRaw = getReverseDeps(projectAPath, "src/b.ts", gateA);
    const revDotted = getReverseDeps(projectAPath, "./src/b.ts", gateA);
    expect(revDotted, "getReverseDeps must normalize a ./-prefixed path").toEqual(revRaw);
  });

  test("an empty/missing filePath is rejected (no silent empty graph result)", () => {
    // Tightened (EHC-8): assert the SPECIFIC typed error. An empty filePath
    // flows through `normalizeGraphKey` → `resolveWithinProject`, which
    // throws `BadRequestError("missing_path")`. A loose `.toThrow` would
    // pass on ANY error (e.g. a MapNotReadyError), masking the deny-by-
    // default contract (empty path → 400, not a silent empty result).
    expect(() => getImpactAnalysis(projectAPath, "", gateA)).toThrow(BadRequestError);
    expect(() => getImpactAnalysis(projectAPath, "", gateA)).toThrow(/path/i);
  });

  test("a not-ready map throws MapNotReadyError (not a bare Error) when the gate is absent + path is server-verified", () => {
    // A path no caller owns (not in the DB) with NO gate: the bridge trusts
    // the path (server-verified exception) + tries the cache → MapNotReadyError
    // (typed, retryable) on a fresh path. Confirms the typed-error contract.
    const freshPath = join(tmpRoot, "never-indexed");
    mkdirSync(freshPath, { recursive: true });
    expect(() => getRepositoryMapSummary(freshPath)).toThrow(MapNotReadyError);
  });

  test("the deps route `dir` validation rejects an unknown direction (no type lie)", () => {
    // Source-scan of the route: the deps handler validates `dir` is one of
    // forward/reverse (BadRequestError invalid_direction). A blanket forward
    // fallback would let `dir=sideways` return forward deps labeled sideways.
    const src = readFileSync(join(ROUTES_DIR, "intelligence.ts"), "utf8");
    expect(src).toMatch(/invalid_direction/);
    expect(src).toMatch(/Direction must be 'forward' or 'reverse'/);
    // BadRequestError is the typed error for the 400.
    expect(src).toContain("BadRequestError");
  });

  test("the async map path checks mtime staleness within the TTL (auto-heal consistency with the sync path)", () => {
    // The async path (`getCachedMapAsync`) must check `isIndexStale` within
    // the TTL window — the same check the sync path (`getCachedMapSync`)
    // makes. Without this, a project accessed only via the async path
    // (e.g. the quality-bridge's `getQualityIndicatorAsync`) would never
    // auto-heal a stale index within the TTL window: files changed on disk
    // would be served stale until the TTL expired, with no background
    // rebuild triggered. Source-scan: the check is a structural invariant
    // (removing the `isIndexStale` call from `getCachedMapAsync` fails this).
    const src = readFileSync(join(SERVER_DIR, "intelligence/intelligence-bridge.ts"), "utf8");
    const lines = src.split("\n");
    const startIdx = lines.findIndex((l) => /^async function getCachedMapAsync\b/.test(l));
    expect(startIdx, "getCachedMapAsync must be defined").toBeGreaterThan(-1);
    // Find the next top-level function declaration after startIdx.
    const endIdx = lines.findIndex((l, i) => i > startIdx && /^(export )?(async )?function \w/.test(l));
    const body = lines.slice(startIdx, endIdx === -1 ? undefined : endIdx).join("\n");
    expect(body, "getCachedMapAsync must call isIndexStale within the TTL (auto-heal consistency with getCachedMapSync)").toContain("isIndexStale(");
  });

  test("the dependency graph is cached + tied to the map's generation (no per-request rebuild)", () => {
    // The graph is a pure function of the map. `buildDependencyGraph` is
    // non-trivial CPU work (resolve every import + build adjacency maps);
    // rebuilding it on every graph/impact/deps request was a per-request
    // cost. The cache is tied to the map's `generatedAt` so a rebuild within
    // the TTL window (the auto-heal mtime-staleness path replaces the map
    // entry with a NEW generatedAt) invalidates the graph automatically.
    // Source-scan: the graph cache + the generation tie are structural.
    const src = readFileSync(join(SERVER_DIR, "intelligence/intelligence-bridge.ts"), "utf8");
    expect(src).toContain("graphCache");
    expect(src).toContain("requireCachedGraph");
    // The tie: the graph cache entry stores mapGeneratedAt + compares it.
    expect(src).toMatch(/mapGeneratedAt\s*===\s*\w+\.generatedAt/);
    // Every cache derived from the map is invalidated alongside the map.
    // Asserting the ITERATION rather than a per-cache `xCache.delete(...)`
    // line is the stronger check: naming each cache could only ever confirm
    // the caches that existed when this test was written, so a derived cache
    // added later would be missed exactly when it mattered. Iterating the
    // registry covers every cache, including ones not yet written.
    expect(src).toMatch(/for\s*\(const cache of derivedFromMapCaches\)\s*cache\.delete\(projectPath\)/);
    // …and the registry is only populated by the registering constructor, so
    // a derived cache cannot come into existence outside it.
    const rawDerivedCaches = src.match(/=\s*new Map<string,\s*DerivedEntry</g) ?? [];
    expect(
      rawDerivedCaches.length,
      "derived caches must be created via registerDerivedCache() so they are auto-invalidated; " +
        "a bare `new Map<string, DerivedEntry<…>>` would never be evicted",
    ).toBe(1); // the one inside registerDerivedCache itself
    // The graph functions use the cached graph (not a direct buildDependencyGraph
    // call after requireCachedMap). Each graph accessor calls requireCachedGraph.
    expect(src).toContain("const { graph } = requireCachedGraph(projectPath);");
    expect(src).toContain("const { graph, modulePaths } = requireCachedGraph(projectPath);");
    expect(src).toContain("const { map, graph } = requireCachedGraph(projectPath);");
    // `buildDependencyGraph` is the CPU-heavy builder. It must be called
    // ONLY in `requireCachedGraph` (the single build site that caches the
    // result). A graph accessor that reverts to calling buildDependencyGraph
    // directly (bypassing the cache) would add a second call site — this
    // count check catches that. Count the call-sites (the `(` after the name)
    // so the import line + the function definition are not double-counted.
    const buildCallSites = (src.match(/\bbuildDependencyGraph\(/g) ?? []).length;
    expect(
      buildCallSites,
      "buildDependencyGraph must be called ONLY in requireCachedGraph (1 call site) — a graph accessor that bypasses the cache adds a second site",
    ).toBe(1);
  });
});

// ── E. route-level: routes import from the bridge + pass the gate ──

describe("E. route-level: routes/intelligence.ts goes through the bridge + gate", () => {
  test("routes/intelligence.ts imports intelligence ops from the bridge, NOT the canonical source", () => {
    const src = readFileSync(join(ROUTES_DIR, "intelligence.ts"), "utf8");
    expect(src).toContain("../intelligence/intelligence-bridge.ts");
    // No direct import of the canonical intelligence subsystem.
    expect(src).not.toMatch(new RegExp(`from\\s*["'][^"']*${escapeRegex(CANONICAL_INTEL_PREFIX)}`));
  });

  test("routes/intelligence.ts constructs the gate via makeFsGate + requireUserContext", () => {
    const src = readFileSync(join(ROUTES_DIR, "intelligence.ts"), "utf8");
    expect(src).toContain("requireUserContext");
    expect(src).toContain("makeFsGate");
    expect(src).toContain("fs-gate.ts");
  });

  test("routes/intelligence.ts passes the gate to every bridge call (not just constructs it)", () => {
    // Dynamic discovery: every call to a bridge function in the
    // route must pass `gate` as the last arg. A bridge call that forgets the
    // gate (e.g. `getRepositoryMap(projectPath)`) is a bypass — the route
    // would not enforce ownership. We parse the NAMED IMPORTS from the
    // bridge (not a hardcoded list) so a newly-imported bridge function is
    // automatically checked.
    const src = readFileSync(join(ROUTES_DIR, "intelligence.ts"), "utf8");
    // Parse the named imports from "../intelligence-bridge.ts" — handles
    // multi-line import blocks + `as` aliases.
    const importBlockRe = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*intelligence-bridge\.ts["']/s;
    const importMatch = importBlockRe.exec(src);
    expect(importMatch, "routes/intelligence.ts must import from intelligence-bridge.ts").not.toBeNull();
    const bridgeCalls = importMatch![1]!
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
      .filter((s) => s.length > 0);
    for (const fn of bridgeCalls) {
      // Find each CALL `fn(` in the route + verify it passes `gate`.
      const callRe = new RegExp(`\\b${fn}\\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(src)) !== null) {
        // Grab the rest of the call line(s) — look for `gate` before the `)`.
        const from = m.index;
        const closeParen = src.indexOf(")", from);
        expect(closeParen, `${fn} call must close its paren`).toBeGreaterThan(0);
        const callText = src.slice(from, closeParen + 1);
        expect(
          callText,
          `${fn} must pass the gate (ownership) — found call without 'gate': ${callText}`,
        ).toContain("gate");
      }
    }
  });
});

// ── F. config: search/retrieve limits are config-owned ──

describe("F. config: search/retrieve result limits are config-owned (no scattered literals)", () => {
  test("the limit accessors are defined ONLY in harness-config.ts", () => {
    const files = walkTs(SERVER_DIR).map((f) => relative(SERVER_DIR, f).split(sep).join("/"));
    for (const accessor of ["getIntelligenceSearchDefaultLimit", "getIntelligenceSearchMaxLimit", "getIntelligenceRetrieveDefaultLimit", "getIntelligenceRetrieveMaxLimit"]) {
      const definers: string[] = [];
      for (const f of files) {
        const src = readFileSync(join(SERVER_DIR, f), "utf8");
        if (new RegExp(`export function ${accessor}\\b`).test(src)) definers.push(f);
      }
      expect(definers, `${accessor} must be defined ONLY in harness-config.ts (single owner)`).toEqual(["kernel/harness-config.ts"]);
    }
  });

  test("the bridge + route + tool-executor use the config accessor (no hardcoded 50 default for search)", () => {
    // The bridge's searchCodeSymbols + findReuse default + the tool-executor
    // fallback must read getIntelligenceSearchDefaultLimit (not a literal 50).
    const bridge = readFileSync(join(SERVER_DIR, "intelligence/intelligence-bridge.ts"), "utf8");
    expect(bridge).toContain("getIntelligenceSearchDefaultLimit");
    // No hardcoded `?? 50` default for the search limit remains.
    expect(bridge).not.toMatch(/limit\s*\?\?\s*50\b/);
    const route = readFileSync(join(ROUTES_DIR, "intelligence.ts"), "utf8");
    expect(route).toContain("getIntelligenceSearchDefaultLimit");
    expect(route).toContain("getIntelligenceSearchMaxLimit");
    expect(route).toContain("getIntelligenceRetrieveDefaultLimit");
    expect(route).toContain("getIntelligenceRetrieveMaxLimit");
    const exec = readFileSync(join(SERVER_DIR, "tools/tool-executor.ts"), "utf8");
    expect(exec).toContain("getIntelligenceSearchDefaultLimit");
  });

  test("the route no longer hardcodes the search 50/500 or retrieve 15/100 literals as clamp defaults", () => {
    const route = readFileSync(join(ROUTES_DIR, "intelligence.ts"), "utf8");
    // The old clamp was `Math.min(Math.max(1, parseInt(...) || 50), 500)` /
    // `|| 15), 100)`. The literals 50/500/15/100 must NOT appear as the
    // clamp floor/cap (they now come from the config accessors).
    expect(route).not.toMatch(/\|\|\s*50\),\s*500\)/);
    expect(route).not.toMatch(/\|\|\s*15\),\s*100\)/);
  });
});

// ── G. adaptive: language detection is dynamic ──

describe("G. adaptive: repository-map summary derives languages dynamically", () => {
  test("getRepositoryMapSummary uses extname (not a hardcoded endsWith chain)", () => {
    const src = readFileSync(join(SERVER_DIR, "intelligence/intelligence-bridge.ts"), "utf8");
    // The adaptive fix derives the extension via `extname(mod.path)`.
    expect(src).toContain("extname(mod.path)");
    // The old hardcoded chain (`.ts`/`.tsx` → ".ts", …: "other") is gone.
    expect(src).not.toMatch(/mod\.path\.endsWith\("\.ts"\) \|\| mod\.path\.endsWith\("\.tsx"\) \? "\.ts"/);
    expect(src).not.toMatch(/:\s*"other";\s*\n\s*langCounts\.set/);
  });

  test("a project with a non-hardcoded language extension is classified (not lumped into 'other')", () => {
    // Behavioral: the summary's `languages` list reflects the ACTUAL
    // extensions in the map (via extname), so a.java/.c/.rb file is its
    // own language entry — not "other". The test project has only.ts
    // files, so the languages list contains ".ts" (extname of a.ts/b.ts).
    const summary = getRepositoryMapSummary(projectAPath, gateA);
    const exts = summary.languages.map((l) => l.extension);
    expect(exts, "the .ts files must be classified as '.ts' via extname").toContain(".ts");
    // The hardcoded chain would have produced ".ts" too, but it would have
    // lumped a hypothetical.java file into "other". extname keeps each
    // extension distinct — verified by the absence of an "other" bucket.
    expect(exts, "no 'other' bucket — every extension is its own entry").not.toContain("other");
  });
});

// ── helpers ──

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
