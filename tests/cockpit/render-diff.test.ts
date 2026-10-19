// @vitest-environment node
/**
 * The unified diff parser (src/cockpit/render/diff.ts).
 *
 * What must hold:
 *   - line numbers come from the patch's own `@@` header and advance by the
 *     standard old/new rules — and are ABSENT, not invented, when the
 *     header cannot be read;
 *   - ± counts are counted from the patch and AGREE with custody's existing
 *     counting owner (the two are pinned together here, so the header
 *     number and the rendered lines can never drift apart);
 *   - intra-line emphasis is claimed only where real prefix/suffix overlap
 *     exists;
 *   - paintDiffLine is a partition — syntax colour plus change emphasis,
 *     with the line's characters unchanged;
 *   - the micro-preview names its remainder instead of truncating silently.
 */
import { describe, expect, test } from "vitest";

import {
  firstHunkOf,
  intralineSegs,
  paintDiffLine,
  parseUnifiedDiff,
} from "../../src/cockpit/render/diff.ts";
import { countPatch } from "../../src/cockpit/rooms/custody-data.ts";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,7 +10,8 @@ export function thing() {",
  " const before = 1;",
  "-  return oldValue;",
  "+  return newValue;",
  "+  // added",
  " const after = 2;",
  "@@ -40,3 +41,3 @@",
  "-removed line",
  "+added line",
  " tail",
  "",
].join("\n");

describe("structure", () => {
  const parsed = parseUnifiedDiff(PATCH);

  test("the file path comes from the patch itself", () => {
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.path).toBe("src/a.ts");
  });

  test("both hunks are found, with their headers verbatim", () => {
    const hunks = parsed.files[0]!.hunks;
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.header).toBe("@@ -10,7 +10,8 @@ export function thing() {");
    expect(hunks[0]!.section).toBe("export function thing() {");
    expect(hunks[1]!.section).toBe("");
  });

  test("index / mode lines are kept as meta, not rendered as content", () => {
    expect(parsed.files[0]!.meta).toContain("index 1111111..2222222 100644");
  });
});

describe("line numbers come from the header and advance correctly", () => {
  const hunk = parseUnifiedDiff(PATCH).files[0]!.hunks[0]!;

  test("the hunk starts where the header says", () => {
    expect(hunk.oldStart).toBe(10);
    expect(hunk.newStart).toBe(10);
  });

  test("context advances both sides; a deletion only the old; an addition only the new", () => {
    expect(hunk.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["context", 10, 10],
      ["del", 11, undefined],
      ["add", undefined, 11],
      ["add", undefined, 12],
      ["context", 12, 13],
    ]);
  });

  test("a malformed header yields NO line numbers rather than invented ones", () => {
    const parsed = parseUnifiedDiff("@@ nonsense @@\n-a\n+b\n");
    // Nothing matched the hunk grammar, so there is no hunk at all.
    expect(parsed.empty).toBe(true);
    expect(parsed.files.flatMap((f) => f.hunks)).toEqual([]);
  });
});

describe("counts are counted, and agree with custody's counting owner", () => {
  test("+/- are counted from the patch body only", () => {
    const parsed = parseUnifiedDiff(PATCH);
    expect(parsed.added).toBe(3);
    expect(parsed.removed).toBe(2);
  });

  test("the render parser and custody's countPatch never disagree", () => {
    // Two owners exist for different reasons (custody counts for its own
    // room; the renderer counts what it lays out). Pinning them together
    // here means a change to either that made them differ fails CI.
    for (const patch of [PATCH, "", "@@ -1 +1 @@\n-a\n+b\n", "no hunks here\n"]) {
      const mine = parseUnifiedDiff(patch);
      const theirs = countPatch(patch);
      expect({ added: mine.added, removed: mine.removed }).toEqual({
        added: theirs.added,
        removed: theirs.removed,
      });
    }
  });

  test("an empty patch is empty, not a zero-hunk fabrication", () => {
    const parsed = parseUnifiedDiff("");
    expect(parsed).toMatchObject({ added: 0, removed: 0, lineCount: 0, empty: true });
    expect(parsed.files).toEqual([]);
  });

  test('"\\ No newline at end of file" is a marker, not a content line', () => {
    const parsed = parseUnifiedDiff("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n");
    const kinds = parsed.files[0]!.hunks[0]!.lines.map((l) => l.kind);
    expect(kinds).toEqual(["del", "add", "marker"]);
    expect(parsed.added).toBe(1);
  });
});

describe("intra-line emphasis is claimed only where overlap is real", () => {
  test("a small edit inside a long line is segmented", () => {
    const segs = intralineSegs("  return oldValue;", "  return newValue;");
    expect(segs.del).toBeDefined();
    expect(segs.del!.map((s) => s.text).join("")).toBe("  return oldValue;");
    expect(segs.add!.map((s) => s.text).join("")).toBe("  return newValue;");
    expect(segs.del!.filter((s) => s.changed).map((s) => s.text)).toEqual(["old"]);
    expect(segs.add!.filter((s) => s.changed).map((s) => s.text)).toEqual(["new"]);
  });

  test("two wholly different lines get NO segments (no coincidental emphasis)", () => {
    expect(intralineSegs("alpha beta gamma", "zeta eta theta")).toEqual({});
  });

  test("identical lines get no segments", () => {
    expect(intralineSegs("same", "same")).toEqual({});
  });

  test("a paired run inside a real patch is segmented in order", () => {
    const hunk = parseUnifiedDiff(PATCH).files[0]!.hunks[0]!;
    const del = hunk.lines.find((l) => l.kind === "del")!;
    expect(del.segs?.filter((s) => s.changed).map((s) => s.text)).toEqual(["old"]);
  });

  test("an unpaired addition gets no segments", () => {
    const hunk = parseUnifiedDiff(PATCH).files[0]!.hunks[0]!;
    const extra = hunk.lines.filter((l) => l.kind === "add")[1]!;
    expect(extra.segs).toBeUndefined();
  });
});

describe("paintDiffLine merges colour and change without altering the line", () => {
  const CASES: readonly (readonly [string, string])[] = [
    ["  return oldValue; // note", "ts"],
    ['{"a": 1}', "json"],
    ["echo \"$x\"", "sh"],
    ["plain text with no grammar", ""],
    ["", "ts"],
    ["\t\tindented", "ts"],
  ];

  for (const [text, lang] of CASES) {
    test(`"${text.slice(0, 24)}" survives painting (${lang || "no lang"})`, () => {
      const plain = paintDiffLine(text, lang);
      expect(plain.map((p) => p.text).join("")).toBe(text);

      const segs = intralineSegs(text, `${text}X`);
      const painted = paintDiffLine(text, lang, segs.del);
      expect(painted.map((p) => p.text).join("")).toBe(text);
    });
  }

  test("segments and tokens are cut at BOTH boundaries", () => {
    const oldText = "const a = 1;";
    const newText = "const b = 1;";
    const segs = intralineSegs(oldText, newText);
    const pieces = paintDiffLine(oldText, "ts", segs.del);
    expect(pieces.map((p) => p.text).join("")).toBe(oldText);
    // The changed run is exactly the differing identifier.
    expect(pieces.filter((p) => p.changed).map((p) => p.text).join("")).toBe("a");
    // And it still carries a syntax role rather than losing its colour.
    expect(pieces.some((p) => p.kind === "keyword")).toBe(true);
  });
});

describe("the micro-preview names its remainder", () => {
  test("the first hunk is previewed and the rest is COUNTED, not dropped", () => {
    const parsed = parseUnifiedDiff(PATCH);
    const { preview, hidden } = firstHunkOf(parsed, 3);
    expect(preview.files[0]!.hunks).toHaveLength(1);
    expect(preview.files[0]!.hunks[0]!.lines).toHaveLength(3);
    // 2 held back in hunk 1, plus the whole 3-line second hunk.
    expect(hidden).toBe(5);
    expect(preview.lineCount + hidden).toBe(parsed.lineCount);
  });

  test("preview counts describe the PREVIEW, not the whole patch", () => {
    const { preview } = firstHunkOf(parseUnifiedDiff(PATCH), 3);
    expect(preview.added).toBe(1);
    expect(preview.removed).toBe(1);
  });

  test("a cap larger than the patch hides nothing", () => {
    const parsed = parseUnifiedDiff(PATCH);
    const { hidden } = firstHunkOf(parsed, 1000);
    // Only the second hunk's lines remain outside the first hunk.
    expect(hidden).toBe(parsed.lineCount - parsed.files[0]!.hunks[0]!.lines.length);
  });
});
