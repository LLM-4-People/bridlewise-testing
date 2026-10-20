// @vitest-environment node
/**
 * Mechanical enforcement: test naming + directory structure (test quality).
 *
 * A test that tests the tests. Verifies the test suite's own conventions
 * so they cannot silently rot:
 *   1. SUFFIX: every test file under tests/ ends in `.test.ts` (vitest) or
 *      `.spec.ts` (Playwright). The public smoke suite under `tests/public/`
 *      is the one explicit exception: it uses `.test.mjs` because it runs on
 *      `node:test`, not Vitest. No other `.test.js`/`.test.mts`/`.spec.tsx`
 *      drift.
 *   2. LOCATION: every test file lives in a SUBDIRECTORY of tests/ (not in
 *      the tests/ root), so the directory tree stays organized.
 *   3. VITEST COVERAGE: every `.test.ts` matches a vitest `include` glob
 *      parsed from vitest.config.ts (the single source of truth). A `.test.ts`
 *      file NOT matched by any include pattern is DEAD — it never runs, so
 *      its assertions silently rot. This catches a file placed in the wrong
 *      directory (e.g. `tests/helpers/x.test.ts` would never execute).
 *   4. PLAYWRIGHT COVERAGE: every `.spec.ts` is in a Playwright testDir
 *      parsed from the playwright configs.
 *   5. NO DUPLICATE top-level `describe` names across files (copy-paste
 *      describes make failure reports ambiguous).
 *   6. EVERY test file has at least one top-level `describe` (an empty or
 *      syntax-broken test file is caught).
 *   7. SEMANTIC NAME: no test file in EITHER suite (this repo's `tests/` or
 *      the engine's `engine/test/`) is named after the experiment, round or
 *      scenario that added it (`exp<NNN>-…`). A name must say WHAT the file
 *      tests — the subject or invariant — because an experiment number is a
 *      dead fact the day the round closes, and a reader cannot find the test
 *      that owns an invariant when the name answers "who" instead of "what".
 *      The experiment archives (the `engine/scripts/exp` tree, the
 *      `engine/_experiments` tree, the root `experiments/` record) keep their
 *      numbers by design — they ARE the experiment — so the check scans only
 *      the LIVE test surface.
 *
 * DYNAMIC (deny-by-default): the test files, the vitest include dirs, and
 * the playwright testDirs are all DISCOVERED at run time. A new test file
 * is automatically covered; a new include directory in vitest.config.ts is
 * automatically recognized. No hardcoded file/dir list that silently rots.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { walk } from "../helpers/source-scan.ts";
import { TEST_INCLUDE } from "../test-include.ts";

const TESTS_ROOT = "tests";

/** The engine suite's own test tree, walked with the same deny-by-default
 * discovery as `tests/` — the naming standard is one standard, not two. The
 * engine's `dist/` bundle is gitignored build output, never a test source. */
const ENGINE_TESTS_ROOT = "engine/test";

/**
 * The scenario-bound FILENAME pattern the rename round removed.
 * `exp<digits>-…` marks a file named after the experiment that introduced it.
 * The experiment RECORDS (the `engine/scripts/exp` tree, the
 * `engine/_experiments` tree, the root `experiments/` archive) keep their
 * numbers legitimately — they are the archive, not a test surface — so the
 * pattern is matched against TEST files only, and the archives are not walked.
 */
const EXPERIMENT_BOUND_NAME = /^exp\d+[-.]/u;

/** Every test-like file under tests/ — broadened beyond `.ts` so the suffix
 * check can catch `.test.js`/`.spec.tsx` drift. Dynamic: discovered by the
 * shared `walk` helper (the single tree-walk owner — no local redefinition). */
const TEST_FILE_RE = /\.(test|spec)\.[A-Za-z0-9]+$/;
const ALL_TEST_FILES = walk(TESTS_ROOT, {
  exts: [".ts", ".js", ".tsx", ".mts", ".cts", ".cjs", ".mjs", ".svelte"],
  ignore: ["node_modules", ".bkp", "dist", ".git", ".svelte-kit"],
}).map((p) => p.split(sep).join("/")).filter((p) => TEST_FILE_RE.test(p));
const VITEST_TEST_FILES = ALL_TEST_FILES.filter((p) => p.endsWith(".test.ts"));
const PLAYWRIGHT_SPEC_FILES = ALL_TEST_FILES.filter((p) => p.endsWith(".spec.ts"));

/** Every test-like file under the ENGINE's test tree — discovered the same
 * way as `tests/` so a scenario-bound name there is caught the moment it
 * lands, not at the next manual audit. */
const ENGINE_TEST_FILES = walk(ENGINE_TESTS_ROOT, {
  exts: [".ts", ".js", ".tsx", ".mts", ".cts", ".cjs", ".mjs"],
  ignore: ["node_modules", ".bkp", "dist", ".git"],
}).map((p) => p.split(sep).join("/")).filter((p) => TEST_FILE_RE.test(p));

/**
 * The vitest include DIRECTORIES — read from the binding the runner receives.
 *
 * IT USED TO BE A REGEX OVER `vite.config.ts`'S BYTES, and it failed in
 * exactly the way `playwrightTestDirs` below already records as a lesson: the
 * moment the globs were lifted out of the config into their own module so the
 * budget guard could import rather than re-parse them, this regex matched
 * NOTHING, `VITEST_INCLUDE_DIRS` came back empty, and every `.test.ts` in the
 * repository was reported as "not under a vitest include dir". Loudly, this
 * time — the file's own non-vacuity floor caught it — but the same shape goes
 * quiet whenever the loss is partial rather than total (§31).
 *
 * So it imports the declaration, which is what the runner is handed. The
 * directory is the glob's first segment, derived rather than restated.
 */
function vitestIncludeDirs(): string[] {
  const dirs: string[] = [];
  for (const glob of TEST_INCLUDE) {
    const m = /^tests\/([A-Za-z0-9_]+)\/\*\*\/\*\.test\.ts$/.exec(glob);
    if (m !== null) dirs.push(m[1]!);
  }
  return dirs;
}
const VITEST_INCLUDE_DIRS = vitestIncludeDirs();

/**
 * The Playwright `testDir` values, READ FROM THE LOADED CONFIGS.
 *
 * IT USED TO BE A REGEX OVER THE BYTES — `/testDir:\s*"([^"]+)"/` — and that
 * is a guard keyed to a spelling. The moment the configs hoisted the value
 * into a `const TEST_DIR` so their own liveness refusal could share it, the
 * regex matched nothing, this returned `[]`, and every `.spec.ts` in the
 * repository was reported as "NOT under a playwright testDir". Loudly, as it
 * happens — but the same shape fails silently whenever the population it
 * bounds is a subset rather than the whole.
 *
 * Importing the config is what Playwright itself does, so the answer is the
 * one that decides the run rather than a claim about it, and it survives any
 * spelling. It also re-runs each config's own liveness refusal on the way in.
 */
async function playwrightTestDirs(): Promise<string[]> {
  const dirs: string[] = [];
  for (const spec of ["../../playwright.config.ts", "../../playwright.perf.config.ts"]) {
    const mod = (await import(spec)) as { default?: { testDir?: string } };
    const dir = mod.default?.testDir;
    if (typeof dir !== "string" || dir.length === 0) {
      throw new Error(
        `${spec} exports no \`testDir\`. This guard's universe is those directories; an ` +
        `empty answer makes every .spec.ts look orphaned, or — worse — makes a real orphan ` +
        `invisible once the list is partially populated.`,
      );
    }
    dirs.push(dir.replace(/^\.\//, ""));
  }
  return dirs;
}
const PLAYWRIGHT_TEST_DIRS = await playwrightTestDirs();

/** Extract top-level (column-0) describe names from a test file source.
 * Handles `describe("name"`, `describe.only("name"`, `describe.skipIf(...)("name"`,
 * and other `.modifier` forms (the modifier + its args precede the name call). */
/**
 * THE NAME MUST BE READ TO ITS REAL END, and the previous pattern did not.
 *
 * It closed the name on `["']` — EITHER quote — regardless of which one
 * opened it, so `describe("the band's span caption — …")` was read as `the
 * band`, stopping dead at the apostrophe. Two files whose names merely SHARE
 * a few words before their first apostrophe then collided, and the
 * duplicate-describe check below reported a duplicate that does not exist.
 * That is the guard accusing correct code, which costs exactly as much trust
 * as a guard that misses a defect.
 *
 * A quoted string ends on the quote that OPENED it. The delimiter is
 * captured and back-referenced, and the body is "anything that is not that
 * delimiter" — so an apostrophe inside a double-quoted name is a character
 * like any other, and a backtick-delimited name works too.
 *
 * The leading `[^\n]*` stays greedy on purpose: it makes the LAST `(`-then-
 * quote on the line the match, which is what carries the name through a
 * modifier chain (`describe.each([1, 2])("name %i", …)`) as well as through
 * the plain and `.skip` forms.
 */
/**
 * THE NAME MAY ALSO BE A DECLARED CONSTANT, and a call whose name argument
 * is an identifier is still a call — but a RAW-TEXT pattern cannot tell an
 * identifier from the same shape inside a string literal, and the first
 * attempt to admit identifiers matched "(UIE-049)" and "(typed)" inside
 * rendered TITLES, certifying duplicates that do not exist. A sound admit
 * needs a structure-preserving view (strings blanked, code intact), which
 * is more machinery than the census needs: files that consume a declared
 * title constant instead pin the declaration to their rendered titles with
 * an exact contract test at the consumer (the shape
 * tests/prevention/flaky-test-memory.test.ts uses for the perf gate's
 * freshness arm). This census therefore stays literal-only by design, and
 * a literal-only miss is caught where it is owned, not here.
 */
function topLevelDescribes(src: string): string[] {
  const out: string[] = [];
  // `describe` at column 0, then any modifier chain + args on the same line,
  // then the call with the string name.
  const re = /^describe\b[^\n]*\(\s*(["'`])((?:(?!\1).)*)\1/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[2]!);
  return out;
}

/** Extract top-level (column-0) test/it names — for files that use a flat
 * list of tests without a describe wrapper (a valid vitest pattern). */
function topLevelTests(src: string): string[] {
  const out: string[] = [];
  // Same delimiter rule as `topLevelDescribes` — a name is not allowed to end
  // on the quote that did not open it.
  const re = /^(?:test|it)\b[^\n]*\(\s*(["'`])((?:(?!\1).)*)\1/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[2]!);
  return out;
}

describe("test naming + directory structure (mechanical enforcement — test quality)", () => {
  test("discovery is non-vacuous (the suite has test files + the configs parse)", () => {
    expect(ALL_TEST_FILES.length, "tests/ must contain test files").toBeGreaterThan(100);
    expect(VITEST_INCLUDE_DIRS.length, "vitest.config.ts must declare at least one include dir").toBeGreaterThanOrEqual(3);
    expect(PLAYWRIGHT_TEST_DIRS.length, "playwright configs must declare testDirs").toBeGreaterThanOrEqual(2);
  });

  test("1. SUFFIX: every test file under tests/ ends in `.test.ts` or `.spec.ts`", () => {
    const bad = ALL_TEST_FILES.filter(
      (p) =>
        !p.endsWith(".test.ts") &&
        !p.endsWith(".spec.ts") &&
        !(p.startsWith("tests/public/") && p.endsWith(".test.mjs")),
    );
    expect(
      bad,
      bad
        .map(
          (p) =>
            `${p}: test file must end in .test.ts (vitest) or .spec.ts (playwright); ` +
            "only tests/public/*.test.mjs may use node:test",
        )
        .join("\n"),
    ).toEqual([]);
  });

  test("2. LOCATION: no test file in the tests/ root (must be in a subdirectory)", () => {
    const inRoot = ALL_TEST_FILES.filter((p) => {
      const rel = relative(TESTS_ROOT, p);
      return !rel.includes(sep);
    });
    expect(
      inRoot,
      inRoot.map((p) => `${p}: test file must live in a subdirectory of tests/, not the root`).join("\n"),
    ).toEqual([]);
  });

  test("3. VITEST COVERAGE: every `.test.ts` is under a vitest include dir (else it never runs)", () => {
    const dead = VITEST_TEST_FILES.filter((p) => {
      // p is like "tests/unit/foo.test.ts" — check the first path segment after tests/.
      const parts = p.split("/");
      const dir = parts[1]; // tests/<dir>/...
      return !VITEST_INCLUDE_DIRS.includes(dir!);
    });
    expect(
      dead,
      dead.map((p) => `${p}: .test.ts is NOT in any vitest include dir (vitest.config.ts includes ${VITEST_INCLUDE_DIRS.join(", ")}) — it never runs`).join("\n"),
    ).toEqual([]);
  });

  test("4. PLAYWRIGHT COVERAGE: every `.spec.ts` is under a playwright testDir", () => {
    const orphan = PLAYWRIGHT_SPEC_FILES.filter((p) => !PLAYWRIGHT_TEST_DIRS.some((d) => p.startsWith(d + "/")));
    expect(
      orphan,
      orphan.map((p) => `${p}: .spec.ts is NOT under a playwright testDir (${PLAYWRIGHT_TEST_DIRS.join(", ")}) — it never runs`).join("\n"),
    ).toEqual([]);
  });

  test("5. NO DUPLICATE top-level `describe` names across test files", () => {
    const seen = new Map<string, string[]>(); // describe name -> file paths
    for (const file of [...VITEST_TEST_FILES, ...PLAYWRIGHT_SPEC_FILES]) {
      const src = readFileSync(file, "utf8");
      for (const name of topLevelDescribes(src)) {
        const arr = seen.get(name) ?? [];
        arr.push(file);
        seen.set(name, arr);
      }
    }
    const dupes = [...seen.entries()].filter(([, files]) => files.length > 1);
    expect(
      dupes,
      dupes.map(([name, files]) => `duplicate describe "${name}" in:\n${files.map((f) => `  ${f}`).join("\n")}`).join("\n\n"),
    ).toEqual([]);
  });

  test("6. EVERY test file has at least one top-level `describe` or `test`/`it` (no empty/broken files)", () => {
    const empty: string[] = [];
    for (const file of [...VITEST_TEST_FILES, ...PLAYWRIGHT_SPEC_FILES]) {
      const src = readFileSync(file, "utf8");
      if (topLevelDescribes(src).length === 0 && topLevelTests(src).length === 0) empty.push(file);
    }
    expect(
      empty,
      empty.map((f) => `${f}: test file has no top-level describe/test/it — empty or syntax-broken`).join("\n"),
    ).toEqual([]);
  });

  test("7. SEMANTIC NAME: no test file in either suite is named after the experiment/round that added it", () => {
    // Both trees are walked; a planted `exp999-…` in either must red.
    const universe = [...ALL_TEST_FILES, ...ENGINE_TEST_FILES];
    expect(universe.length, "both test trees must be discovered non-empty").toBeGreaterThan(200);
    const bound = universe.filter((p) => EXPERIMENT_BOUND_NAME.test(p.split("/").pop() ?? ""));
    expect(
      bound,
      bound.map((p) =>
        `${p}: a test file named after the experiment/round that added it says WHO, not WHAT. ` +
        `Rename it for the subject or invariant it tests (e.g. learning-coverage-benchmark.test.ts, ` +
        `unreachable-catch-checks.test.ts).`
      ).join("\n"),
    ).toEqual([]);
  });
});
