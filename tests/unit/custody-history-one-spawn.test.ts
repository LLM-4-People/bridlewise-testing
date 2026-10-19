// @vitest-environment node
/**
 * Custody history reads a whole page of commits in ONE git invocation.
 * (DESIGN-PERFORMANCE §1 L1 / §6 item 7.)
 *
 * ── The defect ──
 *
 * `custody.history` mapped over its log and ran `git show --numstat
 * --format= <hash>` per commit. With `CUSTODY_HISTORY_DEFAULT = 20` that is
 * ~24 sequential blocking `spawnSync` calls, each paying git's ~30-50ms
 * process startup, all on the event loop. It is the demonstrated cause of
 * head-of-line blocking: `/api/health` measures p50 1.31ms and max 4,814ms
 * with one heavy custody read in flight — every SSE token and keystroke
 * acknowledgement queued behind a git scan.
 *
 * Getting the scan OFF the event loop is the async facade's work. Making it
 * two spawns instead of twenty-four is this one's, and it is the reason the
 * count is what this test measures rather than the wall time: a wall time on
 * one machine decays, an invocation count does not.
 *
 * ── What is verified ──
 *
 * A1 the invocation count is ONE, whatever the number of commits (the
 *    property; a per-commit loop makes it N).
 * A2 the numbers are still git's own, per commit — a batched read that got
 *    the attribution wrong would be worse than a slow correct one.
 * A3 a commit with no numstat (a merge) maps to an empty list, exactly as
 *    `git show --numstat` reported for it — an absence, never a guess.
 * A4 a hash git does not answer for keeps its stated empty entry rather than
 *    vanishing from the map.
 * A5 no commits → no invocation at all.
 * A6 a failed invocation yields stated empties, never a partial guess.
 *
 * ── Mutation-verified ──
 * Reverting to one `git show` per commit makes A1 and A6 FAIL (20 invocations,
 * and a per-commit failure is no longer one stated outcome).
 */
import { describe, test, expect } from "vitest";

import { commitFilesByHash } from "../../server/blocks/custody.ts";

const RS = "\u001e"; // record separator, written as an escape (never a raw byte in source)

/** A fake git that records every invocation and answers `git log --numstat`. */
function fakeGit(perCommit: ReadonlyMap<string, string>): {
  run: (args: readonly string[]) => string | null;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push([...args]);
      const hashes = args.filter((a) => !a.startsWith("-") && a !== "log");
      return hashes
        .filter((h) => perCommit.has(h))
        .map((h) => `${RS}${h}\n${perCommit.get(h)!}`)
        .join("\n");
    },
  };
}

describe("custody history: one git invocation for a whole page of commits", () => {
  test("A1 twenty commits cost ONE invocation, not twenty", () => {
    const hashes = Array.from({ length: 20 }, (_, i) => `hash${String(i).padStart(2, "0")}`);
    const per = new Map(hashes.map((h) => [h, `3\t1\tsrc/${h}.ts`] as const));
    const git = fakeGit(per);
    commitFilesByHash("/repo", hashes, git.run);
    expect(
      git.calls.length,
      "a per-commit `git show` loop is ~24 sequential blocking spawns for one read",
    ).toBe(1);
    expect(git.calls[0]![0]).toBe("log");
    expect(git.calls[0], "every hash must be named in the single call").toEqual(
      expect.arrayContaining(hashes),
    );
  });

  test("A2 each commit keeps its OWN measured numbers", () => {
    const per = new Map([
      ["aaa", "3\t1\tsrc/a.ts\n0\t7\tsrc/b.ts"],
      ["bbb", "12\t0\tREADME.md"],
      ["ccc", "-\t-\tlogo.png"], // binary: real change, no line counts
    ]);
    const git = fakeGit(per);
    const out = commitFilesByHash("/repo", ["aaa", "bbb", "ccc"], git.run);
    expect(out.get("aaa")).toEqual([
      { path: "src/a.ts", insertions: 3, deletions: 1 },
      { path: "src/b.ts", insertions: 0, deletions: 7 },
    ]);
    expect(out.get("bbb")).toEqual([{ path: "README.md", insertions: 12, deletions: 0 }]);
    expect(out.get("ccc"), "a binary file's change is real; its line counts are not").toEqual([
      { path: "logo.png", insertions: 0, deletions: 0 },
    ]);
  });

  test("A3 a commit with no numstat (a merge) is an empty list, not a guess", () => {
    const git = fakeGit(new Map([["merge1", ""], ["aaa", "1\t0\tx.ts"]]));
    const out = commitFilesByHash("/repo", ["merge1", "aaa"], git.run);
    expect(out.get("merge1")).toEqual([]);
    expect(out.get("aaa")).toEqual([{ path: "x.ts", insertions: 1, deletions: 0 }]);
  });

  test("A4 a hash git does not answer for keeps its stated empty entry", () => {
    const git = fakeGit(new Map([["aaa", "1\t0\tx.ts"]]));
    const out = commitFilesByHash("/repo", ["aaa", "unknown"], git.run);
    expect(
      out.has("unknown"),
      "a commit dropped from the map would render as a save with no files at all, " +
        "which is a claim; an empty list is the honest unmeasured answer",
    ).toBe(true);
    expect(out.get("unknown")).toEqual([]);
  });

  test("A5 no commits means no invocation", () => {
    const git = fakeGit(new Map());
    expect(commitFilesByHash("/repo", [], git.run).size).toBe(0);
    expect(git.calls).toHaveLength(0);
  });

  test("A6 a failed invocation yields stated empties, never a partial guess", () => {
    const calls: string[][] = [];
    const out = commitFilesByHash("/repo", ["aaa", "bbb"], (args) => {
      calls.push([...args]);
      return null;
    });
    expect(calls).toHaveLength(1);
    expect(out.get("aaa")).toEqual([]);
    expect(out.get("bbb")).toEqual([]);
  });
});
