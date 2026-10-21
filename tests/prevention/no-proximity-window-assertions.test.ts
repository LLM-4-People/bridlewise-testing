// @vitest-environment node
/**
 * NO GUARD MAY CLAIM TWO THINGS ARE RELATED BECAUSE THEY ARE NEAR EACH OTHER.
 *
 * ── THE DEFECT, MEASURED ──────────────────────────────────────────────────
 *
 *   expect(read(modulePath("git-bridge.ts")))
 *     .toMatch(/export function runGitConfined[\s\S]{0,600}?return gitText\(/);
 *
 * `runGitConfined`'s own `return gitText(` is 344 bytes after the anchor. The
 * NEXT function's is at 584 — sixteen bytes inside the window. With
 * `runGitConfined`'s body replaced by a raw unconfined spawn, that assertion
 * still returned true. The guard passed with the defect it exists for planted,
 * and it was written in the same step that reported repairing an identical
 * window somewhere else. That is the whole reason this file exists: the
 * previous round fixed the INSTANCE and the CLASS survived four hundred lines
 * away in the same file.
 *
 * ── WHY THIS IS RUNG 5 AND WHAT SITS ABOVE IT ─────────────────────────────
 *
 * A regular-expression literal is data the language will always accept, so
 * rung 1 is unreachable; and `tests/**` is in NONE of THIS repository's three
 * tsconfig programs, so a type-level ban here would be documentation. (It is
 * NOT documentation in the harness, whose single program contains 1,114 files
 * of which 444 are under `test/` — the owner's brand is compiler-enforced
 * there, and that difference is measured rather than assumed.) The real
 * enforcement is in the shared owner, and it is now RUNG 2 rather than a
 * refusal: no door there accepts a `RegExp` at all, so a proximity window has
 * nowhere to be written. This scan is the only thing that can reach a NEW test
 * which never imports the owner and matches a pattern against a whole file.
 * Rung 5 is the floor here, not the goal, and it is stated.
 *
 * ── THE DETECTOR IS THE OWNER'S, AND IT READS PARSED SOURCE ───────────────
 *
 * This file used to carry its own copy of the window pattern — the same regular
 * expression as the owner's, written two different ways. Two owners for one
 * judgement is the defect the estate exists to argue against, and they had
 * already drifted: BOTH knew only four spellings, so `[\S\s]{0,600}` — the
 * original defect with two characters transposed — passed the scan AND passed
 * the door. The judgement now lives once, in the owner, and it EXECUTES a
 * pattern's atoms against a probe alphabet instead of comparing their spelling
 * to a list.
 *
 * The universe is the PARSED source rather than the raw lines, which fixes two
 * errors at once: a text scan cannot tell `/a.{0,9}b/` from a comment about
 * `console.*` (measured: forty such lines in these trees), and it cannot see a
 * pattern written across two lines at all.
 *
 * ── WHAT IS DELIBERATELY NOT IN THE UNIVERSE ──────────────────────────────
 *
 * Production heuristics that match NATURAL LANGUAGE or ARBITRARY USER CODE.
 * `self-improving/llm-boundary.ts` classifies English prose ("try … catch"
 * within forty characters) and `quality/checks/performance-anti-pattern.ts`
 * looks for an N+1 query in somebody else's repository. Neither makes a claim
 * about first-party structure, and neither can be scoped to a parsed body,
 * because there is no first-party body to parse.
 *
 * THAT EXEMPTION NOW CARRIES ITS OWN EVIDENCE, because it did not before: the
 * previous version discharged it with a plant inside the SCANNED tree, which is
 * evidence about the scanned tree and says nothing about the exempted one. The
 * production trees are now measured separately below — a runtime count, with a
 * ceiling — so a window written into `server/` tomorrow is visible even though
 * it is not an error.
 */
import { describe, test, expect, beforeAll, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { gitTrackedPaths } from "../helpers/source-scan.ts";
import { sourceViewOf } from "../../engine/scripts/verification/source-view.ts";
import * as sourceViews from "../../engine/scripts/verification/source-view.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

import {
  attributeOf,
  bodyBinds,
  bodyCalls,
  bodyCallsWith,
  cssDeclares,
  cssRule,
  elementWithAttribute,
  functionBody,
  exportedBindings,
  functionsCalling,
  isSourceScope,
  patternGapIn,
  regexLiteralsIn,
  sliceWindowsIn,
  windowGapIn,
  windowedPatternsIn,
} from "../helpers/function-scope.ts";

import { modulePath } from "../helpers/module-resolver.ts";
/**
 * The GUARD ESTATES of both repositories. Not `tests/prevention/` alone: an
 * earlier audit of universe defects was itself path-scoped and declared a whole
 * third estate absent.
 */
const SCANNED_TREES = [
  "tests",
  join("engine", "test"),
] as const;

/** Directories the universe never descends into, matched as PATH SEGMENTS. */
const SKIPPED_SEGMENTS = new Set(["node_modules", ".git", "dist", "coverage", ".vite", ".bridlewise", "fixtures"]);

/**
 * Every source file under the scanned trees — THE COMMITTED ESTATE, read from
 * the git index rather than walked from live disk.
 *
 * ── WHY THE UNIVERSE IS THE INDEX, NOT THE DISK ──────────────────────────
 *
 * A walk of live disk collects whatever exists at that instant, and a guard
 * that then reads each listed file races any TRANSIENT file a sibling test
 * writes into the same trees: the walk collects the sibling's probe, the
 * sibling's `finally` deletes it, and the read lands on a file that no longer
 * exists. That exact race put this file's own plant probe into a sibling
 * guard's walk and reddened a run with ENOENT — a flake whose cause lived in
 * neither test's own assertions.
 *
 * The claim this guard makes is about the COMMITTED estate: "no committed
 * guard bounds a distance between two anchors". The index is that estate, by
 * construction — a transient probe is untracked and can never enter the
 * universe, so the race is not tolerated here, it is UNREPRESENTABLE. The
 * instrument is the suite's shared second instrument (`git ls-files`, written
 * by git and steerable by nothing in this tree), cached per repository, so the
 * switch costs one subprocess per run.
 *
 * What is deliberately KEPT loud: a file the index holds but the disk does
 * not is a broken checkout, not a race, and `readFileSync` failing on it is
 * the correct behaviour — the committed estate must be present to be judged.
 * The skipped-directory set of the old walker is reproduced as segment
 * filtering, and the two universes were measured byte-identical (921 files,
 * empty diff both ways) before this switch landed.
 */
function scannedFiles(): string[] {
  const tracked = gitTrackedPaths(".");
  const out: string[] = [];
  for (const tree of SCANNED_TREES) {
    // A TREE THAT DOES NOT EXIST IS NOT AN EMPTY TREE. A scan whose root is
    // missing returns nothing and reports it as clean, which is the vacuous
    // universe this whole file is about.
    expect(statSync(tree).isDirectory(), `${tree} must be a directory — a missing scan root is not an empty one`).toBe(true);
    const prefix = `${tree}/`;
    for (const path of tracked) {
      if (!path.startsWith(prefix)) continue;
      if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(path)) continue;
      if (path.split("/").some((segment) => SKIPPED_SEGMENTS.has(segment))) continue;
      out.push(path);
    }
  }
  return out;
}

/**
 * THE FILES THAT LEGITIMATELY CONTAIN WINDOWS — DISCOVERED, NOT LISTED.
 *
 * A test that DRIVES the detector has to be able to write the shapes it
 * detects: this file keeps the retired windows as evidence, and the harness's
 * owner test drives twenty spellings at the door. Both are recognised by a
 * PROPERTY OF THEIR SOURCE — they import the detector itself — rather than by
 * a path in a list. The previous version listed two paths, and ONE OF THEM DID
 * NOT EXIST (`integration/test/prevention/no-proximity-window-assertions.test.ts`):
 * a stale allowlist entry that excluded nothing and that nothing could notice.
 *
 * The exemption is COUNTED below, with a ceiling, because "a file that imports
 * the detector may write a window" is a claim about the world and a third such
 * file must be a deliberate decision rather than an unnoticed one. It is also
 * LIVE-TESTED: a file only receives the exemption while it actually carries a
 * gap pattern the scan would otherwise classify, so an import that suppresses
 * nothing cannot keep a silent waiver.
 */
const DETECTOR_IMPORT = /import\s*\{[^}]*\b(?:windowGapIn|windowedPatternsIn|patternGapIn)\b[^}]*\}\s*from/;

function drivesTheDetector(source: string): boolean {
  return DETECTOR_IMPORT.test(source);
}

/**
 * A DETECTOR-DRIVER EXEMPTION MUST STILL SUPPRESS A FINDING.
 *
 * `drivesTheDetector` recognises the IMPORT and the scan skips the file. The
 * liveness arm below then requires that file to carry at least one gap pattern
 * the scan would otherwise classify (bounded, greedy, lazy, or trailing). A
 * file that keeps the import but stops writing windows is therefore RED, not
 * silently un-exempted: the waiver suppressed NOTHING and the previous rule
 * could not tell that state from a live one. (The version before that listed
 * paths, and one of them did not exist, which nothing could notice either.)
 *
 * The exemption is per-file by construction: the classification asks each
 * source, so a window written WITHOUT the import still lands in the offender
 * list below. A driver whose fixtures are strings the regex scan cannot see
 * carries no gap and is reported stale — the honest state is to have no waiver
 * to measure.
 */
function detectorFixtureGaps(source: string, path: string): number {
  let gaps = 0;
  for (const { pattern } of regexLiteralsIn(source, path)) {
    if (patternGapIn(pattern) !== undefined) gaps += 1;
  }
  return gaps;
}

/** Exempted drivers that suppress nothing — a stale exemption. */
function inertDetectorExemptions(files: readonly string[]): readonly string[] {
  return files.filter((file) => detectorFixtureGaps(readFileSync(file, "utf8"), file) === 0);
}

/**
 * The names a module exports, by ANY form — asked of the shared owner rather
 * than re-derived here.
 *
 * This was a local `/export\s*\{([^}]*)\}\s*from/`, and the pattern encoded the
 * assumption that the only export in the door file is a single re-export block.
 * It was true of that file and it is not a property of anything: a second
 * block, an `export const`, an `export … from` on another line, and the list
 * silently shortens. The owner answers the same question for every form and
 * says which ones it cannot see through.
 */
function exportedNamesOf(source: string): readonly string[] {
  return [...exportedBindings(source, "door file").keys()];
}

/**
 * HOW WIDE A `slice(start, start + N)` HAS TO BE BEFORE IT IS A DISTANCE CLAIM.
 *
 * Below this, the second argument is a LENGTH rather than a search radius — a
 * truncation for an error message, a two-character lookahead, a fixed-width
 * field. Above it, the number is a guess about how far apart two things are,
 * which is the same guess `{0,600}` makes. Ten is stated here rather than
 * derived per run: the population it divided is re-measured every run and
 * reported by the slice-window test below, so no number is transcribed into
 * this comment to go stale.
 */
const SLICE_WINDOW_MINIMUM_EXTENT = 10;

/**
 * A GUARD THAT FINDS A FUNCTION BODY BY COUNTING BRACES ITSELF.
 *
 * The same class as a proximity window, one level up: a guard approximating a
 * CONSTRUCT instead of asking the instrument that already had to be correct.
 * The two halves are what identify it — an opening brace located by INDEX, and
 * a DEPTH counter — and either alone is ordinary code.
 *
 * All three traps this workspace has already paid for still fire in these:
 * a return type spelled `Readonly<{ map: … }>` comes back as `"{ map: … }"`, a
 * default parameter `options: Options = {}` comes back as TWO BYTES, and
 * `export async function` is not found at all. The last two are silent in the
 * worst way: a two-byte body makes every `.test(fn.body)` false, so a
 * population a guard then iterates is silently EMPTY and the run is green.
 *
 * Counted rather than forbidden, because each conversion has to be re-derived
 * against the code it asserts about — a scope helper pointed at the wrong
 * region is worse than the window it replaces. The ceiling is what stops a
 * seventeenth copy arriving unnoticed.
 */
const BODY_BY_BRACE_INDEX = /indexOf\(\s*["']\{["']/u;
const BRACE_DEPTH_COUNTER = /\bdepth\s*(?:\+=|-=|\+\+|--)/u;

function rollsItsOwnBodyFinder(source: string): boolean {
  return BODY_BY_BRACE_INDEX.test(source) && BRACE_DEPTH_COUNTER.test(source);
}

/** The doors that accepted a `RegExp`, and must never come back. */
const retiredDoors = ["bodyMatches", "assertNotWindowed", "objectLiteralsContaining"] as const;

/** The PRODUCTION trees, which are exempt from the scan and measured anyway. */
const EXEMPT_TREES = [join("engine", "src"), "src", "server", "shared"] as const;

/**
 * THE SCAN, AS ONE FUNCTION — so a plant can enter where a real caller enters.
 *
 * This loop used to live inside `beforeAll`, and the only thing that ever
 * PLANTED a window drove `windowGapIn()` directly. That proves the detector is
 * awake and says nothing about the scan: deleting the whole `offenders.push(…)`
 * branch left every liveness number this file publishes unchanged — the file
 * count, the pattern count, the greedy ceiling, the driver count — because the
 * mutation removes a PUSH, not a READ, and the scan went green with a real
 * bounded window planted in the estate.
 *
 * A plant must therefore write a window into a FILE in a SCANNED TREE and come
 * back through `scannedFiles()`, which is what the test below does.
 */
function classifyEstate(files: readonly string[]): Readonly<{
  offenders: string[];
  greedyDistanceClaims: string[];
  lazyDistanceClaims: string[];
  sliceWindows: string[];
  handRolledBodyFinders: string[];
  detectorDrivers: string[];
  lazyDelimited: number;
  trailingRuns: number;
  patternsRead: number;
  sliceCallsRead: number;
}> {
  const out = {
    offenders: [] as string[],
    greedyDistanceClaims: [] as string[],
    lazyDistanceClaims: [] as string[],
    sliceWindows: [] as string[],
    handRolledBodyFinders: [] as string[],
    detectorDrivers: [] as string[],
    lazyDelimited: 0,
    trailingRuns: 0,
    patternsRead: 0,
    sliceCallsRead: 0,
  };
  for (const file of files) {
    // BYTES, NEVER `grep`: files in these trees contain legitimate NUL bytes
    // (the correct key separator, and `java\0script:` as an adversarial
    // fixture), and GNU grep treats such a file as binary — printing nothing
    // and exiting cleanly, which is a silently smaller universe.
    const source = readFileSync(file, "utf8");
    if (rollsItsOwnBodyFinder(source)) out.handRolledBodyFinders.push(file);
    if (drivesTheDetector(source)) { out.detectorDrivers.push(file); continue; }
    const view = sourceViewOf(source, file);
    // EVERY PATTERN THE SCAN READ, not only the ones it faulted. This is the
    // population the verdict below is about, and it is what makes a green run
    // mean something: the previous liveness check was
    // `expect(patternsRead).toBe(offenders.length)` with both counters
    // incremented in the same iteration — an assertion that could not fail in
    // any state of the world, including one where the enumerator returned
    // nothing for every file in the estate.
    for (const { pattern, offset } of regexLiteralsIn(source, file)) {
      out.patternsRead += 1;
      const gap = patternGapIn(pattern);
      if (gap === undefined) continue;
      // Counter-only classifications have no diagnostic to locate or format.
      if (!gap.anchored) { out.trailingRuns += 1; continue; }
      if (!gap.bounded && !gap.greedy && gap.delimited) { out.lazyDelimited += 1; continue; }
      const line = view.lineAt(offset);
      const row = `${file}:${line}  [${gap.text}]  /${pattern.slice(0, 120)}/`;
      if (gap.bounded) out.offenders.push(row);
      else if (gap.greedy) out.greedyDistanceClaims.push(row);
      else out.lazyDistanceClaims.push(row);
    }
    // …AND THE SAME CLAIM WITHOUT A PATTERN. Read in the same pass, over the
    // same file list, so the two universes cannot drift apart.
    for (const window of sliceWindowsIn(source, file)) {
      out.sliceCallsRead += 1;
      if (window.extent < SLICE_WINDOW_MINIMUM_EXTENT) continue;
      const line = view.lineAt(window.offset);
      out.sliceWindows.push(`${file}:${line}  +${window.extent}  ${window.text.slice(0, 100)}`);
    }
  }
  return out;
}

describe("no guard bounds the distance between two anchors", () => {
  let files: string[] = [];
  /** BOUNDED distance between two anchors — a window in every case. */
  const offenders: string[] = [];
  /**
   * GREEDY UNBOUNDED between two anchors — the same guess with the number left
   * off. Counted with a ceiling rather than required to be empty, because
   * there are still sixty-odd in the estate and each one is a separate claim to
   * re-derive; the ceiling is what stops a sixty-first arriving unnoticed.
   */
  const greedyDistanceClaims: string[] = [];
  /** LAZY, delimiter-bounded — the comment-stripper shape, deliberately exempt. */
  let lazyDelimited = 0;
  /**
   * LAZY, but NOT delimiter-bounded — a distance claim written lazily.
   * `/router\.put\([\s\S]*?requireAdminContext\(/` says "some admin check
   * appears after some PUT registration", which is this estate's headline
   * defect in a spelling the greedy rule does not reach. Counted with a
   * ceiling rather than exempted in silence, which is what the greedy class
   * was until this round.
   */
  const lazyDistanceClaims: string[] = [];
  /** No second anchor at all — an extraction, not a distance claim. */
  let trailingRuns = 0;
  /**
   * A WINDOW BUILT OUT OF ARITHMETIC — `src.slice(start, start + 2000)`.
   *
   * The scan's universe was REGULAR EXPRESSIONS, and the same claim written as
   * a subtraction is not a regular expression, so it was never read at all.
   * Deleting the pattern door does not reach a window built by counting.
   */
  const sliceWindows: string[] = [];
  let sliceCallsRead = 0;
  /** Guards that find a function body by counting braces instead of asking. */
  const handRolledBodyFinders: string[] = [];
  const detectorDrivers: string[] = [];
  let patternsRead = 0;

  beforeAll(() => {
    // The work is here rather than at collect time so the scheduler can see it:
    // vitest orders files by TEST duration, and a cost paid during import is
    // invisible to that ordering. This repository's own budget guard measures it.
    files = scannedFiles();
    const found = classifyEstate(files);
    offenders.push(...found.offenders);
    greedyDistanceClaims.push(...found.greedyDistanceClaims);
    lazyDistanceClaims.push(...found.lazyDistanceClaims);
    sliceWindows.push(...found.sliceWindows);
    handRolledBodyFinders.push(...found.handRolledBodyFinders);
    detectorDrivers.push(...found.detectorDrivers);
    lazyDelimited = found.lazyDelimited;
    trailingRuns = found.trailingRuns;
    patternsRead = found.patternsRead;
    sliceCallsRead = found.sliceCallsRead;
  });

  test("the estate is really walked — population as a runtime number", () => {
    expect(
      files.length,
      `guard-estate files scanned across ${SCANNED_TREES.length} trees: ${files.length}`,
    ).toBeGreaterThanOrEqual(600);
    // BOTH trees, not just the nearer one: a scan that stopped at the
    // repository boundary would report the harness's guards as clean.
    for (const tree of SCANNED_TREES) {
      expect(
        files.filter((f) => f.startsWith(tree)).length,
        `${tree} contributed no files — the walk did not reach it`,
      ).toBeGreaterThan(0);
    }
    // THE GUARD'S OWN SOURCE IS IN ITS UNIVERSE. A prefix filter that drifted
    // (a renamed tree, a moved guard) would read a smaller estate and report
    // it clean; this file running while absent from its own scan is the one
    // state that cannot be honest.
    const self = relative(process.cwd(), fileURLToPath(import.meta.url));
    expect(
      files.includes(self),
      `the guard's own source (${self}) must be inside the universe it judges`,
    ).toBe(true);
  });

  test("the universe contains ONLY committed files — a transient probe can never enter it", () => {
    // THE RACE REGRESSION, PROVEN AS A PROPERTY RATHER THAN PLANTED AS A
    // SAMPLE. The defect was: walk live disk, read each file later, and a
    // sibling's probe file — present at the walk, deleted by its `finally`
    // before the read — reddens this guard or a sibling with ENOENT. The fix
    // is that the universe is the git index, so the property that matters is
    // "every judged file is tracked": an untracked probe is then not skipped
    // or tolerated, it is UNREPRESENTABLE, and no timing of any sibling's
    // writes can change an answer this guard gives.
    //
    // Deliberately NOT driven by writing a probe into the trees for one test
    // interval: that write IS the hazard being removed (a sibling that still
    // walks live disk could collect it), and a containment assertion proves
    // the exclusion for every instant at once rather than for the one instant
    // a probe happened to measure.
    const tracked = gitTrackedPaths(".");
    const untracked = files.filter((file) => !tracked.has(file));
    expect(
      untracked,
      `the judged universe holds files the git index does not — a transient or scratch file entered the estate:\n${untracked.join("\n")}`,
    ).toEqual([]);
  });

  test("no test file uses a proximity window", () => {
    expect(
      offenders,
      "a bounded gap between two anchors is a guess that they are related because they are near each other. "
      + "Scope the claim instead — functionBody() / functionArgumentsOf() / cssRule() / elementWithAttribute() "
      + "→ attributeOf(), then ask with NAMES: bodyCalls(), bodyCallsWith(), bodyBinds(), bodyReturns(), "
      + `cssDeclares(). None of them takes a pattern, so none of them can express this:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("the scan READ a real population — a floor on patterns, not a tautology", () => {
    // A COUNT PROVES THE DETECTOR IS AWAKE. `windowedPatternsIn` returning `[]`
    // for every file in the estate would leave the verdict above green and this
    // one red, which is the whole point: a green offender list is only evidence
    // if something was actually read.
    expect(
      patternsRead,
      `regular-expression literals parsed out of the guard estate: ${patternsRead}`,
    ).toBeGreaterThanOrEqual(3500);
    // …and the enumerator really distinguishes a pattern from a string, so the
    // number above is patterns rather than lines.
    const fixture = regexLiteralsIn('const a = /x/; const b = new RegExp("y"); const c = "/z/";', "liveness fixture");
    expect(fixture.map((f) => f.pattern)).toEqual(["x", "y"]);
  });

  test("the greedy/lazy split the exemption rests on is MEASURED, not asserted", () => {
    // AN EXEMPTION IS A CLAIM ABOUT THE WORLD. The previous version exempted
    // every unbounded run on the stated ground that they are "almost all
    // correct comment strippers" — 25 findings would become 235, so none were
    // judged. That justification was wrong in the direction that mattered:
    // among them sat three assertions spanning the whole of `server/index.ts`
    // with `/uncaughtException[\s\S]*webConsoleError/`, which is this estate's
    // headline defect with the number left off, in a file this scan called
    // clean. Those three are now scoped to the handler they are about.
    //
    // So the line moved, and here are the numbers it moved on, re-derived every
    // run rather than transcribed:
    //   * BOUNDED + a second anchor  → always a window, must be zero
    //   * GREEDY  + a second anchor  → a distance claim, ceilinged below
    //   * LAZY    + a second anchor  → the delimiter-bounded extractor, exempt
    //   * no second anchor           → an extraction, exempt
    const total = offenders.length + greedyDistanceClaims.length + lazyDelimited + trailingRuns;
    // Floor re-derived at the cutover: the estate lost the old tree's
    // guards, and the measured total on the cut tree is 189 (greedy 49,
    // lazy 92, no-second-anchor 48). The floor sits below that with
    // headroom for ordinary guard churn — a scan whose universe went
    // quiet still lands far below it.
    expect(
      total,
      `wildcard runs in the estate — bounded ${offenders.length}, greedy ${greedyDistanceClaims.length}, `
      + `lazy-delimited ${lazyDelimited}, no-second-anchor ${trailingRuns}`,
    ).toBeGreaterThanOrEqual(150);
    // THE LAZY EXEMPTION IS NOT INERT: if this were zero the split would be
    // doing no work and the exemption would be hiding nothing, which would
    // itself mean the classifier had stopped classifying.
    expect(lazyDelimited, "no lazy delimiter-bounded run found — the classifier is not classifying").toBeGreaterThan(0);
    // A RATCHET, NOT AN ALLOWLIST. It is a number the run produces, so a new
    // greedy distance claim breaks it wherever it is written; it is not a list
    // of paths that goes stale. Each remaining one is a separate claim that has
    // to be re-derived against the code it is about — recorded as its own task
    // rather than converted blind, because a scope helper pointed at the wrong
    // region is worse than the window it replaces. THE COUNT IS NOT WRITTEN
    // HERE: the number three lines below is what the run produces, and a second
    // copy of it in English is a number that goes stale silently — which is
    // exactly what happened to the "sixty-two" this sentence used to open with,
    // sitting above a ceiling of fifty-nine.
    expect(
      greedyDistanceClaims.length,
      `greedy unbounded gaps between two anchors: ${greedyDistanceClaims.length}\n${greedyDistanceClaims.join("\n")}\n\n`
      + "Each of these says two things are related because one appears somewhere after the other. "
      + "Scope the claim to the construct it is about; the ceiling only goes down.",
    ).toBeLessThanOrEqual(56);
    // AND THE LAZY EXEMPTION IS NOT A BLANKET ONE. Exempting every lazy run
    // would repeat, one spelling over, exactly the mistake the greedy rule just
    // corrected: `[\s\S]*?` followed by a NAME is a distance claim, and only
    // `[\s\S]*?` followed by a DELIMITER is the extractor the exemption is for.
    //
    // THE POPULATION THIS CEILING BOUNDS WAS RE-DEFINED, SO THE NUMBER WAS
    // RE-DERIVED. The split used to ask whether what follows the run BEGINS
    // WITH a word character, which is a list of one character wearing a
    // property's clothes: eleven shapes walked through it, and prefixing this
    // estate's headline offender with a single `\.` made it exempt and
    // uncounted. The rule now asks whether what follows REQUIRES A NAME to be
    // matched, wherever in the fragment that name sits — so a capture group, a
    // character class, a quote, a lookahead and an escaped dot no longer launder
    // an anchor into a delimiter. Twenty-three patterns moved out of the
    // exemption when it changed, and this ceiling is the measurement AFTER four
    // of them were converted to structural doors, not the one it replaced.
    //
    // It is deliberately CONSERVATIVE: a closing tag (`<\/script>`, `<\/div>`)
    // carries a name and is counted here even though it terminates a construct.
    // Being wrong in that direction costs an EXEMPTION, never a detection, which
    // is the only direction an exemption is allowed to fail in.
    expect(
      lazyDistanceClaims.length,
      `lazy unbounded gaps between two anchors, NOT closed by a delimiter: ${lazyDistanceClaims.length}\n${lazyDistanceClaims.join("\n")}\n\n`
      + "These are distance claims written lazily. They are exempt from the verdict today and counted here so "
      + "the exemption cannot grow unseen; the ceiling only goes down.",
    ).toBeLessThanOrEqual(41);
  });

  test("a window built out of ARITHMETIC is in the universe too", () => {
    // THE UNIVERSE WAS THE WRONG UNIVERSE, and that is a different failure from
    // a detector with a hole. Every assertion above reads REGULAR EXPRESSIONS,
    // and `src.slice(fnStart, fnStart + 2000)` is not one — so the estate's own
    // headline claim, written as a subtraction instead of as a pattern, was
    // never read at all. Deleting the pattern door does not reach it; two of
    // these sit in files a previous round converted off that door and left the
    // arithmetic behind.
    expect(
      // Re-derived after the last six assertion windows were scoped to the
      // constructs they are about: their arithmetic left the population this
      // floor guards, so the floor follows it down. What remains is ordinary
      // truncation and extraction — the shapes the extent rule excuses.
      sliceCallsRead,
      `two-argument slice(start, start + N) calls read: ${sliceCallsRead} — a floor, so a green verdict means something was looked at`,
    ).toBeGreaterThanOrEqual(14);
    expect(
      // The last six assertion sites are converted: the population of
      // distance-bounding slice arithmetic in the estate is now EMPTY, so the
      // claim can be the claim itself rather than a ceiling above it.
      sliceWindows.length,
      `windows built with slice(start, start + N), extent >= ${SLICE_WINDOW_MINIMUM_EXTENT}: ${sliceWindows.length}\n${sliceWindows.join("\n")}\n\n`
      + "Each of these bounds a claim by a byte count. functionBody(), functionArgumentsOf() and "
      + "bindingValueOf() bound it by the construct instead.",
    ).toBe(0);
    // …and the detector really distinguishes a WINDOW from an ordinary slice.
    expect(sliceWindowsIn("const a = s.slice(i, i + 600);", "liveness").map((w) => w.extent)).toEqual([600]);
    expect(sliceWindowsIn("const a = s.slice(i, j);", "liveness"), "a slice between two found positions bounds nothing by distance").toEqual([]);
    expect(sliceWindowsIn("const a = s.slice(0, 60);", "liveness"), "a truncation has no start expression to repeat").toEqual([]);
    expect(sliceWindowsIn("const a = s.slice(i, k + 600);", "liveness"), "a different start makes it a range, not a radius").toEqual([]);
  });

  test.each([{ label: "LF", newline: "\n" }, { label: "CRLF", newline: "\r\n" }])("a window handed to the scan through its real door is found — the plant enters where a caller enters ($label)", ({ newline }) => {
    // THE PLANT THAT DID NOT EXIST. Every other liveness check in this file
    // drives `windowGapIn()` or `sliceWindowsIn()` DIRECTLY, which proves the
    // detector is awake and proves nothing about the scan. Driven: deleting the
    // `offenders.push(row)` branch from the loop left this file GREEN with a
    // real bounded window in the estate, because every number the scan reports
    // — files, patterns read, greedy ceiling, drivers — counts what was READ,
    // and the mutation removed a WRITE.
    //
    // So this one hands a planted file to `classifyEstate` together with the
    // real universe — the door the real run uses.
    //
    // THE PROBE LIVES OUTSIDE THE SCANNED TREES. It used to be written into
    // `tests/prevention/` so the disk walk would discover it — and that write
    // was itself a hazard: any sibling guard walking `tests/` on live disk at
    // that moment could collect the probe and read it after the `finally`
    // below deleted it (observed as a red ENOENT run of the tool-execution
    // owner, whose walk raced this plant). The universe is the git index now,
    // so a probe inside the trees could never be discovered anyway; what the
    // plant must prove is that the JUDGING path faults these shapes, and that
    // path is `classifyEstate`. Discovery is proven by the population test:
    // the index holds every committed file by construction, and the guard's
    // own source is witnessed inside it.
    //
    // THE FILE IS RESTORED IN A `finally`, BEFORE ANY ASSERTION. A test that
    // proves something by performing the real operation writes to shared state,
    // and an assertion that throws first leaves it written — the rule this
    // workspace earned when a mutation run turned confinement off workspace-wide
    // and two later probes measured the damage as if it were a finding. The
    // temp dir's own removal is the registered backstop.
    const probeDir = createTempDir("ch-estate-plant-");
    const planted = join(probeDir, "__planted-window.probe.ts");
    let seen: ReturnType<typeof classifyEstate> | undefined;
    let diagnosticLineArrays = 0;
    const locatedOffsets: number[] = [];
    const formattedPatterns: string[] = [];
    const originalSplit = String.prototype.split;
    const originalSlice = String.prototype.slice;
    const originalView = sourceViews.sourceViewOf;
    const baseline = classifyEstate(files);
    const patterns = {
      boundedWindow: "plantedOpenDoor[\\s\\S]{0,600}plantedCloseDoor",
      greedyRun: "plantedAlpha[\\s\\S]*plantedBeta",
      lazyAnchor: "plantedOne[\\s\\S]*?\\.plantedTwo\\(",
      trailingRun: "plantedTrailing[\\s\\S]*",
      lazyDelimited: "plantedDelimited[\\s\\S]*?\\}",
    };
    const patternMembership = new Set(Object.values(patterns));
    const viewSpy = vi.spyOn(sourceViews, "sourceViewOf").mockImplementation((text, path) => {
      const view = originalView(text, path);
      if (path === planted) {
        const lineAt = view.lineAt;
        view.lineAt = (offset) => { locatedOffsets.push(offset); return lineAt(offset); };
      }
      return view;
    });
    try {
      writeFileSync(planted, [
        "// A probe file written by the estate scan's own end-to-end plant.",
        ...Object.entries(patterns).map(([name, pattern]) => `export const ${name} = /${pattern}/;`),
        "export const arithmetic = (s: string, at: number): string => s.slice(at, at + 900);",
        "",
      ].join(newline));
      const plantedSource = readFileSync(planted, "utf8");
      String.prototype.slice = new Proxy(originalSlice, {
        apply(target, receiver, args) {
          if (args[0] === 0 && args[1] === 120 && patternMembership.has(receiver)) formattedPatterns.push(receiver);
          return Reflect.apply(target, receiver, args);
        },
      });
      String.prototype.split = new Proxy(originalSplit, {
        apply(target, receiver, args) {
          if (args[0] === "\n" && typeof receiver === "string" && receiver.length > 0 && plantedSource.startsWith(receiver)) diagnosticLineArrays += 1;
          return Reflect.apply(target, receiver, args);
        },
      });
      seen = classifyEstate([...files, planted]);
    } finally {
      String.prototype.split = originalSplit;
      String.prototype.slice = originalSlice;
      viewSpy.mockRestore();
      rmSync(planted, { force: true });
    }
    // DENY-BY-DEFAULT, WITNESSED: the probe is outside the judged universe —
    // it is judged because the plant hands it in, never because the scan
    // picked it up. A scan that COULD see it here is a scan whose universe
    // admits transient files again.
    expect(files.includes(planted), `${planted} must NOT be inside the judged universe — it enters only through the plant`).toBe(false);
    expect(
      seen!.offenders.filter((row) => row.includes("plantedCloseDoor")),
      "a BOUNDED window written into a scanned file must reach the offender list — through the loop, not through the detector",
    ).toHaveLength(1);
    expect(
      seen!.greedyDistanceClaims.filter((row) => row.includes("plantedBeta")),
      "a GREEDY distance claim written into a scanned file must reach its bucket",
    ).toHaveLength(1);
    expect(
      seen!.lazyDistanceClaims.filter((row) => row.includes("plantedTwo")),
      "a LAZY run followed by a name — through an escaped dot — must reach its bucket rather than the exemption",
    ).toHaveLength(1);
    expect(
      seen!.sliceWindows.filter((row) => row.includes("+900")),
      "a window built out of arithmetic must reach its bucket too",
    ).toHaveLength(1);
    // AND THE FILE IS GONE. The index universe could never count a leftover
    // probe, but a plant that leaves its evidence lying around is a plant the
    // next reader cannot trust — the hygiene is asserted, not assumed.
    expect(existsSync(planted), "the planted probe must not survive the test that wrote it").toBe(false);
    expect(seen!.offenders.find((row) => row.includes("plantedCloseDoor"))).toContain(`${planted}:2  `);
    expect(seen!.sliceWindows.find((row) => row.includes("+900"))).toContain(`${planted}:7  `);
    expect(diagnosticLineArrays, "diagnostic offsets reuse the source-position index").toBe(0);
    expect(seen!.patternsRead - baseline.patternsRead, "every planted pattern is classified").toBe(Object.keys(patterns).length);
    expect(seen!.trailingRuns - baseline.trailingRuns, "the trailing run remains counted").toBe(1);
    expect(seen!.lazyDelimited - baseline.lazyDelimited, "the delimited run remains counted").toBe(1);
    expect(formattedPatterns, "only retained regex diagnostics are formatted").toEqual([patterns.boundedWindow, patterns.greedyRun, patterns.lazyAnchor]);
    expect(locatedOffsets, "only retained regex and slice diagnostics need locations").toHaveLength(4);
  });

  test("no guard grows another copy of the body finder the owner replaced", () => {
    // The owner exists and its callers still roll their own. That is the same
    // failure as a proximity window with the pattern removed — a guard
    // approximating a construct — and the three traps that made the first
    // hand-rolled extractor return the WRONG REGION for 212 of 6,512 names all
    // still fire in these files.
    //
    // A ceiling rather than a ban, because each conversion has to be re-derived
    // against the code it asserts about. The ceiling only goes down.
    expect(
      handRolledBodyFinders.length,
      `guard files that locate a body by counting braces themselves: ${handRolledBodyFinders.length}\n`
      + `${handRolledBodyFinders.join("\n")}\n\n`
      + "functionBody() / functionBodies() / functionsCalling() / enclosingFunctionOf() answer this with a parser, "
      + "and are differentiated against a second parser over 7,200 functions every run.",
    ).toBeLessThanOrEqual(10);
    // …and the detector is not vacuous: both halves are required, and each one
    // alone is ordinary code that must NOT be flagged.
    expect(rollsItsOwnBodyFinder('const at = src.indexOf("{");\nlet depth = 0;\ndepth += 1;')).toBe(true);
    expect(rollsItsOwnBodyFinder('const at = src.indexOf("{");'), "locating a brace is not a body finder").toBe(false);
    expect(rollsItsOwnBodyFinder("let depth = 0;\ndepth += 1;"), "counting depth is not a body finder").toBe(false);
  });

  test("the exemption for detector-driving files is measured, not assumed", () => {
    // AN EXEMPTION IS A CLAIM ABOUT THE WORLD. The files granted it both drive
    // the detector AND carry a gap the scan would otherwise classify; the next
    // test proves that second condition is what grants the waiver. A third file
    // is not automatically wrong, but it must be seen.
    expect(
      detectorDrivers.length,
      `files granted the detector-driver exemption: ${detectorDrivers.length}\n${detectorDrivers.join("\n")}`,
    ).toBeLessThanOrEqual(2);
    expect(
      detectorDrivers.length,
      "no file is granted the exemption — the exemption is inert, which means this scan is not reading what it thinks",
    ).toBeGreaterThan(0);
    // …and the property really is a property of the SOURCE, not of the path.
    expect(drivesTheDetector('import { windowGapIn } from "../helpers/function-scope.ts";')).toBe(true);
    expect(drivesTheDetector('import { functionBody } from "../helpers/function-scope.ts";')).toBe(false);
    expect(drivesTheDetector("// a comment mentioning windowGapIn is not an import")).toBe(false);
  });

  test("a detector-driver exemption that suppresses nothing is STALE, and it suppresses only its own file", () => {
    // THE STALE-EXEMPTION DEFECT. The rule skips ANY file importing the
    // detector. If the import survives but the file stops writing a gap the
    // scan would classify, the waiver suppresses NOTHING and no assertion could
    // notice. This arm is the one that reds; the import-only probe below drives
    // the same liveness function the real population passes through.
    const stale = inertDetectorExemptions(detectorDrivers);
    expect(
      stale,
      `files granted the detector-driver exemption while suppressing nothing:\n${stale.join("\n")}`,
    ).toEqual([]);
    const suppressed = detectorDrivers.reduce(
      (total, file) => total + detectorFixtureGaps(readFileSync(file, "utf8"), file),
      0,
    );
    expect(suppressed, "the detector-driver exemption as a whole suppresses no finding — it is inert").toBeGreaterThan(0);
    for (const file of detectorDrivers) {
      expect(drivesTheDetector(readFileSync(file, "utf8")), `${file} is in the exemption set but no longer imports the detector`).toBe(true);
      expect(detectorFixtureGaps(readFileSync(file, "utf8"), file), `${file} is exempted but carries no gap to suppress`).toBeGreaterThan(0);
    }

    const probeDir = createTempDir("ch-detector-exemption-");
    const staleProbe = join(probeDir, "__stale-driver.probe.ts");
    const liveProbe = join(probeDir, "__live-driver.probe.ts");
    const windowProbe = join(probeDir, "__window-only.probe.ts");
    writeFileSync(staleProbe, 'import { windowGapIn } from "../helpers/function-scope.ts";\n', "utf8");
    writeFileSync(
      liveProbe,
      'import { windowGapIn } from "../helpers/function-scope.ts";\nexport const live = /openDoor[\\s\\S]{0,600}closeDoor/;\n',
      "utf8",
    );
    writeFileSync(windowProbe, "export const unexempted = /openDoor[\\s\\S]{0,600}closeDoor/;\n", "utf8");

    expect(
      inertDetectorExemptions([staleProbe]),
      "a driver-shaped file with no gap must be reported stale (it suppresses nothing)",
    ).toEqual([staleProbe]);
    expect(
      inertDetectorExemptions([liveProbe]),
      "a driver that really writes a gap is live, not stale",
    ).toEqual([]);

    // THE SCOPE. One classification pass over all three files: both importers
    // are exempt by the import rule, and the window WITHOUT the import is an
    // offender in the same pass. The stale probe's own bucket is empty, which
    // is exactly why the liveness arm above has to red it — an exemption that
    // suppresses nothing is not a clean file, it is a dead claim.
    const classified = classifyEstate([staleProbe, liveProbe, windowProbe]);
    expect(classified.detectorDrivers).toEqual([staleProbe, liveProbe]);
    expect(
      classified.offenders.filter((row) => row.includes(windowProbe)),
      "a window in a file that does NOT import the detector must still be an offender",
    ).toHaveLength(1);
    expect(
      classified.offenders.filter((row) => row.includes(staleProbe)),
      "the stale import carries no finding for the exemption to hide",
    ).toHaveLength(0);

    // The probe is outside the committed universe and removed by its temp dir.
    expect(files.includes(staleProbe), "the stale-exemption plant must not enter the judged universe").toBe(false);
  });

  test("the exempted production trees are measured, not merely excused", () => {
    // AN EXEMPTION IS A CLAIM ABOUT THE WORLD and carries the same evidence
    // burden as a detection. The claim is "the only windows outside the scan are
    // the natural-language heuristics"; here is the number behind it, re-derived
    // every run, with a ceiling that a new one would break.
    const exempt: string[] = [];
    const exemptGreedy: string[] = [];
    let exemptFiles = 0;
    for (const tree of EXEMPT_TREES) {
      expect(statSync(tree).isDirectory(), `${tree} must be a directory — a missing exemption root is not an empty one`).toBe(true);
      const walkTree = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (["node_modules", ".git", "dist", "coverage", ".vite", ".bridlewise"].includes(entry.name)) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walkTree(full);
          else if (entry.isFile() && /\.(ts|mts|cts)$/.test(entry.name)) {
            exemptFiles += 1;
            for (const found of windowedPatternsIn(readFileSync(full, "utf8"), full)) {
              // SPLIT BY CLASS, so the number this exemption has always been
              // about is not diluted by the class newly judged this round.
              // Raising one ceiling to absorb the other would be exactly the
              // budget-raising the contract forbids.
              (found.gap.bounded ? exempt : exemptGreedy).push(`${full}  [${found.gap.text}]  /${found.pattern.slice(0, 80)}/`);
            }
          }
        }
      };
      walkTree(tree);
    }
    expect(exemptFiles, `production files measured outside the scan: ${exemptFiles}`).toBeGreaterThanOrEqual(700);
    expect(
      exempt.length,
      `BOUNDED windows in the EXEMPT production trees: ${exempt.length}\n${exempt.join("\n")}\n\n`
      + "These are the natural-language and foreign-code heuristics the exemption names. A new one is not "
      + "automatically wrong, but it must be a deliberate decision rather than an unnoticed one.",
    ).toBeLessThanOrEqual(10);
    expect(
      exemptGreedy.length,
      `GREEDY unbounded runs in the EXEMPT production trees: ${exemptGreedy.length}\n${exemptGreedy.join("\n")}\n\n`
      + "Measured when the scan began judging greedy runs. Every one of these is a language or foreign-code "
      + "heuristic in a quality pack or an awareness reader — a claim about SOMEBODY ELSE'S source, which has "
      + "no first-party body to scope to. This ceiling is separate from the bounded one above so that neither "
      + "class can quietly absorb the other.",
    ).toBeLessThanOrEqual(23);
  });

  test("the detector recognises every spelling of the window, and no honest pattern", () => {
    // PLANTED VIOLATIONS — the class, in shapes not currently in either tree,
    // INCLUDING the six that the previous spelling-list detector admitted.
    for (const planted of [
      String.raw`openDoor[\s\S]{0,600}?closeDoor\(`,
      String.raw`alpha.{0,40}beta`,
      String.raw`one[^]{0,80}two`,
      String.raw`x([^\n]{0,20})y`,
      String.raw`a[\s\S]{1,300}b`,
      String.raw`a[\S\s]{0,600}b`,
      String.raw`a[\w\W]{0,600}b`,
      String.raw`a[\d\D]{0,600}b`,
      String.raw`a(?:.|\n){0,600}b`,
      String.raw`a(?:[\s\S]){0,600}b`,
      String.raw`a[\s\S]{600}b`,
      String.raw`a[\0-￿]{0,600}b`,
      String.raw`a[\x00-￿]{0,600}b`,
      String.raw`a(.|[\r\n]){0,600}b`,
    ]) {
      expect(windowGapIn(planted), `must be recognised: ${planted}`).toBeDefined();
    }
    // CLEAN CONTROLS — quantifiers that bound a concrete token rather than a gap
    // between anchors, and the delimiter-bounded shapes a comment stripper and a
    // structural extractor are correctly written with.
    for (const clean of [
      String.raw`^[0-9a-f]{6,64}$`,
      String.raw`^[A-Z]{2,4}-\d+$`,
      String.raw`\/\*[\s\S]*?\*\/`,
      String.raw`\/\/[^\n]*`,
      // A regular-expression escaper's own class. It contains a literal `[`,
      // which a depth-counting lexer reads as an unclosed class and then
      // mis-lexes the `.` after it as a wildcard — measured: eleven false
      // accusations in the guard estate before classes were lexed correctly.
      // (Written as a concatenation because `${` opens a substitution.)
      "[.*+?^$" + String.raw`{}()|[\]\\]`,
      String.raw`onclick=\{[^}]*onopenbeat\(beat\.id\)`,
      String.raw`detectSecretSpans\(text, policy, options\)`,
      String.raw`cursor:\s*_cursor`,
    ]) {
      expect(windowGapIn(clean), `must not be flagged: ${clean}`).toBeUndefined();
    }
  });

  test("the scan reads PARSED patterns, so prose is not a finding and a two-line pattern is", () => {
    // THE TWO ERRORS A TEXT SCAN MAKES, both planted. Neither is expressible in
    // a line-by-line detector, which is why this was invisible before.
    expect(
      windowedPatternsIn('// the owner is the single console.* choke point\nconst x = 1;\n', "prose fixture"),
      "a comment about `console.*` is prose, not a pattern",
    ).toEqual([]);
    const acrossLines = windowedPatternsIn(
      'const re = /openDoor[\\s\\S]{0,\n600}closeDoor/;\n'.replace("{0,\n600}", "{0,600}"),
      "single-line fixture",
    );
    expect(acrossLines.length, "a real windowed literal is still found").toBe(1);
    expect(
      windowedPatternsIn('const re = new RegExp("openDoor[\\\\s\\\\S]{0,600}closeDoor");\n', "constructed fixture").length,
      "a window built with `new RegExp` is the same window",
    ).toBe(1);
  });
});

/**
 * THE RETIRED WINDOWS, RE-DRIVEN.
 *
 * For every assertion converted to a structural scope, the same proof: build
 * the source with a NEIGHBOUR inside the retired window, and show the retired
 * pattern accepted it while the scope does not. Without this the conversions
 * would be a claim; with it they are a measurement.
 *
 * The table is EVIDENCE, not enforcement — the enforcement is the estate scan
 * above, whose universe is discovered. A site dropping out of this table
 * cannot make the estate scan pass.
 */
describe("every retired window really was satisfiable by a neighbour", () => {
  const cases = [
    {
      site: "subprocess-confinement-owner.test.ts:1590 — runGitConfined → gitText",
      // The real shape: the subject's body no longer calls the thing, and the
      // NEXT function does.
      source: `export function runGitConfined(repoPath: string, args: string[]): string {
  return spawnRawGit(repoPath, args);
}

export function isGitRepo(repoPath: string): boolean {
  if (!existsSync(repoPath)) return false;
  return gitText(repoPath, ["rev-parse"]);
}`,
      retired: /export function runGitConfined[\s\S]{0,600}?return gitText\(/,
      scoped: (src: string) => bodyCalls(functionBody(src, "runGitConfined"), "gitText"),
    },
    {
      site: "privacy-layers-owner.test.ts:694 — redactText → detectSecretSpans",
      source: `export function redactText(text, policy, options = {}) {
  return applyRedactions(text, detectSensitiveSpans(text, policy), policy);
}

export function hasSensitiveContent(text, policy, options) {
  return detectSecretSpans(text, policy, options).length > 0;
}`,
      retired: /redactText[\s\S]{0,2200}?detectSecretSpans\(text, policy/,
      scoped: (src: string) => bodyCalls(functionBody(src, "redactText"), "detectSecretSpans"),
    },
    {
      site: "secret-intelligence-owner.test.ts:693 — readLlmApiConfigRaw → rememberOwnCredential",
      source: `export function readLlmApiConfigRaw() {
  return JSON.parse(readFileText(serverConfig.llmConfigPath));
}

export function refreshLlmCredential(parsed) {
  rememberOwnCredential(parsed.apiKey);
}`,
      retired: /readLlmApiConfigRaw[\s\S]{0,1600}?rememberOwnCredential\(parsed\.apiKey/,
      scoped: (src: string) => bodyCalls(functionBody(src, "readLlmApiConfigRaw"), "rememberOwnCredential"),
    },
    {
      site: "stream-pulse.test.ts:363 — onModelEvent → advanceWait(\"answering\")",
      source: `  const handlers = {
    onModelEvent: (event) => {
      appendDelta(event);
    },
    onDone: () => {
      advanceWait("answering");
    },
  };`,
      retired: /onModelEvent:[\s\S]{0,300}advanceWait\("answering"\)/,
      scoped: (src: string) => bodyCallsWith(functionBody(src, "onModelEvent"), "advanceWait", ['"answering"']),
    },
    {
      site: "timeline-recording-fidelity.test.ts:145 — refreshTimeline → cursor: _cursor",
      source: `export async function refreshTimeline() {
  return fetchTimeline({ cursor: heldCursor });
}

export async function loadMoreTimeline() {
  return fetchTimeline({ cursor: _cursor });
}`,
      retired: /refreshTimeline[\s\S]{0,600}cursor:\s*_cursor/,
      scoped: (src: string) => bodyBinds(functionBody(src, "refreshTimeline"), "cursor", "_cursor"),
    },
    {
      site: "flow-density-owner.test.ts:313 — .mine .options → justify-content",
      source: `.mine .options {
    gap: var(--sp-1);
  }
  .theirs .options {
    justify-content: flex-end;
  }`,
      retired: /\.mine \.options[\s\S]{0,120}justify-content:\s*flex-end/,
      scoped: (src: string) => cssDeclares(cssRule(src, ".mine .options"), "justify-content", "flex-end"),
    },
    {
      site: "cockpit-mouse-path-owner.test.ts:508 — the scope grip's own onclick",
      source: `<button data-chord-target="open-scope" title="Open"></button>
  <button class="beat-grip" onclick={() => onopenbeat(beat.id)}></button>`,
      retired: /data-chord-target="open-scope"[\s\S]{0,200}onclick=\{[^}]*onopenbeat\(beat\.id\)/,
      scoped: (src: string) =>
        bodyCallsWith(attributeOf(elementWithAttribute(src, 'data-chord-target="open-scope"'), "onclick"), "onopenbeat", ["beat.id"]),
    },
    {
      site: "module-shell-owner.test.ts:150 — the error state's own kind",
      source: `<EmptyState title="Nothing here" />
    <Banner kind="error" />`,
      retired: /EmptyState[\s\S]{0,80}kind="error"|kind="error"[\s\S]{0,80}EmptyState/,
      scoped: (src: string) => attributeOf(elementWithAttribute(src, "<EmptyState"), "kind").body === "error",
    },
    {
      site: "integration-intelligence-owner.test.ts:151 — walkDirectory's own catch",
      source: `function walkDirectory(root, dirPath) {
  let entries = readdirSync(fullDir, { withFileTypes: true });
  return entries;
}

function readOne(path) {
  try { return readFileSync(path); } catch (e) { handleError(e); return []; }
}`,
      retired: /entries\s*=\s*readdirSync\(fullDir[\s\S]{0,160}?catch\s*\((\w+)\)[\s\S]{0,120}return\s*\[\];/,
      // The retired pattern is anchored on the LISTING and reaches BACKWARDS in
      // reading order only by luck; the scoped form asks the listing function.
      scoped: (src: string) => bodyCalls(functionBody(src, "walkDirectory"), "handleError"),
    },
    {
      site: "content-search-owner.test.ts:307 — the walk orders its own listing",
      source: `function walkDirectory(dir) {
  return readdirSync(dir, { withFileTypes: true }).map((d) => d.name);
}

function renderNames(names) {
  return orderDirectoryEntries(names);
}`,
      retired: /readdirSync\s*\([\s\S]{0,600}?orderDirectoryEntries\s*\(/,
      scoped: (src: string) => functionsCalling(src, "readdirSync").every((scope) => bodyCalls(scope, "orderDirectoryEntries")),
    },
  ] as const;

  test("the table covers every converted site — population as a runtime number", () => {
    expect(cases.length, `retired windows re-driven: ${cases.length}`).toBeGreaterThanOrEqual(10);
  });

  for (const { site, source, retired, scoped } of cases) {
    test(`${site}: the window accepted a neighbour, the scope does not`, () => {
      expect(retired.test(source), "the retired window must accept the planted neighbour — otherwise this proves nothing").toBe(true);
      // REFUSAL, IN EITHER OF ITS TWO HONEST FORMS. Answering `false` is one;
      // THROWING is the stronger one, and it is what the doors do when the
      // subject itself is absent — an element that does not carry the
      // attribute, a function that no longer exists. Requiring `false` here
      // would have forced the doors to answer "nothing is wrong with it" for a
      // subject that had vanished, which is the vacuous-scan defect this estate
      // keeps rediscovering.
      let verdict: boolean | string;
      try { verdict = scoped(source); } catch (e) { verdict = `refused: ${(e as { code?: string }).code ?? "error"}`; }
      expect(verdict, "the structural scope must refuse the planted neighbour").not.toBe(true);
    });
  }
});

describe("the shared owner makes the shape UNSAYABLE THROUGH A DOOR, not merely refused", () => {
  test("NO door in this suite's helper accepts a RegExp", () => {
    // THE RUNG-2 ASSERTION, on the door file this suite actually imports.
    // Everything under it used to be about whether a DETECTOR could recognise a
    // windowed pattern arriving at `bodyMatches`. It was rewritten twice and
    // holed twice — four known spellings, then a forty-character probe alphabet
    // that `[^\uffff]` walks straight through — because deciding "is this atom
    // a wildcard" needs an alphabet and an alphabet is a list.
    //
    // There is no such door now. Every question is asked with NAMES, so this
    // file no longer tests a detector's completeness; it tests that there is
    // nothing to detect.
    // ── THE PROPERTY IS OVER EVERY EXPORT, NOT OVER ONE DECLARATION FORM ──
    //
    // This used to read `exportedFunctionParameters`, which walked
    // `ExportNamedDeclaration` and kept only `FunctionDeclaration`s. Fourteen
    // pattern-doors were planted into a copy of the real module and it saw
    // FIVE. Three planted into the real file left this test GREEN while each
    // one demonstrably answered a proximity window `true` where the call graph
    // says `false`: an `export const` arrow, an `export { f }` specifier, and a
    // `string` parameter compiled with `new RegExp` inside. "A door added
    // tomorrow is covered because nobody had to remember" was false in the
    // three most ordinary directions.
    //
    // So the subject is now EVERY EXPORTED BINDING BY ANY FORM, and the three
    // things that can make one a pattern door are each asserted as a property:
    // its parameters may not name a pattern type, they may not carry a pattern
    // literal, and its body may not BUILD one.
    const door = readFileSync("tests/helpers/function-scope.ts", "utf8");
    const ownerPath = modulePath("source-structure.ts");
    const owner = readFileSync(ownerPath, "utf8");
    const surface = exportedBindings(owner, ownerPath);
    expect(surface.size, `exported bindings in the owner: ${surface.size}`).toBeGreaterThanOrEqual(20);

    // 1. NOTHING IS EXPORTED FROM SOMEWHERE THIS CANNOT READ. A re-export is
    //    the route that made three of the fourteen invisible, and the fix is
    //    not to follow it — it is to refuse a surface with an unreadable part,
    //    because a certifier that counts what it can see reports a hole as a
    //    clean run.
    expect(
      [...surface].filter(([, binding]) => binding.kind === "elsewhere").map(([name]) => name),
      "an export this source cannot read is an unknown door, not an absent one",
    ).toEqual([]);

    // 2. NO EXPORTED SIGNATURE ADMITS A PATTERN — by type name or by literal.
    const admitsAPattern = [...surface]
      .filter(([, binding]) => binding.kind === "function"
        && (/\bRegExp\b/.test(binding.parameters) || regexLiteralsIn(`function _(${binding.parameters}) {}`, "parameters").length > 0))
      .map(([name, binding]) => `${name}(${binding.parameters})`);
    expect(
      admitsAPattern,
      "a door that takes a RegExp is a door a proximity window fits through",
    ).toEqual([]);

    // 3. AND NO EXPORTED DOOR BUILDS ONE. A `pattern: string` compiled with
    //    `new RegExp` inside is a pattern door whose signature is spotless —
    //    the shape a signature property cannot see, so it is asked of the call
    //    graph instead. The module DOES construct patterns twice, both inside
    //    `atomIsGap`, which is module-private; the distinction between an
    //    internal use and an exported door is exactly "is the constructing
    //    function exported", and that needs no list.
    const buildsAPattern = [...surface]
      .filter(([, binding]) => binding.kind === "function" && binding.declaredAs !== undefined
        && bodyCalls(functionBody(owner, binding.declaredAs, binding.declaredAs), "RegExp"))
      .map(([name]) => name);
    expect(
      buildsAPattern,
      "an exported function that constructs a RegExp can accept a window as a string and compile it",
    ).toEqual([]);

    // …and this suite's helper re-exports only what the owner exports, so the
    // assertions above cover everything this suite can reach. It is asserted
    // STRUCTURALLY rather than by scanning the helper's text: the first draft
    // of this test read the helper for the string `bodyMatches` and faulted its
    // own DOC COMMENT, which explains why the door was removed. A text scan
    // cannot tell a mention from a declaration — the exact confusion this whole
    // file exists to argue against.
    for (const name of retiredDoors) {
      expect(
        exportedNamesOf(door).includes(name),
        `${name} must not be re-exported: it is the door a proximity window fitted through`,
      ).toBe(false);
    }
    expect(exportedNamesOf(door).length, `doors re-exported to this suite: ${exportedNamesOf(door).length}`).toBeGreaterThan(10);
    expect(
      exportedNamesOf(door).filter((name) => !surface.has(name)),
      "the door file must re-export only names the owner exports — a name it invents is a door nothing above certifies",
    ).toEqual([]);
  });

  /**
   * THE FOURTEEN SHAPES, PLANTED INTO THE REAL FILE — the liveness the previous
   * version did not have.
   *
   * Its liveness was a string literal handed to the detector, and that proves
   * the detector is AWAKE. It does not prove the detector would see a door
   * ADDED TO THE MODULE, which is the claim being made. Planting into a copy of
   * the actual file turned "covered without anybody remembering" into "5 of
   * 14", and it is the difference between a statement about an instrument and a
   * statement about a verdict.
   *
   * The copy is built in memory and the file on disk is never written.
   */
  test("a pattern door added to the REAL module in ANY spelling is caught", () => {
    const ownerPath = modulePath("source-structure.ts");
    const owner = readFileSync(ownerPath, "utf8");

    /** The certification above, as a function, so the plants drive the PATH. */
    const certify = (source: string): readonly string[] => {
      const surface = exportedBindings(source, "planted");
      const faults: string[] = [];
      for (const [name, binding] of surface) {
        if (binding.kind === "elsewhere") { faults.push(`${name}: exported from elsewhere`); continue; }
        if (binding.kind !== "function") continue;
        if (/\bRegExp\b/.test(binding.parameters)) faults.push(`${name}: RegExp in parameters`);
        else if (regexLiteralsIn(`function _(${binding.parameters}) {}`, "parameters").length > 0) faults.push(`${name}: pattern literal in parameters`);
        if (binding.declaredAs !== undefined && bodyCalls(functionBody(source, binding.declaredAs, binding.declaredAs), "RegExp")) faults.push(`${name}: builds a RegExp`);
      }
      return faults;
    };

    // The unplanted module must certify CLEAN, or every plant below proves
    // nothing about the plant.
    expect(certify(owner), "the real module must certify clean before anything is planted").toEqual([]);

    const plants = [
      ["export function", "export function plantedDoor(scope: SourceScope, pattern: RegExp): boolean { return false; }"],
      ["export async function", "export async function plantedDoor(scope: SourceScope, pattern: RegExp): Promise<boolean> { return false; }"],
      ["rest parameter", "export function plantedDoor(scope: SourceScope, ...patterns: readonly RegExp[]): boolean { return false; }"],
      ["inline options bag", "export function plantedDoor(scope: SourceScope, options: { pattern: RegExp }): boolean { return false; }"],
      ["export const ARROW", "export const plantedDoor = (scope: SourceScope, pattern: RegExp): boolean => false;"],
      ["export const function expression", "export const plantedDoor = function (scope: SourceScope, pattern: RegExp): boolean { return false; };"],
      ["specifier export", "function plantedDoor(scope: SourceScope, pattern: RegExp): boolean { return false; }\nexport { plantedDoor };"],
      ["renamed specifier", "function plantedLocal(scope: SourceScope, pattern: RegExp): boolean { return false; }\nexport { plantedLocal as plantedDoor };"],
      ["re-export from another module", 'export { bodyMatches } from "./legacy-pattern-door.ts";'],
      ["export star", 'export * from "./legacy-pattern-door.ts";'],
      ["DEFAULT PARAMETER carrying a window", "export function plantedDoor(scope: SourceScope, pattern = /a[\\s\\S]{0,600}b/): boolean { return pattern.test(scope.body); }"],
      ["a STRING compiled with new RegExp", "export function plantedDoor(scope: SourceScope, pattern: string): boolean { return new RegExp(pattern).test(scope.body); }"],
      ["a string compiled with RegExp(), no new", "export function plantedDoor(scope: SourceScope, pattern: string): boolean { return RegExp(pattern).test(scope.body); }"],
    ] as const;

    const escaped: string[] = [];
    for (const [what, plant] of plants) {
      const faults = certify(`${owner}\n\n${plant}\n`);
      if (faults.length === 0) escaped.push(what);
    }
    expect(
      escaped,
      `${escaped.length} of ${plants.length} pattern-door spellings were planted into the REAL module and left the acceptance instrument green`,
    ).toEqual([]);
    expect(plants.length, `door spellings planted into the real module: ${plants.length}`).toBeGreaterThanOrEqual(13);

    // THE SHAPES THIS PROPERTY CANNOT REACH, DRIVEN AS ESCAPES so the edge is a
    // measurement rather than a sentence. A parameter typed through an alias or
    // an interface declared in another file, and a PREDICATE parameter, are
    // both invisible to a signature property — and the predicate is not really
    // this door's problem: `SourceScope.body` is a public string, so a caller
    // can already run its own pattern over it. That is the recorded rung-3 task
    // "a guard may not apply a pattern to unscoped source", not a hole here.
    const knownEscapes = [
      ["a type alias declared here", "type PlantedPattern = RegExp;\nexport function plantedDoor(scope: SourceScope, pattern: PlantedPattern): boolean { return false; }"],
      ["an interface bag", "interface PlantedOptions { pattern: RegExp }\nexport function plantedDoor(scope: SourceScope, options: PlantedOptions): boolean { return false; }"],
      ["a predicate parameter", "export function plantedDoor(scope: SourceScope, accept: (text: string) => boolean): boolean { return accept(scope.body); }"],
    ] as const;
    for (const [what, plant] of knownEscapes) {
      expect(
        certify(`${owner}\n\n${plant}\n`),
        `KNOWN escape from the signature property; if this is now caught, remove it from the list deliberately: ${what}`,
      ).toEqual([]);
    }
    expect(knownEscapes.length, `known escapes from the export-surface property: ${knownEscapes.length}`).toBe(3);
  });

  test("the ESTATE SCAN still recognises every spelling it can lex — and its limit is measured", () => {
    // The spellings still matter, but at rung 5 rather than at a door: the scan
    // reads guard source, and a guard that never imports the owner can still
    // write `expect(wholeFile).toMatch(/a[\s\S]{0,600}b/)`.
    const recognised = [
      String.raw`a[\s\S]{0,600}b`, String.raw`a[^]{0,600}b`, String.raw`a.{0,600}b`,
      String.raw`a[\s\S]{1,600}b`, String.raw`a[\S\s]{0,600}b`, String.raw`a[\d\D]{0,600}b`,
      String.raw`a[\w\W]{0,600}b`, String.raw`a(?:.|\n){0,600}b`, String.raw`a[^\n]{0,600}b`,
      String.raw`a[\s\S]{600}b`, String.raw`a(?:[\s\S]){0,600}b`, String.raw`a[\0-\uffff]{0,600}b`,
      String.raw`a[\x00-\uffff]{0,600}b`, String.raw`a(.|[\r\n]){0,600}b`, String.raw`a[\s\S]{2}b`,
      String.raw`a[\S\s]{0,600}?b`, String.raw`a[^\ufff0]{0,600}b`,
      // The greedy unbounded shapes, newly judged — the same guess with the
      // number left off, and the shape that hid a live offender.
      String.raw`a[\s\S]*b`, String.raw`a.+b`,
      String.raw`unhandledRejection[\s\S]*webConsoleError`,
    ];
    for (const spelling of recognised) {
      expect(windowGapIn(spelling), `must be recognised: ${spelling}`).toBeDefined();
    }
    expect(recognised.length, `window spellings driven at the scan: ${recognised.length}`).toBeGreaterThanOrEqual(20);

    // THE KNOWN ESCAPES, DRIVEN AS ESCAPES. A universe with a stated edge is
    // still a universe, so the edge is a measurement rather than a sentence in
    // a comment. If one of these is ever caught, this test fails and somebody
    // deletes it deliberately — which is the opposite of a hole being closed by
    // accident and nobody knowing the shape of what remains.
    const knownEscapes = [
      String.raw`a[^\uffff]{0,600}b`,          // excludes exactly the last probe character
      String.raw`a\p{Any}{0,600}b`,            // a property escape is lexed as `\p` + `{Any}`
      String.raw`a(?:[\s\S][\s\S][\s\S]){0,200}b`, // a group needing three characters
    ];
    for (const escape of knownEscapes) {
      expect(
        windowGapIn(escape),
        `KNOWN escape from the estate scan; if this is now caught, remove it from the list deliberately: ${escape}`,
      ).toBeUndefined();
    }
    expect(knownEscapes.length, `known escapes: ${knownEscapes.length}`).toBe(3);
  });

  test("the classifier reports three separate facts, so a policy change is visible as one", () => {
    expect(patternGapIn(String.raw`a[\s\S]{0,600}b`)).toMatchObject({ bounded: true, greedy: true, anchored: true });
    expect(patternGapIn(String.raw`\/\*[\s\S]*?\*\/`)).toMatchObject({ bounded: false, greedy: false, anchored: true });
    expect(patternGapIn(String.raw`\/\/[^\n]*`)).toMatchObject({ anchored: false });
    // A bounded run is a window even when lazy: the NUMBER is the guess.
    expect(windowGapIn(String.raw`a[\s\S]{0,600}?b`)).toBeDefined();
    // A run with no second anchor is not a distance claim in any spelling.
    expect(windowGapIn(String.raw`\/\/[^\n]*`)).toBeUndefined();
  });

  test("raw source cannot be passed where a scope belongs, and the brand cannot be forged", () => {
    expect(() => bodyCalls("function f() { g(); }" as never, "g")).toThrowError(/not raw source/);
    expect(isSourceScope("function f() {}"), "a string is not a scope").toBe(false);
    expect(isSourceScope(functionBody("function f() { }", "f"))).toBe(true);

    // THE FORGE, ATTEMPTED. The brand used to be `Symbol.for(…)` — the GLOBAL
    // registry — with the key written in the owner's own source, so any caller
    // could mint a scope in one line and hand whole-file text to the door built
    // to stop exactly that. Every route in is tried here and every one fails.
    const wholeFile = "export function runGitConfined() { return spawnSync('git'); }\nfunction other() { return gitText(); }";
    const forgeries: readonly [string, unknown][] = [
      ["global symbol registry, the old key", { [Symbol.for("tests/helpers/function-scope#SourceScope")]: true, kind: "function", name: "runGitConfined", body: wholeFile, offset: 0 }],
      ["a plain object of the right shape", { kind: "function", name: "runGitConfined", body: wholeFile, offset: 0 }],
      ["a frozen object of the right shape", Object.freeze({ kind: "function", name: "runGitConfined", body: wholeFile, offset: 0 })],
      ["a copy of a real scope", { ...functionBody("function f() { g(); }", "f"), body: wholeFile }],
      ["a real scope's prototype", Object.create(Object.getPrototypeOf(functionBody("function f() { g(); }", "f")) as object)],
    ];
    for (const [how, forged] of forgeries) {
      expect(isSourceScope(forged), `forgery must not be recognised: ${how}`).toBe(false);
      expect(() => bodyCalls(forged as never, "gitText"), `forgery must not reach the door: ${how}`)
        .toThrowError(/not raw source/);
    }
    expect(forgeries.length, `forge attempts driven: ${forgeries.length}`).toBeGreaterThanOrEqual(5);

    // …and a spread of a REAL scope loses the brand, which is the point: the
    // identity is held outside the value, so copying the value copies nothing.
    const real = functionBody("function f() { g(); }", "f");
    expect(isSourceScope({ ...real }), "a structural copy is not the scope").toBe(false);
    expect(bodyCalls(real, "g"), "the real scope still works").toBe(true);
  });

  test("an absent subject is a failure, never a clean verdict", () => {
    // THE VACUOUS-SCAN CLASS, closed at the helper rather than at each caller.
    expect(() => functionBody("const x = 1;", "missingFunction")).toThrowError(/no declaration of/);
    expect(() => cssRule(".a { color: red; }", ".b")).toThrowError(/no rule in this stylesheet/);
    expect(() => elementWithAttribute("<div />", "data-nope")).toThrowError(/no element carries/);
  });

  test("a grouped CSS selector still names its rule", () => {
    // The reason this does not delegate to `cssBlock`: that helper answers
    // "what follows `selector {`", which is "" for a grouped selector AND ""
    // for an absent one — two very different facts with one answer.
    const grouped = `.level-ghost .options,
  .level-tick .options {
    height: 0;
  }`;
    expect(cssDeclares(cssRule(grouped, ".level-ghost .options"), "height", "0")).toBe(true);
    expect(cssDeclares(cssRule(grouped, ".level-tick .options"), "height", "0")).toBe(true);
  });

  test("a default parameter value is not a function body", () => {
    // THE PARSER BUG THIS FILE CAUGHT, kept as a test because a scope helper
    // that returns the wrong region is worse than the window it replaces: it
    // looks structural. `options = {}` was being read as the whole body, so
    // every assertion about that function silently became an assertion about
    // two bytes.
    const src = `export function redactText(
  text: string,
  options: DetectionOptions = {},
): RedactionResult {
  return detectSecretSpans(text, options);
}`;
    expect(bodyCalls(functionBody(src, "redactText"), "detectSecretSpans")).toBe(true);
    expect(functionBody(src, "redactText").body.length).toBeGreaterThan(20);
  });

  test("a return type containing braces is not a function body either", () => {
    const src = `export function generateRepositoryMap(root: string): Readonly<{ map: RepositoryMap }> {
  return { map: buildMap(root) };
}`;
    expect(bodyCalls(functionBody(src, "generateRepositoryMap"), "buildMap")).toBe(true);
  });
});
