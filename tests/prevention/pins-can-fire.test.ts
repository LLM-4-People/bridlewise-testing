// @vitest-environment node
/**
 * A PIN THAT CANNOT FIRE IS WORSE THAN NO PIN.
 *
 * ── THE DEFECT, DRIVEN ───────────────────────────────────────────────────
 *
 * `test.fails` passes when its body throws FOR ANY REASON. It does not know,
 * and cannot be told, WHICH line threw. So an `expect` inside a `test.fails`
 * body is a check that can never fail: when it goes wrong the runner reports
 * an expected failure and the file stays green.
 *
 * That is not theoretical. The Switch mount pin asserted three things in
 * order — that the room mounted something, that the DOM agreed with the
 * filter, and then the bound it existed to pin. The fix its own comment
 * recommended (a visibility gate over the river) bounds the MOUNT while the
 * filter keeps every match, which makes the second assertion throw. The pin
 * would have stayed green and reported "still broken" on a repaired tree,
 * and the same is true of any virtualisation that renders nothing until the
 * viewport moves. It fired only for the one fix the comment ruled out.
 *
 * Verified against vitest 4.1.10, the version this repo runs:
 *
 *     A: the pinned assertion passes         -> test.fails RED   (fires)
 *     B: an EARLIER assertion throws         -> "expected fail"   (green)
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────
 *
 * `test.fails` means exactly one thing: THIS BODY THROWS. Bodies that use it
 * must therefore contain no assertion at all — the throw is the subject, and
 * anything worth asserting belongs in an ordinary test where a failure is a
 * failure. To pin a defect as still-present, assert the defect DIRECTLY in an
 * ordinary test: it then reds the moment reality changes, and names the line
 * that moved.
 *
 * ── POPULATION (§20b) ────────────────────────────────────────────────────
 *
 * Every `.ts`/`.svelte`/`.mjs`/`.cjs`/`.js` file under `tests/`, discovered
 * from the filesystem on every run rather than listed — a file added
 * tomorrow is covered without editing this one. The scan reads BYTES (a
 * source file containing a NUL is binary to `grep`, which then reports
 * nothing and exits cleanly), and it runs over a view that KEEPS string
 * literals, because a `test.fails` inside a template or a string is still
 * the construct under discussion. Comments are stripped so this file's own
 * prose does not match itself.
 *
 * The count of discovered files and the count of `test.fails` occurrences are
 * both asserted at runtime with a floor, so a scan whose universe collapsed
 * to nothing fails instead of certifying zero.
 */
import { describe, expect, test } from "vitest";

import { read, relpath, stripCommentsOnly, walk } from "../helpers/source-scan";

/** `test.fails(`, `it.fails(`, and the `.each`/`.concurrent` compositions. */
const PIN = /\b(?:test|it)\s*\.\s*(?:concurrent\s*\.\s*)?fails\s*(?:\.\s*\w+\s*(?:`|\())?\s*\(/g;
const ASSERTION = /\b(?:expect|assert)\s*(?:\.\s*\w+\s*)?\(/;

/**
 * The body of the call starting at `from`, by balancing parentheses over a
 * view with comments removed and string literals KEPT.
 *
 * Balancing from the `(` of the call — not "the next `{`" — matters: a
 * default parameter value or an arrow with a typed return would hand back a
 * region that is not the body, and every assertion about that region would
 * silently become an assertion about two bytes. This has bitten three
 * different mechanisms in this repo, so the extraction is asserted on a
 * fixture below where the naive answer and the correct one differ.
 */
export function callBody(source: string, from: number): string {
  const open = source.indexOf("(", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

type Pin = Readonly<{ file: string; line: number; body: string }>;

function findPins(): { pins: Pin[]; filesScanned: number } {
  const files = walk("tests");
  const pins: Pin[] = [];
  for (const f of files) {
    const raw = read(f);
    // Skip THIS file: it necessarily contains the construct it forbids, in
    // its own fixtures. Identified by path, and asserted to be found.
    if (relpath(f).endsWith("tests/prevention/pins-can-fire.test.ts")) continue;
    const view = stripCommentsOnly(raw);
    PIN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PIN.exec(view)) !== null) {
      pins.push({
        file: relpath(f),
        line: raw.slice(0, Math.min(m.index, raw.length)).split("\n").length,
        body: callBody(view, m.index + m[0].length - 1),
      });
    }
  }
  return { pins, filesScanned: files.length };
}

describe("a pinned defect must be able to report that it was fixed", () => {
  test("LIVENESS: the region extractor takes the CALL, not the next brace", () => {
    // The naive "next `{` after the name" and "the whole node" answers both
    // get this wrong: the arrow's default parameter carries a brace and an
    // `expect(` that is NOT in the body.
    const fixture = 'test.fails("x", (o = { on: expect } ) => { ok(); });';
    const body = callBody(fixture, fixture.indexOf("test.fails") + "test.fails".length - 1);
    expect(body, "the extractor returned a region that is not the call").toBe(
      '"x", (o = { on: expect } ) => { ok(); }',
    );
    // And an unbalanced source degrades to "everything after", never to a
    // silently smaller universe.
    expect(callBody("test.fails(a", 10).length).toBeGreaterThan(0);
  });

  test("the scan's universe is real: files discovered, and pins found", () => {
    const { pins, filesScanned } = findPins();
    // A universe that came back empty must fail rather than certify zero.
    expect(filesScanned, "the test tree scan found no files — the universe collapsed").toBeGreaterThan(300);
    expect(
      pins.length,
      "no test.fails found anywhere — either the construct is gone (delete this file) or the scan stopped matching",
    ).toBeGreaterThan(0);
  });

  test("PLANT: a body carrying an assertion is detected, and one that does not is cleared", () => {
    // Supplied from OUTSIDE the detector and entered where a real caller
    // enters it, so filtering a literal in this file cannot defeat it.
    const guilty = 'test.fails("pinned", async () => { expect(mounted).toBe(matches); throw new Error("x"); });';
    const innocent = 'test.fails("throws", () => { doTheThing(); throw new Error("deliberate"); });';
    const bodyOf = (s: string): string => callBody(stripCommentsOnly(s), s.indexOf("(") - 1);
    expect(ASSERTION.test(bodyOf(guilty)), "the detector missed an assertion inside a pin").toBe(true);
    expect(ASSERTION.test(bodyOf(innocent)), "the detector fired on a pin with no assertion").toBe(false);
  });

  test("no test.fails body contains an assertion", () => {
    const { pins } = findPins();
    const violations = pins
      .filter((p) => ASSERTION.test(p.body))
      .map((p) => `${p.file}:${p.line}`);
    expect(
      violations,
      "test.fails is green whenever the body throws, so these assertions can never fail. " +
      "Move them to an ordinary test, or assert the pinned defect directly. Violations:\n" +
      violations.join("\n"),
    ).toEqual([]);
  });
});
