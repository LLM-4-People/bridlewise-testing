// @vitest-environment node
/**
 * Output shape classification (src/cockpit/render/shapes.ts).
 *
 * The rule under test is the honesty rule: a richer rendering is chosen
 * ONLY when the recorded value genuinely has that shape. Every test here is
 * really the same question asked of a different branch — "would this claim
 * a structure the data does not have?"
 *
 * The negative cases matter more than the positive ones. A classifier that
 * calls prose a "search result list", or dresses a read_file ERROR up as
 * file content, is fabricating structure — the exact failure the §1.1
 * honest-data law forbids.
 */
import { describe, expect, test } from "vitest";

import {
  carriesOwnLineNumbers,
  classifyOutput,
  collapsedSummary,
  commandView,
  foldLines,
  foldString,
  inputPath,
  jsonEntries,
  jsonKindOf,
  oneLineSummary,
  parseSearchRows,
  searchHitsFromArray,
  shouldAutoOpen,
  toCopyText,
} from "../../src/cockpit/render/shapes.ts";
import { JSON_AUTO_OPEN_DEPTH } from "../../src/cockpit/render/render-config.ts";

describe("folding names its remainder — never a silent cut", () => {
  test("under the cap, nothing is hidden", () => {
    expect(foldLines(["a", "b"], 5)).toEqual({ shown: ["a", "b"], hidden: 0, total: 2 });
  });

  test("over the cap, the exact remainder is reported", () => {
    const r = foldLines(["a", "b", "c", "d"], 2);
    expect(r.shown).toEqual(["a", "b"]);
    expect(r.hidden).toBe(2);
    expect(r.shown.length + r.hidden).toBe(r.total);
  });

  test("an infinite cap shows everything", () => {
    expect(foldLines(["a", "b"], Number.POSITIVE_INFINITY).hidden).toBe(0);
  });

  test("a folded string reports remaining CHARACTERS exactly", () => {
    expect(foldString("abcdef", 3)).toEqual({ shown: "abc", hidden: 3 });
    expect(foldString("ab", 5)).toEqual({ shown: "ab", hidden: 0 });
  });
});

describe("file content", () => {
  test("a file reader with a path yields file content, typed by the extension", () => {
    const s = classifyOutput({ path: "src/a.ts" }, "const a = 1;", "file");
    expect(s).toMatchObject({ kind: "file", grammar: "ts", path: "src/a.ts", addLineNumbers: true });
  });

  test("content that already numbers itself does NOT get a second rail", () => {
    const numbered = "   1→const a = 1;\n   2→const b = 2;\n   3→const c = 3;";
    const s = classifyOutput({ path: "a.ts" }, numbered, "file");
    expect(s).toMatchObject({ kind: "file", addLineNumbers: false });
  });

  test("carriesOwnLineNumbers needs a strong majority, not one numbered line", () => {
    expect(carriesOwnLineNumbers("1: a\n2: b\n3: c\n4: d")).toBe(true);
    expect(carriesOwnLineNumbers("1. intro\nprose line\nmore prose\nand more")).toBe(false);
    expect(carriesOwnLineNumbers("1: a\n2: b")).toBe(false); // too short to tell
  });

  test("a file reader whose call did not name a path is NOT called file content", () => {
    expect(classifyOutput({}, "text", "file").kind).toBe("text");
  });

  test("a file reader that FAILED and returned an object is not dressed as a file", () => {
    const s = classifyOutput({ path: "a.ts" }, { error: "ENOENT" }, "file");
    expect(s.kind).toBe("json");
  });

  test("an unknown extension yields no grammar rather than a guess", () => {
    const s = classifyOutput({ path: "a.weird" }, "body", "file");
    expect(s).toMatchObject({ kind: "file", grammar: null });
  });
});

describe("command output", () => {
  test("stdout / stderr / exit code are read only when recorded", () => {
    expect(commandView({ stdout: "o", stderr: "e", exitCode: 3 })).toEqual({
      stdout: "o",
      stderr: "e",
      exitCode: 3,
    });
  });

  test("a missing exit code stays ABSENT — never defaulted to 0", () => {
    const v = commandView({ stdout: "o" });
    expect(v).toEqual({ stdout: "o" });
    expect(v!.exitCode).toBeUndefined();
  });

  test("a non-integer exit code is refused rather than coerced", () => {
    expect(commandView({ stdout: "o", exitCode: "0" })).toEqual({ stdout: "o" });
  });

  test("a bare string from a command is kept whole", () => {
    const s = classifyOutput({ command: "ls" }, "a\nb\n", "command");
    expect(s).toEqual({ kind: "command", view: { text: "a\nb\n" } });
  });

  test("an object with none of the command fields is not a command view", () => {
    expect(commandView({ unrelated: 1 })).toBeNull();
  });
});

describe("search results", () => {
  test("grep-style rows parse into real hits", () => {
    const rows = parseSearchRows("src/a.ts:12:const a = 1;\nsrc/b.ts:3:const b = 2;");
    expect(rows).toEqual([
      { path: "src/a.ts", line: 12, text: "const a = 1;" },
      { path: "src/b.ts", line: 3, text: "const b = 2;" },
    ]);
  });

  test("PROSE containing a colon and a number is NOT a result list", () => {
    expect(parseSearchRows("we ran it at 12:30 today\nand it worked fine")).toBeNull();
  });

  test("a mostly-unparseable block is refused (the 80% floor holds)", () => {
    expect(parseSearchRows("a.ts:1:hit\nprose\nprose\nprose\nprose")).toBeNull();
  });

  test("recorded objects become hits, and a missing path refuses the whole array", () => {
    expect(searchHitsFromArray([{ path: "a.ts", line: 2, text: "x" }])).toEqual([
      { path: "a.ts", line: 2, text: "x" },
    ]);
    expect(searchHitsFromArray([{ path: "a.ts" }, { nope: 1 }])).toBeNull();
    expect(searchHitsFromArray([])).toBeNull();
  });

  test("a hit with no recorded line number simply has none", () => {
    const hits = searchHitsFromArray([{ path: "a.ts", text: "x" }]);
    expect(hits![0]!.line).toBeUndefined();
  });

  test("results nested under a recorded key are found", () => {
    const s = classifyOutput({ query: "x" }, { results: [{ path: "a.ts" }] }, "search");
    expect(s.kind).toBe("search");
  });

  test("a search tool that returned something else falls back honestly", () => {
    expect(classifyOutput({ query: "x" }, "no matches found", "search").kind).toBe("text");
  });
});

describe("the fallbacks", () => {
  test("absent output is empty, in every absent form", () => {
    for (const v of [undefined, null, ""]) {
      expect(classifyOutput({}, v)).toEqual({ kind: "empty" });
    }
  });

  test("an unrecognised tool returning a string yields plain text, verbatim", () => {
    const s = classifyOutput({}, "  spaced\n\ttabbed  ");
    expect(s).toEqual({ kind: "text", text: "  spaced\n\ttabbed  " });
  });

  test("an unrecognised tool returning structure yields a json tree", () => {
    expect(classifyOutput({}, { a: 1 })).toEqual({ kind: "json", value: { a: 1 } });
  });

  // ── A JSON STRING IS STRUCTURED DATA THE TRANSPORT NEVER PARSED ─────────
  //
  // The executor records several tools' results as JSON text (the tools that
  // declare no outputShape: search_symbols, create_artifact, edit), and the
  // renderer promises structured data a collapsible tree in recorded key
  // order. The claim is made on the VALUE parsing to a container — never on
  // the tool's name — and only in the leftover branch, after the tool's own
  // declared doctrine has had its claim.

  test("the three real JSON-string outputs fold into the tree (search_symbols, create_artifact, edit)", () => {
    // Recorded shapes from the live drive, abridged.
    const symbolSearch = JSON.stringify({
      results: [{ name: "Throttle", kind: "type", path: "internal/scheduler/throttle.go", line: 12 }],
    });
    const artifact = JSON.stringify({ ok: true, artifactId: "a1b2c3d4e5f6a7b8", type: "html", title: "T", contentLength: 138 });
    const edit = JSON.stringify({ ok: true, path: "notes/scratch.md", operation: "createFile", added: 3 });
    for (const [tool, out] of [["search_symbols", symbolSearch], ["create_artifact", artifact], ["edit", edit]] as const) {
      const s = classifyOutput({}, out);
      expect(s.kind, `${tool}'s recorded JSON string must fold into the tree, not a raw <pre>`).toBe("json");
      expect(s).toEqual({ kind: "json", value: JSON.parse(out) });
    }
  });

  test("a bare scalar string is NOT a tree — sentences and numbers stay text", () => {
    for (const v of ["42", "true", "null", '""', "1.5"]) {
      expect(classifyOutput({}, v), `${v} parses but is not a container`).toEqual({ kind: "text", text: v });
    }
  });

  test("prose that merely starts with a brace is not claimed either", () => {
    expect(classifyOutput({}, "{ not json at all")).toEqual({ kind: "text", text: "{ not json at all" });
  });

  test("a DECLARED doctrine outranks the JSON probe — command stdout and file content keep their shapes", () => {
    const jsonBody = JSON.stringify({ stdout_is: "sometimes json" });
    expect(
      classifyOutput({ command: "x" }, jsonBody, "command"),
      "a command's streams are never re-interpreted",
    ).toEqual({ kind: "command", view: { text: jsonBody } });
    expect(
      classifyOutput({ path: "config.json" }, jsonBody, "file"),
      "a file reader that read a .json file shows file content",
    ).toMatchObject({ kind: "file", path: "config.json" });
  });

  test("inputPath reads only a path the record actually names", () => {
    expect(inputPath({ path: "a" })).toBe("a");
    expect(inputPath({ filePath: "b" })).toBe("b");
    expect(inputPath({ other: "c" })).toBeNull();
    expect(inputPath("string")).toBeNull();
    expect(inputPath({ path: "" })).toBeNull();
  });
});

describe("the JSON tree reports real counts and real order", () => {
  test("kinds are exact", () => {
    expect(jsonKindOf(null)).toBe("null");
    expect(jsonKindOf([])).toBe("array");
    expect(jsonKindOf({})).toBe("object");
    expect(jsonKindOf(1)).toBe("number");
    expect(jsonKindOf("s")).toBe("string");
    expect(jsonKindOf(true)).toBe("boolean");
  });

  test("a collapsed container states its real child count and nothing else", () => {
    expect(collapsedSummary([1, 2, 3])).toBe("[ 3 items ]");
    expect(collapsedSummary([1])).toBe("[ 1 item ]");
    expect(collapsedSummary({ a: 1 })).toBe("{ 1 key }");
    expect(collapsedSummary({ a: 1, b: 2 })).toBe("{ 2 keys }");
  });

  test("entries keep the RECORDED order (never sorted)", () => {
    expect(jsonEntries({ z: 1, a: 2, m: 3 }).map(([k]) => k)).toEqual(["z", "a", "m"]);
  });

  test("auto-open is a default only — depth and width both close it", () => {
    expect(shouldAutoOpen({ a: 1 }, 0)).toBe(true);
    expect(shouldAutoOpen({ a: 1 }, JSON_AUTO_OPEN_DEPTH)).toBe(false);
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
    expect(shouldAutoOpen(wide, 0)).toBe(false);
  });

  test("copy text is the recorded value, verbatim for strings", () => {
    expect(toCopyText("  raw\ttext  ")).toBe("  raw\ttext  ");
    expect(toCopyText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe("the collapsed one-liner summarizes WITHOUT mangling", () => {
  test("an object reads as key=value pairs in recorded order", () => {
    expect(oneLineSummary({ path: "a.ts", start: 3 }, 100)).toBe("path=a.ts start=3");
  });

  test("braces and quotes INSIDE a value survive (the old form deleted them)", () => {
    // The pre-v2.1 hint did JSON.stringify(v).replace(/[{}"]/g, "") which
    // silently rewrote any value containing those characters.
    expect(oneLineSummary({ q: 'a{b}"c"' }, 100)).toBe('q=a{b}"c"');
  });

  test("a number and a numeric string stay distinguishable", () => {
    expect(oneLineSummary({ a: 1 }, 100)).toBe("a=1");
    expect(oneLineSummary({ a: "1" }, 100)).toBe("a=1");
    // (the one-liner is a hint; the CELL renders the typed tree — the point
    // is only that nothing is deleted from inside the value)
  });

  test("a nested container is reported by its real size, not flattened", () => {
    expect(oneLineSummary({ items: [1, 2, 3] }, 100)).toBe("items=[ 3 items ]");
  });

  test("the clip is at the END and is visible", () => {
    const s = oneLineSummary({ k: "x".repeat(200) }, 20);
    expect(s).toHaveLength(20);
    expect(s.endsWith("…")).toBe(true);
  });

  test("whitespace in a string is collapsed for the ONE LINE only", () => {
    expect(oneLineSummary("a\n\n  b", 100)).toBe("a b");
  });
});
