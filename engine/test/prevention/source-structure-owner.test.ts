/**
 * THE STRUCTURAL SCOPE OWNER, DRIVEN — and its brand proven by the COMPILER.
 *
 * ── WHY THIS FILE IS IN THE HARNESS AND NOT IN THE WEB SUITE ─────────────
 *
 * The owner's ladder verdict used to say the brand is checked at RUN time
 * "because `tests/**` is in none of this repository's three tsconfig programs".
 * That is true of the WEB repository and false of this one, and the difference
 * was never measured: `integration/tsconfig.json` contains 1,114 first-party
 * files of which 444 are under `test/` — including this file. So a COMPILE-TIME
 * brand was available here the whole time and was not taken.
 *
 * It is taken now. {@link SourceScope} carries a MODULE-PRIVATE `unique symbol`
 * that no other module can name, so constructing one by hand is a type error in
 * every program that type-checks the owner. The `@ts-expect-error` lines below
 * are the proof, and they are self-invalidating in the right direction: if the
 * brand ever stops being enforced, `@ts-expect-error` becomes an unused
 * suppression and `npm run typecheck` FAILS. A comment claiming the brand works
 * would be documentation; this is the compiler asserting it.
 *
 * The runtime half stays, and stays for a stated reason rather than out of
 * caution: the web suite's guards really are outside its programs, so the
 * identity is ALSO held in a `WeakSet` only the owner writes to. Both halves are
 * driven below.
 *
 * ── AND WHY THE SPELLING TABLE MOVED ─────────────────────────────────────
 *
 * This file used to drive twenty spellings of a proximity window through a
 * DOOR that accepted a `RegExp` and refused the windowed ones. Three further
 * spellings walked through that door, because deciding "is this atom a
 * wildcard" needs a probe alphabet and an alphabet is a list. The door is gone.
 * The spellings are still driven, but at the estate SCAN — the only place a
 * pattern is still read as text — and the three that escape it are driven as
 * escapes, so the limit is measured rather than believed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  attributeOf,
  bodyBinds,
  bodyCalls,
  bodyCallsWith,
  bodyReturns,
  bodySays,
  callArgumentsOf,
  cssDeclares,
  cssRule,
  elementWithAttribute,
  bindingValueOf,
  enclosingFunctionOf,
  exportedBindings,
  functionBodies,
  functionBody,
  functionsCalling,
  isSourceScope,
  objectLiteralsWith,
  parseableRegionsOf,
  patternGapIn,
  regexLiteralsIn,
  sliceWindowsIn,
  windowGapIn,
  windowedPatternsIn,
  type SourceScope,
} from "../../src/shared/source-structure.ts";

const OWNER = "src/shared/source-structure.ts";

function readOwnerSource(relative: string): string {
  // BYTES, NEVER `grep`: first-party files in this tree carry legitimate NUL
  // bytes, and GNU grep treats such a file as binary — printing nothing and
  // exiting cleanly, which is a silently smaller universe.
  return readFileSync(relative, "utf8");
}

// ── 0. RUNG 2, ASSERTED STRUCTURALLY: NO DOOR TAKES A PATTERN ─────────────

/**
 * THE THREE WAYS AN EXPORTED BINDING CAN BE A PATTERN DOOR, as a function so
 * that a plant drives the same PATH the certification does rather than a
 * re-implementation of it.
 *
 * `exportedFunctionParameters` used to be the whole instrument, and it walked
 * only `export function` declarations. Fourteen door spellings were planted
 * into a copy of the real module and it saw FIVE: an `export const` arrow, an
 * `export { f }` specifier and an `export … from` re-export were invisible, and
 * each one demonstrably answered a proximity window `true` where the call graph
 * says `false`. The subject is now every exported binding by any form, and the
 * signature half is joined by a call-graph half, because a `pattern: string`
 * compiled with `new RegExp` inside has a spotless signature.
 */
function patternDoorsIn(source: string, what: string): readonly string[] {
  const faults: string[] = [];
  for (const [name, binding] of exportedBindings(source, what)) {
    // An export whose declaration is in another module is UNKNOWN, not absent.
    if (binding.kind === "elsewhere") { faults.push(`${name}: exported from a module this source cannot read`); continue; }
    if (binding.kind !== "function") continue;
    if (/\bRegExp\b/.test(binding.parameters)) faults.push(`${name}(${binding.parameters}): a pattern type in the signature`);
    else if (regexLiteralsIn(`function _(${binding.parameters}) {}`, what).length > 0) faults.push(`${name}(${binding.parameters}): a pattern literal in the signature`);
    // …and the door that BUILDS one. The module constructs a `RegExp` twice,
    // both inside `atomIsGap`, which is module-private — so "is the
    // constructing function exported" separates an internal use from a door
    // without anybody maintaining a list of which uses are allowed.
    if (binding.declaredAs !== undefined && bodyCalls(functionBody(source, binding.declaredAs, binding.declaredAs), "RegExp")) {
      faults.push(`${name}: builds a RegExp, so a window can arrive as a string`);
    }
  }
  return faults;
}

test("SourceStructure: NO exported door accepts a RegExp — the window is unsayable, not refused", () => {
  // THIS IS THE ACCEPTANCE INSTRUMENT FOR THE WHOLE STEP, and it is deliberately
  // a property of the owner's own EXPORT SURFACE rather than a list of door
  // names: a door added tomorrow fails this without anybody remembering to add
  // it anywhere, in any of the spellings below.
  //
  // The class this closes: two rounds were spent making a detector decide which
  // patterns were honest, and each round the detector's universe was wrong in a
  // new way — four known spellings, then a forty-character probe alphabet that
  // `[^￿]` walks straight through. With no pattern parameter there is
  // nothing to detect and no alphabet to be incomplete.
  const source = readOwnerSource(OWNER);
  const surface = exportedBindings(source, OWNER);
  assert.ok(surface.size >= 20, `exported bindings in the owner: ${surface.size}`);
  assert.deepEqual(patternDoorsIn(source, OWNER), [], "this module must offer no way to hand a pattern to a door");

  // LIVENESS — the instrument reads real signatures, and each of its three
  // properties really would fault. Planted INTO THE REAL FILE, because a plant
  // in a one-line fixture is a statement about the detector and this claim is a
  // statement about the verdict.
  assert.ok(surface.has("bodyCalls") && surface.has("functionBody"), "the doors must be among them");
  assert.match(surface.get("functionBody")!.parameters, /source: string/);
  const plants: readonly (readonly [string, string])[] = [
    ["an arrow binding", "export const plantedDoor = (scope: SourceScope, pattern: RegExp): boolean => false;"],
    ["a specifier over a local", "function plantedLocal(scope: SourceScope, pattern: RegExp): boolean { return false; }\nexport { plantedLocal as plantedDoor };"],
    ["a re-export from elsewhere", 'export { bodyMatches } from "./legacy-pattern-door.ts";'],
    ["a pattern LITERAL as a default", "export function plantedDoor(scope: SourceScope, pattern = /a[\\s\\S]{0,600}b/): boolean { return pattern.test(scope.body); }"],
    ["a string compiled inside", "export function plantedDoor(scope: SourceScope, pattern: string): boolean { return new RegExp(pattern).test(scope.body); }"],
  ];
  for (const [what, plant] of plants) {
    assert.ok(
      patternDoorsIn(`${source}\n\n${plant}\n`, `${OWNER} + ${what}`).length > 0,
      `a pattern door planted into the real module as ${what} must be caught`,
    );
  }
  assert.ok(plants.length >= 5, `door spellings planted into the real module: ${plants.length}`);
});

// ── 1. RUNG 3, BY THE COMPILER ────────────────────────────────────────────

test("SourceStructure: raw source cannot be handed to a door — a COMPILE error here", () => {
  const source = "export function target() {\n  return neighbour();\n}\n";

  // @ts-expect-error a string is not a SourceScope: the brand is a module-private
  // `unique symbol`, so no other module can even write the property.
  assert.throws(() => bodyCalls(source, "neighbour"), (e: unknown) => (e as { code?: string }).code === "source_structure_not_a_scope");

  // @ts-expect-error and the same for every other door, including the new ones.
  assert.throws(() => bodyCallsWith(source, "neighbour", []), (e: unknown) => (e as { code?: string }).code === "source_structure_not_a_scope");

  // @ts-expect-error an object of the right SHAPE is not a scope either, because
  // the branded property cannot be named from outside the owner.
  const forged: SourceScope = { kind: "function", name: "target", body: source, offset: 0 };
  assert.equal(isSourceScope(forged), false, "a hand-built object must not be recognised at runtime either");
});

test("SourceStructure: the brand cannot be forged at RUNTIME, by any route", () => {
  const wholeFile = "export function runGitConfined() { return spawnSync('git'); }\nfunction other() { return gitText(); }\n";
  const real = functionBody("function f() { g(); }", "f");

  const forgeries: readonly (readonly [string, unknown])[] = [
    // THE ROUTE THAT WORKED. The brand was `Symbol.for(…)` — the GLOBAL registry
    // — with the key written in the owner's own source, so any caller could
    // mint a scope in one line and hand whole-file text to the door built to
    // stop exactly that.
    ["the global symbol registry, with the old key", {
      [Symbol.for("tests/helpers/function-scope#SourceScope")]: true,
      kind: "function", name: "runGitConfined", body: wholeFile, offset: 0,
    }],
    ["a plain object of the right shape", { kind: "function", name: "x", body: wholeFile, offset: 0 }],
    ["a frozen object of the right shape", Object.freeze({ kind: "function", name: "x", body: wholeFile, offset: 0 })],
    ["a structural copy of a real scope", { ...real, body: wholeFile }],
    ["an object on a real scope's prototype", Object.create(Object.getPrototypeOf(real) as object)],
    ["a Proxy wrapping a real scope", new Proxy({ ...real, body: wholeFile }, {})],
    ["every own symbol of a real scope, copied", (() => {
      const copy: Record<PropertyKey, unknown> = { ...real, body: wholeFile };
      for (const s of Object.getOwnPropertySymbols(real)) copy[s] = (real as unknown as Record<PropertyKey, unknown>)[s];
      return copy;
    })()],
  ];

  for (const [how, forged] of forgeries) {
    assert.equal(isSourceScope(forged), false, `forgery must not be recognised: ${how}`);
    // EVERY door, not one: a forgery that reaches any of them reaches the
    // module, and the previous version drove only the pattern door.
    for (const [door, run] of [
      ["bodyCalls", () => bodyCalls(forged as SourceScope, "gitText")],
      ["bodyCallsWith", () => bodyCallsWith(forged as SourceScope, "gitText", [])],
      ["bodyBinds", () => bodyBinds(forged as SourceScope, "a", "b")],
      ["bodyReturns", () => bodyReturns(forged as SourceScope, "[]")],
      ["bodySays", () => bodySays(forged as SourceScope, "anything")],
      ["cssDeclares", () => cssDeclares(forged as SourceScope, "height", "0")],
      ["attributeOf", () => attributeOf(forged as SourceScope, "onclick")],
    ] as const) {
      assert.throws(
        run,
        (e: unknown) => (e as { code?: string }).code === "source_structure_not_a_scope",
        `forgery must not reach ${door}: ${how}`,
      );
    }
  }
  assert.ok(forgeries.length >= 7, `forge attempts driven: ${forgeries.length}`);

  // LIVENESS: the real scope still works, so the refusals above are refusals
  // and not an outage.
  assert.equal(bodyCalls(real, "g"), true);
});

// ── 2. THE EXTRACTOR, ON THE SHAPES THAT BROKE THE HAND-ROLLED ONE ────────

test("SourceStructure: the shapes that made a brace-matcher return a NEIGHBOUR", () => {
  const cases: readonly (readonly [string, string, string, string])[] = [
    // A union return type ending in a string literal made the real body look
    // like a type position, and the NEXT FUNCTION'S BODY came back.
    [`function target(v: unknown): "exact" | "prefix" {\n  return SAFE;\n}\nfunction neighbour(): void { DANGER(); }`,
      "target", "SAFE", "DANGER"],
    // An interface member is not an expression-bodied arrow; the RETURN TYPE
    // was coming back as the body.
    [`interface Crypto { open: (b: Buffer) => Buffer; }\nconst c = { open: (b: Buffer): Buffer => decodeSealed(b) };`,
      "open", "decodeSealed", "=>"],
    // An expression body ran past the comma that ends it.
    [`const o = { target: (x) => safe(x), other: (y) => DANGER(y) };`, "target", "safe(x)", "DANGER"],
    // An overload set resolves to the implementation.
    [`export function target(x: string): void;\nexport function target(x: number): void;\nexport function target(x: string | number): void {\n  SAFE(x);\n}\nfunction neighbour() { DANGER(); }`,
      "target", "SAFE", "DANGER"],
    // A default parameter value is not a body.
    [`export function target(t: string, o: Options = {}): R {\n  return SAFE(t, o);\n}`, "target", "SAFE", "Options"],
    // A generic return type carrying braces is not a body.
    [`export function target(r: string): Readonly<{ map: Map<string, string> }> {\n  return { map: SAFE(r) };\n}`,
      "target", "SAFE", "Readonly"],
    // A regular-expression literal containing braces does not end it early.
    [`function target(): void {\n  const re = /[}]{2,3}/;\n  SAFE(re);\n}\nfunction neighbour() { DANGER(); }`,
      "target", "SAFE", "DANGER"],
    // Nor does a template literal containing one.
    ["function target(): string {\n  return `a${\"}\"}b` + SAFE();\n}\nfunction neighbour() { DANGER(); }",
      "target", "SAFE", "DANGER"],
  ];
  for (const [source, name, contains, excludes] of cases) {
    const scope = functionBody(source, name);
    assert.ok(scope.body.includes(contains), `${name}: expected the body to contain ${contains}, got ${JSON.stringify(scope.body)}`);
    assert.ok(!scope.body.includes(excludes), `${name}: the body must not reach ${excludes}, got ${JSON.stringify(scope.body)}`);
  }
  assert.ok(cases.length >= 8, `parser fixtures driven: ${cases.length}`);
});

test("SourceStructure: a CLASS PRIVATE method is a named function, not an absent one", () => {
  // WIRED BUT INERT, in the module written to end that class. `declaredName`
  // accepted only `Identifier` and `StringLiteral` keys, and Babel gives a
  // private member a `PrivateName` — so `case "ClassPrivateMethod"` and
  // `case "ClassPrivateProperty"` could never record anything, and twenty-seven
  // private methods in these trees were refused by a module that carried two
  // branches claiming to handle them.
  const source = [
    "class Reader {",
    "  #consumeChunk(chunk: Buffer): void { PRIVATE_BODY(chunk); }",
    "  #buffered = (n: number) => PRIVATE_FIELD(n);",
    "  consumeChunk(chunk: Buffer): void { PUBLIC_BODY(chunk); }",
    "}",
  ].join("\n");
  assert.equal(bodyCalls(functionBody(source, "#consumeChunk"), "PRIVATE_BODY"), true);
  assert.equal(bodyCalls(functionBody(source, "#buffered"), "PRIVATE_FIELD"), true);
  // THE `#` IS PART OF THE NAME. A private member and a public sibling spelled
  // the same are two different members and must not collapse into one entry —
  // which is exactly the ambiguity the next test refuses.
  assert.equal(bodyCalls(functionBody(source, "consumeChunk"), "PUBLIC_BODY"), true);
  assert.equal(bodyCalls(functionBody(source, "consumeChunk"), "PRIVATE_BODY"), false);
});

test("SourceStructure: a name declared TWICE is refused, never silently answered", () => {
  // THE MUTATION THAT ESCAPED THE PREVIOUS VERSION. `collectFunctions` kept the
  // first declaration in source order and justified it on DETERMINISM — but
  // determinism was never the question. Here is the module's own headline
  // defect, reached through the tie-break instead of through a byte count: a
  // guard asserting "`runGitConfined` reaches `gitText`" returned TRUE while a
  // second `runGitConfined` in the same file spawned raw.
  const twice = [
    'const runGitConfined = () => gitText();',
    'export function reallyRun(): void {',
    '  const runGitConfined = () => rawSpawn();',
    '  runGitConfined();',
    '}',
  ].join("\n");

  assert.throws(
    () => functionBody(twice, "runGitConfined"),
    (e: unknown) => (e as { code?: string }).code === "source_structure_subject_ambiguous",
    "an ambiguous subject is UNKNOWN INPUT, and unknown input is an error rather than a silent default",
  );
  // …and the message names BOTH, so the reader can see what they were choosing
  // between rather than being told to look.
  try {
    functionBody(twice, "runGitConfined");
    assert.fail("expected a refusal");
  } catch (e) {
    assert.match((e as Error).message, /declared 2 times/);
    assert.match((e as Error).message, /at offsets \d+, \d+/);
  }

  // THE PLURAL DOOR is what makes the refusal affordable: a caller who means
  // "all of them" says so, and then the second declaration cannot be silently
  // exempt.
  const all = functionBodies(twice, "runGitConfined");
  assert.equal(all.length, 2, "both declarations must be offered");
  assert.equal(all.some((scope) => bodyCalls(scope, "gitText")), true);
  assert.equal(all.some((scope) => bodyCalls(scope, "rawSpawn")), true, "the raw one must be visible, not hidden behind the first");
  // The plural door is still not a vacuous one.
  assert.throws(
    () => functionBodies(twice, "neverDeclared"),
    (e: unknown) => (e as { code?: string }).code === "source_structure_subject_absent",
  );
  // A name declared ONCE is not ambiguous, so nothing was made harder.
  assert.equal(bodyCalls(functionBody(twice, "reallyRun"), "runGitConfined"), true);
});

test("SourceStructure: a subject that has vanished is a FAILURE, never a clean verdict", () => {
  // THE VACUOUS-SCAN CLASS, closed at the helper rather than at each caller.
  for (const [what, run] of [
    ["an absent function", () => functionBody("const x = 1;", "missingFunction")],
    ["a declaration with no body", () => functionBody("interface I { open: (b: Buffer) => Buffer; }", "open")],
    ["an absent CSS rule", () => cssRule(".a { color: red; }", ".b")],
    ["an absent element", () => elementWithAttribute("<div />", "data-nope")],
    ["an absent attribute", () => attributeOf(elementWithAttribute('<button title="x">', "title"), "onclick")],
  ] as const) {
    assert.throws(run, (e: unknown) => (e as { code?: string }).code === "source_structure_subject_absent", what);
  }
  // …and a source that is neither TypeScript nor a component says so, rather
  // than answering from a guess.
  assert.throws(
    () => functionBody("this is not code at all ((( ", "anything"),
    (e: unknown) => (e as { code?: string }).code === "source_structure_unparsable",
  );
});

test("SourceStructure: bodyCalls asks the CALL GRAPH, so a comment is not a call", () => {
  const source = [
    "function target(): void {",
    "  // this used to runGitConfined(argv) before the confinement work",
    '  const note = "spawnSync(argv)";',
    "  return gitText(note);",
    "}",
  ].join("\n");
  const scope = functionBody(source, "target");
  assert.equal(bodyCalls(scope, "gitText"), true, "a real call is a call");
  assert.equal(bodyCalls(scope, "runGitConfined"), false, "a name in a COMMENT is not a call");
  assert.equal(bodyCalls(scope, "spawnSync"), false, "a name in a STRING is not a call");
  // A longer identifier merely ending in the callee is not the callee.
  assert.equal(bodyCalls(functionBody("function t() { spawnRawGit(); }", "t"), "rawGit"), false);
  // A dotted path is one name, whitespace and all.
  assert.equal(bodyCalls(functionBody("function t() { db\n  .getProject(1); }", "t"), "db.getProject"), true);
  // A stylesheet has no call graph, and saying so beats answering from its text.
  assert.throws(
    () => bodyCalls(cssRule(".a { color: red; }", ".a"), "red"),
    (e: unknown) => (e as { code?: string }).code === "source_structure_not_a_scope",
  );
});

// ── 3. THE DOORS THAT REPLACED THE PATTERN, EACH STRICTER THAN WHAT IT REPLACED ─

test("SourceStructure: bodyCallsWith compares arguments the PARSER delimited", () => {
  const source = [
    "function target(): void {",
    "  detectSecretSpans(redactedText, policy);",
    "  advanceWait(\"answering\");",
    "  wrapped(outer(a, b), second);",
    "}",
    "function neighbour(): void { detectSecretSpans(originalText, policy); }",
  ].join("\n");
  const scope = functionBody(source, "target");

  assert.equal(bodyCallsWith(scope, "detectSecretSpans", ["redactedText"]), true);
  // THE CLAIM THAT A CALL-NAME CHECK CANNOT MAKE, and the one the pattern was
  // reached for: the verifier must inspect the REDACTED text.
  assert.equal(bodyCallsWith(scope, "detectSecretSpans", ["originalText"]), false, "the neighbour's argument must not answer");
  assert.equal(bodyCallsWith(scope, "advanceWait", ['"answering"']), true);
  assert.equal(bodyCallsWith(scope, "advanceWait", ['"connected"']), false);
  // A NESTED CALL IS ONE ARGUMENT. `[^)]*` stopped at the first `)`, so
  // `wrapped(outer(a, b), second)` read as taking `outer(a, b` — every claim
  // about such a call was quietly a claim about a truncated string.
  assert.equal(bodyCallsWith(scope, "wrapped", ["outer(a,b)", "second"]), true);
  // A PREFIX OF ONE CALL, never assembled across two.
  const split = functionBody("function t() { f(a); f(b); }", "t");
  assert.equal(bodyCallsWith(split, "f", ["a"]), true);
  assert.equal(bodyCallsWith(split, "f", ["a", "b"]), false, "two separate calls must not combine into one argument list");
  // Whitespace is not part of an argument.
  assert.equal(bodyCallsWith(functionBody("function t() { f(a,\n  b); }", "t"), "f", ["a", "b"]), true);
  // A callee named only in a comment or a string is still not a call.
  assert.equal(bodyCallsWith(functionBody('function t() { const s = "f(a)"; }', "t"), "f", ["a"]), false);
});

test("SourceStructure: bodyBinds reads the four ways source relates two names", () => {
  for (const [what, source, name, to] of [
    ["a destructuring rename", "function t() { const { cursor: _cursor, ...rest } = current; }", "cursor", "_cursor"],
    ["an object literal property", "function t() { return send({ cursor: _cursor }); }", "cursor", "_cursor"],
    ["an assignment", "function t() { entries = listing; }", "entries", "listing"],
    ["a declaration", "function t() { const entries = listing; }", "entries", "listing"],
  ] as const) {
    assert.equal(bodyBinds(functionBody(source, "t"), name, to), true, what);
  }
  // …and it is a relation, not a containment test: the wrong pairing is false.
  assert.equal(bodyBinds(functionBody("function t() { const { cursor: held } = c; }", "t"), "cursor", "_cursor"), false);
  // A neighbour's binding does not answer for this body.
  const two = "function target() { const a = SAFE; }\nfunction neighbour() { const a = DANGER; }";
  assert.equal(bodyBinds(functionBody(two, "target"), "a", "SAFE"), true);
  assert.equal(bodyBinds(functionBody(two, "target"), "a", "DANGER"), false);
});

test("SourceStructure: bodyReturns is EXACT, so a fallback is not an empty listing", () => {
  assert.equal(bodyReturns(functionBody("function t() { return []; }", "t"), "[]"), true);
  assert.equal(bodyReturns(functionBody("function t() { return [fallback]; }", "t"), "[]"), false,
    "`return [fallback]` is not `return []`, and a containment test would have called it one");
  assert.equal(bodyReturns(functionBody("function t() { return; }", "t"), ""), true, "a bare return is a real answer");
  assert.equal(bodyReturns(functionBody("function t() { const x = []; }", "t"), "[]"), false, "a binding is not a return");
});

test("SourceStructure: bodySays reads emitted STRINGS, never a comment about them", () => {
  const emits = 'function t() { report("beats do not carry this id"); }';
  const claims = 'function t() { /* reports that beats do not carry it */ report(code); }';
  assert.equal(bodySays(functionBody(emits, "t"), "beats do not carry"), true);
  assert.equal(bodySays(functionBody(claims, "t"), "beats do not carry"), false,
    "a comment claiming the handler explains itself is not the handler explaining itself");
  assert.equal(bodySays(functionBody("function t() { report(`a ${x} carried`); }", "t"), "carried"), true,
    "a template literal is a string this body says");
});

test("SourceStructure: cssDeclares reads ONE rule's declaration list", () => {
  const sheet = [
    ".mine .options {",
    "  justify-content: flex-end;",
    "  padding-left: var(--sp-1);",
    "}",
    ".theirs .options {",
    "  justify-content: flex-start;",
    "}",
    ".outer {",
    "  color: red;",
    "  @media (min-width: 40rem) { height: 0; }",
    "}",
  ].join("\n");
  assert.equal(cssDeclares(cssRule(sheet, ".mine .options"), "justify-content", "flex-end"), true);
  // THE NEIGHBOUR, WHICH THE WINDOW ACCEPTED. The retired form ran past the
  // closing brace, so the NEXT rule's declaration satisfied it.
  assert.equal(cssDeclares(cssRule(sheet, ".mine .options"), "justify-content", "flex-start"), false);
  // A value with parentheses is one value.
  assert.equal(cssDeclares(cssRule(sheet, ".mine .options"), "padding-left", "var(--sp-1)"), true);
  // A NESTED BLOCK'S declarations are not this rule's.
  assert.equal(cssDeclares(cssRule(sheet, ".outer"), "height", "0"), false,
    "a declaration inside a nested block belongs to that block, not to the rule containing it");
  assert.equal(cssDeclares(cssRule(sheet, ".outer"), "color", "red"), true);
  // A LONGER PROPERTY NAME IS A DIFFERENT PROPERTY, which a substring pattern
  // could not say.
  const heights = ".box { max-height: 0; }";
  assert.equal(cssDeclares(cssRule(heights, ".box"), "height", "0"), false);
  assert.equal(cssDeclares(cssRule(heights, ".box"), "max-height", "0"), true);
  // A grouped selector still names its rule.
  const grouped = ".a .options,\n  .b .options {\n  height: 0;\n}";
  assert.equal(cssDeclares(cssRule(grouped, ".a .options"), "height", "0"), true);
  assert.equal(cssDeclares(cssRule(grouped, ".b .options"), "height", "0"), true);
  // …and a function scope is not a rule.
  assert.throws(
    () => cssDeclares(functionBody("function f() { }", "f"), "height", "0"),
    (e: unknown) => (e as { code?: string }).code === "source_structure_not_a_scope",
  );
});

test("SourceStructure: attributeOf bounds ONE attribute, and parses the code inside it", () => {
  const template = [
    '<button class="beat-grip" data-chord-target="open-scope" title={tOpen}',
    '  onclick={(e) => { e.stopPropagation(); onopenbeat(beat.id); }}',
    '>scope</button>',
    '<button onclick={() => otherThing(beat.id)}>other</button>',
  ].join("\n");
  const element = elementWithAttribute(template, 'data-chord-target="open-scope"');

  const handler = attributeOf(element, "onclick");
  assert.equal(bodyCallsWith(handler, "onopenbeat", ["beat.id"]), true);
  // THE NEIGHBOURING ELEMENT'S HANDLER MUST NOT ANSWER.
  assert.equal(bodyCalls(handler, "otherThing"), false);
  // A quoted value is text, compared exactly — so a longer value is a
  // different value, which a pattern could not say.
  assert.equal(attributeOf(element, "class").body, "beat-grip");
  assert.equal(attributeOf(elementWithAttribute('<Banner kind="error-ish" />', "<Banner"), "kind").body, "error-ish");
  // A PREFIX OF AN ATTRIBUTE NAME IS NOT THE ATTRIBUTE. `on` must not find
  // `onclick`, or the scope would be a different attribute's value.
  assert.throws(
    () => attributeOf(element, "on"),
    (e: unknown) => (e as { code?: string }).code === "source_structure_subject_absent",
  );
  // A bare attribute exists and says nothing — a different fact from absence.
  assert.equal(attributeOf(elementWithAttribute("<input disabled />", "disabled"), "disabled").body, "");
  // An element is not a function scope.
  assert.throws(
    () => attributeOf(functionBody("function f() { }", "f"), "onclick"),
    (e: unknown) => (e as { code?: string }).code === "source_structure_not_a_scope",
  );
});

test("SourceStructure: objectLiteralsWith reads fields by name, through the wrappers real code uses", () => {
  const source = [
    'const tool = deepFreeze({',
    '  type: "function",',
    '  function: deepFreeze({ name: "git_status", parameters: deepFreeze({ type: "object" }) }),',
    '});',
    'const other = { type: "resource", function: { name: "not_a_tool" } };',
  ].join("\n");
  const found = objectLiteralsWith(source, "type", "function", "fixture");
  assert.equal(found.length, 1, "only the literal that DECLARES the discriminant is in the population");
  assert.equal(found[0]!.get("function.name"), "git_status");
  // A NESTED LITERAL'S PROPERTY IS ADDRESSED BY PATH, so a container is never
  // confused with what it holds — the question the pattern door answered by
  // blanking nested spans and matching a second time.
  assert.equal(found[0]!.get("function.parameters.type"), "object");
  assert.equal(found[0]!.get("name"), undefined, "the outer literal has no `name` of its own");
  assert.equal(objectLiteralsWith(source, "type", "resource", "fixture").length, 1);
});

// ── 4. RUNG 5: THE ESTATE SCAN, AND THE HONEST LIMIT OF ITS ALPHABET ──────

test("SourceStructure: the estate scan recognises every spelling of a window it can lex", () => {
  // These are patterns as TEXT, because that is all the scan ever sees — it
  // reads guard source and can never run what it finds. Nothing here knows a
  // spelling by name; each is found by RUNNING the atom against a probe
  // alphabet.
  const recognised: readonly string[] = [
    String.raw`a[\s\S]{0,600}b`, String.raw`a[^]{0,600}b`, String.raw`a.{0,600}b`,
    String.raw`a[\s\S]{1,600}b`, String.raw`a[\S\s]{0,600}b`, String.raw`a[\d\D]{0,600}b`,
    String.raw`a[\w\W]{0,600}b`, String.raw`a(?:.|\n){0,600}b`, String.raw`a[^\n]{0,600}b`,
    String.raw`a[\s\S]{600}b`, String.raw`a(?:[\s\S]){0,600}b`, String.raw`a[\0-￿]{0,600}b`,
    String.raw`a[\x00-￿]{0,600}b`, String.raw`a(.|[\r\n]){0,600}b`, String.raw`a[\s\S]{2}b`,
    String.raw`a[\S\s]{0,600}?b`, String.raw`a[^￰]{0,600}b`,
    // THE GREEDY UNBOUNDED SHAPES, newly judged. These are the same guess with
    // the number left off, and the previous version exempted every one of them
    // on the argument that they were "almost all comment strippers".
    String.raw`a[\s\S]*b`, String.raw`a.+b`, String.raw`unhandledRejection[\s\S]*webConsoleError`,
  ];
  for (const spelling of recognised) {
    assert.notEqual(windowGapIn(spelling), undefined, `must be recognised: ${spelling}`);
  }
  assert.ok(recognised.length >= 20, `window spellings driven at the scan: ${recognised.length}`);

  // CLEAN CONTROLS — a quantifier bounding a concrete token, and the two shapes
  // an extractor is correctly written with.
  for (const clean of [
    String.raw`^[0-9a-f]{6,64}$`,
    String.raw`^[A-Z]{2,4}-\d+$`,
    // LAZY AND DELIMITER-BOUNDED: the comment stripper. The `*` then the
    // closing delimiter is the construct's real end, not a guessed distance.
    String.raw`\/\*[\s\S]*?\*\/`,
    // NO SECOND ANCHOR: this runs to the end of the line and stops, so there is
    // no other thing it claims to be near and no neighbour that can satisfy it.
    String.raw`\/\/[^\n]*`,
    // A regular-expression escaper's own class. It contains a literal `[`,
    // which a depth-counting lexer reads as an unclosed class and then
    // mis-lexes the `.` after it as a wildcard — measured at eleven false
    // accusations across the two guard trees before classes were closed at the
    // first `]`. (Written as a concatenation because a `${` opens a
    // substitution.)
    "[.*+?^$" + String.raw`{}()|[\]\\]`,
    String.raw`onclick=\{[^}]*onopenbeat\(beat\.id\)`,
    String.raw`detectSecretSpans\(text, policy, options\)`,
  ]) {
    assert.equal(windowGapIn(clean), undefined, `must not be flagged: ${clean}`);
  }

  // LIVENESS FOR THE LEXER: a class that really is a wildcard, written
  // immediately after one containing a `[`, is still found.
  assert.notEqual(windowGapIn(String.raw`[a[b]x[\s\S]{0,9}y`), undefined);
});

test("SourceStructure: the scan's alphabet is INCOMPLETE, and here is exactly how", () => {
  // A UNIVERSE WITH A STATED EDGE IS STILL A UNIVERSE, so the edge is measured
  // rather than described. This class was declared closed twice by making the
  // detector's list better; each time a spelling walked through. These three do
  // so today, and this test exists so that stays a KNOWN fact:
  //
  //   * `[^￿]` excludes exactly the last probe character, so the atom is
  //     not seen to admit everything — though it admits everything anybody
  //     would ever match. The published table's own twentieth spelling,
  //     `[^￰]`, sits ONE CODE POINT away and IS caught.
  //   * `\p{Any}` is lexed as `\p` followed by a literal `{Any}`, so the real
  //     quantifier is never associated with the atom.
  //   * a group needing three characters is tested against single ones.
  //
  // The structural answer is not a longer alphabet — that is the same list one
  // round later. It is that no door in this module accepts a pattern at all,
  // which the first test in this file asserts. This scan is the floor beneath
  // that, for guards which never import the owner, and it is stated as such.
  const escapes: readonly string[] = [
    String.raw`a[^￿]{0,600}b`,
    String.raw`a\p{Any}{0,600}b`,
    String.raw`a(?:[\s\S][\s\S][\s\S]){0,200}b`,
  ];
  for (const escape of escapes) {
    assert.equal(
      windowGapIn(escape), undefined,
      `this spelling is KNOWN to escape the scan; if it is now caught, delete it from this list deliberately: ${escape}`,
    );
  }
  assert.equal(escapes.length, 3, `known escapes from the estate scan: ${escapes.length}`);
});

test("SourceStructure: the scan classifies a wildcard run rather than judging its spelling", () => {
  // The three facts the verdict is built from, each driven on its own, so a
  // change to the POLICY is visible separately from a change to the LEXING.
  const bounded = patternGapIn(String.raw`a[\s\S]{0,600}b`);
  assert.equal(bounded?.bounded, true);
  assert.equal(bounded?.greedy, true);
  assert.equal(bounded?.anchored, true);

  const lazyDelimited = patternGapIn(String.raw`\/\*[\s\S]*?\*\/`);
  assert.equal(lazyDelimited?.bounded, false);
  assert.equal(lazyDelimited?.greedy, false, "a trailing `?` makes the run stop at the first delimiter");
  assert.equal(lazyDelimited?.anchored, true);

  const trailing = patternGapIn(String.raw`\/\/[^\n]*`);
  assert.equal(trailing?.anchored, false, "nothing follows it, so there is no second thing it claims to be near");

  // THE DELIMITER FACT, which stops the lazy exemption being a blanket one.
  // Exempting every lazy run would repeat the greedy mistake one spelling over.
  assert.equal(lazyDelimited?.delimited, true, "a comment stripper closes on its own delimiter");
  const lazyClaim = patternGapIn(String.raw`router\.put\([\s\S]*?requireAdminContext\(`);
  assert.equal(lazyClaim?.greedy, false, "it is lazy");
  assert.equal(lazyClaim?.anchored, true, "…and it does have a second anchor");
  assert.equal(lazyClaim?.delimited, false,
    "…which is a NAME, so this is a distance claim written lazily, not an extractor");
  // The rule is a PROPERTY, not a list of delimiter characters: the first
  // draft was a list and called `-->` a second anchor because `-` was not in it.
  assert.equal(patternGapIn(String.raw`<!--[\s\S]*?-->`)?.delimited, true, "`-->` closes the construct");
  assert.equal(patternGapIn(String.raw`f\([\s\S]*?\n\}`)?.delimited, true, "a newline and a brace close it");
  assert.equal(patternGapIn(String.raw`\.panel[\s\S]*?width:\s*var\(--x\)`)?.delimited, false, "`width` is a name");

  // …and a bounded run is a window even when lazy, because the NUMBER is the
  // guess whatever the laziness.
  assert.notEqual(windowGapIn(String.raw`a[\s\S]{0,600}?b`), undefined);
});

test("SourceStructure: the estate detector reads PARSED patterns, so prose is not a finding", () => {
  // A TEXT SCAN CANNOT TELL `/a.{0,9}b/` FROM A COMMENT ABOUT `console.*`.
  // Measured across the two guard trees: forty such comment lines.
  assert.deepEqual(
    windowedPatternsIn("// the owner is the single console.* choke point\nconst x = 1;\n", "prose"),
    [],
  );
  assert.equal(windowedPatternsIn('const re = /openDoor[\\s\\S]{0,600}closeDoor/;\n', "literal").length, 1);
  assert.equal(
    windowedPatternsIn('const re = new RegExp("openDoor[\\\\s\\\\S]{0,600}closeDoor");\n', "constructed").length,
    1,
    "a window built with `new RegExp` is the same window",
  );
  // THE POPULATION THE SCAN READ, not only the findings it reported. A scan
  // that reports zero offenders cannot otherwise tell "nothing is wrong" from
  // "nothing was read", and the estate's liveness check used to be
  // `expect(patternsRead).toBe(offenders.length)` — two counters incremented in
  // the same iteration, an assertion that could not fail in any state of the
  // world.
  const literals = regexLiteralsIn('const a = /x/; const b = new RegExp("y"); const c = "not a pattern";', "fixture");
  assert.equal(literals.length, 2, "both a literal and a constructed pattern are patterns; a string is not");
  assert.deepEqual(literals.map((l) => l.pattern), ["x", "y"]);
});

// ── 5. THE OTHER STRUCTURAL ANSWERS, DRIVEN ON THIS REPOSITORY'S OWN SOURCE ─

test("SourceStructure: the remaining doors answer over real source, with populations", () => {
  const source = readOwnerSource(OWNER);

  const callers = functionsCalling(source, "atomIsGap");
  assert.ok(callers.length >= 1, `functions calling atomIsGap: ${callers.length}`);

  const args = callArgumentsOf(source, "issueScope", OWNER);
  assert.ok(args.length >= 4, `calls to issueScope: ${args.length}`);

  const literals = objectLiteralsWith(source, "attachComment", "false", OWNER);
  assert.ok(literals.length >= 1, `object literals declaring attachComment: ${literals.length}`);

  // THE OWNER'S OWN PATTERN POPULATION, as a runtime number.
  assert.ok(regexLiteralsIn(source, OWNER).length >= 5, `regex literals in the owner: ${regexLiteralsIn(source, OWNER).length}`);

  // A `.ts` source is ONE region at offset zero; a component is its script
  // blocks. Five first-party `.ts` files contain the text `<script` inside a
  // string literal, so the split is decided by the parser rather than by a tag.
  const regions = parseableRegionsOf(source, OWNER);
  assert.equal(regions.length, 1);
  assert.equal(regions[0]!.offset, 0);
  const component = parseableRegionsOf('<script lang="ts">\n  const a = 1;\n</script>\n<div />\n', "component");
  assert.equal(component.length, 1);
  assert.ok(component[0]!.offset > 0, "a component's script block does not start at zero");
});

// ── 6. THE THREE DOORS THE WINDOW CLASSES NEEDED, DRIVEN ──────────────────

test("SourceStructure: bindingValueOf bounds a constant's VALUE, and refuses an ambiguous name", () => {
  // THE NEIGHBOUR THAT SATISFIED THE RETIRED FORM. A guard asked for the text
  // between a name and the next thing that looks like the end of its value:
  // `/const bestExtractor[\s\S]*?\.name\s*\?\?\s*"none"/`. With a SIBLING
  // declared above it the lazy run stops early, the region is the wrong
  // declaration, and the verdict flips.
  const neighbour = 'const bestTrigger = pick(triggers)?.name ?? "none";\nconst bestExtractor = pick(extraction)?.name ?? "none";\n';
  const retired = /const bestExtractor[\s\S]*?\.name\s*\?\?\s*"none"/.exec(neighbour);
  assert.ok(retired !== null && retired[0].includes("bestExtractor"), "the retired window must match, or this proves nothing");
  const scoped = bindingValueOf(neighbour, "bestExtractor");
  assert.equal(scoped.body, 'pick(extraction)?.name ?? "none"');
  assert.equal(scoped.body.includes("triggers"), false, "the neighbour's initializer must be outside this scope");

  // THE FACTS ARE THE VALUE'S OWN, so a caller can ask the call graph as well
  // as read the text.
  assert.equal(bodyCalls(scoped, "pick"), true);

  // AN ABSENT NAME AND AN AMBIGUOUS ONE ARE BOTH REFUSED, with their own codes:
  // an empty answer for a vanished constant is the vacuous-scan defect, and
  // answering about one of two declarations is how a neighbour satisfies a claim.
  assert.throws(
    () => bindingValueOf("const other = 1;", "gone"),
    (e: unknown) => (e as { code?: string }).code === "source_structure_subject_absent",
  );
  assert.throws(
    () => bindingValueOf("const a = 1;\nfunction f() { const a = 2; return a; }", "a"),
    (e: unknown) => (e as { code?: string }).code === "source_structure_subject_ambiguous",
  );
});

test("SourceStructure: enclosingFunctionOf answers with the INNERMOST construct, and with nothing at top level", () => {
  const source = 'test("outer", () => {\n  const inner = () => {\n    INNER_MARK();\n  };\n  OUTER_MARK(inner);\n});\n';

  // AN ANONYMOUS TEST BODY IS THE SUBJECT a guard means, and no named-function
  // door can reach it — which is why the safety guard was using a sixty-line
  // window instead.
  const outer = enclosingFunctionOf(source, source.indexOf("OUTER_MARK"));
  assert.ok(outer !== undefined, "a call inside a test body must have an enclosing construct");
  assert.equal(bodyCalls(outer, "OUTER_MARK"), true);

  // INNERMOST WINS: a callback inside a test body is a different subject from
  // the test body, and answering with the outer one turns a claim about the
  // callback into a claim about everything around it.
  const inner = enclosingFunctionOf(source, source.indexOf("INNER_MARK"));
  assert.ok(inner !== undefined);
  assert.equal(inner.body.trim(), "INNER_MARK();");
  assert.equal(bodyCalls(inner, "OUTER_MARK"), false, "the outer call must be outside the inner construct");

  // TOP LEVEL IS A REAL ANSWER, and a caller must read it as "inside nothing"
  // rather than as "inside something that is fine".
  assert.equal(enclosingFunctionOf("const a = 1;\nB();\n", 13), undefined);
});

test("SourceStructure: sliceWindowsIn sees a window built out of ARITHMETIC, and only that", () => {
  // THE UNIVERSE THE PATTERN SCAN COULD NOT REACH. `src.slice(fnStart, fnStart
  // + 2000)` is this estate's headline claim with no pattern in it at all, so
  // removing the pattern door never touched it.
  const found = sliceWindowsIn('const body = src.slice(fnStart, fnStart + 2000);', "planted");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.extent, 2000);
  assert.match(found[0]!.text, /slice\(fnStart, fnStart \+ 2000\)/);

  // …AND THE SHAPE IS WHAT IDENTIFIES IT, not a heuristic about the number.
  // A slice between two FOUND positions bounds nothing by distance; a
  // truncation has no start expression to repeat; a different start makes it a
  // range rather than a radius. All three must stay out of the population, or
  // the ceiling in the estate scan would be measuring ordinary code.
  assert.deepEqual(sliceWindowsIn("const a = s.slice(i, j);", "p"), []);
  assert.deepEqual(sliceWindowsIn("const a = s.slice(0, 60);", "p"), []);
  assert.deepEqual(sliceWindowsIn("const a = s.slice(i, k + 600);", "p"), []);

  // The owner's own source contains none — stated as a runtime number rather
  // than assumed, because a detector whose population is empty everywhere it
  // is pointed proves nothing.
  assert.deepEqual(sliceWindowsIn(readOwnerSource(OWNER), OWNER).filter((w) => w.extent >= 10), []);
});

test("SourceStructure: a fact from outside the scope is REFUSED, not answered", () => {
  // THE CHOKE POINT BEHIND THE SUBJECT TYPE. The type stops a caller and every
  // other module from handing the fact reader a node wider than the body; this
  // is what stops the owner's own next author from doing it, and it is the
  // general form of three separate defects — a fact from a default parameter, a
  // fact from a decorator or a computed key, and a whole fact set copied from a
  // neighbouring function.
  //
  // Driven through the doors on the shape that produced the live bug: the body
  // must not answer for the signature.
  const source = 'export function target(run: R = (a) => LEAKED(a)) {\n  return run(1);\n}\n';
  const scope = functionBody(source, "target");
  assert.equal(scope.body.includes("LEAKED"), false, "the signature is not the body");
  assert.equal(bodyCalls(scope, "LEAKED"), false, "and the doors must agree with the body they hand back");
  assert.equal(bodyCalls(scope, "run"), true, "the body's own call must still be visible");
});
