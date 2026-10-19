/**
 * NO IGNORE RULE REACHES FURTHER THAN THE PLACE IT NAMES.
 *
 * The rule and its wording live in `scripts/verification/gitignore-anchoring.ts`;
 * this file supplies the instruments and the evidence. It judges the
 * `.gitignore` files of every repository it can reach from here — this one and
 * the tree it is a submodule of — and it DRIVES the two claims the rule rests
 * on, against real git, on throwaway repositories:
 *
 *   A. an unanchored directory pattern really does swallow a tracked file at
 *      another depth, and `mv` + `git add -A` really does drop it from the
 *      index at exit 0 — with ONE line of warning, a staged deletion of the
 *      old path, which vanishes at the commit;
 *   B. an anchored pattern really does keep working when its subtree becomes a
 *      subdirectory, PROVIDED the `.gitignore` travels with the subtree.
 *
 * B is the direction anchoring could have broken, and it is the reason each
 * subtree owns its rules instead of one file at the top reaching down.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

import {
  allFindings,
  anchoredProbePath,
  anchoringOf,
  everyDepthName,
  gitignoreAnchoringFailure,
  parseGitignore,
  submoduleRoots,
  trackedSegments,
  unremediedFindings,
  type GitignoreDeclaration,
} from "../../scripts/verification/gitignore-anchoring.ts";
import { createTempDir } from "../support/temp-dir.ts";

const INTEGRATION_ROOT = resolve(import.meta.dirname, "..", "..");
const HARNESS_ROOT = dirname(INTEGRATION_ROOT);

/** Repository-relative paths git holds in the index of `root`. */
function trackedPaths(root: string): readonly string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((entry) => entry.length > 0);
}

/**
 * Every tree these rules must be judged FROM.
 *
 * RE-DERIVED AT THE MONOREPO ASSEMBLY (2026-07-30), NOT PORTED. This was
 * `[HARNESS_ROOT, ...submoduleRoots(HARNESS_ROOT)]` — the tree that owned this
 * submodule plus everything it declared inside itself, which was three
 * repositories and three indexes. They are one index now, `.gitmodules` is
 * gone, and the list returned exactly one root while the floor below still
 * demanded two. Dropping the floor would have been the wrong repair: the
 * number was never the point.
 *
 * What the reach is actually FOR is the direction anchoring can break in. An
 * anchored pattern is resolved relative to the `.gitignore` that declares it,
 * so `engine/.gitignore`'s `/large-codebases` means `engine/large-codebases`
 * from this repository's root and `large-codebases` from the engine's — and
 * only the second listing can say what that rule will mean if this subtree
 * ever becomes a repository again, which is the state it just came out of.
 * So the engine root is asked SEPARATELY, exactly as the web side of this
 * repository asks it (`tests/prevention/gitignore-anchoring.test.ts`), and a
 * submodule declared tomorrow still extends the answer by itself.
 */
function reachableRoots(): readonly string[] {
  const roots = [INTEGRATION_ROOT, HARNESS_ROOT, ...submoduleRoots(HARNESS_ROOT)];
  return [...new Set(roots)];
}

/**
 * The refusal a reach earns, or `null` — PURE over the listings it is handed.
 *
 * The floor it replaces (`roots.length >= 2`) could be satisfied by two names
 * for one thing, which is precisely what a merge produces. These three arms
 * cannot: a root that contributes nothing is not reached, and two roots that
 * produce the SAME listing are one view wearing two labels, which is the
 * vacuous state a count reports as healthy.
 */
function reachFailure(
  roots: readonly string[],
  listingOf: (root: string) => readonly string[],
): string | null {
  if (roots.length < 2) {
    return (
      `reached ${String(roots.length)} root(s): this tree and the repository that holds it ` +
      `must both be asked, because an anchored pattern means a different place in each`
    );
  }
  const silent = roots.filter((root) => listingOf(root).length === 0);
  if (silent.length > 0) {
    return `contributed no tracked path, so the scan did not reach it: ${silent.join(", ")}`;
  }
  const views = new Set(roots.map((root) => listingOf(root).join("\0")));
  if (views.size !== roots.length) {
    return `two of [${roots.join(", ")}] produced the SAME listing, so one of them adds no view`;
  }
  return null;
}

/** Every tracked `.gitignore` in `root`, as repository-relative paths. */
function gitignoreFiles(root: string): readonly string[] {
  return trackedPaths(root).filter((path) => path === ".gitignore" || path.endsWith("/.gitignore"));
}

/** Every `.gitignore` in `root`, paired with what it declares. */
function declarationsOf(root: string, label: string): readonly GitignoreDeclaration[] {
  return gitignoreFiles(root).map((file) => ({
    file: `${label}/${file}`,
    patterns: parseGitignore(readFileSync(join(root, file), "utf8"), `${label}/${file}`),
  }));
}

/** A throwaway repository, whose removal the temp-dir owner already holds. */
function scratchRepository(): string {
  const root = createTempDir("ch-gitignore-anchoring-");
  const run = (...args: readonly string[]): void => {
    execFileSync("git", [...args], { cwd: root, stdio: "pipe" });
  };
  run("init", "-q");
  run("config", "user.email", "guard@example.invalid");
  run("config", "user.name", "guard");
  return root;
}

function writeFile(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/**
 * The subset of `paths` some ignore rule matches, asked of git itself.
 *
 * `git check-ignore` exits 1 when NOTHING matched — the interesting case in
 * both directions here — so the status is read as data via `spawnSync` rather
 * than raised by a throwing wrapper. `--no-index` asks about the RULES rather
 * than about today's index, and `-z` keeps a path holding a newline intact.
 */
function ignoredAmong(root: string, paths: readonly string[]): ReadonlySet<string> {
  const result = spawnSync("git", ["check-ignore", "--stdin", "--no-index", "-z"], {
    cwd: root,
    input: `${paths.join("\0")}\0`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed (status ${String(result.status)}): ${result.stderr}`);
  }
  return new Set(result.stdout.split("\0").filter((entry) => entry.length > 0));
}

test("every reachable repository's ignore rules name a place they can defend", () => {
  const roots = reachableRoots();
  // POPULATION. A reach that silently shrank would otherwise certify the
  // trees it stopped looking at.
  const reach = reachFailure(roots, trackedPaths);
  assert.equal(reach, null, reach ?? "");

  const segments = trackedSegments(roots.flatMap((root) => trackedPaths(root)));
  assert.ok(segments.size > 0, "the tracked-segment universe is empty");

  const declarations = roots.flatMap((root) =>
    declarationsOf(root, root === HARNESS_ROOT ? "harness" : "integration"),
  );
  assert.ok(declarations.length > 0, "no .gitignore was discovered");

  // AND THE ENGINE'S OWN RULES ARE JUDGED IN BOTH VIEWS, which is the whole
  // reason the reach is more than one root. Spelled by DERIVING the engine's
  // place inside this repository rather than by writing `engine/`: the last
  // thing that moved was exactly this path.
  const enginePrefix = relative(HARNESS_ROOT, INTEGRATION_ROOT);
  assert.ok(
    declarations.some((declaration) => declaration.file === "integration/.gitignore"),
    "the engine's rules were not judged from the engine root",
  );
  assert.ok(
    declarations.some((declaration) => declaration.file === `harness/${enginePrefix}/.gitignore`),
    `the engine's rules were not judged from the repository root as ${enginePrefix}/.gitignore`,
  );

  const failure = gitignoreAnchoringFailure(
    `${roots.length} reachable repositories`,
    declarations,
    segments,
  );
  assert.equal(failure, null, failure ?? "");
});

test("THE REACH IS ITSELF CHECKED: a shrunken or doubled-up reach is a refusal", () => {
  // PLANTS, supplied from outside. The arm that matters most is the last one:
  // two labels over one listing is what a merge produces, it satisfies any
  // count, and it is the state in which this guard judges half of what it
  // claims to.
  const listings = new Map<string, readonly string[]>([
    ["/w", ["a.ts", "engine/b.ts"]],
    ["/w/engine", ["b.ts"]],
  ]);
  const listingOf = (root: string): readonly string[] => listings.get(root) ?? [];
  assert.equal(reachFailure(["/w", "/w/engine"], listingOf), null);
  assert.match(reachFailure(["/w"], listingOf) ?? "", /reached 1 root/u);
  assert.match(reachFailure(["/w", "/gone"], listingOf) ?? "", /contributed no tracked path/u);
  assert.match(reachFailure(["/w", "/w/engine"], () => ["same.ts"]) ?? "", /the SAME listing/u);
});

test("the rule reports an unanchored pattern, and the report is not about this tree", () => {
  // PLANT, supplied from outside the guard: the rule is asked about a
  // declaration written here, so a green verdict above is about the ignore
  // files and not about a detector that stopped detecting.
  const planted = parseGitignore("research/\n**/experiments/\n/artifacts/\n", "plant/.gitignore");
  assert.equal(planted.length, 3);
  assert.deepEqual(planted.map((p) => anchoringOf(p.pattern)), ["implicit", "every-depth", "anchored"]);

  const failure = gitignoreAnchoringFailure(
    "plant",
    [{ file: "plant/.gitignore", patterns: planted }],
    trackedSegments(["docs/research/notes.md", "experiments/exp1/a.ts"]),
  );
  assert.notEqual(failure, null);
  assert.match(failure ?? "", /research\//u);
  assert.match(failure ?? "", /experiments\//u);
  // The anchored one is NOT reported, so the rule is discriminating rather
  // than complaining about everything.
  assert.doesNotMatch(failure ?? "", /artifacts/u);
});

test("an empty universe is a refusal on every input, not a clean verdict", () => {
  const segments = trackedSegments(["src/a.ts"]);
  const patterns = parseGitignore("/build/\n", "x/.gitignore");
  const declared = [{ file: "x/.gitignore", patterns }];
  assert.match(gitignoreAnchoringFailure("x", [], segments) ?? "", /broken discovery/u);
  assert.match(
    gitignoreAnchoringFailure("x", [{ file: "x/.gitignore", patterns: [] }], segments) ?? "",
    /NOT ONE pattern/u,
  );
  assert.match(gitignoreAnchoringFailure("x", declared, new Set()) ?? "", /universe is empty/u);
  assert.equal(gitignoreAnchoringFailure("x", declared, segments), null);

  // AND THE THIRD RULE, planted: an anchored pattern written in a file that
  // cannot carry it. The root declares a path inside a subtree that has its
  // own rules, so it is correct today and stops matching when that subtree
  // moves — the failure anchoring alone would have introduced.
  const misplaced = gitignoreAnchoringFailure(
    "x",
    [
      { file: ".gitignore", patterns: parseGitignore("bench/.out/\n", ".gitignore") },
      { file: "bench/.gitignore", patterns: parseGitignore("/.fixtures/\n", "bench/.gitignore") },
    ],
    segments,
  );
  assert.match(misplaced ?? "", /cannot carry them/u);
  assert.match(misplaced ?? "", /bench\/\.out\//u);
  // The subtree's own rule is NOT reported: the check is about placement, not
  // about anchored patterns in general.
  assert.doesNotMatch(misplaced ?? "", /\.fixtures/u);
});

test("THE ADVICE IS HELD TO THE RULE: every remedy this guard prints passes this guard", () => {
  // The general form of a defect this rule shipped twice. It printed
  // `/**/server/` as the anchored spelling of `**/server/` — and `/**/server/`
  // still matches at every depth, so an operator who followed the advice
  // changed nothing and had a message saying they had. It also offered
  // `**/x` as a free alternative to `/x` for every unanchored pattern, and
  // `**/x` is refused by the collision rule whenever `x` is a directory some
  // repository tracks files under — which is the case the rule fires on most.
  //
  // Neither was reachable by reading the message. Both are reachable by
  // TAKING the advice and asking again, which is all this test does.
  const segments = trackedSegments(["experiments/exp1/a.ts", "a/server/f.ts", "src/x.ts"]);
  const declarations: readonly GitignoreDeclaration[] = [
    {
      file: ".gitignore",
      // Supplied from outside the rule, one line per branch it can take:
      // implicit-and-colliding, every-depth-and-colliding, implicit wildcard,
      // implicit negated, and an anchored rule sitting in the wrong file.
      patterns: parseGitignore("experiments/\n**/server/\n*.log\n!coverage\nbench/.out/\n", ".gitignore"),
    },
    { file: "bench/.gitignore", patterns: parseGitignore("/.fixtures/\n", "bench/.gitignore") },
  ];

  const { examined, remaining } = unremediedFindings(declarations, segments);

  // POPULATION, as a runtime number, and containment rather than a count: a
  // branch that stopped producing a finding would otherwise leave its remedy
  // unexamined while this test still reported success.
  assert.deepEqual(
    examined.map((f) => f.pattern.raw).sort(),
    ["!coverage", "**/server/", "*.log", "bench/.out/", "experiments/"],
    "the planted set must reach every branch that prints a remedy",
  );
  for (const finding of examined) {
    assert.ok(finding.remedies.length > 0, `"${finding.pattern.raw}" was refused with no remedy`);
  }

  assert.deepEqual(
    remaining.map((f) => `${f.pattern.file}:${f.pattern.raw} — ${f.why}`),
    [],
    "a remedy this rule printed is refused by this rule",
  );

  // AND THE INERT SHAPE, which the round-trip alone cannot see: the remedies
  // could be computed correctly, checked here, and a DIFFERENT spelling
  // printed in the sentence the operator actually reads. The prose is the
  // deliverable, so every remedy must appear in it verbatim.
  for (const finding of examined) {
    for (const remedy of finding.remedies) {
      assert.ok(
        finding.why.includes(`"${remedy.pattern}"`),
        `the message for "${finding.pattern.raw}" does not print its own remedy ` +
          `"${remedy.pattern}" — the field is right and the sentence is not:\n${finding.why}`,
      );
    }
  }

  // The collision-dependent alternative, stated as its own claim: `**/x` is
  // offered for a name nothing tracks and withheld for a name something does.
  const offered = (raw: string): readonly string[] =>
    examined.find((f) => f.pattern.raw === raw)?.remedies.map((r) => r.pattern) ?? [];
  assert.deepEqual(offered("experiments/"), ["/experiments/"]);
  assert.deepEqual(offered("*.log"), ["/*.log", "**/*.log"]);
  // A negated pattern keeps its `!`; a remedy that silently inverts a rule
  // would round-trip clean and mean the opposite thing.
  assert.deepEqual(offered("!coverage"), ["!/coverage", "!**/coverage"]);
  // The misplaced rule's remedy is re-anchored to the file that will carry it.
  assert.deepEqual(offered("bench/.out/"), ["/.out/"]);
});

test("DRIVEN REMEDY: git agrees the advice reaches only where the rule says it does", () => {
  // ── WHY THE ROUND-TRIP ABOVE IS NOT ENOUGH ────────────────────────────────
  //
  // It feeds the advice back through the rule's OWN classifier, and the
  // classifier is the thing that can be wrong. Driven here: reverting the
  // remedy to the spelling this file used to print — `/**/server/` for
  // `**/server/` — left the round-trip GREEN, because `anchoringOf` read the
  // leading slash as an anchor and called it "anchored". git does not.
  //
  //   git 2.47.3, `/**/server/`  → ignores server/f.ts, a/server/f.ts,
  //                                deep/er/server/f.ts
  //   git 2.47.3, `/server/`     → ignores server/f.ts ONLY
  //
  // So the acceptance instrument here is git itself, asked in a scratch
  // repository, and the rule's opinion is never consulted.
  const root = scratchRepository();
  const segments = trackedSegments(["experiments/exp1/a.ts", "a/server/f.ts", "src/x.ts"]);
  const findings = allFindings(
    [
      {
        file: ".gitignore",
        patterns: parseGitignore("experiments/\n**/server/\nnode_modules\n", ".gitignore"),
      },
    ],
    segments,
  );
  assert.ok(findings.length > 0, "no finding was produced, so no remedy was examined");

  // Each remedy gets its own directory declaring its own `.gitignore`, so git
  // resolves it exactly as it would in the file it is destined for and the
  // remedies cannot mask one another.
  type Probe = Readonly<{ remedy: string; path: string; mustBeIgnored: boolean }>;
  const probes: Probe[] = [];
  let index = 0;
  for (const finding of findings) {
    for (const remedy of finding.remedies) {
      if (remedy.pattern.startsWith("!")) continue; // a negation's effect is not its own
      const home = `r${String(index)}`;
      index += 1;
      writeFile(root, join(home, ".gitignore"), `${remedy.pattern}\n`);
      const anchoring = anchoringOf(remedy.pattern);
      const here = anchoredProbePath(remedy.pattern);
      const name = everyDepthName(remedy.pattern);
      if (anchoring === "anchored" && here !== null) {
        // The claim: this names ONE place. So the depth below it is untouched.
        probes.push({ remedy: remedy.pattern, path: join(home, here), mustBeIgnored: true });
        probes.push({ remedy: remedy.pattern, path: join(home, "nested", here), mustBeIgnored: false });
      } else if (anchoring === "every-depth" && name !== null) {
        // The claim: this names every place, and the author typed it that way.
        probes.push({ remedy: remedy.pattern, path: join(home, name, "probe.txt"), mustBeIgnored: true });
        probes.push({
          remedy: remedy.pattern,
          path: join(home, "nested", name, "probe.txt"),
          mustBeIgnored: true,
        });
      }
    }
  }
  // LIVENESS: a remedy shape this loop cannot build a probe for would silently
  // leave the assertion below true over nothing.
  assert.ok(probes.length >= 4, `only ${probes.length} probe(s) were built from ${findings.length} findings`);
  for (const probe of probes) writeFile(root, probe.path, "x\n");

  const ignored = ignoredAmong(root, probes.map((p) => p.path));
  const wrong = probes.filter((p) => ignored.has(p.path) !== p.mustBeIgnored);
  assert.deepEqual(
    wrong.map((p) => `${p.remedy} ${p.mustBeIgnored ? "should" : "should NOT"} ignore ${p.path}`),
    [],
    "git disagrees with what the rule says its own remedy reaches",
  );

  // AND THE SPELLING THAT ESCAPED THE WHOLE RULE, now planted as a violation.
  // Asked of git FIRST, so the claim is behaviour rather than a spelling: a
  // leading slash does not anchor a `**/`, and the rule must agree.
  writeFile(root, join("slashed", ".gitignore"), "/**/server/\n");
  const slashedProbes = ["slashed/server/f.ts", "slashed/a/server/f.ts", "slashed/d/e/server/f.ts"];
  for (const path of slashedProbes) writeFile(root, path, "x\n");
  const slashedIgnored = ignoredAmong(root, slashedProbes);
  assert.deepEqual(
    slashedProbes.filter((p) => !slashedIgnored.has(p)),
    [],
    "git no longer matches `/**/server/` at every depth; the rule below is calibrated to a git that did",
  );
  assert.equal(anchoringOf("/**/server/"), "every-depth");
  assert.equal(everyDepthName("/**/server/"), "server");
  const slashed = gitignoreAnchoringFailure(
    "plant",
    [{ file: "plant/.gitignore", patterns: parseGitignore("/**/server/\n", "plant/.gitignore") }],
    segments,
  );
  assert.match(slashed ?? "", /ignores "server" at every depth/u);
  assert.match(slashed ?? "", /"\/server\/"/u);
});

test("DRIVEN A: an unanchored pattern swallows a tracked file at another depth, silently", () => {
  const root = scratchRepository();
  writeFile(root, ".gitignore", "research/\n");
  writeFile(root, "src/keep.ts", "export const keep = 1;\n");
  writeFile(root, "docs/research/paper.md", "# paper\n");
  const run = (...args: readonly string[]): string =>
    execFileSync("git", [...args], { cwd: root, encoding: "utf8" });

  // The file is TRACKED first, which is the state the merge starts from:
  // `git add -f` is how it got into the index despite the rule, exactly as a
  // repository that never had this rule would have it.
  run("add", "-f", "src/keep.ts", "docs/research/paper.md", ".gitignore");
  run("commit", "-q", "-m", "before");
  assert.ok(trackedPaths(root).includes("docs/research/paper.md"));

  // Now the file MOVES, the way a restructure moves it. Same intent, and the
  // two mechanics differ in outcome while both exit 0.
  renameSync(join(root, "docs", "research", "paper.md"), join(root, "docs", "research", "moved.md"));
  run("add", "-A");

  const after = trackedPaths(root);
  assert.ok(!after.includes("docs/research/moved.md"), "the moved file entered the index");
  assert.ok(!after.includes("docs/research/paper.md"), "the old path is still in the index");

  // AND A CORRECTION, DRIVEN, to how this class is usually described. There is
  // exactly ONE moment when the loss is visible: between the `add -A` and the
  // commit, `git status` shows a staged DELETION of the old path and says
  // nothing at all about the new one. That is the whole warning, it is a line
  // that reads like an ordinary rename half, and there is no second chance.
  assert.equal(run("status", "--porcelain").trim(), "D  docs/research/paper.md");

  // After the commit it is genuinely silent: nothing staged, nothing
  // untracked, the file sitting on disk that no clone will ever receive and
  // that the next `git clean -xfd` removes.
  run("commit", "-q", "-m", "after");
  assert.equal(run("status", "--porcelain", "--untracked-files=all").trim(), "");
  assert.ok(existsSync(join(root, "docs", "research", "moved.md")));
  assert.ok(!trackedPaths(root).includes("docs/research/moved.md"));

  // And the benign counterpart on the SAME repository: a file the rule does
  // not name survives the identical operation.
  renameSync(join(root, "src", "keep.ts"), join(root, "src", "kept.ts"));
  run("add", "-A");
  assert.ok(trackedPaths(root).includes("src/kept.ts"));
});

test("DRIVEN B: anchored rules keep their verdicts once the subtree is nested one level deeper", () => {
  // The direction anchoring could have broken. Each reachable repository's
  // `.gitignore` files are copied into a scratch repository UNDER an extra
  // directory level — the shape a merge produces — and every anchored rule
  // must keep its verdict on the path it names. Nothing is re-typed: the
  // patterns and the probe paths are derived from the real files.
  //
  // THE VERDICT IS A PAIR, NOT A DIRECTION. The first shape of this test
  // asserted every probe comes back IGNORED, skipping negated patterns when
  // it planted. That is a model of git, and it is wrong: git is
  // last-match-wins, so a probe a later NEGATED rule re-admits — the floor
  // bytes this branch deliberately tracks, `!/traceability/evidence/` and
  // `!/experiments/` — comes back NOT ignored in both layouts, and the
  // assertion red-s on a declared, parity-guarded divergence. Worse, the
  // skip made negations invisible to the guard entirely: a negation that
  // STOPPED travelling with its subtree would have passed unobserved.
  //
  // Git itself answers both sides. Each probe's verdict in a FLAT scratch
  // repository (the rule stack at its natural place) is paired against its
  // verdict in the NESTED one — the property under test is "nesting changes
  // no verdict", which holds for patterns and negations alike, needs no
  // fnmatch in this file, and reds on a travel break in either direction.
  const nestedRoot = scratchRepository();
  const roots = reachableRoots();
  for (const repository of roots) {
    const nestUnder = join("merged", repository === HARNESS_ROOT ? "harness" : "integration");
    const flatRoot = scratchRepository();
    const pairs: { flat: string; nested: string }[] = [];

    for (const file of gitignoreFiles(repository)) {
      const source = readFileSync(join(repository, file), "utf8");
      // The `.gitignore` travels WITH its subtree — that is the property under
      // test, and writing it anywhere else would be testing something else.
      writeFile(nestedRoot, join(nestUnder, file), source);
      writeFile(flatRoot, file, source);
      const flatDir = dirname(file);
      const nestedDir = dirname(join(nestUnder, file));
      for (const pattern of parseGitignore(source, file)) {
        // Negated rules probe too: re-admission is a verdict, and its travel
        // is the same property. `anchoredProbePath` reads the stripped form.
        const probe = anchoredProbePath(pattern.pattern);
        if (probe === null) continue;
        const flat = join(flatDir, probe);
        const nested = join(nestedDir, probe);
        writeFile(flatRoot, flat, "x\n");
        writeFile(nestedRoot, nested, "x\n");
        pairs.push({ flat, nested });
      }
    }

    // LIVENESS: the loop above actually built probes. A silent zero would make
    // the whole test a green tick over nothing.
    assert.ok(pairs.length > 0, `no anchored pattern produced a probe path for ${nestUnder}`);

    const flatIgnored = ignoredAmong(flatRoot, pairs.map((p) => p.flat));
    const nestedIgnored = ignoredAmong(nestedRoot, pairs.map((p) => p.nested));
    const drifted = pairs.filter((p) => flatIgnored.has(p.flat) !== nestedIgnored.has(p.nested));
    assert.deepEqual(
      drifted,
      [],
      `${String(drifted.length)} of ${String(pairs.length)} anchored rules changed their verdict ` +
        `once their subtree was nested one level deeper: ${drifted.map((d) => d.nested).join(", ")}`,
    );
  }

  // AND THE PLANT, from outside: a path no rule names must NOT come back
  // ignored, otherwise the instrument answers yes to everything and the
  // assertion above is vacuous.
  const benign = join("merged", "harness", "definitely-not-ignored.txt");
  writeFile(nestedRoot, benign, "x\n");
  assert.equal(ignoredAmong(nestedRoot, [benign]).has(benign), false);
});

test("DRIVEN B-plant: the same nesting BREAKS a rule that reached down from above", () => {
  // The counterexample that gives B its meaning. One `.gitignore` at the top
  // naming `web/coverage/` is correct today and wrong the moment `web/` moves
  // — and the per-subtree form of the same rule survives.
  const root = scratchRepository();
  writeFile(root, ".gitignore", "web/coverage/\n");
  writeFile(root, "merged/web/coverage/report.html", "x\n");
  writeFile(root, "merged/web/.gitignore", "/coverage/\n");
  writeFile(root, "merged/web/other/coverage/report.html", "x\n");

  const ignored = (path: string): boolean => ignoredAmong(root, [path]).has(path);

  // The reaching-down rule no longer matches anything under the moved subtree.
  // The subtree's own anchored rule does — and it is anchored to the subtree,
  // so it does NOT reach a deeper `coverage` directory, which is the whole
  // point of anchoring in the first place.
  assert.equal(ignored("merged/web/coverage/report.html"), true);
  assert.equal(ignored("merged/web/other/coverage/report.html"), false);
});
