// @vitest-environment node
/**
 * THE SCAN'S UNIVERSE IS FLOORED BY THE GIT INDEX, NOT BY A NUMBER.
 *
 * ── THE DEFECT CLASS ──────────────────────────────────────────────────────
 *
 * `walk()` in `tests/helpers/source-scan.ts` is the universe of roughly 258
 * call sites across ~106 guard files. It already refuses a MISSING root, so a
 * renamed directory reds. It could not see a PARTIAL loss: a walk that
 * descends into most of a tree and silently drops part of it returns a
 * smaller universe, every guard reading it finds no offenders, and the run is
 * green. That is the same shape as a dead include pattern and a dead glob —
 * a total loss is caught, a partial one is invisible.
 *
 * A per-call floor cannot fix it. The header on `walk` measures why: the call
 * sites resolve to 88 distinct `(root, extensions)` pairs, 47 of them iterate
 * a SET of roots, and a floor over a set collapses to its weakest member.
 *
 * ── THE INSTRUMENT ────────────────────────────────────────────────────────
 *
 * `git ls-files` is a second, independently-sourced answer to "what source
 * files exist here". It is written by git, no pattern in this repository can
 * steer it, and it is therefore capable of DISAGREEING with the walk. The
 * expectation is derived per call from the index for exactly the pair being
 * walked — nothing here is a literal count — and the comparison is set
 * CONTAINMENT, because the right number with the wrong set is a real outcome.
 *
 * ── HOW THE PLANTS WORK ───────────────────────────────────────────────────
 *
 * Every plant is a real scratch git repository built outside this file's
 * source, fed to `walk` at the entry point a real caller uses. Nothing about
 * the plants' shape is special-cased anywhere in the helper, and no plant
 * touches a tracked file of this repository — a mutation canary must never be
 * a live tracked file.
 *
 * Each plant is paired with the benign version of itself that must stay
 * green, so a refusal is evidence about the defect rather than about scratch
 * repositories in general.
 */
import { describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

import {
  gitTrackedPaths,
  repositoryOwnedEntries,
  ScanUniverseError,
  SOURCE_EXTS,
  walk,
} from "../helpers/source-scan.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

/**
 * A real repository with `lib/` holding the named files, all committed.
 *
 * The caller then perturbs the DISK — never this function — so the index and
 * the filesystem disagree in exactly one way per test.
 */
function plantRepository(files: Readonly<Record<string, string>>): string {
  const root = createTempDir("ch-web-scan-universe-");
  const run = (...args: readonly string[]): void => {
    execFileSync("git", [...args], { cwd: root, stdio: "pipe" });
  };
  run("init", "-q");
  run("config", "user.email", "guard@example.invalid");
  run("config", "user.name", "guard");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  run("add", "-A");
  run("commit", "-q", "-m", "plant");
  return root;
}

/** The repository-relative, forward-slash paths a walk of `root` returned. */
function walkedUnder(root: string, opts?: { exts?: readonly string[]; ignore?: readonly string[] }): string[] {
  return walk(root, opts).map((file) => file.slice(root.length + 1).split("\\").join("/")).sort();
}

describe("walk() refuses a universe smaller than the git index", () => {
  test("benign: an intact tree walks clean, and the index agrees file for file", () => {
    const root = plantRepository({
      "lib/a.ts": "export const a = 1;\n",
      "lib/nested/b.ts": "export const b = 2;\n",
      "lib/c.svelte": "<div></div>\n",
    });
    // The two instruments are both live and both non-empty — without this the
    // green below could mean "nothing was compared".
    const tracked = [...gitTrackedPaths(root)].sort();
    expect(tracked).toEqual(["lib/a.ts", "lib/c.svelte", "lib/nested/b.ts"]);
    expect(walkedUnder(join(root, "lib"))).toEqual(["a.ts", "c.svelte", "nested/b.ts"]);
  });

  test("a tracked file removed from disk is refused, and the message names it", () => {
    const root = plantRepository({
      "lib/a.ts": "export const a = 1;\n",
      "lib/nested/b.ts": "export const b = 2;\n",
    });
    // The benign half FIRST, on this very tree: it walks clean before the
    // perturbation, so the refusal below is caused by the removal and not by
    // anything about a scratch repository.
    expect(walkedUnder(join(root, "lib"))).toEqual(["a.ts", "nested/b.ts"]);

    rmSync(join(root, "lib", "nested"), { recursive: true, force: true });
    expect(() => walk(join(root, "lib"))).toThrowError(/lib\/nested\/b\.ts/u);
    expect(() => walk(join(root, "lib"))).toThrowError(
      /1 tracked file\(s\) were never visited/u,
    );

    // THE REFUSAL IS TYPED AND CARRIES ITS PARTIAL ANSWER, and both halves
    // are load-bearing rather than decorative. A caller that must still say
    // something precise about the files it CAN see reads `found` — that is
    // what the suite's own source-tree fingerprint needed when a bare throw
    // made it blind to the deletion it exists to catch — and `missing` is the
    // finding itself. Asserted here so neither can be quietly dropped.
    let caught: unknown = null;
    try {
      walk(join(root, "lib"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScanUniverseError);
    const refusal = caught as ScanUniverseError;
    expect(refusal.name).toBe("ScanUniverseError");
    expect(refusal.missing).toEqual(["lib/nested/b.ts"]);
    expect(refusal.found.map((f) => f.slice(root.length + 1))).toEqual(["lib/a.ts"]);
  });

  test("an UNSTAGED deletion (present before the first question) is absent, not missing — no `git rm` needed", () => {
    const root = plantRepository({
      "lib/a.ts": "export const a = 1;\n",
      "lib/gone/b.ts": "export const b = 2;\n",
    });
    // Deleted in the working tree only: the index still holds it, and git
    // itself names it deleted. No index operation is needed or made.
    rmSync(join(root, "lib", "gone"), { recursive: true, force: true });
    expect(walkedUnder(join(root, "lib"))).toEqual(["a.ts"]);
    expect(gitTrackedPaths(root).has("lib/gone/b.ts")).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain", "--", "lib/gone/b.ts"], { cwd: root, encoding: "utf8" }))
      .toBe(" D lib/gone/b.ts\n");
    // A deletion AFTER the first question is still a loss the walk refuses
    // (the next test): only the state the run started with is honoured.
  });

  test("a tracked directory named like dependencies or build output is walked — no default name list hides it", () => {
    // The measured class: the walk's old defaults removed `dist` and
    // `node_modules` at every depth, and nobody wrote that sentence at the
    // call site. What the repository does not own now comes only from its
    // versioned ignore rules, which never hide a tracked file.
    const root = plantRepository({
      "lib/a.ts": "export const a = 1;\n",
      "lib/dist/generated.ts": "export const g = 3;\n",
    });
    expect(gitTrackedPaths(root).has("lib/dist/generated.ts")).toBe(true);
    expect(walkedUnder(join(root, "lib"))).toEqual(["a.ts", "dist/generated.ts"]);

    // A caller that SAYS what it is not looking at is believed, because that
    // sentence is in its source where a reader can argue with it.
    expect(walkedUnder(join(root, "lib"), { ignore: ["dist"] })).toEqual(["a.ts"]);
  });

  test("a root that lists its entries but cannot stat them returned [] SILENTLY, and now refuses", () => {
    // DRIVEN, and it corrects a belief worth stating: taking the execute bit
    // off a directory while leaving the read bit does NOT make `walk` throw.
    // `readdirSync` succeeds (it needs read), every `statSync` on a child
    // fails with EACCES (that needs execute), and the per-entry catch — one
    // entry, not the universe — swallows every single one. The root exists and
    // is `realpath`-able, so neither refusal in `walk` fires, and the caller
    // receives `[]` for a directory full of tracked source.
    //
    // Removing the read bit instead is LOUD (`readdirSync` throws EACCES and
    // nothing catches it), which is why this specific permission is the case
    // that mattered.
    // HALF ONE — the collapse itself, measured where no index exists to catch
    // it. This is what every caller received before this change, and it is
    // still exactly what they receive when the tree is not a repository.
    const bare = createTempDir("ch-web-scan-unstattable-");
    mkdirSync(join(bare, "lib", "deep"), { recursive: true });
    writeFileSync(join(bare, "lib", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(bare, "lib", "deep", "b.ts"), "export const b = 2;\n");
    expect(walk(join(bare, "lib")).length).toBe(2);
    chmodSync(join(bare, "lib"), 0o444);
    try {
      // LIVENESS on the perturbation before judging anything: a run as uid 0
      // ignores permission bits, and then there is no collapse to catch. The
      // test states which world it is in instead of asserting a refusal it did
      // not earn.
      const collapsed = walk(join(bare, "lib"));
      if (collapsed.length !== 0) return;
      expect(collapsed).toEqual([]);
    } finally {
      chmodSync(join(bare, "lib"), 0o755);
    }

    // HALF TWO — the identical perturbation inside a repository, where the
    // second instrument exists and disagrees.
    const root = plantRepository({
      "lib/a.ts": "export const a = 1;\n",
      "lib/deep/b.ts": "export const b = 2;\n",
      "lib/deep/c.ts": "export const c = 3;\n",
    });
    expect(walkedUnder(join(root, "lib"))).toEqual(["a.ts", "deep/b.ts", "deep/c.ts"]);
    chmodSync(join(root, "lib"), 0o444);
    try {
      expect(() => walk(join(root, "lib"))).toThrowError(/3 tracked file\(s\) were never visited/u);
      expect(() => walk(join(root, "lib"))).toThrowError(/lib\/deep\/b\.ts/u);
    } finally {
      chmodSync(join(root, "lib"), 0o755);
    }
  });

  test("CONTAINMENT, not a count: the right number with the wrong set is refused", () => {
    // The mutation this pairs with is `found.length >= expected.length`. Here
    // the walk returns exactly as many files as the index holds, and one of
    // them is the wrong file: a tracked source gone from disk, and an
    // untracked scratch file picked up in its place. A quotient cannot see
    // this; containment does.
    const root = plantRepository({
      "lib/a.ts": "export const a = 1;\n",
      "lib/b.ts": "export const b = 3;\n",
    });
    // The index is asked FIRST: the loss happens during the run (a deletion
    // that predates the first question is an unstaged deletion, absent).
    const trackedTs = [...gitTrackedPaths(root)].filter((p) => p.endsWith(".ts"));
    expect(trackedTs.length).toBe(2);
    rmSync(join(root, "lib", "b.ts"));
    writeFileSync(join(root, "lib", "scratch.ts"), "export const s = 4;\n");

    expect(() => walk(join(root, "lib"))).toThrowError(/lib\/b\.ts/u);
    let found: readonly string[] = [];
    try { walk(join(root, "lib")); } catch (error) { found = (error as ScanUniverseError).found; }
    // The counts MATCH — proven, not assumed — so the refusal is about the set.
    expect(found.length).toBe(trackedTs.length);
  });

  test("a DEFAULTED extension set that the index disagrees with is refused", () => {
    // ── THE SECOND REFUSAL `assertIndexCoverage` RAISES, AND IT HAD NO PLANT ─
    //
    // The containment arms above compare the walk against the index FOR THE
    // EXTENSIONS THE CALL ASKED ABOUT, so a whole extension missing from the
    // request is invisible to them by construction: the files are never
    // expected, so they can never be missing. The helper grew a second refusal
    // for exactly that — and this file, whose describe block claims to own
    // "walk() refuses a universe smaller than the git index", never drove it.
    // A guard blind inside its own declared subject is worse than no guard,
    // because green here reads as "both refusals are known to fire".
    const root = plantRepository({
      "lib/a.ts": "export const a = 1;\n",
      "lib/tool.mjs": "export const t = 2;\n",
    });
    expect(gitTrackedPaths(root).has("lib/tool.mjs")).toBe(true);

    let caught: unknown = null;
    try {
      walk(join(root, "lib"));
    } catch (error) {
      caught = error;
    }
    expect(caught, "a bare walk over a root the index disagrees with did not refuse")
      .toBeInstanceOf(ScanUniverseError);
    const refusal = caught as ScanUniverseError;
    // The SPECIFIC refusal, not merely a refusal: the containment arm's message
    // is a different sentence, and asserting only "it threw" would let either
    // one satisfy this test.
    expect(refusal.message).toMatch(/took the DEFAULT extensions/u);
    expect(refusal.message).toMatch(/lib\/tool\.mjs/u);
    expect(refusal.missing).toEqual(["lib/tool.mjs"]);
    // …and it carries the partial answer, like its sibling, so a caller that
    // must still speak about what it CAN see is not left with nothing.
    expect(refusal.found.map((f) => f.slice(root.length + 1))).toEqual(["lib/a.ts"]);

    // ── THE BENIGN COUNTERPARTS: A CALLER THAT DECIDED IS LEFT ALONE ────────
    //
    // Both directions of "naming your extensions is a decision", so the arm
    // above is evidence about the DEFAULT rather than about `.mjs` in general.
    expect(walkedUnder(join(root, "lib"), { exts: SOURCE_EXTS })).toEqual(["a.ts", "tool.mjs"]);
    expect(walkedUnder(join(root, "lib"), { exts: [".ts"] })).toEqual(["a.ts"]);
    // …and a tree the default really does cover stays silent, so the refusal
    // is not simply "a bare walk always throws".
    const clean = plantRepository({ "lib/a.ts": "export const a = 1;\n" });
    expect(walkedUnder(join(clean, "lib"))).toEqual(["a.ts"]);
  });

  test("untracked files are never a refusal — a working tree is allowed to be untidy", () => {
    // The deliberate silence, stated as a test so removing it is a visible
    // change: a walk that finds MORE than the index holds says nothing. The
    // opposite question — a source file the program needs that the index does
    // not hold — has its own owner in tracked-source-owner.test.ts.
    const root = plantRepository({ "lib/a.ts": "export const a = 1;\n" });
    writeFileSync(join(root, "lib", "untracked.ts"), "export const u = 5;\n");
    expect(walkedUnder(join(root, "lib"))).toEqual(["a.ts", "untracked.ts"]);
  });

  test("a root outside any git repository is silent, because the second instrument is absent", () => {
    // Not a refusal: there is no index to disagree with, and a check that
    // invented one would be reporting a fact it did not measure.
    const bare = createTempDir("ch-web-scan-nogit-");
    mkdirSync(join(bare, "lib"), { recursive: true });
    writeFileSync(join(bare, "lib", "a.ts"), "export const a = 1;\n");
    expect(walkedUnder(join(bare, "lib"))).toEqual(["a.ts"]);
  });

  test("the live checkout's own roots are covered, and the coverage is a runtime number", () => {
    // POPULATION: the check is worthless if it never runs against the real
    // tree. These are the roots the suite's own guards scan most, walked
    // through the real entry point, with the index consulted for each.
    const tracked = gitTrackedPaths(process.cwd());
    for (const root of ["src", "server", "shared", "tests"]) {
      const expected = [...tracked].filter(
        (p) => p.startsWith(`${root}/`) && (p.endsWith(".ts") || p.endsWith(".svelte")),
      );
      expect(expected.length).toBeGreaterThan(0);
      const walked = walk(root);
      expect(walked.length).toBeGreaterThanOrEqual(expected.length);
    }
  });

  test("on THIS checkout, every root the default under-covers refuses — and the set is derived", () => {
    // ── WHY THIS ARM EXISTS BESIDE THE ONE ABOVE ────────────────────────────
    //
    // The four roots above are precisely the roots where the default extension
    // set happens to be RIGHT, so no run of that arm can ever reach the second
    // refusal on the live tree. It was the whole of this file's live-population
    // evidence, and it is structurally incapable of touching half its subject.
    //
    // The roots that DO under-cover are derived from the index rather than
    // named, which is the point: a written-down set of them was measured wrong
    // — "engine/src is the only such root" — while the index held nine, and a
    // named set would have gone stale the first time somebody added a `.mjs`
    // anywhere. Nobody has to come back here when that happens.
    const tracked = [...gitTrackedPaths(process.cwd())];
    const DEFAULTED = [".ts", ".svelte"];
    const underCovered = new Set<string>();
    for (const path of tracked) {
      const extension = extname(path);
      if (!SOURCE_EXTS.includes(extension) || DEFAULTED.includes(extension)) continue;
      const segments = path.split("/");
      if (segments.length < 2) continue;
      const root = `${segments[0]}/${segments[1]}`;
      try {
        if (statSync(root).isDirectory()) underCovered.add(root);
      } catch {
        // A two-segment prefix of a root-level file is not a root. The walk
        // below would refuse it for a different reason, which would make this
        // arm's evidence about the wrong refusal.
        continue;
      }
    }
    // LIVENESS BEFORE VERDICT. An empty set would make every assertion below
    // vacuous, and it is the shape this file's own header warns about: the
    // derivation going quiet looks exactly like a clean tree.
    expect(
      underCovered.size,
      `roots where the default extension set under-covers the index: ${[...underCovered].sort().join(", ")}`,
    ).toBeGreaterThan(1);

    for (const root of [...underCovered].sort()) {
      let caught: unknown = null;
      try {
        walk(root);
      } catch (error) {
        caught = error;
      }
      expect(caught, `a bare walk of ${root} did not refuse, though the index disagrees with the default`)
        .toBeInstanceOf(ScanUniverseError);
      expect((caught as ScanUniverseError).message).toMatch(/took the DEFAULT extensions/u);
      // …and the same root, with the extensions NAMED, is clean — so the
      // refusal is about the decision not being made rather than about the
      // root being unwalkable.
      expect(walk(root, { exts: SOURCE_EXTS }).length).toBeGreaterThan(0);
    }
  });
});

describe("walk() enumerates only what the repository owns", () => {
  // THE DEFECT CLASS: the truncation guard read `research/responses-api/**`,
  // gitignored research copies of whole source trees, as production source.
  // The repository's versioned `.gitignore` already declares what it does not
  // own, so the walk prunes those paths at the directory, and a root the
  // repository ignores is refused rather than answered with `[]`.
  function plantWithIgnoredCopy(): string {
    const root = plantRepository({
      ".gitignore": "/research/\n**/*.log\n",
      "lib/a.ts": "export const a = 1;\n",
    });
    mkdirSync(join(root, "research", "copy", "lib"), { recursive: true });
    writeFileSync(join(root, "research", "copy", "lib", "a.ts"), "export const copied = [].slice(0, 20);\n");
    writeFileSync(join(root, "lib", "debug.log"), "noise\n");
    return root;
  }

  test("a gitignored copy under the walked root is pruned, and untracked owned files stay", () => {
    const root = plantWithIgnoredCopy();
    writeFileSync(join(root, "lib", "untracked.ts"), "export const u = 5;\n");
    expect(walkedUnder(root, { exts: [".ts", ".log"] })).toEqual(["lib/a.ts", "lib/untracked.ts"]);
  });

  test("an ignored scan root is refused, and root discovery never offers one", () => {
    const root = plantWithIgnoredCopy();
    expect(() => walk(join(root, "research"))).toThrow(/ignored by the repository's \.gitignore/u);
    expect(repositoryOwnedEntries(root)).toEqual([".gitignore", "lib"]);
  });

  test("a tracked file inside an ignored directory is still walked — the index outranks the ignore rule", () => {
    const root = plantWithIgnoredCopy();
    execFileSync("git", ["add", "-f", "research/copy/lib/a.ts"], { cwd: root, stdio: "pipe" });
    expect(walkedUnder(root)).toEqual(["lib/a.ts", "research/copy/lib/a.ts"]);
  });

  test("on THIS checkout, a whole-repository walk returns no gitignored path", () => {
    // A SECOND INSTRUMENT, not the walk's own listing: `git check-ignore`
    // matches each walked path against the ignore rules independently of the
    // `ls-files` population the walk prunes with.
    const walked = walk(".", { exts: SOURCE_EXTS }).map((file) => file.split("\\").join("/"));
    expect(walked.length).toBeGreaterThan(100);
    const checked = spawnSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "-z", "--stdin"], {
      cwd: process.cwd(), input: `${walked.join("\0")}\0`, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    // Exit 1 means "nothing matched"; anything but 0/1 is a refusal, never a clean answer.
    expect([0, 1]).toContain(checked.status);
    const leaked = checked.stdout.split("\0").filter((entry) => entry.length > 0);
    expect(leaked.slice(0, 10)).toEqual([]);
  });

});
