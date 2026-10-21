/**
 * THE SUITE MAY NOT MODIFY FIRST-PARTY SOURCE. Measured once, then measured
 * again, at the one place that runs exactly once per suite.
 *
 * ── THE INCIDENT ──────────────────────────────────────────────────────────
 *
 * Two prevention tests proved their scans by MUTATING a live tracked source
 * file — appending a planted construct to `server/worker-ipc.ts`, asserting,
 * and restoring it in a `finally`. Both used the same path, and vitest runs
 * test FILES in parallel forks. `writeFileSync` truncates before it writes,
 * so a `readFileSync` from the other fork landing inside that window returns
 * the EMPTY STRING; that empty string becomes the "original", and the
 * `finally` restores it faithfully.
 *
 * `server/worker-ipc.ts` was found at ZERO BYTES after a run. It surfaced
 * only because ten other tests import it and failed on a missing export. Had
 * the canary been a file nothing imports, THE RUN WOULD HAVE BEEN GREEN with
 * a first-party source file emptied on disk, and the next commit would have
 * recorded the deletion as intentional.
 *
 * ── WHY THE CHECK IS HERE AND NOT IN A TEST ───────────────────────────────
 *
 * A test that checks this is a test that can be skipped, filtered out by a
 * `-t` pattern, or scheduled before the file that does the damage. vitest's
 * global setup runs ONCE before any worker starts and its teardown runs after
 * the last one exits, so there is no ordering and no filter that can miss it,
 * and no test author has to remember it exists.
 *
 * It compares CONTENT HASHES, not mtimes: a write that restores the same
 * bytes is genuinely harmless and must not fail the suite, while a write that
 * changes them is a finding no matter how the timestamps landed. It compares
 * the FILE MODE alongside the hash, because "byte-identical, mode-different"
 * is a real outcome here: an atomic write replaces the inode and inherits the
 * umask, and a run that leaves a source file at a different permission has
 * changed the tree just as surely as one that edits it.
 *
 * ── THE POPULATION IS THE GIT INDEX, NOT FOUR DIRECTORY NAMES ─────────────
 *
 * It used to be `server`, `src`, `contracts`, `scripts` — 499 of the 1,147
 * files git tracks. The 648 it could not see included every root-level
 * declaration: all four `tsconfig*.json`, `vite.config.ts`, `package.json`,
 * both playwright configs. A test that rewrote a tsconfig was invisible, and
 * those declarations are now load-bearing — a dead `include` pattern
 * typechecks a fraction of the tree and exits 0.
 *
 * So the population is every file the index holds, minus `tests/`. The
 * exclusion is deliberate and is the only one: the suite legitimately writes
 * its own fixtures, reports and snapshots there, and including it would make
 * this refuse on ordinary work. Deriving from the index rather than from
 * directory names means a new top-level file is covered because it was
 * committed, not because somebody remembered to extend a list.
 *
 * ── AND "THE INDEX" WAS ONE INDEX WHILE THE SUITE WRITES TO SEVERAL ───────
 *
 * The paragraph above says "every file the index holds" and never says WHOSE.
 * It was `git ls-files` with `cwd: process.cwd()` — this repository, and only
 * this one. Driven: a test that appends to
 * `engine/src/integrity.ts` finished with **exit 0,
 * no finding, and the sibling's `git status` showing `M src/integrity.ts`.**
 * Verbatim the `worker-ipc.ts` incident one directory up, and more reachable
 * than before — this suite's config, build and typecheck all resolve across
 * that boundary, so a test reaching the same way is an ordinary import away.
 *
 * The repair is at the POPULATION, not a second copy of the check. The
 * population is now:
 *
 *   1. the repository containing `process.cwd()`, minus `tests/`; plus
 *   2. EVERY OTHER git repository this repository's own tracked text resolves
 *      a path into.
 *
 * (2) is discovered, not named. Every tracked file is read anyway, to hash it;
 * the same bytes are scanned for `../…` paths, each is resolved against the
 * file that wrote it, and a candidate landing on a real FILE inside a
 * different git repository enlists that repository. Measured on this tree:
 * 650 candidates, resolving to two repositories — `harness-main-v1` (189
 * tracked) and its `integration` submodule (2,038) — for 2,874 stamped files
 * in 93 ms per pass. A directory-shaped coincidence enlists nothing, which is
 * what keeps a stray `../` in prose from dragging in an unrelated checkout.
 *
 * `tests/` is forgiven only in THIS repository. The suite is entitled to write
 * its own fixtures; it is entitled to write nothing at all in someone else's
 * tree, so no prefix is excused there.
 *
 * ── WHAT IT STILL CANNOT SEE ──────────────────────────────────────────────
 *
 * A file created and removed again INSIDE the run leaves both fingerprints
 * identical. Two snapshots cannot see a round trip; catching that needs a
 * watch, which is a different instrument with a different cost, and saying so
 * is better than implying coverage that is not there.
 *
 * And a repository that NOTHING in this tree names is not discovered, because
 * discovery is reachability. A test that invents a path to a fourth checkout
 * out of string fragments is outside this population. That is a bound, stated;
 * it is not a claim that such a write is safe.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE SUITE'S ROOT, FROM THIS MODULE'S OWN LOCATION — never the caller's cwd.
 *
 * The global setup used to fingerprint `process.cwd()`. Driven: running the
 * suite with a foreign working directory made it guard that directory (or
 * refuse because it was not a repository), while the checkout under test went
 * unsupervised. The module lives at `<root>/tests/setup/`, so its own URL is
 * the one fact that names the tree no matter where the runner was started.
 */
export const SUITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The one exclusion, and it applies to the suite's OWN repository only.
 */
const WRITABLE_PREFIX = "tests/";

/**
 * A `../…` path as it appears in source — an import specifier, a
 * `readFileSync` argument, a config entry, a path built in prose. Deliberately
 * broader than an import scan: the write that started this was a plain string
 * handed to `writeFileSync`, which no module-graph walk would have seen.
 */
const ESCAPING_PATH = /\.\.(?:\/[A-Za-z0-9._@-]+)+/g;

/**
 * Content hash + permission bits — "identical" must mean both.
 *
 * Exported so a test can drive it over a REAL file. It was not, once, and a
 * mutation that computed the mode and threw it away passed every assertion:
 * the comparison was exercised on stamps written inside a test, so nothing
 * connected the production stamp to the production comparison. A test that
 * asserts a value on a fixture says nothing about the value in production.
 */
export function stampOf(file: string): string {
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
  // eslint-disable-next-line no-bitwise -- the permission bits are the low 12.
  const mode = (statSync(file).mode & 0o7777).toString(8);
  return `${hash}:${mode}`;
}

/** The repository-relative paths a git index holds, in path order. */
function trackedPaths(repositoryRoot: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((entry) => entry.length > 0);
}

/** The git repository containing `dir`, or null when there is none. */
function repositoryRootOf(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    // `.git` is a FILE inside a submodule checkout and a directory otherwise;
    // `existsSync` accepts both, and the submodule case is the one that
    // matters here — the engine this suite reaches into is exactly that.
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The answer AND the reason it cannot be believed, for one candidate suite
 * root. A setup module that resolves into a REPOSITORY but not at its root is
 * refused too: fingerprinting a subdirectory would silently drop every tracked
 * file above it.
 *
 * Exported so a test can drive the real answer, a planted non-repository, and
 * a nested repository directory without touching the live checkout.
 */
export type SuiteRootAnswer = Readonly<{
  root: string;
  failure: string | null;
}>;

export function judgeSuiteRoot(candidate: string = SUITE_ROOT): SuiteRootAnswer {
  const absolute = resolve(candidate);
  const repository = repositoryRootOf(absolute);
  if (repository === null) {
    return {
      root: absolute,
      failure:
        `source-tree-immutable: ${absolute} is not inside a git repository, so there is no index ` +
        "to fingerprint. The setup module derives its root from its own location; a checkout " +
        "where that path is not a repository cannot certify anything.",
    };
  }
  if (resolve(repository) !== absolute) {
    return {
      root: repository,
      failure:
        `source-tree-immutable: ${absolute} resolves inside the repository ${repository} but is ` +
        "not its root. Fingerprinting a nested directory would miss every tracked file above it; " +
        "the setup module must live at <root>/tests/setup/.",
    };
  }
  return { root: repository, failure: null };
}

/** The suite root, or a refusal that names why the location cannot be believed. */
export function requireSuiteRoot(candidate: string = SUITE_ROOT): string {
  const answer = judgeSuiteRoot(candidate);
  if (answer.failure !== null) throw new Error(answer.failure);
  return answer.root;
}

/**
 * Stamp every tracked path of one repository into `out`, keyed relative to
 * `home` so two repositories cannot collide on a shared path.
 *
 * A tracked path that is not on disk is recorded as ABSENT rather than
 * skipped — a deletion must survive into the comparison, and that is precisely
 * what a skip would swallow. A tracked path that is a DIRECTORY is a gitlink
 * (a submodule); it is recorded as such rather than hashed, and the submodule
 * itself is stamped in its own right when anything here reaches into it.
 *
 * `collect`, when supplied, receives the resolved `../…` targets found in each
 * file's bytes. Discovery rides along with hashing because the bytes are
 * already in hand; a second pass over the tree to find the same paths would be
 * the same read twice.
 */
function stampRepository(
  home: string,
  repositoryRoot: string,
  writablePrefix: string | null,
  out: Map<string, string>,
  collect: Set<string> | null,
): void {
  for (const entry of trackedPaths(repositoryRoot)) {
    const absolute = join(repositoryRoot, entry);
    const key = relative(home, absolute).split(sep).join("/");
    let isDirectory = false;
    try {
      isDirectory = statSync(absolute).isDirectory();
    } catch {
      // Not on disk at all — ABSENT below.
    }
    const excused = writablePrefix !== null && entry.startsWith(writablePrefix);
    if (!existsSync(absolute)) {
      if (!excused) out.set(key, "ABSENT");
      continue;
    }
    if (isDirectory) {
      if (!excused) out.set(key, "GITLINK");
      continue;
    }
    // THE PRODUCTION STAMP, not a second one written here. A mutation that
    // computed the mode and discarded it escaped once already, and it escaped
    // because the comparison was exercised on stamps a test had built.
    if (!excused) out.set(key, stampOf(absolute));
    // EXCUSED FILES ARE STILL READ FOR DISCOVERY. `tests/` is where the
    // cross-repository reaches are written, so excluding it from discovery
    // would remove the very evidence that names the other repositories.
    if (collect === null) continue;
    const text = readFileSync(absolute, "utf8");
    if (!text.includes("../")) continue;
    for (const match of text.matchAll(ESCAPING_PATH)) {
      collect.add(resolve(dirname(absolute), match[0]));
    }
  }
}

/**
 * The other git repositories this repository's own text resolves a path into.
 *
 * Exported so a test can drive the real tree AND a planted one: a discovery
 * step that quietly stops discovering restores the exact defect this file was
 * widened to close, and nothing about a green run would say so.
 */
export function foreignRepositories(home: string, candidates: ReadonlySet<string>): string[] {
  const roots = new Set<string>();
  for (const candidate of candidates) {
    let isFile = false;
    try {
      isFile = statSync(candidate).isFile();
    } catch {
      continue;
    }
    // A FILE, not merely an existing path. A directory-shaped coincidence in
    // prose would otherwise enlist whatever repository happens to contain it.
    if (!isFile) continue;
    const root = repositoryRootOf(dirname(candidate));
    if (root === null || root === home) continue;
    roots.add(root);
  }
  return [...roots].sort();
}

/**
 * The trees this repository DECLARES it cannot run without — the second
 * instrument the stamped population is required to contain.
 *
 * ── WHAT THE MONOREPO ASSEMBLY DID TO THIS ANSWER, AND WHY IT IS NOT A
 *    RETIREMENT ────────────────────────────────────────────────────────────
 *
 * Until 2026-07-30 the engine was a SIBLING repository (`harness-main-v1`)
 * carrying `integration/` as a submodule, and this function read
 * `package.json` for `../<name>/` prefixes and `.gitmodules` for what lived
 * inside them. The assembly put all three histories into one repository: the
 * engine is now `engine/` in this same git index, and there is no sibling and
 * no submodule left to find.
 *
 * THAT MAKES THE OLD ANSWER VACUOUS RATHER THAN WRONG, and a vacuous floor is
 * the exact failure this file was written to prevent — `required = []` has
 * nothing missing from it, so it certifies for free. It is therefore NOT
 * retired, and its number is NOT ported. The PROPOSITION is re-derived for
 * the new topology, and it is the same proposition in both:
 *
 *   *the fingerprint must cover every tree a run here can write to, and it
 *   must be PROVEN to cover it by a key that a blind fingerprint could not
 *   produce.*
 *
 * The universe did not shrink; it was ABSORBED. Measured at the assembly:
 * 515 stamped web files + 2,060 engine files + 204 harness-root files = 2,779
 * before, against 2,774 stamped keys after — the difference being exactly the
 * five paths the assembly deliberately removed (the `integration` gitlink,
 * `.gitmodules`, and the three duplicate collision files). A fingerprint over
 * a silently-shrunk universe is this project's own named failure mode, so the
 * reconciliation is written here rather than trusted.
 *
 * ── THE NEW INSTRUMENT IS THE SAME FILE, ONE `../` SHORTER ────────────────
 *
 * Still not a source scan and still not a list anyone maintains.
 * `package.json` is where this repository states the tree it cannot run
 * without: `bootstrap:hooks` and `typecheck:includes` both invoke
 * `engine/scripts/…`, and `tsconfig.json` resolves seven `@harness/*` aliases
 * into `./engine/src/…`. Without that tree `typecheck`, `vite build`,
 * `vitest run`, `vite preview` and `vite` dev all exit 1, four of them at
 * config load — the identical sentence that justified the old answer.
 *
 * A NAMED SEGMENT ONLY COUNTS WHEN IT IS ITS OWN PACKAGE. `package.json` also
 * names `server/`, `scripts/` and `src/`, which are this repository's own
 * source and are already stamped by the home walk; requiring them would prove
 * nothing. What distinguishes `engine/` is that it carries its own
 * `package.json` — it is a tree that was, and still behaves as, a repository
 * in its own right. That test is mechanical, has exactly one hit today
 * (`git ls-files` filtered to top-level `package.json` files names exactly
 * `engine/package.json`), and
 * extends itself with nothing edited the day a second package is absorbed.
 *
 * ── AND IT STILL REFUSES AN EMPTY UNIVERSE, ON BOTH INPUTS ────────────────
 *
 * Every way of emptying this answer silently disarms the floor above it, so
 * each empty input is a REFUSAL that names which one it was. The old table of
 * driven emptyings is preserved because the shapes did not change, only the
 * spelling of the reach:
 *
 *   | how the universe empties                        | answer |
 *   |-------------------------------------------------|--------|
 *   | healthy tree                                    | 1 root |
 *   | `package.json` ABSENT — the `catch` returned [] | **[]** |
 *   | the tree reached via a VARIABLE, not `<name>/`  | **[]** |
 *   | the named segment carries no `package.json`     | **[]** |
 *
 * A tree that genuinely has no inner package must say so HERE, by editing
 * this function, rather than being indistinguishable from one whose
 * declaration was lost.
 */
export type RequiredInnerRootsAnswer = Readonly<{
  roots: readonly string[];
  /** Plain-words reason the answer cannot be believed, or `null`. */
  failure: string | null;
}>;

/**
 * The answer AND the reason it cannot be believed, computed once.
 *
 * Separated from `requiredInnerRoots` so a test can drive both directions over
 * planted trees without catching exceptions, and so the refusal is one
 * computation rather than a check duplicating the walk it guards.
 */
export function judgeRequiredInnerRoots(home: string): RequiredInnerRootsAnswer {
  const where = join(home, "package.json");
  let manifest: string;
  try {
    manifest = readFileSync(where, "utf8");
  } catch {
    return {
      roots: [],
      failure:
        `requiredInnerRoots: could not read ${where}. That file is the declaration this ` +
        "check believes over a source scan, and an unreadable declaration is a broken " +
        "discovery, not a repository with no inner trees — every root it would have named " +
        "is now absent from the floor, which then has nothing to miss.",
    };
  }
  const named = [...manifest.matchAll(/(?:^|[\s"'(=])([A-Za-z0-9._@-]+)\//gu)].map((m) => m[1] ?? "");
  if (named.length === 0) {
    return {
      roots: [],
      failure:
        `requiredInnerRoots: ${where} names NO directory by a \`<name>/\` path. This ` +
        "repository cannot typecheck, build, dev-serve or test without the engine tree, " +
        "so zero here means the reach is now spelled some other way — a variable, an env " +
        "var, a path joined at run time — and not that the coupling is gone. Name it here, " +
        "or state at this function why this tree genuinely stands alone.",
    };
  }
  const roots = new Set<string>();
  for (const name of new Set(named)) {
    // `./tsconfig.templates.json` is a real spelling in this manifest, and
    // `.` resolves to HOME — whose `package.json` always exists, so without
    // this the home tree would enlist itself as its own inner package and the
    // floor would be satisfied by the walk it is meant to check.
    if (name === "." || name === "..") continue;
    // ITS OWN PACKAGE, not merely a named directory. This repository's own
    // `src/`, `server/`, `scripts/` and `tests/` are named here too and are
    // already covered by the home walk; requiring them would certify nothing.
    if (!existsSync(join(home, name, "package.json"))) continue;
    roots.add(name);
  }
  if (roots.size === 0) {
    return {
      roots: [],
      failure:
        `requiredInnerRoots: ${where} names ${String(new Set(named).size)} directory path(s) ` +
        `(${[...new Set(named)].sort().join(", ")}) and NOT ONE of them carries its own ` +
        "`package.json`. The declaration and the tree disagree; a floor built on this " +
        "answer would require nothing at all. Before the monorepo assembly the same " +
        "sentence read `and NOT ONE of them holds a `.git``.",
    };
  }
  return { roots: [...roots].sort(), failure: null };
}

export function requiredInnerRoots(home: string = SUITE_ROOT): string[] {
  const answer = judgeRequiredInnerRoots(home);
  if (answer.failure !== null) throw new Error(answer.failure);
  return [...answer.roots];
}

/**
 * Every tracked file this run could write, across every repository it can
 * reach, with its stamp.
 */
function fingerprint(): Map<string, string> {
  const home = requireSuiteRoot();
  const out = new Map<string, string>();
  const candidates = new Set<string>();
  stampRepository(home, home, WRITABLE_PREFIX, out, candidates);
  const foreign = foreignRepositories(home, candidates);
  // WHICH ROOTS ACTUALLY CONTRIBUTED, not which were found. The two differ in
  // exactly the case that matters — discover all three, stamp one — so the
  // floor below is built from this and never from `foreign`.
  stampedForeign = [];
  for (const root of foreign) {
    const sizeBefore = out.size;
    stampRepository(home, root, null, out, null);
    if (out.size > sizeBefore) stampedForeign.push(root);
  }
  covered = [home, ...foreign].map((root) => relative(home, root) || ".");
  return out;
}

/**
 * The repositories the last fingerprint covered, for the messages. Not a
 * decoration: a finding that names a file in another tree is unreadable
 * without it, and a run whose foreign list has silently emptied looks exactly
 * like a run with nothing to say.
 */
let covered: string[] = [];

/**
 * The foreign repositories the last fingerprint actually STAMPED at least one
 * file from — the population the floor is built on, deliberately not the list
 * that was discovered. Finding three trees and hashing one is the inert shape
 * this project keeps meeting, and only a root that contributed a key proves it
 * is in the comparison.
 */
let stampedForeign: string[] = [];

let before: Map<string, string> | null = null;

/**
 * Any throw out of a global hook must first write the verdict where a caller
 * reads it.
 *
 * MEASURED, AND THE REASON THIS WRAPPER EXISTS: a throw from a global
 * teardown is printed by vitest as `error during close` and the process still
 * EXITS 0. The check below sets `process.exitCode` on its own findings — but
 * an exception raised on the way to that verdict (a helper that now refuses,
 * a root that moved) skipped the line entirely and the run reported success
 * while announcing a failure. That is the same defect the check exists to
 * prevent, arriving through the check's own plumbing.
 */
export function withVerdict(body: () => void): void {
  try {
    body();
  } catch (error) {
    process.exitCode = 1;
    throw error;
  }
}

export function setup(): void {
  withVerdict(() => {
    const home = requireSuiteRoot();
    before = fingerprint();
    if (before.size === 0) {
      // A fingerprint of nothing agrees with every later fingerprint of
      // nothing. That is the vacuous pass this file exists to prevent, so it
      // refuses rather than certifying an empty universe.
      throw new Error(
        "source-tree-immutable: fingerprinted ZERO tracked files. " +
        `Expected the git index of ${home} to hold files outside ` +
        `${WRITABLE_PREFIX}; either this is not the repository root, or this ` +
        "check has gone blind.",
      );
    }
    // ── PER ROOT, AND AGAINST AN INSTRUMENT THAT IS NOT THIS SCAN ──────────
    //
    // A scalar floor cannot see a PARTIAL collapse, and this population dies
    // partially. Driven before the monorepo assembly: `harness-main-v1` (189
    // tracked files) was enlisted by exactly ONE candidate — a literal
    // `"../../../harness-main-v1/TASKS.md"` in one test — while thirty other
    // sites in the same suite built the same reach as
    // `join(here, "..", "..", "harness-main-v1", …)`, which the literal-path
    // regex cannot see. Rewriting that one line to the idiom its neighbours
    // already use took the population from 2,875 files across 3 repositories
    // to 2,686 across 2, and the scalar floor still passed, because the
    // submodule's 2,038 keys satisfied it on their own. A write to the harness
    // tree would have finished at exit 0 in silence again.
    //
    // THOSE TWO FIGURES ARE HISTORY, NOT THIS RUN'S FLOOR. They were measured
    // against three separate repositories that no longer exist as such, and
    // §34a forbids carrying a drifted figure forward as if it still described
    // the tree. What survives is the SHAPE of the finding, which is why the
    // floor below is per-root and never a count.
    //
    // So the floor asks a SECOND instrument which trees must be in the answer,
    // and requires the stamped population to CONTAIN every one of them (never
    // merely to be as large). The second instrument is deliberately not a
    // source scan: this repository's own `package.json` names the tree it
    // cannot build without, and a `package.json` inside that tree is git's
    // evidence that it is a repository in its own right — two declarations
    // that already have to be correct for the product to work.
    const stampedKeys = [...before.keys()];
    const requiredInner = requiredInnerRoots(home);
    const missingInner = requiredInner.filter(
      (root) => !stampedKeys.some((key) => key.startsWith(`${root}/`)),
    );
    if (missingInner.length > 0) {
      throw new Error(
        `source-tree-immutable: stamped no file from ${String(missingInner.length)} tree/s this ` +
        `repository declares it cannot run without (${missingInner.join(", ")}). Required: ` +
        `${requiredInner.join(", ")}. Before the monorepo assembly these were sibling ` +
        "repositories and the same emptiness was spelled `stampedForeign === []`; now they " +
        "are subtrees of this git index, and a subtree that silently leaves the population " +
        "does so while every count that remains stays plausible.",
      );
    }
    // THE FLOOR IS ON WHAT WAS STAMPED, NOT ON WHAT WAS DECLARED — and that
    // distinction is the whole assertion. A floor reading the declaration is
    // satisfied by a pass that names the engine and then stamps nothing from
    // it: right answer computed, wrong answer used, which is the inert shape
    // this project keeps meeting. Only a key that an engine-blind fingerprint
    // could not produce proves the tree is actually in the comparison, and
    // `key.startsWith("engine/")` is exactly such a key.
    //
    // ── THE OLD `foreignStamped === 0` FLOOR IS RETIRED, WITH ITS REASON ───
    //
    // It counted keys beginning `../`, because until the assembly every tree
    // outside this one was reached by escaping the root. There are now zero
    // repositories outside this one — `foreignRepositories()` below still
    // runs, and still stamps anything that appears tomorrow, but its floor
    // would today be a test that can only pass. A guard that cannot fail is
    // worse than no guard, because it reads as coverage. The proposition it
    // carried (a write to the engine tree must not finish at exit 0 in
    // silence) is carried instead by `missingInner` above, over the same
    // files, in the topology they now live in.
    const foreignStamped = stampedKeys.filter((key) => key.startsWith("../")).length;
    if (foreignStamped > 0 && stampedForeign.length === 0) {
      throw new Error(
        `source-tree-immutable: ${String(foreignStamped)} stamped key(s) escape this ` +
        `repository while NO foreign repository was recorded as stamped (covered: ` +
        `${covered.join(", ") || "none"}). The discovery and the stamping disagree, which ` +
        "is the shape that let a whole repository leave the population unnoticed.",
      );
    }
  });
}

/**
 * What changed between two fingerprints, named by KIND.
 *
 * Separated from the hooks so the verdict is testable without a whole child
 * run: the four kinds a run can produce (deleted, content, mode, index) are
 * exactly the four this must name, and naming them wrongly sends the reader
 * to the wrong diagnosis. Exported for that reason and no other.
 */
export function compareFingerprints(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): readonly string[] {
  const changed: string[] = [];
  for (const [file, stamp] of before) {
    const now = after.get(file);
    if (now === undefined) changed.push(`${file}: UNTRACKED by the run`);
    else if (now === "ABSENT" && stamp !== "ABSENT") changed.push(`${file}: DELETED by the run`);
    else if (now !== stamp) {
      const [beforeHash = "", beforeMode = ""] = stamp.split(":");
      const [afterHash = "", afterMode = ""] = now.split(":");
      changed.push(
        beforeHash === afterHash
          ? `${file}: MODE CHANGED by the run (${beforeMode} → ${afterMode})`
          : `${file}: CONTENT CHANGED by the run`,
      );
    }
  }
  for (const file of after.keys()) {
    if (!before.has(file)) changed.push(`${file}: TRACKED by the run`);
  }
  return changed;
}

export function teardown(): void {
  withVerdict(() => {
    if (before === null) return;
    const changed = compareFingerprints(before, fingerprint());
    if (changed.length > 0) {
      // THE EXIT CODE IS SET EXPLICITLY, AND THAT IS NOT BELT-AND-BRACES.
      // See `withVerdict` above: a throw alone leaves the process at 0.
      process.exitCode = 1;
      throw new Error(
        `The test run modified first-party source (${String(changed.length)} of ` +
        `${String(before.size)} files across ${String(covered.length)} ` +
        `repositories: ${covered.join(", ")}):\n  ${changed.join("\n  ")}\n` +
        "A guard that proves itself by mutating a real source file is writing to state " +
        "another parallel worker is reading, and a truncating write caught mid-flight " +
        "restores an empty file. Plant into the scan's file LIST instead, or into a " +
        "private temporary directory — never into the repository.",
      );
    }
  });
}
