// EVERY TYPE-PROGRAM EXCLUSION IS A CLAIM, AND A CLAIM CARRIES EVIDENCE.
//
// A type program's `exclude` list is a hand-written set of paths that drop
// silently out of the type program. Nothing asserted an entry was still
// justified, and the result was what an unchecked list always becomes:
// measured before this guard existed, 19 entries, of which THREE named paths
// that no longer exist and NINE named files that compile cleanly. Twelve
// exclusions were removing files from the compiler for no reason anybody
// could still state, and the whole point of that file is to decide what gets
// checked.
//
// A stale exclusion is worse than a wrong one. It fails OPEN — the path is
// absent, the entry matches nothing, and it sits there reading like a
// justified decision. That is the same shape as an allowlist entry protecting
// a symbol that was renamed years ago: it looks like enforcement and is
// furniture.
//
// So each entry must earn its place twice. It must RESOLVE, which kills the
// stale class in milliseconds. And it must be NECESSARY: dropping it must
// produce at least one compiler error under that path. An exclusion that
// changes nothing is deleted, not documented.
//
// Two entries are structural rather than error-driven and say so by name
// below, because "this is not that kind of exclusion" is itself a claim and
// belongs in the code rather than in a reviewer's memory.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import {
  createRepositoryLocalTemporaryDirectory,
  removeRepositoryLocalTemporaryDirectory,
} from "../support/repository-local-temporary.ts";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * Exclusions whose justification is STRUCTURAL — they are not excluded
 * because they fail to compile, so "dropping it produces an error" is the
 * wrong test for them and would be a manufactured one.
 *
 * `node_modules` is dependency code this program does not own.
 *
 * `test/fixtures/**` holds sources that are DELIBERATELY malformed, because
 * they are the input to the evaluation harness. They matter twice over:
 * TypeScript suppresses semantic diagnostics for a program containing parse
 * errors, so admitting them does not merely add six syntax errors — it hides
 * every other error in the repository. Measured: with fixtures admitted, the
 * compiler reported 6 syntax errors and NOTHING else; with them excluded, 29
 * semantic errors across 11 files. An "include everything" instinct here
 * would have produced a quieter compiler and called it progress.
 */
const STRUCTURAL: readonly string[] = ["node_modules", "test/fixtures/**"];

/**
 * Every type program the engine declares — `tsconfig.json` (the product
 * program, shared with the product tree) and `tsconfig.tests.json` (it
 * extends the product program and adds `test/**`) — DISCOVERED, as the
 * include-liveness check discovers them, so a new program's exclusions are
 * judged the day it is added.
 */
function typePrograms(): readonly string[] {
  const names = globSync("tsconfig*.json", { cwd: ROOT }).sort();
  assert.ok(names.includes("tsconfig.json"), "the engine's product type program was not found — the discovery went blind");
  return names;
}

/** One program's OWN `exclude` list (each program in this engine states its own). */
function readExclusions(program: string): readonly string[] {
  const parsed: unknown = JSON.parse(readFileSync(join(ROOT, program), "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null, `${program} must be an object`);
  const exclude = (parsed as { exclude?: unknown }).exclude;
  assert.ok(Array.isArray(exclude), `${program} must declare its own exclude array`);
  assert.ok(exclude.every((entry): entry is string => typeof entry === "string"));
  return exclude;
}

/** The on-disk path an exclusion glob points at, with the glob suffix removed. */
function pathOf(entry: string): string {
  return join(ROOT, entry.replace(/\/\*\*$/u, ""));
}

/**
 * THE TWO DETECTORS, EXTRACTED SO A PLANTED VIOLATION DRIVES THE SAME CODE
 * THE VERDICT DOES.
 *
 * Written inline first, and a mutation caught that: leaving the detection
 * intact and DISCARDING its result — `unnecessary.filter(() => false)` — kept
 * the test green with a real unnecessary exclusion planted in the config. The
 * detector ran, got the right answer, and the assertion looked at nothing.
 * A count would not have caught it either; the count was right too.
 *
 * So each test now asserts the verdict AND re-runs the detector over the same
 * input plus one planted violation, asserting it comes back. That is evidence
 * the detector still AGREES ON A VERDICT, not merely that it is awake, and it
 * is the only shape that survives having its output thrown away.
 */
function absentExclusions(exclusions: readonly string[]): readonly string[] {
  return exclusions.filter((entry) => !existsSync(pathOf(entry)));
}

function unnecessaryExclusions(
  exclusions: readonly string[],
  erroringPaths: ReadonlySet<string>,
): readonly string[] {
  return exclusions.filter((entry) => {
    const prefix = entry.replace(/\/\*\*$/u, "");
    return ![...erroringPaths].some((path) => path === prefix || path.startsWith(`${prefix}/`));
  });
}

type ExclusionProbe = Readonly<{ directory: string; configurationPath: string }>;

/**
 * THE PROBE IS NEVER WRITTEN INTO THE REPOSITORY ROOT, AND THIS FUNCTION IS
 * THE ONE PLACE THAT DECIDES SO.
 *
 * It used to be `join(ROOT, "tsconfig.exclusion-probe.json")`: an UNTRACKED
 * file, matched by no `.gitignore` rule, sitting in the root for the seconds
 * `tsc` takes and removed in a `finally`. Anything enumerating the live
 * workspace during that window sees it. Measured: a concurrent
 * candidate-manifest build in the same 370-file parallel phase counted 2032
 * files against a steady state of 2031, and — one moment later, in its own
 * enumerate-then-read — reported
 * `candidate-entry-unreadable:tsconfig.exclusion-probe.json` and refused the
 * whole manifest. Five green runs, one red, on an unchanged tree.
 *
 * THE FIX REMOVES THE SHARED RESOURCE; IT DOES NOT SCHEDULE AROUND IT. The
 * concurrency classifier would have taken a tenth source-text spelling
 * (`writeFileSync(join(ROOT,`) and moved this file to the serial phase — its
 * own comments record a ninth being added for this identical signature one
 * round earlier, and adding a tenth is that mistake a third time. A list of
 * spellings has a universe and a universe can be wrong; a file that is not in
 * the root cannot be seen by anything reading the root, under any scheduler,
 * for ever.
 *
 * The repository-local fixture root is the EXISTING owner of "somewhere a test
 * may write inside this repository": its top segment is in
 * `repositoryScanExclusions` AND in `.gitignore`, so the probe enters neither
 * the safe-repository walk nor `git ls-files --others`. Removal is registered
 * by the helper that creates it, so a thrown assertion cannot leak one.
 *
 * Relative paths in a tsconfig resolve against the file they are WRITTEN in,
 * so moving the file moves its paths: `extends` carries the base config's
 * `include` and `compilerOptions`, which keep resolving against ROOT because
 * that is where they are written, and this file's own `exclude` is therefore
 * stated absolutely. Driven before the move: the relocated probe reports the
 * SAME 10 erroring paths as the root-level one did, so the instrument is
 * unchanged and only its location moved.
 */
function createExclusionProbe(prefix: string, program: string): ExclusionProbe {
  const directory = createRepositoryLocalTemporaryDirectory(prefix);
  const configurationPath = join(directory, "tsconfig.exclusion-probe.json");
  writeFileSync(configurationPath, `${JSON.stringify({
    extends: join(ROOT, program),
    exclude: readExclusions(program).filter((entry) => STRUCTURAL.includes(entry)).map((entry) => join(ROOT, entry)),
  }, null, 2)}\n`);
  return Object.freeze({ directory, configurationPath });
}

/** A path that has never existed in this repository, for planting. */
const PLANTED_ABSENT = "src/this-path-has-never-existed/**";
/** A real file that compiles cleanly, so excluding it buys nothing. Resolved
 *  through the module resolver so the fold's move of errors.ts into kernel/
 *  does not leave the plant pointing at a path that no longer exists. */
const PLANTED_UNNECESSARY = engineModuleSourceRelative("kernel/errors.ts");

test("every tsconfig exclusion names a path that exists", () => {
  const exclusions = typePrograms().flatMap((program) => readExclusions(program));
  // Liveness on the list itself: an empty or shrunken list would satisfy a
  // per-entry loop while proving nothing.
  assert.ok(exclusions.length > 0, "the exclude list is empty — this guard would be vacuous");
  const absent = absentExclusions(exclusions);
  assert.deepEqual(
    absent,
    [],
    `tsconfig exclusions name paths that no longer exist. An exclusion matching nothing is not a ` +
    `decision, it is a leftover, and it reads exactly like a justified one. Delete these: ${absent.join(", ")}`,
  );
  // PLANTED VIOLATION. The clean verdict above is worth exactly as much as the
  // detector's ability to produce a dirty one on demand.
  assert.deepEqual(
    absentExclusions([...exclusions, PLANTED_ABSENT]),
    [PLANTED_ABSENT],
    "the absent-path detector did not report a path that has never existed",
  );
  assert.ok(!existsSync(pathOf(PLANTED_ABSENT)), "the planted path must genuinely not exist");
});

test("every non-structural tsconfig exclusion is necessary — dropping it produces a compiler error", () => {
  const programs = typePrograms();
  const errorDrivenOf = (program: string): readonly string[] => readExclusions(program).filter((entry) => !STRUCTURAL.includes(entry));
  assert.ok(
    programs.some((program) => errorDrivenOf(program).length > 0),
    "no error-driven exclusions remain — delete this test rather than letting it pass vacuously",
  );
  // Every structural entry must actually BE in some program's list, or the
  // exemption above is protecting nothing and the next reader will trust it anyway.
  for (const structural of STRUCTURAL) {
    assert.ok(
      programs.some((program) => readExclusions(program).includes(structural)),
      `${structural} is recorded here as a structural exclusion but no program excludes it — ` +
      `remove it from STRUCTURAL, or the note is a claim about a world that no longer exists`,
    );
  }

  for (const program of programs.filter((name) => errorDrivenOf(name).length > 0)) {
    const errorDriven = errorDrivenOf(program);
    const probeFixture = createExclusionProbe("tsconfig-exclusion-probe-", program);
    try {
      const probe = spawnSync(
        process.execPath,
        [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", probeFixture.configurationPath],
        { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
      // Liveness on the probe: if the compiler did not run, or ran clean, every
      // per-entry check below is satisfied by an absence of evidence rather than
      // by evidence of absence. A clean probe means every error-driven exclusion
      // is unnecessary, which is a finding, not a pass.
      assert.ok(
        /error TS\d+/u.test(output),
        `the ${program} exclusion probe produced no compiler errors at all. Either every remaining exclusion is ` +
        `unnecessary and should be deleted, or the probe did not compile. Output: ${output.slice(0, 500)}`,
      );
      const erroringPaths = new Set(
        output.split("\n")
          .map((line) => /^(.+?)\(\d+,\d+\): error TS\d+/u.exec(line)?.[1])
          .filter((path): path is string => path !== undefined),
      );
      const unnecessary = unnecessaryExclusions(errorDriven, erroringPaths);
      assert.deepEqual(
        unnecessary,
        [],
        `${program} exclusions that compile cleanly and are excluded anyway. Each one silently removes ` +
        `files from the type program in exchange for nothing. Delete them: ${unnecessary.join(", ")}`,
      );
      // PLANTED VIOLATION, over the same error set the verdict was taken from.
      // `src/errors.ts` is real, is in the program, and compiles — so excluding
      // it would remove a file from the compiler and buy nothing, which is
      // exactly the shape the clean verdict above claims is absent.
      assert.ok(existsSync(pathOf(PLANTED_UNNECESSARY)), "the planted file must genuinely exist");
      assert.deepEqual(
        unnecessaryExclusions([...errorDriven, PLANTED_UNNECESSARY], erroringPaths),
        [PLANTED_UNNECESSARY],
        "the unnecessary-exclusion detector did not report a cleanly-compiling file",
      );
    } finally {
      removeRepositoryLocalTemporaryDirectory(probeFixture.directory);
    }
  }
});

test("the exclusion probe is invisible to anything reading the live workspace", () => {
  // LIVENESS ON THE FIX ITSELF, THROUGH THE SAME DOOR THE PROBE USES.
  //
  // The test above would pass just as well with the probe back in the
  // repository root — it only reads `tsc`'s output, and the race was never
  // visible from inside the file that caused it. So this drives
  // `createExclusionProbe`, the single owner of where the probe is written,
  // and asserts the property that ended the race. Moving the probe back into
  // the root is one edit to that function, and it reds here.
  const probe = createExclusionProbe("tsconfig-exclusion-probe-visibility-", "tsconfig.json");
  try {
    const fixtureRoot = join(ROOT, ROOT_POLICY.verification.testFixtures.repositoryLocalTemporaryRoot);
    assert.ok(
      probe.configurationPath.startsWith(`${fixtureRoot}/`),
      `the probe must be written under the repository-local fixture root, got ${probe.configurationPath}`,
    );
    // The two instruments that read the live tree must BOTH miss it. Either
    // one alone leaves the probe visible to the other: the safe-repository
    // walk excludes by directory name, git excludes by ignore rule, and the
    // candidate manifest reads `git ls-files --cached --others`.
    const excludedDirectory = ROOT_POLICY.verification.testFixtures.repositoryLocalTemporaryRoot.split("/")[0]!;
    assert.ok(
      (ROOT_POLICY.configuration.repositoryScanExclusions as readonly string[]).includes(excludedDirectory),
      `${excludedDirectory} must be a repository scan exclusion, or the walk sees the probe`,
    );
    // `--no-index` IS LOAD-BEARING. Without it `check-ignore` reports nothing
    // for a path already in the index, so a question about the RULES silently
    // becomes a question about today's index — and the pair below would then
    // be answering two different questions while looking like a control.
    const ignored = spawnSync(
      "git",
      ["check-ignore", "-q", "--no-index", "--", probe.configurationPath],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(
      ignored.status,
      0,
      `git must ignore ${probe.configurationPath}, or an enumerator of the live tree sees the probe`,
    );
    // CONTROL — the same question asked about the path this probe used to
    // occupy answers the other way, so the assertion above is about the
    // relocation and not about `git check-ignore` always saying yes.
    //
    // EQUAL TO 1, NOT MERELY DIFFERENT FROM 0. `-q` answers 0 for ignored and
    // 1 for not ignored; 128 (bad repository or bad argv) and `null` (git
    // never launched) are failures to ask, and a `notEqual(…, 0)` control is
    // satisfied by both — so a control that had stopped running would still
    // certify the assertion above as a relocation result.
    const rootProbe = spawnSync(
      "git",
      ["check-ignore", "-q", "--no-index", "--", join(ROOT, "tsconfig.exclusion-probe.json")],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(rootProbe.status, 1, "fixture assumption: a root-level probe would NOT have been ignored");
  } finally {
    removeRepositoryLocalTemporaryDirectory(probe.directory);
  }
});
