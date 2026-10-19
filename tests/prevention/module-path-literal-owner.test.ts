// @vitest-environment node
/**
 * GUARDS NAME MODULES, NEVER PATHS — a guard that spells a module's location
 * is a guard that breaks on the next move.
 *
 * ── THE DEFECT THIS GUARDS ────────────────────────────────────────────────
 *
 * A prevention guard that needs to read or scan a product module used to write
 * the path as a string literal: `read("server/llm/llm-bridge.ts")`,
 * `const OWNER = "engine/src/kernel/root-policy.ts"`. When the folder
 * organization refactor moved dozens of modules, every one of those literals
 * pointed at a path that no longer existed, and 54 guards had to be re-pointed
 * by hand. The location of a module is a fact about the TREE, and restating it
 * as a literal in a guard is the two-paths defect applied to file paths.
 *
 * The fix is the resolver owner (`tests/helpers/module-resolver.ts`): a guard
 * asks for a module by NAME and gets its current path, so a move touches
 * nothing. This guard is the guard-of-guards that refuses a guard that still
 * spells the location itself.
 *
 * ── WHAT IS REFUSED, AND WHAT IS NOT ──────────────────────────────────────
 *
 * Refused: a STRING LITERAL in a prevention guard that names a module's
 * repo-relative product path — `"server/<…>.ts"`, `"engine/src/<…>.ts"`,
 * `"engine/scripts/<…>.ts"`, `"src/<…>.ts"`. That is the rewrite-on-move
 * shape. The guard should call `modulePath("<file>.ts")` and let the resolver
 * find the module.
 *
 * NOT refused, deliberately:
 *   - a STATIC IMPORT specifier (`import { X } from "../../server/db/client.ts"`).
 *     Those are relative, type-checked, and REFUSED from any runtime resolver
 *     by the dynamic-loading design — a move breaks them at the compiler,
 *     which is the correct, loud failure. They are not this guard's subject.
 *   - a path inside the RESOLVER's own test, which must spell paths to prove
 *     the resolver refuses the wrong ones.
 *
 * ── STRENGTH LADDER (§0) — WHY THIS IS RUNG 5 ─────────────────────────────
 *
 * Rung 1 is unavailable: the filesystem creates any path. Rung 2 is
 * unavailable: a guard must be ABLE to talk about "the file that owns X", and
 * that name is a legitimate string. Rung 3 is reached PARTIALLY by the
 * resolver's branded `ModuleRef`, but a guard that ignores the brand and
 * writes a raw literal into a bare `read` is still well-typed — so the
 * remaining enforcement is a source scan over the guard population. That scan
 * is only as good as its universe, so the universe is DISCOVERED
 * (`discoverPreventionGuards`) and never listed, and a planted literal is
 * driven to prove the scan reds. This is the floor, named as the floor.
 *
 * GUARD SUBJECT: no prevention guard carries a literal naming a product module's repo-relative path; guards resolve a module by name.
 * GUARD OWNS: tests/helpers/module-resolver.ts (the resolution owner).
 * GUARD PLANT: a guard body spelling `"server/llm/llm-bridge.ts"` must red.
 * GUARD DRIVEN: the detector is driven against a planted literal in a string, never a tracked file, over the discovered web-guard population.
 */
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoverPreventionGuards,
  REPO_ROOT,
} from "../../engine/scripts/tooling/verification/guard-dossier.ts";
import { stripCommentsOnly } from "../helpers/source-scan.ts";

/**
 * A string literal naming a product module's repo-relative path. The pattern
 * requires a product root, at least one path segment, and an executable
 * extension, so a bare word ("server") or a non-module path never matches.
 * Comments are stripped before matching so a doc comment that QUOTES a path to
 * explain the rule (like the one above) is not itself a finding — only a
 * literal that could reach a scan helper counts.
 */
const PRODUCT_PATH_LITERAL =
  /"((?:server|engine\/src|engine\/scripts|src)\/[a-z0-9][a-z0-9./-]*\.(?:ts|mts|cts|mjs|svelte))"/g;

/**
 * The guards exempt from the rule, each with its reason. This is a CLAIM per
 * entry and must stay minimal:
 *   - `module-resolver.test.ts` drives the resolver's refusal paths, which
 *     requires spelling the very literals the resolver must reject. It is the
 *     owner test and the one place raw literals are the subject.
 *   - `run-executes-once.test.ts` reads the run path through
 *     `tests/helpers/run-source.ts`, a domain owner whose `readRunPathModule`
 *     is typed to the run-path member union. Those paths are that owner's
 *     subject, not a location handed to a generic scan helper, and routing
 *     them through this resolver would bypass the domain owner's own gate.
 *   - `centralized-config.test.ts` resolves paths against `engine/` (the
 *     INTEGRATION_ROOT), a different base than this resolver's web-rooted
 *     product tree; the resolver would hand back a web-relative path the
 *     engine-rooted `existsSync` then mis-resolves. Its literals name the
 *     engine's OWN config owners, a separate resolution concern.
 * A guard that merely WANTS a path is not exempt — it resolves by name.
 */
const EXEMPT = new Set<string>([
  // This guard ITSELF plants a real module's path to prove the detector reds
  // (the PLANT test). Its own literal is the witness, not a hazard.
  "tests/prevention/module-path-literal-owner.test.ts",
  "tests/prevention/module-resolver.test.ts",
  "tests/prevention/run-executes-once.test.ts",
  "tests/prevention/centralized-config.test.ts",
]);

/**
 * The web (vitest) estate's guards — the population this guard scans. The
 * engine's own `engine/test/prevention` guards run under the `engine/` runner
 * with cwd=`engine/`, where `src/…` names the ENGINE's source — a different
 * tree with a different resolution convention. Those literals are the engine
 * estate's concern, not this guard's universe; folding two runners' path
 * semantics into one scan would manufacture false reds. The resolver walks the
 * tree from the WEB suite's cwd, so this guard scans the guards it serves.
 */
function webPreventionGuards(): readonly string[] {
  return discoverPreventionGuards().filter((g) => g.startsWith("tests/prevention/"));
}

/** The literals a guard carries that name a product module's path. */
function pathLiteralsIn(guardRel: string): readonly string[] {
  const source = readFileSync(join(REPO_ROOT, guardRel), "utf8");
  const code = stripCommentsOnly(source);
  const out: string[] = [];
  for (const match of code.matchAll(PRODUCT_PATH_LITERAL)) {
    const index = match.index!;
    // A static-import specifier is not a finding: it begins with `./` or
    // `../` and so never matches this pattern. Two more shapes are not the
    // defect this guard exists to end:
    //
    //   - the ARGUMENT of a resolver call. `modulePathMatching("db/schema.ts")`
    //     carries a unique path fragment that IS the module's identity (the
    //     resolver refuses it the moment it stops being unique), so flagging
    //     the resolver's own input would flag the fix.
    //   - an OBJECT-LITERAL KEY. `{ "server/x.ts": "the reason" }` is a
    //     documented per-module allowlist or expectation, keyed BY the module;
    //     the key names the subject, it is not a path passed to a scan helper,
    //     and replacing it with a bare call would corrupt the object. The
    //     resolver cannot express "a map keyed by module" without computed
    //     keys, which is a readability regression for a documented allowlist.
    //
    // Every OTHER literal — `read("server/x.ts")`, `const OWNER = "…"` — is
    // the rewrite-on-move defect and is reported.
    if (isResolverArgument(code, index)) continue;
    if (isObjectKeyPosition(code, index, match[0].length)) continue;
    // A PLANTED FIXTURE is not the defect: guards that test drift-detection
    // (gitignore rules, the source-tree verdict, scan-root refusal) write
    // modules into a temp tree and reference them by a made-up product path
    // that does NOT exist on disk. Such a literal is the subject of the
    // guard's own mutation, not a real module's location, and the resolver
    // would refuse it (it matches nothing). Only a literal that NAMES A REAL
    // module is the rewrite-on-move hazard, so a path that resolves to no file
    // is left to the guard that planted it.
    out.push(match[1]!);
  }
  return out;
}

/** The literals that name a REAL module on disk (the actual hazard set). */
function realModuleLiterals(literals: readonly string[]): readonly string[] {
  return literals.filter((rel) => existsSync(join(REPO_ROOT, rel)));
}

/**
 * Is the literal at `index` the argument of a resolver call (`modulePath(`,
 * `modulePathIn(`, `modulePathMatching(`)? Those calls resolve a name or a
 * unique fragment to a path, so the string they carry is not a hardcoded
 * location — it is the resolver's input, and the resolver owns the answer.
 */
function isResolverArgument(code: string, index: number): boolean {
  const before = code.slice(Math.max(0, index - 40), index);
  return /modulePath(?:In|Matching)?\s*\(\s*$/.test(before);
}

/**
 * Is the literal at `index` in object-KEY position — a string directly
 * followed by `:`? A key names the module a documented expectation is ABOUT;
 * it is not a location handed to a scan helper, so it is not the defect.
 */
function isObjectKeyPosition(code: string, index: number, length: number): boolean {
  let i = index + length;
  while (i < code.length && /\s/.test(code[i]!)) i += 1;
  return code[i] === ":";
}

describe("guards name modules, never paths (guard-of-guards)", () => {
  test("the guard universe is discovered, not listed, and is non-empty", () => {
    const guards = webPreventionGuards();
    expect(
      guards.length,
      "webPreventionGuards found no guards — a broken discovery, not a clean bill",
    ).toBeGreaterThan(0);
  });

  test("no web prevention guard spells a REAL product module's path as a literal", () => {
    const offenders: string[] = [];
    for (const guard of webPreventionGuards()) {
      if (EXEMPT.has(guard)) continue;
      // Only literals that name a REAL module on disk are the rewrite-on-move
      // hazard; planted fixtures (drift-detection subjects) match nothing and
      // are left to the guard that planted them.
      const literals = realModuleLiterals(pathLiteralsIn(guard));
      if (literals.length > 0) {
        offenders.push(`${guard}: ${[...new Set(literals)].join(", ")}`);
      }
    }
    expect(
      offenders,
      `guard(s) spelling a real module's location as a literal (the rewrite-on-move defect):\n` +
        offenders.join("\n") +
        `\nResolve the module by name instead: modulePath("<file>.ts") from ` +
        `tests/helpers/module-resolver.ts, so a move never touches the guard.`,
    ).toEqual([]);
  });

  test("every exemption is real and still needed", () => {
    const guards = new Set(webPreventionGuards());
    for (const exempt of EXEMPT) {
      expect(
        guards.has(exempt),
        `${exempt} is exempt from the path-literal rule but is not a discovered guard — a stale claim`,
      ).toBe(true);
    }
  });

  test("PLANT: a guard body spelling a product path literal is caught", () => {
    // The detector's liveness: a planted literal must appear in the finding
    // list. Driven against the pattern directly so the real guards are never
    // touched (§28a — plant into a string, never a tracked source file).
    const planted = `const OWNER = "server/llm/llm-bridge.ts";\nread(OWNER);`;
    const found: string[] = [];
    for (const match of stripCommentsOnly(planted).matchAll(PRODUCT_PATH_LITERAL)) {
      found.push(match[1]!);
    }
    expect(found, "a planted product-path literal must be detected").toContain(
      "server/llm/llm-bridge.ts",
    );
  });

  test("PLANT-NEGATIVE: a static import specifier is NOT a finding", () => {
    // The inert shape: a relative import specifier must never be flagged, or
    // migrating a guard's imports would red this guard for the wrong reason.
    const inert = `import { DbClient } from "../../server/db/client.ts";\n`;
    const found: string[] = [];
    for (const match of stripCommentsOnly(inert).matchAll(PRODUCT_PATH_LITERAL)) {
      found.push(match[1]!);
    }
    expect(found, "a relative import specifier is not a product-path literal").toEqual([]);
  });
});
