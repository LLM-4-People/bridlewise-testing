// @vitest-environment node
import { statSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  globMatchCounts,
  patternLivenessFailure,
} from "../../engine/scripts/verification/pattern-liveness.ts";
import { SOURCE_EXTS, relpath, sourceFilesReachableFrom, walk } from "../helpers/source-scan.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { TEST_INCLUDE } from "../../vitest.config.ts";

/**
 * WHAT A FRONTEND TEST MAY TRANSITIVELY REACH, BOUNDED BY WHAT THE FRONTEND
 * ITSELF CONTAINS.
 *
 * ── THE DEFECT THIS EXISTS TO END ──────────────────────────────────────────
 *
 * A Svelte cockpit test — `tests/cockpit/stream-pulse.test.ts` — transitively
 * imported the harness's GENERATED architecture manifest, a 422 KB, 5,000-line
 * data module, for ONE frozen array of eight file extensions. The chain was
 * five links long and every link was individually reasonable:
 *
 *   stream-pulse.test.ts
 *     -> tests/helpers/function-scope.ts
 *     -> integration/src/shared/source-structure.ts
 *     -> integration/src/quality-packs/prevention/ast-helpers.ts
 *     -> integration/src/architecture-manifest.ts        (422 KB, generated)
 *
 * Nobody chose that. It was assembled one import at a time, and the manifest
 * grows by a few hundred bytes every time ANY module is registered — so the
 * frontend suite's inputs changed on work that never touched the frontend.
 * The failure that surfaced it was a module-cache fault in the runner, and it
 * was diagnosed as a size cliff; the size was a symptom. The disease is that a
 * UI test's module graph reached a machine-written data module at all.
 *
 * ── WHY A BOUND AND NOT A LIST ─────────────────────────────────────────────
 *
 * A list of modules a test may not reach is a list someone must remember to
 * extend, and the next generated artifact will not be on it. A bound needs no
 * maintenance because it is DERIVED from the tree on every run:
 *
 *   > No module reached from outside this repository may be larger than the
 *   > largest first-party source file this repository itself contains.
 *
 * Nothing here is typed. The bound is `max(size)` over the web repository's own
 * source, so it moves with the repository and never has to be re-stated; the
 * judged population is the transitive RUNTIME import closure of the test files
 * the RUNNER ITSELF selects, read out of the runner's own config object rather
 * than re-declared here (a re-declared list is a second source of truth that
 * agrees with itself while the runner uses something else).
 *
 * ── WHY THE FOREIGN SIDE, AND NOT EVERY MODULE ─────────────────────────────
 *
 * The bound is set BY a file in the web tree, so applying it to the web tree
 * would be a tautology: the largest web file is always exactly at the bound.
 * The question that has an answer is the cross-repository one — how much of
 * another repository does a frontend test drag in — and that is also where the
 * defect lived. A web file that grows past every other web file is a different
 * problem with a different owner.
 *
 * ── DELIBERATE BLIND SPOTS, REPORTED AS NUMBERS ────────────────────────────
 *
 * The closure is a source scan. It cannot resolve a computed specifier, and a
 * relative specifier may resolve to nothing. Both are counted and printed in
 * the verdict rather than assumed to be zero, so a reader can see the size of
 * the hole instead of inferring that there is none.
 */

const WEB_ROOT = resolve(import.meta.dirname, "..", "..");

/** The trees that are this repository's OWN first-party source. */
const WEB_SOURCE_ROOTS: readonly string[] = ["src", "server", "tests", "scripts", "shared"];

/**
 * A reached file is FOREIGN when it is not part of this project's own source.
 *
 * RE-DERIVED AT THE MONOREPO ASSEMBLY (2026-07-30), NOT PORTED. This used to
 * read `!file.startsWith(WEB_ROOT + "/")` — "another repository" meant another
 * checkout, and path containment was chosen so that RENAMING the sibling could
 * not silently empty the judged population. The assembly did something a
 * rename could not: it moved the sibling INSIDE, so every reached engine file
 * became "not foreign" at once and the floor below (`foreignFiles > 0`) went
 * from a live check to one that could only fail. Measured on the assembled
 * tree before this repair: closure=950, foreign=0.
 *
 * The proposition is unchanged — a frontend test must not transitively drag in
 * a module larger than the biggest file the frontend itself owns — so foreign
 * is now spelled against this project's OWN roots rather than against the
 * repository boundary. `node_modules` is excluded because it was never in this
 * population: it sat outside `WEB_SOURCE_ROOTS` before the assembly too, and
 * dependencies are not the subject.
 */
function isForeign(file: string): boolean {
  if (!file.startsWith(`${WEB_ROOT}/`)) return true;
  const relative = file.slice(WEB_ROOT.length + 1);
  if (relative.startsWith("node_modules/") || relative.includes("/node_modules/")) return false;
  return !WEB_SOURCE_ROOTS.some((root) => relative.startsWith(`${root}/`));
}

type Offender = Readonly<{ file: string; bytes: number }>;

type ClosureVerdict = Readonly<{
  entrypoints: number;
  closureFiles: number;
  foreignFiles: number;
  boundBytes: number;
  boundFile: string;
  largestForeign: Offender | null;
  offenders: readonly Offender[];
  unresolved: number;
  dynamicUnresolved: number;
}>;

/**
 * Judge one entry set against one bound population.
 *
 * Both universes are arguments so a plant can enter through the SAME door a
 * real run enters, rather than through an inner helper that the real verdict
 * never calls.
 *
 * REFUSES rather than returning a clean verdict when either universe is empty.
 * An empty entry set and a clean tree produce the same value otherwise, and
 * "nothing was examined" must never be spelled the same way as "nothing is
 * wrong". The same refusal covers the inert shape: a run that computes the
 * closure correctly and then judges it against no bound at all.
 */
function judgeClosure(
  entrypoints: readonly string[],
  boundPopulation: readonly string[],
): ClosureVerdict {
  if (entrypoints.length === 0) {
    throw new Error(
      "frontend closure bound: the entry set is EMPTY. Nothing was reached, so nothing " +
      "could be judged; a guard that examines no file agrees with every bound.",
    );
  }
  if (boundPopulation.length === 0) {
    throw new Error(
      "frontend closure bound: the bound population is EMPTY, so the bound would be " +
      "computed from no file. A closure measured and then compared against nothing is " +
      "a verdict about nothing.",
    );
  }
  const sizedBound = boundPopulation
    .map((file) => ({ file, bytes: statSync(file).size }))
    .sort((left, right) => right.bytes - left.bytes);
  const bound = sizedBound[0]!;

  const reached = sourceFilesReachableFrom(entrypoints, "runtime");
  if (reached.files.length === 0) {
    throw new Error("frontend closure bound: the reachable closure is EMPTY.");
  }
  const foreign = reached.files
    .filter(isForeign)
    .map((file) => ({ file, bytes: statSync(file).size }))
    .sort((left, right) => right.bytes - left.bytes);

  return {
    entrypoints: reached.entrypoints.length,
    closureFiles: reached.files.length,
    foreignFiles: foreign.length,
    boundBytes: bound.bytes,
    boundFile: relpath(bound.file),
    largestForeign: foreign[0] ?? null,
    offenders: foreign.filter((candidate) => candidate.bytes > bound.bytes),
    unresolved: reached.unresolved.length,
    dynamicUnresolved: reached.dynamicUnresolved,
  };
}

/** Every test file the RUNNER selects, read from the runner's own config. */
function runnerSelectedTestFiles(): { patterns: readonly string[]; files: readonly string[] } {
  const patterns = TEST_INCLUDE;
  const liveness = patternLivenessFailure(
    "frontend closure bound: vitest.config.ts test.include",
    globMatchCounts(patterns, WEB_ROOT),
  );
  if (liveness !== null) throw new Error(liveness);
  const files = [...new Set(patterns.flatMap((pattern) => globSync(pattern, { cwd: WEB_ROOT })))]
    .map((relative) => resolve(WEB_ROOT, relative))
    .sort();
  return { patterns, files };
}

/** Every first-party source file this repository owns. */
function webOwnSourceFiles(): readonly string[] {
  return WEB_SOURCE_ROOTS
    // SOURCE_EXTS, not the default: `scripts/` is in the roots above and holds
    // five tracked `.mjs` files. A plain JS module is web-own source by every
    // reading of this guard's subject, and the default extension set silently
    // kept all five out of the population it bounds.
    .flatMap((directory) => walk(join(WEB_ROOT, directory), { exts: SOURCE_EXTS }))
    .filter((file) => SOURCE_EXTS.some((extension) => file.endsWith(extension)));
}

describe("a frontend test may not reach further than the frontend reaches itself", () => {
  test("no foreign module in the test closure exceeds the largest web source file", () => {
    const { patterns, files } = runnerSelectedTestFiles();
    const verdict = judgeClosure(files, webOwnSourceFiles());

    // POPULATION, AS RUNTIME NUMBERS. Printed unconditionally so a green run
    // still says how much it looked at — a floor below is what stops the
    // population from collapsing quietly.
    const population =
      `entrypoints=${verdict.entrypoints} (from ${patterns.length} runner globs) ` +
      `closure=${verdict.closureFiles} foreign=${verdict.foreignFiles} ` +
      `bound=${verdict.boundBytes}B set by ${verdict.boundFile} ` +
      `largestForeign=${verdict.largestForeign === null ? "none" : `${verdict.largestForeign.bytes}B ${relpath(verdict.largestForeign.file)}`} ` +
      `unresolvedSpecifiers=${verdict.unresolved} computedSpecifiers=${verdict.dynamicUnresolved}`;

    expect(verdict.entrypoints, population).toBeGreaterThan(0);
    expect(verdict.foreignFiles, population).toBeGreaterThan(0);

    expect(
      verdict.offenders.map((offender) => `${offender.bytes}B ${relpath(offender.file)}`),
      `${population}\n` +
      `A frontend test transitively reaches a module from another repository that is ` +
      `LARGER than anything this repository contains. Break the import edge — move what ` +
      `the frontend actually needs into a module that does not carry the rest with it. ` +
      `Do not raise this bound: it is derived from this repository's own largest source ` +
      `file and has no number to raise.`,
    ).toEqual([]);
  });

  test("the bound catches a planted edge into a foreign module that exceeds it", () => {
    const bound = webOwnSourceFiles();
    const largest = bound
      .map((file) => ({ file, bytes: statSync(file).size }))
      .sort((left, right) => right.bytes - left.bytes)[0]!;

    // THE PLANT IS SUPPLIED FROM OUTSIDE THE GUARD AND IS NOT A TRACKED FILE.
    // A canary written into the repository is a canary a parallel run can
    // truncate; a canary that is a literal in this file can be defeated by
    // filtering that literal.
    const scratch = createTempDir("ch-web-closure-plant-");
    const oversized = join(scratch, "oversized-foreign.ts");
    writeFileSync(oversized, `// ${"x".repeat(largest.bytes + 1)}\nexport const PLANTED = 1;\n`);
    const entry = join(scratch, "entry.test.ts");
    writeFileSync(entry, `import { PLANTED } from "./oversized-foreign.ts";\nexport const USED = PLANTED;\n`);

    const verdict = judgeClosure([entry], bound);
    expect(verdict.offenders.map((offender) => basename(offender.file)))
      .toContain("oversized-foreign.ts");
    expect(verdict.offenders[0]!.bytes).toBeGreaterThan(verdict.boundBytes);
  });

  test("the same door accepts a foreign module that fits under the bound", () => {
    const bound = webOwnSourceFiles();
    const scratch = createTempDir("ch-web-closure-control-");
    const small = join(scratch, "small-foreign.ts");
    writeFileSync(small, "export const PLANTED = 1;\n");
    const entry = join(scratch, "entry.test.ts");
    writeFileSync(entry, `import { PLANTED } from "./small-foreign.ts";\nexport const USED = PLANTED;\n`);

    const verdict = judgeClosure([entry], bound);
    expect(verdict.offenders).toEqual([]);
    expect(verdict.foreignFiles).toBeGreaterThan(0);
  });

  test("an empty entry set or an empty bound population REFUSES instead of passing", () => {
    expect(() => judgeClosure([], webOwnSourceFiles())).toThrowError(/entry set is EMPTY/u);
    const { files } = runnerSelectedTestFiles();
    expect(() => judgeClosure(files, [])).toThrowError(/bound population is EMPTY/u);
  });
});
