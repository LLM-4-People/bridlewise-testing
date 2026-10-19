// @vitest-environment node
/**
 * NO IGNORE RULE IN THIS REPOSITORY REACHES FURTHER THAN THE PLACE IT NAMES.
 *
 * ── WHY THIS TREE IS THE ONE THAT MUST ASK ────────────────────────────────
 *
 * The rule and its wording live in one owner, in the harness tree, and the
 * driven proofs of git's behaviour live beside it — an unanchored pattern
 * really does swallow a tracked file at another depth, and an anchored one
 * really does survive its subtree being nested. Nothing of that is repeated
 * here.
 *
 * What is here is the half only this repository can answer. The collision
 * question — "does this every-depth pattern name a directory some repository
 * TRACKS files under" — needs every index, and this is the only one of the
 * three trees that can reach all three. The harness side reaches itself and
 * its submodule; it cannot see this one. So a pattern here that would swallow
 * the harness tree's files is visible from here and nowhere else.
 *
 * `experiments/` is the standing example, and the numbers behind it MOVED,
 * which is the point of deriving them rather than writing them down. It used
 * to name 53 tracked files at THIS root and 80 at every depth. The root's 53
 * were retired; the engine's 27 (under `engine/experiments/`) then left the
 * index too; and the experiments-shape decision brought the experiment
 * archive back to the root under `experiments/engine/`, tracked like any
 * record (what ships is the promotion profile's answer, never an ignore
 * rule). The plant below still finds the collision it is handed, because it
 * derives the tracked segments from the live indexes instead of asserting a
 * count.
 *
 * The `coverage/` defect is this repository's own: written for the report
 * directory at the root, it also matched `src/lib/coverage/`, and the
 * component registry imports from there unconditionally. The working tree
 * built and every fresh clone did not.
 *
 * ── AND THE OPPOSITE DIRECTION, ADDED HERE RATHER THAN IN A NEW FILE ───────
 *
 * A rule can also stop SHORT of the place it names. §39/W-08 prescribes
 * `mv <dir> <dir>.<label>-$(date +%s)` — preserve state by renaming it — and
 * the renamed directory holds exactly the bytes the rule was written to keep
 * out of the index under a name the rule does not match. Nine files including
 * a database encryption key were committed from
 * `.bridlewise.fresh-evidence-<epoch>/` that way, with `git status` clean
 * throughout, and the repair at the time was one literal for that one
 * directory. Enumerated afterwards: 28 of the 31 directory-style rules across
 * the four tracked `.gitignore` files had the identical hole.
 *
 * THE §41 SEARCH, RECORDED SO NOBODY REPEATS IT. Four guards were read:
 *
 *   `tests/prevention/tracked-source-owner.test.ts` owns "the rules and the
 *   INDEX agree, in both directions" — a file the program needs is missing, or
 *   the index holds a path the rules ignore. Both halves ask about the index.
 *   This asks about the RULES alone: the moved-aside directory is in nobody's
 *   index yet, which is precisely why it is still preventable. Not blind
 *   inside its subject; a different subject.
 *
 *   `tests/prevention/encryption-and-dedup-prevention.test.ts` already asks
 *   this exact question — "git ignores the key's home AND any suffixed sibling
 *   of it" — and is the guard that WAS blind here, and was repaired for it. It
 *   is secret-specific by its own declared subject (`db-key`, harness state),
 *   and `node_modules.aside-<epoch>` is not a secret. It owns one member of
 *   this family and says so.
 *
 *   `tests/prevention/declared-root-inventory.test.ts` is a DEPTH-1 walk of
 *   this root whose header says the class "is not about ignore patterns at
 *   all". It would never see `engine/guardian/build.aside-<epoch>`.
 *
 *   THIS FILE was the answer to Q2. Same instrument, same population — every
 *   pattern in every tracked `.gitignore` — same rules module, and the same
 *   invariant asked in the mirror direction. A reader looking for "does my
 *   ignore rule cover the moved-aside spelling" lands here, and a second file
 *   beside this one would be the two-owners defect wearing test clothes. The
 *   subject widens: no rule reaches further than the place it names, AND none
 *   stops short of the one rename this workspace's own contract prescribes.
 *
*/
import { describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  anchoringOf,
  directoryStyleRules,
  gitignoreAnchoringFailure,
  literalInstance,
  movedAsideCoverageFailure,
  movedAsideSpelling,
  parseGitignore,
  misplacedAnchoredPatterns,
  submoduleRoots,
  trackedSegments,
  type DirectoryRule,
  type GitignoreDeclaration,
} from "../../engine/scripts/verification/gitignore-anchoring.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

/**
 * The harness tree, as a path relative to this repository.
 *
 * IT MOVED WHEN THE TREES MERGED, WHICH IS WHAT THE OLD COMMENT HERE PREDICTED.
 * Until the monorepo assembly (2026-07-30) this was
 * `resolve(process.cwd(), "..", "harness-main-v1")` — a sibling checkout whose
 * own `.gitignore` files this scan had to reach across a repository boundary
 * to read. The engine is now `engine/` inside this same index, so the reach is
 * one directory DOWN rather than one up.
 *
 * It stays a named constant rather than being folded away: the scan below asks
 * a DIFFERENT git index the question (`git ls-files` with `cwd` set here), and
 * `engine/` still carries its own `.gitignore` whose anchored patterns resolve
 * relative to itself. A reader deserves to find that by grepping the obvious
 * thing.
 */
const HARNESS_ROOT = resolve(process.cwd(), "engine");

function trackedPaths(root: string): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((entry) => entry.length > 0);
}

function gitignoreFiles(root: string): readonly string[] {
  return trackedPaths(root).filter((p) => p === ".gitignore" || p.endsWith("/.gitignore"));
}

/** A repository's `.gitignore` files, each paired with what it declares. */
function declarationsIn(root: string): readonly GitignoreDeclaration[] {
  return gitignoreFiles(root).map((file) => ({
    file,
    patterns: parseGitignore(readFileSync(join(root, file), "utf8"), file),
  }));
}

/** This repository's `.gitignore` files, each paired with what it declares. */
function declarationsOf(): readonly GitignoreDeclaration[] {
  return declarationsIn(process.cwd());
}

/**
 * The subset of `paths` some ignore rule matches, asked of GIT'S OWN MATCHER.
 *
 * `--no-index` IS LOAD-BEARING, for the reason `tracked-source-owner.test.ts`
 * records beside its own copy: without it `check-ignore` reports nothing for a
 * path already in the index, so a question about the RULES would silently
 * become a question about today's index. Nothing probed here is in any index —
 * these are paths nobody has created — but the flag is what keeps that true
 * when somebody force-adds one.
 *
 * `check-ignore` exits 1 when NOTHING matched, which is a verdict rather than a
 * failure, so the status is read as data and anything other than 0 or 1 is
 * refused. A `catch { return false }` here would report a crashed git as "not
 * ignored", which is a finding this instrument would then manufacture.
 */
function ignoredAmong(cwd: string, paths: readonly string[]): ReadonlySet<string> {
  if (paths.length === 0) return new Set();
  const result = spawnSync("git", ["check-ignore", "--stdin", "--no-index", "-z"], {
    cwd,
    input: `${paths.join("\0")}\0`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git check-ignore failed in ${cwd} (status ${String(result.status)}): ${result.stderr}`,
    );
  }
  return new Set(result.stdout.split("\0").filter((entry) => entry.length > 0));
}

/**
 * The rule that makes `path` ignored in `root`, as GIT names it.
 *
 * Discovered rather than retyped: a pattern copied into a test is a second
 * copy of the rule, and the copy is what drifts while the assertion keeps
 * passing. `check-ignore -v` answers with the declaring file, its line, and the
 * pattern itself, which is the deployed rule by construction. An unmatched path
 * is a failure here rather than a `null`, because every caller below is asking
 * about a rule it has already established exists.
 */
function ignoringRule(
  root: string,
  path: string,
): Readonly<{ file: string; line: number; pattern: string }> {
  const result = spawnSync("git", ["check-ignore", "-v", "--no-index", "-z", "--stdin"], {
    cwd: root,
    input: `${path}\0`,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `nothing in ${root} ignores ${path} (status ${String(result.status)}): ${result.stderr}`,
    );
  }
  const [file, line, pattern] = result.stdout.split("\0");
  return { file: file ?? "", line: Number(line), pattern: pattern ?? "" };
}

/**
 * A throwaway repository whose only ignore rules are `patterns`.
 *
 * One rule in isolation, so an answer here is about that rule rather than about
 * whichever of this tree's thirty-odd others happened to match first. Nothing
 * is committed: `check-ignore --no-index` and `git add` both read the working
 * tree's `.gitignore` directly.
 */
function repositoryIgnoring(patterns: readonly string[]): string {
  const root = createTempDir("ch-web-shape-");
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, ".gitignore"), `${patterns.join("\n")}\n`);
  return root;
}

/**
 * The labels and epochs the probe drives.
 *
 * MORE THAN ONE OF EACH ON PURPOSE. A rule that happened to cover the single
 * label written here would pass while covering nothing else, and `fresh-evidence`
 * is the label that actually got through — typed by an operator, written by no
 * program in this tree. `evidence` is the one §39/W-08 prescribes; the third is
 * a spelling nobody has used, which is the only kind the next rename will have.
 * The epochs are ten digits (`date +%s`) and thirteen (milliseconds), because
 * the sweeper's own regex bounds the digits only from below.
 */
const ASIDE_LABELS: readonly string[] = ["evidence", "fresh-evidence", "a-label-nobody-typed-yet"];
const ASIDE_EPOCHS: readonly number[] = [1785461259, 1785461259000];

/** Whether `repositoryRelativePath` is a directory (or a link to one) in `root`. */
function namesADirectoryIn(root: string): (path: string) => boolean {
  return (path) => {
    try {
      return statSync(join(root, path)).isDirectory();
    } catch {
      return false;
    }
  };
}

/**
 * Every path a moved-aside rename of `rule`'s directory would put in front of
 * `git add -A`.
 *
 * THE PROBE'S SHAPE IS THE RULE'S OWN SHAPE, and getting that wrong makes the
 * guard demand something git cannot give. `<aside>/probe.txt` is what enters
 * the index when the moved-aside thing is a real directory, and it is the only
 * question a directory-only rule (trailing `/`) can answer: `check-ignore`
 * never stats, so it will not match such a rule against a bare name.
 *
 * A SLASHLESS rule gets the bare name instead, because that is what it exists
 * for. `engine/.gitignore` carries `/large-codebases` with no slash, measured
 * and recorded: the path is a SYMLINK, git records one as a blob rather than a
 * tree, and adding the slash for consistency took it out of the ignore set
 * entirely. Its moved-aside spelling is a symlink too, so only a slashless rule
 * covers it and only this probe can tell.
 */
function asideProbes(rule: DirectoryRule): readonly string[] {
  const directoryOnly = rule.pattern.pattern.endsWith("/");
  const probes: string[] = [];
  for (const label of ASIDE_LABELS) {
    for (const epoch of ASIDE_EPOCHS) {
      const aside = movedAsideSpelling(rule.directory, label, epoch);
      probes.push(directoryOnly ? `${aside}/probe.txt` : aside);
    }
  }
  return probes;
}

/** The directory rules in `root` whose moved-aside spelling nothing ignores. */
function uncoveredDirectoryRules(
  root: string,
  declarations: readonly GitignoreDeclaration[],
): Readonly<{ examined: readonly DirectoryRule[]; uncovered: readonly DirectoryRule[] }> {
  const examined = directoryStyleRules(declarations, namesADirectoryIn(root));
  const probes = examined.flatMap((rule) => asideProbes(rule));
  const ignored = ignoredAmong(root, probes);
  const uncovered = examined.filter((rule) => asideProbes(rule).some((p) => !ignored.has(p)));
  return { examined, uncovered };
}

/**
 * A scratch repository declaring three directory rules, one of which does not
 * cover its own moved-aside sibling.
 *
 * Supplied from OUTSIDE the guard and driven through the same functions the
 * live assertion calls — parse, resolve, ask git — so a green verdict there is
 * about this repository's rules rather than about a detector that stopped
 * detecting. `/covered/` and its `/covered.*\/` companion are the control: a
 * plant that reported every rule would be indistinguishable from one that
 * worked.
 *
 * `/linked` CARRIES NO TRAILING SLASH AND POINTS AT A SYMLINK, which is the
 * shape `engine/.gitignore`'s `/large-codebases` really has and the only shape
 * that reaches the second branch of `directoryStyleRules`. Without it every
 * rule here was slash-terminated, the disk predicate was never consulted, and
 * the plant certified a detector running on one of its two suppliers — the
 * same blindness the live assertion was found to have.
 */
function repositoryWithAnUncoveredRule(): string {
  const root = createTempDir("ch-web-aside-");
  const run = (...args: readonly string[]): void => {
    execFileSync("git", [...args], { cwd: root, stdio: "pipe" });
  };
  run("init", "-q");
  run("config", "user.email", "guard@example.invalid");
  run("config", "user.name", "guard");
  writeFileSync(join(root, ".gitignore"), "/keep/\n/covered/\n/covered.*/\n/linked\n/linked.*\n");
  mkdirSync(join(root, "keep"), { recursive: true });
  mkdirSync(join(root, "covered"), { recursive: true });
  mkdirSync(join(root, "linked-target"), { recursive: true });
  symlinkSync("linked-target", join(root, "linked"));
  run("add", ".gitignore");
  run("commit", "-q", "-m", "plant");
  return root;
}

/**
 * Every tree whose files these rules govern.
 *
 * The old comment here read "once the trees merge". They merged on 2026-07-30:
 * what were three converging repositories (this one, `harness-main-v1`, and
 * its `integration` submodule) are one index with the engine at `engine/`.
 * Each entry is still asked SEPARATELY because a pattern is resolved relative
 * to the `.gitignore` that declares it — `engine/.gitignore` names
 * `/large-codebases` meaning `engine/large-codebases`, and only an
 * engine-relative listing can say whether that collides.
 */
function allRoots(): readonly string[] {
  return [...new Set([process.cwd(), HARNESS_ROOT, ...submoduleRoots(HARNESS_ROOT)])];
}

describe("this repository's ignore rules name a place they can defend", () => {
  test("every pattern is anchored, or every-depth on purpose and colliding with nothing", () => {
    const roots = allRoots();
    // POPULATION, as runtime numbers — the whole point of asking from here is
    // the reach, so a reach that shrank must be visible rather than quiet.
    //
    // RE-DERIVED AT THE MONOREPO ASSEMBLY, NOT PORTED. The floor was `>= 3`,
    // counting three converging REPOSITORIES. They converged; two of the three
    // are the same index now, so `>= 3` could only be met by inventing a root.
    // A count that can only be met by invention is worse than no count, so the
    // floor moved to CONTAINMENT (§31a): every root must CONTRIBUTE, which is
    // what "the reach shrank" would actually break, and which a scalar could
    // never see.
    expect(roots.length).toBeGreaterThanOrEqual(2);
    for (const root of roots) {
      expect(
        trackedPaths(root).length,
        `${root} contributed no tracked path — this scan did not reach it`,
      ).toBeGreaterThan(0);
    }

    const segments = trackedSegments(roots.flatMap((root) => trackedPaths(root)));
    expect(segments.size).toBeGreaterThan(0);

    const declarations = declarationsOf();
    expect(declarations.length).toBeGreaterThan(1);
    const patterns = declarations.flatMap((d) => d.patterns);
    expect(patterns.length).toBeGreaterThan(declarations.length);

    const failure = gitignoreAnchoringFailure(
      `this repository, against ${roots.length} converging trees`,
      declarations,
      segments,
    );
    expect(failure, failure ?? "").toBeNull();
  });

  test("no rule sits in a file that cannot carry it when its subtree moves", () => {
    // Anchoring only survives a move because git resolves the pattern
    // relative to the file that declares it — so a rule about a subtree that
    // owns its own `.gitignore` must live THERE. This repository had two such
    // rules at the root (`tests/performance/.report.json` and `.run.json`),
    // correct today and dead the moment that directory moved.
    const declarations = declarationsOf();
    expect(declarations.map((d) => d.file)).toContain(".gitignore");
    expect(declarations.filter((d) => d.file !== ".gitignore").length).toBeGreaterThan(0);

    const findings = misplacedAnchoredPatterns(declarations);
    expect(findings.map((f) => `${f.pattern.file}:${String(f.pattern.line)} ${f.pattern.raw}`)).toEqual([]);

    // PLANT, from outside: the same call over a declaration set holding the
    // shape that was just removed must report it, otherwise the empty answer
    // above is about a detector that stopped detecting.
    const planted = misplacedAnchoredPatterns([
      { file: ".gitignore", patterns: parseGitignore("bench/.out/\n", ".gitignore") },
      { file: "bench/.gitignore", patterns: parseGitignore("/.fixtures/\n", "bench/.gitignore") },
    ]);
    expect(planted.map((f) => f.pattern.raw)).toEqual(["bench/.out/"]);
  });

  test("PLANT: the rule reports a pattern that would swallow this tree's tracked files", () => {
    // Supplied from outside the guard and driven through the same function
    // the assertion above calls, so a green verdict there is about the ignore
    // files rather than about a detector that stopped detecting. The names are
    // this workspace's real collision risk: an `experiments/` segment once
    // held 53 tracked files at this root, then zero, and the floor-byte
    // archive (`experiments/engine/…`, tracked on this branch) makes it a
    // tracked segment again — the anchored spelling is what this plant must
    // keep accepting while it rejects the other two.
    const segments = trackedSegments(allRoots().flatMap((root) => trackedPaths(root)));
    // The every-depth name must collide with a directory this tree REALLY
    // tracks (it was `coverage/` until the old tree's src/lib/coverage was
    // deleted and the plant went quiet); `src/state` is that directory now.
    const planted = parseGitignore(
      "experiments/\n**/state/\n/state/\n",
      "plant/.gitignore",
    );
    expect(planted.map((p) => anchoringOf(p.pattern))).toEqual([
      "implicit",
      "every-depth",
      "anchored",
    ]);

    const failure = gitignoreAnchoringFailure(
      "plant",
      [{ file: "plant/.gitignore", patterns: planted }],
      segments,
    );
    expect(failure).not.toBeNull();
    // The implicit one, and the every-depth one that collides — but NOT the
    // anchored spelling of the identical name, which is the live rule this
    // repository actually carries.
    expect(failure ?? "").toContain("experiments/");
    expect((failure ?? "").split("\n").length).toBe(3);
    expect(failure ?? "").toContain("**/state/");
  });

  test("every directory rule also covers its own MOVED-ASIDE spelling", () => {
    const cwd = process.cwd();

    // WITNESS FIRST (§36). "No rule is uncovered" and "check-ignore answered
    // nothing at all" are the same empty set. The witness lives in the SAME
    // instrument the assertion below requires to be quiet — one path the rules
    // certainly cover, one they certainly do not — so an instrument pointed at
    // the wrong tree shows up as a missing witness rather than as a clean bill.
    const probe = ignoredAmong(cwd, [
      ".bridlewise/db-key",
      "src/cockpit/nothing-ignores-this.ts",
    ]);
    expect(
      probe.has(".bridlewise/db-key"),
      "git did not report .bridlewise/db-key as ignored, so this instrument is not reading " +
        "this repository's rules and its empty answer below would be about the instrument",
    ).toBe(true);
    expect(
      probe.has("src/cockpit/nothing-ignores-this.ts"),
      "git reported a path under src/cockpit as ignored, so this instrument answers yes to " +
        "everything and could not report an uncovered rule",
    ).toBe(false);

    const { examined, uncovered } = uncoveredDirectoryRules(cwd, declarationsOf());

    // THE PROBES ARE MOVED-ASIDE NAMES, asserted rather than assumed. This is
    // the WIRED-BUT-INERT arm, and it is not theoretical: `movedAsideSpelling`
    // computing the suffix and returning the directory unchanged was driven,
    // and every rule came back "covered" — because it was being asked about the
    // directories the rules already ignore. Green, over a probe generator that
    // had stopped generating. Only a name the ORIGINAL rule cannot match is
    // evidence about the moved-aside rename.
    for (const rule of examined) {
      for (const probe of asideProbes(rule)) {
        expect(
          probe.startsWith(`${rule.directory}.`) && probe.length > rule.directory.length + 1,
          `the probe ${probe} is not a moved-aside spelling of ${rule.directory}, so asking git ` +
            `about it says nothing about the rename W-08 prescribes`,
        ).toBe(true);
      }
    }

    // POPULATION AS A RUNTIME NUMBER, and a floor rather than the count: 32
    // directory-style rules today across four `.gitignore` files, and the walk
    // shrinking is the failure this file has already met once. The floor is
    // enforced inside the rule so both callers get it.
    //
    // AND IT IS TWO NUMBERS, BECAUSE THE POPULATION HAS TWO SUPPLIERS. The
    // scalar was blind in the exact way §31 describes: replacing
    // `namesADirectoryIn` with `() => false` moved `examined` 32 -> 31, left
    // `uncovered` empty, and THE VERDICT STAYED GREEN — while dropping
    // `engine/.gitignore`'s `/large-codebases`, the only slashless rule in this
    // tree and the one the slashless branch exists for. A floor of 25 cannot
    // see a loss of one, and no higher scalar would have either.
    const failure = movedAsideCoverageFailure(
      `this repository, across ${declarationsOf().length} .gitignore file(s)`,
      examined,
      uncovered,
      { rules: 25, slashless: 1 },
    );
    expect(failure, failure ?? "").toBeNull();

    // The subject really is every tracked `.gitignore`, not just the root's:
    // a run where `engine/.gitignore` or `bench/.gitignore` stopped being read
    // would otherwise pass with a smaller, greener population.
    const files = new Set(examined.map((rule) => rule.pattern.file));
    expect([...files].sort()).toEqual([
      ".gitignore",
      "bench/.gitignore",
      "engine/.gitignore",
      "tests/performance/.gitignore",
    ]);
  });

  test("PLANT: a rule whose moved-aside sibling nothing covers is reported, and its neighbour is not", () => {
    // Driven through the SAME functions the assertion above calls, on a real
    // repository with real rules, so only the input varies.
    const root = repositoryWithAnUncoveredRule();
    const { examined, uncovered } = uncoveredDirectoryRules(root, declarationsIn(root));

    // `/linked` is here because it is SLASHLESS: it entered only by the disk
    // predicate answering yes about a symlink to a directory. `/linked.*` did
    // not enter — its instantiated name is on no disk — which is the predicate
    // discriminating rather than waving everything through.
    expect(examined.map((rule) => rule.pattern.raw)).toEqual([
      "/keep/",
      "/covered/",
      "/covered.*/",
      "/linked",
    ]);
    // `/keep/` alone: `/covered/`'s sibling is covered by the rule beside it,
    // `/covered.*/` covers its own, and `/linked.*` covers `/linked`'s.
    expect(uncovered.map((rule) => rule.pattern.raw)).toEqual(["/keep/"]);

    const failure = movedAsideCoverageFailure("plant", examined, uncovered, {
      rules: 3,
      slashless: 1,
    });
    expect(failure ?? "").toContain("keep.<label>-<epoch>");
    expect(failure ?? "").not.toContain("covered.<label>-<epoch>");
    expect(failure ?? "").toContain("1 of 4");

    // AND THE EMPTY UNIVERSE IS A REFUSAL, not a clean verdict: a walk that
    // returned four rules cannot certify a tree the guard expects 25 from.
    expect(
      movedAsideCoverageFailure("plant", examined, [], { rules: 25, slashless: 1 }) ?? "",
    ).toContain("below the floor of 25");
    expect(movedAsideCoverageFailure("plant", examined, [], { rules: 3, slashless: 1 })).toBeNull();

    // AND THE SLASHLESS BRANCH DYING IS A REFUSAL TOO, which the total cannot
    // express. This is the live defect in miniature: hand the rule the same
    // population with its one disk-supplied member removed — what
    // `namesADirectoryIn` returning `false` produces — and the total floor is
    // still met while the branch is gone.
    const slashyOnly = examined.filter((rule) => rule.pattern.pattern.endsWith("/"));
    expect(slashyOnly.length).toBe(3);
    const branchDead = movedAsideCoverageFailure("plant", slashyOnly, [], {
      rules: 3,
      slashless: 1,
    });
    expect(branchDead ?? "").toContain('0 of 3 directory-style ignore rule(s) have no trailing "/"');
    expect(branchDead ?? "").toContain("the branch it supplies is dead");
  });

  test("the moved-aside shape is DERIVED, and a probe outside it is refused", () => {
    // The generator is held to the derivation. `movedAsideSpelling` exists so
    // the probe cannot drift away from the rename W-08 actually prescribes —
    // a label with no epoch, or an epoch too short to be one, would ask git
    // about a name nothing in this workspace produces and read the answer as
    // evidence about the rename.
    expect(movedAsideSpelling(".bridlewise", "fresh-evidence", 1785461259)).toBe(
      ".bridlewise.fresh-evidence-1785461259",
    );
    expect(() => movedAsideSpelling(".bridlewise", "aside", Number.NaN)).toThrow(
      /is not a moved-aside suffix/u,
    );
    expect(() => movedAsideSpelling(".bridlewise", "", 1785461259)).toThrow(
      /is not a moved-aside suffix/u,
    );
    // Nine digits is not a unix timestamp of this era, and a rule that matched
    // it would be matching `v1.2-3`-shaped names too.
    expect(() => movedAsideSpelling(".bridlewise", "aside", 178546125)).toThrow(
      /is not a moved-aside suffix/u,
    );

    // A SHAPE RULE IS STILL PROBEABLE, which is what keeps `bench/.gitignore`
    // in the population instead of exempted out of it. Its `/.*/ ` names no
    // directory, so a concrete member is built; an unrecognised shape refuses
    // rather than guessing, and the caller reds naming the pattern.
    expect(literalInstance("/.*/")).toBe(".sample");
    expect(literalInstance("**/node_modules/")).toBe("node_modules");
    expect(literalInstance("guardian/build/")).toBe("guardian/build");
    expect(literalInstance("**/*.*-[0-9][0-9]*")).toBe("sample.sample-00sample");
    expect(literalInstance("/[!x]/")).toBeNull();
  });

  test("the shape rule's trailing `*` is load-bearing, and its over-reach is the price", () => {
    // ── WHY THIS ARM EXISTS ────────────────────────────────────────────────
    //
    // The deployed rule ends in `*`, so ten digits followed by ANYTHING match —
    // including inside a file name. The root `.gitignore` records that as a
    // known limit, and a recorded limit is a paragraph: it cannot tell the next
    // reader whether the narrower spelling was tried, and it goes stale the
    // moment somebody edits the rule. Both halves are driven here instead.
    //
    // THE RULE IS DISCOVERED FROM GIT, NEVER RETYPED. Asking `check-ignore -v`
    // which pattern matched makes this an assertion about the rule this
    // repository deploys; a literal copied into this file would be an
    // assertion about the copy, and the copy is the thing that drifts.
    const deployed = ignoringRule(process.cwd(), "node_modules-1785461259");
    expect(deployed.file).toBe(".gitignore");

    // The names the rename really produces, across both epoch widths the
    // sweeper's own `\d+` admits and both shapes W-08 leaves behind.
    const mustCover = [
      "keep.evidence-1785461259/probe.txt",
      "keep.evidence-1785461259000/probe.txt",
      "large-codebases.evidence-1785461259",
      "large-codebases.evidence-1785461259000",
      "node_modules-1785461259",
      ".bridlewise.archived-1785461259.tar",
    ];
    // Prospective false positives: no such name is in this index today, and
    // each is a plausible FILE somebody adds tomorrow.
    const overReached = [
      "fixtures/book.isbn-9780134685991.json",
      "src/data.export-20260731010342.csv",
      "src/app.min-1234567890.js",
    ];

    const asDeployed = repositoryIgnoring([deployed.pattern]);
    for (const path of mustCover) {
      expect(
        ignoredAmong(asDeployed, [path]).has(path),
        `the deployed shape rule does not cover ${path}, which W-08's rename produces`,
      ).toBe(true);
    }

    // ── CANDIDATE 1: THE NARROWED SINGLE RULE ──────────────────────────────
    //
    // Dropping the `*` anchors the epoch to the end of the name and removes
    // every false positive above — and it stops covering three of the six
    // names the rename produces, because `fnmatch` has NO REPETITION OPERATOR:
    // there is no way to say "and the rest is digits", `[0-9]*` means "one
    // digit then anything", and the epoch's own width is not fixed.
    const narrowed = deployed.pattern.endsWith("*")
      ? deployed.pattern.slice(0, -1)
      : deployed.pattern;
    expect(narrowed).not.toBe(deployed.pattern);
    const asNarrowed = repositoryIgnoring([narrowed]);
    const missed = mustCover.filter((path) => !ignoredAmong(asNarrowed, [path]).has(path));
    expect(missed).toEqual([
      "keep.evidence-1785461259000/probe.txt",
      "large-codebases.evidence-1785461259000",
      ".bridlewise.archived-1785461259.tar",
    ]);
    for (const path of overReached) {
      expect(
        ignoredAmong(asNarrowed, [path]).has(path),
        `${path} is still swallowed without the trailing "*", so the trade-off recorded in ` +
          `.gitignore is not the trade-off that exists`,
      ).toBe(false);
    }

    // ── CANDIDATE 2: THE ONE THAT REFUTES THE CLAIM THIS ARM USED TO MAKE ──
    //
    // This arm drove ONE alternative and `.gitignore` concluded from it that
    // "there is no spelling in this language that admits the six and refuses
    // the three". A single candidate cannot support a claim about every
    // spelling, and the claim is FALSE: three anchored rules — ten digits,
    // thirteen digits, ten digits plus `.tar` — do exactly that, and it is
    // driven below rather than argued. The conclusion (keep the over-reach)
    // survives on a different mechanism, so the mechanism is what is asserted.
    const digits = (count: number): string => "[0-9]".repeat(count);
    const widthEnumerated = [
      `**/*-${digits(10)}`,
      `**/*-${digits(13)}`,
      `**/*-${digits(10)}.tar`,
    ];
    const asEnumerated = repositoryIgnoring(widthEnumerated);
    for (const path of mustCover) {
      expect(
        ignoredAmong(asEnumerated, [path]).has(path),
        `the width-enumerated candidate does not cover ${path}, so the counterexample this arm ` +
          `exists to drive is not the counterexample it was measured to be`,
      ).toBe(true);
    }
    for (const path of overReached) {
      expect(
        ignoredAmong(asEnumerated, [path]).has(path),
        `${path} is swallowed by the width-enumerated candidate, which would make it no better ` +
          `than the deployed rule and would leave the retired claim standing`,
      ).toBe(false);
    }

    // ── AND WHY IT LOSES ANYWAY: ENUMERATING WIDTHS IS A LIST ──────────────
    //
    // A pattern that anchors the epoch matches a FIXED number of digit
    // positions, so a set of them covers exactly the widths it spells out —
    // and this file's whole reason for naming a shape is that a list defends
    // only the names somebody has already met. The widths are BUILT here
    // rather than written down, and the two that matter are not hypothetical:
    // sixteen digits is what `date +%s%6N` prints and nineteen is `date +%s%N`,
    // both spellings an operator can type into the rename W-08 prescribes,
    // which nothing in this tree executes.
    const enumeratedWidths = [10, 13];
    const unenumerated = [11, 12, 14, 16, 19];
    for (const width of unenumerated) {
      expect(enumeratedWidths).not.toContain(width);
      const epoch = `1${"0".repeat(width - 1)}`;
      expect(epoch.length, "the probe's epoch is not the width it claims").toBe(width);
      const name = `node_modules.evidence-${epoch}`;
      expect(
        ignoredAmong(asEnumerated, [name]).has(name),
        `the width-enumerated candidate covers a ${String(width)}-digit epoch, so enumerating ` +
          `widths is not the list this arm reports it to be`,
      ).toBe(false);
      // …and the DEPLOYED rule covers it, which is the whole of its advantage
      // and is re-measured here rather than asserted in prose.
      expect(
        ignoredAmong(asDeployed, [name]).has(name),
        `the deployed shape rule misses a ${String(width)}-digit epoch, so the reason recorded ` +
          `in .gitignore for keeping its over-reach no longer holds`,
      ).toBe(true);
    }

    // ── THE SELF-REFERENTIAL FIXTURE HAZARD, AND WHY IT IS NOT ONE HERE ────
    //
    // A guard that swallows its own test data is a trap: a regression fixture
    // for THIS rule is named exactly like a moved-aside directory, so
    // `git add -A` would drop it in silence and the suite would pass locally
    // off a file no clone has. This guard cannot be trapped that way BY SHAPE
    // and the shape is asserted, not asserted-about: every moved-aside name it
    // uses is built by `movedAsideSpelling` at run time and asked of a
    // throwaway repository, so none of them is a path in this index.
    const tracked = new Set(trackedPaths(process.cwd()));
    for (const path of [...mustCover, ...overReached]) {
      expect(
        tracked.has(path),
        `${path} is TRACKED, so this guard now depends on a committed file whose name its own ` +
          `subject rule matches — the trap this assertion exists to keep open`,
      ).toBe(false);
    }

    // And the residual is bounded rather than silent, which is the other half
    // of the recorded limit: an EXPLICIT `git add <path>` refuses out loud and
    // names the path — only `git add -A` is quiet — and anything force-added
    // past that refusal is what `tracked-source-owner.test.ts` reds on. Driven
    // in the repository carrying the DEPLOYED rule, with the file really on
    // disk, so a non-zero status cannot come from a pathspec that matched
    // nothing: that would be a refusal read off an emptiness.
    const swallowed = overReached[0] ?? "";
    mkdirSync(join(asDeployed, dirname(swallowed)), { recursive: true });
    writeFileSync(join(asDeployed, swallowed), "a regression fixture somebody adds tomorrow\n");
    const refused = spawnSync("git", ["add", "--", swallowed], {
      cwd: asDeployed,
      encoding: "utf8",
    });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("ignored by one of your .gitignore files");
    expect(refused.stderr).toContain(swallowed);
  });
});
