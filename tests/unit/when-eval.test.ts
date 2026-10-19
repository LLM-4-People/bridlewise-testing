// @vitest-environment node
import { describe, test, expect } from "vitest";
import { evalWhen, resolvePath, WhenParseError } from "../../shared/when-eval";

/**
 * When-clause evaluator tests. Covers truthy/falsy, equality, null checks,
 * AND/OR/NOT, grouping, dotted paths, and improper usage (malformed input
 * must throw a typed WhenParseError, not silently pass).
 */

describe("evalWhen — truthy / falsy", () => {
  test("missing key is falsy", () => {
    expect(evalWhen("missing", {})).toBe(false);
  });
  test("present truthy string is truthy", () => {
    expect(evalWhen("name", { name: "x" })).toBe(true);
  });
  test("present non-empty object is truthy", () => {
    expect(evalWhen("run", { run: { status: "running" } })).toBe(true);
  });
  test("zero is falsy", () => {
    expect(evalWhen("count", { count: 0 })).toBe(false);
  });
  test("empty string is falsy", () => {
    expect(evalWhen("label", { label: "" })).toBe(false);
  });
  test("false is falsy", () => {
    expect(evalWhen("flag", { flag: false })).toBe(false);
  });
  test("!key is true when key missing", () => {
    expect(evalWhen("!run", {})).toBe(true);
  });
  test("!key is false when key present", () => {
    expect(evalWhen("!run", { run: { status: "running" } })).toBe(false);
  });
});

describe("evalWhen — equality", () => {
  test("string equality matches", () => {
    expect(evalWhen("run.status == 'running'", { run: { status: "running" } })).toBe(true);
  });
  test("string equality does not match", () => {
    expect(evalWhen("run.status == 'running'", { run: { status: "done" } })).toBe(false);
  });
  test("string inequality", () => {
    expect(evalWhen("run.status != 'running'", { run: { status: "done" } })).toBe(true);
  });
  test("dotted path resolves nested object", () => {
    expect(evalWhen("run.modelLabel == 'gemma'", { run: { modelLabel: "gemma" } })).toBe(true);
  });
  test("missing dotted path is undefined → not equal", () => {
    expect(evalWhen("run.modelLabel == 'gemma'", { run: {} })).toBe(false);
  });
  test("number equality", () => {
    expect(evalWhen("count == 5", { count: 5 })).toBe(true);
  });
  test("boolean true literal", () => {
    expect(evalWhen("flag == true", { flag: true })).toBe(true);
  });
  test("boolean false literal matches false", () => {
    expect(evalWhen("flag == false", { flag: false })).toBe(true);
  });
  test("boolean false literal does not match true", () => {
    expect(evalWhen("flag == false", { flag: true })).toBe(false);
  });
});

describe("evalWhen — null checks", () => {
  test("key == null matches when missing", () => {
    expect(evalWhen("project == null", {})).toBe(true);
  });
  test("key == null matches when null", () => {
    expect(evalWhen("project == null", { project: null })).toBe(true);
  });
  test("key!= null matches when present", () => {
    expect(evalWhen("project != null", { project: { id: "x" } })).toBe(true);
  });
  test("key!= null is false when missing", () => {
    expect(evalWhen("chat != null", {})).toBe(false);
  });
});

describe("evalWhen — logical operators", () => {
  test("AND both true", () => {
    expect(evalWhen("run && project", { run: { status: "running" }, project: { id: "x" } })).toBe(true);
  });
  test("AND one false", () => {
    expect(evalWhen("run && project", { run: { status: "running" } })).toBe(false);
  });
  test("OR first true", () => {
    expect(evalWhen("run || project", { run: { status: "running" } })).toBe(true);
  });
  test("OR both false", () => {
    expect(evalWhen("run || project", {})).toBe(false);
  });
  test("NOT with comparison", () => {
    expect(evalWhen("!(run.status == 'done')", { run: { status: "running" } })).toBe(true);
  });
  test("grouping with parentheses", () => {
    expect(evalWhen("(run || project) && chat", { project: { id: "x" }, chat: { id: "c" } })).toBe(true);
  });
  test("complex nested expression", () => {
    const ctx = { run: { status: "running" }, project: { id: "x" }, chat: { id: "c" } };
    expect(evalWhen("(run.status == 'running' && project) || chat", ctx)).toBe(true);
  });
});

describe("evalWhen — empty / undefined", () => {
  test("undefined expression is true (always visible)", () => {
    expect(evalWhen(undefined, {})).toBe(true);
  });
  test("empty string is true", () => {
    expect(evalWhen("", {})).toBe(true);
  });
  test("whitespace-only is true", () => {
    expect(evalWhen("   ", {})).toBe(true);
  });
});

describe("evalWhen — improper usage (must throw, never silently pass)", () => {
  test("unterminated string throws WhenParseError", () => {
    expect(() => evalWhen("key == 'unterminated", { key: "x" })).toThrow(WhenParseError);
  });
  test("unexpected character throws", () => {
    expect(() => evalWhen("key @ 'x'", {})).toThrow(WhenParseError);
  });
  test("missing closing paren throws", () => {
    expect(() => evalWhen("(run && project", { run: {}, project: {} })).toThrow(WhenParseError);
  });
  test("trailing tokens throw", () => {
    expect(() => evalWhen("run extra", { run: {} })).toThrow(WhenParseError);
  });
  test("comparison with an identifier on the right compares two paths", () => {
    // The grammar deliberately allows an ident on the RHS: relevance
    // predicates need to compare two context values (`data.used > data.limit`),
    // which a literal-only RHS cannot express. This previously threw.
    expect(evalWhen("a == b", { a: 1, b: 1 })).toBe(true);
    expect(evalWhen("a == b", { a: 1, b: 2 })).toBe(false);
    expect(evalWhen("used > limit", { used: 10, limit: 5 })).toBe(true);
    expect(evalWhen("used > limit", { used: 5, limit: 10 })).toBe(false);
  });
});

describe("resolvePath", () => {
  test("single key", () => {
    expect(resolvePath({ a: 1 }, "a")).toBe(1);
  });
  test("nested path", () => {
    expect(resolvePath({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  });
  test("missing segment returns undefined", () => {
    expect(resolvePath({ a: {} }, "a.b.c")).toBe(undefined);
  });
  test("null object returns undefined", () => {
    expect(resolvePath(null, "a")).toBe(undefined);
  });
});
