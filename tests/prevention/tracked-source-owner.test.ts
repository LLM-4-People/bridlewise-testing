// @vitest-environment node
/**
 * THE IGNORE RULES AND THE INDEX AGREE — IN BOTH DIRECTIONS.
 *
 * This file used to be titled "every source file the program imports is in the
 * repository", which is one of the two directions. It now owns both, because
 * they are one invariant asked twice and splitting them would put two owners
 * on it:
 *
 *   UNDER-REACH  a file the program NEEDS is missing from the index, usually
 *                because an ignore rule reached further than its author saw.
 *                This is the original defect and classes A/B below.
 *   OVER-REACH   the index HOLDS a path the ignore rules say it should not.
 *                Class C below, added when three artefact trees turned out to
 *                be sitting in the index with no test that would notice them
 *                coming back.
 *
 * ── WHY CLASS C IS HERE AND NOT IN A NEW FILE ─────────────────────────────
 *
 * The search, recorded so the next author does not repeat it. Three guards
 * could plausibly have owned it and none does:
 *
 *   `declared-root-inventory.test.ts` states the same obligation
 *   ("ignored-runtime ⇒ absent from the index") but is a DEPTH-1 walk of this
 *   root, and says so in its own header. Driven: with `bench/.after1/
 *   db-real.json` and `engine/merge-manifest.json` both force-added, it exits
 *   0. It is not blind inside its subject — its subject stops at depth 1.
 *
 *   `gitignore-anchoring.test.ts` asks whether a RULE reaches too far. That is
 *   a question about the patterns; this is a question about the index, and a
 *   correctly-anchored rule with a force-added file underneath it passes there
 *   and fails here.
 *
 *   `encryption-and-dedup-prevention.test.ts` is depth-unbounded over the
 *   index but secret-specific: it looks for `db-key` and harness state
 *   directories, and a benchmark report is neither.
 *
 * So the population was genuinely unowned, and the nearest EXISTING assertion
 * is the last test in this file — same instrument, same message shape, same
 * invariant, on the adjacent population of source files. Widening it is the
 * repair; a fourth file would have been a fourth owner.
 *
 * ── WHY THE IGNORE RULE ITSELF IS NOT THE ANSWER ──────────────────────────
 *
 * An ignore rule stops `git add`. It does not stop `git add -f`, and `-f` is
 * exactly what a person types when git declines to stage the file they mean to
 * commit. Every one of the artefact trees that prompted class C was ignorable
 * by a rule that did not exist yet; now the rules exist, and this is the thing
 * that reds if one is overridden.
 *

 * ── THE DEFECT, MEASURED ──────────────────────────────────────────────────
 *
 * `.gitignore` carried `coverage/` with no leading slash. A pattern without a
 * leading slash matches a directory of that name at ANY DEPTH, so a rule
 * written for the coverage-report output at the repository root also matched
 * `src/lib/coverage/` — a source directory. `CoveragePanel.svelte` lived
 * there, was never added, and `src/lib/component-registry.ts` imports it
 * UNCONDITIONALLY and registers it under `coverage-panel`, which
 * `server/schema/ui-declarations.ts` renders. So the working tree built and
 * every clone did not: the registry's import could not resolve.
 *
 * The instrument that found it was a DISAGREEMENT — disk said 362 files in a
 * directory, git said 361 — and the disagreement was the finding.
 *
 * ── WHY THE FIX IS NOT "ANCHOR THE PATTERN" ───────────────────────────────
 *
 * Anchoring `coverage/` fixes this instance. It does nothing about the next
 * rule someone writes, and `.gitignore` is edited by people thinking about
 * output artifacts, not about which source files they are making invisible.
 * The class is "a source file the program needs is not in the index", and the
 * only instrument that can see it is the index itself — a filesystem walk
 * cannot, because the file is right there on disk.
 *
 * So both halves below compare a POPULATION DERIVED FROM DISK against the
 * GIT INDEX, which is written by `git` and cannot be influenced by any
 * pattern in this repository:
 *
 *   A. every relative static import in the component registry resolves to a
 *      tracked file — the door the defect came through;
 *   B. every source file under the declared source roots is tracked — the
 *      class, which subsumes A and also catches a swallowed file that nothing
 *      imports yet.
 *
 * ── HOW THE PLANTS WORK, AND WHY THEY ARE NOT LITERALS ────────────────────
 *
 * A planted violation that is a fixed string inside this file can be defeated
 * by filtering that exact string. Both plants here are supplied from OUTSIDE
 * the guard: a real scratch git repository holding a real file that is on
 * disk and not committed, fed to the SAME functions the real assertions call,
 * so the plant drives the whole path — read, parse, resolve, consult the
 * index — and only the input varies.
 */
import { describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

// `gitTrackedPaths` moved to the scan helper when `walk` itself started
// consulting the index: this file asked git the same question the walker now
// asks on every call, and two readers of one index is two places to keep
// right. The helper owns it; this file consumes it.
import { gitTrackedPaths, read, walk, stripCommentsOnly } from "../helpers/source-scan.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { ownedFiles, trackedFiles, trackedIgnoredFiles } from "../../engine/src/git/repository-ownership.ts";

/**
 * The source roots. Named rather than discovered, because `walk` REFUSES on a
 * missing root — so a renamed root reds here instead of quietly reducing the
 * scanned population to nothing, which is the failure shape this file exists
 * to prevent, appearing inside the guard.
 */
const SOURCE_ROOTS: readonly string[] = ["src", "server", "shared"];

/** A path the program depends on that the index does not contain. */
type Finding = Readonly<{ path: string; origin: string }>;

/**
 * Every module specifier this source statically imports, from BYTES.
 *
 * Comments are stripped and STRING LITERALS ARE KEPT. A module specifier IS a
 * string literal, so the thorough stripper — which blanks string interiors —
 * would return an empty import list and the scan would pass over a file it
 * never actually read.
 */
function staticImportSpecifiers(source: string): readonly string[] {
  const code = stripCommentsOnly(source);
  const found: string[] = [];
  const pattern = /(?:^|[\s;}])import\s+(?:[^'"();]*?\sfrom\s+)?["']([^"']+)["']/gmu;
  for (const match of code.matchAll(pattern)) found.push(match[1]!);
  return found;
}

/**
 * Findings for one importing file: every RELATIVE specifier resolving to a
 * path the index does not hold. Bare specifiers (`svelte`, `vitest`) name
 * dependencies, never files inside this tree, so they are skipped.
 */
function untrackedImports(
  importerPath: string,
  source: string,
  isTracked: (path: string) => boolean,
): readonly Finding[] {
  const base = dirname(importerPath);
  const findings: Finding[] = [];
  for (const specifier of staticImportSpecifiers(source)) {
    if (!specifier.startsWith(".")) continue;
    const target = join(base, specifier).split(sep).join("/");
    if (isTracked(target)) continue;
    findings.push({ path: target, origin: `${importerPath} imports "${specifier}"` });
  }
  return findings;
}

/** Findings for a walked population: every source file the index does not hold. */
function untrackedSources(
  files: readonly string[],
  isTracked: (path: string) => boolean,
): readonly Finding[] {
  return files
    .filter((file) => !isTracked(file))
    .map((file) => ({ path: file, origin: "on disk, absent from the git index" }));
}

/**
 * The subset of `paths` that some ignore rule matches, each rendered as
 * `<rule-source>:<line>:<pattern> <path>`.
 *
 * `git check-ignore` exits 1 when NOTHING matched — the passing case — so a
 * non-zero status here is a verdict, not a failure. Reading it through a
 * throwing wrapper would turn "clean" into an exception; `spawnSync` returns
 * the status as data and the status is judged rather than assumed.
 *
 * `--no-index` IS LOAD-BEARING AND WAS EARNED BY A MUTATION. Without it,
 * `check-ignore` reports nothing for a path that is already in the index — so
 * once the swallowed file is added, a scan of TRACKED sources asks the rules
 * nothing and passes for free. Driven: with a fresh `lens/` rule appended,
 * the default form exits 1 in silence and `--no-index` names
 * `.gitignore:20:lens/`. The question this guard asks is about the RULES, not
 * about today's index, so the index must be left out of the answer.
 */
function ignoredAmong(cwd: string, paths: readonly string[]): readonly string[] {
  const result = spawnSync("git", ["check-ignore", "--stdin", "--no-index", "-v", "-z"], {
    cwd,
    input: `${paths.join("\0")}\0`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed (status ${String(result.status)}): ${result.stderr}`);
  }
  // `-v -z` emits four NUL-terminated fields per hit: source, line, pattern, path.
  const fields = result.stdout.split("\0").filter((f) => f.length > 0);
  const lines: string[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    lines.push(`${fields[i]!}:${fields[i + 1]!}:${fields[i + 2]!}\t${fields[i + 3]!}`);
  }
  return lines;
}

/**
 * Every path the index holds that the ignore rules ALSO match, from git.
 *
 * The ownership reader's `trackedIgnoredFiles` is git answering about its
 * own index with its own matcher (the versioned rules), which is the instrument that already has
 * to be correct for the product to work — a hand-rolled join of `ls-files` and
 * `check-ignore` would be a claim about it. It reads every `.gitignore` in the
 * tree, each resolved relative to itself, so one call at the root covers
 * `engine/.gitignore` and `bench/.gitignore` too. Driven: with
 * `engine/merge-manifest.json` force-added, this returns it, and that path is
 * ignored by nothing except `engine/.gitignore`.
 */
function trackedButIgnored(root: string): readonly string[] {
  const listed = trackedIgnoredFiles(root);
  if (listed === undefined) throw new Error(`${root} is not a git working tree; there is no index to judge`);
  return listed;
}

/**
 * Every path in the working tree that is NEITHER tracked NOR ignored, from
 * git.
 *
 * ── WHY THIS ARM EXISTS, AND WHY IT IS HERE ───────────────────────────────
 *
 * The two arms above are `(needed ∧ not indexed)` and `(any depth ∧ ignored ∧
 * indexed)`, and `declared-root-inventory.test.ts` covers `(depth 1 ∧
 * unclassified)`. Intersect those and one quadrant is left uncovered:
 * **depth ≥ 2, matched by no ignore rule, in no index.** A file there is
 * invisible to every guard in this repository — `engine/test_edit_tool.txt`,
 * `scripts/api-visibility.mts` and `docs/merge-manifest.json` were all
 * exactly that before the clean-root work removed them, and four of the five
 * categories it retired land back in that quadrant if they are recreated one
 * directory down.
 *
 * THIS FILE IS BLIND INSIDE ITS OWN DECLARED SUBJECT, WHICH IS WHY THE REPAIR
 * IS HERE AND NOT IN A NEW FILE. Its title is "the ignore rules and the index
 * agree — in both directions", and a path that is in neither is precisely a
 * disagreement it never asks about. Case B asks a piece of the question and
 * the mechanism of its blindness is its POPULATION: three named source roots
 * and a five-extension filter, so `engine/`, `scripts/`, `docs/`, `bench/`,
 * `tests/` and every non-source extension were outside it by construction. A
 * second file beside this one would leave that population narrow and leave a
 * reader trusting it.
 *
 * ── WHY GIT ANSWERS AND NOTHING WALKS ─────────────────────────────────────
 *
 * A depth-N walk needs a skip list, and a skip list is the thing that goes
 * stale — it would have to know about `node_modules`, the caches, the
 * snapshots. The ownership reader (`ownedFiles` minus `trackedFiles`) is git
 * applying every versioned `.gitignore` in the tree, each resolved relative
 * to itself, and reporting exactly the paths that survive. There is no universe here to get wrong,
 * which is the property every level-5 guard in this project has failed on.
 *
 * A directory that is not a repository is a refusal rather than a clean tree:
 * the reader answers `undefined` there, never an empty list.
 */
function untrackedAndUnignored(root: string): readonly string[] {
  const owned = ownedFiles(root);
  const tracked = trackedFiles(root);
  if (owned === undefined || tracked === undefined) {
    throw new Error(`${root} is not a git working tree; "nothing untracked" and "no repository" must not look alike`);
  }
  const index = new Set(tracked);
  return owned.filter((path) => !index.has(path));
}

/**
 * A scratch repository whose index holds a file its own rules ignore.
 *
 * The plant is supplied from outside the guard and enters where a real caller
 * enters — `git add -f`, the actual door, rather than a literal this file
 * could recognise by name. `tracked.txt` beside it is the control: a plant
 * that reported everything would be indistinguishable from one that worked.
 */
function repositoryWithAForceAddedArtefact(): string {
  const root = createTempDir("ch-web-forced-");
  const run = (...args: readonly string[]): void => {
    execFileSync("git", [...args], { cwd: root, stdio: "pipe" });
  };
  run("init", "-q");
  run("config", "user.email", "guard@example.invalid");
  run("config", "user.name", "guard");
  writeFileSync(join(root, ".gitignore"), "/.reports/\n");
  writeFileSync(join(root, "tracked.txt"), "kept\n");
  mkdirSync(join(root, ".reports"), { recursive: true });
  writeFileSync(join(root, ".reports", "run.json"), "{}\n");
  run("add", ".gitignore", "tracked.txt");
  run("add", "-f", ".reports/run.json");
  run("commit", "-q", "-m", "plant");
  return root;
}

/** Repository-relative, forward-slash paths for every source file under `root`. */
function sourceFilesUnder(repositoryRoot: string, root: string): readonly string[] {
  return walk(root, { exts: [".ts", ".svelte", ".mjs", ".cjs", ".js"] })
    .map((file) => relative(repositoryRoot, file).split(sep).join("/"));
}

/**
 * A scratch git repository holding a committed file and an identical-looking
 * file that is on disk and NOT committed, plus an importer of both.
 *
 * This is the plants' supply. It is a real repository, so `git ls-files`
 * answers it for real, and nothing about its shape is special-cased in any
 * function under test.
 */
function plantRepository(): Readonly<{ root: string; importer: string }> {
  const root = createTempDir("ch-web-tracked-");
  const run = (...args: readonly string[]): void => {
    execFileSync("git", [...args], { cwd: root, stdio: "pipe" });
  };
  run("init", "-q");
  run("config", "user.email", "guard@example.invalid");
  run("config", "user.name", "guard");
  mkdirSync(join(root, "lib", "swallowed"), { recursive: true });
  writeFileSync(join(root, "lib", "Present.svelte"), "<div></div>\n");
  writeFileSync(join(root, "lib", "swallowed", "Absent.svelte"), "<div></div>\n");
  writeFileSync(
    join(root, "lib", "registry.ts"),
    'import Present from "./Present.svelte";\n' +
      'import Absent from "./swallowed/Absent.svelte";\n' +
      'import { onMount } from "svelte";\n' +
      "export const R = { Present, Absent, onMount };\n",
  );
  run("add", "lib/Present.svelte", "lib/registry.ts");
  run("commit", "-q", "-m", "plant");
  return { root, importer: "lib/registry.ts" };
}

describe("every source the program imports is in the git index", () => {
  // (Class A and its plant died with the component registry — class B
  //  below subsumes it: every source file under the roots is index-checked.)

  test("B. every source file under the source roots is tracked", () => {
    const cwd = process.cwd();
    const tracked = gitTrackedPaths(cwd);
    const files = SOURCE_ROOTS.flatMap((root) => sourceFilesUnder(cwd, root));

    // LIVENESS — the walked population, floored by the index rather than by a
    // number written here. Every tracked source under these roots is also on
    // disk, so the walk can never return fewer files than git holds.
    const trackedUnderRoots = [...tracked].filter(
      (p) => SOURCE_ROOTS.some((r) => p.startsWith(`${r}/`)) &&
        /\.(?:ts|svelte|mjs|cjs|js)$/u.test(p),
    );
    expect(trackedUnderRoots.length).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThanOrEqual(trackedUnderRoots.length);

    const findings = untrackedSources(files, (p) => tracked.has(p));
    expect(
      findings.map((f) => f.path),
      `${findings.length} of ${files.length} source file(s) are on disk and absent from the git index, so a ` +
        `fresh clone does not contain them. Run \`git check-ignore -v <path>\`: an ignore pattern without a ` +
        `leading slash matches a directory of that name at EVERY depth.`,
    ).toEqual([]);
  });

  test("B-plant. the same function reports an untracked source file when one exists", () => {
    const { root } = plantRepository();
    const tracked = gitTrackedPaths(root);
    const files = sourceFilesUnder(root, join(root, "lib"));

    expect(files).toContain("lib/Present.svelte");
    expect(files).toContain("lib/swallowed/Absent.svelte");

    const findings = untrackedSources(files, (p) => tracked.has(p));
    expect(findings.map((f) => f.path)).toEqual(["lib/swallowed/Absent.svelte"]);
    expect(untrackedSources(files, () => true)).toEqual([]);
  });

  test("B-inert. discarding the result cannot make the assertion pass", () => {
    // The wired-but-inert shape: compute the findings and drop them. The
    // assertion above consumes the FILE SET, which still holds the untracked
    // path, so a discarded result changes nothing that is asserted on. Driven
    // against the plant so this is measured rather than claimed.
    const { root } = plantRepository();
    const tracked = gitTrackedPaths(root);
    const files = sourceFilesUnder(root, join(root, "lib"));
    void untrackedSources(files, (p) => tracked.has(p));
    expect(files).toContain("lib/swallowed/Absent.svelte");
    expect(tracked.has("lib/swallowed/Absent.svelte")).toBe(false);
  });

  test("no ignore rule matches a source file, and the rule is named when one does", () => {
    // The direct statement of the original defect, against `git check-ignore`
    // itself — the instrument that NAMED the rule (`.gitignore:8:coverage/`),
    // so a failure points at the line to edit rather than only at the file.
    const cwd = process.cwd();
    const files = SOURCE_ROOTS.flatMap((root) => sourceFilesUnder(cwd, root));
    expect(files.length).toBeGreaterThan(0);
    const matched = ignoredAmong(cwd, files);
    expect(
      matched,
      `an ignore rule matches ${matched.length} source file(s); each line names the file and the rule:\n` +
        matched.join("\n"),
    ).toEqual([]);

    // LIVENESS AND PLANT, from outside: the same call against a path the rules
    // DO cover must report it, otherwise a silent `check-ignore` would make
    // the assertion above vacuous.
    expect(ignoredAmong(cwd, ["node_modules/anything.ts"])).not.toEqual([]);
  });

  test("C. no path the ignore rules match is in the index, at any depth", () => {
    const cwd = process.cwd();

    // WITNESS FIRST (§ an absence assertion needs one). "Nothing is tracked and
    // ignored" and "this command is not reading a repository" both return an
    // empty list. The witness lives in the SAME instrument the assertion
    // requires to be empty — the index — so a broken reach shows up as a
    // missing witness rather than as a clean tree.
    const tracked = gitTrackedPaths(cwd);
    expect(
      tracked.has(".gitignore"),
      "the index scan did not find .gitignore, so it is not reading this repository and its " +
        "empty answer below would be about the instrument",
    ).toBe(true);
    // POPULATION AS A RUNTIME NUMBER, floored well under today's count so it
    // reds on a collapsed reach rather than on ordinary churn.
    expect(tracked.size).toBeGreaterThan(500);

    // AND THE RULES MUST REACH TOO. An index full of files proves the first
    // half of the join; this proves the second, in the subtrees that carry
    // their own ignore files — a run where `bench/.gitignore` or
    // `engine/.gitignore` stopped being consulted would otherwise be green.
    for (const covered of [
      "bench/.out/db-real.json",
      "bench/.after1/db-real.json",
      "engine/merge-manifest.json",
      ".bkp/anything.ts",
    ]) {
      expect(
        ignoredAmong(cwd, [covered]),
        `no rule covers ${covered}, so nothing here would refuse it being force-added`,
      ).not.toEqual([]);
    }

    // (The experiment archive `experiments/` is a tracked record named by no
    // rule: what ships is the promotion profile's answer, never an ignore
    // rule — the branch-conditional `/experiments/` rule and its re-admission
    // retired with the merge door, PROMO-4.)

    const forced = trackedButIgnored(cwd);
    expect(
      forced,
      `${forced.length} path(s) are in the git index AND matched by an ignore rule. A rule saying ` +
        `a path is an artefact, and an index holding it anyway, is the state that put 26 benchmark ` +
        `run reports and a stray merge manifest in this repository. Run ` +
        `\`git check-ignore -v <path>\` for the rule, then \`git rm --cached <path>\` — or, if the ` +
        `file genuinely belongs in the index, change the rule rather than overriding it with -f.`,
    ).toEqual([]);
  });

  test("D. no path in this tree is in neither the index nor the ignore rules, at any depth", () => {
    const cwd = process.cwd();

    // LIVENESS FIRST. `git status` answering "nothing" and `git status` not
    // reading this repository are the same empty list — the second is a
    // refusal here (non-zero exits throw), and this pins the first.
    expect(
      gitTrackedPaths(cwd).size,
      "the index scan found nothing, so this tree is not the one being judged",
    ).toBeGreaterThan(500);

    const undeclared = untrackedAndUnignored(cwd);
    expect(
      undeclared,
      `${undeclared.length} path(s) in this working tree are in NO index and matched by NO ` +
        `ignore rule. Every path here is one or the other: the index says "the program, its ` +
        `proofs or its records need this", and a rule says "a program wrote this and git must ` +
        `not hold it". A path that says neither is residue, and it is sitting in front of the ` +
        `next \`git add -A\` — which is how a merge manifest reached \`docs/\`, a scratch text ` +
        `file reached \`engine/\` and a one-off script reached \`scripts/\`. Say which it is: ` +
        `\`git add <path>\` (or \`git add -N <path>\` while it is still being written), or give ` +
        `it an ignore rule in the \`.gitignore\` that owns its subtree.`,
    ).toEqual([]);
  });

  test("D-plant. the same call reports an untracked, unignored path and not its neighbours", () => {
    // Driven through the SAME function the assertion above calls, on a real
    // repository, so only the input varies. Three files, one of each state:
    // tracked, ignored, and neither — a plant that reported all three would be
    // indistinguishable from one that reported everything.
    const root = createTempDir("ch-web-undeclared-");
    const run = (...args: readonly string[]): void => {
      execFileSync("git", [...args], { cwd: root, stdio: "pipe" });
    };
    run("init", "-q");
    run("config", "user.email", "guard@example.invalid");
    run("config", "user.name", "guard");
    writeFileSync(join(root, ".gitignore"), "/artefacts/\n");
    writeFileSync(join(root, "tracked.txt"), "in the index\n");
    run("add", ".gitignore", "tracked.txt");
    run("commit", "-q", "-m", "plant");

    // Nothing yet: every path is tracked, and the answer must be empty for
    // that reason rather than because the call cannot see the repository.
    expect(untrackedAndUnignored(root)).toEqual([]);

    mkdirSync(join(root, "artefacts"), { recursive: true });
    writeFileSync(join(root, "artefacts", "run.json"), "{}\n");
    // Still empty — an ignored path is DECLARED, by the rule.
    expect(untrackedAndUnignored(root)).toEqual([]);

    // The residue, two directories down so the depth-1 root guard could not
    // have seen it and with an extension case B's filter would have skipped.
    mkdirSync(join(root, "docs", "deep"), { recursive: true });
    writeFileSync(join(root, "docs", "deep", "merge-manifest.json"), "{}\n");
    expect(untrackedAndUnignored(root)).toEqual(["docs/deep/merge-manifest.json"]);

    // …and it clears the way the message says it does, by EITHER route.
    run("add", "-N", "docs/deep/merge-manifest.json");
    expect(untrackedAndUnignored(root)).toEqual([]);
  });

  test("D-refusal. a directory that is not a repository is refused, never reported clean", () => {
    // The empty answer this arm asserts is the same empty answer a misdirected
    // instrument gives, so the misdirection has to be a throw. Driven rather
    // than claimed: `git status` exits 128 outside a repository and prints
    // nothing at all on stdout.
    const notARepository = createTempDir("ch-web-not-a-repo-");
    expect(() => untrackedAndUnignored(notARepository)).toThrow(/is not a git working tree/u);
  });

  test("C-plant. a force-added ignored file is reported, and its tracked neighbour is not", () => {
    // Driven through the SAME function the assertion above calls, on a real
    // repository whose index really was overridden with `git add -f`.
    const root = repositoryWithAForceAddedArtefact();
    expect([...trackedButIgnored(root)]).toEqual([".reports/run.json"]);

    // The control: the same repository's ordinary tracked file is NOT
    // reported, so the plant is measuring the rule and not the reach.
    const tracked = gitTrackedPaths(root);
    expect(tracked.has("tracked.txt")).toBe(true);
    expect(tracked.has(".reports/run.json")).toBe(true);
    expect([...trackedButIgnored(root)]).not.toContain("tracked.txt");
  });
});
