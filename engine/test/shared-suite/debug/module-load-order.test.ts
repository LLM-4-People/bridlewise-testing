import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execPath } from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readSourceView } from "../../../scripts/verification/source-view.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { walk } from "../../../scripts/verification/source-walk.ts";

/**
 * ⚠ EVERY MODULE IN THE DEBUG AND PRIVACY SUBTREES MUST LOAD AS AN ESM ENTRY
 * POINT, AND THE PREDICATE FOR "IT DID NOT" IS NOT THE EXIT CODE.
 *
 * ── The defect this exists to make impossible ────────────────────────────
 *
 * A module that does work at MODULE SCOPE reading an IMPORTED binding makes its
 * own evaluation order load-bearing. Inside an import cycle, whichever module
 * evaluates second throws
 * `ReferenceError: Cannot access '…' before initialization` — a TDZ break, at
 * load, with nothing between the user and a dead security control.
 *
 * DRIVEN, at the parent commit, with no wiring of any kind:
 * `import("src/shared/debug/debug-config.ts")` threw
 * `Cannot access 'DEBUG_CONFIG_DEFAULTS' before initialization` on the cycle
 * `debug-config → integrity → errors → debug-system → debug-config`. It was the
 * ONLY module in 514 under `src/` whose load threw, and the module-scope read
 * that caused it was `debug-system.ts`'s `NO_OP_SYSTEM` — the file whose sibling
 * comment called this "a pre-existing break that has nothing to do with this
 * module". It was the identical defect class, in the same subtree.
 *
 * ── WHY THE PREDICATE IS THE INTERESTING PART ────────────────────────────
 *
 * The obvious sweep asks whether the child process exited non-zero. MEASURED:
 * every one of the eight TDZ breaks findable in this tree EXITS 0 when the
 * import is awaited with a `catch`, so an exit-code predicate scores all eight
 * as healthy. Worse, it is systematically blind to the exact repair this class
 * calls for — deferring module-scope work moves a failure from load time to
 * first call, so a sweep that cannot see the failure cannot judge the fix.
 *
 * This asks the child to PRINT WHAT HAPPENED and reads that. A child that
 * produces neither marker is a third outcome and is also a failure — never
 * silently a pass.
 *
 * ── §36: THE INSTRUMENT IS WITNESSED IN THE SAME RUN ─────────────────────
 *
 * Two modules are PLANTED into a temp directory and driven through the same
 * function as the real ones: one with the exact TDZ shape, which must be
 * reported as THREW, and one inert, which must be reported as LOADED. A green
 * result from the real subtree means nothing without both — a scan that reports
 * "nothing threw" is indistinguishable from one pointed at the wrong place, or
 * one whose child never ran.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

/** The subtrees this guard owns. Their CONTENTS are discovered, never listed. */
const OWNED_SUBTREES = ["src/shared/debug", "src/privacy"] as const;

/**
 * ⚠ THE OWNED SUBTREES ARE NOT THE POPULATION, AND BELIEVING THEY WERE LET A
 * REAL BREAK THROUGH.
 *
 * A TDZ break in a cycle is DIRECTIONAL: it fires only when the entry point
 * reaches one side before the other. Sweeping only modules INSIDE the owned
 * subtrees always enters from the same side, so it can be 100% green while the
 * other direction is dead.
 *
 * DRIVEN. `debug-system.ts` gained an import of `src/secret-signals.ts`, which
 * closed the cycle
 *   secret-signals → integrity → errors → debug-system → secret-signals
 * and `debug-system.ts` read `SECRET_TEXT_SIGNAL_CATALOG` at module scope. Every
 * module in both owned subtrees still loaded — this guard, and a separate
 * 515-module sweep of ALL of `src/`, both reported zero failures. But entering
 * from `src/secret-signals.ts` threw `ReferenceError: Cannot access
 * 'SECRET_TEXT_SIGNAL_CATALOG' before initialization`, and all 14 tests in
 * `test/secret-signals.test.ts` STOPPED BEING ENQUEUED — the suite reported
 * `failCount: 0` over a denominator that had silently shrunk by 14.
 *
 * So the population is the owned subtrees PLUS EVERY MODULE THEY IMPORT: those
 * are exactly the modules that can be a cycle's other side. DERIVED from the
 * import edges rather than listed (§31b) — a hand-written list of cycle
 * partners would drift the moment an import is added, which is the same class
 * of defect this guard exists to catch.
 */
function importedNeighbours(modules: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const file of modules) {
    // Through the sanctioned door, and the view is `codeWithStrings()` because
    // a module specifier IS a quoted string literal: `code()` blanks quoted
    // interiors, so it would return ZERO edges and silently restore the very
    // blind spot the witness below exists to refuse. `codeWithStrings()` keeps
    // quoted interiors while blanking comments and template interiors, so a
    // specifier spelled inside a doc comment or a fixture template is prose,
    // not an import edge.
    const source = readSourceView(file).codeWithStrings();
    for (const match of source.matchAll(/from\s*["'](\.[^"']*\.ts)["']/gu)) {
      const resolved = resolve(dirname(file), match[1]!);
      if (!existsSync(resolved)) continue;
      if (modules.includes(resolved)) continue;
      out.add(resolved);
    }
  }
  return [...out].sort();
}

type LoadOutcome = Readonly<{ path: string; verdict: "loaded" | "threw" | "no-marker"; detail: string }>;

function listModules(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"] })) {
    if (!file.endsWith(".d.ts")) acc.push(file);
  }
  return acc;
}

/**
 * Import one module as an ESM ENTRY POINT in its own process — the population
 * that matters, because a module that only ever loads after its cycle partner
 * is a module whose health depends on who imported first.
 */
function loadAsEntryPoint(absolutePath: string): LoadOutcome {
  const source =
    `import(${JSON.stringify(absolutePath)})` +
    `.then(() => { process.stdout.write("HARNESS-LOAD-OK\\n"); })` +
    `.catch((e) => { process.stdout.write("HARNESS-LOAD-THREW " + (e && e.constructor ? e.constructor.name : "?") + ": " + String(e && e.message).split("\\n")[0] + "\\n"); });`;
  let out = "";
  try {
    out = execFileSync(execPath, ["--experimental-strip-types", "--no-warnings", "-e", source], {
      cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  if (out.includes("HARNESS-LOAD-OK")) return { path: absolutePath, verdict: "loaded", detail: "" };
  const threw = out.indexOf("HARNESS-LOAD-THREW ");
  if (threw >= 0) return { path: absolutePath, verdict: "threw", detail: out.slice(threw + 19).split("\n")[0] ?? "" };
  return { path: absolutePath, verdict: "no-marker", detail: out.trim().split("\n")[0] ?? "(no output)" };
}

test("module load: the instrument itself — a planted TDZ break is SEEN and an inert module is not", () => {
  const dir = createTempDir("debug-load-witness-");

  // The exact shape: a module-scope read of a binding imported from a module
  // that is mid-evaluation because it imports us back. Not a `throw` statement —
  // a scan that only catches explicit throws would pass this and miss the class.
  writeFileSync(join(dir, "cycle-a.ts"), [
    `import { LATE } from "./cycle-b.ts";`,
    `export const EARLY = { seen: LATE };`,
    ``,
  ].join("\n"));
  writeFileSync(join(dir, "cycle-b.ts"), [
    `import { EARLY } from "./cycle-a.ts";`,
    `export const LATE = "late";`,
    `export function readsEarly(): unknown { return EARLY; }`,
    ``,
  ].join("\n"));
  writeFileSync(join(dir, "inert.ts"), [
    `export function inert(): number { return 1; }`,
    ``,
  ].join("\n"));

  const planted = loadAsEntryPoint(join(dir, "cycle-b.ts"));
  const inert = loadAsEntryPoint(join(dir, "inert.ts"));

  assert.equal(planted.verdict, "threw", `witness: the planted TDZ break must be SEEN, got ${planted.verdict} ${planted.detail}`);
  assert.match(planted.detail, /before initialization/u, "witness: and seen as the TDZ it is, not as some other failure");
  assert.equal(inert.verdict, "loaded", `witness: an inert module must NOT be reported as broken, got ${inert.verdict} ${inert.detail}`);
});

test("module load: every module in the debug and privacy subtrees loads as its own entry point", () => {
  const modules = OWNED_SUBTREES.flatMap((sub) => listModules(join(REPO_ROOT, sub)));

  // §31a — containment against a SECOND instrument, never a count. `git ls-files`
  // holds the index; a walk holds the disk. A module that exists in one and not
  // the other is a hole in this guard's universe, whichever way round it is.
  const tracked = execFileSync("git", ["ls-files", "--", ...OWNED_SUBTREES], {
    cwd: REPO_ROOT, encoding: "utf8",
  })
    .split("\n")
    .filter((l) => l.endsWith(".ts") && !l.endsWith(".d.ts"))
    .map((l) => join(REPO_ROOT, l));
  const walked = new Set(modules);
  const missing = tracked.filter((t) => !walked.has(t));
  assert.deepEqual(missing, [], "every tracked module in these subtrees is in the swept universe");
  assert.ok(modules.length >= tracked.length, "the walk cannot be smaller than the index");

  // THE OTHER SIDE OF EVERY CYCLE. See `importedNeighbours`: entering only from
  // inside the owned subtrees always enters from the same side, and a TDZ break
  // is directional.
  const neighbours = importedNeighbours(modules);
  assert.ok(
    neighbours.length > 0,
    "witness: the neighbour derivation found real import edges — an empty set would silently restore the blind spot",
  );
  const population = [...modules, ...neighbours];

  const outcomes = population.map(loadAsEntryPoint);
  const broken = outcomes.filter((o) => o.verdict !== "loaded");

  // §30 — the population, its instrument and its unit, printed by the run.
  console.log(
    `[module-load] ${population.length} entry points (unit: modules; ${modules.length} from the walk of ` +
    `${OWNED_SUBTREES.join(" + ")}, ${tracked.length} tracked, plus ${neighbours.length} imported neighbours ` +
    `so both sides of every cycle are entered), verdict from a printed marker and NOT from the exit code`,
  );

  assert.deepEqual(
    broken.map((o) => `${relative(REPO_ROOT, o.path)} :: ${o.verdict} :: ${o.detail}`),
    [],
    "a module whose load throws is a security control that is dead before it is called",
  );
});

for (const entry of ["src/shared/best-effort.ts", "src/shared/debug/debug-config.ts"]) {
  test(`module first use: fixed failure reporting after ${entry} enters the cycle first`, () => {
    const source = `
      await import(${JSON.stringify(join(REPO_ROOT, entry))});
      const { bestEffort, bestEffortAsync } = await import(${JSON.stringify(join(REPO_ROOT, "src/shared/best-effort.ts"))});
      const debug = await import(${JSON.stringify(join(REPO_ROOT, "src/shared/debug/debug-system.ts"))});
      const { DEBUG_CONFIG_DEFAULTS } = await import(${JSON.stringify(join(REPO_ROOT, "src/shared/debug/debug-config.ts"))});
      bestEffort(() => { throw "fixture-secret"; });
      const sink = debug.createCollectingSink();
      debug.configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { enabledSinks: ["collecting"] } }, [sink]);
      await bestEffortAsync(async () => { throw "fixture-secret"; });
      if (sink.events.length !== 1 || sink.events[0].code !== "best_effort_failed" || sink.events[0].source !== null) throw new Error("first use did not report");
      process.stdout.write("HARNESS-FIRST-USE-OK\\n");
    `;
    const child = spawnSync(execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", source], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "HARNESS-FIRST-USE-OK\n");
    assert.equal(child.stderr, "[debug] diagnostic unavailable\n");
  });
}
