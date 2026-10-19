// @vitest-environment node
/**
 * ONE SEARCH PATH, AND IT IS THE RANKED ONE.
 *
 * The defect class this guards is not "symbol search is wrong". It is
 * "symbol search was improved somewhere ELSE, beside the path everything
 * already used". That is the shape the codebase has grown repeatedly:
 * three SSE helpers written independently, a category map beside the
 * exposure registry, a second chord registry that made a mechanical guard
 * pass vacuously. Each time the new mechanism worked and the old one kept
 * answering, and the two drifted until they disagreed.
 *
 * Symbol search has three consumers — the HTTP route, the `code.search`
 * block, and the LLM `search_symbols` tool. All three reach it through ONE
 * bridge function. Upgrading that function upgrades all three; adding a
 * "hybrid search" entry point beside it would have upgraded whichever
 * callers someone remembered to migrate.
 *
 * WHAT IS CHECKED, AND AT WHICH STRENGTH:
 *
 *  A. The harness search module is imported by the bridge and nothing else.
 *     Discovered by walking `server/`, not by naming files — a new route or
 *     bridge added tomorrow is covered because it is found, not because it
 *     was listed.
 *  B. Exactly one exported bridge function performs a symbol search. A
 *     second one is the defect, whatever it is called.
 *  C. The ranked path is LIVE, not decorative. Asserted behaviourally
 *     against the real module: hybrid ranking must actually reorder results
 *     that the previous substring matcher scored identically. A wiring test
 *     that only greps for the call would pass on a call whose result is
 *     thrown away.
 *  D. The confidence signals reach the surfaces rather than being computed
 *     and dropped — the failure mode where a value is produced, looks
 *     wired, and never leaves the building.
 *
 * A and B are source scans, which is the floor: they are only as good as
 * the universe they walk, so they walk it dynamically. C and D are
 * behavioural, and are the reason this file is not only a source scan.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { walkTs, valueReferencesModule } from "../helpers/source-scan.ts";

import {
  hybridSearchSymbols,
  searchSymbols,
} from "../../engine/src/intelligence/symbol-search.ts";
import { resolveActionAffinityConfig } from "../../engine/src/intelligence/action-affinity-config.ts";
import { actionClassFor, extractVerb } from "../../engine/src/intelligence/action-affinity.ts";
import type {
  ModuleInfo,
  RepositoryMap,
  SymbolInfo,
  SymbolSearchQuery,
} from "../../engine/src/intelligence/intelligence-types.ts";

const SERVER_DIR = join(import.meta.dirname, "..", "..", "server");

/** The harness module every symbol search must ultimately go through. */
const SEARCH_MODULE = "intelligence/symbol-search.ts";

describe("symbol search has one path", () => {
  const serverFiles = walkTs(SERVER_DIR);

  test("the corpus is real — the walk found the server tree", () => {
    // Without this, every scan below could be passing over zero files, which
    // is exactly how a source-scan guard passes vacuously.
    expect(serverFiles.length).toBeGreaterThan(20);
    expect(serverFiles.some((f) => f.endsWith("intelligence-bridge.ts"))).toBe(true);
  });

  test("A. only the intelligence bridge reaches the harness search module", () => {
    // `valueReferencesModule` is the shared detector, and it knows every form
    // that reaches a module's values — not only `import … from`. That matters
    // here specifically: this assertion was defeated during review by a route
    // that reached the engine through `await import(…)`, which the scan this
    // test used to carry did not read as an import at all.
    const importers = serverFiles
      .filter((f) => valueReferencesModule(readFileSync(f, "utf8"), SEARCH_MODULE))
      .map((f) => relative(SERVER_DIR, f).replaceAll("\\", "/"));
    expect(
      importers.sort(),
      "a file outside the bridge imports the symbol-search module directly, which is a second search path: " +
        "route/tool/block callers must go through the bridge so the ownership gate and the ranking config apply to all of them",
    ).toEqual(["intelligence/intelligence-bridge.ts"]);
  });

  test("B. exactly one exported bridge function performs a symbol search", () => {
    const src = readFileSync(join(SERVER_DIR, "intelligence/intelligence-bridge.ts"), "utf8");
    // Split on every exported DECLARATION form, then keep the blocks that
    // actually call the ranked search. Names are never enumerated — a second
    // entry point is caught whatever it is called.
    //
    // All four forms, because the docstring promises "whatever it is called"
    // and a split on `export function ` alone delivers "whatever it is called,
    // provided it is also declared the same way": an `export async function`
    // or an `export const search = () => …` was not a block boundary at all,
    // so its body stayed glued to the previous declaration and was never
    // examined on its own.
    const boundary = /^export\s+(?:async\s+function|function|const|let|var)\s+/mu;
    const blocks = src.split(boundary).slice(1);
    const searchers = blocks
      .filter((b) => /\bhybridSearchSymbols\s*\(/u.test(b))
      .map((b) => (/^[A-Za-z_$][\w$]*/u.exec(b) ?? ["(anonymous)"])[0]);
    expect(
      searchers,
      "symbol search must have exactly one exported entry point; a second one is a parallel path that " +
        "callers will split across and that will drift from this one",
    ).toEqual(["searchCodeSymbols"]);
  });

  test("B2. the bridge search entry point returns the ranking signals, by type", () => {
    // The return annotation is the strongest rung available here: a caller
    // cannot receive a bare array without the compiler objecting, so the
    // signals cannot be quietly dropped back out of the contract.
    const src = readFileSync(join(SERVER_DIR, "intelligence/intelligence-bridge.ts"), "utf8");
    expect(src).toMatch(/export function searchCodeSymbols\([\s\S]*?\):\s*HybridSearchResult\s*\{/u);
  });

  test("D. every consumer forwards the signals instead of dropping them", () => {
    // The consumers are DISCOVERED, not listed. The previous version named the
    // route and the tool in its body while its own comment said "the route,
    // the block and the tool" — the `code.search` block, one of the three, was
    // never read, so a regression narrowing it to `.results` would have left
    // this green for exactly the consumer the prose promised to cover.
    //
    // Narrowing to `.results` at the call site is the check, because that is
    // how a computed signal stops reaching anyone: the ranking still runs, the
    // confidence fields are still populated, and the caller quietly keeps only
    // the list.
    const consumers = serverFiles
      .filter((f) => /\bsearchCodeSymbols\s*\(/u.test(readFileSync(f, "utf8")))
      .map((f) => [relative(SERVER_DIR, f).replaceAll("\\", "/"), readFileSync(f, "utf8")] as const);

    expect(
      consumers.map(([rel]) => rel).sort(),
      "the walk found no consumer of the bridge search function, so this check ran over nothing",
    ).not.toEqual([]);

    const droppers = consumers
      .filter(([, src]) => /searchCodeSymbols\([^;]*?\)\s*\.results\b/su.test(src))
      .map(([rel]) => rel);
    expect(
      droppers,
      "a consumer narrows the search result to `.results`, discarding how the query was classified, " +
        "which weights were applied, whether the top hit stood clear and whether the hits all came from " +
        "one directory — the facts that say how much to trust the order",
    ).toEqual([]);
  });
});

// ── Behavioural: the ranked path actually ranks ──────────────────────────

function symbol(name: string, line: number, filePath: string): SymbolInfo {
  return {
    name,
    kind: "function",
    visibility: "local",
    location: { filePath, line, column: 1 },
    exported: true,
    async: false,
    generator: false,
    parameterCount: 0,
    modifiers: [],
  };
}

function moduleOf(path: string, names: readonly string[]): ModuleInfo {
  return {
    path,
    contentHash: `hash-${path}`,
    lineCount: 100,
    symbols: names.map((n, i) => symbol(n, (i + 1) * 10, path)),
    imports: [],
    exports: [],
    architectureModuleId: null,
    architectureLayer: null,
    architectureRealm: null,
    architectureOwner: null,
  };
}

function mapOf(modules: readonly ModuleInfo[]): RepositoryMap {
  return {
    schemaVersion: "bridlewise-intelligence/v1",
    rootPath: ".",
    generatedAt: "2026-07-27T00:00:00.000Z",
    files: modules.map((m) => ({
      path: m.path,
      extension: ".ts" as const,
      sizeBytes: 100,
      contentHash: m.contentHash,
      lineCount: m.lineCount,
      isSource: true,
    })),
    modules,
    totalSymbols: modules.reduce((n, m) => n + m.symbols.length, 0),
    totalDependencies: 0,
    mapHash: "map-hash",
  };
}

function query(name: string, matchMode: SymbolSearchQuery["matchMode"]): SymbolSearchQuery {
  return {
    name,
    kind: null,
    filePath: null,
    directory: null,
    exported: null,
    async: null,
    limit: 10,
    matchMode,
  } as SymbolSearchQuery;
}

/**
 * The lexical matchers, every mode of them. The inert-shape assertions below
 * are only worth their words if "the old ranker could not have produced this"
 * is CHECKED against all four modes rather than assumed of the one the live
 * path happens to pass.
 */
const LEXICAL_MODES = ["exact", "prefix", "contains", "fuzzy"] as const;

describe("the ranked path is live, not decorative", () => {
  /**
   * Built so that each of the four assertions below has something to bite on:
   *
   *  - Every name contains the query as a substring, so the previous matcher
   *    scored them by name length alone.
   *  - The LONGEST name sits in the directory the query names, so term
   *    evidence over name AND path ranks it first while every lexical mode
   *    ranks it second or last. The old path cannot reproduce this order by
   *    accident, which the previous fixture's order — identical between the
   *    two rankers — could and did.
   *  - `flushBuffer` matches the query on PATH tokens only. The hybrid scorer
   *    admits it on that evidence; no lexical mode can return it at all,
   *    because its name does not match. It is therefore a result that cannot
   *    be conjured by decorating the old ranker's list.
   */
  const MAP = mapOf([
    moduleOf("src/unrelated/a.ts", ["readTokenValue"]),
    moduleOf("src/parser/token.ts", ["readTokenValueFromCacheOrRebuild"]),
    moduleOf("src/unrelated/b.ts", ["internalReadTokenValueHelper"]),
    moduleOf("src/read-ahead/buffer.ts", ["flushBuffer"]),
  ]);

  /** Every name any lexical mode can return for this query. */
  function lexicalReachable(name: string): Set<string> {
    const names = new Set<string>();
    for (const mode of LEXICAL_MODES) {
      for (const r of searchSymbols(MAP, query(name, mode))) names.add(r.symbol.name);
    }
    return names;
  }

  test("C. hybrid ranking orders results no lexical mode does", () => {
    const ranked = hybridSearchSymbols(MAP, query("readToken", "fuzzy"));
    expect(ranked.results.length).toBeGreaterThan(1);
    // The symbol living in the directory the query names wins DESPITE having
    // the longest name — path tokens are evidence too, and name length is all
    // the substring matcher had.
    expect(ranked.results[0]!.filePath).toBe("src/parser/token.ts");
    expect(ranked.results[0]!.symbol.name).toBe("readTokenValueFromCacheOrRebuild");
    // …and no lexical mode puts it first, so this order is not one the old
    // path reproduces by accident. Asserted rather than assumed, because an
    // ordering that BOTH rankers happen to produce proves nothing about which
    // one produced it.
    for (const mode of LEXICAL_MODES) {
      const lexical = searchSymbols(MAP, query("readToken", mode));
      expect(
        lexical[0]?.symbol.name,
        `the '${mode}' matcher ranks the same symbol first, so this ordering does not distinguish the two rankers`,
      ).not.toBe("readTokenValueFromCacheOrRebuild");
    }
  });

  test("C1b. the results carry the hybrid scorer's own evidence vocabulary", () => {
    // THE INERT CASE, first of four assertions against it. A ranker can
    // compute every hybrid score and then return a list produced by the
    // previous matcher — the call site reads correctly, the signals are
    // populated, and the ordering is plausible, so ordering assertions alone
    // pass. Verified by mutation: replacing the returned list with
    // `searchSymbols(...)` left every other assertion in this file green.
    //
    // `matchedFields` is the first discriminator: the hybrid scorer records
    // WHICH evidence moved each result ("bm25", "fuzzy"), and the lexical
    // scorer records a disjoint vocabulary ("name", "kind").
    const ranked = hybridSearchSymbols(MAP, query("readToken", "fuzzy"));
    const evidence = new Set(ranked.results.flatMap((r) => [...r.matchedFields]));
    expect(
      evidence.has("bm25") || evidence.has("fuzzy"),
      `results carry no hybrid evidence (saw ${[...evidence].join(", ") || "none"}) — ` +
        "the hybrid scores were computed and then discarded",
    ).toBe(true);
    expect(
      evidence.has("name"),
      "results carry the lexical scorer's evidence vocabulary, so they came from that scorer",
    ).toBe(false);
  });

  test("C1c. the results INCLUDE a match only the hybrid scorer can find", () => {
    // Evidence vocabulary alone is not enough, and this assertion is here
    // because that was proven rather than suspected: an inert path that
    // returned the old ranker's list and COPIED the hybrid scorer's
    // `matchedFields` onto it passed C1b, C, C2 and C3 together. Decoration
    // is copyable; membership is not.
    //
    // `flushBuffer` matches "readToken" on its PATH tokens and not on its
    // name, so the hybrid scorer admits it and no lexical mode can return it
    // — a result that cannot exist in a list the old ranker produced, however
    // that list is subsequently painted.
    const ranked = hybridSearchSymbols(MAP, query("readToken", "fuzzy"));
    const returned = new Set(ranked.results.map((r) => r.symbol.name));
    const reachable = lexicalReachable("readToken");
    const hybridOnly = [...returned].filter((n) => !reachable.has(n));
    expect(
      hybridOnly,
      "every returned symbol is one the lexical matcher could also have returned, so the results are " +
        "consistent with the old ranker's list wearing the new ranker's labels",
    ).toContain("flushBuffer");
  });

  test("C1d. the results are ordered by the score they report", () => {
    // The third inert shape, and the one the other two miss: return the
    // hybrid-scored results — right members, right evidence, right numbers —
    // in the order the old ranker put them in. Proven necessary by mutation.
    //
    // Asserted as an invariant of the contract rather than against a
    // recomputed expected order, so this does not become a second copy of the
    // ranker: the order a caller sees must be explained by the numbers the
    // caller sees. Any reordering that changes anything breaks it.
    const ranked = hybridSearchSymbols(MAP, query("readToken", "fuzzy"));
    const scores = ranked.results.map((r) => r.score);
    expect(scores.length).toBeGreaterThan(2);
    for (let i = 1; i < scores.length; i += 1) {
      expect(
        scores[i - 1]! >= scores[i]!,
        `result ${i} scores ${scores[i]} but sits below result ${i - 1} scoring ${scores[i - 1]} — ` +
          "the returned order is not the order the returned scores describe",
      ).toBe(true);
    }
  });

  test("C1f. the verb-class re-ranking reaches the results too", () => {
    // The re-ranker sits INSIDE the ranker, so it has its own inert shape:
    // call it, ignore what it returns. Proven necessary by mutation —
    // replacing the ranked list with the pre-affinity candidates while still
    // calling the re-ranker left C, C1b, C1c, C1d and C1e all green, because
    // every one of those is satisfied by the BM25 half alone.
    //
    // The label is checked against the re-ranker's OWN classification of each
    // candidate rather than a list written out here, so blanket-labelling
    // every result fails just as loudly as labelling none. `actionClassFor`
    // and `extractVerb` are the owner's exports; the rule is not restated.
    const ranked = hybridSearchSymbols(MAP, query("readToken", "fuzzy"));
    const queryClass = actionClassFor(extractVerb("readToken"));
    expect(queryClass, "the fixture's query verb must be one the re-ranker recognises").not.toBe("unknown");
    const labelled = ranked.results
      .filter((r) => r.matchedFields.includes("action-affinity"))
      .map((r) => r.symbol.name)
      .sort();
    const shouldBeLabelled = ranked.results
      .filter((r) => actionClassFor(extractVerb(r.symbol.name)) === queryClass)
      .map((r) => r.symbol.name)
      .sort();
    expect(shouldBeLabelled.length, "the fixture must contain both matching and non-matching verb classes")
      .toBeGreaterThan(0);
    expect(shouldBeLabelled.length).toBeLessThan(ranked.results.length);
    expect(
      labelled,
      "the verb-class bonus does not appear on the results it applies to — it was computed and discarded",
    ).toEqual(shouldBeLabelled);
  });

  test("C1e. the returned scores are on the hybrid scale, not the lexical one", () => {
    // The fourth discriminator, and the one that survives a fixture where
    // membership and order happen to coincide. The hybrid score is a convex
    // combination of two 0..1 terms plus at most one affinity bonus, so it is
    // bounded; the lexical scorer's fuzzy score accumulates per-character
    // bonuses and is not. The bound comes from the config owner, so a
    // re-tuned bonus moves it automatically.
    const bound = 1 + resolveActionAffinityConfig().sameVerbBonus;
    const ranked = hybridSearchSymbols(MAP, query("readToken", "fuzzy"));
    for (const r of ranked.results) {
      expect(
        r.score,
        `${r.symbol.name} scores ${r.score}, above everything the hybrid combination can produce — ` +
          "these are the lexical scorer's numbers",
      ).toBeLessThanOrEqual(bound);
    }
    // The bound only means something if the other scorer actually exceeds it
    // on this fixture. Without this, a bound nothing could ever break would
    // read as a passing check and test nothing.
    const lexicalMax = Math.max(...searchSymbols(MAP, query("readToken", "fuzzy")).map((r) => r.score));
    expect(
      lexicalMax,
      "the lexical scorer stays inside the hybrid bound on this fixture, so the bound cannot tell them apart",
    ).toBeGreaterThan(bound);
  });

  test("C3. the confidence signals are computed from the results, not constant", () => {
    // A signal that reports the same value regardless of input is the
    // 748%-bug shape: present, plausible, and carrying no information.
    const focused = hybridSearchSymbols(MAP, query("readTokenValue", "fuzzy"));
    const vague = hybridSearchSymbols(MAP, query("red", "fuzzy"));
    expect(focused.queryClass).toBe("specific");
    expect(vague.queryClass).toBe("vague");
    expect(focused.bm25Weight).not.toBe(vague.bm25Weight);
    // All three candidates sit under src/, but in different directories, so
    // concentration is a real measurement here rather than a constant.
    expect(typeof focused.biasDetected).toBe("boolean");
  });

  test("C4. an unknown ranking knob is refused, not silently ignored", () => {
    // Deny by default: a mistyped knob must fail loudly at the config
    // boundary rather than leaving the operator with a setting that reads
    // as applied and does nothing.
    expect(() =>
      hybridSearchSymbols(MAP, query("readToken", "fuzzy"), {
        hybridBm25Weight: 1.5,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "intelligence_config_invalid",
        message: expect.stringContaining("hybridBm25Weight"),
      }),
    );
  });
});
