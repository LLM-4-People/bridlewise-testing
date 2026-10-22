/**
 * THE REPRODUCTION DOOR'S JUDGEMENT (src/workflow/flake-cli.ts `reproduceFlake`,
 * `recordIdentityMove`, `parseFlakeReproduceArgs`, `parseFlakeMoveArgs`) and
 * the records it writes (src/shared/flake-reproduction.ts): a test that failed
 * on the fix's parent and passed on the fix is recorded with the digest it
 * failed with, under the one set of conditions both sides ran under, and the
 * record then explains its ledger failures in the verdict; a statistical
 * reproduction runs each side N times and needs one parent failure and N fix
 * passes; a test that passed on the parent, failed on the fix, did not run or
 * merely vanished is refused; a fix that changed no declared cause's meaning
 * runs nothing; a move is recorded only when the inventories show it; a
 * credential-named environment entry never reaches a record; a record the
 * schema refuses, or one filed under another key, is reported and ignored.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { declaredCauseFixes } from "../../src/git/flake-cause-fixes.ts";
import { configuredGitRepository } from "../../src/git/worktree-port.ts";
import { claimLooks, reproducedDigests, flakeAttemptDirectory, flakeAttemptFileName, flakeReproductionDirectory, flakeReproductionFileName, noOpFixProbability, readFlakeAttempts, readFlakeReproductions, runsNeeded, serializeFlakeReproduction, type FlakeAttempt, type FlakeReproduction, type IdentityMove } from "../../src/shared/flake-reproduction.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import { flakyVerdictWithin } from "../../src/shared/run-history.ts";
import { appendFlakeAttempt, assertShimWorldConfined, createShimWorld, deterministicRuns, parseFlakeMoveArgs, parseFlakeReproduceArgs, recordableConditions, recordIdentityMove, reproduceFlake, shimEnvironment, statisticalRunsOf, type ReproductionAnswer, type ReproductionReport, type ReproductionRun, type ReproductionSettings } from "../../src/workflow/flake-cli.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";

const IDENTITY = "test/x.test.ts::counts every run";
const DIGEST = "0123456789abcdef";

function fixture(): Readonly<{ root: string; engineRoot: string; git: (...args: string[]) => string; commit: (files: Readonly<Record<string, string>>, message: string) => string }> {
  const root = createTempDir("flake-reproduce-");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...testGitIdentityEnvironment() } }).trim();
  git("init", "-q", "-b", "main");
  const commit = (files: Readonly<Record<string, string>>, message: string): string => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    git("add", "--", ...Object.keys(files));
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { root, engineRoot: join(root, "engine"), git, commit };
}

const request = (fix: string, identities: readonly string[] = [IDENTITY], extra: readonly string[] = []) =>
  parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", fix, ...identities.flatMap((identity) => ["--test", identity, "--cause", "engine/src/door.ts"]), "--env", "MARK=/somewhere", "--setup", "true", "--during", "sleep 1", ...extra]);

/** The fixtures' α, the shims they register, and the runs an all-failing parent needs at α without a registered shim (1/C(10,5) ≤ 0.01). */
const ALPHA = 0.01;
const SHIMS: readonly string[] = ["engine/test/support/shim.ts"];
const DETERMINISTIC = deterministicRuns(null, ALPHA, SHIMS);

/** What a door attempt wrote: its records (with their bytes), the outputs it kept and the attempts it logged — into the fixture's own log. */
type Door = Readonly<{ settings: ReproductionSettings; written: FlakeReproduction[]; kept: string[]; logged: FlakeAttempt[]; write: (record: FlakeReproduction, bytes: string) => string }>;

/** Attempt ids are unique across every door of this file, as the door's random ids are (an id two attempts claim proves neither). */
let nextAttempt = 0;

function door(repo: ReturnType<typeof fixture>, runs: number, load: () => number = () => 0.5): Door {
  const written: FlakeReproduction[] = [];
  const kept: string[] = [];
  const logged: FlakeAttempt[] = [];
  return {
    written, kept, logged,
    settings: {
      runs, preloadSha256: null, now: () => new Date("2026-10-08T00:00:00.000Z"), load, significance: ALPHA, deterministicShims: SHIMS,
      priorLooks: (identity, fix) => claimLooks(readFlakeAttempts(repo.engineRoot).looks, identity, fix),
      attemptId: () => (nextAttempt += 1).toString(16).padStart(32, "0"),
      keepOutput: (output) => { kept.push(output); return sha256(output); },
      appendAttempt: (attempt) => { logged.push(attempt); appendFlakeAttempt(repo.engineRoot, attempt); },
    },
    write: (record, bytes) => {
      written.push(record);
      const directory = flakeReproductionDirectory(repo.engineRoot);
      mkdirSync(directory, { recursive: true });
      const path = join(directory, flakeReproductionFileName(record.identity, record.fix.commit));
      writeFileSync(path, bytes);
      return path;
    },
  };
}

/** A run that answers `report` and printed `output`. */
const ran = (report: ReproductionReport, output = "ran\n"): ReproductionRun => ({ report, output });

test("a test that FAILED on the parent EVERY run and PASSED on the fix every run is recorded with its digest, the attempt is LOGGED with every run's output kept — and the record then explains its ledger failures", async () => {
  const repo = fixture();
  repo.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n" }, "init");
  const brokenTree = repo.git("rev-parse", "HEAD^{tree}");
  const fix = repo.commit({ "engine/src/door.ts": "fixed\n" }, `fix\n\nFlake-cause: ${IDENTITY} => engine/src/door.ts`);
  const fixedTree = repo.git("rev-parse", "HEAD^{tree}");
  const ranOn: string[] = [];
  const at = door(repo, DETERMINISTIC);
  const answers = await reproduceFlake(request(fix), configuredGitRepository({}, repo.root), (file) => `engine/${file}`,
    async (revision, files) => {
      ranOn.push(`${revision}:${files.join(",")}`);
      return ran(revision === "parent" ? { [IDENTITY]: { outcome: "failed", digest: DIGEST, location: null } } : { [IDENTITY]: { outcome: "passed" } }, `${revision} run ${String(ranOn.length)}\n`);
    },
    at.write, at.settings);
  assert.equal(DETERMINISTIC, 5, "an all-failing parent needs 5 runs per side at α 0.01 (1/252)");
  assert.deepEqual(ranOn, [...Array.from({ length: DETERMINISTIC }, () => "parent:test/x.test.ts"), ...Array.from({ length: DETERMINISTIC }, () => "fix:test/x.test.ts")], "the parent first, then the fix, each the test's own file");
  assert.ok("recorded" in answers[0]!);
  const written = at.written[0]!;
  assert.deepEqual(written.parentRuns, { failed: { [DIGEST]: DETERMINISTIC }, locations: { [DIGEST]: [""] }, passed: 0, loads: Array.from({ length: DETERMINISTIC }, () => 0.5) });
  assert.deepEqual(written.fixRuns, { passed: DETERMINISTIC, loads: Array.from({ length: DETERMINISTIC }, () => 0.5) });
  assert.equal(written.mode, "deterministic");
  assert.equal(written.parent.commit, repo.git("rev-parse", `${fix}^`));
  assert.deepEqual(written.conditions, { environment: { MARK: "/somewhere" }, setup: "true", during: "sleep 1", preload: null, seed: null, onlyNamed: false }, "ONE set of conditions, both sides");
  // THE ATTEMPT: logged once, with every run's output by digest and the record's bytes by digest.
  assert.equal(at.logged.length, 1);
  assert.equal(at.logged[0]!.attempt, written.attempt);
  assert.deepEqual(at.logged[0]!.outputs.map((output) => output.sha256), at.kept.map((output) => sha256(output)));
  assert.equal(at.kept.length, 2 * DETERMINISTIC, "every run's output is kept");
  assert.deepEqual(at.logged[0]!.outcomes, [{ identity: IDENTITY, recorded: sha256(readFileSync(answers[0]!.recorded as string, "utf8")) }]);
  const evidence = await declaredCauseFixes(configuredGitRepository({}, repo.root), (file) => `engine/${file}`, repo.engineRoot, { flakeReproduction: { statisticalRuns: 4, significance: ALPHA, deterministicShims: SHIMS }, suites: null });
  const verdict = flakyVerdictWithin([
    { timestamp: "2026-10-07T20:00:00.000Z", failures: [IDENTITY], treeId: brokenTree, digests: { [IDENTITY]: DIGEST } },
    { timestamp: "2026-10-07T22:00:00.000Z", failures: [], treeId: fixedTree },
  ], 10, undefined, [], evidence)!;
  assert.deepEqual(verdict.reds, []);
  assert.equal(verdict.fixed.length, 1);
});

test("ONE RUN PER SIDE is strong only for a deterministic SHIM (--preload); without one a single run is refused — and the refusal is LOGGED like a record", async () => {
  const repo = fixture();
  repo.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n", "engine/test/support/shim.ts": "throw 1;\n" }, "init");
  const fix = repo.commit({ "engine/src/door.ts": "fixed\n" }, "fix");
  const once = async (extra: readonly string[]): Promise<Door & { answer: ReproductionAnswer }> => {
    const at = door(repo, 1);
    const [answer] = await reproduceFlake(request(fix, [IDENTITY], extra), configuredGitRepository({}, repo.root), (file) => `engine/${file}`,
      async (revision) => ran(revision === "parent" ? { [IDENTITY]: { outcome: "failed", digest: DIGEST, location: null } } : { [IDENTITY]: { outcome: "passed" } }),
      at.write, { ...at.settings, preloadSha256: extra.length === 0 ? null : "e".repeat(64) });
    return { ...at, answer: answer! };
  };
  const bare = await once([]);
  assert.match((bare.answer as { refused: string }).refused, /probability 0\.500, above α 0\.01: at this failure rate 5 runs per side are needed \(one run per side is strong only for a deterministic shim registered in testExecution\.flakeReproduction\.deterministicShims\)/u);
  assert.equal(bare.written.length, 0);
  assert.deepEqual(bare.logged.map((attempt) => attempt.outcomes), [[{ identity: IDENTITY, refused: (bare.answer as { refused: string }).refused }]], "a refused attempt is logged too");
  assert.equal(deterministicRuns("engine/test/support/shim.ts", ALPHA, SHIMS), 1);
  assert.equal(deterministicRuns("engine/test/support/unregistered.ts", ALPHA, SHIMS), DETERMINISTIC, "a preload config does not register is no shim: an all-failing parent's runs (design 8b)");
  const shim = await once(["--preload", "engine/test/support/shim.ts"]);
  assert.ok("recorded" in shim.answer, JSON.stringify(shim.answer));
  assert.equal(readFlakeAttempts(repo.engineRoot).attempts.length, 2, "both attempts are kept");
});

test("a test that PASSED on the parent, FAILED on the fix, DID NOT RUN, or did not fail EVERY run of a deterministic reproduction is refused — nothing is recorded, the attempt is logged", async () => {
  const repo = fixture();
  repo.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n" }, "init");
  const fix = repo.commit({ "engine/src/door.ts": "fixed\n" }, "fix");
  const outcomes: Record<string, readonly [ReproductionReport, ReproductionReport]> = {
    "passed on the parent": [{ [IDENTITY]: { outcome: "passed" } }, { [IDENTITY]: { outcome: "passed" } }],
    "failed on the fix": [{ [IDENTITY]: { outcome: "failed", digest: DIGEST, location: null } }, { [IDENTITY]: { outcome: "failed", digest: DIGEST, location: null } }],
    "did not run": [{}, { [IDENTITY]: { outcome: "passed" } }],
    "skipped on the fix": [{ [IDENTITY]: { outcome: "failed", digest: DIGEST, location: null } }, { [IDENTITY]: { outcome: "skipped" } }],
  };
  for (const [what, [parent, fixed]] of Object.entries(outcomes)) {
    const at = door(repo, DETERMINISTIC);
    const answers = await reproduceFlake(request(fix), configuredGitRepository({}, repo.root), (file) => `engine/${file}`,
      async (revision) => ran(revision === "parent" ? parent : fixed), () => assert.fail(`${what}: nothing is written`), at.settings);
    assert.ok("refused" in answers[0]!, what);
    assert.equal(at.logged.length, 1, `${what}: the attempt is logged`);
  }
  // A run in which the test did not run at all (its file errored before it): the parent's tally does not add up (correctness F-L5).
  const absent = door(repo, DETERMINISTIC);
  let absentRuns = 0;
  const skipped = await reproduceFlake(request(fix), configuredGitRepository({}, repo.root), (file) => `engine/${file}`, async (revision) => {
    if (revision === "parent") absentRuns += 1;
    return ran(revision === "parent" && absentRuns === 3 ? {} : revision === "parent" ? { [IDENTITY]: { outcome: "failed", digest: DIGEST, location: null } } : { [IDENTITY]: { outcome: "passed" } });
  }, () => assert.fail("a parent that did not run every time records nothing"), absent.settings);
  assert.match((skipped[0] as { refused: string }).refused, /on the parent it did not run every time/u);
  assert.equal(absent.logged.length, 1, "and the refused attempt is logged");
  const at = door(repo, DETERMINISTIC);
  let parentRuns = 0;
  const once = await reproduceFlake(request(fix), configuredGitRepository({}, repo.root), (file) => `engine/${file}`, async (revision) => {
    if (revision === "parent") parentRuns += 1;
    return ran(revision === "parent" && parentRuns === 1 ? { [IDENTITY]: { outcome: "failed", digest: DIGEST, location: null } } : { [IDENTITY]: { outcome: "passed" } });
  }, () => assert.fail("a parent that failed once of five is not deterministic"), at.settings);
  assert.match((once[0] as { refused: string }).refused, /a deterministic reproduction fails every run — reproduce the condition with --statistical/u);
});

test("A RUN THAT ENDS THE ATTEMPT EARLY is logged, every test refused with why, and the error still reaches the caller", async () => {
  const repo = fixture();
  repo.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n" }, "init");
  const fix = repo.commit({ "engine/src/door.ts": "fixed\n" }, "fix");
  const at = door(repo, DETERMINISTIC);
  await assert.rejects(reproduceFlake(request(fix), configuredGitRepository({}, repo.root), (file) => `engine/${file}`,
    async () => { throw new Error("the setup failed"); }, () => assert.fail("nothing is written"), at.settings), /the setup failed/u);
  assert.deepEqual(at.logged.map((attempt) => attempt.outcomes), [[{ identity: IDENTITY, refused: "the attempt ended before its runs were done: the setup failed" }]]);
});

test("AN ATTEMPT KEEPS NO HOME DIRECTORY (#238): a refusal that names this home or any /home/<name> is kept with `~`, in the record and in its bytes", async () => {
  const repo = fixture();
  repo.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n" }, "init");
  const fix = repo.commit({ "engine/src/door.ts": "fixed\n" }, "fix");
  const at = door(repo, DETERMINISTIC);
  const why = `setup failed; full output (9 bytes): ${homedir()}/.cache/run/log.txt and /home/jdoe/x`;
  await assert.rejects(reproduceFlake(request(fix), configuredGitRepository({}, repo.root), (file) => `engine/${file}`,
    async () => { throw new Error(why); }, () => assert.fail("nothing is written"), at.settings), /setup failed/u);
  assert.deepEqual(at.logged.map((attempt) => attempt.outcomes), [[{ identity: IDENTITY, refused: "the attempt ended before its runs were done: setup failed; full output (9 bytes): ~/.cache/run/log.txt and ~/x" }]]);
  for (const name of readdirSync(flakeAttemptDirectory(repo.engineRoot))) {
    const bytes = readFileSync(join(flakeAttemptDirectory(repo.engineRoot), name), "utf8");
    assert.equal(bytes.includes(homedir()), false, "the kept attempt names no home directory");
    assert.equal(bytes.includes("/home/"), false);
  }
});

test("A SKIP ROW THAT MERELY VANISHED ON THE FIX IS REFUSED: absence is not a pass (a moved test is recorded by `harness flake move`)", async () => {
  const repo = fixture();
  const skipped = `${IDENTITY} (skipped)`;
  repo.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n" }, "init");
  const fix = repo.commit({ "engine/src/door.ts": "fixed\n" }, "fix");
  const answer = async (fixRun: ReproductionReport) => (await reproduceFlake(request(fix, [skipped]), configuredGitRepository({}, repo.root), (file) => `engine/${file}`,
    async (revision) => ran(revision === "parent" ? { [skipped]: { outcome: "failed", digest: DIGEST, location: null } } : fixRun), (record) => record.identity, door(repo, DETERMINISTIC).settings))[0]!;
  assert.ok("refused" in await answer({ "test/x.test.ts::another": { outcome: "passed" } }), "the file ran on the fix and the skip row is merely gone");
  assert.ok("refused" in await answer({}), "the file did not run on the fix: nothing is shown");
  assert.ok("refused" in await answer({ [skipped]: { outcome: "failed", digest: DIGEST, location: null } }), "still skipped on the fix");
});

test("A STATISTICAL REPRODUCTION runs each side N times under the same conditions: STRONG counts are recorded with the loads; weak ones are refused with the runs their rate needs (the 1-in-N lottery is gone); zero parent failures, or one fix failure, records nothing", async () => {
  const repo = fixture();
  repo.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n" }, "init");
  const fix = repo.commit({ "engine/src/door.ts": "fixed\n" }, "fix");
  const runs = 8;
  const statistical = request(fix, [IDENTITY], ["--statistical", "--seed", "7"]);
  const failingParent = (fails: (run: number) => boolean) => {
    let parentRun = 0;
    return async (revision: "parent" | "fix"): Promise<ReproductionRun> => {
      if (revision === "parent") parentRun += 1;
      return ran(revision === "parent" && fails(parentRun) ? { [IDENTITY]: { outcome: "failed", digest: DIGEST, location: null } } : { [IDENTITY]: { outcome: "passed" } });
    };
  };
  const strong = door(repo, runs, (() => { let load = 0; return () => (load += 1); })());
  const answers = await reproduceFlake(statistical, configuredGitRepository({}, repo.root), (file) => `engine/${file}`, failingParent((run) => run <= 6), strong.write, strong.settings);
  assert.ok("recorded" in answers[0]!, JSON.stringify(answers[0]));
  assert.equal(strong.written[0]!.mode, "statistical");
  assert.deepEqual(strong.written[0]!.parentRuns, { failed: { [DIGEST]: 6 }, locations: { [DIGEST]: [""] }, passed: 2, loads: [1, 2, 3, 4, 5, 6, 7, 8] });
  assert.deepEqual(strong.written[0]!.fixRuns, { passed: 8, loads: [9, 10, 11, 12, 13, 14, 15, 16] });
  assert.equal(strong.written[0]!.conditions.seed, "7");
  const weak = door(repo, runs);
  const once = await reproduceFlake(statistical, configuredGitRepository({}, repo.root), (file) => `engine/${file}`, failingParent((run) => run === 2), () => assert.fail("1 of 8 is weak"), weak.settings);
  // The second look at this (test, fix) — the strong one above was the first — is judged at α / 2.
  assert.match((once[0] as { refused: string }).refused, /probability 0\.500, above α 0\.01 over 2 attempts of this test and fix \(0\.00500\): at this failure rate \d+ runs per side are needed/u);
  assert.equal(weak.logged.length, 1, "the weak attempt is logged: re-running until lucky leaves a trail");
  const neverRan: string[] = [];
  const never = await reproduceFlake(statistical, configuredGitRepository({}, repo.root), (file) => `engine/${file}`,
    async (revision) => { neverRan.push(revision); return ran({ [IDENTITY]: { outcome: "passed" } }); }, () => assert.fail("zero parent failures records nothing"), door(repo, runs).settings);
  assert.match((never[0] as { refused: string }).refused, /failed 0 and passed 8 of 8 run\(s\): nothing was reproduced/u);
  assert.deepEqual(neverRan, Array.from({ length: runs }, () => "parent"), "a parent that reproduced nothing makes no fix run");
  const fixRuns = { count: 0 };
  const flaky = await reproduceFlake(statistical, configuredGitRepository({}, repo.root), (file) => `engine/${file}`, async (revision) => {
    if (revision === "parent") return ran({ [IDENTITY]: { outcome: "failed", digest: DIGEST, location: null } });
    fixRuns.count += 1;
    return ran(fixRuns.count === 3 ? { [IDENTITY]: { outcome: "failed", digest: DIGEST, location: null } } : { [IDENTITY]: { outcome: "passed" } });
  }, () => assert.fail("one fix failure records nothing"), door(repo, runs).settings);
  assert.match((flaky[0] as { refused: string }).refused, /the fix is not shown/u);
});

test("THE NO-OP PROBABILITY is the one-sided Fisher exact probability, and the runs a rate needs follow from it", () => {
  assert.equal(noOpFixProbability(1, 1), 0.5);
  assert.equal(noOpFixProbability(5, 5), 1 / 252);
  assert.equal(noOpFixProbability(1, 10), 0.5);
  assert.ok(Math.abs(noOpFixProbability(7, 30) - 0.00527) < 0.00001, "the custody record: 7 of 30 against 0 of 30 (C(30,7)/C(60,7))");
  assert.equal(noOpFixProbability(0, 10), 1, "nothing failed: a no-op shows that always");
  assert.equal(runsNeeded(1, 0.01), 5);
  assert.equal(runsNeeded(0, 0.01), Number.POSITIVE_INFINITY);
  const half = runsNeeded(0.5, 0.01);
  assert.ok(noOpFixProbability(Math.ceil(0.5 * half), half) <= 0.01 && noOpFixProbability(Math.ceil(0.5 * (half - 1)), half - 1) > 0.01, "the smallest such N");
});

test("A FIX THAT CHANGED NO DECLARED CAUSE'S MEANING runs nothing: an untouched cause, and the test file's own comment or layout edit, are refused by name", async () => {
  const repo = fixture();
  repo.commit({ "engine/test/x.test.ts": "await tick();\n", "engine/src/door.ts": "same\n" }, "init");
  const fix = repo.commit({ "engine/test/x.test.ts": "// one tick\nawait tick( );\n" }, "edit the test's layout only");
  const refuse = async (causes: string): Promise<void> => {
    await assert.rejects(
      reproduceFlake(parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", fix, "--test", IDENTITY, "--cause", causes]),
        configuredGitRepository({}, repo.root), (file) => `engine/${file}`, async () => assert.fail("nothing runs"), () => assert.fail("nothing is written"), door(repo, 1).settings),
      (error: unknown) => (error as { code?: string }).code === "flake_reproduction_cause_cosmetic" && /comment or layout only|unchanged/u.test((error as Error).message),
    );
  };
  await refuse("engine/src/door.ts");
  await refuse("engine/test/x.test.ts");
});

test("A MOVE is recorded only when the inventories show it: on the hermetic suite at the parent, gone at the commit, its destination a live suite file", () => {
  const repo = fixture();
  const inventory = (tests: readonly (readonly [string, string])[], live: readonly string[]): string =>
    `${JSON.stringify({ tests: tests.map(([sourceId, name]) => ({ sourceId, name })), scope: { qualifiedExternalSourceIds: live } })}\n`;
  repo.commit({ [`engine/${VERIFICATION_PATHS.testInventory}`]: inventory([["test/x.test.ts", "counts every run"], ["test/x.test.ts", "stays"]], []) }, "before");
  const moved = repo.commit({ [`engine/${VERIFICATION_PATHS.testInventory}`]: inventory([["test/x.test.ts", "stays"]], ["live/x.test.ts"]) }, "move to the live suite");
  const written: IdentityMove[] = [];
  const move = (from: string, to: string): string => recordIdentityMove(parseFlakeMoveArgs(["move", "--suite", "engine", "--commit", moved, "--from", from, "--to", to]),
    configuredGitRepository({}, repo.root), "engine", (record) => { written.push(record); return record.from; }, () => new Date("2026-10-08T00:00:00.000Z"));
  assert.equal(move(IDENTITY, "live/x.test.ts::counts every run, live"), IDENTITY);
  assert.deepEqual(written[0], { schemaVersion: "bridlewise-identity-move/v1", suite: "engine", from: IDENTITY, to: "live/x.test.ts::counts every run, live", commit: moved, recordedAt: "2026-10-08T00:00:00.000Z" });
  for (const [what, from, to] of [
    ["it never was a hermetic test", "test/x.test.ts::never", "live/x.test.ts::never"],
    ["it is still a hermetic test", "test/x.test.ts::stays", "live/x.test.ts::stays"],
    ["the destination is no live suite file", IDENTITY, "test/elsewhere.test.ts::counts every run"],
  ] as const) {
    assert.throws(() => move(from, to), (error: unknown) => (error as { code?: string }).code === "flake_move_refused", what);
  }
  assert.throws(() => parseFlakeMoveArgs(["move", "--suite", "web", "--commit", moved, "--from", IDENTITY, "--to", "live/x.test.ts::y"]), /only the engine has a live suite/u);
  assert.throws(() => parseFlakeMoveArgs(["move", "--suite", "engine", "--commit", moved, "--from", IDENTITY]), /are required/u);
});

test("the request: a door-owned variable is refused, a credential is REDACTED in the record (UR-21) but reaches the run, every flag is required, an unknown flag is refused", () => {
  assert.equal(parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts", "--env", "PROBE_TOOL_HOME=/a/folder"]).environment.PROBE_TOOL_HOME, "/a/folder", "a folder setting is not a credential");
  for (const name of ["HOME", "TMPDIR", "FLAKE_REPRODUCTION_OUTPUT", "GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_PARAMETERS", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "HARNESS_KEY_HOME", "HARNESS_EVIDENCE_HOME"]) {
    assert.throws(() => parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts", "--env", `${name}=/somewhere`]),
      (error: unknown) => (error as { code?: string }).code === "flake_reproduction_variable_owned", name);
  }
  const secret = parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts",
    "--env", "OPENAI_API_KEY=x", "--env", "PLAIN=sk-abcdefghijklmnopqrstuvwxyz123456",
    "--setup", "export X_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456; true", "--during", "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456' x"]);
  assert.equal(secret.environment.OPENAI_API_KEY, "x", "the run gets the real value");
  const recorded = recordableConditions(secret, null);
  assert.equal(recorded.environment.OPENAI_API_KEY, "[REDACTED:credential]");
  assert.doesNotMatch(JSON.stringify(recorded), /sk-abcdefghijklmnopqrstuvwxyz123456/u, "no credential reaches the record (D-09)");
  assert.match(recorded.setup!, /\[REDACTED:/u);
  assert.match(recorded.during!, /\[REDACTED:/u);
  assert.throws(() => parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--test", IDENTITY, "--cause", "a.ts"]));
  assert.throws(() => parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", "abc1234", "--test", IDENTITY]), /each followed by its --cause/u, "a test without its cause");
  assert.throws(() => parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", "abc1234", "--cause", "a.ts", "--test", IDENTITY]), /each --cause follows its own --test/u, "a cause before any test");
  assert.deepEqual(parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", "abc1234", "--test", "a::x", "--cause", "p.ts", "--test", "b::y", "--cause", "q.ts,r.ts"]).tests,
    [{ identity: "a::x", causes: ["p.ts"] }, { identity: "b::y", causes: ["q.ts", "r.ts"] }]);
  assert.throws(() => parseFlakeReproduceArgs(["reproduce", "--suite", "both", "--test", IDENTITY, "--cause", "a.ts", "--fix", "abc1234"]));
  assert.throws(() => parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--test", IDENTITY, "--cause", "a.ts", "--fix", "abc1234", "--rerun", "x"]));
  assert.throws(() => parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts", "--statistical"]),
    (error: unknown) => (error as { code?: string }).code === "flake_reproduction_statistical_unconditioned", "a statistical reproduction without a condition is a rerun lottery");
  assert.equal(parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts", "--statistical", "--preload", "engine/test/support/shim.ts"]).statistical, true, "a preloaded shim is a condition");
  assert.throws(() => parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts", "--seed", "-1"]), /--seed takes/u);
  // The web runner takes a preload too, pinned like the engine's (the door sets NODE_OPTIONS); a request's own NODE_OPTIONS is door-owned (design 8c).
  assert.equal(parseFlakeReproduceArgs(["reproduce", "--suite", "web", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts", "--preload", "shim.ts"]).preload, "shim.ts");
  assert.throws(() => parseFlakeReproduceArgs(["reproduce", "--suite", "web", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts", "--env", "NODE_OPTIONS=--import=./shim.ts"]), /the door owns|door-owned|owns/u);
  assert.equal(parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts", "--only-named"]).onlyNamed, true, "only the named tests: a recorded condition");
  assert.throws(() => parseFlakeReproduceArgs(["reproduce", "--suite", "web", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts", "--only-named"]), /the engine runner's/u);
  const conditioned = parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts", "--during", "hog", "--statistical", "--seed", "3", "--preload", "engine/test/support/shim.ts"]);
  assert.deepEqual([conditioned.statistical, conditioned.seed, conditioned.preload, conditioned.during], [true, "3", "engine/test/support/shim.ts", "hog"]);
  // --runs: a statistical record's N above the configured one (a rarer race takes more runs to show); never fewer.
  assert.equal(parseFlakeReproduceArgs(["reproduce", "--suite", "web", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts", "--during", "churn", "--statistical", "--runs", "30"]).runs, 30);
  assert.equal(conditioned.runs, null, "no --runs: the configured N");
  assert.throws(() => parseFlakeReproduceArgs(["reproduce", "--suite", "web", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts", "--runs", "30"]), /it takes --statistical/u);
  for (const bad of ["0", "-3", "x", "12345"]) {
    assert.throws(() => parseFlakeReproduceArgs(["reproduce", "--suite", "web", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts", "--during", "churn", "--statistical", "--runs", bad]), /--runs takes a positive integer/u, bad);
  }
  const configured = { flakeReproduction: { statisticalRuns: 10, significance: ALPHA, deterministicShims: SHIMS } };
  assert.equal(statisticalRunsOf({ runs: null }, configured), 10);
  assert.equal(statisticalRunsOf({ runs: 30 }, configured), 30);
  assert.throws(() => statisticalRunsOf({ runs: 9 }, configured), (error: unknown) => (error as { code?: string }).code === "flake_reproduction_too_few_runs");
});

test("a record counts ONLY when an attempt the door kept recorded exactly its bytes: one the schema refuses, one filed under another key, one written by hand, one edited after, one from before the log are reported and explain nothing; an edited attempt is refused alone", () => {
  const repo = fixture();
  const directory = flakeReproductionDirectory(repo.engineRoot);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "not-json.json"), "{");
  writeFileSync(join(directory, "wrong-shape.json"), JSON.stringify({ schemaVersion: "x" }));
  const good = (identity: string, attempt: string): FlakeReproduction => ({
    schemaVersion: "bridlewise-flake-reproduction/v3", attempt,
    identity, suite: "engine", paths: ["engine/test/x.test.ts", "engine/src/door.ts"], causes: ["engine/src/door.ts"],
    fix: { commit: "a".repeat(40), contentDigest: "b".repeat(64) }, parent: { commit: "c".repeat(40), contentDigest: "d".repeat(64) },
    conditions: { environment: {}, setup: null, during: null, preload: null, seed: null, onlyNamed: false }, mode: "deterministic", runs: 5,
    parentRuns: { failed: { [DIGEST]: 5 }, locations: { [DIGEST]: [""] }, passed: 0, loads: [0, 0, 0, 0, 0] }, fixRuns: { passed: 5, loads: [0, 0, 0, 0, 0] }, recordedAt: "2026-10-08T00:00:00.000Z",
  });
  const logged = (record: FlakeReproduction, edit: (bytes: string) => string = (bytes) => bytes): void => {
    const bytes = edit(serializeFlakeReproduction(record));
    writeFileSync(join(directory, flakeReproductionFileName(record.identity, record.fix.commit)), bytes);
    appendFlakeAttempt(repo.engineRoot, {
      schemaVersion: "bridlewise-flake-attempt/v2", attempt: record.attempt, suite: "engine", fix: record.fix.commit, parent: record.parent.commit,
      conditions: record.conditions, mode: record.mode, runs: record.runs, outputs: [], outcomes: [{ identity: record.identity, recorded: sha256(bytes) }], recordedAt: record.recordedAt,
    });
  };
  const kept = good(IDENTITY, "1".repeat(32));
  logged(kept);
  writeFileSync(join(directory, "misnamed.json"), serializeFlakeReproduction(kept));
  // By hand: valid, well named, but no attempt recorded it.
  const byHand = good("test/x.test.ts::by hand", "2".repeat(32));
  writeFileSync(join(directory, flakeReproductionFileName(byHand.identity, byHand.fix.commit)), serializeFlakeReproduction(byHand));
  // Edited after its attempt: the log names other bytes.
  const edited = good("test/x.test.ts::edited", "3".repeat(32));
  logged(edited);
  writeFileSync(join(directory, flakeReproductionFileName(edited.identity, edited.fix.commit)), serializeFlakeReproduction({ ...edited, parentRuns: { ...edited.parentRuns, failed: { fedcba9876543210: 5 }, locations: { fedcba9876543210: [""] } } }));
  // From before the log (v2).
  const { attempt: _unused, ...old } = good("test/x.test.ts::old", "4".repeat(32));
  writeFileSync(join(directory, flakeReproductionFileName(old.identity, old.fix.commit)), `${JSON.stringify({ ...old, schemaVersion: "bridlewise-flake-reproduction/v2" })}\n`);
  // Logged by the door's own log, but naming a door-owned variable as a condition (a host HOME, a git variable): no record (security F-2).
  const owned = good("test/x.test.ts::owned", "5".repeat(32));
  // (The serializer refuses to write one; the door's log recorded the bytes such a writer would have made.)
  const withEnvironment = (entry: string) => (bytes: string): string => {
    assert.ok(bytes.includes('"environment":{}'), "the plant changes the conditions");
    return bytes.replace('"environment":{}', `"environment":{${entry}}`);
  };
  logged(owned, withEnvironment('"HOME":"/home/someone/.cache/home"'));
  const gitOwned = good("test/x.test.ts::git owned", "6".repeat(32));
  logged(gitOwned, withEnvironment('"GIT_CONFIG_GLOBAL":"/elsewhere"'));
  const read = readFlakeReproductions(repo.engineRoot);
  assert.deepEqual(read.records.map((record) => record.identity), [IDENTITY]);
  const why = Object.fromEntries(read.ignored.map((entry) => [entry.file.split("/").at(-1), entry.why]));
  assert.deepEqual(Object.keys(why).sort(), ["misnamed.json", "not-json.json", "wrong-shape.json", flakeReproductionFileName(byHand.identity, byHand.fix.commit), flakeReproductionFileName(edited.identity, edited.fix.commit), flakeReproductionFileName(old.identity, old.fix.commit), flakeReproductionFileName(owned.identity, owned.fix.commit), flakeReproductionFileName(gitOwned.identity, gitOwned.fix.commit)].sort());
  assert.match(why[flakeReproductionFileName(owned.identity, owned.fix.commit)]!, /names a variable the door owns/u);
  assert.match(why[flakeReproductionFileName(gitOwned.identity, gitOwned.fix.commit)]!, /names a variable the door owns/u);
  assert.match(why[flakeReproductionFileName(byHand.identity, byHand.fix.commit)]!, /no attempt the door kept recorded these bytes/u);
  assert.match(why[flakeReproductionFileName(edited.identity, edited.fix.commit)]!, /no attempt the door kept recorded these bytes/u);
  assert.match(why[flakeReproductionFileName(old.identity, old.fix.commit)]!, /before the door kept its attempt log/u);
  // An EDITED attempt is refused ALONE (its name is no longer its hash): every other attempt, and its records, still hold.
  const attempts = flakeAttemptDirectory(repo.engineRoot);
  const keptAttempt = readdirSync(attempts).find((name) => readFileSync(join(attempts, name), "utf8").includes(kept.attempt))!;
  const ownedAttempt = readdirSync(attempts).find((name) => readFileSync(join(attempts, name), "utf8").includes(owned.attempt))!;
  writeFileSync(join(attempts, ownedAttempt), readFileSync(join(attempts, ownedAttempt), "utf8").replace("2026-10-08T00:00:00.000Z", "2026-10-08T00:00:01.000Z"));
  const afterEdit = readFlakeAttempts(repo.engineRoot);
  assert.deepEqual(afterEdit.refused.map((entry) => [entry.file.split("/").at(-1), entry.why]), [[ownedAttempt, "its name is not the sha256 of its bytes: edited or renamed after the door named it"]]);
  assert.ok(afterEdit.attempts.some((attempt) => attempt.attempt === kept.attempt), "the other attempts still hold");
  assert.deepEqual(readFlakeReproductions(repo.engineRoot).records.map((record) => record.identity), [IDENTITY], "and so do their records");
  assert.ok(existsSync(join(attempts, keptAttempt)));
});

test("R3-2: TWO BRANCHES' ATTEMPTS ARE TWO FILES — their merge is the union and breaks nothing; an id two attempts claim proves neither", () => {
  const repo = fixture();
  const directory = flakeReproductionDirectory(repo.engineRoot);
  mkdirSync(directory, { recursive: true });
  const attempt = (id: string, identity: string, recordedAt: string): FlakeAttempt => ({
    schemaVersion: "bridlewise-flake-attempt/v2", attempt: id, suite: "engine", fix: "a".repeat(40), parent: "c".repeat(40),
    conditions: { environment: {}, setup: null, during: null, preload: null, seed: null, onlyNamed: false }, mode: "deterministic", runs: 5,
    outputs: [], outcomes: [{ identity, refused: "nothing was reproduced" }], recordedAt,
  });
  // Branch A and branch B each add an attempt on the same base, then both files are kept (any merge keeps both).
  appendFlakeAttempt(repo.engineRoot, attempt("1".repeat(32), "test/x.test.ts::a", "2026-10-08T00:00:01.000Z"));
  appendFlakeAttempt(repo.engineRoot, attempt("2".repeat(32), "test/x.test.ts::b", "2026-10-08T00:00:00.000Z"));
  const both = readFlakeAttempts(repo.engineRoot);
  assert.deepEqual(both.refused, []);
  assert.deepEqual(both.attempts.map((entry) => entry.attempt), ["2".repeat(32), "1".repeat(32)], "every attempt holds, in time order");
  for (const name of readdirSync(flakeAttemptDirectory(repo.engineRoot))) assert.equal(name, flakeAttemptFileName(readFileSync(join(flakeAttemptDirectory(repo.engineRoot), name), "utf8")), "each is named by its bytes");
  // A second attempt claiming an id already used: both are refused, by name.
  appendFlakeAttempt(repo.engineRoot, attempt("1".repeat(32), "test/x.test.ts::claimed", "2026-10-08T00:00:02.000Z"));
  const claimed = readFlakeAttempts(repo.engineRoot);
  assert.deepEqual(claimed.attempts.map((entry) => entry.attempt), ["2".repeat(32)]);
  assert.equal(claimed.refused.filter((entry) => entry.why === `another attempt claims its id ${"1".repeat(32)}`).length, 2);
});

test("S0: A SHIM NEVER REMOVES AN UNCONFINED PLACE — refused at the request, before anything runs", () => {
  for (const command of ['rm -rf "$HOME" && mkdir -p "$HOME/.local/state"', "rm -rf ~/.cache/x", "rm -r $SOMEWHERE", 'cd x && rm -Rf "${TARGET}/y"', 'HOME=$(mktemp -d); rm -rf "$HOME"']) {
    for (const flag of ["--setup", "--during"]) {
      assert.throws(() => parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts", flag, command]),
        (error: unknown) => (error as { code?: string }).code === "flake_reproduction_unconfined_removal", `${flag} ${command}`);
    }
  }
  assert.equal(parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", "abc1234", "--test", IDENTITY, "--cause", "a.ts",
    "--setup", 'mkdir -p "$HOME/.local/state" && W=$(mktemp -d) && rm -rf "$W/x"']).setup, 'mkdir -p "$HOME/.local/state" && W=$(mktemp -d) && rm -rf "$W/x"', "a removal under a folder the command made is confined");
});

test("S0: EVERY RUN GETS A FRESH WORLD under the temp root, and a planted override failure is refused before any shim runs", () => {
  const temporaryRoot = createTempDir("flake-world-root-");
  const harnessRoot = fileURLToPath(new URL("../../", import.meta.url));
  const world = createShimWorld(temporaryRoot, harnessRoot);
  const environment = shimEnvironment({ HOME: "/home/the-real-one", TMPDIR: "/tmp", GIT_DIR: "/caller/.git", GIT_INDEX_FILE: "/caller/index", PATH: "/usr/bin",
    XDG_DATA_HOME: "/home/the-real-one/.local/share", XDG_CONFIG_HOME: "/home/the-real-one/.config", XDG_STATE_HOME: "/home/the-real-one/.local/state",
    HARNESS_KEY_HOME: "/home/the-real-one/.local/state/keys", HARNESS_EVIDENCE_HOME: "/home/the-real-one/.local/share/evidence" }, request("abc1234"), world, join(world.root, "out.json"));
  for (const name of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "HARNESS_KEY_HOME", "HARNESS_EVIDENCE_HOME"]) assert.equal(environment[name], undefined, `the caller's ${name} is scrubbed: it would lead out of the fresh world`);
  assert.equal(environment.HOME, world.home);
  assert.equal(environment.TMPDIR, world.tmp);
  assert.equal(environment.GIT_DIR, undefined, "the caller's git environment never reaches a run");
  assert.equal(environment.GIT_INDEX_FILE, undefined);
  assert.equal(environment.PATH, "/usr/bin");
  const outside = createTempDir("flake-world-outside-");
  for (const [what, planted] of [
    ["HOME left as the caller's", { HOME: "/home/the-real-one", TMPDIR: world.tmp }],
    ["HOME unset", { TMPDIR: world.tmp }],
    ["HOME the world itself", { HOME: world.root, TMPDIR: world.tmp }],
    ["TMPDIR outside", { HOME: world.home, TMPDIR: outside }],
  ] as const) {
    assert.throws(() => assertShimWorldConfined(planted, world), (error: unknown) => (error as { code?: string }).code === "flake_shim_home_unconfined", what);
  }
  // The world's HOME replaced by a link out of it: the door's own environment is refused by what it resolves to.
  rmdirSync(world.home);
  symlinkSync(outside, world.home);
  assert.throws(() => shimEnvironment({}, request("abc1234"), world, join(world.root, "out.json")),
    (error: unknown) => (error as { code?: string }).code === "flake_shim_home_unconfined", "a HOME that resolves outside the world");
  assert.throws(() => createShimWorld(join(process.env.HOME ?? "/nonexistent", ".local", "state", "bridlewise-flake-world-probe"), harnessRoot),
    (error: unknown) => (error as { code?: string }).code === "flake_reproduction_temp_root_refused", "a temp root inside the safety floor");
});

test("EVERY LOOK COUNTS (design 8a, F-L2): a (test, fix) re-attempted is judged at α over its attempts — the refused ones included — so attempting until one passes never inflates the claim's error", async () => {
  const repo = fixture();
  repo.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n" }, "init");
  const fix = repo.commit({ "engine/src/door.ts": "fixed\n" }, "fix");
  const attempt = async (): Promise<ReproductionAnswer> => {
    const at = door(repo, DETERMINISTIC);
    const [answer] = await reproduceFlake(request(fix), configuredGitRepository({}, repo.root), (file) => `engine/${file}`,
      async (revision) => ran(revision === "parent" ? { [IDENTITY]: { outcome: "failed", digest: DIGEST, location: null } } : { [IDENTITY]: { outcome: "passed" } }), at.write, at.settings);
    return answer!;
  };
  // 5 of 5 against 0 of 5: p = 1/252 = 0.00397. The first look is judged at 0.01, the second at 0.005, the third at 0.0033.
  assert.ok("recorded" in await attempt(), "the first look");
  assert.ok("recorded" in await attempt(), "the second look (0.00397 ≤ 0.005)");
  const third = await attempt();
  assert.match((third as { refused: string }).refused, /above α 0\.01 over 3 attempts of this test and fix/u);
  // …and the verdict reads the record with the claim's looks: three, so its counts explain nothing now.
  const read = readFlakeReproductions(repo.engineRoot).records.find((record) => record.identity === IDENTITY)!;
  assert.equal(read.looks, 3);
  assert.ok("why" in reproducedDigests(read, 4, ALPHA, SHIMS), "a record whose claim was looked at three times is judged at α/3");
});

test("every kept attempt is a text file that ends with its newline, named by the sha256 of exactly those bytes (the candidate format a checkout certifies; round 13)", () => {
  const directory = flakeAttemptDirectory(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const names = readdirSync(directory).filter((name) => name.endsWith(".json"));
  assert.ok(names.length > 0, "the kept attempts are read");
  for (const name of names) {
    const text = readFileSync(join(directory, name), "utf8");
    assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), `${name} ends with one newline`);
    assert.equal(flakeAttemptFileName(text), name, `${name} is named by its bytes`);
  }
});

test("a look is every attempt the door wrote: one a later schema refuses is refused as a record but still counted as a look (every look counts)", () => {
  const engineRoot = createTempDir("flake-looks-");
  const directory = flakeAttemptDirectory(engineRoot);
  mkdirSync(directory, { recursive: true });
  // The door's bytes of an attempt written before NODE_OPTIONS became door-owned: intact, but refused by today's schema.
  const bytes = `${JSON.stringify({ attempt: "a".repeat(32), fix: "b".repeat(40), outcomes: [{ identity: IDENTITY, refused: "weak" }], conditions: { environment: { NODE_OPTIONS: "--import=./shim.ts" } } })}\n`;
  writeFileSync(join(directory, flakeAttemptFileName(bytes)), bytes);
  const read = readFlakeAttempts(engineRoot);
  assert.equal(read.attempts.length, 0, "it is no attempt today");
  assert.equal(read.refused.length, 1, "it is refused, by name");
  assert.equal(claimLooks(read.looks, IDENTITY, "b".repeat(40)), 1, "and it is still a look of its claim");
  assert.equal(claimLooks(read.looks, IDENTITY, "c".repeat(40)), 0, "of that claim only");
});
