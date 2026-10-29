import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import test from "node:test";

import {
  assertTestSurfaceConservation,
  buildTestSurfaceScope,
  createTestSurfaceDispositionManifest,
  isScannedRecognizableTestSource,
  recognizableTestSourceLanguage,
  type TestSurfaceDispositionEntry,
  type TestSurfaceScope,
} from "../../scripts/verification/test-surface.ts";
import {
  listGitTrackedRecognizableTestPaths,
  listRecognizableTestPaths,
} from "../../scripts/test-inventory.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import { effectiveDispositionEntries } from "../../src/kernel/test-surface-manifest.ts";
import { readDispositionManifest } from "../../src/workflow/disposition-records.ts";
import { canonicalHash } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { bodyCallsWith, functionBody } from "../../src/shared/source-structure.ts";
import {
  createRepositoryLocalTemporaryDirectory,
  removeRepositoryLocalTemporaryDirectory,
} from "../support/repository-local-temporary.ts";

/**
 * THE SUITE CANNOT SHRINK QUIETLY.
 *
 * ── THE CATASTROPHE, PERFORMED ────────────────────────────────────────────
 *
 * Rename `test/` to `tests/`. Run `harness regenerate`: exit 0, "pass". Run
 * `npm test`: exit 0, `status: "passed"`, 78 of 8,562 tests. Nothing in the
 * repository disagreed, because every number in the receipt was derived from
 * the same policy the rename had invalidated:
 *
 *   1. `qualifiedSourcePatterns[0]` stopped matching anything, so the two
 *      remaining entries — single file literals — became the whole canonical
 *      set;
 *   2. the auto-heal PRUNED 399 disposition entries and re-added them as
 *      `pending-external-qualification`, leaving a manifest that was
 *      internally consistent and described a suite of 2 files;
 *   3. the coverage gate compared the healed manifest against the current
 *      surface and agreed with itself.
 *
 * ── THE FOUR REFUSALS, AND WHY THEY ARE NOT ONE ───────────────────────────
 *
 * Each catches a different step, and each is reachable without the others:
 *
 *   R-a  every declared qualified pattern matches at least one file;
 *   R-b  pruning disposition entries FAILS instead of healing
 *        (`autoAddMissingDispositionEntries`, covered in auto-heal.test.ts);
 *   R-c  the non-canonical source set is pinned by content hash;
 *   ID   the conservation identity, against the git index.
 *
 * ── WHY THE PLANTS ARE ARGUMENTS ──────────────────────────────────────────
 *
 * `assertTestSurfaceConservation` is pure over its two inputs precisely so a
 * planted violation costs a synthetic argument and no mutation of this tree.
 * Its production reachability is proven separately, by the fact that
 * `harness regenerate` calls it on every run: if that call were removed, the
 * live assertion below would still pass and the FIRST test here — which
 * drives the real repository through the same function — would still be the
 * only thing standing. So the last test in this file asserts the call site.
 */

const DISCOVERY = ROOT_POLICY.verification.testDiscovery;
const ROOT = process.cwd();

/** A scope with the given buckets, built through the production contract. */
function scopeOf(
  canonical: readonly string[],
  pending: readonly string[] = [],
  fixtures: readonly string[] = [],
  oracles: readonly string[] = [],
): TestSurfaceScope {
  // The language is DERIVED, never written down: hardcoding
  // "javascript-typescript" made every python fixture path invalid, and a
  // fixture that cannot be built is a plant that never enters.
  const entry = (
    path: string,
    disposition: TestSurfaceDispositionEntry["disposition"],
    blocks: boolean,
    evidenceLinks: readonly string[],
  ): TestSurfaceDispositionEntry => {
    const language = recognizableTestSourceLanguage(path);
    assert.ok(language !== undefined, `fixture path is not a recognizable test source: ${path}`);
    return {
      path,
      language,
      disposition,
      rationale: `Conservation fixture: ${disposition}.`,
      evidenceLinks: [...evidenceLinks],
      blocksFullRepositoryClaim: blocks,
    };
  };
  const entries: TestSurfaceDispositionEntry[] = [
    ...canonical.map((path) => entry(path, "canonical-node-test", false, [])),
    ...pending.map((path) => entry(path, "pending-external-qualification", true, [])),
    ...fixtures.map((path) => entry(path, "non-test-fixture", false, ["conservation-fixture"])),
    ...oracles.map((path) => entry(path, "qualified-external-oracle", false, ["conservation-fixture"])),
  ];
  const paths = entries.map((entry) => entry.path);
  return buildTestSurfaceScope(paths, createTestSurfaceDispositionManifest(entries));
}

/** The code of the `HarnessError` a call throws, or `undefined` when it does not throw. */
function refusalCode(run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    assert.ok(error instanceof HarnessError, `expected a HarnessError, got ${String(error)}`);
    return error.code;
  }
}

test("conservation: the live repository balances, and every term is a runtime number", () => {
  const git = listGitTrackedRecognizableTestPaths(ROOT);
  const pins = DISCOVERY.surfaceConservation;

  // THE COVERED POPULATION, STATED. A guard that names its subject has already
  // chosen how much of it to check, and that choice is invisible in a green run.
  assert.ok(git.length > 400, `git-tracked recognizable set collapsed to ${git.length}`);
  assert.equal(DISCOVERY.qualifiedSourcePatterns.length, 3);
  assert.ok(pins.excludedSourceSet.count > 0);
  assert.ok(pins.nonCanonicalSourceSet.count > 0);

  // Both pinned sets carry a real hash, not a placeholder: a pin of all zeroes
  // would make every comparison below fail open the day someone forgets to
  // fill one in.
  assert.match(pins.excludedSourceSet.sha256, /^[0-9a-f]{64}$/u);
  assert.match(pins.nonCanonicalSourceSet.sha256, /^[0-9a-f]{64}$/u);
  assert.notEqual(pins.excludedSourceSet.sha256, "0".repeat(64));
  assert.notEqual(pins.nonCanonicalSourceSet.sha256, "0".repeat(64));
});

test("conservation: R-a refuses a qualified pattern that matches no file", () => {
  // PLANT — the rename, expressed as its effect: every path moves out from
  // under the glob while the two file literals keep matching. Supplied as an
  // argument, so nothing in the tree is touched and the plant is not a literal
  // this guard could filter.
  const git = listGitTrackedRecognizableTestPaths(ROOT);
  const literals = DISCOVERY.qualifiedSourcePatterns.filter((p) => !p.includes("*"));
  assert.equal(literals.length, 2, "fixture assumption: two of the three patterns are file literals");

  const renamed = git.map((path) => path.replace(/^test\//u, "tests/"));
  assert.notDeepEqual(renamed, git, "the plant must change the input, or it proves nothing");
  const survivingScope = scopeOf(literals);

  assert.equal(
    refusalCode(() => assertTestSurfaceConservation(renamed, survivingScope)),
    "qualified_test_pattern_dead",
  );

  // CONTROL — the same call with the paths left alone reaches a LATER refusal,
  // never this one. That proves the finding is about the rename and not about
  // the synthetic scope.
  assert.notEqual(
    refusalCode(() => assertTestSurfaceConservation(git, survivingScope)),
    "qualified_test_pattern_dead",
  );
});

test("conservation: R-a is judged against files the suite would RUN, not merely files git tracks", () => {
  // ── THE DEFECT, DRIVEN ───────────────────────────────────────────────────
  //
  // R-a took the git-tracked recognizable set unfiltered. That set holds 21
  // files the suite can never run — experiment trees and excluded directories
  // the walk drops — and TWELVE of them sit under `test/`. So
  // `test/**/*.test.ts` kept matching against never-run files no matter what
  // happened to the files that actually run, and a population consisting
  // ENTIRELY of excluded files left R-a silent: the refusal that fired was the
  // pin, about a different question.
  //
  // The plant is that exact population — the excluded files plus the two file
  // literals, so all three patterns still match SOMETHING git tracks — and it
  // is derived from the live tree rather than written down, so it cannot go
  // stale and it is not a literal this guard could filter.
  const git = listGitTrackedRecognizableTestPaths(ROOT);
  const neverRun = git.filter((path) => !isScannedRecognizableTestSource(path));
  assert.ok(neverRun.length > 0, "fixture assumption: git tracks recognizable sources the walk excludes");
  assert.ok(
    neverRun.some((path) => path.startsWith("test/")),
    "fixture assumption: some never-run files sit under the glob's own root, which is what made this silent",
  );

  const literals = DISCOVERY.qualifiedSourcePatterns.filter((pattern) => !pattern.includes("*"));
  const deadPopulation = [...neverRun, ...literals].toSorted();
  assert.equal(
    refusalCode(() => assertTestSurfaceConservation(deadPopulation, scopeOf(literals))),
    "qualified_test_pattern_dead",
  );

  // CONTROL — the same synthetic scope against the FULL live population
  // reaches a later refusal, never this one, so the finding is about the dead
  // population and not about the fixture scope.
  assert.notEqual(
    refusalCode(() => assertTestSurfaceConservation(git, scopeOf(literals))),
    "qualified_test_pattern_dead",
  );
});

test("conservation: the walk and the git index are filtered by ONE owner, and they agree", () => {
  // "One owner" is a claim, and a claim carries evidence. The walk prunes
  // excluded directories during traversal for speed; the per-path decision
  // lives in `isScannedRecognizableTestSource` and both sides apply it. If the
  // two ever answer differently, the liveness refusal above is judging a
  // population nothing runs — which is the defect it was just corrected for.
  const git = listGitTrackedRecognizableTestPaths(ROOT);
  const walk = listRecognizableTestPaths(ROOT);
  assert.ok(walk.length > 400, `the walk collapsed to ${walk.length}`);
  assert.deepEqual(
    git.filter(isScannedRecognizableTestSource).toSorted(),
    [...walk].toSorted(),
    "the git index filtered by the shared per-path rule must be exactly what the walk returns",
  );
  // And the two sets must genuinely DIFFER before the filter, or the agreement
  // above is satisfied by the filter doing nothing.
  assert.ok(git.length > walk.length, "fixture assumption: git tracks more recognizable sources than the walk keeps");
});

test("conservation: the live scope passes, and R-c refuses when one file changes bucket", () => {
  const git = listGitTrackedRecognizableTestPaths(ROOT);
  const live = liveScope();

  // CONTROL — the live manifest, rebuilt through the production contract,
  // satisfies all four refusals. Without this the plants below could be firing
  // on the fixture rather than on the change.
  assert.equal(refusalCode(() => assertTestSurfaceConservation(git, live)), undefined);

  // PLANT — move exactly ONE canonical file into `pending`. The excluded set
  // is untouched, so the excluded pin cannot be what fires; only the pinned
  // non-canonical set has moved, and it moved by one entry out of 412.
  const demoted = live.canonicalNodeSourceIds[0]!;
  const moved = scopeOf(
    live.canonicalNodeSourceIds.filter((path) => path !== demoted),
    [...live.pendingExternalSourceIds, demoted],
    live.nonTestFixtureSourceIds,
  );
  assert.equal(
    refusalCode(() => assertTestSurfaceConservation(git, moved)),
    "test_surface_pinned_set_moved",
  );
});

test("conservation: the git side moving is refused, and the identity is a tripwire not a detector", () => {
  // MEASURED CORRECTION, recorded so nobody re-derives it. The conservation
  // identity was proposed as the mechanism that refuses the catastrophes.
  // Driven, it is not: given the subset check and the two pins, the arithmetic
  // holds identically, so it can never be the FIRST refusal. Deleting a
  // canonical test file from the index is caught — but by the subset check,
  // which is the better message anyway.
  const git = listGitTrackedRecognizableTestPaths(ROOT);
  const live = liveScope();
  const deleted = live.canonicalNodeSourceIds[0]!;
  const shrunk = git.filter((path) => path !== deleted);
  assert.equal(shrunk.length, git.length - 1, "the plant must change the input");

  assert.equal(
    refusalCode(() => assertTestSurfaceConservation(shrunk, live)),
    "test_surface_registry_untracked",
  );

  // A universe of ZERO cannot pass: the left-hand side is not supplied by the
  // manifest, so an empty registry does not make an empty problem. This is the
  // answer to a population that used to be a parameter.
  assert.ok(refusalCode(() => assertTestSurfaceConservation([], scopeOf([]))) !== undefined);

  // And the identity is stated, so a future change that makes it live is a red
  // test rather than a silent tautology.
  const pins = DISCOVERY.surfaceConservation;
  assert.equal(
    git.length - pins.excludedSourceSet.count - pins.nonCanonicalSourceSet.count,
    live.canonicalNodeSourceIds.length,
  );
});

test("conservation: a path in two buckets, and a path twice in one, are BOTH refused", () => {
  // ── THE SIBLING THAT NOTHING CAUGHT ──────────────────────────────────────
  //
  // Every quantity here counts the registry as an ARRAY while the argument
  // that justifies the arithmetic is about it as a SET. Driven before this
  // refusal existed: duplicating a canonical path inside its own bucket fired
  // the arithmetic identity and nothing else, and putting a canonical path
  // ALSO into `nonTestFixtureSourceIds` fired NOTHING — all four refusals
  // passed a registry describing a surface that does not exist.
  //
  // A tripwire that fires on one shape and misses its sibling is worse than
  // none, because it advertises coverage it lacks. So both shapes are planted,
  // through the same door a real caller uses.
  const git = listGitTrackedRecognizableTestPaths(ROOT);
  const live = liveScope();
  const duplicated = live.canonicalNodeSourceIds[0]!;

  // The scope is assembled directly rather than through `scopeOf`, because the
  // projection door deliberately rejects both shapes — and this refusal exists
  // precisely for the callers that did not come through that door.
  const withinOneBucket: TestSurfaceScope = {
    ...live,
    canonicalNodeSourceIds: [...live.canonicalNodeSourceIds, duplicated],
  };
  assert.equal(
    refusalCode(() => assertTestSurfaceConservation(git, withinOneBucket)),
    "test_surface_registry_not_partitioned",
  );

  const acrossTwoBuckets: TestSurfaceScope = {
    ...live,
    nonTestFixtureSourceIds: [...live.nonTestFixtureSourceIds, duplicated],
  };
  assert.equal(
    refusalCode(() => assertTestSurfaceConservation(git, acrossTwoBuckets)),
    "test_surface_registry_not_partitioned",
  );

  // CONTROL — the same live scope with nothing duplicated passes every
  // refusal, so the two plants are what changed the answer.
  assert.equal(refusalCode(() => assertTestSurfaceConservation(git, live)), undefined);
});

test("conservation: a registry naming a file git does not track is refused", () => {
  const git = listGitTrackedRecognizableTestPaths(ROOT);
  const live = liveScope();
  const invented = "test/this-file-was-never-committed.test.ts";
  assert.equal(git.includes(invented), false, "fixture assumption: the planted path is not tracked");
  const withGhost = scopeOf(
    live.canonicalNodeSourceIds,
    [...live.pendingExternalSourceIds, invented],
    live.nonTestFixtureSourceIds,
  );
  assert.equal(
    refusalCode(() => assertTestSurfaceConservation(git, withGhost)),
    "test_surface_registry_untracked",
  );
});

test("conservation: the identity is asserted by the production inventory door", () => {
  // §21 — a plant must drive the PATH, not the unit. Every test above drives
  // the function directly, which says nothing about whether anything CALLS it.
  // The generator is the one production caller, and it is the door that writes
  // the pinned inventory, so its call site is asserted here.
  //
  // NAMES, NOT BYTES. This was a byte-exact regex over the source text
  // (`/assertTestSurfaceConservation\(gitRecognizable, scopeForConservation\(root\)\)/`),
  // which a reformat breaks and a rename of nothing at all defeats. The parser
  // compares the call's argument NAMES as it delimited them, so a line break,
  // an appended option or different whitespace all pass, and a substituted
  // argument — the change that would actually matter — reds.
  const source = readSource("scripts/test-inventory.ts");
  assert.ok(
    bodyCallsWith(
      functionBody(source, "main"),
      "assertTestSurfaceConservation",
      ["gitRecognizable", "scopeForConservation(root)"],
    ),
    "the inventory CLI body must assert conservation against the git-derived set; " +
    "a refusal nothing calls is a refusal that does not exist",
  );
  // AND THE RECEIPT MUST REACH THE PAYLOAD. This is the part a swallowing
  // `try { … } catch {}` cannot fake: the caller reads these numbers back, so
  // a discarded refusal produces a payload with nothing in it. Driven against
  // the real CLI rather than asserted from source.
  // `--check` exits 1 to mean "the inventory has drifted", which is a verdict
  // and not a crash, so the status is judged rather than thrown on.
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/test-inventory.ts", "--check"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.ok(run.status === 0 || run.status === 1, `inventory --check crashed: ${run.stderr}`);
  // A refusal prints its typed error on stderr and nothing on stdout: said as the failure, never a JSON parse error.
  assert.ok(run.stdout.trim().length > 0, `inventory --check printed no payload (exit ${String(run.status)}): ${run.stderr.trim()}`);
  const payload = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as {
    conservation?: { kind?: string; canonicalCount?: number; gitRecognizableCount?: number };
  };
  assert.ok(payload.conservation !== undefined, "the inventory CLI must emit the conservation receipt");
  // AND IT MUST SAY `verified`, NEVER `unavailable`. The `unavailable` branch
  // exists for whole-repository fixtures that have no `.git`, and asserting
  // that the REAL repository never takes it is what stops that branch from
  // quietly becoming the normal one.
  assert.equal(payload.conservation.kind, "verified");

  assert.equal(payload.conservation.canonicalCount, liveScope().canonicalNodeSourceIds.length);
  assert.ok((payload.conservation.gitRecognizableCount ?? 0) > 400);
  // And the git-derived set must come from the index, not from the walk that
  // the policy already filters — the whole mechanism is the independence.
  assert.match(
    source,
    /\bpresentTrackedFiles\(\s*root\s*\)/u,
    "the independent instrument must be the git index (minus unstaged deletions), read through the one ownership reader (presentTrackedFiles)",
  );
});

test("conservation: the production door REFUSES a broken surface, driven, and no wrapper can fake that", () => {
  // ── WHY THIS TEST EXISTS, MEASURED ───────────────────────────────────────
  //
  // The call site used to be defended by a structural assertion on its own
  // indentation, on the argument that a `try`/`catch` wrapper would indent it
  // further. It does not have to. Renaming the import and shadowing it with a
  // local function of the same name that swallows and returns a fabricated
  // receipt leaves EVERY byte the structural check inspects untouched:
  //
  //   import { assertTestSurfaceConservation as rawAssert… } from "…";
  //   function assertTestSurfaceConservation(paths, scope) {
  //     try { return rawAssert…(paths, scope); }
  //     catch { return { …counts computed from the arguments… }; }
  //   }
  //
  // Driven: that mutant took the production door from exit 1 to exit 0 on a
  // tree that must be refused, while `tsc` reported 0 errors and all seven
  // conservation tests plus four other guard files passed. A refusal that can
  // be wrapped is not a refusal, and no assertion about the SHAPE of the call
  // can tell "consumed" from "consumed and discarded on throw" — the two
  // differ only on the day the refusal fires.
  //
  // So the day is made to arrive. This drives the real CLI, as a subprocess,
  // against a repository state that MUST be refused, and requires the refusal
  // to come back.
  //
  // ── THE PLANT TOUCHES NOTHING ────────────────────────────────────────────
  //
  // The refusal's independent instrument is `git ls-files`, and git reads its
  // index from `GIT_INDEX_FILE` when that is set. So the plant is a COPY of
  // the real index with one canonical test source removed, handed to the
  // subprocess through the environment. The repository, the working tree and
  // the real index are untouched — which is what makes this safe to run
  // beside everything else in the suite, and it is supplied from outside the
  // guard rather than being a literal this guard could filter.
  const removed = liveScope().canonicalNodeSourceIds[0]!;
  const fixture = createRepositoryLocalTemporaryDirectory("conservation-index-plant-");
  try {
    const plantedIndex = join(fixture, "index");
    const realIndex = spawnSync("git", ["rev-parse", "--git-path", "index"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(realIndex.status, 0, "could not locate the git index");
    // `--git-path` answers RELATIVE to the cwd on a plain checkout (`.git/index`)
    // and ABSOLUTE on a worktree (the common dir lives in the main checkout).
    // `join` against an absolute answer manufactures `<root>/home/...` — a path
    // that does not exist — so only a relative answer is joined.
    const realIndexPath = realIndex.stdout.trim();
    copyFileSync(isAbsolute(realIndexPath) ? realIndexPath : join(ROOT, realIndexPath), plantedIndex);
    const update = spawnSync("git", ["update-index", "--force-remove", removed], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GIT_INDEX_FILE: plantedIndex },
    });
    assert.equal(update.status, 0, `could not plant the index: ${update.stderr}`);

    // LIVENESS ON THE PLANT — the planted index must actually answer
    // differently, or everything below is asserting about an unchanged world.
    const listed = (indexPath?: string): number => {
      const result = spawnSync("git", ["ls-files", "-z"], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        ...(indexPath === undefined ? {} : { env: { ...process.env, GIT_INDEX_FILE: indexPath } }),
      });
      assert.equal(result.status, 0, "git ls-files failed");
      return result.stdout.split("\0").filter((entry) => entry.length > 0).length;
    };
    assert.equal(listed(plantedIndex), listed() - 1, "the planted index must hold exactly one file fewer");

    const refused = runInventoryCheck(plantedIndex);
    assert.notEqual(refused.status, 0, "the production door must refuse a registry naming an untracked source");
    assert.equal(
      refused.refusal,
      "test_surface_registry_untracked",
      `the CLI must carry the specific refusal code; got ${JSON.stringify(refused.stderr)}`,
    );
    assert.match(refused.message ?? "", new RegExp(escapeForRegExp(removed), "u"));

    // CONTROL — the same command against the REAL index reaches no refusal at
    // all. `--check` still exits 1 whenever the pinned inventory has drifted,
    // which is a verdict and not a refusal, so the control is stated on the
    // refusal channel rather than on the exit code.
    const control = runInventoryCheck(undefined);
    assert.equal(control.refusal, undefined, `the unplanted tree must not refuse: ${control.stderr}`);
  } finally {
    removeRepositoryLocalTemporaryDirectory(fixture);
  }
});

type InventoryCheckOutcome = Readonly<{
  status: number | null;
  refusal?: string;
  message?: string;
  stderr: string;
}>;

/**
 * Run the production inventory CLI, optionally against a planted git index.
 * The refusal is read from the CLI's own stderr payload, which carries the
 * specific refusal code beside the generic generation-failure one.
 */
function runInventoryCheck(indexPath: string | undefined): InventoryCheckOutcome {
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/test-inventory.ts", "--check"],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...(indexPath === undefined ? {} : { env: { ...process.env, GIT_INDEX_FILE: indexPath } }),
    },
  );
  const stderr = run.stderr.trim();
  const lastLine = stderr.split("\n").at(-1) ?? "";
  let parsed: { refusal?: unknown; message?: unknown } = {};
  try {
    parsed = JSON.parse(lastLine) as { refusal?: unknown; message?: unknown };
  } catch {
    // No JSON payload means no refusal was reported; the caller asserts on that.
  }
  return Object.freeze({
    status: run.status,
    ...(typeof parsed.refusal === "string" ? { refusal: parsed.refusal } : {}),
    ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
    stderr,
  });
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The live disposition manifest as a scope. The plants below start from the
 * REAL population and change one thing, so a failure names the change rather
 * than a difference between a fixture and production.
 */
function liveScope(): TestSurfaceScope {
  // The EFFECTIVE dispositions (#221): the manifest records only the exceptions, and every qualified Node
  // source with no entry is canonical by default — read through their one owner, never the raw entries.
  const manifest = readDispositionManifest(ROOT);
  const effective = effectiveDispositionEntries(listRecognizableTestPaths(ROOT), manifest);
  const of = (disposition: string): readonly string[] =>
    effective.filter((entry) => entry.disposition === disposition).map((entry) => entry.path);
  // Every disposition the live manifest uses is carried: a bucket this helper
  // dropped would make the live scope disagree with the pins it is checked by
  // (the first qualified-external-oracle, LIVE-SUITE, found exactly that).
  const carried = ["canonical-node-test", "pending-external-qualification", "non-test-fixture", "qualified-external-oracle"];
  assert.deepEqual(effective.filter((entry) => !carried.includes(entry.disposition)).map((entry) => `${entry.path}: ${entry.disposition}`), [],
    "the live manifest uses a disposition this helper does not carry");
  return scopeOf(of("canonical-node-test"), of("pending-external-qualification"), of("non-test-fixture"), of("qualified-external-oracle"));
}

function readSource(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

test("conservation: canonicalHash is the same instrument the pins were computed with", () => {
  // A pin computed with one hash and compared with another fails forever and
  // gets deleted. This states the instrument so a change to it is a red test
  // rather than a mystery.
  assert.equal(canonicalHash([]).length, 64);
  assert.notEqual(canonicalHash(["a"]), canonicalHash(["b"]));
});
