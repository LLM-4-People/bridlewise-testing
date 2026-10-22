// @vitest-environment node
/**
 * THE STRUCTURAL EXTRACTOR IS DIFFERENTIATED AGAINST A SECOND PARSER, OVER
 * EVERY NAMED FUNCTION IN BOTH PRODUCTION TREES — ITS REGIONS *AND* ITS
 * ANSWERS.
 *
 * ── A CORRECT REGION IS NOT A CORRECT ANSWER ──────────────────────────────
 *
 * This file certified the extractor's spans at ZERO disagreements over 6,481
 * names, and it was true, and the module was still wrong. `commitFilesByHash`
 * got exactly the right body span and then answered `bodyCalls(scope,
 * "gitText")` with TRUE about a body that does not contain the text `gitText` —
 * because the FACTS were read from the whole function node, which includes the
 * default parameter `run: GitRunner = (args) => gitText(repoPath, args)`.
 * Nineteen callees across the two trees were answerable that way.
 *
 * A differential that compares SPANS is silent about everything DERIVED from
 * them, so an instrument certifying the INPUT said nothing about the OUTPUT.
 * The planted mutation "compute each function's facts and hand back the FIRST
 * function's" passed this file untouched, because it moves no span at all.
 *
 * So the differential has two arms and they answer different questions:
 *
 *   REGION — is `scope.body` the same bytes the compiler calls the body?
 *   ANSWER — is the set of callees the DOORS report the same set the compiler
 *            finds INSIDE those bytes, and does it EXCLUDE every callee the
 *            compiler finds in the function but outside them?
 *
 * The second arm is the one with teeth against the whole family "a fact drawn
 * from something wider than the scope": a default parameter, a decorator, a
 * computed key, a return-type object literal, a neighbouring function.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * The first version of `functionBody` walked a signature character by character
 * and balanced braces to find the body. It was driven over the sixteen call
 * sites it converted and printed what it extracted, exactly as required — and
 * ALL SIXTEEN WERE RIGHT, which is precisely why nobody could see that it was
 * returning the WRONG REGION for 212 of the 6,512 named functions in these two
 * trees and refusing 309 more that do have bodies. The converted sites are
 * ordinary `export function` declarations with block bodies: the easy ninety
 * per cent. A helper that returns a wrong region is worse than the window it
 * replaces, because it looks structural, and one of those wrong regions was
 * literally A NEIGHBOURING FUNCTION'S BODY — the very defect the module exists
 * to remove, wearing a parser's clothes.
 *
 * So "drive it over its call sites" is not enough for a helper that replaces a
 * mechanism. The acceptance criterion is a DIFFERENTIAL AGAINST THE INSTRUMENT
 * THAT ALREADY HAD TO BE CORRECT, over the whole corpus. The extractor is built
 * on `@babel/parser` (the harness's own parser, used by six production
 * modules); this test judges it with TypeScript's own compiler, a completely
 * independent implementation that is a declared devDependency of this
 * repository. Two parsers written by different people agreeing on 6,500+ spans
 * is evidence; one parser agreeing with itself is not.
 *
 * ── COST, MEASURED ────────────────────────────────────────────────────────
 *
 * The whole differential parses ~850 first-party files twice (once per parser,
 * ~9.6 MB) and asks about ~6,500 names. Measured at ~1.9 s of work, well inside
 * the per-file pool-share cap. The extractor caches its parse by source content,
 * so the 6,500 questions cost 850 parses rather than 6,500.
 */
import { describe, test, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

import {
  bodyBinds,
  bodyCalls,
  bodyReturns,
  bodySays,
  functionArgumentsOf,
  bodyCallsWith,
  functionBodies,
  functionBody,
  type SourceScope,
} from "../helpers/function-scope.ts";

// TypeScript 5, aliased in package.json as `typescript5`, is the SECOND parser.
// It is not what the extractor uses and it is not what type-checks this repo;
// its only job here is to disagree if it can.
const ts = createRequire(import.meta.url)("typescript5") as typeof import("typescript5");

// The compiler's node types, derived from the VALUE rather than named through a
// namespace: `ts` here is a `createRequire` binding, so `ts.Node` is a property
// access and not a type. Deriving the two shapes this file needs from functions
// the value exposes keeps the annotations honest without a second import.
type TsNode = Parameters<typeof ts.forEachChild>[0];
type TsSourceFile = ReturnType<typeof ts.createSourceFile>;
// The same derivation for the shapes the compiler view annotates below —
// type queries against the aliased module, never the runtime binding.
type TsArrowFunction = import("typescript5").ArrowFunction;
type TsFunctionExpression = import("typescript5").FunctionExpression;
type TsFunctionLikeDeclaration = import("typescript5").FunctionLikeDeclaration;

const HARNESS = join("engine");

/** Both repositories' PRODUCTION trees — the corpus the guards make claims about. */
const PRODUCTION_TREES = [
  join(HARNESS, "src"),
  "src",
  "server",
  "shared",
] as const;

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".vite", ".bridlewise", "fixtures"]);

function walkTree(dir: string, matches: (name: string) => boolean, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTree(full, matches, out);
    else if (entry.isFile() && matches(entry.name)) out.push(full);
  }
  return out;
}

function productionFiles(matches: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const tree of PRODUCTION_TREES) {
    // A TREE THAT DOES NOT EXIST IS NOT AN EMPTY TREE. A corpus whose root is
    // missing produces zero disagreements and reports it as agreement, which is
    // the vacuous universe this whole estate exists to refuse.
    expect(statSync(tree).isDirectory(), `${tree} must be a directory — a missing corpus root is not an empty one`).toBe(true);
    walkTree(tree, matches, out);
  }
  return out;
}

/**
 * One declaration, as the compiler sees it: where its body is, AND what it
 * calls on each side of that boundary.
 *
 * `inBody` and `nodeOnly` are carried HERE rather than in a parallel map on
 * purpose — the spans get sorted into source order, and a second structure
 * sorted separately is a second chance to pair the wrong function with the
 * wrong facts, which is the defect this arm exists to catch.
 */
type Span = Readonly<{
  start: number;
  end: number;
  /** Callees the compiler finds INSIDE the body. The doors must say yes. */
  inBody: ReadonlySet<string>;
  /** Callees it finds in the function but NOT in the body. They must say no. */
  nodeOnly: ReadonlySet<string>;
}>;

/**
 * The callee text the OTHER parser produces for a call, or `undefined` when
 * the two parsers do not agree that it is a call at all.
 *
 * Two normalisations, both MEASURED rather than assumed, and both about the
 * instruments rather than about the subject:
 *
 *   - Babel records parenthesisation as a property of the node instead of as a
 *     node, so `(async () => {…})()` and `(postMessage as Fn)(m)` have callee
 *     spans that EXCLUDE the wrapping parentheses. Unwrapping here compares
 *     callee to callee rather than callee to callee-plus-punctuation.
 *   - A dynamic `import(…)` is a `CallExpression` whose callee is the `import`
 *     keyword to TypeScript and is not a `CallExpression` at all to Babel.
 *     Neither reading is wrong; the two simply do not answer the same
 *     question, so it is held out rather than reported as a disagreement.
 *
 * Without these, 32 of 31,206 in-body callees look like misses and would have
 * to be silenced with a list of file names — which is the shape this estate
 * refuses.
 */
function calleeTextOf(node: TsNode, sourceFile: TsSourceFile): string | undefined {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return undefined;
  let expression: TsNode = node.expression;
  if (expression.kind === ts.SyntaxKind.ImportKeyword) return undefined;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression.getText(sourceFile).replace(/\s+/g, "");
}

/** Every callee the compiler finds at or under `node`. */
function calleesUnder(node: TsNode, sourceFile: TsSourceFile): Set<string> {
  const into = new Set<string>();
  const add = (n: TsNode): void => {
    const text = calleeTextOf(n, sourceFile);
    if (text !== undefined) into.add(text);
  };
  const visit = (n: TsNode): void => { add(n); ts.forEachChild(n, visit); };
  add(node);
  ts.forEachChild(node, visit);
  return into;
}

/**
 * WHAT THE COMPILER SAYS, for one source: the first declaration of each name
 * that binds a function WITH A BODY, and the names that are declared only
 * WITHOUT one.
 *
 * The bodiless set is not bookkeeping. `f: (x) => T;` in an interface is
 * indistinguishable from an expression-bodied arrow by inspection, and the
 * previous extractor returned the RETURN TYPE as the body for 70 of them —
 * `"Buffer"`, `"void"`, `"AgentRuntime"`. A parser cannot make that mistake,
 * and this arm is what proves it every run.
 */
function compilerView(source: string, fileName: string, offset = 0): Readonly<{
  bodied: Map<string, Span[]>;
  bodiless: Set<string>;
}> {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bodied = new Map<string, Span[]>();
  const bodiless = new Set<string>();

  const isFunctionValued = (node: TsNode | undefined): node is TsArrowFunction | TsFunctionExpression =>
    node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

  /**
   * THE NAME A DECLARATION CARRIES — including a `#private` one.
   *
   * This used to be `ts.isIdentifier(node.name)`, which is FALSE for a
   * `PrivateIdentifier`. The extractor could not answer about a private method
   * either, and the two failures cancelled: the construct the implementation
   * got wrong was precisely the construct this instrument excluded from its
   * population, so the differential agreed at zero disagreements while
   * twenty-seven private methods were refused by a module carrying two `case`
   * labels claiming to handle them. An acceptance instrument blind in the same
   * place as its subject is not an acceptance instrument.
   *
   * TypeScript keeps the `#` in `PrivateIdentifier.text` (measured, 5.9.3) and
   * so does the extractor, so the two agree on the name as well as the span.
   */
  const nameOf = (name: TsNode | undefined): string | undefined => {
    if (name === undefined) return undefined;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name)) return name.text;
    return undefined;
  };

  const remember = (name: string | undefined, fn: TsFunctionLikeDeclaration): void => {
    if (name === undefined) return;
    const body = fn.body;
    if (body === undefined) {
      if (!bodied.has(name)) bodiless.add(name);
      return;
    }
    const block = ts.isBlock(body);
    // EVERY DECLARATION, NOT THE FIRST. The previous version kept only the
    // first and so applied the SAME first-wins tie-break as the extractor —
    // two instruments sharing a rule agree by construction, and flipping the
    // extractor to last-wins passed this differential and the owner's own
    // tests. What the two arms may share is the parse; what they must not
    // share is the decision.
    const inBody = calleesUnder(body, sourceFile);
    const span: Span = {
      start: (block ? body.getStart(sourceFile) + 1 : body.getStart(sourceFile)) + offset,
      end: (block ? body.getEnd() - 1 : body.getEnd()) + offset,
      inBody,
      nodeOnly: new Set([...calleesUnder(fn, sourceFile)].filter((callee) => !inBody.has(callee))),
    };
    const already = bodied.get(name);
    if (already === undefined) bodied.set(name, [span]);
    else already.push(span);
    bodiless.delete(name);
  };

  const noteBodiless = (name: string | undefined): void => {
    if (name !== undefined && !bodied.has(name)) bodiless.add(name);
  };

  const visit = (node: TsNode): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) remember(nameOf(node.name), node);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFunctionValued(node.initializer)) {
      remember(node.name.text, node.initializer);
    } else if ((ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node))
      && isFunctionValued(node.initializer)) {
      remember(nameOf(node.name), node.initializer);
    } else if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
      remember(nameOf(node.name), node);
    } else if (ts.isMethodSignature(node)) {
      noteBodiless(nameOf(node.name));
    } else if (ts.isPropertySignature(node)
      && node.type !== undefined && ts.isFunctionTypeNode(node.type)) {
      noteBodiless(nameOf(node.name));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  for (const spans of bodied.values()) spans.sort((a, b) => a.start - b.start);
  return { bodied, bodiless };
}

/** The `<script>` blocks of a component, with where each one starts. */
function scriptBlocks(source: string): readonly Readonly<{ text: string; offset: number }>[] {
  const out: { text: string; offset: number }[] = [];
  for (const match of source.matchAll(/<script\b[^>]*>/g)) {
    const start = match.index + match[0].length;
    const end = source.indexOf("</script", start);
    if (end >= 0) out.push({ text: source.slice(start, end), offset: start });
  }
  return out;
}

/**
 * THE WORK RUNS IN `beforeAll`, NOT AT COLLECT TIME, and that is a real
 * requirement rather than a style choice: vitest orders files by TEST duration,
 * so a cost paid while the module is being imported is invisible to the
 * scheduler and lands wherever — which is what made this suite's wall clock
 * bimodal once before. This repository's own budget guard measures exactly that
 * and refuses it.
 */
describe("functionBody agrees with TypeScript's own parser over both production trees", () => {
  let files: string[] = [];
  const disagreements: string[] = [];
  const wronglyAnswered: string[] = [];
  const ambiguityMisses: string[] = [];
  const leaked: string[] = [];
  const missed: string[] = [];
  let namesAsked = 0;
  let bodilessAsked = 0;
  let ambiguousAsked = 0;
  let privateAsked = 0;
  let inBodyAsked = 0;
  let nodeOnlyAsked = 0;
  let nodeOnlyFunctions = 0;

  /**
   * THE ANSWER ARM. `scope` was already checked to be the right REGION; this
   * asks whether the doors answer about that region and nothing else.
   *
   * Both directions are needed and they fail differently. Missing an in-body
   * callee makes a guard silently unable to see the thing it asserts; reporting
   * a node-only callee makes a guard TRUE about text its own scope does not
   * contain, which is the proximity-window defect arriving through the facts
   * instead of through a byte count.
   */
  const judgeAnswers = (file: string, name: string, at: number, span: Span, scope: SourceScope): void => {
    for (const callee of span.inBody) {
      inBodyAsked += 1;
      if (!bodyCalls(scope, callee)) missed.push(`${file} ${name}[${String(at)}]: the compiler finds \`${callee}\` inside the body and bodyCalls says no`);
    }
    if (span.nodeOnly.size > 0) nodeOnlyFunctions += 1;
    for (const callee of span.nodeOnly) {
      nodeOnlyAsked += 1;
      if (bodyCalls(scope, callee)) {
        leaked.push(
          `${file} ${name}[${String(at)}]: bodyCalls says YES to \`${callee}\`, which the compiler finds in the function `
          + "but NOT in the body — the scope is answering about text it does not contain",
        );
      }
    }
  };

  beforeAll(() => {
  files = productionFiles((n) => /\.(ts|mts|cts)$/.test(n) && !n.endsWith(".d.ts"));
  for (const file of files) {
    // BYTES, NEVER `grep`: first-party files in these trees carry legitimate NUL
    // bytes, and GNU grep treats such a file as binary — printing nothing and
    // exiting cleanly, which is a silently smaller universe.
    const source = readFileSync(file, "utf8");
    let view;
    try {
      view = compilerView(source, file);
    } catch {
      continue;
    }
    for (const [name, expected] of view.bodied) {
      namesAsked += expected.length;
      if (name.startsWith("#")) privateAsked += 1;
      const sameSpan = (span: Span, scope: { offset: number; body: string }): boolean =>
        scope.offset === span.start && scope.body.length === span.end - span.start;

      if (expected.length > 1) {
        // AN AMBIGUOUS NAME MUST BE REFUSED, NOT ANSWERED. This is the arm the
        // previous differential could not have: both instruments applied
        // first-wins, so a silent choice between two declarations was invisible
        // to it by construction.
        ambiguousAsked += 1;
        try {
          functionBody(source, name);
          ambiguityMisses.push(`${file} ${name}: declared ${String(expected.length)} times with a body, and functionBody answered anyway`);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== "source_structure_subject_ambiguous") {
            ambiguityMisses.push(`${file} ${name}: declared ${String(expected.length)} times, refused with the wrong code ${String(code)}`);
          }
        }
        // …and the PLURAL door must offer every one of them, byte-identically,
        // so refusing the singular door costs no coverage.
        try {
          const all = functionBodies(source, name);
          if (all.length !== expected.length) {
            disagreements.push(`${file} ${name}: compiler has ${String(expected.length)} bodies, functionBodies returned ${String(all.length)}`);
          } else {
            for (const [at, span] of expected.entries()) {
              if (!sameSpan(span, all[at]!)) {
                disagreements.push(
                  `${file} ${name}[${String(at)}]: compiler says ${String(span.end - span.start)}B @${String(span.start)}, `
                  + `extractor says ${String(all[at]!.body.length)}B @${String(all[at]!.offset)}`,
                );
              }
              judgeAnswers(file, name, at, span, all[at]!);
            }
          }
        } catch (error) {
          disagreements.push(`${file} ${name}: functionBodies threw ${String((error as { code?: string }).code)}`);
        }
        continue;
      }

      try {
        const scope = functionBody(source, name);
        if (!sameSpan(expected[0]!, scope)) {
          disagreements.push(
            `${file} ${name}: compiler says ${String(expected[0]!.end - expected[0]!.start)}B @${String(expected[0]!.start)}, `
            + `extractor says ${String(scope.body.length)}B @${String(scope.offset)}`,
          );
        }
        judgeAnswers(file, name, 0, expected[0]!, scope);
      } catch (error) {
        disagreements.push(`${file} ${name}: compiler says it has a body, extractor threw ${String((error as { code?: string }).code)}`);
      }
    }
    for (const name of view.bodiless) {
      bodilessAsked += 1;
      let answered: string | undefined;
      try {
        answered = functionBody(source, name).body.slice(0, 60);
      } catch (error) {
        if ((error as { code?: string }).code !== "source_structure_subject_absent") {
          wronglyAnswered.push(`${file} ${name}: refused with the wrong code ${String((error as { code?: string }).code)}`);
        }
      }
      if (answered !== undefined) wronglyAnswered.push(`${file} ${name}: answered ${JSON.stringify(answered)} for a declaration with no body`);
    }
  }
  });

  test("the corpus is really walked — population as a runtime number", () => {
    expect(files.length, `first-party production sources differentiated: ${String(files.length)}`).toBeGreaterThanOrEqual(700);
    for (const tree of PRODUCTION_TREES) {
      expect(
        files.filter((f) => f.startsWith(tree)).length,
        `${tree} contributed no files — the walk did not reach it`,
      ).toBeGreaterThan(0);
    }
    expect(namesAsked, `named functions asked for: ${String(namesAsked)}`).toBeGreaterThanOrEqual(6000);
    expect(bodilessAsked, `bodiless declarations asked for: ${String(bodilessAsked)}`).toBeGreaterThanOrEqual(200);
    // THE TWO POPULATIONS THIS INSTRUMENT USED TO BE BLIND TO, as runtime
    // numbers. A floor on each is what stops the arms above passing vacuously
    // the way they did when `ts.isIdentifier` excluded every private member and
    // a shared tie-break hid every duplicate.
    expect(privateAsked, `#private members asked for: ${String(privateAsked)}`).toBeGreaterThanOrEqual(20);
    expect(ambiguousAsked, `names declared more than once with a body: ${String(ambiguousAsked)}`).toBeGreaterThanOrEqual(50);
  });

  test("the ANSWER arm has a population too, and the discriminating half is not empty", () => {
    // A floor on the easy half…
    expect(inBodyAsked, `in-body callees asked of the doors: ${String(inBodyAsked)}`).toBeGreaterThanOrEqual(25000);
    // …and, more importantly, on the half that DISCRIMINATES. Every one of
    // these is a callee the compiler finds in the function and not in its body,
    // so it is a question only a scope reading the wrong node can get wrong. If
    // this reached zero the soundness test below would pass vacuously — which is
    // exactly how the span arm passed while nineteen of these were answered
    // `true`.
    expect(
      nodeOnlyAsked,
      `callees present in a function but NOT in its body: ${String(nodeOnlyAsked)} across ${String(nodeOnlyFunctions)} functions. `
      + "These come from default parameter values, decorators and computed keys, and they are the only questions in this corpus "
      + "that can tell a body-scoped fact set from a node-scoped one.",
    ).toBeGreaterThanOrEqual(10);
  });

  test("a door never answers YES about a callee outside the body it hands back", () => {
    expect(
      leaked.slice(0, 40),
      `${String(leaked.length)} of ${String(nodeOnlyAsked)} node-only callees were answered YES. `
      + "A correct region is not a correct answer: the span can be exactly right while the facts come from a wider node, "
      + "and a guard asserting `this function goes through the confined runner` is then satisfied by a default parameter.",
    ).toEqual([]);
  });

  test("a door never answers NO about a callee that IS in the body", () => {
    expect(
      missed.slice(0, 40),
      `${String(missed.length)} of ${String(inBodyAsked)} in-body callees were answered NO. `
      + "Narrowing the fact set to the body must not narrow it past the body — a door that cannot see a real call "
      + "makes every guard built on it vacuous.",
    ).toEqual([]);
  });

  test("a name declared TWICE is refused, never silently answered with one of them", () => {
    expect(
      ambiguityMisses.slice(0, 40),
      `${String(ambiguityMisses.length)} of ${String(ambiguousAsked)} ambiguous names were answered instead of refused. `
      + "Picking one makes the claim true of that declaration and silent about the others, which is how a "
      + "neighbour satisfies a guard — the defect this module exists to remove, arriving through the tie-break.",
    ).toEqual([]);
  });

  test("every extracted region is byte-identical to the compiler's", () => {
    expect(
      disagreements.slice(0, 40),
      `${String(disagreements.length)} of ${String(namesAsked)} named functions got a region the compiler disagrees with. `
      + "A wrong region is worse than the proximity window it replaced, because it looks structural.",
    ).toEqual([]);
  });

  test("a declaration with no body is refused, never answered with its return type", () => {
    expect(
      wronglyAnswered.slice(0, 40),
      `${String(wronglyAnswered.length)} of ${String(bodilessAsked)} bodiless declarations were answered instead of refused.`,
    ).toEqual([]);
  });
});

describe("functionBody reads a component's script block", () => {
  let components: string[] = [];
  const disagreements: string[] = [];
  let namesAsked = 0;

  beforeAll(() => {
  components = productionFiles((n) => n.endsWith(".svelte"));
  for (const file of components) {
    const source = readFileSync(file, "utf8");
    // A component's declarations span all of its script blocks, so the
    // compiler's view is assembled across them — and, like the `.ts` arm, it
    // keeps EVERY declaration of a name rather than the first. A name declared
    // in two blocks is ambiguous in exactly the same way.
    const bodied = new Map<string, Span[]>();
    for (const block of scriptBlocks(source)) {
      let view;
      try {
        view = compilerView(block.text, `${file}.ts`, block.offset);
      } catch {
        continue;
      }
      for (const [name, spans] of view.bodied) {
        const already = bodied.get(name);
        if (already === undefined) bodied.set(name, [...spans]);
        else already.push(...spans);
      }
    }
    for (const [name, expected] of bodied) {
      namesAsked += expected.length;
      expected.sort((a, b) => a.start - b.start);
      try {
        const all = functionBodies(source, name);
        if (all.length !== expected.length) {
          disagreements.push(`${file} ${name}: compiler has ${String(expected.length)} bodies, functionBodies returned ${String(all.length)}`);
          continue;
        }
        for (const [at, span] of expected.entries()) {
          if (all[at]!.offset !== span.start || all[at]!.body.length !== span.end - span.start) {
            disagreements.push(
              `${file} ${name}[${String(at)}]: compiler says ${String(span.end - span.start)}B @${String(span.start)}, `
              + `extractor says ${String(all[at]!.body.length)}B @${String(all[at]!.offset)}`,
            );
          }
        }
        // …and the singular door refuses precisely when there is more than one.
        if (expected.length > 1) {
          try {
            functionBody(source, name);
            disagreements.push(`${file} ${name}: declared ${String(expected.length)} times and functionBody answered anyway`);
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (code !== "source_structure_subject_ambiguous") {
              disagreements.push(`${file} ${name}: ambiguous, refused with the wrong code ${String(code)}`);
            }
          }
        }
      } catch (error) {
        disagreements.push(`${file} ${name}: threw ${String((error as { code?: string }).code)}`);
      }
    }
  }
  });

  test("the component corpus is really walked — population as a runtime number", () => {
    // Floors re-derived at the cutover (the old component tree left; the
    // corpus is the cockpit's ~150 .svelte files): measured 271 component
    // functions on the cut tree, floored with headroom for refactors that
    // remove a few — a COLLAPSE (a walk root going quiet) still lands far
    // below either number.
    expect(components.length, `components differentiated: ${String(components.length)}`).toBeGreaterThanOrEqual(50);
    expect(namesAsked, `component functions asked for: ${String(namesAsked)}`).toBeGreaterThanOrEqual(220);
  });

  test("every component function's region is byte-identical to the compiler's", () => {
    expect(disagreements.slice(0, 40), `${String(disagreements.length)} of ${String(namesAsked)} component functions disagree`).toEqual([]);
  });
});

/**
 * THE THREE MEASURED DEFECT SHAPES, kept as fixtures because each one returned
 * a region that LOOKED structural, and two of them returned a NEIGHBOUR — which
 * is the exact class the module exists to remove.
 */
describe("the shapes that made the hand-rolled extractor return a neighbour", () => {
  const cases = [
    {
      what: "a union return type ending in a string literal is not a type position for the body",
      source: `function target(v: unknown): "exact" | "prefix" {
  return SAFE_ANSWER;
}
function neighbour(): void { DANGEROUS_SPAWN(); }`,
      name: "target",
      contains: "SAFE_ANSWER",
      excludes: "DANGEROUS_SPAWN",
    },
    {
      what: "an interface member is not an expression-bodied arrow",
      source: `interface Crypto {
  open: (blob: Buffer) => Buffer;
}
const crypto = {
  open: (blob: Buffer): Buffer => decodeSealed(blob),
};`,
      name: "open",
      contains: "decodeSealed",
      excludes: "=>",
    },
    {
      what: "a one-line object's arrow stops at its comma",
      source: `const o = { target: (x) => safe(x), other: (y) => DANGEROUS_SPAWN(y) };`,
      name: "target",
      contains: "safe(x)",
      excludes: "DANGEROUS_SPAWN",
    },
    {
      what: "an overload set resolves to the implementation, not to a signature",
      source: `export function target(x: string): void;
export function target(x: number): void;
export function target(x: string | number): void {
  SAFE_ANSWER(x);
}
export function neighbour(): void { DANGEROUS_SPAWN(); }`,
      name: "target",
      contains: "SAFE_ANSWER",
      excludes: "DANGEROUS_SPAWN",
    },
    {
      what: "a default parameter value is not a function body",
      source: `export function target(text: string, options: Options = {}): Result {
  return SAFE_ANSWER(text, options);
}`,
      name: "target",
      contains: "SAFE_ANSWER",
      excludes: "Options",
    },
    {
      what: "a generic return type carrying braces is not a function body",
      source: `export function target(root: string): Readonly<{ map: Map<string, string> }> {
  return { map: SAFE_ANSWER(root) };
}`,
      name: "target",
      contains: "SAFE_ANSWER",
      excludes: "Readonly",
    },
    {
      what: "a decorated class member's body is its own",
      source: `class Host {
  target(): void {
    SAFE_ANSWER();
  }
  neighbour(): void { DANGEROUS_SPAWN(); }
}`,
      name: "target",
      contains: "SAFE_ANSWER",
      excludes: "DANGEROUS_SPAWN",
    },
    {
      what: "a regular-expression literal containing braces does not end the body early",
      source: `function target(): void {
  const re = /[}]{2,3}/;
  SAFE_ANSWER(re);
}
function neighbour(): void { DANGEROUS_SPAWN(); }`,
      name: "target",
      contains: "SAFE_ANSWER",
      excludes: "DANGEROUS_SPAWN",
    },
    {
      what: "a template literal containing a brace does not end the body early",
      source: `function target(): string {
  return \`a\${"}"}b\` + SAFE_ANSWER();
}
function neighbour(): void { DANGEROUS_SPAWN(); }`,
      name: "target",
      contains: "SAFE_ANSWER",
      excludes: "DANGEROUS_SPAWN",
    },
  ] as const;

  test("the fixture table covers every measured cause — population as a runtime number", () => {
    expect(cases.length, `parser fixtures driven: ${String(cases.length)}`).toBeGreaterThanOrEqual(9);
  });

  for (const { what, source, name, contains, excludes } of cases) {
    test(what, () => {
      const scope = functionBody(source, name);
      expect(scope.body, `extracted: ${JSON.stringify(scope.body)}`).toContain(contains);
      expect(scope.body, `extracted: ${JSON.stringify(scope.body)}`).not.toContain(excludes);
    });
  }
});

/**
 * WHERE THE NODE AND THE BODY DELIBERATELY DISAGREE.
 *
 * The estate arm above proves the doors agree with the compiler on real code.
 * These are the shapes that make the two DIFFER on purpose, so that a fact set
 * drawn from the wrong object is caught even in a corpus that happens not to
 * contain one. Every case below was driven against a copy of the module with
 * the fix reverted and CHANGED ITS ANSWER — a fixture that reads the same on
 * both sides certifies nothing, which is the same rule that governs a mutation
 * reported as escaped.
 *
 * Two shapes are here as measurements rather than as flips, and they are stated
 * rather than dropped:
 *
 *   - A COMPUTED KEY cannot leak. `{ [pick()]: fn }` gives the member no name,
 *     so it never enters the named-function table and there is nothing to ask;
 *     and a sibling's computed key is outside the target's node entirely. There
 *     is no way to write this one as a flip, so it is not pretended at.
 *   - A DECORATED class is REFUSED, not misread — the parser is configured for
 *     TypeScript without the decorators proposal, so a decorated declaration
 *     fails to parse and every door throws. That is unknown input treated as an
 *     error rather than as a silent default, and it is the fail-closed
 *     direction. Measured across both repositories' `src`, `server`,
 *     `shared` and both test trees (1,924 files): ZERO decorated
 *     declarations, so nothing is affected today.
 */
describe("a scope's FACTS are its BODY's, on fixtures where node and body differ", () => {
  const cases = [
    {
      what: "a default parameter's call is not a call the body makes",
      source: "export function target(run: R = (a) => LEAKED_CALL(a)) {\n  return run(1);\n}",
      ask: (scope: SourceScope) => bodyCalls(scope, "LEAKED_CALL"),
    },
    {
      what: "a default parameter's call ARGUMENTS are not the body's",
      source: "export function target(cache = createCache(root, mode)) {\n  return cache;\n}",
      ask: (scope: SourceScope) => bodyCallsWith(scope, "createCache", ["root", "mode"]),
    },
    {
      what: "a DESTRUCTURED parameter's default is not the body either",
      source: "export function target({ limit = leakedDefault() } = {}) {\n  return limit;\n}",
      ask: (scope: SourceScope) => bodyCalls(scope, "leakedDefault"),
    },
    {
      what: "a default parameter's object property is not a binding the body makes",
      source: "export function target(options = { leakedKey: leakedValue }) {\n  return options;\n}",
      ask: (scope: SourceScope) => bodyBinds(scope, "leakedKey", "leakedValue"),
    },
    {
      what: "a `return` inside a default parameter is not this function's return",
      source: "export function target(make = () => { return LEAKED_SHAPE; }) {\n  return REAL_SHAPE;\n}",
      ask: (scope: SourceScope) => bodyReturns(scope, "LEAKED_SHAPE"),
    },
    {
      what: "a default parameter's string is not a word the body emits",
      source: 'export function target(label = "leaked words") {\n  return label;\n}',
      ask: (scope: SourceScope) => bodySays(scope, "leaked words"),
    },
    {
      what: "a string LITERAL TYPE in the return type is not a word the body emits",
      source: 'export function target(v: unknown): "leaked-literal" | "other" {\n  return REAL;\n}',
      ask: (scope: SourceScope) => bodySays(scope, "leaked-literal"),
    },
  ] as const;

  test("every disagreement shape this module has met is driven — population as a runtime number", () => {
    expect(cases.length, `node-vs-body fixtures driven: ${String(cases.length)}`).toBeGreaterThanOrEqual(7);
  });

  for (const { what, source, ask } of cases) {
    test(what, () => {
      const scope = functionBody(source, "target");
      expect(ask(scope), `the scope's own body is ${JSON.stringify(scope.body)}`).toBe(false);
    });
  }

  test("the handler door reads a handler's BODY, not the handler's signature", () => {
    // `functionArgumentsOf` carried its own copy of the same defect, so it needs
    // its own case: reverting only the named-function door leaves this one green.
    const source = 'process.on("uncaughtException", (err, log = LEAKED_LOGGER()) => {\n  realHandler(err);\n});';
    const [scope] = functionArgumentsOf(source, "process.on", ['"uncaughtException"']);
    expect(scope, "the handler door found no handler to scope").toBeDefined();
    expect(bodyCalls(scope!, "LEAKED_LOGGER"), `handler body: ${JSON.stringify(scope!.body)}`).toBe(false);
    expect(bodyCalls(scope!, "realHandler"), "the handler's own call must still be visible").toBe(true);
  });

  test("a decorated declaration is refused, never read as if the decorator were absent", () => {
    const source = "class Host {\n  @register(TOKEN)\n  target(): void {\n    real();\n  }\n}";
    expect(() => functionBody(source, "target")).toThrowError(
      expect.objectContaining({ code: "source_structure_unparsable" }),
    );
  });
});
