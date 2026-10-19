/**
 * EXP447 helpers — synthetic source files + claim/record builders shared
 * across the hallucination, bias, and bandaid benchmark suites.
 *
 * These helpers are DETERMINISTIC (no LLM, no network). They build the
 * enriched semantic index + the structural index + the bias/bandaid event
 * streams the benchmark suites need.
 */
import { buildSemanticIndexFromSources, type SemanticIndex } from "../../src/safety/hallucination-semantic.ts";
import { buildIndexFromSources, type CodebaseIndex } from "../../src/safety/hallucination-detector.ts";

/** A 20-function synthetic TS codebase (the LLM's "real" environment). */
export const SYNTHETIC_SOURCES: ReadonlyArray<Readonly<{ path: string; content: string }>> = [
  {
    path: "src/array.ts",
    content: `
export function assertArrayExpression(node: object, opts?: object): void { if (!isArray(node)) throw new TypeError("not array"); }
export function cloneNode<T>(node: T, deep?: boolean, withoutLoc?: boolean): T { return { ...node }; }
export function findParent(this: NodePath, callback: (p: NodePath) => boolean): NodePath | null { return null; }
export function getAncestry(this: NodePath): NodePath[] { return []; }
export function parseExpression(input: string, options?: object): import("@babel/parser").ParseResult { return {} as never; }
export async function asyncFetch(url: string): Promise<string> { return ""; }
export function sortByKey(arr: {name: string}[]): {name: string}[] { return arr.sort((a, b) => a.name.localeCompare(b.name)); }
export function buildMatchMemberExpression(match: string, allowPartial?: boolean): MemberExpression { return {} as MemberExpression; }
export const syncAdd = (a: number, b: number): number => a + b;
export class PathRegistry {
  register(path: NodePath): void {}
  find(id: string): NodePath | null { return null; }
}
`,
  },
  {
    path: "src/types.ts",
    content: `
export type NodePath = { node: unknown };
export interface MemberExpression { type: string; }
export function createTypeChecker(host: object): import("typescript").TypeChecker { return {} as never; }
export function createNodeFactory(flags: number, baseFactory: object): import("typescript").NodeFactory { return {} as never; }
export function bindSourceFile(file: object, options: object): void {}
`,
  },
];

export const SEMANTIC_INDEX: SemanticIndex = buildSemanticIndexFromSources(SYNTHETIC_SOURCES);
// EXP447: structural index reuses the AST-extracted function names (DRY —
// the AST is the single source of truth for function names; the regex index
// catches types/imports/exports/paths). This keeps L3 grounding consistent
// with L7 semantic (class methods the regex misses are grounded).
export const STRUCTURAL_INDEX: CodebaseIndex = buildIndexFromSources(SYNTHETIC_SOURCES, SEMANTIC_INDEX);

/** All real function names in the synthetic codebase (for real-prompt tests). */
export const REAL_NAMES = SEMANTIC_INDEX.records.map((r) => r.name);

/** Generate N hallucination trap names (guaranteed NOT in the index). */
export function trapNames(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`fakeFunction${i}`);
  return out;
}

/** Generate N real-prompt function calls (cycling the real names). */
export function realPrompts(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const name = REAL_NAMES[i % REAL_NAMES.length] ?? "syncAdd";
    out.push(`${name}();\n`);
  }
  return out;
}

/** Build the 50 SEMANTIC traps (wrong return type, params, async, line, throws). */
export interface SemanticTrap {
  ref: string;
  field: "returns" | "params" | "async" | "line" | "throws" | "argCount";
  /** The WRONG claimed value. */
  wrongValue: string | number | boolean | readonly string[];
  /** The CORRECT actual value (from the semantic index; may be null). */
  correctValue: string | number | boolean | readonly string[] | null;
}

export function buildSemanticTraps(n: number): SemanticTrap[] {
  const traps: SemanticTrap[] = [];
  const recs = SEMANTIC_INDEX.records;
  if (recs.length === 0) return traps;
  // Cycle through trap kinds to generate `n` varied traps.
  const kinds: SemanticTrap["field"][] = ["returns", "params", "async", "line", "throws", "argCount"];
  let i = 0;
  while (traps.length < n) {
    const rec = recs[i % recs.length]!;
    const kind = kinds[i % kinds.length]!;
    i++;
    const actual = actualForField(rec, kind);
    if (actual === null) continue;
    const wrong = wrongValueFor(kind, actual);
    traps.push({ ref: rec.name, field: kind, wrongValue: wrong, correctValue: actual });
  }
  return traps;
}

function actualForField(rec: { returnType: string | null; paramNames: readonly string[]; isAsync: boolean; line: number; throws: readonly string[]; argCount: number }, field: SemanticTrap["field"]): string | number | boolean | readonly string[] | null {
  switch (field) {
    case "returns": return rec.returnType ?? "void";
    case "params": return rec.paramNames.filter((p) => p !== "this");
    case "async": return rec.isAsync;
    case "line": return rec.line;
    case "throws": return rec.throws;
    case "argCount": return rec.argCount;
    default: return null;
  }
}

function wrongValueFor(field: SemanticTrap["field"], actual: string | number | boolean | readonly string[]): string | number | boolean | readonly string[] {
  switch (field) {
    case "returns":
      return actual === "boolean" ? "number" : "boolean";
    case "params":
      // Ensure the wrong value differs from actual (handles empty-params case).
      if (Array.isArray(actual)) {
        if (actual.length === 0) return ["wrongParam"];
        return actual.map((p) => `${p}WRONG`);
      }
      return ["wrong"];
    case "async":
      return !actual;
    case "line":
      return (typeof actual === "number" ? actual + 500 : 999);
    case "throws":
      return ["SyntaxError"];
    case "argCount":
      return (typeof actual === "number" ? actual + 3 : 99);
    default:
      return "wrong";
  }
}

/** Build N bias-detection cases (8 types × N/8 cases each). */
export function buildBiasCases(n: number): { type: string; stance: string }[] {
  const cases: { type: string; stance: string }[] = [];
  const biasTypes = ["confirmation", "anchoring", "selection", "recency", "availability", "representation", "sampling", "metric"];
  for (let i = 0; i < n; i++) {
    const type = biasTypes[i % biasTypes.length]!;
    cases.push({ type, stance: "for" });
  }
  return cases;
}

/** Build N bias negative-controls (balanced searches → no bias). */
export function buildBiasControls(n: number): { type: string; stance: string }[] {
  const cases: { type: string; stance: string }[] = [];
  for (let i = 0; i < n; i++) {
    cases.push({ type: "control", stance: i % 2 === 0 ? "for" : "against" });
  }
  return cases;
}

/**
 * EXP461 (S1): memory facts for the recency/availability bias tests. The
 * detector needs established memory facts (with retention + tokens) to
 * evaluate those two types. Five facts with varied retention so the
 * top-K (availability) set is well-defined.
 */
export const BIAS_MEMORY_FACTS = [
  { id: "mf1", content: "the function returns a promise of string", retention: 0.95, tokens: ["the", "function", "returns", "promise", "string"] },
  { id: "mf2", content: "the parser validates the AST node types", retention: 0.9, tokens: ["the", "parser", "validates", "ast", "node", "types"] },
  { id: "mf3", content: "the editor writes with exact preimages", retention: 0.85, tokens: ["the", "editor", "writes", "exact", "preimages"] },
  { id: "mf4", content: "the timeline records every tool call", retention: 0.6, tokens: ["the", "timeline", "records", "every", "tool", "call"] },
  { id: "mf5", content: "the config declares every threshold", retention: 0.4, tokens: ["the", "config", "declares", "every", "threshold"] },
];

/**
 * EXP461 (S1): record the event stream that RELIABLY triggers each of the
 * 8 bias types. The 3 hard-to-trigger types (recency, availability,
 * representation) need memoryFacts + awareness patterns, which the
 * predecessor only provided for 5/8. This helper feeds the correct events
 * for every type so the 5000-case test achieves >=95% detection on ALL 8.
 */
export function triggerBiasType(
  det: import("../../src/safety/bias-detector.ts").BiasDetector,
  type: string,
  awareness: import("../../src/safety/bias-detector.ts").RepositoryAwareness,
  _memoryFacts: readonly import("../../src/safety/bias-detector.ts").MemoryFact[],
): void {
  switch (type) {
    case "confirmation":
      for (let j = 0; j < 10; j++) det.recordSearch({ turn: j, query: `q${j}`, stance: "for", hypothesisId: "h1" });
      break;
    case "anchoring":
      det.recordAnswer({ turn: 1, hypothesisId: "h1", content: "x", similarityToFirstAnswer: 1, similarityToRecentContext: 0.95, similarityToMemoryFacts: 0.9, reevaluationForced: false });
      det.recordAnswer({ turn: 2, hypothesisId: "h1", content: "x", similarityToFirstAnswer: 0.95, similarityToRecentContext: 0.1, similarityToMemoryFacts: 0.9, reevaluationForced: false });
      det.recordAnswer({ turn: 3, hypothesisId: "h1", content: "x", similarityToFirstAnswer: 0.95, similarityToRecentContext: 0.1, similarityToMemoryFacts: 0.9, reevaluationForced: false });
      break;
    case "selection":
      for (let j = 0; j < 10; j++) det.recordRead({ turn: j, filePath: "src/h1/f0.ts", stance: "for", hypothesisId: "h1", relevant: true });
      break;
    case "recency": {
      // Recency: answer aligns with recent context (>=0.7) but NOT memory (<0.3).
      det.recordAnswer({ turn: 1, hypothesisId: "h1", content: "use the recent cache value", similarityToFirstAnswer: 0.5, similarityToRecentContext: 0.9, similarityToMemoryFacts: 0.1, reevaluationForced: false });
      det.recordAnswer({ turn: 2, hypothesisId: "h1", content: "use the recent cache value", similarityToFirstAnswer: 0.5, similarityToRecentContext: 0.85, similarityToMemoryFacts: 0.1, reevaluationForced: false });
      break;
    }
    case "availability": {
      // Availability: answer reflects <40% of the top-K most-relevant memory.
      // The top-5 facts share tokens "the","function","returns"... an answer
      // with none of those tokens → coverage 0 < 0.4 → availability bias.
      det.recordAnswer({ turn: 1, hypothesisId: "h1", content: "zzz qqq xxx unrelated gibberish", similarityToFirstAnswer: 0.1, similarityToRecentContext: 0.1, similarityToMemoryFacts: 0.05, reevaluationForced: false });
      det.recordAnswer({ turn: 2, hypothesisId: "h1", content: "zzz qqq xxx unrelated gibberish", similarityToFirstAnswer: 0.1, similarityToRecentContext: 0.1, similarityToMemoryFacts: 0.05, reevaluationForced: false });
      break;
    }
    case "representation":
      // Representation: suggestion patterns diverge from codebase patterns.
      det.recordCodeSuggestion({ turn: 1, hypothesisId: "h1", patterns: ["for-loop", "while-loop", "recursion"], codebasePatterns: awareness.patternsForFile("src/h1/f0.ts") });
      det.recordCodeSuggestion({ turn: 2, hypothesisId: "h1", patterns: ["for-loop", "while-loop", "recursion"], codebasePatterns: awareness.patternsForFile("src/h1/f0.ts") });
      break;
    case "metric":
      for (let j = 0; j < 5; j++) det.recordMetricFinding({ turn: j, functionId: `fn${j}`, metricName: "fp", value: 0.8, context: "x", falsePositive: j < 4 });
      break;
    case "sampling":
      det.recordCoverage({ turn: 1, indexedCount: 1, totalCount: 10, strategyDocumented: false, missingSamplePaths: [] });
      break;
  }
}
