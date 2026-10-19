import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";

import { InputError } from "../src/kernel/errors.ts";
import {
  createUtf8OffsetMap,
  isUtf8Boundary,
  utf8ByteLengthFromMap,
  utf8ByteOffset,
  utf8ByteOffsetFromMap,
  utf8ByteSpan,
  utf8ByteSpanFromMap,
  utf16OffsetFromUtf8Byte,
  type ByteSpan,
} from "../src/text/utf8-offsets.ts";

const INVALID_BOUNDARY = 0xffffffff;

// ---------------------------------------------------------------------------
// Helper: well-formed reference strings and their UTF-8 byte lengths
// ---------------------------------------------------------------------------

interface RefCase {
  readonly name: string;
  readonly text: string;
}

const REF_CASES: readonly RefCase[] = [
  { name: "empty", text: "" },
  { name: "ascii-a", text: "a" },
  { name: "ascii-word", text: "hello" },
  { name: "latin-é", text: "é" },
  { name: "latin-café", text: "café" },
  { name: "latin-façade", text: "façade" },
  { name: "latin-naïve", text: "naïve" },
  { name: "cjk-一", text: "一" },
  { name: "cjk-mixed", text: "a一b" },
  { name: "cjk-sentence", text: "日本語テスト" },
  { name: "greek-omega", text: "Ω" },
  { name: "check-mark", text: "✓" },
  { name: "combining-é-decomposed", text: "e\u0301" },
  { name: "combining-mixed", text: "e\u0301b" },
  { name: "tab-newline", text: "a\tb\nc" },
  { name: "digits", text: "12345" },
  { name: "punctuation", text: "a, b; c: d" },
  { name: "zwj-not-surrogate", text: "a\u200db" },
  { name: "cr-lf", text: "\r\n" },
  { name: "astral-math-p", text: "\u{1D4DF}" },
  { name: "astral-emoji", text: "😀" },
  { name: "astral-emoji-family", text: "👨\u200d👩\u200d👧" },
  { name: "astral-mixed", text: "a😀b" },
  { name: "astral-math-bold-a", text: "\u{1D400}" },
  { name: "astral-cjk-ext-b", text: "\u{20000}" },
  { name: "mixed-all", text: "aéΩ𝕏b" },
  { name: "aéb", text: "aéb" },
  { name: "crlf-end", text: "abc\r\n" },
  { name: "combining-end", text: "a\u0301" },
];

// ---------------------------------------------------------------------------
// Section 1: utf8ByteOffset — BMP and astral boundary correctness
// ---------------------------------------------------------------------------

test("utf8ByteOffset: every boundary of every reference string matches Buffer.byteLength", () => {
  for (const { name, text } of REF_CASES) {
    const totalBytes = Buffer.byteLength(text, "utf8");
    for (let offset = 0; offset <= text.length; offset += 1) {
      let actual: number;
      try {
        actual = utf8ByteOffset(text, offset);
      } catch {
        continue; // split-surrogate or lone-surrogate boundary — utility correctly throws
      }
      const expected = Buffer.byteLength(text.slice(0, offset), "utf8");
      assert.equal(actual, expected, `${name} offset=${offset} expected=${expected} actual=${actual}`);
    }
    assert.equal(utf8ByteOffset(text, text.length), totalBytes, `${name} total bytes`);
  }
});

// ---------------------------------------------------------------------------
// Section 2: utf8ByteOffset — negative sentinel
// ---------------------------------------------------------------------------

test("utf8ByteOffset: negative safe-integer offsets return -1 sentinel", () => {
  for (const n of [-1, -2, -3, -100, -1000, -2147483648]) {
    assert.equal(utf8ByteOffset("abc", n), -1, `negative ${n} should return -1`);
    assert.equal(utf8ByteOffset("", n), -1, `negative ${n} on empty string should return -1`);
    assert.equal(utf8ByteOffset("😀", n), -1, `negative ${n} on astral should return -1`);
  }
});

test("utf8ByteOffset: Number(node.start?? -1) pattern returns -1 for null/undefined start", () => {
  const nullStart: number | null = null;
  const undefinedStart: number | undefined = undefined;
  assert.equal(utf8ByteOffset("abc", Number(nullStart ?? -1)), -1);
  assert.equal(utf8ByteOffset("abc", Number(undefinedStart ?? -1)), -1);
});

// ---------------------------------------------------------------------------
// Section 3: utf8ByteOffset — non-integer rejection
// ---------------------------------------------------------------------------

test("utf8ByteOffset: non-safe-integer offsets throw not_integer", () => {
  const badValues: unknown[] = [NaN, Infinity, -Infinity, 1.5, 2.5, 0.1, -0.1, "1", true];
  for (const v of badValues) {
    assert.throws(() => utf8ByteOffset("abc", v as number), /not_integer/);
  }
});

test("utf8ByteOffset: -Infinity throws not_integer before the negative check", () => {
  assert.throws(() => utf8ByteOffset("abc", -Infinity), /not_integer/);
});

// ---------------------------------------------------------------------------
// Section 4: utf8ByteOffset — out-of-range rejection
// ---------------------------------------------------------------------------

test("utf8ByteOffset: offset > source.length throws out_of_range", () => {
  for (const { text } of REF_CASES) {
    assert.throws(() => utf8ByteOffset(text, text.length + 1), /out_of_range/);
    assert.throws(() => utf8ByteOffset(text, text.length + 100), /out_of_range/);
  }
});

// ---------------------------------------------------------------------------
// Section 5: utf8ByteOffset — non-string source rejection
// ---------------------------------------------------------------------------

test("utf8ByteOffset: non-string source throws not_string", () => {
  const badSources: unknown[] = [123, null, undefined, true, {}, [], Symbol("x")];
  for (const s of badSources) {
    assert.throws(() => utf8ByteOffset(s as string, 0), /not_string/);
  }
});

// ---------------------------------------------------------------------------
// Section 6: utf8ByteOffset — split-surrogate rejection
// ---------------------------------------------------------------------------

test("utf8ByteOffset: offset splitting a surrogate pair throws splits_surrogate_pair", () => {
  const astralCases = ["😀", "𝕏", "\u{20000}", "\u{1D4DF}", "a😀b", "x𝕏y"];
  for (const text of astralCases) {
    for (let i = 0; i < text.length - 1; i += 1) {
      if (text.charCodeAt(i) >= 0xd800 && text.charCodeAt(i) <= 0xdbff &&
          text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
        const splitOffset = i + 1;
        assert.throws(
          () => utf8ByteOffset(text, splitOffset),
          /splits_surrogate_pair/,
          `${text} offset=${splitOffset} should throw splits_surrogate_pair`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Section 7: utf8ByteOffset — lone-surrogate rejection
// ---------------------------------------------------------------------------

test("utf8ByteOffset: offset after a lone high surrogate throws lone_surrogate", () => {
  const loneHigh = "a\u{D800}b";
  assert.throws(() => utf8ByteOffset(loneHigh, 2), /lone_surrogate/);
  const loneHighEnd = "a\u{D800}";
  assert.throws(() => utf8ByteOffset(loneHighEnd, 2), /lone_surrogate/);
  const loneHighStart = "\u{D800}a";
  assert.throws(() => utf8ByteOffset(loneHighStart, 1), /lone_surrogate/);
  const onlyLoneHigh = "\u{D800}";
  assert.throws(() => utf8ByteOffset(onlyLoneHigh, 1), /lone_surrogate/);
});

test("utf8ByteOffset: offset after a lone low surrogate throws lone_surrogate", () => {
  const loneLow = "a\u{DC00}b";
  assert.throws(() => utf8ByteOffset(loneLow, 2), /lone_surrogate/);
  const loneLowEnd = "a\u{DC00}";
  assert.throws(() => utf8ByteOffset(loneLowEnd, 2), /lone_surrogate/);
  const loneLowStart = "\u{DC00}a";
  assert.throws(() => utf8ByteOffset(loneLowStart, 1), /lone_surrogate/);
  const onlyLoneLow = "\u{DC00}";
  assert.throws(() => utf8ByteOffset(onlyLoneLow, 1), /lone_surrogate/);
});

test("utf8ByteOffset: offset at a lone surrogate position (before it) is valid", () => {
  assert.equal(utf8ByteOffset("a\u{D800}b", 1), 1);
  assert.equal(utf8ByteOffset("a\u{DC00}b", 1), 1);
  assert.equal(utf8ByteOffset("\u{D800}b", 0), 0);
  assert.equal(utf8ByteOffset("\u{DC00}b", 0), 0);
  assert.equal(utf8ByteOffset("a\u{D800}b", 3), 5);
  assert.equal(utf8ByteOffset("a\u{DC00}b", 3), 5);
});

// ---------------------------------------------------------------------------
// Section 8: utf8ByteOffset — error type is InputError
// ---------------------------------------------------------------------------

test("utf8ByteOffset: all errors are InputError instances", () => {
  assert.throws(() => utf8ByteOffset(123 as unknown as string, 0), (e: unknown) => e instanceof InputError);
  assert.throws(() => utf8ByteOffset("abc", NaN), (e: unknown) => e instanceof InputError);
  assert.throws(() => utf8ByteOffset("abc", 4), (e: unknown) => e instanceof InputError);
  assert.throws(() => utf8ByteOffset("😀", 1), (e: unknown) => e instanceof InputError);
  assert.throws(() => utf8ByteOffset("\u{D800}a", 1), (e: unknown) => e instanceof InputError);
});

// ---------------------------------------------------------------------------
// Section 9: utf8ByteSpan — valid spans
// ---------------------------------------------------------------------------

test("utf8ByteSpan: valid spans match Buffer.byteLength of the slice", () => {
  for (const { name, text } of REF_CASES) {
    for (let start = 0; start <= text.length; start += 1) {
      for (let end = start; end <= text.length; end += 1) {
        let span: ByteSpan;
        try {
          span = utf8ByteSpan(text, start, end);
        } catch {
          continue; // split-surrogate or lone-surrogate boundary — utility correctly throws
        }
        const expectedStart = Buffer.byteLength(text.slice(0, start), "utf8");
        const expectedEnd = Buffer.byteLength(text.slice(0, end), "utf8");
        assert.equal(span.startByte, expectedStart, `${name} span [${start},${end}) startByte`);
        assert.equal(span.endByte, expectedEnd, `${name} span [${start},${end}) endByte`);
      }
    }
  }
});

test("utf8ByteSpan: returns a frozen ByteSpan object", () => {
  const span = utf8ByteSpan("abc", 0, 3);
  assert.equal(Object.isFrozen(span), true);
  assert.equal(span.startByte, 0);
  assert.equal(span.endByte, 3);
});

// ---------------------------------------------------------------------------
// Section 10: utf8ByteSpan — error cases
// ---------------------------------------------------------------------------

test("utf8ByteSpan: inverted range throws inverted", () => {
  assert.throws(() => utf8ByteSpan("abc", 2, 1), /inverted/);
  assert.throws(() => utf8ByteSpan("abc", 3, 0), /inverted/);
  assert.throws(() => utf8ByteSpan("😀", 2, 0), /inverted/);
});

test("utf8ByteSpan: negative endpoints throw offset_negative", () => {
  assert.throws(() => utf8ByteSpan("abc", -1, 2), /offset_negative/);
  assert.throws(() => utf8ByteSpan("abc", 0, -1), /offset_negative/);
  assert.throws(() => utf8ByteSpan("abc", -1, -1), /offset_negative/);
});

test("utf8ByteSpan: end > source.length throws end_out_of_range", () => {
  assert.throws(() => utf8ByteSpan("abc", 0, 4), /end_out_of_range/);
  assert.throws(() => utf8ByteSpan("abc", 0, 100), /end_out_of_range/);
});

test("utf8ByteSpan: split-surrogate endpoints throw", () => {
  assert.throws(() => utf8ByteSpan("😀", 0, 1), /splits_surrogate_pair/);
  assert.throws(() => utf8ByteSpan("😀", 1, 2), /splits_surrogate_pair/);
  assert.throws(() => utf8ByteSpan("a😀b", 1, 2), /splits_surrogate_pair/);
});

test("utf8ByteSpan: lone-surrogate endpoints throw", () => {
  assert.throws(() => utf8ByteSpan("a\u{D800}b", 0, 2), /lone_surrogate/);
  assert.throws(() => utf8ByteSpan("a\u{D800}b", 2, 3), /lone_surrogate/);
});

test("utf8ByteSpan: non-integer endpoints throw not_integer", () => {
  assert.throws(() => utf8ByteSpan("abc", 0.5, 2), /not_integer/);
  assert.throws(() => utf8ByteSpan("abc", 0, NaN), /not_integer/);
  assert.throws(() => utf8ByteSpan("abc", Infinity, 2), /not_integer/);
});

test("utf8ByteSpan: non-string source throws not_string", () => {
  assert.throws(() => utf8ByteSpan(123 as unknown as string, 0, 1), /not_string/);
  assert.throws(() => utf8ByteSpan(null as unknown as string, 0, 1), /not_string/);
});

// ---------------------------------------------------------------------------
// Section 11: createUtf8OffsetMap — well-formed strings
// ---------------------------------------------------------------------------

test("createUtf8OffsetMap: every valid position matches Buffer.byteLength for well-formed strings", () => {
  for (const { name, text } of REF_CASES) {
    const map = createUtf8OffsetMap(text);
    assert.equal(map.length, text.length + 1, `${name} map length`);
    for (let i = 0; i <= text.length; i += 1) {
      const mapVal = map[i] as number;
      if (mapVal === INVALID_BOUNDARY) continue;
      const expected = Buffer.byteLength(text.slice(0, i), "utf8");
      assert.equal(mapVal, expected, `${name} map[${i}] expected=${expected}`);
    }
    const total = utf8ByteLengthFromMap(map);
    assert.equal(total, Buffer.byteLength(text, "utf8"), `${name} total from map`);
  }
});

test("createUtf8OffsetMap: empty string produces [0]", () => {
  const map = createUtf8OffsetMap("");
  assert.equal(map.length, 1);
  assert.equal(map[0], 0);
  assert.equal(utf8ByteLengthFromMap(map), 0);
});

// ---------------------------------------------------------------------------
// Section 12: createUtf8OffsetMap — split-pair positions marked INVALID
// ---------------------------------------------------------------------------

test("createUtf8OffsetMap: surrogate pair split positions are marked INVALID_BOUNDARY", () => {
  const astralCases = [
    { text: "😀", splitAt: 1 },
    { text: "𝕏", splitAt: 1 },
    { text: "\u{20000}", splitAt: 1 },
    { text: "a😀b", splitAt: 2 },
    { text: "x𝕏y", splitAt: 2 },
    { text: "aéΩ𝕏b", splitAt: 4 },
  ];
  for (const { text, splitAt } of astralCases) {
    const map = createUtf8OffsetMap(text);
    assert.equal(map[splitAt], INVALID_BOUNDARY, `${text} map[${splitAt}] should be INVALID`);
  }
});

test("createUtf8OffsetMap: non-split positions adjacent to pairs are valid", () => {
  const map = createUtf8OffsetMap("a😀b");
  assert.notEqual(map[0], INVALID_BOUNDARY);
  assert.notEqual(map[1], INVALID_BOUNDARY);
  assert.equal(map[2], INVALID_BOUNDARY); // split
  assert.notEqual(map[3], INVALID_BOUNDARY);
  assert.notEqual(map[4], INVALID_BOUNDARY);
});

// ---------------------------------------------------------------------------
// Section 13: createUtf8OffsetMap — lone-surrogate positions marked INVALID
// ---------------------------------------------------------------------------

test("createUtf8OffsetMap: position after a lone high surrogate is marked INVALID", () => {
  const map = createUtf8OffsetMap("a\u{D800}b");
  assert.notEqual(map[0], INVALID_BOUNDARY);
  assert.notEqual(map[1], INVALID_BOUNDARY);
  assert.equal(map[2], INVALID_BOUNDARY); // after lone high surrogate
  assert.notEqual(map[3], INVALID_BOUNDARY); // after 'b' (valid end)
});

test("createUtf8OffsetMap: position after a lone low surrogate is marked INVALID", () => {
  const map = createUtf8OffsetMap("a\u{DC00}b");
  assert.notEqual(map[0], INVALID_BOUNDARY);
  assert.notEqual(map[1], INVALID_BOUNDARY);
  assert.equal(map[2], INVALID_BOUNDARY); // after lone low surrogate
  assert.notEqual(map[3], INVALID_BOUNDARY);
});

test("createUtf8OffsetMap: string ending with a lone surrogate marks map[length] INVALID", () => {
  const map1 = createUtf8OffsetMap("\u{D800}");
  assert.equal(map1[1], INVALID_BOUNDARY);
  assert.throws(() => utf8ByteLengthFromMap(map1), /invalid_boundary/);

  const map2 = createUtf8OffsetMap("a\u{D800}");
  assert.equal(map2[2], INVALID_BOUNDARY);
  assert.throws(() => utf8ByteLengthFromMap(map2), /invalid_boundary/);

  const map3 = createUtf8OffsetMap("\u{DC00}");
  assert.equal(map3[1], INVALID_BOUNDARY);
  assert.throws(() => utf8ByteLengthFromMap(map3), /invalid_boundary/);
});

// ---------------------------------------------------------------------------
// Section 14: utf8ByteOffsetFromMap — O(1) lookup
// ---------------------------------------------------------------------------

test("utf8ByteOffsetFromMap: valid lookups match utf8ByteOffset for well-formed strings", () => {
  for (const { name, text } of REF_CASES) {
    const map = createUtf8OffsetMap(text);
    for (let i = 0; i <= text.length; i += 1) {
      const mapVal = map[i] as number;
      if (mapVal === INVALID_BOUNDARY) {
        assert.throws(() => utf8ByteOffsetFromMap(map, i), /invalid_boundary/, `${name} map[${i}]`);
      } else {
        assert.equal(utf8ByteOffsetFromMap(map, i), utf8ByteOffset(text, i), `${name} map[${i}]`);
      }
    }
  }
});

test("utf8ByteOffsetFromMap: out-of-range offset throws", () => {
  const map = createUtf8OffsetMap("abc");
  assert.throws(() => utf8ByteOffsetFromMap(map, -1), /out_of_range/);
  assert.throws(() => utf8ByteOffsetFromMap(map, 4), /out_of_range/);
  assert.throws(() => utf8ByteOffsetFromMap(map, 100), /out_of_range/);
  assert.throws(() => utf8ByteOffsetFromMap(map, NaN), /out_of_range/);
});

// ---------------------------------------------------------------------------
// Section 15: utf8ByteSpanFromMap — O(1) span lookup
// ---------------------------------------------------------------------------

test("utf8ByteSpanFromMap: valid spans match utf8ByteSpan for well-formed strings", () => {
  for (const { name, text } of REF_CASES) {
    const map = createUtf8OffsetMap(text);
    for (let start = 0; start <= text.length; start += 1) {
      for (let end = start; end <= text.length; end += 1) {
        const startVal = map[start] as number;
        const endVal = map[end] as number;
        if (startVal === INVALID_BOUNDARY || endVal === INVALID_BOUNDARY) continue;
        const spanMap = utf8ByteSpanFromMap(map, start, end);
        const spanDirect = utf8ByteSpan(text, start, end);
        assert.deepEqual(spanMap, spanDirect, `${name} span [${start},${end})`);
      }
    }
  }
});

test("utf8ByteSpanFromMap: inverted range throws", () => {
  const map = createUtf8OffsetMap("abc");
  assert.throws(() => utf8ByteSpanFromMap(map, 2, 1), /inverted/);
  assert.throws(() => utf8ByteSpanFromMap(map, 3, 0), /inverted/);
});

test("utf8ByteSpanFromMap: invalid boundary throws", () => {
  const map = createUtf8OffsetMap("a😀b");
  assert.throws(() => utf8ByteOffsetFromMap(map, 2), /invalid_boundary/);
  assert.throws(() => utf8ByteSpanFromMap(map, 2, 3), /invalid_boundary/);
  assert.throws(() => utf8ByteSpanFromMap(map, 0, 2), /invalid_boundary/);
});

// ---------------------------------------------------------------------------
// Section 16: utf8ByteLengthFromMap
// ---------------------------------------------------------------------------

test("utf8ByteLengthFromMap: total byte length matches Buffer.byteLength for well-formed strings", () => {
  for (const { name, text } of REF_CASES) {
    const map = createUtf8OffsetMap(text);
    assert.equal(utf8ByteLengthFromMap(map), Buffer.byteLength(text, "utf8"), `${name}`);
  }
});

// ---------------------------------------------------------------------------
// Section 17: Large hostile string consistency
// ---------------------------------------------------------------------------

test("createUtf8OffsetMap + utf8ByteOffset consistency on large hostile string", () => {
  const hostile = "çafé_𝕏_Ω_" + "x".repeat(1000) + "_ééé_𝕏𝕏😀";
  const map = createUtf8OffsetMap(hostile);
  for (let i = 0; i <= hostile.length; i += 1) {
    const mapVal = map[i] as number;
    if (mapVal === INVALID_BOUNDARY) continue;
    assert.equal(mapVal, Buffer.byteLength(hostile.slice(0, i), "utf8"), `map@${i}`);
  }
  assert.equal(utf8ByteLengthFromMap(map), Buffer.byteLength(hostile, "utf8"));
});

// ---------------------------------------------------------------------------
// Section 18: Contract test — sole canonical ownership
// ---------------------------------------------------------------------------

test("contract: scripts/verification/source-byte-offset.ts must not exist", () => {
  assert.equal(
    existsSync("scripts/verification/source-byte-offset.ts"),
    false,
    "The duplicate utility scripts/verification/source-byte-offset.ts must not exist; src/text/utf8-offsets.ts is the sole canonical owner.",
  );
});

test("contract: no file imports from source-byte-offset.ts", () => {
  const result = execSync(
    "grep -rl 'source-byte-offset' --include='*.ts' --include='*.mjs' --include='*.mts' src/ scripts/ verification/ 2>/dev/null || true",
    { encoding: "utf8", cwd: process.cwd() },
  );
  assert.equal(result.trim(), "", "No source or verification file should import from source-byte-offset.ts:\n" + result);
});

test("contract: src/text/utf8-offsets.ts is the sole exporter of utf8ByteOffset", () => {
  const result = execSync(
    "grep -rl 'export function utf8ByteOffset' --include='*.ts' src/ 2>/dev/null || true",
    { encoding: "utf8", cwd: process.cwd() },
  );
  const files = result.trim().split("\n").filter((f) => f.length > 0);
  assert.equal(files.length, 1, "Exactly one file should export utf8ByteOffset: " + files.join(", "));
  assert.equal(files[0], "src/text/utf8-offsets.ts", "Sole exporter must be src/text/utf8-offsets.ts");
});

test("contract: occurrence-selectors.ts imports from the canonical utility", () => {
  const result = execSync(
    "grep 'utf8-offsets' scripts/verification/authority/occurrence-selectors.ts",
    { encoding: "utf8", cwd: process.cwd() },
  );
  assert.ok(result.includes("src/text/utf8-offsets.ts"), "occurrence-selectors.ts must import from src/text/utf8-offsets.ts");
});

test("contract: candidate-adapters.mjs imports from the canonical utility", () => {
  const result = execSync(
    "grep 'utf8-offsets' verification/benchmarks/secret-spans/candidate-adapters.mjs",
    { encoding: "utf8", cwd: process.cwd() },
  );
  assert.ok(result.includes("src/text/utf8-offsets.ts"), "candidate-adapters.mjs must import from src/text/utf8-offsets.ts");
});

test("contract: no local byteOffset function using naive Buffer.byteLength(slice) in source files", () => {
  const result = execSync(
    "grep -rn 'function byteOffset' --include='*.mjs' --include='*.ts' verification/ src/ scripts/ 2>/dev/null || true",
    { encoding: "utf8", cwd: process.cwd() },
  );
  assert.equal(result.trim(), "", "No local byteOffset function should exist in source/verification files:\n" + result);
});

// ---------------------------------------------------------------------------
// Section 19: isUtf8Boundary — pure predicate
// ---------------------------------------------------------------------------

test("isUtf8Boundary: returns true for byte offset 0 on every reference string", () => {
  for (const { name, text } of REF_CASES) {
    assert.equal(isUtf8Boundary(text, 0), true, `${name} @0`);
  }
});

test("isUtf8Boundary: returns true for total byte length on every reference string", () => {
  for (const { name, text } of REF_CASES) {
    const total = Buffer.byteLength(text, "utf8");
    assert.equal(isUtf8Boundary(text, total), true, `${name} @total`);
  }
});

test("isUtf8Boundary: matches createUtf8OffsetMap valid boundaries for a multibyte string", () => {
  const text = "aé一😀b";
  const map = createUtf8OffsetMap(text);
  const total = Buffer.byteLength(text, "utf8");
  const validByteOffsets = new Set<number>();
  for (let i = 0; i <= text.length; i += 1) {
    const v = map[i] as number;
    if (v !== INVALID_BOUNDARY) validByteOffsets.add(v);
  }
  for (let b = 0; b <= total; b += 1) {
    assert.equal(isUtf8Boundary(text, b), validByteOffsets.has(b), `@${b}`);
  }
});

test("isUtf8Boundary: returns false inside a multi-byte Latin-1 sequence", () => {
  assert.equal(isUtf8Boundary("é", 1), false);
  assert.equal(isUtf8Boundary("café", 4), false);
});

test("isUtf8Boundary: returns false inside a 3-byte CJK sequence", () => {
  assert.equal(isUtf8Boundary("一", 1), false);
  assert.equal(isUtf8Boundary("一", 2), false);
  assert.equal(isUtf8Boundary("a一b", 2), false);
});

test("isUtf8Boundary: returns false inside a 4-byte astral sequence (surrogate-pair split)", () => {
  assert.equal(isUtf8Boundary("😀", 1), false);
  assert.equal(isUtf8Boundary("😀", 2), false);
  assert.equal(isUtf8Boundary("😀", 3), false);
  assert.equal(isUtf8Boundary("a😀b", 2), false);
  assert.equal(isUtf8Boundary("a😀b", 3), false);
  assert.equal(isUtf8Boundary("a😀b", 4), false);
});

test("isUtf8Boundary: returns true at astral code-point boundaries", () => {
  assert.equal(isUtf8Boundary("😀", 0), true);
  assert.equal(isUtf8Boundary("😀", 4), true);
  assert.equal(isUtf8Boundary("a😀b", 0), true);
  assert.equal(isUtf8Boundary("a😀b", 1), true);
  assert.equal(isUtf8Boundary("a😀b", 5), true);
  assert.equal(isUtf8Boundary("a😀b", 6), true);
});

test("isUtf8Boundary: returns false for negative, non-integer, and out-of-range offsets", () => {
  assert.equal(isUtf8Boundary("abc", -1), false);
  assert.equal(isUtf8Boundary("abc", 1.5), false);
  assert.equal(isUtf8Boundary("abc", NaN), false);
  assert.equal(isUtf8Boundary("abc", Infinity), false);
  assert.equal(isUtf8Boundary("abc", 4), false);
  assert.equal(isUtf8Boundary("abc", 100), false);
});

test("isUtf8Boundary: returns false for non-string source without throwing", () => {
  assert.equal(isUtf8Boundary(undefined as unknown as string, 0), false);
  assert.equal(isUtf8Boundary(null as unknown as string, 0), false);
  assert.equal(isUtf8Boundary(123 as unknown as string, 0), false);
});

test("isUtf8Boundary: empty string only accepts byte offset 0", () => {
  assert.equal(isUtf8Boundary("", 0), true);
  assert.equal(isUtf8Boundary("", 1), false);
});

test("isUtf8Boundary: is consistent with utf16OffsetFromUtf8Byte across a hostile string", () => {
  const hostile = "çafé_𝕏_Ω_" + "x".repeat(200) + "_ééé_𝕏𝕏😀";
  const total = Buffer.byteLength(hostile, "utf8");
  for (let b = 0; b <= total; b += 1) {
    const boundary = isUtf8Boundary(hostile, b);
    if (boundary) {
      assert.doesNotThrow(() => utf16OffsetFromUtf8Byte(hostile, b), `@${b}`);
    } else {
      assert.throws(() => utf16OffsetFromUtf8Byte(hostile, b), InputError, `@${b}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Section 20: utf16OffsetFromUtf8Byte — strict reverse converter
// ---------------------------------------------------------------------------

test("utf16OffsetFromUtf8Byte: returns 0 for byte offset 0 on every reference string", () => {
  for (const { name, text } of REF_CASES) {
    assert.equal(utf16OffsetFromUtf8Byte(text, 0), 0, `${name} @0`);
  }
});

test("utf16OffsetFromUtf8Byte: returns source.length for total byte length on every reference string", () => {
  for (const { name, text } of REF_CASES) {
    const total = Buffer.byteLength(text, "utf8");
    assert.equal(utf16OffsetFromUtf8Byte(text, total), text.length, `${name} @total`);
  }
});

test("utf16OffsetFromUtf8Byte: round-trips against utf8ByteOffset for ascii-word", () => {
  const text = "hello";
  for (let i = 0; i <= text.length; i += 1) {
    const byteOff = utf8ByteOffset(text, i);
    assert.equal(utf16OffsetFromUtf8Byte(text, byteOff), i, `utf16@${i}`);
  }
});

test("utf16OffsetFromUtf8Byte: round-trips against utf8ByteOffset across all reference strings", () => {
  for (const { name, text } of REF_CASES) {
    const map = createUtf8OffsetMap(text);
    for (let i = 0; i <= text.length; i += 1) {
      const mapVal = map[i] as number;
      if (mapVal === INVALID_BOUNDARY) continue;
      const byteOff = utf8ByteOffset(text, i);
      assert.ok(byteOff >= 0, `${name} byteOff@${i}`);
      assert.equal(utf16OffsetFromUtf8Byte(text, byteOff), i, `${name} utf16@${i}`);
    }
  }
});

test("utf16OffsetFromUtf8Byte: round-trips against the precomputed map across a hostile string", () => {
  const hostile = "çafé_𝕏_Ω_" + "x".repeat(500) + "_ééé_𝕏𝕏😀";
  const map = createUtf8OffsetMap(hostile);
  for (let i = 0; i <= hostile.length; i += 1) {
    const mapVal = map[i] as number;
    if (mapVal === INVALID_BOUNDARY) continue;
    assert.equal(utf16OffsetFromUtf8Byte(hostile, mapVal), i, `map@${i}`);
  }
});

test("utf16OffsetFromUtf8Byte: locates astral code-point boundaries", () => {
  assert.equal(utf16OffsetFromUtf8Byte("a😀b", 0), 0);
  assert.equal(utf16OffsetFromUtf8Byte("a😀b", 1), 1);
  assert.equal(utf16OffsetFromUtf8Byte("a😀b", 5), 3);
  assert.equal(utf16OffsetFromUtf8Byte("a😀b", 6), 4);
});

test("utf16OffsetFromUtf8Byte: locates CJK and Latin-1 boundaries", () => {
  assert.equal(utf16OffsetFromUtf8Byte("café", 0), 0);
  assert.equal(utf16OffsetFromUtf8Byte("café", 1), 1);
  assert.equal(utf16OffsetFromUtf8Byte("café", 2), 2);
  assert.equal(utf16OffsetFromUtf8Byte("café", 3), 3);
  assert.equal(utf16OffsetFromUtf8Byte("café", 5), 4);
  assert.equal(utf16OffsetFromUtf8Byte("a一b", 0), 0);
  assert.equal(utf16OffsetFromUtf8Byte("a一b", 1), 1);
  assert.equal(utf16OffsetFromUtf8Byte("a一b", 4), 2);
  assert.equal(utf16OffsetFromUtf8Byte("a一b", 5), 3);
});

test("utf16OffsetFromUtf8Byte: throws InputError inside a multi-byte sequence", () => {
  assert.throws(() => utf16OffsetFromUtf8Byte("é", 1), InputError);
  assert.throws(() => utf16OffsetFromUtf8Byte("一", 1), InputError);
  assert.throws(() => utf16OffsetFromUtf8Byte("一", 2), InputError);
  assert.throws(() => utf16OffsetFromUtf8Byte("😀", 1), InputError);
  assert.throws(() => utf16OffsetFromUtf8Byte("😀", 2), InputError);
  assert.throws(() => utf16OffsetFromUtf8Byte("😀", 3), InputError);
});

test("utf16OffsetFromUtf8Byte: throws InputError for non-string source", () => {
  assert.throws(() => utf16OffsetFromUtf8Byte(undefined as unknown as string, 0), InputError);
  assert.throws(() => utf16OffsetFromUtf8Byte(null as unknown as string, 0), InputError);
  assert.throws(() => utf16OffsetFromUtf8Byte(42 as unknown as string, 0), InputError);
});

test("utf16OffsetFromUtf8Byte: throws InputError for non-safe-integer offsets", () => {
  assert.throws(() => utf16OffsetFromUtf8Byte("abc", 1.5), InputError);
  assert.throws(() => utf16OffsetFromUtf8Byte("abc", NaN), InputError);
  assert.throws(() => utf16OffsetFromUtf8Byte("abc", Infinity), InputError);
});

test("utf16OffsetFromUtf8Byte: throws InputError for negative and out-of-range offsets", () => {
  assert.throws(() => utf16OffsetFromUtf8Byte("abc", -1), InputError);
  assert.throws(() => utf16OffsetFromUtf8Byte("abc", 4), InputError);
  assert.throws(() => utf16OffsetFromUtf8Byte("abc", 1000), InputError);
});

test("utf16OffsetFromUtf8Byte: empty string accepts only byte offset 0", () => {
  assert.equal(utf16OffsetFromUtf8Byte("", 0), 0);
  assert.throws(() => utf16OffsetFromUtf8Byte("", 1), InputError);
});

test("utf16OffsetFromUtf8Byte: handles lone high surrogate as 3 bytes", () => {
  const lone = "a\uD800b";
  assert.equal(utf16OffsetFromUtf8Byte(lone, 0), 0);
  assert.equal(utf16OffsetFromUtf8Byte(lone, 1), 1);
  assert.equal(utf16OffsetFromUtf8Byte(lone, 4), 2);
  assert.equal(utf16OffsetFromUtf8Byte(lone, 5), 3);
  assert.throws(() => utf16OffsetFromUtf8Byte(lone, 2), InputError);
  assert.throws(() => utf16OffsetFromUtf8Byte(lone, 3), InputError);
});

test("utf16OffsetFromUtf8Byte: handles lone low surrogate as 3 bytes", () => {
  const lone = "a\uDC00b";
  assert.equal(utf16OffsetFromUtf8Byte(lone, 0), 0);
  assert.equal(utf16OffsetFromUtf8Byte(lone, 1), 1);
  assert.equal(utf16OffsetFromUtf8Byte(lone, 4), 2);
  assert.equal(utf16OffsetFromUtf8Byte(lone, 5), 3);
  assert.throws(() => utf16OffsetFromUtf8Byte(lone, 2), InputError);
  assert.throws(() => utf16OffsetFromUtf8Byte(lone, 3), InputError);
});

test("utf16OffsetFromUtf8Byte: large hostile string round-trip is exhaustive", () => {
  const hostile = "çafé_𝕏_Ω_" + "x".repeat(2000) + "_ééé_𝕏𝕏😀";
  const map = createUtf8OffsetMap(hostile);
  let checked = 0;
  for (let i = 0; i <= hostile.length; i += 1) {
    const mapVal = map[i] as number;
    if (mapVal === INVALID_BOUNDARY) continue;
    assert.equal(utf16OffsetFromUtf8Byte(hostile, mapVal), i, `large@${i}`);
    checked += 1;
  }
  assert.ok(checked > 2000, "round-trip exercised more than 2000 boundaries");
});
