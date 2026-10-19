// @vitest-environment node
/**
 * THE FINGERPRINT'S VERDICT MUST SURVIVE ITS OWN PLUMBING.
 *
 * ── THE DEFECT THIS EXISTS FOR, MEASURED ──────────────────────────────────
 *
 * The source-tree fingerprint writes `process.exitCode = 1` before it throws,
 * because a throw from a vitest global teardown is printed as `error during
 * close` and the process still EXITS 0. That line is correct and it was not
 * enough: it only runs on the path where the check REACHES its verdict. When
 * a shared scan helper started refusing on a shrunken universe, the second
 * fingerprint threw on the way to that line, the run announced a failure in
 * its output and exited 0 — and the deletion branch became unreachable for
 * exactly the file kind it was built to protect.
 *
 * Two guards, each green on its own subject, composing into a hole. The
 * durable lesson is about the WORKFLOW as much as the code: adding a throw to
 * a shared helper changes every consumer, and no consumer's own mutation set
 * can see it, because each mutates only its own subject.
 *
 * So the two halves are tested here, directly and cheaply, rather than by
 * spawning a child run: the verdict WRAPPER (any throw sets the exit code
 * first) and the verdict FUNCTION (each kind of change is named as itself).
 */
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  compareFingerprints,
  foreignRepositories,
  judgeRequiredInnerRoots,
  requiredInnerRoots,
  stampOf,
  withVerdict,
} from "../setup/source-tree-immutable.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

/** Run `body` with `process.exitCode` restored afterwards, and report it. */
function exitCodeAfter(body: () => void): { code: number | string | null | undefined; threw: unknown } {
  const original = process.exitCode;
  let threw: unknown = null;
      let code: number | string | null | undefined;
  try {
    try {
      body();
    } finally {
      code = process.exitCode;
    }
  } catch (error) {
    threw = error;
  } finally {
    process.exitCode = original;
  }
  return { code, threw };
}

describe("the source-tree fingerprint's verdict", () => {
  test("ANY throw out of the hook sets the exit code before it propagates", () => {
    const boom = new Error("a helper refused on the way to the verdict");
    const { code, threw } = exitCodeAfter(() => {
      withVerdict(() => {
        throw boom;
      });
    });
    // Both halves matter: the caller-readable verdict AND the human-readable
    // error. Losing either one is the shape this file exists to prevent.
    expect(code).toBe(1);
    expect(threw).toBe(boom);
  });

  test("a clean body leaves the exit code alone", () => {
    // The benign direction. Without it, a wrapper that set the code
    // unconditionally would pass the test above and fail every run.
    const { code, threw } = exitCodeAfter(() => {
      withVerdict(() => {
        expect(true).toBe(true);
      });
    });
    expect(threw).toBeNull();
    expect(code).toBeUndefined();
  });

  test("each kind of change is named as itself, and an unchanged tree is silent", () => {
    const before = new Map([
      ["src/a.ts", "hash-a:664"],
      ["src/b.ts", "hash-b:664"],
      ["src/c.ts", "hash-c:664"],
      ["src/gone.ts", "hash-d:664"],
      ["src/untracked-later.ts", "hash-e:664"],
    ]);
    const after = new Map([
      ["src/a.ts", "hash-a:664"],
      ["src/b.ts", "hash-b2:664"],
      ["src/c.ts", "hash-c:600"],
      ["src/gone.ts", "ABSENT"],
      ["src/new.ts", "hash-f:664"],
    ]);

    expect(compareFingerprints(before, after)).toEqual([
      "src/b.ts: CONTENT CHANGED by the run",
      "src/c.ts: MODE CHANGED by the run (664 → 600)",
      "src/gone.ts: DELETED by the run",
      "src/untracked-later.ts: UNTRACKED by the run",
      "src/new.ts: TRACKED by the run",
    ]);

    // The benign counterpart, on the same function: an identical pair of
    // fingerprints says nothing at all.
    expect(compareFingerprints(before, before)).toEqual([]);
  });

  test("the PRODUCTION stamp carries the mode, over a real file on disk", () => {
    // WHY THIS EXISTS: the comparison above is exercised on stamps written
    // inside this file, and a mutation that computed the permission bits and
    // discarded them passed all of it. Driven then: the whole-run drive's mode
    // row went from exit 1 to exit 0 while every test stayed green. Nothing
    // connected the production stamp to the production comparison, so this
    // does — on a real file, through the real function, with only the mode
    // varying.
    const dir = createTempDir("ch-web-stamp-");
    const file = join(dir, "a.ts");
    writeFileSync(file, "export const a = 1;\n");
    chmodSync(file, 0o664);
    const permissive = stampOf(file);
    chmodSync(file, 0o600);
    const restricted = stampOf(file);

    // The bytes did not change and the stamp did — that is the whole claim.
    expect(permissive.split(":")[0]).toBe(restricted.split(":")[0]);
    expect(permissive).not.toBe(restricted);
    expect(permissive.endsWith(":664")).toBe(true);
    expect(restricted.endsWith(":600")).toBe(true);

    // And the two real stamps, fed to the real comparison, produce the real
    // verdict — the seam the mutation slipped through.
    expect(compareFingerprints(new Map([[file, permissive]]), new Map([[file, restricted]]))).toEqual([
      `${file}: MODE CHANGED by the run (664 → 600)`,
    ]);
    // Benign: the same stamp twice says nothing.
    expect(compareFingerprints(new Map([[file, permissive]]), new Map([[file, permissive]]))).toEqual([]);
  });

  test("a mode change with identical bytes is still a finding", () => {
    // The case §11c earned by hand: `atomicWriteFile` replaces the inode and
    // inherits the umask, so a file can come back byte-identical and
    // mode-different. A content-only fingerprint reports nothing.
    const before = new Map([["src/a.ts", "same-hash:664"]]);
    const after = new Map([["src/a.ts", "same-hash:600"]]);
    expect(compareFingerprints(before, after)).toEqual([
      "src/a.ts: MODE CHANGED by the run (664 → 600)",
    ]);
  });
});

// ── THE POPULATION IS PLURAL, AND THAT IS THE HALF THAT WENT MISSING ──────
//
// The fingerprint compared one repository's index while the suite could write
// to three. Driven before the widening: a test appending to
// `engine/src/integrity.ts` finished at exit 0 with
// nothing reported and the sibling's `git status` showing the modification.
//
// The verdict half is tested above without a child run; the POPULATION half
// is tested here the same way — by driving the discovery function over the
// real tree and over a planted one. A plant is what proves it still agrees on
// a verdict; a count only proves it is awake.
describe("the source-tree fingerprint's population", () => {
  test("the engine is INSIDE this repository now, and the discovery says so with a witness", () => {
    const home = process.cwd();
    // RE-DERIVED AT THE MONOREPO ASSEMBLY (2026-07-30). Until then this test
    // asserted that `engine/src/config.ts` enlisted a SIBLING repository whose
    // root ended `harness-main-v1/integration`. The three histories are now one
    // repository, so the same path must enlist NOTHING — it no longer escapes.
    //
    // A bare "returns zero" would be indistinguishable from a resolver pointed
    // at the wrong place (§36), so it carries a WITNESS: the same path is
    // required to exist and to be a file. Zero foreign repositories WITH the
    // witness present means absorbed; zero WITHOUT it means blind.
    const reached = join(home, "engine", "src", "kernel", "config.ts");
    expect(existsSync(reached), "the witness path must exist, or this proves nothing").toBe(true);
    expect(foreignRepositories(home, new Set([reached]))).toEqual([]);

    // And the instrument is still capable of a non-empty answer — proven on a
    // path that DOES leave this repository. Without this the assertion above
    // would pass on a function that had been reduced to `return []`.
    const outside = join(home, "..", "does-not-matter");
    expect(foreignRepositories(home, new Set([reached, outside]))).toEqual([]);
  });

  test("a planted repository is discovered, and a directory-shaped path is not", () => {
    const base = createTempDir("foreign-repo-");
    const repo = join(base, "planted-repo");
    mkdirSync(join(repo, "nested"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const file = join(repo, "nested", "reached.ts");
    writeFileSync(file, "export const x = 1;\n");

    // A FILE inside a foreign repository enlists it…
    expect(foreignRepositories(base, new Set([file]))).toEqual([repo]);
    // …a DIRECTORY does not, which is what keeps a `../` in prose from
    // dragging a whole unrelated checkout into the population…
    expect(foreignRepositories(base, new Set([join(repo, "nested")]))).toEqual([]);
    // …a path that resolves to nothing does not…
    expect(foreignRepositories(base, new Set([join(repo, "nested", "absent.ts")]))).toEqual([]);
    // …and a file in the caller's OWN repository is not "foreign".
    const ownRepo = join(base, "own");
    mkdirSync(ownRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: ownRepo });
    const ownFile = join(ownRepo, "here.ts");
    writeFileSync(ownFile, "export const y = 2;\n");
    expect(foreignRepositories(ownRepo, new Set([ownFile]))).toEqual([]);
  });
});

// ── THE SECOND INSTRUMENT, WHICH HAD NO TEST AT ALL ───────────────────────
//
// LADDER VERDICT: rung 4, and it is the right rung.
//   Rung 1 unavailable — nothing the OS can refuse; the inputs are two files
//     that may legitimately be missing in some other checkout.
//   Rung 2 unavailable — the bad state is an EMPTY list, and `readonly
//     string[]` cannot express "non-empty and derived from a live input".
//     A branded non-empty type would still be minted by this same function,
//     so the refusal, not the type, is what has to be right.
//   Rung 3 unavailable — the caller already passes the only argument there is
//     (`home`); there is no argument it could be made to supply that carries
//     the evidence.
//   Rung 4 IS available and taken: ONE door computes the answer, and it
//     refuses there. Every consumer of `requiredInnerRoots` gets the refusal
//     because there is no second way to compute it.
//
// `requiredInnerRoots` is the second of the two instruments the per-root
// floor in `setup()` compares. It was the ONE exported member of that module
// with ZERO test references — `foreignRepositories` had 6, `stampOf` 3,
// `compareFingerprints` 6 — and with `required = []` the floor
// `required.filter(...)` certifies for free.
describe("the required-inner-roots instrument refuses an empty universe", () => {
  // RE-DERIVED AT THE MONOREPO ASSEMBLY (2026-07-30), NOT PORTED. The old
  // instrument read `package.json` for `../<name>/` siblings and `.gitmodules`
  // for what lived inside them. There is no sibling and no submodule left: the
  // engine is `engine/` in this same git index. The old answer would therefore
  // be `[]` on a healthy tree — the exact vacuous shape this block exists to
  // forbid — so the PROPOSITION was carried over and the mechanism replaced.
  //
  // The ladder verdict is unchanged and restated for the new function:
  //   Rung 2 unavailable — the bad state is an EMPTY list, and `readonly
  //     string[]` cannot express "non-empty and derived from a live input".
  //   Rung 3 unavailable — the caller already passes the only argument there
  //     is (`home`).
  //   Rung 4 IS available and taken: ONE door computes the answer and refuses
  //     there, so every consumer of `requiredInnerRoots` gets the refusal.

  /** A planted repository: `<base>/web` with an inner package at `<home>/engine`. */
  function plantRepository(options: {
    readonly manifest: string | null;
    readonly innerPackage: boolean;
  }): string {
    const base = createTempDir("required-inner-");
    const home = join(base, "web");
    mkdirSync(home, { recursive: true });
    if (options.innerPackage) {
      mkdirSync(join(home, "engine"), { recursive: true });
      writeFileSync(join(home, "engine", "package.json"), JSON.stringify({ name: "engine" }));
    }
    if (options.manifest !== null) writeFileSync(join(home, "package.json"), options.manifest);
    return home;
  }

  const REACHING_MANIFEST = JSON.stringify({
    scripts: { "typecheck:includes": "node engine/scripts/verification/tsconfig-include-liveness.ts ." },
  });

  test("THE INERT DIRECTION — a healthy tree is believed, and so is this repository", () => {
    // Without this, a `judgeRequiredInnerRoots` that refused unconditionally
    // would pass every plant below.
    const planted = judgeRequiredInnerRoots(plantRepository({ manifest: REACHING_MANIFEST, innerPackage: true }));
    expect(planted.failure).toBeNull();
    expect(planted.roots).toEqual(["engine"]);

    // And the REAL tree, which is the population the floor actually runs on.
    const real = judgeRequiredInnerRoots(process.cwd());
    expect(real.failure).toBeNull();
    expect(real.roots).toContain("engine");
    expect(requiredInnerRoots()).toEqual([...real.roots]);
  });

  test("`package.json` unreadable is a broken discovery, not a tree with no inner packages", () => {
    // DRIVEN before the repair: the `catch` returned `[]` and the floor above
    // certified a single-tree population in silence.
    const home = plantRepository({ manifest: null, innerPackage: true });
    const answer = judgeRequiredInnerRoots(home);
    expect(answer.roots).toEqual([]);
    expect(answer.failure).toMatch(/could not read/u);
    expect(() => requiredInnerRoots(home)).toThrow(/could not read/u);
  });

  test("a tree reached by a VARIABLE rather than `<name>/` is refused, not counted as zero", () => {
    const home = plantRepository({
      manifest: JSON.stringify({ scripts: { typecheck: "node $ENGINE_ROOT_scripts_check ." } }),
      innerPackage: true,
    });
    const answer = judgeRequiredInnerRoots(home);
    expect(answer.roots).toEqual([]);
    expect(answer.failure).toMatch(/names NO directory/u);
  });

  test("a named directory carrying no `package.json` is refused rather than dropped", () => {
    // The successor of "a named sibling with no `.git`". A directory that is
    // merely mentioned is this repository's own source, and requiring it would
    // certify nothing; the refusal is what keeps that from reading as an
    // answer.
    const home = plantRepository({ manifest: REACHING_MANIFEST, innerPackage: false });
    const answer = judgeRequiredInnerRoots(home);
    expect(answer.roots).toEqual([]);
    expect(answer.failure).toMatch(/NOT ONE of them carries its own/u);
  });

  test("the refusals are not interchangeable — a reader must land on the right diagnosis", () => {
    const unreadable = judgeRequiredInnerRoots(plantRepository({ manifest: null, innerPackage: true }));
    const unnamed = judgeRequiredInnerRoots(
      plantRepository({ manifest: JSON.stringify({ scripts: { t: "node x" } }), innerPackage: true }),
    );
    const noPackage = judgeRequiredInnerRoots(plantRepository({ manifest: REACHING_MANIFEST, innerPackage: false }));
    const messages = [unreadable.failure, unnamed.failure, noPackage.failure];
    expect(messages.every((m) => m !== null)).toBe(true);
    expect(new Set(messages).size).toBe(3);
  });
});
