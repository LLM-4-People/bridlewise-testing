// @vitest-environment node
/**
 * THE ARM PALETTE GUARD — the palette is DERIVED from the server's own
 * vocabulary, never a hand list (the registry-derivation pattern).
 *
 * The invariants this file owns:
 *   - EQUALITY, both directions (deny-by-default): every field the
 *     vocabulary declares is offered by the palette, and every offered
 *     field is a live vocabulary member. A server-side vocabulary GROWTH
 *     surfaces in the palette with ZERO test edits — proven by planting a
 *     grown map and deriving through the same function — and a hand-list
 *     mutation (an offered field the map does not declare) reds.
 *   - The ready rows (templates) reference only live vocabulary fields.
 *   - Every evaluation-note override keys a live field (a stale note about
 *     a removed field is a lie with a green test over it).
 *   - The operator list is the parser's own WHEN_OPERATORS, verbatim.
 */
import { describe, expect, test } from "vitest";

import {
  ARM_PREDICATE_VOCABULARY,
  armVocabularyFields,
} from "../../shared/arm-vocabulary";
import { WHEN_OPERATORS, evalWhen } from "../../shared/when-eval";
import {
  armPaletteFields,
  armPaletteFieldGroups,
  armPaletteOperators,
  armPaletteRows,
  armTemplateFields,
} from "../../src/cockpit/sweep/arm-palette";
import { ARM_FIELD_EVALUATION } from "../../src/cockpit/sweep/arm-fire";

describe("palette ↔ vocabulary equality (deny-by-default, both ways)", () => {
  test("every field the vocabulary declares is offered, and every offered field is declared", () => {
    const offered = new Set(armPaletteFields().map((f) => f.path));
    const declared = new Set(armVocabularyFields().map((f) => f.path));
    for (const path of declared) {
      expect(offered.has(path), `the palette must offer ${path}`).toBe(true);
    }
    for (const path of offered) {
      expect(declared.has(path), `the palette offers ${path}, which the vocabulary does not declare`).toBe(true);
    }
    expect(offered.size).toBe(declared.size);
  });

  test("every field carries its root's plain-words meaning and an evaluation sentence", () => {
    for (const f of armPaletteFields()) {
      expect(f.meaning.length).toBeGreaterThan(0);
      expect(f.evaluation.length).toBeGreaterThan(0);
      // The meaning is the map's own description head, verbatim up to the
      // enumerated fields — e.g. "the received ledger event".
      expect(ARM_PREDICATE_VOCABULARY[f.root]!.startsWith(f.meaning)).toBe(true);
    }
  });

  test("MUTATION (the registry-derivation arm): a planted vocabulary GROWTH surfaces in the palette with zero edits", () => {
    // A server-side growth: a new field on an existing root + a whole new
    // root. Nothing in the palette source changes; the SAME derivation
    // offers both — this is the arm that reds if anyone turns the palette
    // into a hand list the growth silently misses.
    const grown: Readonly<Record<string, string>> = Object.freeze({
      ...ARM_PREDICATE_VOCABULARY,
      tool: "the tool frame in flight: tool.name, tool.failed, tool.durationMs, tool.retries",
      memory: "the injected memories: memory.count",
    });
    const offered = new Set(armPaletteFields(grown).map((f) => f.path));
    expect(offered.has("tool.retries"), "a new field on an existing root must appear").toBe(true);
    expect(offered.has("memory.count"), "a whole new root must appear").toBe(true);
    // And the growth's groups carry the new root in the map's own order.
    const roots = armPaletteFieldGroups(grown).map((g) => g.root);
    expect(roots).toContain("memory");
  });

  test("MUTATION (the hand-list arm): an offered field the vocabulary does not declare reds the equality", () => {
    // The derived list cannot over-offer — this proves the equality has
    // teeth in that direction by checking the derivation against a SHRUNK
    // map: the fields of the live map that the shrunk map no longer
    // declares must not be offered for the shrunk map.
    const shrunk: Readonly<Record<string, string>> = Object.freeze({
      event: ARM_PREDICATE_VOCABULARY.event!,
      tool: "the tool frame in flight: tool.name, tool.failed",
    });
    const offered = new Set(armPaletteFields(shrunk).map((f) => f.path));
    expect(offered.has("tool.durationMs")).toBe(false);
    expect(offered.has("tool.failed")).toBe(true);
    expect(offered.has("check.id")).toBe(false);
  });
});

describe("the ready rows — templates over live vocabulary fields only", () => {
  test("named conditions roundtrip quotes, path slashes and Unicode through the real evaluator", () => {
    const row = armPaletteRows().find(row => row.id === "tool-name-fails")!;
    for (const name of ["it's", "C:\\tools\\read", "both\\'quotes\"", "日本語 🛠", "trailing\\", "x' || tool.failed || '"]) {
      const built = row.build(name);
      expect("predicate" in built).toBe(true);
      if (!("predicate" in built)) throw new Error("named condition failed to build");
      expect(evalWhen(built.predicate, { tool: { name, failed: true } })).toBe(true);
      expect(evalWhen(built.predicate, { tool: { name: "different", failed: true } })).toBe(false);
      expect(evalWhen(built.predicate, { tool: { name, failed: false } })).toBe(false);
    }
  });
  test("every field a template references is a live vocabulary member", () => {
    const declared = new Set(armVocabularyFields().map((f) => f.path));
    for (const row of armPaletteRows()) {
      for (const path of armTemplateFields(row)) {
        expect(
          declared.has(path),
          `template "${row.label}" references ${path}, which the vocabulary does not declare`,
        ).toBe(true);
      }
    }
  });

  test("a parametrized row without its value says what it needs; with one it builds an expression", () => {
    const rows = armPaletteRows();
    const namedTool = rows.find((r) => r.id === "tool-name-fails")!;
    expect("needs" in namedTool.build(null)).toBe(true);
    const built = namedTool.build("edit");
    expect("predicate" in built && built.predicate).toBe("tool.name == 'edit' && tool.failed");
    // A value with a quote in it is escaped, not silently mangled.
    const quoted = namedTool.build("it's");
    expect("predicate" in quoted && quoted.predicate).toBe("tool.name == 'it\\'s' && tool.failed");
    const noParam = rows.find((r) => r.id === "run-boundary")!;
    expect("predicate" in noParam.build(null)).toBe(true);
  });

  test("the operators are the parser's own list, each named in plain words", () => {
    const offered = armPaletteOperators().map((op) => op.token);
    expect(offered).toEqual([...WHEN_OPERATORS]);
    for (const op of armPaletteOperators()) {
      expect(op.label.length).toBeGreaterThan(0);
      expect(op.label).not.toBe(op.token);
    }
  });
});

describe("the evaluation-note overrides — no stale keys", () => {
  test("every override keys a live vocabulary field (a note about a removed field is a lie)", () => {
    const declared = new Set(armVocabularyFields().map((f) => f.path));
    for (const key of Object.keys(ARM_FIELD_EVALUATION)) {
      expect(
        declared.has(key),
        `an evaluation note exists for ${key}, which the vocabulary does not declare`,
      ).toBe(true);
    }
  });
});
