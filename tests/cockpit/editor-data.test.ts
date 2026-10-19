// @vitest-environment node
/**
 * EDITOR — the pure data the room renders from.
 *
 * The tree's shape and every sentence the room says about a file are decided
 * by functions with no DOM and no network, so they are provable directly.
 * What is being defended here is the honest-data law: a malformed payload
 * becomes ABSENCE, never a partially-guessed list of the user's file names;
 * and every sentence quotes the number that produced it.
 */
import { describe, expect, test } from "vitest";

import {
  ancestorsOf,
  buildRows,
  decodeTree,
  depthOf,
  dirSummary,
  parentOf,
  sortEntries,
  type DirLoad,
  type TreeEntry,
} from "../../src/cockpit/editor/tree.ts";
import {
  binarySentence,
  decodeMedia,
  decodeProbe,
  extensionOf,
  baseNameOf,
  fileSizeText,
  isEditable,
  isLargeRead,
  largeReadSentence,
  renderModeFor,
  renderModeExplanation,
  renderModeLabel,
  tooLargeToEditSentence,
  type FileProbe,
} from "../../src/cockpit/editor/file-kind.ts";
import { LARGE_FILE_BYTES } from "../../src/cockpit/editor/editor-config.ts";

function entry(over: Partial<TreeEntry> & { name: string; relativePath: string }): TreeEntry {
  return {
    path: `/proj/${over.relativePath}`,
    type: "file",
    size: 10,
    extension: null,
    lineCount: null,
    ...over,
  };
}

function probe(over: Partial<FileProbe> = {}): FileProbe {
  return {
    abs: "/proj/src/reader.ts",
    relativePath: "src/reader.ts",
    kind: "file",
    size: 100,
    text: true,
    binaryReason: null,
    mediaType: null,
    language: "typescript",
    maxReadBytes: 1024 * 1024,
    maxEditBytes: 10 * 1024 * 1024,
    ...over,
  };
}

describe("the tree decodes defensively — absence over a guess", () => {
  test("a well-formed payload decodes", () => {
    const wire = { root: "/proj", entryCount: 1, entries: [entry({ name: "a.ts", relativePath: "a.ts" })] };
    expect(decodeTree(wire)?.entries).toHaveLength(1);
  });

  test("a payload with a malformed ENTRY decodes to null — not to the good half", () => {
    const wire = {
      root: "/proj",
      entries: [entry({ name: "a.ts", relativePath: "a.ts" }), { name: 7 }],
    };
    expect(
      decodeTree(wire),
      "showing the entries that happened to parse would be inventing a directory listing",
    ).toBeNull();
  });

  test("an unknown entry TYPE is refused (a file rendered as a folder is a lie)", () => {
    const wire = { root: "/proj", entries: [{ ...entry({ name: "x", relativePath: "x" }), type: "socket" }] };
    expect(decodeTree(wire)).toBeNull();
  });

  test("junk decodes to null", () => {
    for (const junk of [null, 7, "x", {}, { root: "/p" }, { entries: [] }]) {
      expect(decodeTree(junk)).toBeNull();
    }
  });
});

describe("reading order — folders first, then names", () => {
  test("kind wins over name", () => {
    const rows = sortEntries([
      entry({ name: "app.ts", relativePath: "app.ts" }),
      entry({ name: "zebra", relativePath: "zebra", type: "directory" }),
      entry({ name: "Beta.ts", relativePath: "Beta.ts" }),
      entry({ name: "alpha", relativePath: "alpha", type: "directory" }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["alpha", "zebra", "app.ts", "Beta.ts"]);
  });

  test("sorting does not mutate its input", () => {
    const input = [entry({ name: "b", relativePath: "b" }), entry({ name: "a", relativePath: "a" })];
    sortEntries(input);
    expect(input.map((e) => e.name)).toEqual(["b", "a"]);
  });
});

describe("paths", () => {
  test("depth, parent and ancestors", () => {
    expect(depthOf("a.ts")).toBe(0);
    expect(depthOf("src/a.ts")).toBe(1);
    expect(depthOf("src/deep/a.ts")).toBe(2);
    expect(parentOf("a.ts")).toBe("");
    expect(parentOf("src/deep/a.ts")).toBe("src/deep");
    expect(ancestorsOf("src/deep/nested/a.ts")).toEqual(["src", "src/deep", "src/deep/nested"]);
    expect(ancestorsOf("a.ts")).toEqual([]);
  });

  test("names and extensions", () => {
    expect(baseNameOf("/proj/src/a.ts")).toBe("a.ts");
    expect(baseNameOf("a.ts")).toBe("a.ts");
    expect(extensionOf("/proj/src/a.test.ts")).toBe(".ts");
    expect(extensionOf("/proj/Makefile")).toBe("");
    expect(extensionOf("/proj/.gitignore"), "a dotfile has no extension, it IS a name").toBe("");
    expect(extensionOf("/proj/A.MD")).toBe(".md");
  });
});

describe("the rows on screen are a pure function of what was measured", () => {
  const loads = new Map<string, DirLoad>([
    [
      "",
      {
        kind: "read",
        truncated: false,
        entries: [
          entry({ name: "src", relativePath: "src", type: "directory" }),
          entry({ name: "readme.md", relativePath: "readme.md" }),
        ],
      },
    ],
    [
      "src",
      {
        kind: "read",
        truncated: false,
        entries: [entry({ name: "reader.ts", relativePath: "src/reader.ts" })],
      },
    ],
  ]);

  test("a closed folder contributes only itself", () => {
    const rows = buildRows(loads, new Set());
    expect(rows.map((r) => r.entry.name)).toEqual(["src", "readme.md"]);
  });

  test("an open folder contributes its measured children, indented", () => {
    const rows = buildRows(loads, new Set(["src"]));
    expect(rows.map((r) => `${r.depth}:${r.entry.name}`)).toEqual([
      "0:src",
      "1:reader.ts",
      "0:readme.md",
    ]);
  });

  test("an open folder that has NOT been read contributes no children", () => {
    const partial = new Map<string, DirLoad>([["", loads.get("")!]]);
    const rows = buildRows(partial, new Set(["src"]));
    expect(rows.map((r) => r.entry.name), "a guessed child is fabricated data").toEqual([
      "src",
      "readme.md",
    ]);
    expect(rows[0]!.load.kind).toBe("unread");
  });

  test("no root load, no rows", () => {
    expect(buildRows(new Map(), new Set(["src"]))).toEqual([]);
  });

  test("the count line states only what was counted", () => {
    expect(dirSummary([entry({ name: "a", relativePath: "a", type: "directory" })])).toBe("1 folder");
    expect(dirSummary([entry({ name: "a", relativePath: "a" })])).toBe("1 file");
    expect(dirSummary([])).toBe("");
  });
});

describe("what a file IS decides what the room offers", () => {
  test("an image is decided by the SERVER's declared media type, never by us", () => {
    expect(renderModeFor(probe({ mediaType: "image/png", text: false }))).toBe("image");
    // A .png the server did NOT declare is not treated as one.
    expect(renderModeFor(probe({ relativePath: "a.png", mediaType: null, text: false }))).toBe("none");
  });

  test("markdown, pages and patches have rendered forms; source does not", () => {
    expect(renderModeFor(probe({ relativePath: "notes.md" }))).toBe("markdown");
    expect(renderModeFor(probe({ relativePath: "index.html" }))).toBe("page");
    expect(renderModeFor(probe({ relativePath: "fix.patch" }))).toBe("diff");
    expect(renderModeFor(probe({ relativePath: "src/reader.ts" }))).toBe("none");
  });

  test("a binary file has no rendered form at all", () => {
    expect(renderModeFor(probe({ relativePath: "notes.md", text: false }))).toBe("none");
  });

  test("every offered form has plain words and an explanation", () => {
    for (const mode of ["markdown", "page", "image", "diff"] as const) {
      expect(renderModeLabel(mode).length).toBeGreaterThan(0);
      expect(renderModeExplanation(mode).length).toBeGreaterThan(20);
    }
    expect(renderModeLabel("none")).toBe("");
  });

  test("only text within the write cap may be edited", () => {
    expect(isEditable(probe())).toBe(true);
    expect(isEditable(probe({ text: false }))).toBe(false);
    expect(isEditable(probe({ kind: "directory" }))).toBe(false);
    expect(isEditable(probe({ size: 20 * 1024 * 1024 }))).toBe(false);
  });
});

describe("every sentence quotes the number that produced it", () => {
  test("sizes read in the largest unit that keeps them under 1024", () => {
    expect(fileSizeText(0)).toBe("0 bytes");
    expect(fileSizeText(999)).toBe("999 bytes");
    expect(fileSizeText(1024)).toBe("1.0 KB");
    expect(fileSizeText(1024 * 1024)).toBe("1.0 MB");
    expect(fileSizeText(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  test("an unmeasured size says so rather than printing a number", () => {
    expect(fileSizeText(Number.NaN)).toBe("an unmeasured size");
    expect(fileSizeText(-1)).toBe("an unmeasured size");
  });

  test("the large-file gate states the size, the threshold, and the consequence", () => {
    const big = probe({ size: LARGE_FILE_BYTES * 4 });
    expect(isLargeRead(big)).toBe(true);
    const line = largeReadSentence(big);
    expect(line).toContain(fileSizeText(big.size));
    expect(line).toContain(fileSizeText(LARGE_FILE_BYTES));
    expect(line, "…and what pressing the verb will do").toContain("will load");
  });

  test("a file past the READ cap says the rest is not sent", () => {
    const huge = probe({ size: 8 * 1024 * 1024, maxReadBytes: 1024 * 1024 });
    expect(largeReadSentence(huge)).toContain("the rest is not sent");
  });

  test("a file at the threshold is NOT gated (the boundary is stated, not fuzzy)", () => {
    expect(isLargeRead(probe({ size: LARGE_FILE_BYTES }))).toBe(false);
    expect(isLargeRead(probe({ size: LARGE_FILE_BYTES + 1 }))).toBe(true);
  });

  test("the binary sentence carries the SERVER's measured reason", () => {
    const line = binarySentence(
      probe({ text: false, binaryReason: "these bytes contain a zero byte, which text never does", size: 2048 }),
    );
    expect(line).toContain("zero byte");
    expect(line).toContain("2.0 KB");
    expect(line).not.toMatch(/probably|looks like|seems/);
  });

  test("a binary file with no stated reason still says something true", () => {
    expect(binarySentence(probe({ text: false, binaryReason: null }))).toContain("not text");
  });

  test("the too-large-to-edit sentence names both numbers", () => {
    const p = probe({ size: 20 * 1024 * 1024, maxEditBytes: 10 * 1024 * 1024 });
    const line = tooLargeToEditSentence(p);
    expect(line).toContain("20.0 MB");
    expect(line).toContain("10.0 MB");
    expect(line, "…and says what CAN still be done").toContain("read here but not saved");
  });
});

describe("the probe and media wires decode defensively", () => {
  test("a well-formed probe decodes", () => {
    expect(decodeProbe(probe())?.kind).toBe("file");
  });

  test("an unknown KIND is refused", () => {
    expect(decodeProbe({ ...probe(), kind: "device" })).toBeNull();
  });

  test("a missing field is refused rather than defaulted", () => {
    const { size: _size, ...withoutSize } = probe();
    void _size;
    expect(decodeProbe(withoutSize)).toBeNull();
  });

  test("media must be a DATA url — anything else would reach the network", () => {
    const good = { path: "/p/a.png", mediaType: "image/png", size: 4, dataUrl: "data:image/png;base64,AAA" };
    expect(decodeMedia(good)).not.toBeNull();
    expect(
      decodeMedia({ ...good, dataUrl: "https://example.com/a.png" }),
      "an image element handed a URL would fetch it — the room must never do that",
    ).toBeNull();
    expect(decodeMedia({ ...good, dataUrl: "javascript:alert(1)" })).toBeNull();
  });
});
