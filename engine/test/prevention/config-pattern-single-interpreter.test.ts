/**
 * Every config field whose values are COMPILED as patterns has exactly ONE
 * interpreting reader in `src/` — the one-list-two-compilations fork cannot
 * re-form.
 *
 * ── THE CLASS ─────────────────────────────────────────────────────────────
 *
 * `performance.labelSchema` once carried `forbiddenLabelPatterns`: regex
 * source, validated as bare strings, and compiled at TWO sites with DIFFERENT
 * flags — `"u"` in the admission gate, `"giu"` in the redactor — so the two
 * gates disagreed about `SECRET=…`: allowed by one, dropped by the other. One
 * list, two interpretations, two verdicts. That field's own guard lives with
 * its subsystem in `test/performance/performance-config.test.ts`; this file
 * is the CLASS guard, deny-by-default over every config field with the same
 * shape, including ones added tomorrow.
 *
 * ── THE SEARCH BEFORE CREATION ────────────────────────────────────────────
 *
 * Two existing guards were candidates to own this and neither does:
 * `config-consumption-contract.test.ts` asserts AT LEAST ONE consumer per
 * field (dead config, the opposite end of the count), over the privacy policy
 * only; the label guard asserts its ONE field's token appears in exactly one
 * file, by name. No guard asks "of every field whose values are compiled,
 * who compiles+applies it, and is there exactly one" over the discovered
 * population — so this file is new, and the two neighbours stay.
 *
 * ── HOW A FIELD ENTERS THE GUARDED POPULATION ─────────────────────────────
 *
 * A field whose values are compiled carries its own proof at the schema door:
 * a `.refine`/`.superRefine` whose body constructs a `RegExp` from the value
 * — "accepting a string that does not compile moves the failure from the
 * write to the next scan", as the never-push rule schema says at its own
 * declaration. That refine IS the declaration "my values are patterns", so
 * the population is discovered from the schema layer and a new pattern field
 * carrying the same validation is covered without an edit here. A pattern
 * field declared WITHOUT compile-validation is invisible to this guard — that
 * is a stated limit, and itself a defect of another kind (an uncompilable
 * value reaches the scan that was supposed to be a safety check).
 *
 * ── WHAT AN INTERPRETING READER IS ────────────────────────────────────────
 *
 * A source file that (a) references the field, (b) constructs a `RegExp`, and
 * (c) applies one (`.test(`/`.exec(`). The schema file itself is excluded —
 * its compile is the load-time validation, the declaration of compilability,
 * never an application of the pattern to runtime data. A pass-through that
 * maps the list into a frozen DTO compiles nothing and is not a reader. A
 * file that compiles but never applies is not counted either — as the ONLY
 * reader that shape reads as zero readers, which is red; alongside a real
 * reader it decides nothing, and "the application feeds the verdict" is the
 * behavioural tests' charter (the never-push scan's hostile tests), not this
 * guard's.
 *
 * All of it runs over the parsed program (the sanctioned view's `code()`
 * text), so a mention in a comment or a fixture string is not code, and a
 * regex literal's parentheses are nodes, never a brace-counting hazard.
 */
import assert from "node:assert/strict";
import { join, relative } from "node:path";
import test from "node:test";

import { parse } from "@babel/parser";

import { astNode, walkAst, type AstNode } from "../../src/quality-packs/prevention/ast-helpers.ts";
import { readSourceView, sourceViewOf } from "../../scripts/verification/source-view.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

const SRC_ROOT = join(import.meta.dirname, "..", "..", "src");

interface CompileValidatedField {
  /** The file declaring the schema, relative to `src/` (forward slashes). */
  readonly schemaFile: string;
  /** The named schema binding carrying the refine, when there is one. */
  readonly schemaConst: string | null;
  /** The property the refine is attached to (e.g. the `pattern` sub-field). */
  readonly refinedProperty: string;
  /** The field(s) runtime code reads (e.g. `additiveRules`). */
  readonly consumedFields: readonly string[];
}

interface Discovery {
  readonly fields: readonly CompileValidatedField[];
  /** Files whose code view would not parse — each is a loud finding. */
  readonly unparseable: readonly string[];
}

function parseCodeView(code: string): AstNode {
  return parse(code, {
    sourceType: "module",
    plugins: ["typescript"],
    attachComment: false,
    errorRecovery: false,
  }) as unknown as AstNode;
}

function memberCallName(node: AstNode): string | null {
  if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return null;
  const callee = astNode(node.callee);
  if (callee === undefined || callee.type !== "MemberExpression") return null;
  if (callee.computed === true) return null;
  const property = astNode(callee.property);
  return property?.type === "Identifier" && typeof property.name === "string" ? property.name : null;
}

function subtreeHas(node: AstNode, predicate: (n: AstNode) => boolean): boolean {
  let found = false;
  walkAst(node, (n) => {
    if (!found && predicate(n)) found = true;
  });
  return found;
}

function isRegExpConstruction(node: AstNode): boolean {
  if (node.type !== "NewExpression") return false;
  const callee = astNode(node.callee);
  return callee?.type === "Identifier" && callee.name === "RegExp";
}

function spanOf(node: AstNode): readonly [number, number] {
  return [
    typeof node.start === "number" ? node.start : -1,
    typeof node.end === "number" ? node.end : -1,
  ];
}

function containsSpan(outer: AstNode, inner: AstNode): boolean {
  const [os, oe] = spanOf(outer);
  const [is, ie] = spanOf(inner);
  return os <= is && oe >= ie;
}

/** The key of the smallest object property whose value holds `node`. */
function enclosingPropertyKey(ast: AstNode, node: AstNode): string | null {
  let best: { name: string; size: number } | null = null;
  walkAst(ast, (candidate) => {
    if (candidate.type !== "ObjectProperty") return;
    const value = astNode(candidate.value);
    if (value === undefined || !containsSpan(value, node)) return;
    const key = astNode(candidate.key);
    if (key?.type !== "Identifier" || typeof key.name !== "string") return;
    const [s, e] = spanOf(candidate);
    const size = e - s;
    if (best === null || size < best.size) best = { name: key.name, size };
  });
  return best === null ? null : (best as { name: string }).name;
}

/** The smallest `const X = …` whose initializer holds `node`. */
function enclosingSchemaConst(ast: AstNode, node: AstNode): string | null {
  let best: { name: string; size: number } | null = null;
  walkAst(ast, (candidate) => {
    if (candidate.type !== "VariableDeclarator") return;
    const init = astNode(candidate.init);
    if (init === undefined || !containsSpan(init, node)) return;
    const id = astNode(candidate.id);
    if (id?.type !== "Identifier" || typeof id.name !== "string") return;
    const [s, e] = spanOf(candidate);
    const size = e - s;
    if (best === null || size < best.size) best = { name: id.name, size };
  });
  return best === null ? null : (best as { name: string }).name;
}

/**
 * The object-property keys whose value references `schemaConst` — the fields
 * runtime code reads — excluding properties inside the schema's own
 * declaration.
 */
function consumedFieldKeys(ast: AstNode, schemaConst: string): readonly string[] {
  let declaration: AstNode | undefined;
  walkAst(ast, (candidate) => {
    if (candidate.type !== "VariableDeclarator") return;
    const id = astNode(candidate.id);
    if (id?.type === "Identifier" && id.name === schemaConst) declaration = candidate;
  });
  const keys = new Set<string>();
  walkAst(ast, (candidate) => {
    if (candidate.type !== "ObjectProperty") return;
    if (declaration !== undefined && containsSpan(declaration, candidate)) return;
    const value = astNode(candidate.value);
    if (value === undefined) return;
    const references = subtreeHas(
      value,
      (n) => n.type === "Identifier" && n.name === schemaConst,
    );
    if (!references) return;
    const key = astNode(candidate.key);
    if (key?.type === "Identifier" && typeof key.name === "string") keys.add(key.name);
  });
  return [...keys].toSorted();
}

function discoverInFile(schemaFile: string, code: string): CompileValidatedField[] {
  const ast = parseCodeView(code);
  const out: CompileValidatedField[] = [];
  walkAst(ast, (node) => {
    const name = memberCallName(node);
    if (name !== "refine" && name !== "superRefine") return;
    if (!subtreeHas(node, isRegExpConstruction)) return;
    const refinedProperty = enclosingPropertyKey(ast, node);
    const schemaConst = enclosingSchemaConst(ast, node);
    // A refine on a property of a NAMED sub-schema (the never-push rule's
    // `pattern`) guards the field that consumes the sub-schema; a refine
    // sitting directly on the consumed property (an inline `namePattern`)
    // has no sub-schema to resolve through and guards its own property.
    const resolved = schemaConst !== null ? consumedFieldKeys(ast, schemaConst) : [];
    const consumedFields = resolved.length > 0
      ? resolved
      : (refinedProperty !== null ? [refinedProperty] : []);
    out.push({
      schemaFile,
      schemaConst,
      refinedProperty: refinedProperty ?? "(unresolved)",
      consumedFields,
    });
  });
  return out;
}

/**
 * The guarded population across `files` (path → code-view text). Discovery
 * only parses files that name a refine at all; a parse failure is COLLECTED,
 * never skipped — a file the extractor cannot read is the extractor gone
 * blind, and the caller asserts the list is empty.
 */
export function discoverCompileValidatedFields(
  files: ReadonlyMap<string, string>,
): Discovery {
  const fields: CompileValidatedField[] = [];
  const unparseable: string[] = [];
  for (const [file, code] of files) {
    if (!code.includes(".refine(") && !code.includes(".superRefine(")) continue;
    try {
      fields.push(...discoverInFile(file, code));
    } catch {
      unparseable.push(file);
    }
  }
  // One entry per (schema file, consumed field) — two pattern sub-fields of
  // one rules list guard the same reader, not two.
  const seen = new Set<string>();
  const unique: CompileValidatedField[] = [];
  for (const field of fields) {
    for (const consumed of field.consumedFields) {
      const key = `${field.schemaFile}${consumed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ ...field, consumedFields: [consumed] });
    }
  }
  return { fields: unique, unparseable };
}

const ARRAY_DECISIONS: ReadonlySet<string> = new Set([
  "some", "every", "filter", "find", "findIndex", "forEach", "map", "flatMap",
]);

/**
 * Does one parsed file APPLY a pattern it compiled? The compile and the
 * apply must be the same object, or an imported constant's `.test` answers
 * for an unrelated construction and a surgical neuter of the real chain goes
 * green. The shapes covered are the idioms this tree compiles lists in:
 * bind-then-apply (`const re = new RegExp(…); re.test(…)`), the direct chain
 * (`new RegExp(…).test(…)`), and map-to-array-then-decide (`const res =
 * xs.map((p) => new RegExp(p)); res.some((re) => re.test(…))`, and the same
 * through a `for … of`). A holder squirreled into a member expression
 * (`this.res`) is out of reach of a source guard — a stated limit, in the
 * under-count direction.
 */
function appliesCompiledPattern(ast: AstNode): boolean {
  const holders = new Set<string>();
  walkAst(ast, (node) => {
    if (node.type === "VariableDeclarator") {
      const id = astNode(node.id);
      const init = astNode(node.init);
      if (id?.type === "Identifier" && typeof id.name === "string" &&
        init !== undefined && subtreeHas(init, isRegExpConstruction)) {
        holders.add(id.name);
      }
      return;
    }
    if (node.type === "AssignmentExpression") {
      const left = astNode(node.left);
      const right = astNode(node.right);
      if (left?.type === "Identifier" && typeof left.name === "string" &&
        right !== undefined && subtreeHas(right, isRegExpConstruction)) {
        holders.add(left.name);
      }
    }
  });
  const isDecisionCall = (node: AstNode): boolean => {
    const name = memberCallName(node);
    return name === "test" || name === "exec";
  };
  const decidesOn = (node: AstNode, holderNames: ReadonlySet<string>): boolean => {
    const callee = astNode(node.callee);
    const object = callee === undefined ? undefined : astNode(callee.object);
    if (object === undefined) return false;
    return isRegExpConstruction(object) ||
      (object.type === "Identifier" && typeof object.name === "string" && holderNames.has(object.name));
  };
  let applies = false;
  walkAst(ast, (node) => {
    if (applies) return;
    if (isDecisionCall(node) && decidesOn(node, holders)) {
      applies = true;
      return;
    }
    const name = memberCallName(node);
    if (name !== null && ARRAY_DECISIONS.has(name) && decidesOn(node, holders) &&
      subtreeHas(node, isDecisionCall)) {
      applies = true;
      return;
    }
    if (node.type === "ForOfStatement") {
      const right = astNode(node.right);
      if (right?.type === "Identifier" && typeof right.name === "string" && holders.has(right.name) &&
        subtreeHas(node, isDecisionCall)) {
        applies = true;
      }
    }
  });
  return applies;
}

/**
 * The `src/` files that INTERPRET `field`: reference it, and apply a pattern
 * the file itself compiled. The schema file is out — its compile is the
 * declaration of compilability, never an application to runtime data.
 */
export function interpretingReaders(
  field: string,
  schemaFile: string,
  files: ReadonlyMap<string, string>,
): readonly string[] {
  const reference = new RegExp(`\\b${field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u");
  const readers: string[] = [];
  for (const [file, code] of files) {
    if (file === schemaFile) continue;
    if (!reference.test(code)) continue;
    if (appliesCompiledPattern(parseCodeView(code))) readers.push(file);
  }
  return readers.toSorted();
}

function walkSourceFiles(dir: string, into: string[]): void {
  for (const file of walk(dir, { exts: [".ts"] })) {
    if (!file.endsWith(".test.ts")) into.push(file);
  }
}

// ── Fixture-driven arms: the verdict shapes, driven from OUTSIDE the scan ──

const FIXTURE_SCHEMA = `
import { z } from "zod";
const widgetPatternSchema = z.strictObject({
  source: z.string().min(1).refine(
    (value) => {
      try {
        new RegExp(value, "u");
        return true;
      } catch {
        return false;
      }
    },
    { message: "not a regular expression" },
  ),
  label: z.string(),
});
export const widgetSchema = z.strictObject({
  widgetRules: z.array(widgetPatternSchema).max(64),
});
`;

const FIXTURE_INTERPRETER = `
export function scanWidgetRules(rules: readonly { source: string }[]): string[] {
  const hits: string[] = [];
  for (const rule of rules) {
    const compiled = new RegExp(rule.source, "u");
    for (const candidate of candidates(rule)) {
      if (compiled.test(candidate)) hits.push(candidate);
    }
  }
  return hits;
}
// The interpreter reads the config list the scan is built from.
declare function candidates(rule: { source: string }): string[];
export const door = (config: { widgetRules: readonly { source: string }[] }): string[] =>
  scanWidgetRules([...config.widgetRules]);
`;

const FIXTURE_PASS_THROUGH = `
export function freezeWidgetRules(config: { widgetRules: readonly unknown[] }): readonly unknown[] {
  return config.widgetRules.map((rule) => Object.freeze(rule));
}
`;

function fixtureFiles(entries: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [name, text] of Object.entries(entries)) {
    out.set(name, sourceViewOf(text, `${name}.ts`).code());
  }
  return out;
}

test("discovery: a compile-validating refine resolves to the field runtime code reads", () => {
  const discovery = discoverCompileValidatedFields(fixtureFiles({
    "contracts/widgets": FIXTURE_SCHEMA,
  }));
  assert.deepEqual(discovery.unparseable, []);
  assert.equal(discovery.fields.length, 1);
  const field = discovery.fields[0]!;
  assert.equal(field.schemaConst, "widgetPatternSchema");
  assert.equal(field.refinedProperty, "source");
  assert.deepEqual(field.consumedFields, ["widgetRules"]);
});

test("discovery: a refine that never compiles is not a pattern field, and a compile outside a refine is not a declaration", () => {
  const discovery = discoverCompileValidatedFields(fixtureFiles({
    "contracts/plain": `
      import { z } from "zod";
      const names = z.strictObject({
        label: z.string().refine((v) => v.length > 0, { message: "empty" }),
      });
      export const door = z.strictObject({ names });
      export const probe = (v: string): RegExp => new RegExp(v, "u");
    `,
  }));
  assert.deepEqual(discovery.unparseable, []);
  assert.deepEqual(discovery.fields, []);
});

test("discovery: an inline compile-validating refine tracks its own property", () => {
  const discovery = discoverCompileValidatedFields(fixtureFiles({
    "contracts/inline": `
      import { z } from "zod";
      export const door = z.strictObject({
        namePattern: z.string().refine((v) => {
          new RegExp(v, "u");
          return true;
        }),
      });
    `,
  }));
  assert.deepEqual(discovery.unparseable, []);
  assert.equal(discovery.fields.length, 1);
  assert.deepEqual(discovery.fields[0]!.consumedFields, ["namePattern"]);
});

test("readers: exactly one interpreter is green; a pass-through and a compile-without-apply are not readers", () => {
  const files = fixtureFiles({
    "contracts/widgets": FIXTURE_SCHEMA,
    "runtime/widget-scan": FIXTURE_INTERPRETER,
    "runtime/widget-dto": FIXTURE_PASS_THROUGH,
    "runtime/widget-inert": `
      export const probe = (config: { widgetRules: readonly { source: string }[] }): number =>
        config.widgetRules.map((rule) => new RegExp(rule.source, "u").source.length).length;
    `,
  });
  const readers = interpretingReaders("widgetRules", "contracts/widgets", files);
  assert.deepEqual(readers, ["runtime/widget-scan"]);
});

test("readers: a second interpreter is the fork, and it is named", () => {
  const files = fixtureFiles({
    "contracts/widgets": FIXTURE_SCHEMA,
    "runtime/widget-scan": FIXTURE_INTERPRETER,
    "runtime/widget-audit": `
      export function audit(widgetRules: readonly { source: string }[], path: string): boolean {
        for (const rule of widgetRules) {
          if (new RegExp(rule.source, "iu").test(path)) return true;
        }
        return false;
      }
    `,
  });
  const readers = interpretingReaders("widgetRules", "contracts/widgets", files);
  assert.deepEqual(readers, ["runtime/widget-audit", "runtime/widget-scan"]);
});

test("readers: the map-to-array-then-decide idiom is an interpreter too", () => {
  const files = fixtureFiles({
    "contracts/widgets": FIXTURE_SCHEMA,
    "runtime/widget-scan": FIXTURE_INTERPRETER,
    "runtime/widget-detector": `
      export function createDetector(config: { widgetRules: readonly { source: string }[] }) {
        const compiled = config.widgetRules.map((rule) => new RegExp(rule.source));
        return {
          detect(value: string): boolean {
            return compiled.some((re) => re.test(value));
          },
        };
      }
    `,
  });
  const readers = interpretingReaders("widgetRules", "contracts/widgets", files);
  assert.deepEqual(readers, ["runtime/widget-detector", "runtime/widget-scan"]);
});

test("readers: an unrelated pattern's apply does not stand in for the field's — a surgical neuter reads as zero", () => {
  const files = fixtureFiles({
    "contracts/widgets": FIXTURE_SCHEMA,
    "runtime/widget-scan": `
      const URL_SHAPE = /^https:/u;
      export function scanWidgetRules(config: { widgetRules: readonly { source: string }[] }, value: string): number {
        // The field is still referenced and the file still applies AN imported
        // pattern — but nothing applies a pattern this file compiled.
        return config.widgetRules.length + (URL_SHAPE.test(value) ? 1 : 0);
      }
    `,
  });
  assert.deepEqual(interpretingReaders("widgetRules", "contracts/widgets", files), []);
});

test("readers: zero interpreters is dead config, never a pass", () => {
  const files = fixtureFiles({
    "contracts/widgets": FIXTURE_SCHEMA,
    "runtime/widget-dto": FIXTURE_PASS_THROUGH,
  });
  assert.deepEqual(interpretingReaders("widgetRules", "contracts/widgets", files), []);
});

// ── The LIVE arm: the real tree, deny-by-default over what it discovers ────

test("LIVE: every config-sourced pattern field has exactly ONE interpreting reader in src/", () => {
  const paths: string[] = [];
  walkSourceFiles(SRC_ROOT, paths);
  assert.ok(paths.length > 100, `witness: src/ was actually walked (${String(paths.length)} files)`);

  const files = new Map<string, string>();
  for (const path of paths) {
    files.set(relative(SRC_ROOT, path).replaceAll("\\", "/"), readSourceView(path).code());
  }

  const discovery = discoverCompileValidatedFields(files);
  assert.deepEqual(
    discovery.unparseable,
    [],
    "these code views would not parse — the extractor went blind on them, and a blind " +
      "extractor's green certifies nothing",
  );
  assert.ok(
    discovery.fields.length >= 1,
    "discovered ZERO compile-validated config fields — the discovery went blind, not the " +
      "tree clean. A pattern field declares itself by a refine that constructs a RegExp " +
      "from the value; if that shape exists anywhere in src/ and this finds none, the " +
      "extractor is broken.",
  );

  const violations: string[] = [];
  const census: string[] = [];
  for (const field of discovery.fields) {
    assert.ok(
      field.consumedFields.length === 1,
      `${field.refinedProperty} in ${field.schemaFile}: the consumed field could not be ` +
        "resolved — a pattern field the guard cannot name is a discovery it cannot make",
    );
    const consumed = field.consumedFields[0]!;
    const readers = interpretingReaders(consumed, field.schemaFile, files);
    census.push(`${consumed} (${field.schemaFile}): ${readers.length} reader(s) — ${readers.join(", ") || "none"}`);
    if (readers.length !== 1) {
      violations.push(
        `${consumed} has ${String(readers.length)} interpreting reader(s)` +
          (readers.length > 0 ? ` (${readers.join(", ")})` : "") +
          `: every reader of a config-sourced pattern list other than its one interpreter ` +
          "is a second compilation waiting to fork — consume the one interpreter's answer " +
          "instead. Zero readers is dead config: declared, validated, never applied.",
      );
    }
  }
  assert.deepEqual(
    violations,
    [],
    `config-sourced pattern fields must each have exactly ONE interpreting reader.\n` +
      `Population examined: ${census.join(" | ")}`,
  );
});
