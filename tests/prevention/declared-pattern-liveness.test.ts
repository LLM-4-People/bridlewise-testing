// @vitest-environment node
/**
 * Mechanical enforcement: EVERY DECLARED FILE-SELECTING PATTERN IS LIVE.
 *
 * ── THE CLASS ─────────────────────────────────────────────────────────────
 *
 * A declaration that selects files — a tsconfig `include`, the test runner's
 * `include` — is a LIST whose results are unioned, and every guard this
 * project had over such a list was a floor on the UNION. A floor on a union
 * cannot see the loss of one member, because the survivors hold the total up.
 * Driven, and each number here was measured rather than estimated:
 *
 *   - `tsc` exits 0 when ONE include pattern of several matches nothing. Only
 *     when ALL of them do does it say `TS18003`. Renaming `shared/` takes
 *     the client program from 225 files to 212 and stays green.
 *   - the runner's `discovered > 300` floor over 451 files passes after
 *     `tests/cockpit/**` is dropped, losing 121 files and leaving 330.
 *
 * ── WHAT THIS FILE ADDS THAT THE ENFORCEMENT ITSELF DOES NOT ──────────────
 *
 * The refusals live at the doors — `vitest.config.ts` for the runner globs, the
 * `typecheck` script for the tsconfigs — which is where they cannot be
 * bypassed. This file is the guard over the RULE: it drives the shared owner
 * over BOTH repositories' real configs, and it plants a dead pattern from
 * OUTSIDE the owner to prove the refusal still fires. A rule that is only
 * exercised by being satisfied has never been shown to be capable of failing.
 */
import { describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { globSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkRepository,
  checkTsconfigIncludeLiveness,
} from "../../engine/scripts/verification/tsconfig-include-liveness.ts";
import {
  deadPatterns,
  globMatchCounts,
  patternLivenessFailure,
} from "../../engine/scripts/verification/pattern-liveness.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { TEST_INCLUDE } from "../test-include.ts";
import { DECLARED_ROOT } from "../declared-root.ts";

const WEB_ROOT = process.cwd();
const INTEGRATION_ROOT = join(WEB_ROOT, "engine");

describe("declared pattern liveness — both repositories", () => {
  test("every tsconfig include pattern in BOTH repositories selects at least one file", () => {
    // BOTH ROOTS, because the two repositories share one typecheck story and
    // a guard scoped to the one it was written in is the silently smaller
    // universe this suite keeps rediscovering.
    const reports = [...checkRepository(WEB_ROOT), ...checkRepository(INTEGRATION_ROOT)];
    // POPULATION AS A RUNTIME NUMBER, derived from the configs on disk — never
    // a count written here, which would go stale the moment a config is added
    // and would then bound a population it had not measured.
    const patterns = reports.flatMap((r) => r.perPattern);
    expect(
      reports.length,
      "no tsconfig was examined — a liveness check with an empty subject agrees with everything",
    ).toBeGreaterThan(0);
    expect(
      patterns.length,
      "no include patterns were examined across either repository",
    ).toBeGreaterThan(0);
    const failures = reports.filter((r) => r.failure !== null).map((r) => r.failure);
    expect(
      failures,
      "a dead include pattern removes its files from the type program while tsc still exits 0",
    ).toEqual([]);
  });

  test("every test-runner glob the vitest config declares selects at least one file", async () => {
    // Read from the CONFIG THE RUNNER LOADED, not re-typed here: a re-typed
    // list is a second source of truth that can agree with itself while the
    // runner uses something else. Importing it also re-runs the config's own
    // per-glob refusal, so this test fails on either mechanism going quiet.
    const config = (await import("../../vitest.config.ts")) as unknown as {
      default: { test?: { include?: readonly string[] } };
    };
    const include = config.default.test?.include ?? [];
    expect(include.length, "vitest.config.ts declares no test.include globs").toBeGreaterThan(0);
    const matches = globMatchCounts(include, WEB_ROOT);
    expect(
      deadPatterns(matches),
      "a dead runner glob drops its whole tree from the suite; the total-count floor cannot see it",
    ).toEqual([]);
    // LIVENESS OF THE INSTRUMENT ITSELF: a matcher that returned 0 for
    // everything would make the assertion above pass vacuously.
    expect(matches.reduce((n, m) => n + m.matched, 0)).toBeGreaterThan(0);
  });
});

describe("the rule can fail — planted from outside the owner", () => {
  test("a tsconfig whose include names a directory that is not there is REFUSED, and the message names it", () => {
    // THE PLANT IS A WHOLE SYNTHETIC REPOSITORY, supplied from outside the
    // subject: the owner cannot special-case a literal it has never seen, and
    // nothing in the real tree is touched to produce the failure.
    const dir = createTempDir("tsconfig-liveness-plant-");
    mkdirSync(join(dir, "alive"), { recursive: true });
    writeFileSync(join(dir, "alive", "one.ts"), "export const one = 1;\n");
    const absent = `gone-${Math.random().toString(36).slice(2)}`;
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ include: ["alive/**/*.ts", `${absent}/**/*.ts`] }),
    );
    const report = checkTsconfigIncludeLiveness(join(dir, "tsconfig.json"));
    expect(report.failure).not.toBeNull();
    expect(String(report.failure)).toContain(`${absent}/**/*.ts`);
    // AND IT REPORTS THE SURVIVORS, because the operator's first question
    // after "which pattern died" is "what is still covered".
    expect(String(report.failure)).toContain("alive/**/*.ts");
    // The live sibling is NOT reported dead — a rule that fails everything
    // once anything fails is a rule nobody can act on.
    expect(report.perPattern.find(([p]) => p === "alive/**/*.ts")?.[1]).toBe(1);
  });

  test("an EMPTY declaration is a refusal, not a pass", () => {
    // The degenerate case a per-pattern rule would otherwise satisfy
    // trivially: zero patterns means zero dead patterns.
    expect(patternLivenessFailure("probe", [])).toContain("declares NO patterns");
  });

  test("a repository with no tsconfig is a refusal, not an empty success", () => {
    const dir = createTempDir("tsconfig-liveness-empty-");
    let thrown: unknown;
    try {
      checkRepository(dir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toMatch(/no tsconfig\*\.json found/);
  });
});

/**
 * Every `*.test.*` file this repository's index holds, outside the engine.
 *
 * `engine/` is excluded because it is its own program with its own runner and
 * its own inventory guard; a claim about what runs there belongs there. The
 * universe is the git index rather than a walk, so there is no skip list to go
 * stale and no directory a walker forgot.
 */
function trackedTestFiles(root: string): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    // NO EXTENSION WHITELIST. An enumerated list of extensions is exactly the
    // place a universe shrinks without anything failing — narrow it to `.ts`
    // and the one orphan this arm exists for silently leaves the population
    // while every count stays plausible. `.test.` in the basename is the whole
    // rule, so there is no list to get wrong.
    .filter((p) => p.length > 0 && !p.startsWith("engine/") && /(^|\/)[^/]*\.test\.[^/]+$/u.test(p))
    // RECORDS ARE NOT LIVE TESTS. The experiment archive holds closed rounds'
    // own test copies (the exp493 files moved to `experiments/engine/`) — the
    // record of what a round ran, never something the current suite executes,
    // and their import edges point at paths that existed only inside their
    // own round. Which root entries are records is DECLARED once
    // (`tests/declared-root.ts`, class `record`), so a future record root
    // joins this subtraction the day it is declared.
    .filter((p) => DECLARED_ROOT[p.split("/")[0]!]?.class !== "record");
}

/**
 * Run one `node:test` file and report the status AND the names that passed.
 *
 * THE NAMES ARE THE POINT, and getting this wrong was driven rather than
 * imagined. `node --test` over a file declaring NO test at all exits 0 and
 * reports `tests 1 / pass 1` — byte-identical to a file with one passing test,
 * because the FILE itself becomes the subtest. So a pass COUNT cannot tell an
 * executed suite from an empty one, which is the same emptiness this whole
 * file exists to refuse.
 *
 * The TAP reporter names each pass, and the name is what differs: the empty
 * file's only `ok 1 - …` carries the FILE's name, a real one carries the test
 * names. That is the witness (§36) — a run whose every passing name is the
 * file it ran proves nothing ran.
 */
function nodeTestRun(
  root: string,
  file: string,
): Readonly<{ status: number | null; output: string; passedNames: readonly string[] }> {
  // THE TIMEOUT IS NOT OPTIONAL, AND VITEST'S OWN CANNOT SUBSTITUTE FOR IT.
  // `spawnSync` blocks the thread, so a child that never exits is a run that
  // never returns — `testTimeout` is a timer on an event loop this call is not
  // yielding to, and it can neither fire nor interrupt. The failure mode is a
  // hang rather than a false pass, which is the better of the two, but this
  // suite judges wall clock and a hang takes the whole run with it. `SIGKILL`
  // rather than the default `SIGTERM`: a spinning child never reaches a
  // handler, which this workspace has already measured once.
  const result = spawnSync(
    "node",
    ["--experimental-strip-types", "--test", "--test-reporter=tap", file],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      killSignal: "SIGKILL",
    },
  );
  if (result.error !== undefined) {
    throw new Error(
      `node --test ${file} in ${root} did not complete: ${result.error.message}. A killed or ` +
        `un-launched child produces no TAP, and reading "no passing names" off one would be a ` +
        `crash reported as a domain answer.`,
    );
  }
  const output = `${result.stdout}${result.stderr}`;
  const passedNames = output
    .split("\n")
    .map((line) => /^ok \d+ - (?<name>.+?)(?: # .*)?$/u.exec(line)?.groups?.["name"])
    .filter((name): name is string => name !== undefined);
  return { status: result.status, output, passedNames };
}

/** The passing names that are not just the file reporting itself. */
function ranSomething(file: string, passedNames: readonly string[]): boolean {
  const base = file.split("/").at(-1) ?? file;
  return passedNames.some((name) => name !== base && name !== file);
}

describe("every test file this repository holds is executed by something", () => {
  /**
   * ── THE DEFECT, MEASURED ────────────────────────────────────────────────
   *
   * `scripts/harness-root/merge-round.test.mjs` — 19 tests over the merge
   * tool's ordering, conflict resolution, staging-then-promote, the
   * missing-issues rejection and the concurrent lock — HAS NEVER RUN in this
   * repository. Two independent reasons, and either alone is enough: every
   * runner glob is `tests/<dir>/**\/*.test.ts`, which selects neither the
   * directory nor the extension; and the file is written against `node:test`,
   * which vitest cannot execute even if a glob reached it. It looked like
   * coverage from every angle except the one that matters.
   *
   * ── WHY THE REPAIR IS A BRIDGE AND NOT A PORT ───────────────────────────
   *
   * Rewriting 348 lines into vitest would put a second owner beside the file
   * it copies, and two owners of one invariant is the defect this suite keeps
   * finding. Driving the incumbent where it stands keeps ONE owner. Measured
   * before committing to it: the whole file runs in 1.0 s, so admitting it
   * costs the run nothing it has to buy back from a budget.
   *
   * ── WHY THIS FILE AND NOT A NEW ONE ─────────────────────────────────────
   *
   * Searched: `declared-pattern-liveness.test.ts` (here) owns "every declared
   * file-selecting pattern is live" — a pattern that selects nothing. This is
   * the mirror of the same invariant, over the same declaration
   * (`TEST_INCLUDE`) and the same matcher: a FILE that no pattern selects. A
   * reader asking "is my test actually being run" lands here.
   * `tracked-source-owner.test.ts` asks whether the index and the ignore rules
   * agree about a path — this file is in the index and correctly so.
   * `declared-root-inventory.test.ts` is depth-1 over the root. Neither could
   * have failed on this, and neither can be widened to it without taking this
   * file's name.
   */
  test("no test file is selected by no runner pattern and executed by nobody", () => {
    const tests = trackedTestFiles(WEB_ROOT);
    // POPULATION AS RUNTIME NUMBERS. A universe that collapsed would report
    // "no orphans" for the wrong reason, and that is the shape this whole
    // file exists to refuse.
    expect(tests.length, "the index yielded no test file at all").toBeGreaterThan(300);
    const selected = new Set(TEST_INCLUDE.flatMap((pattern) => globSync(pattern, { cwd: WEB_ROOT })));
    expect(selected.size, "the runner globs selected nothing").toBeGreaterThan(300);

    const orphans = tests.filter((file) => !selected.has(file));
    // EVERY ORPHAN IS DRIVEN HERE, which is what makes this an execution
    // guarantee rather than a census. An orphan that cannot be run this way is
    // a red, and the message says the two ways out.
    for (const orphan of orphans) {
      const run = nodeTestRun(WEB_ROOT, orphan);
      expect(
        run.status,
        `${orphan} is matched by no runner pattern, so vitest never sees it, and running it as ` +
          `a node:test file did not succeed either — so nothing in this repository executes it ` +
          `and its assertions are decoration. Either move it under a declared glob in ` +
          `tests/test-include.ts, or make it pass as a node:test file:\n${run.output}`,
      ).toBe(0);
      // …and it must actually have RUN something. Driven: `node --test` over a
      // file declaring nothing exits 0 and reports `pass 1`, because the file
      // is the subtest — so only a passing NAME that is not the file's own is
      // evidence that anything executed.
      expect(
        ranSomething(orphan, run.passedNames),
        `${orphan} ran green while declaring no test of its own, so its green is about the ` +
          `file loading and not about anything being checked:\n${run.output}`,
      ).toBe(true);
    }
  });

  test("PLANT: the runner this arm uses reports a FAILING orphan rather than passing it", () => {
    // Without this, a repository with no orphans exercises the loop above zero
    // times and the arm is inert — the wired-but-inert shape, in a guard whose
    // whole subject is things that silently do not run.
    const dir = createTempDir("orphan-runner-");
    const failing = join(dir, "orphan.test.mjs");
    writeFileSync(
      failing,
      'import test from "node:test";\nimport assert from "node:assert/strict";\n' +
        'test("planted", () => { assert.equal(1, 2); });\n',
    );
    const failed = nodeTestRun(dir, "orphan.test.mjs");
    expect(failed.status, "a node:test file with a failing assertion exited 0").not.toBe(0);

    // The control: the same runner over a passing file answers the other way,
    // so the assertion above is about the failure and not about a runner that
    // always fails.
    const passing = join(dir, "ok.test.mjs");
    writeFileSync(passing, 'import test from "node:test";\ntest("planted", () => {});\n');
    const ok = nodeTestRun(dir, "ok.test.mjs");
    expect(ok.status).toBe(0);
    expect(ok.passedNames).toContain("planted");
    expect(ranSomething("ok.test.mjs", ok.passedNames)).toBe(true);

    // AND THE EMPTY FILE — the reason the arm above judges NAMES and not the
    // exit code or the pass count. Driven here rather than assumed: a file
    // declaring nothing exits 0 and reports `pass 1`, and the one name it
    // passes is the file itself.
    const empty = join(dir, "empty.test.mjs");
    writeFileSync(empty, "// no tests here\n");
    const none = nodeTestRun(dir, "empty.test.mjs");
    expect(none.status).toBe(0);
    expect(none.passedNames).toEqual(["empty.test.mjs"]);
    expect(ranSomething("empty.test.mjs", none.passedNames)).toBe(false);
  }, 120_000);
});
