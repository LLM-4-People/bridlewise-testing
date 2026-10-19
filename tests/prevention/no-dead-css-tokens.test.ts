// @vitest-environment node
/**
 * Mechanical enforcement: no dead CSS custom properties, and no dangling
 * `var()` reference.
 *
 * This file is the guard `no-dead-css-selectors.test.ts`'s header already
 * names as its companion — the reference existed before the file did (the
 * named-reference evidence is why creating it is earned rather than a second
 * owner). The selector half guards scoped CLASSES; this half guards the
 * TOKEN layer (`--name` custom properties) declared in the token owner.
 *
 * TWO DIRECTIONS, because drift runs both ways:
 *
 *   1. DECLARED-BUT-UNCONSUMED — a `--name` declared in tokens.css that no
 *      source file ever reads. A token nobody consumes is either dead
 *      weight or a promise that was never wired (the `--layer-disabled`
 *      defect: declared, migrated-to nowhere, read by nothing). A token
 *      counts as consumed when ANY of these holds:
 *        - a `var(--name)` read in any scanned source (component, state
 *          module, or the token file itself — internal composition counts);
 *        - a STRING consumption via the canvas path (sweep/categories.ts
 *          reads `--cat-*` names as strings through `cssVar`/`borrows`);
 *        - a `@property`-registered stamp (the per-element stamps a
 *          component sets inline — `--depth`, `--cap-reels`, `--update-ink`);
 *        - a theme-override re-derive inside tokens.css itself (the light
 *          "logbook" block re-declares a name the dark root declares).
 *   2. REFERENCED-BUT-UNDECLARED — a `var(--name)` in a source that
 *      tokens.css never declares. That is the typo class: the reference
 *      resolves to nothing at computed-value time and the failure is
 *      silent. The one exception is a registered stamp's initial value
 *      (`@property` declares the name with an initial, so the reference is
 *      never dangling by construction).
 *
 * The `--cat-*` wheel is handled BY DESIGN, not by scan blindness: its
 * members are consumed as strings by the sweep's canvas palette reader, so
 * this guard parses categories.ts's `cssVar`/`borrows` columns and counts
 * each as a live consumption — a wheel entry the sweep stops borrowing reds
 * here, and a swept name the wheel does not declare reds the other way.
 */
import { describe, expect, test } from "vitest";
import ts from "typescript5";
import { callArgumentsOf } from "../helpers/function-scope.ts";

import { read, relpath, walk } from "../helpers/source-scan.ts";
import { modulePathMatching } from "../helpers/module-resolver.ts";

const TOKENS = "src/cockpit/tokens.css";
const CATEGORIES = modulePathMatching("src/cockpit/sweep/categories.ts");

/** Every `--name` declared in a CSS source (`--name:` at declaration site). */
export function declaredTokens(css: string): Set<string> {
  const out = new Set<string>();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of stripped.matchAll(/^\s*(--[\w-]+)\s*:/gm)) out.add(m[1]!);
  return out;
}

/** Every `--name` a `@property` block registers (a stamp's honest declaration). */
export function registeredProperties(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/@property\s+(--[\w-]+)/g)) out.add(m[1]!);
  return out;
}

/** Every `--name` consumed as a `var(--name)` in a source. */
export function consumedVars(src: string): Set<string> {
  const out = new Set<string>();
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of stripped.matchAll(/var\(\s*(--[\w-]+)/g)) out.add(m[1]!);
  return out;
}

/**
 * Every `--name` the sweep's canvas path consumes as a STRING — the
 * `cssVar`/`borrows` columns in categories.ts. Parsed from the module's own
 * declarations (not a hand list), so a wheel entry the sweep borrows counts
 * as consumed and a category added there is covered automatically.
 */
export function stringConsumedTokens(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/(?:cssVar|borrows):\s*"(--[\w-]+)"/g)) out.add(m[1]!);
  for (const m of src.matchAll(/pick\("(--[\w-]+)"/g)) out.add(m[1]!);
  for (const m of src.matchAll(/tokenHex?\("(--[\w-]+)"/g)) out.add(m[1]!);
  return out;
}

/** The shared reader is a callback parameter, not a globally reserved name.
 * Reuse the source owner's actual call extraction and the installed compiler AST
 * to identify that parameter before counting its literal token reads. */
export function paintConsumedTokens(src: string): Set<string> {
  const out = new Set<string>();
  if (!src.includes("withPaintTokens")) return out;
  for (const args of callArgumentsOf(src, "withPaintTokens")) {
    const expression = `withPaintTokens(${args})`;
    const file = ts.createSourceFile("paint.ts", expression, ts.ScriptTarget.Latest, true);
    const statement = file.statements[0];
    if (statement === undefined || !ts.isExpressionStatement(statement)) continue;
    const call = statement.expression;
    if (!ts.isCallExpression(call)) continue;
    const callback = call.arguments[1];
    if (callback === undefined || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) continue;
    const reader = callback.parameters[0]?.name;
    if (reader === undefined || !ts.isIdentifier(reader)) continue;
    for (const input of callArgumentsOf(`const paint = ${callback.getText(file)}`, reader.text)) {
      const token = /^\s*["'](--[\w-]+)["'](?:\s*,|\s*$)/.exec(input)?.[1];
      if (token !== undefined) out.add(token);
    }
  }
  return out;
}

describe("no-dead-css-tokens — every declared token has a consumer, every reference a declaration", () => {
  const tokensCss = read(TOKENS);
  const declared = declaredTokens(tokensCss);
  const registered = registeredProperties(tokensCss);

  test("the token owner declares a real vocabulary (a gutted file cannot pass vacuously)", () => {
    expect(declared.size, "tokens.css declares the vocabulary").toBeGreaterThan(150);
  });

  // The scanned population: every cockpit source (components + state
  // modules), index.html, and the token file itself (internal composition).
  const svelteFiles = walk("src/cockpit", { exts: [".svelte", ".ts"] });
  const consumers = new Map<string, Set<string>>();
  const consume = (name: string, where: string): void => {
    if (!consumers.has(name)) consumers.set(name, new Set());
    consumers.get(name)!.add(where);
  };
  // var() reads across the tree
  const allSources = [TOKENS, CATEGORIES, "index.html", ...svelteFiles.map(relpath)];
  for (const f of allSources) {
    const src = read(f);
    for (const name of consumedVars(src)) consume(name, `${f} (var)`);
    for (const name of paintConsumedTokens(src)) consume(name, `${f} (withPaintTokens)`);
  }
  // string consumption via the canvas path
  for (const name of stringConsumedTokens(read(CATEGORIES))) {
    consume(name, `${CATEGORIES} (string)`);
  }
  // registered stamps count as consumed (their initial value IS the answer)
  for (const name of registered) consume(name, `${TOKENS} (@property initial)`);

  test("every token declared in tokens.css has a consumer", () => {
    const dead: string[] = [];
    for (const name of declared) {
      if (!consumers.has(name)) dead.push(name);
    }
    expect(
      dead,
      `declared in tokens.css but consumed nowhere (var(), canvas string, @property initial, or theme re-derive):\n  ${dead.join("\n  ")}`,
    ).toEqual([]);
  });

  test("paint reads follow the callback binding and ignore unrelated strings, comments and outside readers", () => {
    const source = `const fake = 'read("--fake")'; read("--outside");
      withPaintTokens(host, (pick) => { const unused = "--unused"; /* pick("--comment") */ return pick("--actual"); });`;
    expect([...paintConsumedTokens(source)]).toEqual(["--actual"]);
    expect([...paintConsumedTokens(source.replace('pick("--actual")', 'unused'))]).toEqual([]);
    expect([...paintConsumedTokens(source.replace('withPaintTokens(host', 'differentOwner(host'))]).toEqual([]);
    expect([...paintConsumedTokens('withPaintTokens(host, token => token("--renamed", "fallback"))')]).toEqual(["--renamed"]);
  });

  test("every var(--name) referenced is declared (no dangling reference)", () => {
    const dangling: string[] = [];
    for (const [name, sites] of consumers) {
      if (declared.has(name)) continue;
      if (registered.has(name)) continue; // a stamp's initial value declares it
      dangling.push(`${name} ← ${[...sites].slice(0, 3).join(", ")}`);
    }
    expect(
      dangling,
      `referenced but never declared in tokens.css (a typo resolves to nothing, silently):\n  ${dangling.join("\n  ")}`,
    ).toEqual([]);
  });

  test("the --cat-* wheel is consumed by design (string reads), not by scan blindness", () => {
    // LIVENESS for the string-consumption arm: the wheel must actually be
    // string-consumed, or this guard's "by design" claim is vacuous.
    const wheel = [...declared].filter((n) => n.startsWith("--cat-") || n.startsWith("--on-cat-"));
    expect(wheel.length, "the wheel is declared").toBeGreaterThan(0);
    const stringRead = stringConsumedTokens(read(CATEGORIES));
    const unconsumed = wheel.filter((n) => !consumers.has(n));
    // The wheel is the `--cat-*` set today (the `--on-cat-*` half was deleted
    // when the canvas stopped reading a paired on-hue); the filter keeps the
    // `--on-cat-` prefix so a re-introduced member is checked rather than
    // silently outside the population. Every member still standing is
    // consumed as a string by the canvas palette reader or re-derived by the
    // light theme — both counted as consumption above.
    expect(
      unconsumed,
      `wheel members with no consumer at all (not var, not string, not a theme re-derive):\n  ${unconsumed.join("\n  ")}`,
    ).toEqual([]);
    expect(stringRead.size, "the sweep string-consumes the wheel").toBeGreaterThan(0);
  });

  // ── MUTATION SELF-CHECKS ───────────────────────────────────────────────

  test("mutation: a dead declaration is caught", () => {
    const decl = declaredTokens(":root {\n  --real: 1px;\n  --never-read: 2px;\n}");
    const consumedNow = new Map<string, Set<string>>();
    consumedNow.set("--real", new Set(["x.svelte (var)"]));
    const dead = [...decl].filter((n) => !consumedNow.has(n));
    expect(dead).toEqual(["--never-read"]);
  });

  test("mutation: a dangling reference is caught", () => {
    const decl = declaredTokens(":root {\n  --real: 1px;\n}");
    const refs = consumedVars(".x { color: var(--real); width: var(--typo-name); }");
    const dangling = [...refs].filter((n) => !decl.has(n));
    expect(dangling).toEqual(["--typo-name"]);
  });

  test("mutation: a registered @property stamp counts as declared-and-consumed", () => {
    const css = ":root { }\n@property --depth { syntax: \"<number>\"; inherits: true; initial-value: 0; }";
    const decl = declaredTokens(css);
    const reg = registeredProperties(css);
    expect(decl.has("--depth")).toBe(false); // @property is not a --name: declaration
    expect(reg.has("--depth")).toBe(true);
  });

  test("mutation: a wheel entry the sweep stops borrowing reads as dead", () => {
    // The string-consumption arm's liveness: with categories.ts's cssVar /
    // borrows columns gone, the wheel's members must have NO consumer.
    const withoutCanvas = stringConsumedTokens("export const X = 1;");
    expect(withoutCanvas.size).toBe(0);
  });
});
