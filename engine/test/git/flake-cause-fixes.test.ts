/**
 * DECLARED CAUSE FIXES AND THEIR RECORDED REPRODUCTIONS (src/git/flake-cause-fixes.ts,
 * src/shared/flake-reproduction.ts) and the flaky verdict's fix dimension
 * (src/shared/run-history.ts `flakyVerdictWithin`; the FLAKE-REPRO decision): a
 * `Flake-cause:` trailer explains a suspect only with a recorded reproduction
 * of that (test, fix), and only failures that measured the fix's parent bytes
 * at every declared path — the test's own file among them — AND said what the
 * reproduction saw there. A fix whose declared causes did not change MEANING
 * (a comment or layout edit, the test's own file included) explains nothing;
 * a statistical record explains only at the configured N; a test that left
 * the hermetic suite is explained only by a recorded move into the live
 * suite's manifest; a malformed trailer is refused at commit time and, in
 * history, reported and ignored.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { appendFlakeAttempt } from "../../src/workflow/flake-cli.ts";
import { randomBytes, sha256 } from "../../src/kernel/integrity.ts";
import { declaredCauseFixes, flakeCauseContentKeys, flakeCauseTrailerProblems, ignoredCauseEvidenceMessage, parseFlakeCause } from "../../src/git/flake-cause-fixes.ts";
import { configuredGitRepository } from "../../src/git/worktree-port.ts";
import {
  contentKeyDigest,
  FLAKE_ATTEMPT_SCHEMA_VERSION,
  FLAKE_REPRODUCTION_SCHEMA_VERSION,
  flakeReproductionDirectory,
  flakeReproductionFileName,
  IDENTITY_MOVE_SCHEMA_VERSION,
  identityMoveFileName,
  serializeFlakeReproduction,
  serializeIdentityMove,
  type FlakeReproduction,
} from "../../src/shared/flake-reproduction.ts";
import { flakyVerdictWithin, NO_CAUSE_EVIDENCE, type CauseEvidence, type RunFailureRows, type SuiteIdentities } from "../../src/shared/run-history.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";

const IDENTITY = "test/x.test.ts::counts every run";
const FAILED_SO = "0123456789abcdef";
const FAILED_OTHERWISE = "fedcba9876543210";

type Fixture = Readonly<{
  root: string;
  engineRoot: string;
  git: (...args: string[]) => string;
  commit: (files: Readonly<Record<string, string>>, message: string) => string;
  tree: () => string;
}>;

function repository(): Fixture {
  const root = createTempDir("flake-cause-");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...testGitIdentityEnvironment() } }).trim();
  git("init", "-q", "-b", "main");
  const commit = (files: Readonly<Record<string, string>>, message: string): string => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    git("add", "--", ...Object.keys(files));
    git("commit", "-s", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { root, engineRoot: join(root, "engine"), git, commit, tree: () => git("rev-parse", "HEAD^{tree}") };
}

/** How a planted record ran: deterministic (the parent failing every one of `DETERMINISTIC_RUNS`), or statistical with N runs and `hits` parent failures. */
type Ran = Readonly<{ mode: "deterministic" } | { mode: "statistical"; runs: number; hits: number }>;

/** The runs an all-failing parent needs at the fixtures' α (1/C(10,5) = 1/252 ≤ 0.01). */
const DETERMINISTIC_RUNS = 5;

/**
 * The record `harness flake reproduce` would write for (identity, fix) at
 * `paths`, planted through the one serializer AND logged through the door's
 * own append (a record no attempt shows explains nothing).
 */
function record(fixture: Fixture, identity: string, fix: string, paths: readonly string[], digest: string, ran: Ran = { mode: "deterministic" }, causes: readonly string[] = paths.slice(1), where: readonly string[] = [""]): FlakeReproduction {
  const keys = flakeCauseContentKeys(configuredGitRepository({}, fixture.root));
  const parent = fixture.git("rev-parse", `${fix}^`);
  const runs = ran.mode === "deterministic" ? DETERMINISTIC_RUNS : ran.runs;
  const hits = ran.mode === "deterministic" ? DETERMINISTIC_RUNS : ran.hits;
  const attempt = randomBytes(16).toString("hex");
  const reproduction: FlakeReproduction = {
    schemaVersion: FLAKE_REPRODUCTION_SCHEMA_VERSION,
    identity,
    suite: "engine",
    paths: [...paths],
    causes: [...causes],
    attempt,
    fix: { commit: fix, contentDigest: contentKeyDigest(keys(fix, paths)!) },
    parent: { commit: parent, contentDigest: contentKeyDigest(keys(parent, paths)!) },
    conditions: { environment: {}, setup: null, during: ran.mode === "deterministic" ? null : "hog", preload: null, seed: null, onlyNamed: false },
    mode: ran.mode,
    runs,
    parentRuns: { failed: { [digest]: hits }, locations: { [digest]: [...where] }, passed: runs - hits, loads: Array.from({ length: runs }, () => 1) },
    fixRuns: { passed: runs, loads: Array.from({ length: runs }, () => 1) },
    recordedAt: "2026-10-08T00:00:00.000Z",
  };
  const directory = flakeReproductionDirectory(fixture.engineRoot);
  mkdirSync(directory, { recursive: true });
  const bytes = serializeFlakeReproduction(reproduction);
  writeFileSync(join(directory, flakeReproductionFileName(identity, fix)), bytes);
  appendFlakeAttempt(fixture.engineRoot, {
    schemaVersion: FLAKE_ATTEMPT_SCHEMA_VERSION, attempt, suite: "engine", fix, parent, conditions: reproduction.conditions, mode: ran.mode, runs,
    outputs: [], outcomes: [{ identity, recorded: sha256(bytes) }], recordedAt: reproduction.recordedAt,
  });
  return reproduction;
}

const row = (timestamp: string, treeId: string | undefined, failures: readonly string[], digest?: string, location?: string): RunFailureRows =>
  ({ timestamp, failures, ...(treeId === undefined ? {} : { treeId }), ...(digest === undefined ? {} : { digests: Object.fromEntries(failures.map((identity) => [identity, digest])) }),
    ...(location === undefined ? {} : { locations: Object.fromEntries(failures.map((identity) => [identity, location])) }) });

/** The configured statistical N and α of these fixtures. */
const STATISTICAL_RUNS = 4;
const SIGNIFICANCE = 0.01;

const evidenceOf = (fixture: Fixture, suites: SuiteIdentities | null = null): ReturnType<typeof declaredCauseFixes> =>
  declaredCauseFixes(configuredGitRepository({}, fixture.root), (file) => `engine/${file}`, fixture.engineRoot, { flakeReproduction: { statisticalRuns: STATISTICAL_RUNS, significance: SIGNIFICANCE, deterministicShims: [] }, suites });

const judged = (entries: readonly RunFailureRows[], evidence: CauseEvidence) => flakyVerdictWithin(entries, 10, undefined, [], evidence)!;
const reds = (entries: readonly RunFailureRows[], evidence: CauseEvidence): readonly string[] => judged(entries, evidence).reds.map((suspect) => suspect.identity);

test("a declared fix explains a suspect ONLY with its recorded reproduction, and only failures that measured the parent's bytes AND said what the reproduction saw", async () => {
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n", "other.ts": "1\n" }, "init");
  const brokenTree = fixture.tree();
  fixture.commit({ "other.ts": "2\n" }, "unrelated");
  const unrelatedTree = fixture.tree();
  const fix = fixture.commit({ "engine/src/door.ts": "fixed\n" }, `fix the door\n\nFlake-cause: ${IDENTITY} => engine/src/door.ts`);
  const fixedTree = fixture.tree();
  const paths = ["engine/test/x.test.ts", "engine/src/door.ts"];
  const history = [row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY], FAILED_SO), row("2026-10-07T21:00:00.000Z", unrelatedTree, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", fixedTree, [])];

  const declaredOnly = await evidenceOf(fixture);
  assert.deepEqual(declaredOnly.declared, [{ identity: IDENTITY, paths, causes: ["engine/src/door.ts"], commit: fix, change: { semantic: true } }]);
  assert.deepEqual(reds(history, declaredOnly), [IDENTITY], "a declaration without its recorded reproduction explains nothing");

  record(fixture, IDENTITY, fix, paths, FAILED_SO);
  const reproduced = await evidenceOf(fixture);
  assert.equal(reproduced.reproductions.length, 1);
  assert.deepEqual(judged(history, reproduced).fixed.map((entry) => [entry.suspect.identity, entry.fixes.map((one) => one.commit)]), [[IDENTITY, [fix]]]);

  const saidOtherwise = [row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY], FAILED_SO), row("2026-10-07T21:00:00.000Z", unrelatedTree, [IDENTITY], FAILED_OTHERWISE), row("2026-10-07T22:00:00.000Z", fixedTree, [])];
  assert.deepEqual(reds(saidOtherwise, reproduced), [IDENTITY], "a failure on the same bytes that said something else failed for another reason");
  const saidNothing = [row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY]), row("2026-10-07T22:00:00.000Z", fixedTree, [])];
  assert.deepEqual(reds(saidNothing, reproduced), [IDENTITY], "a row that recorded no digest cannot be matched");
  const recurred = [row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY], FAILED_SO), row("2026-10-07T21:00:00.000Z", fixedTree, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", fixedTree, [])];
  assert.deepEqual(reds(recurred, reproduced), [IDENTITY], "a failure on the fixed content is a recurrence");
  const unnamed = [row("2026-10-07T20:00:00.000Z", undefined, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", fixedTree, [])];
  assert.deepEqual(reds(unnamed, reproduced), [IDENTITY], "a run that named no tree cannot prove what it measured");
  const notYetFixed = [row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", unrelatedTree, [])];
  assert.deepEqual(reds(notYetFixed, reproduced), [IDENTITY], "the latest run measured the unfixed bytes: nothing explains it");
  const latestUnnamed = [row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", undefined, [])];
  assert.deepEqual(reds(latestUnnamed, reproduced), [IDENTITY], "a latest run that named no tree proves no change");
  assert.deepEqual(reds(history, NO_CAUSE_EVIDENCE), [IDENTITY], "without a declaration the suspect reds");
  const otherTest = [row("2026-10-07T20:00:00.000Z", brokenTree, ["test/y.test.ts::else"], FAILED_SO), row("2026-10-07T22:00:00.000Z", fixedTree, [])];
  assert.deepEqual(reds(otherTest, reproduced), ["test/y.test.ts::else"], "a declaration names its own test only");

  // The record must be THIS fix's, on THESE paths, of THESE bytes.
  const forged: CauseEvidence = { ...reproduced, reproductions: reproduced.reproductions.map((one) => ({ ...one, parent: { ...one.parent, contentDigest: "0".repeat(64) } })) };
  assert.deepEqual(reds(history, forged), [IDENTITY], "a record of other parent bytes explains nothing");
  const otherPaths: CauseEvidence = { ...reproduced, reproductions: reproduced.reproductions.map((one) => ({ ...one, paths: ["engine/test/x.test.ts", "other.ts"] })) };
  assert.deepEqual(reds(history, otherPaths), [IDENTITY], "a record of other paths explains nothing");
  const otherFixBytes: CauseEvidence = { ...reproduced, reproductions: reproduced.reproductions.map((one) => ({ ...one, fix: { ...one.fix, contentDigest: "0".repeat(64) } })) };
  assert.deepEqual(reds(history, otherFixBytes), [IDENTITY], "a record of other FIX bytes explains nothing (correctness F-L1)");
  const otherFix: CauseEvidence = { ...reproduced, reproductions: reproduced.reproductions.map((one) => ({ ...one, fix: { ...one.fix, commit: "f".repeat(40) } })) };
  assert.deepEqual(reds(history, otherFix), [IDENTITY], "a record of another fix commit explains nothing (correctness F-L1)");
});

test("THE TEST FILE'S OWN BYTES COUNT: a failure that measured an edited test with the cause's old bytes is not the reproduced failure", async () => {
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": "test v1\n", "engine/src/door.ts": "racy\n" }, "init");
  const brokenTree = fixture.tree();
  fixture.commit({ "engine/test/x.test.ts": "test v2\n" }, "edit the test");
  const editedTestTree = fixture.tree();
  fixture.commit({ "engine/test/x.test.ts": "test v1\n" }, "restore the test");
  const fix = fixture.commit({ "engine/src/door.ts": "fixed\n" }, `fix\n\nFlake-cause: ${IDENTITY} => engine/src/door.ts`);
  const fixedTree = fixture.tree();
  record(fixture, IDENTITY, fix, ["engine/test/x.test.ts", "engine/src/door.ts"], FAILED_SO);
  const evidence = await evidenceOf(fixture);
  assert.deepEqual(reds([row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", fixedTree, [])], evidence), []);
  assert.deepEqual(reds([row("2026-10-07T20:00:00.000Z", editedTestTree, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", fixedTree, [])], evidence), [IDENTITY]);
});

test("THE TEST FILE IS HELD WHOLE: a failure that measured ANY other bytes of the test's own file — a sibling's edit, a parameterized or decoy title around it — is not the reproduced failure; no parse decides which bytes it measured (security T-1/T-2, correctness F-N1, design F4/F5)", async () => {
  const body = (sibling: string, around: string): string => [
    around,
    `describe("suite", () => { test("counts every run", () => { expect(1).toBe(1); }); });`,
    `test("a sibling", () => { expect(0).toBe(${sibling}); });`,
  ].join("\n");
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": body("0", "// none"), "engine/src/door.ts": "racy\n" }, "init");
  const brokenTree = fixture.tree();
  // The edits a closure would have called unexecuted: a sibling's body, and a parameterized title that could claim the test.
  fixture.commit({ "engine/test/x.test.ts": body("9", "// none") }, "edit a sibling");
  const siblingEditTree = fixture.tree();
  fixture.commit({ "engine/test/x.test.ts": body("9", "test.each([[\"x\"]])(\"%s\", () => {});") }, "a parameterized title at module scope");
  const decoyTree = fixture.tree();
  const fix = fixture.commit({ "engine/src/door.ts": "fixed\n" }, `fix\n\nFlake-cause: ${IDENTITY} => engine/src/door.ts`);
  const fixedTree = fixture.tree();
  record(fixture, IDENTITY, fix, ["engine/test/x.test.ts", "engine/src/door.ts"], FAILED_SO);
  const evidence = await evidenceOf(fixture);
  const failedOn = (tree: string) => [row("2026-10-07T20:00:00.000Z", tree, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", fixedTree, [])];
  // The fix's parent is the decoy tree: only a failure that measured exactly its test file is the reproduced one.
  assert.deepEqual(reds(failedOn(decoyTree), evidence), [], "the parent's own bytes are explained");
  assert.deepEqual(reds(failedOn(siblingEditTree), evidence), [IDENTITY], "a test file whose bytes differ anywhere is other content");
  assert.deepEqual(reds(failedOn(brokenTree), evidence), [IDENTITY], "the same, two edits back");
});

test("WHERE IT FAILED COUNTS BESIDE WHAT IT SAID: a failure is the reproduced one only when its location is among the reproduction's for that digest; a row with no location matches only a reproduction whose failures named none (design NH-D)", async () => {
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n" }, "init");
  const brokenTree = fixture.tree();
  const fix = fixture.commit({ "engine/src/door.ts": "fixed\n" }, `fix\n\nFlake-cause: ${IDENTITY} => engine/src/door.ts`);
  const fixedTree = fixture.tree();
  const paths = ["engine/test/x.test.ts", "engine/src/door.ts"];
  const HERE = "1111222233334444";
  const THERE = "5555666677778888";
  record(fixture, IDENTITY, fix, paths, FAILED_SO, { mode: "deterministic" }, paths.slice(1), [HERE]);
  const evidence = await evidenceOf(fixture);
  const failed = (location?: string) => [row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY], FAILED_SO, location), row("2026-10-07T22:00:00.000Z", fixedTree, [])];
  assert.deepEqual(reds(failed(HERE), evidence), [], "the same digest, the same place: the reproduced failure");
  assert.deepEqual(reds(failed(THERE), evidence), [IDENTITY], "the same message from another place is another failure");
  assert.deepEqual(reds(failed(), evidence), [IDENTITY], "a row that recorded no place cannot be shown to be the reproduced one");
});

test("A RECURRENCE VOIDS THE FIX FOR EVERY TEST IT EXPLAINS: one fix declared for two tests with one digest; a failure of either with that digest on bytes other than the parent's leaves BOTH red (design NH-D)", async () => {
  const other = "test/x.test.ts::a sibling drive";
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n" }, "init");
  const brokenTree = fixture.tree();
  const fix = fixture.commit({ "engine/src/door.ts": "fixed\n" }, `fix the door\n\nFlake-cause: ${IDENTITY} => engine/src/door.ts\nFlake-cause: ${other} => engine/src/door.ts`);
  const fixedTree = fixture.tree();
  const paths = ["engine/test/x.test.ts", "engine/src/door.ts"];
  record(fixture, IDENTITY, fix, paths, FAILED_SO);
  record(fixture, other, fix, paths, FAILED_SO);
  const evidence = await evidenceOf(fixture);
  const before = [row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY, other], FAILED_SO), row("2026-10-07T22:00:00.000Z", fixedTree, [])];
  assert.deepEqual(reds(before, evidence), [], "both explained while nothing recurred");
  const recurred = [row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY, other], FAILED_SO), row("2026-10-07T21:00:00.000Z", fixedTree, [other], FAILED_SO), row("2026-10-07T22:00:00.000Z", fixedTree, [])];
  assert.deepEqual([...reds(recurred, evidence)].sort(), [IDENTITY, other].sort(), "the recurrence of the digest on the fixed bytes voids the fix for both");
});

test("A FIX OF A CAUSE CHANGES THE CAUSE: a commit that edits only the test and names an untouched cause explains nothing, even with a record", async () => {
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": "test v1\n", "engine/src/unrelated.ts": "same\n" }, "init");
  const brokenTree = fixture.tree();
  const fix = fixture.commit({ "engine/test/x.test.ts": "test v1 // a comment\n" }, `cosmetic\n\nFlake-cause: ${IDENTITY} => engine/src/unrelated.ts`);
  const fixedTree = fixture.tree();
  record(fixture, IDENTITY, fix, ["engine/test/x.test.ts", "engine/src/unrelated.ts"], FAILED_SO);
  const evidence = await evidenceOf(fixture);
  assert.deepEqual(reds([row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", fixedTree, [])], evidence), [IDENTITY]);
  assert.match(ignoredCauseEvidenceMessage(evidence), /engine\/src\/unrelated\.ts: unchanged/u, "the declaration explains nothing, and says why");
});

test("THE TEST FILE MAY BE ITS OWN CAUSE, but only by a SEMANTIC change: a comment or layout edit is refused by name; a changed AST with its reproduction explains", async () => {
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": "const wait = 1;\nawait tick(wait);\n" }, "init");
  const brokenTree = fixture.tree();
  const cosmetic = fixture.commit({ "engine/test/x.test.ts": "// the wait is one tick\nconst wait  =  1 ;\n\nawait tick( wait );\n" }, `reformat\n\nFlake-cause: ${IDENTITY} => engine/test/x.test.ts`);
  const cosmeticTree = fixture.tree();
  record(fixture, IDENTITY, cosmetic, ["engine/test/x.test.ts"], FAILED_SO, { mode: "deterministic" }, ["engine/test/x.test.ts"]);
  const refused = await evidenceOf(fixture);
  assert.deepEqual(reds([row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", cosmeticTree, [])], refused), [IDENTITY], "a comment and layout edit fixed nothing, even with a record");
  assert.match(ignoredCauseEvidenceMessage(refused), /engine\/test\/x\.test\.ts: comment or layout only/u);

  const fix = fixture.commit({ "engine/test/x.test.ts": "const answer = await next();\n" }, `await the event\n\nFlake-cause: ${IDENTITY} => engine/test/x.test.ts`);
  const fixedTree = fixture.tree();
  const before = [row("2026-10-07T20:00:00.000Z", cosmeticTree, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", fixedTree, [])];
  assert.deepEqual(reds(before, await evidenceOf(fixture)), [IDENTITY], "a semantic change without its reproduction explains nothing");
  record(fixture, IDENTITY, fix, ["engine/test/x.test.ts"], FAILED_SO, { mode: "deterministic" }, ["engine/test/x.test.ts"]);
  const explained = judged(before, await evidenceOf(fixture));
  assert.deepEqual(explained.reds, []);
  assert.deepEqual(explained.fixed.map((entry) => entry.fixes.map((one) => [one.commit, one.paths, one.causes])), [[[fix, ["engine/test/x.test.ts"], ["engine/test/x.test.ts"]]]]);
});

test("A CAUSE NO READER JUDGES never counts as a semantic change: a fix that changed only such a cause explains nothing, and says which reader is missing", async () => {
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": "test\n", "engine/scripts/run.sh": "sleep 1\n" }, "init");
  const brokenTree = fixture.tree();
  const fix = fixture.commit({ "engine/scripts/run.sh": "sleep 2\n" }, `fix\n\nFlake-cause: ${IDENTITY} => engine/scripts/run.sh`);
  const fixedTree = fixture.tree();
  record(fixture, IDENTITY, fix, ["engine/test/x.test.ts", "engine/scripts/run.sh"], FAILED_SO);
  const evidence = await evidenceOf(fixture);
  assert.deepEqual(reds([row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", fixedTree, [])], evidence), [IDENTITY]);
  assert.match(ignoredCauseEvidenceMessage(evidence), /engine\/scripts\/run\.sh: no reader of this repository judges a \.sh file's meaning/u);
});

test("A STATISTICAL REPRODUCTION explains only at the configured N, with counts a no-op fix would show at most α of the time, and parent failures that said what the ledger row said", async () => {
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": "test\n", "engine/src/socket.ts": "reuse\n" }, "init");
  const brokenTree = fixture.tree();
  const fix = fixture.commit({ "engine/src/socket.ts": "fresh\n" }, `fix\n\nFlake-cause: ${IDENTITY} => engine/src/socket.ts`);
  const fixedTree = fixture.tree();
  const history = [row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", fixedTree, [])];
  const paths = ["engine/test/x.test.ts", "engine/src/socket.ts"];
  record(fixture, IDENTITY, fix, paths, FAILED_SO, { mode: "statistical", runs: STATISTICAL_RUNS - 1, hits: 3 });
  assert.deepEqual(reds(history, await evidenceOf(fixture)), [IDENTITY], "fewer runs than the configured N show nothing");
  record(fixture, IDENTITY, fix, paths, FAILED_SO, { mode: "statistical", runs: STATISTICAL_RUNS, hits: 1 });
  assert.deepEqual(reds(history, await evidenceOf(fixture)), [IDENTITY], "1 of 4 against 0 of 4: a fix that changed nothing shows that half the time — weak, it explains nothing");
  record(fixture, IDENTITY, fix, paths, FAILED_SO, { mode: "statistical", runs: 10, hits: 1 });
  assert.deepEqual(reds(history, await evidenceOf(fixture)), [IDENTITY], "1 of 10 is as weak (the reviewer's 23%-per-attempt case)");
  // Every attempt of this (test, fix) is a look (design 8a): this is the claim's fourth, judged at α / 4.
  record(fixture, IDENTITY, fix, paths, FAILED_SO, { mode: "statistical", runs: 8, hits: 6 });
  assert.deepEqual(reds(history, await evidenceOf(fixture)), [IDENTITY], "6 of 8 against 0 of 8: p = 28/8008 = 0.0035, strong at α but not at α / 4 after three earlier looks");
  record(fixture, IDENTITY, fix, paths, FAILED_SO, { mode: "statistical", runs: 8, hits: 8 });
  assert.deepEqual(reds(history, await evidenceOf(fixture)), [], "8 of 8 against 0 of 8: p = 1/12870, strong at α / 5");
  record(fixture, IDENTITY, fix, paths, FAILED_OTHERWISE, { mode: "statistical", runs: 8, hits: 8 });
  assert.deepEqual(reds(history, await evidenceOf(fixture)), [IDENTITY], "the parent's failures said something else");
});

test("A RECORD THAT SHOWS NOTHING IS REFUSED BY ITS SCHEMA: zero parent failures, a fix run that failed, a statistical record with nothing alongside", async () => {
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": "test\n", "engine/src/socket.ts": "reuse\n" }, "init");
  const fix = fixture.commit({ "engine/src/socket.ts": "fresh\n" }, "fix");
  const good = record(fixture, IDENTITY, fix, ["engine/test/x.test.ts", "engine/src/socket.ts"], FAILED_SO, { mode: "statistical", runs: STATISTICAL_RUNS, hits: 1 });
  const broken: readonly Readonly<[string, FlakeReproduction]>[] = [
    ["zero parent failures", { ...good, parentRuns: { failed: {}, locations: {}, passed: STATISTICAL_RUNS, loads: good.parentRuns.loads } }],
    ["a fix run that failed", { ...good, fixRuns: { passed: STATISTICAL_RUNS - 1, loads: good.fixRuns.loads } }],
    ["no condition (nothing alongside, no shim)", { ...good, conditions: { ...good.conditions, during: null, preload: null } }],
    ["a deterministic record whose parent passed a run", { ...good, mode: "deterministic" }],
  ];
  for (const [what, bad] of broken) assert.throws(() => serializeFlakeReproduction(bad), /./u, what);
  assert.doesNotThrow(() => serializeFlakeReproduction({ ...good, conditions: { ...good.conditions, during: null, preload: { path: "engine/test/support/shim.ts", sha256: "e".repeat(64) } } }), "a preloaded shim is a condition");
  writeFileSync(join(flakeReproductionDirectory(fixture.engineRoot), flakeReproductionFileName(IDENTITY, fix)), `${JSON.stringify({ ...good, parentRuns: { failed: {}, locations: {}, passed: STATISTICAL_RUNS, loads: good.parentRuns.loads } })}\n`);
  const evidence = await evidenceOf(fixture);
  assert.equal(evidence.reproductions.length, 0);
  assert.match(ignoredCauseEvidenceMessage(evidence), /the parent's runs show no failure: nothing was reproduced/u);
});

test("A MOVED TEST clears only by a RECORDED MOVE into the live suite's manifest, never by absence", async () => {
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": "test\n" }, "init");
  const tree = fixture.tree();
  const moved = `${IDENTITY} (skipped)`;
  const live = "live/x.test.ts::counts every run, live";
  const history = [row("2026-10-07T20:00:00.000Z", tree, [moved], FAILED_SO), row("2026-10-07T22:00:00.000Z", tree, [])];
  const gone: SuiteIdentities = { hermetic: new Set(["test/x.test.ts::another"]), live: new Set([live]) };
  assert.deepEqual(reds(history, await evidenceOf(fixture, gone)), [moved], "absent from the hermetic suite, but no move is recorded: red");
  const directory = flakeReproductionDirectory(fixture.engineRoot);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, identityMoveFileName(IDENTITY)), serializeIdentityMove({
    schemaVersion: IDENTITY_MOVE_SCHEMA_VERSION, suite: "engine", from: IDENTITY, to: live, commit: fixture.git("rev-parse", "HEAD"), recordedAt: "2026-10-08T00:00:00.000Z",
  }));
  const verdict = judged(history, await evidenceOf(fixture, gone));
  assert.deepEqual(verdict.reds, []);
  assert.deepEqual(verdict.moved.map((entry) => [entry.suspect.identity, entry.move.to]), [[moved, live]]);
  assert.deepEqual(reds(history, await evidenceOf(fixture, { hermetic: new Set([IDENTITY]), live: new Set([live]) })), [moved], "the test is back in the hermetic suite: red");
  assert.deepEqual(reds(history, await evidenceOf(fixture, { hermetic: new Set(), live: new Set() })), [moved], "the destination is not in the live manifest: red");
  assert.deepEqual(reds(history, await evidenceOf(fixture, null)), [moved], "a suite with no live suite moves nothing");
});

test("a cause the fix ADDED was absent where the failure ran: an absent path never keys equal", async () => {
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n" }, "init");
  const brokenTree = fixture.tree();
  const fix = fixture.commit({ "engine/src/door.ts": "fixed\n", "engine/src/guard.ts": "new\n" }, `fix\n\nFlake-cause: ${IDENTITY} => engine/src/door.ts, engine/src/guard.ts`);
  const fixedTree = fixture.tree();
  assert.deepEqual(reds([row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", fixedTree, [])], await evidenceOf(fixture)), [IDENTITY]);
  assert.equal(flakeCauseContentKeys(configuredGitRepository({}, fixture.root))(`${fix}^`, ["engine/src/guard.ts"]), "engine/src/guard.ts=", "absent keys as absent, never as a match");
  assert.equal(flakeCauseContentKeys(configuredGitRepository({}, fixture.root))("0".repeat(40), ["engine/src/door.ts"]), null, "an unknown tree proves nothing");
});

test("a cause the LATEST tree no longer holds is other bytes: a fixed suspect stays explained after its cause file is deleted", async () => {
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n" }, "init");
  const brokenTree = fixture.tree();
  const fix = fixture.commit({ "engine/src/door.ts": "fixed\n" }, `fix\n\nFlake-cause: ${IDENTITY} => engine/src/door.ts`);
  fixture.git("rm", "-q", "engine/src/door.ts");
  fixture.git("commit", "-s", "-q", "-m", "the door is gone");
  const goneTree = fixture.tree();
  record(fixture, IDENTITY, fix, ["engine/test/x.test.ts", "engine/src/door.ts"], FAILED_SO);
  assert.deepEqual(reds([row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY], FAILED_SO), row("2026-10-07T22:00:00.000Z", goneTree, [])], await evidenceOf(fixture)), []);
});

test("TWO CAUSES, TWO REPRODUCED FIXES: each failure is explained by its own fix's bytes and digest, never by the other's", async () => {
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n", "engine/src/helper.ts": "racy\n" }, "init");
  const brokenTree = fixture.tree();
  const doorFix = fixture.commit({ "engine/src/door.ts": "fixed\n" }, `fix the door\n\nFlake-cause: ${IDENTITY} => engine/src/door.ts`);
  const helperBrokenTree = fixture.tree();
  const helperFix = fixture.commit({ "engine/src/helper.ts": "fixed\n" }, `fix the helper\n\nFlake-cause: ${IDENTITY} => engine/src/helper.ts`);
  const fixedTree = fixture.tree();
  record(fixture, IDENTITY, doorFix, ["engine/test/x.test.ts", "engine/src/door.ts"], FAILED_SO);
  record(fixture, IDENTITY, helperFix, ["engine/test/x.test.ts", "engine/src/helper.ts"], FAILED_OTHERWISE);
  const evidence = await evidenceOf(fixture);
  const twoCauses = [row("2026-10-07T20:00:00.000Z", brokenTree, [IDENTITY], FAILED_SO), row("2026-10-07T21:00:00.000Z", helperBrokenTree, [IDENTITY], FAILED_OTHERWISE), row("2026-10-07T22:00:00.000Z", fixedTree, [])];
  assert.deepEqual(judged(twoCauses, evidence).fixed.map((entry) => entry.fixes.map((one) => one.commit).toSorted()), [[doorFix, helperFix].toSorted()]);
  const doorOnly: CauseEvidence = { ...evidence, declared: evidence.declared.filter((declared) => declared.commit === doorFix) };
  assert.deepEqual(reds(twoCauses, doorOnly), [IDENTITY], "one fix cannot explain the other cause's failure");
});

test("A LATER DECLARATION (`@ <commit>`) resolves to the fix's full name; a malformed trailer or an unknown commit in history is REPORTED AND IGNORED, never thrown", async () => {
  const fixture = repository();
  fixture.commit({ "engine/test/x.test.ts": "test\n", "engine/src/door.ts": "racy\n" }, "init");
  const fix = fixture.commit({ "engine/src/door.ts": "fixed\n" }, "fix without a trailer");
  fixture.commit({ "notes.md": "declared\n" }, `declare\n\nFlake-cause: ${IDENTITY} => engine/src/door.ts @ ${fix.slice(0, 8)}`);
  fixture.commit({ "notes.md": "typo\n" }, "typo\n\nFlake-cause: test/x.test.ts::t =>");
  fixture.commit({ "notes.md": "unknown\n" }, `unknown\n\nFlake-cause: ${IDENTITY} => engine/src/door.ts @ ${"ab".repeat(20)}`);
  const evidence = await evidenceOf(fixture);
  assert.deepEqual(evidence.declared.map((declared) => declared.commit), [fix]);
  assert.equal(evidence.ignoredDeclarations.length, 2);
  const said = ignoredCauseEvidenceMessage(evidence);
  assert.match(said, /2 declaration\(s\) or record\(s\) explain nothing/u);
  assert.match(said, /no commit of this repository/u);
});

test("THE COMMIT-MSG DOOR judges every Flake-cause trailer's syntax (an empty segment, an escaping path, no cause, a bad commit), and passes a good one", () => {
  const fixture = repository();
  fixture.commit({ "a.txt": "a\n" }, "init");
  const repo = configuredGitRepository({}, fixture.root);
  assert.deepEqual(flakeCauseTrailerProblems(repo, `fix\n\nFlake-cause: ${IDENTITY} => engine/src/door.ts\nFlake-cause: ${IDENTITY} => engine/src/a.ts @ 2d2b58e2\n`), []);
  assert.deepEqual(flakeCauseTrailerProblems(repo, "no trailers at all\n"), []);
  for (const bad of [`${IDENTITY} =>`, `${IDENTITY} => engine/src/`, `${IDENTITY} => /etc/passwd`, `${IDENTITY} => engine/../x.ts`, `${IDENTITY} => engine/src/a.ts @ not-a-commit`, `no-file-here => engine/src/a.ts`]) {
    assert.equal(flakeCauseTrailerProblems(repo, `fix\n\nFlake-cause: ${bad}\n`).length, 1, bad);
  }
});

test("a Flake-cause value parses to the test's own path first, then its causes; the test's own file may be a declared cause, said once", () => {
  const ok = parseFlakeCause(`${IDENTITY} => engine/src/a.ts, engine/src/b.ts`, "c0ffee0", (file) => `engine/${file}`);
  assert.deepEqual(ok.paths, ["engine/test/x.test.ts", "engine/src/a.ts", "engine/src/b.ts"]);
  assert.deepEqual(ok.causes, ["engine/src/a.ts", "engine/src/b.ts"]);
  const itself = parseFlakeCause(`${IDENTITY} => engine/src/a.ts, engine/test/x.test.ts`, "c0ffee0", (file) => `engine/${file}`);
  assert.deepEqual(itself.paths, ["engine/test/x.test.ts", "engine/src/a.ts"]);
  assert.deepEqual(itself.causes, ["engine/src/a.ts", "engine/test/x.test.ts"]);
  assert.equal(parseFlakeCause(`${IDENTITY} => engine/src/a.ts @ 2d2b58e2`, "c0ffee0", (file) => file).commit, "2d2b58e2");
});

test("THE SHIPPED commit-msg HOOK refuses a malformed Flake-cause trailer and passes a good one (the door, driven as git drives it)", () => {
  const engine = fileURLToPath(new URL("../../", import.meta.url));
  const scratch = createTempDir("flake-cause-hook-");
  execFileSync("git", ["init", "-q"], { cwd: scratch, stdio: "pipe" });
  const hook = join(scratch, ".githooks", "commit-msg");
  mkdirSync(dirname(hook), { recursive: true });
  copyFileSync(join(engine, "..", ".githooks", "commit-msg"), hook);
  chmodSync(hook, 0o755);
  symlinkSync(engine, join(scratch, "engine"));
  writeFileSync(join(scratch, "readme.md"), "# scratch\n");
  execFileSync("git", ["-c", "user.name=hook", "-c", "user.email=hook@example.invalid", "commit", "-s", "-q", "--allow-empty", "-m", "base"], { cwd: scratch, stdio: "pipe" });
  const run = (message: string): ReturnType<typeof spawnSync> => {
    writeFileSync(join(scratch, "COMMIT_EDITMSG"), message);
    // Signed off by the committer the hook sees (the DCO is one of the message's duties).
    return spawnSync("sh", [hook, join(scratch, "COMMIT_EDITMSG")], {
      // The identities git hands a commit's hooks: it resolves author and committer before it runs them.
      cwd: scratch, encoding: "utf8", maxBuffer: 1 << 24, env: { ...process.env, GIT_COMMITTER_NAME: "hook", GIT_COMMITTER_EMAIL: "hook@example.invalid", GIT_AUTHOR_NAME: "hook", GIT_AUTHOR_EMAIL: "hook@example.invalid" },
    });
  };
  const signedOff = "Signed-off-by: hook <hook@example.invalid>";
  const good = run(`fix\n\nFlake-cause: ${IDENTITY} => engine/src/door.ts\n${signedOff}\n`);
  assert.equal(good.status, 0, String(good.stderr));
  const bad = run(`fix\n\nFlake-cause: ${IDENTITY} => engine/src/\n${signedOff}\n`);
  assert.notEqual(bad.status, 0);
  assert.match(String(bad.stderr), /Flake-cause trailer of this message is malformed/u);
});
