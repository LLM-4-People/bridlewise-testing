// @vitest-environment node
/**
 * Mechanical enforcement: awareness + quality bridge owner (Single-Party-
 * Owner AWARENESS/QUALITY BRIDGE).
 *
 * ("Single-Party-Owner Principle" + "Deny-by-
 * Default"): awareness operations (snapshot, summary, invalidate, async
 * build) must have ONE owner module (`server/awareness-bridge.ts`) and
 * quality operations (indicator, async indicator, score) must have ONE
 * owner module (`server/quality-bridge.ts`). ALL awareness/quality
 * queries go through the bridges — no route or service calls the
 * canonical awareness/quality subsystem (`integration/src/awareness/*`,
 * `integration/src/quality/*`) directly. The bridges enforce the fs-gate
 * (ownership) at the choke point for every public function that
 * takes a project path, so a route that forgets to pass the gate cannot
 * leak (deny-by-default).
 *
 * This test pins the architecture across 7 assurance classes:
 * A. source-scan — the bridges are the single owners; the canonical
 * source is imported ONLY by the bridges + the awareness worker
 * (the bridge's off-thread delegation); canonical.ts does NOT
 * re-export awareness/quality VALUE forms (deny-by-default — no
 * parallel import path that bypasses the bridges' fs-gate + worker
 * choke points). Mirrors the fix for intelligence.
 * B. single-owner — the bridges' public functions are defined ONLY in
 * awareness-bridge.ts / quality-bridge.ts (no scattered helpers).
 * C. bridge uses fs-gate — imports assertProjectPathOwnership; every
 * public project-scoped function calls the ownership gate (directly
 * or via delegation to another bridge function that does).
 * D. behavioral — the gate runs FIRST (ForbiddenError before
 * AwarenessNotReadyError — the cross-user fix at the lowest level);
 * the quality-bridge's gate runs before its downstream calls to the
 * awareness + intelligence bridges (co-owner pattern — the quality-
 * bridge verifies ownership itself, then calls downstream without
 * forwarding the gate, BY DESIGN per server-verified path).
 * E. route-level — routes/awareness.ts + routes/quality.ts import
 * every op from the bridges (not the canonical source) + construct
 * + pass the gate to every bridge call.
 * F. config — the quality scoring weights are config-owned (one
 * accessor `getQualityConfig` in harness-config.ts; no scattered
 * hardcoded 100/0/30/20/15/5/2/100 literals in the bridge).
 * G. runner path — auto-check-runner.ts + routes/run.ts FORWARD the
 * ownership gate to the quality bridge. Both used to omit it "BY
 * DESIGN" on a server-verified path, and that was defensible only
 * while the runner sat one directory outside the call-site guard's
 * universe. Once that universe became the CALL GRAPH rather than
 * `server/routes`, the runner's call was the same ungated shape the
 * run route had already fixed. The gate is now built where ownership
 * is established (`blocks/checks.ts`, after `db.getProject(id,
 * userId)`) and threaded through, so the invariant is enforced where
 * the bridge enforces it instead of argued from a call chain.
 *
 * Dynamic discovery: file lists are discovered via
 * `readdirSync` + `walk` — NO hardcoded route/bridge/source file lists.
 * A new route or bridge that bypasses the owner is automatically caught.
 *
 * Mutation-verified: key assertions FAIL when the violation is
 * reintroduced (removing the gate from a bridge function, re-exporting
 * the canonical value form, re-hardcoding a weight, reverting the
 * route-level gate).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { join, relative, sep } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import {
  getAwarenessSnapshot,
  getAwarenessSnapshotAsync,
  getAwarenessSummary,
  invalidateAwarenessCache,
} from "../../server/awareness/awareness-bridge.ts";
import { getQualityIndicator, getQualityIndicatorAsync } from "../../server/awareness/quality-bridge.ts";
import { makeFsGate, type FsGate } from "../../server/filesystem/fs-gate.ts";
import { ForbiddenError, BadRequestError, AwarenessNotReadyError } from "../../server/kernel/errors.ts";
import { walkTs, valueReferencesModule, referencesModule } from "../helpers/source-scan.ts";
import { bodyCallsWith, exportedFunctionParameters, functionBody, type SourceScope } from "../helpers/function-scope.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
// The run path is FIVE modules since the executor was split out of the GET
// handler that used to be it. This guard asks about the run path, not about
// whichever file happened to hold the answer when it was written.
import { runPathSource } from "../helpers/run-source.ts";

/**
 * THE PUBLIC PROJECT-SCOPED ENTRY POINTS OF ONE BRIDGE, and their bodies.
 *
 * This replaces the idiom `exportedFunctionParameters` was written to retire:
 * a line-anchored `/^export (?:async )?function (\w+)\(projectPath: string\b/`
 * plus a body taken as "the lines up to the next similar construct". Both
 * halves were wrong in the same direction — quietly, and downwards.
 *
 * MEASURED, not argued: over `intelligence-bridge.ts` the line-anchored form
 * found **16** gate-taking functions and a parser finds **21**. The five it
 * could not see — `getDependencyPath`, `searchCodeSymbols`, `findCodeSymbolUsage`,
 * `findReuse`, `retrieveRelevantFiles` — declare their parameters one per line,
 * so the signature never appears on a single line at all. A guard whose whole
 * purpose is "a new function that forgets the gate is auto-caught" was
 * inspecting three quarters of them and reporting a clean run.
 *
 * The line-range body was the same defect on the other side: it ran to the next
 * `export function`, which is end-of-file for the last one, so the final
 * function's "body" contained every helper below it.
 */
function gateTakingFunctions(source: string, what: string): readonly (readonly [string, SourceScope])[] {
  const out: (readonly [string, SourceScope])[] = [];
  for (const [name, parameters] of exportedFunctionParameters(source, what)) {
    // Plain string tests rather than a pattern: the parameter list comes from
    // the parser already delimited, so there is nothing left to match around.
    if (!parameters.startsWith("projectPath: string") || !parameters.includes("gate?: FsGate")) continue;
    out.push([name, functionBody(source, name, `${what} ${name}`)] as const);
  }
  return out;
}

/** The awareness entry points a sibling may forward its gate to. */
const AWARENESS_DELEGATES = [
  "getAwarenessSnapshot", "getAwarenessSnapshotAsync", "invalidateAwarenessCache", "getAwarenessSummary",
] as const;

const SERVER_DIR = join(process.cwd(), "server");
const ROUTES_DIR = join(SERVER_DIR, "routes");
const CANONICAL_AWARENESS_PREFIX = "engine/src/awareness/";
const CANONICAL_QUALITY_PREFIX = "engine/src/quality/";

// ── Test DB + project setup (for behavioral tests) ──

let tmpRoot: string;
let db: DbClient;
let userA: { userId: string };
let userB: { userId: string };
let projectAPath: string;
let gateA: FsGate;
let gateB: FsGate;

// Each witness changes what filesystem admission would answer. The real gate
// must still answer ownership first; malformed input has its own intentional
// validation contract before ownership lookup.
const refusedRoots = {
  directory: { path: () => projectAPath, error: ForbiddenError, code: "project_path_not_owned" },
  missing: { path: () => join(projectAPath, "not-present"), error: ForbiddenError, code: "project_path_not_owned" },
  file: { path: () => join(projectAPath, "src", "a.ts"), error: ForbiddenError, code: "project_path_not_owned" },
  fileDescendant: { path: () => join(projectAPath, "src", "a.ts", "child"), error: ForbiddenError, code: "project_path_not_owned" },
  encrypted: { path: () => "enc:stale-project", error: ForbiddenError, code: "project_path_not_owned" },
  empty: { path: () => "", error: BadRequestError, code: "missing_path" },
  nul: { path: () => `${projectAPath}\0child`, error: BadRequestError, code: "invalid_path" },
};

beforeAll(async () => {
  tmpRoot = createTempDir("ch-aware-owner-");
  db = new DbClient({ path: join(tmpRoot, "web.db") });
  userA = createTestUser(db, "alice-aware");
  userB = createTestUser(db, "bob-aware");
  projectAPath = join(tmpRoot, "alice-project");
  mkdirSync(join(projectAPath, "src"), { recursive: true });
  // A small source file so the awareness engine has something to compute
  // (the engine walks + parses source files for complexity/clones/etc.).
  writeFileSync(join(projectAPath, "src", "a.ts"), "export const A = 1;\nexport function f(x: number): number { return x + 1; }\n");
  db.createProject({ name: "A-aware", path: projectAPath }, userA.userId);
  const adb = AsyncDbClient.inline(db);
  gateA = await makeFsGate(userA.userId, adb, projectAPath);
  gateB = await makeFsGate(userB.userId, adb, ...Object.values(refusedRoots).map(({ path }) => path()));
  for (const { path, error } of Object.values(refusedRoots)) {
    if (error === ForbiddenError) {
      expect(gateB.decisions.has(path()), `resolved denied ownership: ${path()}`).toBe(true);
      expect(gateB.decisions.get(path())).toBeNull();
    } else {
      expect(gateB.decisions.has(path()), "malformed paths never reach the ownership query").toBe(false);
    }
  }
});

afterAll(() => {
  if (projectAPath) {
    try { invalidateAwarenessCache(projectAPath); } catch { /* ok */ }
  }
  if (db) db.close();
});

// ── helpers ──

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── A. source-scan: the bridges are the single owners ──

describe("A. source-scan: awareness/quality bridges are the single owners", () => {
  test("awareness-bridge.ts exports the public awareness functions", () => {
    const src = readFileSync(join(SERVER_DIR, "awareness/awareness-bridge.ts"), "utf8");
    expect(src).toContain("export function getAwarenessSnapshot");
    expect(src).toContain("export async function getAwarenessSnapshotAsync");
    expect(src).toContain("export function invalidateAwarenessCache");
    expect(src).toContain("export function getAwarenessSummary");
  });

  test("quality-bridge.ts exports the public quality functions", () => {
    const src = readFileSync(join(SERVER_DIR, "awareness/quality-bridge.ts"), "utf8");
    expect(src).toContain("export function getQualityIndicator");
    expect(src).toContain("export async function getQualityIndicatorAsync");
  });

  test("the canonical awareness source is imported ONLY by the bridge + its worker (no route/service bypass)", () => {
    // Dynamic discovery: scan EVERY.ts file under server/ for a
    // direct VALUE import of the canonical awareness subsystem. The allowed
    // importers are the bridge + its off-thread worker entry point(s) —
    // recognized DYNAMICALLY by the delegation naming convention
    // (`*-bridge.ts` / `*-worker.ts`), NOT a hardcoded 2-name set. A new
    // worker added for off-thread awareness work is auto-allowed (its
    // `-worker.ts` name is the explicit grant); a route/service that imports
    // the canonical source directly (bypassing the bridge) is auto-caught.
    const isDelegation = (rel: string): boolean =>
      /-bridge\.ts$/.test(rel) || /-worker\.ts$/.test(rel);
    const offenders: string[] = [];
    for (const file of walkTs(SERVER_DIR)) {
      const rel = relative(SERVER_DIR, file).split(sep).join("/");
      const src = readFileSync(file, "utf8");
      // A VALUE reference to the canonical awareness subsystem (not a
      // type-only one). `import type {... }` is allowed (erased at runtime);
      // a value `import { createAwarenessEngine }` is a bypass — and so are
      // `import * as`, `await import(...)` and `export * from`, which the
      // brace-list regex this replaced could not see. Verified by mutation:
      // a route reaching the engine by namespace import left this green.
      if (valueReferencesModule(src, CANONICAL_AWARENESS_PREFIX) && !isDelegation(rel)) {
        offenders.push(rel);
      }
    }
    expect(offenders, `non-bridge files must not import the canonical awareness subsystem as a value: ${offenders.join(", ")}`).toEqual([]);
  });

  test("the canonical quality source is NOT imported by ANY server file (the quality bridge derives its own score)", () => {
    // The full quality aggregator (integration/src/quality/*) requires
    // tree-sitter WASM, not available in the web UI server. The quality
    // bridge derives its own score from the awareness engine's signals
    // (computeScore). No server file should import the canonical quality
    // subsystem — not even the bridge. A value OR type import is a bypass
    // (the quality bridge is the single owner; the canonical source is a
    // parallel path that bypasses the bridge's fs-gate + scoring model).
    const offenders: string[] = [];
    for (const file of walkTs(SERVER_DIR)) {
      const rel = relative(SERVER_DIR, file).split(sep).join("/");
      const src = readFileSync(file, "utf8");
      // ANY reference (value or type) to the canonical quality subsystem.
      if (referencesModule(src, CANONICAL_QUALITY_PREFIX)) {
        offenders.push(rel);
      }
    }
    expect(offenders, `no server file may import the canonical quality subsystem (the quality bridge is the single owner): ${offenders.join(", ")}`).toEqual([]);
  });

  test("canonical.ts does NOT re-export awareness/quality VALUE forms (deny-by-default — only types)", () => {
    // Mirrors the fix for intelligence: re-exporting the value forms
    // (createAwarenessEngine, configureAwareness, scoreQuality) from
    // canonical.ts would expose a parallel import path that bypasses the
    // bridges' fs-gate + worker choke points. Only TYPE re-exports are
    // allowed (consumed by the bridge + auto-check-runner for type-only
    // imports). The quality VALUE form (`scoreQuality`) has NO web-UI
    // consumer — the bridge derives its own score — so it is removed
    // entirely (value + type).
    const src = readFileSync(join(SERVER_DIR, "kernel/canonical.ts"), "utf8");
    // A value re-export of the canonical awareness/quality source.
    const valueReExportRe = /export\s+(?!type\b)\{[^}]*\}\s*from\s*["'][^"']*(?:awareness\/(?:engine|config)|quality\/scoring)\.ts["']/;
    expect(
      src,
      "canonical.ts must NOT re-export awareness/quality VALUE forms — the bridges are the single owners (deny-by-default)",
    ).not.toMatch(valueReExportRe);
    // The awareness TYPE re-export IS present (consumed by the bridge +
    // auto-check-runner for type-only imports). The quality TYPE re-export
    // is removed (no consumer — the bridge uses its own QualityIndicator).
    expect(src).toMatch(/export type \{ AwarenessSnapshot \}/);
    // scoreQuality + its types are NOT RE-EXPORTED (dead code + bypass).
    // Check the actual re-export statement (the comment may mention the
    // name to document WHY it is not re-exported — that is allowed).
    expect(src).not.toMatch(/export\s+\{[^}]*\bscoreQuality\b[^}]*\}\s*from/);
    expect(src).not.toMatch(/export\s+type\s+\{[^}]*\bQualityScore\b[^}]*\}\s*from/);
    expect(src).not.toMatch(/export\s+type\s+\{[^}]*\bCategoryScore\b[^}]*\}\s*from/);
    expect(src).not.toMatch(/export\s+type\s+\{[^}]*\bCategoryId\b[^}]*\}\s*from/);
    // The awareness VALUE forms are NOT RE-EXPORTED (the worker imports
    // them directly from the canonical source, not through this hub).
    expect(src).not.toMatch(/export\s+\{[^}]*\bcreateAwarenessEngine\b[^}]*\}\s*from/);
    expect(src).not.toMatch(/export\s+\{[^}]*\bconfigureAwareness\b[^}]*\}\s*from/);
  });
});

// ── B. single-owner: bridge functions defined ONLY in their bridges ──

describe("B. single-owner: bridge functions defined ONLY in awareness-bridge.ts / quality-bridge.ts", () => {
  // Dynamic discovery: scan ALL.ts files in server/ + routes/.
  const SERVER_FILES: string[] = walkTs(SERVER_DIR).map((f) => relative(SERVER_DIR, f).split(sep).join("/"));

  // Dynamic discovery: parse EVERY exported function name from
  // each bridge source — NEVER hardcode the list. A new bridge function is
  // automatically checked (the old hardcoded lists would silently miss a
  // new export).
  const AWARENESS_SRC = readFileSync(join(SERVER_DIR, "awareness/awareness-bridge.ts"), "utf8");
  const AWARENESS_FUNCTIONS = [...AWARENESS_SRC.matchAll(/^export (?:async )?function (\w+)\b/gm)].map((m) => m[1]!);
  const QUALITY_SRC = readFileSync(join(SERVER_DIR, "awareness/quality-bridge.ts"), "utf8");
  const QUALITY_FUNCTIONS = [...QUALITY_SRC.matchAll(/^export (?:async )?function (\w+)\b/gm)].map((m) => m[1]!);

  for (const fn of AWARENESS_FUNCTIONS) {
    test(`${fn} is defined ONLY in awareness-bridge.ts`, () => {
      const definers: string[] = [];
      for (const f of SERVER_FILES) {
        const src = readFileSync(join(SERVER_DIR, f), "utf8");
        const re = new RegExp(`export (?:async )?function ${fn}\\b`);
        if (re.test(src)) definers.push(f);
      }
      expect(definers, `${fn} must be defined ONLY in awareness-bridge.ts (no scattered awareness helpers)`).toEqual(["awareness/awareness-bridge.ts"]);
    });
  }

  for (const fn of QUALITY_FUNCTIONS) {
    test(`${fn} is defined ONLY in quality-bridge.ts`, () => {
      const definers: string[] = [];
      for (const f of SERVER_FILES) {
        const src = readFileSync(join(SERVER_DIR, f), "utf8");
        const re = new RegExp(`export (?:async )?function ${fn}\\b`);
        if (re.test(src)) definers.push(f);
      }
      expect(definers, `${fn} must be defined ONLY in quality-bridge.ts (no scattered quality helpers)`).toEqual(["awareness/quality-bridge.ts"]);
    });
  }
});

// ── C. bridge uses fs-gate ──

describe("C. awareness bridge uses fs-gate (ownership gate at the choke point)", () => {
  test("awareness-bridge.ts imports assertProjectPathOwnership from fs-gate", () => {
    const src = readFileSync(join(SERVER_DIR, "awareness/awareness-bridge.ts"), "utf8");
    expect(src).toContain("../filesystem/fs-gate.ts");
    expect(src).toContain("assertProjectPathOwnership");
    expect(src).toContain("FsGate");
  });

  test("quality-bridge.ts imports assertProjectPathOwnership from fs-gate", () => {
    const src = readFileSync(join(SERVER_DIR, "awareness/quality-bridge.ts"), "utf8");
    expect(src).toContain("../filesystem/fs-gate.ts");
    expect(src).toContain("assertProjectPathOwnership");
    expect(src).toContain("FsGate");
  });

  test("every public awareness bridge function that takes a projectPath enforces the ownership gate (directly or via delegation)", () => {
    // Dynamic discovery: parse the bridge's exported functions
    // that take a `projectPath` parameter + an optional `gate?`. Each MUST
    // call `assertProjectPathOwnership(projectPath, gate)` directly OR
    // delegate to another bridge function that does (e.g. getAwarenessSummary
    // delegates to getAwarenessSnapshot with the gate). A new bridge function
    // that takes a project path but forgets the gate is auto-caught.
    const src = readFileSync(join(SERVER_DIR, "awareness/awareness-bridge.ts"), "utf8");
    const checked = gateTakingFunctions(src, "awareness/awareness-bridge.ts");
    for (const [name, body] of checked) {
      // The function must EITHER call assertProjectPathOwnership directly
      // OR delegate to another bridge function with the gate forwarded
      // (e.g. `getAwarenessSnapshot(projectPath, gate)`).
      const directGate = bodyCallsWith(body, "assertProjectPathOwnership", ["projectPath", "gate"]);
      const delegatedGate = AWARENESS_DELEGATES.some((to) => bodyCallsWith(body, to, ["projectPath", "gate"]));
      expect(
        directGate || delegatedGate,
        `${name} must call assertProjectPathOwnership(projectPath, gate) OR delegate to a bridge function with the gate forwarded`,
      ).toBe(true);
    }
    expect(checked.length, `public project-scoped awareness functions checked: ${checked.length}`).toBeGreaterThan(0);
  });

  test("every public quality bridge function that takes a projectPath calls assertProjectPathOwnership (the co-owner gate)", () => {
    // The quality bridge is a co-owner: it verifies ownership itself (the
    // gate runs FIRST, before the downstream awareness + intelligence
    // calls). The downstream calls omit the gate BY DESIGN (server-verified
    // path — the quality bridge already verified ownership). This test
    // pins the co-owner pattern: the quality bridge MUST call
    // assertProjectPathOwnership directly (not rely on the downstream
    // bridges to enforce it).
    const src = readFileSync(join(SERVER_DIR, "awareness/quality-bridge.ts"), "utf8");
    const checked = gateTakingFunctions(src, "awareness/quality-bridge.ts");
    for (const [name, body] of checked) {
      expect(
        bodyCallsWith(body, "assertProjectPathOwnership", ["projectPath", "gate"]),
        `${name} must call assertProjectPathOwnership(projectPath, gate) (the co-owner gate runs FIRST)`,
      ).toBe(true);
    }
    expect(checked.length, `public project-scoped quality functions checked: ${checked.length}`).toBeGreaterThan(0);
  });

  test("buildSnapshotInWorker does NOT set a pending entry (the pool owns the in-flight state)", () => {
    // The pending-entry dedup was moved from each bridge INTO the worker
    // pool (the lowest level). The pool sets the in-flight entry BEFORE
    // spawning, so the bridge no longer needs to manually set a pending
    // cache entry. The bridge cache holds ONLY "ready" entries. The
    // bridge uses `getInFlightWorker` for the sync path. This test pins
    // that the bridge does NOT have a pending entry (the RIGID pattern
    // is gone — the pool handles dedup so a new bridge can't forget).
    const src = readFileSync(join(SERVER_DIR, "awareness/awareness-bridge.ts"), "utf8");
    expect(src, "buildSnapshotInWorker must NOT set a pending snapshotCache entry (the pool owns the in-flight state)").not.toMatch(/snapshotCache\.set\(projectPath,\s*\{\s*status:\s*"pending"/);
    expect(src, "awareness-bridge must use getInFlightWorker for the sync path (pool-owned dedup)").toContain("getInFlightWorker");
  });
});

// ── D. behavioral: the bridge enforces the gate FIRST ──

describe("D. behavioral: gate-first + cross-user deny-by-default", () => {
  describe.each(Object.entries(refusedRoots))("%s root", (_name, { path, error, code }) => {
    test("getAwarenessSnapshot refuses before filesystem admission or cache lookup", () => {
      const invoke = () => getAwarenessSnapshot(path(), gateB);
      expect(invoke).toThrow(error);
      expect(invoke).toThrow(expect.objectContaining({ code }));
    });

    test("getAwarenessSnapshotAsync refuses before filesystem admission or worker dispatch", async () => {
      const result = getAwarenessSnapshotAsync(path(), gateB);
      await expect(result).rejects.toThrow(error);
      await expect(result).rejects.toMatchObject({ code });
    });

    test("getAwarenessSummary preserves the delegated refusal", () => {
      const invoke = () => getAwarenessSummary(path(), gateB);
      expect(invoke).toThrow(error);
      expect(invoke).toThrow(expect.objectContaining({ code }));
    });

    test("invalidateAwarenessCache refuses before changing cached state", () => {
      const invoke = () => invalidateAwarenessCache(path(), gateB);
      expect(invoke).toThrow(error);
      expect(invoke).toThrow(expect.objectContaining({ code }));
    });

    test("getQualityIndicator refuses before calling downstream bridges", () => {
      const invoke = () => getQualityIndicator(path(), gateB);
      expect(invoke).toThrow(error);
      expect(invoke).toThrow(expect.objectContaining({ code }));
    });

    test("getQualityIndicatorAsync refuses before calling downstream bridges", async () => {
      const result = getQualityIndicatorAsync(path(), gateB);
      await expect(result).rejects.toThrow(error);
      await expect(result).rejects.toMatchObject({ code });
    });
  });

  test("a not-ready snapshot throws AwarenessNotReadyError (not a bare Error) when the gate is absent + path is server-verified", () => {
    // A path no caller owns (not in the DB) with NO gate: the bridge trusts
    // the path (server-verified exception) + tries the cache →
    // AwarenessNotReadyError (typed, retryable) on a fresh path. Confirms
    // the typed-error contract + that the gate is OPT-IN (a server-verified
    // caller may omit it).
    const freshPath = join(tmpRoot, "never-indexed");
    mkdirSync(freshPath, { recursive: true });
    expect(() => getAwarenessSnapshot(freshPath)).toThrow(AwarenessNotReadyError);
  });
});

// ── E. route-level: routes import from the bridges + pass the gate ──

describe("E. route-level: routes go through the bridges + gate", () => {
  test("routes/awareness.ts imports awareness ops from the bridge, NOT the canonical source", () => {
    const src = readFileSync(join(ROUTES_DIR, "awareness.ts"), "utf8");
    expect(src).toContain("../awareness/awareness-bridge.ts");
    // No direct import of the canonical awareness subsystem.
    expect(src).not.toMatch(new RegExp(`from\\s*["'][^"']*${escapeRegex(CANONICAL_AWARENESS_PREFIX)}`));
  });

  test("routes/quality.ts imports quality ops from the bridge, NOT the canonical source", () => {
    const src = readFileSync(join(ROUTES_DIR, "quality.ts"), "utf8");
    expect(src).toContain("../awareness/quality-bridge.ts");
    // No direct import of the canonical quality subsystem.
    expect(src).not.toMatch(new RegExp(`from\\s*["'][^"']*${escapeRegex(CANONICAL_QUALITY_PREFIX)}`));
  });

  test("routes/awareness.ts constructs the gate via makeFsGate + requireUserContext", () => {
    const src = readFileSync(join(ROUTES_DIR, "awareness.ts"), "utf8");
    expect(src).toContain("requireUserContext");
    expect(src).toContain("makeFsGate");
    expect(src).toContain("fs-gate.ts");
  });

  test("routes/quality.ts constructs the gate via makeFsGate + requireUserContext", () => {
    const src = readFileSync(join(ROUTES_DIR, "quality.ts"), "utf8");
    expect(src).toContain("requireUserContext");
    expect(src).toContain("makeFsGate");
    expect(src).toContain("fs-gate.ts");
  });

  test("routes/awareness.ts passes the gate to every bridge call (not just constructs it)", () => {
    // Dynamic discovery: every call to a bridge function in the
    // route must pass `gate` as the last arg. A bridge call that forgets
    // the gate (e.g. `getAwarenessSummary(projectPath)`) is a bypass — the
    // route would not enforce ownership. We parse the NAMED IMPORTS from
    // the bridge (not a hardcoded list) so a newly-imported bridge function
    // is automatically checked.
    const src = readFileSync(join(ROUTES_DIR, "awareness.ts"), "utf8");
    const importBlockRe = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*awareness-bridge\.ts["']/s;
    const importMatch = importBlockRe.exec(src);
    expect(importMatch, "routes/awareness.ts must import from awareness-bridge.ts").not.toBeNull();
    const bridgeCalls = importMatch![1]!
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
      .filter((s) => s.length > 0);
    for (const fn of bridgeCalls) {
      const callRe = new RegExp(`\\b${fn}\\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(src)) !== null) {
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

  test("routes/quality.ts passes the gate to every bridge call", () => {
    // Dynamic discovery: parse the named imports from the
    // quality bridge (not a hardcoded list).
    const src = readFileSync(join(ROUTES_DIR, "quality.ts"), "utf8");
    const importBlockRe = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*quality-bridge\.ts["']/s;
    const importMatch = importBlockRe.exec(src);
    expect(importMatch, "routes/quality.ts must import from quality-bridge.ts").not.toBeNull();
    const bridgeCalls = importMatch![1]!
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
      .filter((s) => s.length > 0);
    for (const fn of bridgeCalls) {
      const callRe = new RegExp(`\\b${fn}\\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(src)) !== null) {
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

// ── F. config: quality scoring weights are config-owned ──

describe("F. config: quality scoring weights are config-owned (no scattered literals)", () => {
  test("getQualityConfig is defined ONLY in harness-config.ts", () => {
    const files = walkTs(SERVER_DIR).map((f) => relative(SERVER_DIR, f).split(sep).join("/"));
    const definers: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(SERVER_DIR, f), "utf8");
      if (/export function getQualityConfig\b/.test(src)) definers.push(f);
    }
    expect(definers, "getQualityConfig must be defined ONLY in harness-config.ts (single owner)").toEqual(["kernel/harness-config.ts"]);
  });

  test("the quality bridge reads weights via getQualityConfig (no inline magic-number redeclare of the config weights)", () => {
    const bridge = readFileSync(join(SERVER_DIR, "awareness/quality-bridge.ts"), "utf8");
    expect(bridge).toContain("getQualityConfig");
    // The config-driven weights must NOT be redeclared as inline constants
    // in the bridge (the config owner is the single source of truth). The
    // grade boundaries (GRADE_A_MIN etc.) are display semantics, NOT weights
    // — they are allowed as named constants (the comment in the bridge
    // documents this). The penalty weights (scoreMax, penaltyCapIssuesPerKloc,
    // penaltyWeightIssuesPerKloc, etc.) must NOT be redeclared.
    expect(bridge).not.toMatch(/\bconst\s+scoreMax\s*=/);
    expect(bridge).not.toMatch(/\bconst\s+penaltyCapIssuesPerKloc\s*=/);
    expect(bridge).not.toMatch(/\bconst\s+penaltyWeightIssuesPerKloc\s*=/);
    expect(bridge).not.toMatch(/\bconst\s+penaltyCapHotspots\s*=/);
    expect(bridge).not.toMatch(/\bconst\s+penaltyWeightHotspots\s*=/);
    expect(bridge).not.toMatch(/\bconst\s+penaltyCapClones\s*=/);
    expect(bridge).not.toMatch(/\bconst\s+penaltyWeightClones\s*=/);
    expect(bridge).not.toMatch(/\bconst\s+penaltyCapUntyped\s*=/);
    expect(bridge).not.toMatch(/\bconst\s+penaltyWeightUntyped\s*=/);
    expect(bridge).not.toMatch(/\bconst\s+penaltyCapIssueDensity\s*=/);
    expect(bridge).not.toMatch(/\bconst\s+penaltyWeightIssueDensity\s*=/);
  });
});

// ── G. runner bypass: auto-check-runner + run.ts call the bridge BY DESIGN ──

describe("G. runner bypass: server-verified paths omit the gate BY DESIGN", () => {
  test("auto-check-runner.ts imports the quality bridge (NOT the canonical quality source)", () => {
    // The runner is called by blocks/checks.ts with `project.path` from
    // `db.getProject(projectId, user.userId)` — a user-scoped DB read (the
    // authoritative binding point). The test verifies the runner imports from
    // the bridge (not the canonical source — that would be a bypass).
     const src = readFileSync(join(SERVER_DIR, "awareness/auto-check-runner.ts"), "utf8");
     expect(src).toContain("./quality-bridge.ts");
    expect(src).not.toMatch(new RegExp(`from\\s*["'][^"']*${escapeRegex(CANONICAL_QUALITY_PREFIX)}`));
    // THE RUNNER NOW FORWARDS THE GATE, and this assertion is inverted
    // deliberately rather than deleted. It used to pin the opposite —
    // "getQualityIndicatorAsync(projectPath)", the runner omitting the gate BY
    // DESIGN — which was defensible only while the runner sat one directory
    // outside the call-site guard's universe. Once that universe became the
    // call graph, this was the same ungated call the run route had already
    // fixed, in the same shape, and "by design" was doing the work an
    // unreachable scan should have been doing.
    expect(
      bodyCallsWith(functionBody(src, "runLint", "auto-check-runner.ts runLint"), "getQualityIndicatorAsync", ["projectPath", "ownershipGate"]),
      "the runner must FORWARD the ownership gate to the bridge — an omitted optional gate is an unchecked call that looks identical to a checked one",
    ).toBe(true);
    expect(
      bodyCallsWith(functionBody(src, "runAutoCheck", "auto-check-runner.ts runAutoCheck"), "runLint", ["projectPath", "ownershipGate"]),
      "…and the entry point must thread it through rather than dropping it",
    ).toBe(true);
  });

  test("the run path imports the quality bridge (NOT the canonical quality source)", () => {
    const src = runPathSource();
    // The MODULE, not the relative prefix. The executor sits one directory up
    // from the routes, so the same dependency is spelled "./quality-bridge.ts"
    // there. A guard keyed to the number of dots measures where a file lives,
    // not what it depends on.
    expect(src).toContain("awareness/quality-bridge.ts");
    expect(src).not.toMatch(new RegExp(`from\\s*["'][^"']*${escapeRegex(CANONICAL_QUALITY_PREFIX)}`));
  });

  test("routes/run.ts verifies project ownership via db.getProject(id, userId) BEFORE binding active.projectPath (the authoritative binding point)", () => {
    // The run route resolves `project` via `db.getProject(input.projectId,
    // user.userId)` (a user-scoped DB read — null → 403 for non-owners),
    // then binds `active.projectPath = project.path`. The downstream
    // quality call (`getQualityIndicatorAsync(active.projectPath)`) omits
    // the gate BECAUSE the path is server-verified at this authoritative
    // binding point. The test pins the ownership probe.
    const src = readFileSync(join(ROUTES_DIR, "run.ts"), "utf8");
    expect(src).toMatch(/db\.getProject\(input\.projectId,\s*user\.userId\)/);
    expect(src).toMatch(/projectPath:\s*project\.path/);
  });

  test("routes/auto-checks.ts verifies project ownership via db.getProject(id, userId) BEFORE calling runAutoCheck", () => {
    // The auto-checks route resolves `project` via `db.getProject(projectId,
    // user.userId)` (null → 404), then calls `runAutoCheck(name,
    // project.path)`. The runner omits the gate BECAUSE the path is
    // server-verified at this authoritative binding point.
    const src = readFileSync(join(ROUTES_DIR, "auto-checks.ts"), "utf8");
    expect(src).toMatch(/db\.getProject\(projectId,\s*user\.userId\)/);
    expect(src).toMatch(/runAutoCheck\(input\.checkName,\s*project\.path\)/);
  });
});
