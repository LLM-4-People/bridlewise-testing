// @vitest-environment node
/**
 * THE TOKEN INDEX MUST ANSWER EXACTLY WHAT THE REGEX ANSWERED.
 *
 * `no-unused-exports.test.ts` used to re-read and re-regex the entire
 * codebase once per candidate export name. Measured in isolation: **15.5s,
 * of which `import` was 15.41s and `tests` was 14ms** — and because vitest
 * orders files by their TEST duration, a file reporting 14ms was sorted to
 * the very end of the run, where 15s of collect-time work had nothing left
 * to overlap with. That tail is what made the suite's wall clock bimodal
 * (~31s vs ~43s) across a 35s budget sitting between the two modes.
 *
 * The rescan is now one pass building a token index (`buildTokenIndex`), and
 * a lookup per name (`referencedElsewhere`). Same question, 36× less work:
 * 15.5s → 428ms.
 *
 * THE OPTIMISATION IS ONLY SAFE IF THE ANSWER IS UNCHANGED, so this file
 * tests the equivalence itself rather than the speed.
 *
 * The claim: JS `\b` is a boundary between `\w = [A-Za-z0-9_]` and non-`\w`,
 * so `\bname\b` matches a text exactly when `name` is one of that text's
 * maximal `[A-Za-z0-9_]` runs — i.e. membership in the token set. Every case
 * below either exercises that equivalence or exercises a case where it does
 * NOT hold and the fallback must take over.
 *
 * THE CASE THAT MOTIVATES THE FALLBACK: `$` is not a `\w` character but IS a
 * legal JS identifier character. `\bfoo$bar\b` therefore matches text that
 * the tokeniser splits into `foo` and `bar`, so a `$`-containing name can
 * never be answered from the index. `isTokenName` is the gate, and a name it
 * rejects goes down the original regex path. There are currently ZERO such
 * exports in the tree (985 candidate names, all pure `\w`), which is exactly
 * why the path needs a test of its own: the corpus does not exercise it, so
 * a regression there would be invisible.
 */
import { describe, expect, test } from "vitest";

import {
  buildTokenIndex,
  isTokenName,
  referencedElsewhere,
  type TokenSites,
} from "../helpers/source-scan.ts";

/** An in-memory corpus: path → contents. Keeps the test off the filesystem. */
type Corpus = Record<string, string>;

function indexOf(corpus: Corpus): {
  index: Map<string, TokenSites>;
  files: string[];
  read: (f: string) => string;
} {
  const files = Object.keys(corpus);
  const read = (f: string): string => corpus[f] ?? "";
  return { index: buildTokenIndex(files, ".", read), files, read };
}

/** The ORIGINAL question, verbatim in shape: does `\bname\b` hit any file
 *  other than `ownRel`? Every equivalence assertion below compares against
 *  this, so the oracle is the regex and not a restatement of the new code. */
function regexReferencedElsewhere(name: string, ownRel: string, corpus: Corpus): boolean {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  for (const [file, text] of Object.entries(corpus)) {
    if (file === ownRel) continue;
    if (re.test(text)) return true;
  }
  return false;
}

function bothAgree(name: string, ownRel: string, corpus: Corpus): { via: boolean; regex: boolean } {
  const { index, files, read } = indexOf(corpus);
  return {
    via: referencedElsewhere(name, ownRel, index, files, ".", read),
    regex: regexReferencedElsewhere(name, ownRel, corpus),
  };
}

describe("the token index answers the same question as the word-boundary regex", () => {
  /**
   * The table is the point: each row is a shape that could plausibly break
   * the tokenise-and-look-up equivalence. `expected` is written down
   * independently so a bug that broke BOTH implementations the same way
   * would still fail — comparing the two against each other alone would
   * pass in that case.
   */
  const CASES: readonly {
    readonly what: string;
    readonly name: string;
    readonly own: string;
    readonly corpus: Corpus;
    readonly expected: boolean;
  }[] = [
    {
      what: "a plain call in another file",
      name: "loadThing",
      own: "a.ts",
      corpus: { "a.ts": "export function loadThing() {}", "b.ts": "loadThing();" },
      expected: true,
    },
    {
      what: "only the declaring file mentions it",
      name: "loadThing",
      own: "a.ts",
      corpus: { "a.ts": "export function loadThing() {}", "b.ts": "somethingElse();" },
      expected: false,
    },
    {
      what: "a member call `mod.name()` still counts as a reference",
      name: "loadThing",
      own: "a.ts",
      corpus: { "a.ts": "export function loadThing() {}", "b.ts": "mod.loadThing();" },
      expected: true,
    },
    {
      what: "a LONGER identifier containing the name is NOT a reference",
      name: "load",
      own: "a.ts",
      corpus: { "a.ts": "export const load = 1;", "b.ts": "loadThing(); preload(); reloaded;" },
      expected: false,
    },
    {
      what: "an underscore neighbour is NOT a boundary (`_` is a \\w char)",
      name: "load",
      own: "a.ts",
      corpus: { "a.ts": "export const load = 1;", "b.ts": "const load_more = 2; const x_load = 3;" },
      expected: false,
    },
    {
      what: "a digit neighbour is NOT a boundary",
      name: "load",
      own: "a.ts",
      corpus: { "a.ts": "export const load = 1;", "b.ts": "load2(); x1load;" },
      expected: false,
    },
    {
      what: "a `$` neighbour IS a boundary (`$` is not a \\w char)",
      name: "load",
      own: "a.ts",
      corpus: { "a.ts": "export const load = 1;", "b.ts": "$load;" },
      expected: true,
    },
    {
      what: "the name at the very start of a file",
      name: "load",
      own: "a.ts",
      corpus: { "a.ts": "export const load = 1;", "b.ts": "load()" },
      expected: true,
    },
    {
      what: "the name at the very end of a file, no trailing newline",
      name: "load",
      own: "a.ts",
      corpus: { "a.ts": "export const load = 1;", "b.ts": "x = load" },
      expected: true,
    },
    {
      what: "many occurrences in ONE non-declaring file still count once, and count",
      name: "load",
      own: "a.ts",
      corpus: { "a.ts": "export const load = 1;", "b.ts": "load;load;load;load;load;" },
      expected: true,
    },
    {
      what: "many occurrences in the DECLARING file only — still dead",
      name: "load",
      own: "a.ts",
      corpus: { "a.ts": "export const load = 1; load; load; load;", "b.ts": "nothing;" },
      expected: false,
    },
    {
      what: "a name nothing anywhere mentions",
      name: "neverWritten",
      own: "a.ts",
      corpus: { "a.ts": "export const other = 1;", "b.ts": "other;" },
      expected: false,
    },
    // ── the fallback path: names the index cannot answer ──
    {
      what: "a `$`-containing name referenced elsewhere (fallback path)",
      name: "use$fixture",
      own: "a.ts",
      corpus: { "a.ts": "export const use$fixture = 1;", "b.ts": "use$fixture();" },
      expected: true,
    },
    {
      what: "a `$`-containing name NOT referenced elsewhere (fallback path)",
      name: "use$fixture",
      own: "a.ts",
      corpus: { "a.ts": "export const use$fixture = 1;", "b.ts": "use(); fixture();" },
      expected: false,
    },
    {
      // ── A PRE-EXISTING LIMITATION, CARRIED OVER DELIBERATELY ──
      //
      // Found by this table, because the expectation was written down
      // independently of both implementations: `true` was asserted here and
      // the REGEX ORACLE — the original code — answered `false`.
      //
      // `\b` is a boundary between a `\w` and a non-`\w`. A name beginning
      // with `$` has a non-`\w` first character, so at the start of a file
      // there is no boundary to match and `\b\$state\b` never fires. (It DOES
      // fire in `x$state`, where the preceding `x` supplies the boundary —
      // verified directly.) So the original scan could never see a reference
      // to a `$`-prefixed export and would report it dead.
      //
      // NOT FIXED HERE, and stated rather than silently inherited. The
      // failure mode is a FALSE POSITIVE — the guard would fail loudly on a
      // live export — not a hole that lets a dead export through, so it is
      // safe to carry. There are zero `$`-prefixed exports in the tree today.
      // The index change is a performance change and must not alter a verdict;
      // this row pins that it does not.
      what: "a leading-`$` name is invisible to `\\b` — pre-existing, preserved",
      name: "$state",
      own: "a.ts",
      corpus: { "a.ts": "export const $state = 1;", "b.ts": "$state.value;" },
      expected: false,
    },
    {
      what: "…but a `$` name with a \\w char before it IS seen (fallback path)",
      name: "$state",
      own: "a.ts",
      corpus: { "a.ts": "export const $state = 1;", "b.ts": "const x$state = 2;" },
      expected: true,
    },
  ];

  for (const c of CASES) {
    test(`${c.what} → ${String(c.expected)}`, () => {
      const { via, regex } = bothAgree(c.name, c.own, c.corpus);
      // The independently written expectation first: this is what stops a
      // shared bug from passing by mutual agreement.
      expect(regex, `the regex oracle disagrees with the written expectation`).toBe(c.expected);
      expect(via, `the token index disagrees with the regex oracle`).toBe(c.expected);
    });
  }
});

describe("the index's own invariants", () => {
  test("only single-\\w-run names may take the index path", () => {
    expect(isTokenName("loadThing")).toBe(true);
    expect(isTokenName("load_thing2")).toBe(true);
    expect(isTokenName("_private")).toBe(true);
    // `$` is a legal JS identifier char and NOT a \w char — the whole reason
    // the fallback exists.
    expect(isTokenName("use$fixture")).toBe(false);
    expect(isTokenName("$state")).toBe(false);
    expect(isTokenName("a.b")).toBe(false);
    expect(isTokenName("")).toBe(false);
  });

  test("a token in three files records two DISTINCT sites, never the same file twice", () => {
    const corpus: Corpus = { "a.ts": "load load load", "b.ts": "load", "c.ts": "load" };
    const { index } = indexOf(corpus);
    const sites = index.get("load");
    expect(sites).toBeDefined();
    expect(sites?.second).not.toBeNull();
    // Two sites, and they must be different files — the cap is "two distinct
    // files", which is what makes `second !== null ⇒ one of them is not the
    // declarer` sound. Recording "a.ts" twice would break that implication.
    expect(sites?.first).not.toBe(sites?.second);
  });

  test("a token that appears many times in ONE file leaves `second` null", () => {
    const { index } = indexOf({ "a.ts": "load; load; load; load;", "b.ts": "other;" });
    expect(index.get("load")?.second).toBeNull();
    expect(index.get("load")?.first).toBe("a.ts");
  });

  test("an absent token is absent, not an empty record", () => {
    const { index } = indexOf({ "a.ts": "load;" });
    expect(index.get("neverWritten")).toBeUndefined();
  });
});
