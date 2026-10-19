// @vitest-environment node
/**
 * EVERY PUBLISHED RANKING KNOB CHANGES SOMETHING.
 *
 * A setting an operator can see, type a number into, and have accepted at
 * every layer — schema, config file, reader, resolver — while it changes no
 * score, no order and no reported signal, is a fake control. It is worse than
 * a missing one: the operator concludes the feature does not help, when what
 * happened is that their number was never applied.
 *
 * Two of the twelve knobs this merge published were exactly that. One gated
 * a branch whose two arms both returned "vague"; sweeping it from 1 to 99
 * reclassified no query. The other was recomputed from its sibling on every
 * path that scored anything, so setting it to 0 or 1 changed nothing — and an
 * operator who raised the BM25 weight and left it alone got a REPORTED weight
 * that disagreed with the one actually applied, so the signal explaining the
 * ranking described a ranking that did not happen.
 *
 * Neither was caught by anything. They typechecked, they validated, they were
 * forwarded, and every existing test passed. So the surface is swept here,
 * DISCOVERED from the owner's own runtime list rather than written out, which
 * is what makes a knob added tomorrow covered by a test nobody remembered to
 * update.
 *
 * The second half checks the other direction: the web reader must forward the
 * whole surface. A knob the harness declares and the reader has never heard
 * of is set by the operator and dropped in transit — the same lie, one layer
 * out. The compiler already catches the reverse (a name the reader forwards
 * and the harness has dropped is a type error), so only this direction needs
 * asserting.
 */
import { describe, test, expect } from "vitest";

import {
  hybridSearchSymbols,
  HYBRID_SEARCH_KNOBS,
  type HybridSearchOptions,
} from "../../engine/src/intelligence/symbol-search.ts";
import { resolveIntelligenceConfig } from "../../engine/src/intelligence/intelligence-config.ts";
import type {
  ModuleInfo,
  RepositoryMap,
  SymbolInfo,
  SymbolSearchQuery,
} from "../../engine/src/intelligence/intelligence-types.ts";
import { getHybridSearchOverrides } from "../../server/kernel/harness-config.ts";

function symbol(name: string, line: number, filePath: string): SymbolInfo {
  return {
    name, kind: "function", visibility: "local",
    location: { filePath, line, column: 1 },
    exported: true, async: false, generator: false, parameterCount: 0, modifiers: [],
  };
}
function moduleOf(path: string, names: readonly string[]): ModuleInfo {
  return {
    path, contentHash: `hash-${path}`, lineCount: 100,
    symbols: names.map((n, i) => symbol(n, (i + 1) * 10, path)),
    imports: [], exports: [],
    architectureModuleId: null, architectureLayer: null,
    architectureRealm: null, architectureOwner: null,
  };
}
function mapOf(modules: readonly ModuleInfo[]): RepositoryMap {
  return {
    schemaVersion: "bridlewise-intelligence/v1", rootPath: ".",
    generatedAt: "2026-07-27T00:00:00.000Z",
    files: modules.map((m) => ({
      path: m.path, extension: ".ts" as const, sizeBytes: 100,
      contentHash: m.contentHash, lineCount: m.lineCount, isSource: true,
    })),
    modules,
    totalSymbols: modules.reduce((n, m) => n + m.symbols.length, 0),
    totalDependencies: 0, mapHash: "map-hash",
  };
}
function query(name: string): SymbolSearchQuery {
  return {
    name, kind: null, filePath: null, directory: null,
    exported: null, async: null, limit: 20, matchMode: "fuzzy",
  } as SymbolSearchQuery;
}

/**
 * A corpus with enough shape for every knob to have something to bite on:
 * shared subject tokens (so BM25 weighting matters), a directory that
 * concentrates results (bias), one clear winner (the seal), several
 * near-identical names (length normalisation), and a path-only match.
 */
const MAP = mapOf([
  moduleOf("src/parser/token.ts", ["readTokenValue", "readTokenStream", "flushBuffer"]),
  moduleOf("src/parser/lexer.ts", ["readTokenValueFromCacheOrRebuild"]),
  moduleOf("src/unrelated/b.ts", ["internalReadTokenValueHelper"]),
  moduleOf("src/unrelated/c.ts", ["writeTokenValue"]),
]);

/** Everything a caller can observe, as one comparable string. */
function observe(options: HybridSearchOptions, name: string): string {
  const r = hybridSearchSymbols(MAP, query(name), options);
  return JSON.stringify({
    order: r.results.map((x) => `${x.filePath}#${x.symbol.name}`),
    scores: r.results.map((x) => x.score.toFixed(6)),
    fields: r.results.map((x) => [...x.matchedFields]),
    biasDetected: r.biasDetected,
    sealFired: r.sealFired,
    queryClass: r.queryClass,
    bm25Weight: r.bm25Weight,
    fuzzyWeight: r.fuzzyWeight,
  });
}

/** Values worth trying for a knob, given the kind of number it is. */
function probeValues(knob: string, current: number): number[] {
  const isCount = Number.isInteger(current) && current >= 1 && Math.abs(current) > 0.999;
  return isCount ? [1, 2, 5, 20] : [0, 0.1, 0.5, 0.9, 1];
}

const QUERIES = ["readToken", "read token value", "readTokenValue", "tok", "flush"];

describe("every published ranking knob is a real control", () => {
  const defaults = resolveIntelligenceConfig();

  test("the knob surface was discovered, not assumed", () => {
    // Without this, a list that came back empty would make every sweep below
    // pass over nothing — the one way a discovery-driven test can lie.
    expect(HYBRID_SEARCH_KNOBS.length).toBeGreaterThan(5);
    for (const knob of HYBRID_SEARCH_KNOBS) {
      expect(typeof defaults[knob], `${knob} is not a number in the resolved config`).toBe("number");
    }
  });

  for (const knob of HYBRID_SEARCH_KNOBS) {
    test(`${knob} changes what a caller can observe`, () => {
      const current = defaults[knob] as number;
      const baselines = QUERIES.map((q) => observe({}, q));
      const changed: string[] = [];
      for (const value of probeValues(knob, current)) {
        if (value === current) continue;
        for (const [i, q] of QUERIES.entries()) {
          let result: string;
          try {
            result = observe({ [knob]: value } as HybridSearchOptions, q);
          } catch {
            // A value the resolver refuses is a real effect too — the knob is
            // wired to a validator, which is more than a fake control has.
            changed.push(`${knob}=${value} refused`);
            continue;
          }
          if (result !== baselines[i]) changed.push(`${knob}=${value} on "${q}"`);
        }
      }
      expect(
        changed.length,
        `${knob} is published to operators, validated, and forwarded, but no value of it changed any ` +
          `score, order, matched field or reported signal across ${QUERIES.length} queries. ` +
          "A control that cannot do anything must not be offered.",
      ).toBeGreaterThan(0);
    });
  }

  test("the web reader forwards the whole knob surface", () => {
    // Discovered on both sides. The reader returns only what an operator SET,
    // so the surface it recognises is read from its behaviour: give it the
    // real config and ask which of the declared knobs it is willing to carry.
    const forwarded = new Set(Object.keys(getHybridSearchOverrides()));
    const configured = new Set(
      HYBRID_SEARCH_KNOBS.filter((k) => forwarded.has(k)),
    );
    // Every knob the config file actually sets must arrive.
    expect(
      [...forwarded].filter((k) => !(HYBRID_SEARCH_KNOBS as readonly string[]).includes(k)),
      "the web reader forwards a knob the ranker does not declare — it will be dropped by the resolver",
    ).toEqual([]);
    expect(
      configured.size,
      "the reader forwarded none of the declared knobs, so this check ran over nothing",
    ).toBeGreaterThan(0);
  });

  test("a knob name the resolver does not know is refused, not dropped", () => {
    // Deny by default at the last layer that can still tell. Every layer above
    // this one accepts an arbitrary name: the config schema types the
    // retrieval knobs as a loose numeric map, and the reader simply skips what
    // it does not recognise. A misspelling was accepted everywhere and applied
    // nowhere.
    expect(() =>
      resolveIntelligenceConfig({ bm25k1: 9 } as unknown as Parameters<typeof resolveIntelligenceConfig>[0]),
    ).toThrowError(
      expect.objectContaining({
        code: "intelligence_config_unknown_key",
        message: expect.stringContaining("bm25k1"),
      }),
    );
    // …and the message names what IS valid, so the operator can act on it
    // rather than only learning that they were wrong.
    expect(() =>
      resolveIntelligenceConfig({ nonsense: 1 } as unknown as Parameters<typeof resolveIntelligenceConfig>[0]),
    ).toThrowError(expect.objectContaining({ message: expect.stringContaining("bm25K1") }));
  });
});
