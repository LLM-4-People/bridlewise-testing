import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getConfigDocumentSchema } from "../../src/kernel/config-contracts.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { INTELLIGENCE_SETTING_NAMES } from "../../src/intelligence/intelligence-config.ts";
import {
  createInvertedIndexSearchEngine,
  createLexicalSearchEngine,
  type MemorySearchEngine,
  resolveMemorySearchEngine,
} from "../../src/memory/memory-search.ts";
import { createMemoryStore } from "../../src/memory/memory-store.ts";
import {
  createMemorySearchQuery,
  MEMORY_SEARCH_ENGINE_KINDS,
  type MemoryEntry,
  type MemorySearchEngineKind,
  type MemorySearchQuery,
  type MemorySearchResult,
  resolveMemoryConfig,
} from "../../src/memory/memory-types.ts";
import { parseExports, valueReferencesModule } from "../support/source-scan.ts";
import { mkTempDir } from "../support/temp-dir.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

// ===========================================================================
// The two engines answer the same question. One of them does far less work to
// do it. Both halves are asserted, because either alone is satisfiable by a
// broken engine: an engine that returns nothing is very fast, and an engine
// that is a rename of the linear scan is perfectly correct.
// ===========================================================================

/** Deterministic pseudo-random source. A seeded corpus is reproducible; a
 * failure here is a failure anyone can re-run and see. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const VOCABULARY = [
  "retry", "budget", "landlock", "guardian", "timeline", "ledger", "redaction",
  "posting", "tokenizer", "promotion", "quarantine", "manifest", "signature",
  "throttle", "snapshot", "reconcile", "provenance", "invariant",
];
const TOPICS = ["deployment", "search", "privacy", null];
const AGENTS = ["planner", "editor", null];
const TIERS = ["present", "short-term", "long-term"] as const;

function makeCorpus(count: number, seed: number): readonly MemoryEntry[] {
  const rand = seeded(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const entries: MemoryEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const words: string[] = [];
    for (let w = 0; w < 6; w += 1) words.push(pick(VOCABULARY));
    entries.push(Object.freeze({
      id: `mem-${i}`,
      tier: pick(TIERS),
      content: words.join(" "),
      tags: Object.freeze(rand() < 0.3 ? ["decision"] : []),
      agentId: pick(AGENTS),
      topic: pick(TOPICS),
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      sourceEventId: null,
      turnId: null,
      runId: null,
      metadata: Object.freeze({}),
    }) as MemoryEntry);
  }
  return entries;
}

function makeQueries(count: number, seed: number): readonly MemorySearchQuery[] {
  const rand = seeded(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const queries: MemorySearchQuery[] = [];
  for (let i = 0; i < count; i += 1) {
    const terms: string[] = [];
    const termCount = 1 + Math.floor(rand() * 3);
    for (let t = 0; t < termCount; t += 1) terms.push(pick(VOCABULARY));
    queries.push(createMemorySearchQuery({
      // Every query shape the scorer treats differently: text alone, and text
      // combined with each boost-bearing filter. The boost cases are the ones
      // an index gets wrong, because they score entries whose text matches
      // nothing at all.
      ...(rand() < 0.9 ? { text: terms.join(" ") } : {}),
      ...(rand() < 0.35 ? { topic: pick(["deployment", "search", "privacy"]) } : {}),
      ...(rand() < 0.3 ? { agentId: pick(["planner", "editor"]) } : {}),
      ...(rand() < 0.3 ? { tier: pick(TIERS) } : {}),
      ...(rand() < 0.25 ? { tags: ["decision"] } : {}),
      limit: 1 + Math.floor(rand() * 25),
    }));
  }
  return queries;
}

const shape = (results: readonly MemorySearchResult[]): unknown =>
  results.map((r) => [r.entry.id, r.score, [...r.matchedFields]]);

test("memory search engines: the indexed engine answers exactly what the linear scan answers", () => {
  const entries = makeCorpus(400, 7);
  const queries = makeQueries(200, 11);
  const lexical = createLexicalSearchEngine();
  const indexed = createInvertedIndexSearchEngine();

  let nonEmpty = 0;
  for (const query of queries) {
    const expected = lexical.search(entries, query);
    const actual = indexed.search(entries, query);
    if (expected.length > 0) nonEmpty += 1;
    assert.deepEqual(
      shape(actual),
      shape(expected),
      `the engines disagreed on ${JSON.stringify(query)}`,
    );
  }
  // Without this the assertion above is satisfied by two engines that both
  // return nothing, which is the one way a same-answer test can pass while
  // proving nothing.
  assert.ok(nonEmpty > queries.length / 2, `only ${nonEmpty} of ${queries.length} queries matched anything`);
});

test("memory search engines: a query naming a topic still reaches entries whose text does not match", () => {
  // The specific divergence the equivalence sweep exists to catch, stated on
  // its own so the reason is legible when it fails. `scoreEntry` awards a
  // topic boost, and the filter has already discarded every other topic, so
  // this entry belongs in the answer despite sharing no word with the query.
  const entries: readonly MemoryEntry[] = [
    Object.freeze({
      id: "mem-topic-only", tier: "short-term", content: "unrelated wording entirely",
      tags: Object.freeze([]), agentId: null, topic: "deployment",
      timestamp: "2026-01-01T00:00:00.000Z", sourceEventId: null, turnId: null,
      runId: null, metadata: Object.freeze({}),
    }) as MemoryEntry,
    Object.freeze({
      id: "mem-word-match", tier: "short-term", content: "landlock guardian",
      tags: Object.freeze([]), agentId: null, topic: "deployment",
      timestamp: "2026-01-01T00:00:01.000Z", sourceEventId: null, turnId: null,
      runId: null, metadata: Object.freeze({}),
    }) as MemoryEntry,
  ];
  const query = createMemorySearchQuery({ text: "landlock", topic: "deployment", limit: 10 });
  const ids = createInvertedIndexSearchEngine().search(entries, query).map((r) => r.entry.id);
  assert.deepEqual([...ids].sort(), ["mem-topic-only", "mem-word-match"]);
});

// ---------------------------------------------------------------------------
// The discriminator: work done, counted by the corpus itself.
//
// The two engines return the same rows, deliberately, so no row can tell them
// apart — and any field an engine stamped on its output to say "the index
// answered this" would be a decoration, which a wired-but-inert engine copies
// across in one line. What cannot be copied is the reading of the corpus: the
// linear scan must tokenize every surviving entry to score it, and the index
// must not. So the corpus counts its own reads, and the count is evidence the
// engine cannot manufacture.
//
// An engine that folds the index and then returns the linear scan's answer —
// right thing computed, wrong thing returned — reads everything, and fails
// here exactly as an engine that never built an index at all.
// ---------------------------------------------------------------------------

function countingCorpus(count: number): { entries: readonly MemoryEntry[]; reads: () => number } {
  let reads = 0;
  const entries: MemoryEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const body = i === 0 ? "singular needle phrase" : `common filler words number ${i % 17}`;
    const entry = {
      id: `mem-${i}`, tier: "short-term" as const, tags: Object.freeze([]),
      agentId: null, topic: null,
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      sourceEventId: null, turnId: null, runId: null, metadata: Object.freeze({}),
    };
    Object.defineProperty(entry, "content", {
      get(): string { reads += 1; return body; },
      enumerable: true,
    });
    // Frozen here so the store's own `deepFreeze` short-circuits and does not
    // count as a read.
    entries.push(Object.freeze(entry) as unknown as MemoryEntry);
  }
  return { entries, reads: () => reads };
}

const CORPUS_SIZE = 500;

/**
 * DISTINCT questions, never one question asked repeatedly.
 *
 * A bound measured over repeats of a single query is satisfied by an engine
 * that simply remembers its last answer — which builds no index, keeps every
 * answer it has ever given, and is O(n) again the moment a NEW question is
 * asked, i.e. on every question a real store actually receives. Asking eight
 * different questions is what makes the bound about the fold rather than
 * about a cache.
 *
 * Three terms reach exactly one entry each and five reach none, so the rows
 * an honest engine returns stay far below the corpus and the bound below has
 * no room to hold trivially.
 */
const PROBE_TERMS = [
  "needle", "singular", "phrase",
  "absentone", "absenttwo", "absentthree", "absentfour", "absentfive",
] as const;

type QueryCost = { term: string; reads: number; rows: number };

function measure(engine: MemorySearchEngine): { fold: number; perQuery: readonly QueryCost[] } {
  const { entries, reads } = countingCorpus(CORPUS_SIZE);
  // A first query no entry answers, so what it costs is the fold and nothing
  // else — the later numbers are then purely per-question cost.
  engine.search(entries, createMemorySearchQuery({ text: "unmatchedwarmup", limit: 50 }));
  const fold = reads();
  const perQuery = PROBE_TERMS.map((term) => {
    const before = reads();
    const rows = engine.search(entries, createMemorySearchQuery({ text: term, limit: 50 })).length;
    return { term, reads: reads() - before, rows };
  });
  return { fold, perQuery };
}

test("memory search engines: the linear scan reads the whole corpus for every query", () => {
  // The other half of the bound below. Without it, a corpus that is never
  // read at all would satisfy the indexed engine's assertion trivially, and
  // the guard would be measuring nothing.
  const { fold, perQuery } = measure(createLexicalSearchEngine());
  assert.ok(fold >= CORPUS_SIZE, `linear scan read ${fold} of ${CORPUS_SIZE} entries on the first query`);
  for (const q of perQuery) {
    assert.ok(
      q.reads >= CORPUS_SIZE,
      `linear scan read ${q.reads} entries answering "${q.term}"; it must re-read all ${CORPUS_SIZE} for every question`,
    );
  }
});

test("memory search engines: the indexed engine reads the corpus once, then only what it returns", () => {
  const { fold, perQuery } = measure(createInvertedIndexSearchEngine());
  // The fold has to see every entry, so the first query costs a full pass.
  assert.ok(fold >= CORPUS_SIZE, `the fold read ${fold} of ${CORPUS_SIZE} entries; it must see them all`);
  // What the fold BOUGHT, stated per QUESTION and against that question's own
  // answer rather than against a written-down number: no question may cost
  // more reading than it produces. An engine that re-scanned would read the
  // whole store to return one row and fail here on the first term.
  for (const q of perQuery) {
    assert.ok(
      q.reads <= q.rows,
      `answering "${q.term}" read ${q.reads} entries to return ${q.rows} rows; after the fold a question must read no more than it returns`,
    );
  }
  const answered = perQuery.filter((q) => q.rows > 0);
  assert.ok(answered.length > 0, "no probe term matched anything, so the bounds above hold vacuously");
  assert.ok(
    perQuery.some((q) => q.rows === 0),
    "no probe term missed, so nothing proves an unmatched question is answered without reading",
  );
});

test("memory search engines: the fold is redone when the entry set changes", () => {
  // A cheaper staleness check (length plus endpoints) would call a
  // middle-of-the-list replacement unchanged and keep serving the old fold.
  const engine = createInvertedIndexSearchEngine();
  const base = makeCorpus(20, 3);
  const query = createMemorySearchQuery({ text: "supersedingtoken", limit: 10 });
  assert.equal(engine.search(base, query).length, 0);

  const swapped = [...base];
  swapped[10] = Object.freeze({ ...base[10]!, content: "supersedingtoken appeared" }) as MemoryEntry;
  const hits = engine.search(swapped, query);
  assert.deepEqual(hits.map((r) => r.entry.id), [base[10]!.id]);
});

// ---------------------------------------------------------------------------
// The wiring. Three independent statements, because each alone is dodgeable.
// ---------------------------------------------------------------------------

test("memory store: the answer is the engine's answer, not one the store computed", () => {
  // Identity, not equality: the store must hand back exactly what the engine
  // produced. A store that computed its own results and happened to agree
  // would fail this, which is the point.
  const sentinel: readonly MemorySearchResult[] = Object.freeze([]);
  let sawEntries = 0;
  const probe: MemorySearchEngine = {
    search(entries): readonly MemorySearchResult[] {
      sawEntries = entries.length;
      return sentinel;
    },
  };
  const dir = mkTempDir("memory-engine-wiring-");
  try {
    const timeline = createTimelineStore({ path: join(dir, "wiring.db") });
    const memory = createMemoryStore({ store: timeline, searchEngine: probe });
    memory.addShortTerm("landlock guardian budget");
    const out = memory.search(createMemorySearchQuery({ text: "landlock", limit: 5 }));
    assert.equal(out, sentinel, "the store did not return the engine's result object");
    assert.equal(sawEntries, 1, "the store did not pass its entries to the engine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory store: no consumer constructs a search engine except through the resolver", () => {
  // Deny-by-default, over names discovered from the owner rather than written
  // down here: a `createSomeOtherSearchEngine` added tomorrow is forbidden in
  // consumers automatically, with nothing to remember.
  const ownerSource = read("src/memory/memory-search.ts");
  const engineFactories = parseExports(ownerSource).filter(
    (name) => /SearchEngine$/.test(name) && name !== "MemorySearchEngine" && name !== "SemanticSearchEngine",
  );
  const forbidden = engineFactories.filter((n) => n !== "resolveMemorySearchEngine");
  assert.ok(forbidden.length > 0, "found no engine constructors to forbid — the scan is looking at the wrong module");
  assert.ok(engineFactories.includes("resolveMemorySearchEngine"), "the resolver is not an export of the owner");

  // Dynamically discovered consumers: every module that reaches the search
  // owner's runtime values at all, in any of the five import spellings.
  const consumers = ["src/memory/memory-store.ts", "src/memory/attempt-history.ts"];
  for (const rel of consumers) {
    const source = read(rel);
    assert.ok(
      valueReferencesModule(source, "memory-search.ts"),
      `${rel} no longer reaches the search owner at all — the scan below would pass over nothing`,
    );
    for (const name of forbidden) {
      assert.ok(
        !new RegExp(`\\b${name}\\b`).test(source),
        `${rel} names ${name} directly; the engine choice must come from resolveMemorySearchEngine so the configured value is what runs`,
      );
    }
    assert.match(
      source,
      /resolveMemorySearchEngine\s*\(/,
      `${rel} does not call resolveMemorySearchEngine`,
    );
  }
});

test("memory store: the engine the shipped configuration names is the one that gets built", () => {
  // A bound taken from the config owner rather than from this test. If the
  // document's value stopped reaching the store — or the resolver started
  // ignoring it — the engine built here would read the whole corpus per query
  // and the measured bound would fail.
  const document = JSON.parse(read("bridlewise.config.json")) as { memory?: { searchEngine?: unknown } };
  const configured = document.memory?.searchEngine;
  assert.ok(
    MEMORY_SEARCH_ENGINE_KINDS.includes(configured as MemorySearchEngineKind),
    `the config document names an engine the memory module does not declare: ${String(configured)}`,
  );
  const resolved = resolveMemoryConfig({ searchEngine: configured as MemorySearchEngineKind });
  const { fold, perQuery } = measure(resolveMemorySearchEngine(resolved.searchEngine));
  assert.ok(fold >= CORPUS_SIZE);
  for (const q of perQuery) {
    assert.ok(
      q.reads <= q.rows,
      `the engine named by the shipped configuration (${String(configured)}) read ${q.reads} entries to answer "${q.term}" with ${q.rows} rows; it re-reads the corpus per query`,
    );
  }
});

test("memory config: an engine name the module does not declare is refused, not defaulted", () => {
  assert.throws(
    () => resolveMemoryConfig({ searchEngine: "inverted_index" as MemorySearchEngineKind }),
    (err: unknown) => {
      assert.ok(err instanceof InputError, `expected InputError, got ${err instanceof Error ? err.constructor.name : typeof err}`);
      assert.equal(err.code, "memory_config_invalid");
      assert.match(err.message, /searchEngine must be one of/u);
      for (const kind of MEMORY_SEARCH_ENGINE_KINDS) assert.match(err.message, new RegExp(kind));
      return true;
    },
  );
  // The accepting half: every declared kind resolves.
  for (const kind of MEMORY_SEARCH_ENGINE_KINDS) {
    assert.equal(resolveMemoryConfig({ searchEngine: kind }).searchEngine, kind);
  }
});

// ---------------------------------------------------------------------------
// The config document's own gate. `memory.searchEngine` is only worth having
// if a wrong value cannot be written; and the retrieval knob map next door was
// the standing counter-example — anything at all validated there.
// ---------------------------------------------------------------------------

function parseDocument(mutate: (doc: Record<string, unknown>) => void): { ok: boolean; message: string } {
  const doc = JSON.parse(read("bridlewise.config.json")) as Record<string, unknown>;
  mutate(doc);
  const result = CONFIG_DOCUMENT_SCHEMA.safeParse(doc);
  return { ok: result.success, message: result.success ? "" : JSON.stringify(result.error.issues) };
}

test("config document: the shipped document validates, so the rejections below mean something", () => {
  const { ok, message } = parseDocument(() => {});
  assert.ok(ok, `the shipped config document does not validate: ${message}`);
});

test("config document: a memory search engine that does not exist is rejected at the write gate", () => {
  const { ok, message } = parseDocument((doc) => {
    (doc["memory"] as Record<string, unknown>)["searchEngine"] = "inverted_index";
  });
  assert.equal(ok, false, "the write gate accepted an engine name the memory module does not declare");
  assert.match(message, /searchEngine/u);
});

test("config document: a misspelled retrieval knob is rejected, and the real one is not", () => {
  // The knob map used to be an unconstrained numeric record: `bm25k1`
  // validated here, was dropped by the reader that forwards only known names,
  // and never reached the resolver that would have refused it. Accepted at
  // every step, applied at none.
  const real = INTELLIGENCE_SETTING_NAMES.find((n) => n === "bm25K1");
  assert.ok(real !== undefined, "the intelligence layer no longer declares bm25K1 — pick another live knob");

  const misspelled = parseDocument((doc) => {
    const ci = doc["codeIntelligence"] as Record<string, unknown>;
    (ci["retrieval"] as Record<string, unknown>)["bm25k1"] = 1.4;
  });
  assert.equal(misspelled.ok, false, "the write gate accepted a retrieval knob the intelligence layer does not answer to");
  assert.match(misspelled.message, /bm25k1/u);

  const correct = parseDocument((doc) => {
    const ci = doc["codeIntelligence"] as Record<string, unknown>;
    (ci["retrieval"] as Record<string, unknown>)[real] = 1.4;
  });
  assert.ok(correct.ok, `the write gate rejected a knob the intelligence layer does declare: ${correct.message}`);
});

// ---------------------------------------------------------------------------
// The scanner the wiring guard leans on, including the half that must NOT
// fire. A scan that answers yes to everything makes every guard built on it
// pass, and looks exactly like a guard that works.
// ---------------------------------------------------------------------------

test("source scan: all five ways of reaching a module's values are seen, and type-only reaching is not", () => {
  const reaching = [
    `import { a } from "./memory-search.ts";`,
    `import "./memory-search.ts";`,
    `import * as engine from "./memory-search.ts";`,
    `export { a } from "./memory-search.ts";`,
    `export * from "./memory-search.ts";`,
    `const m = await import("./memory-search.ts");`,
    `const m = require("./memory-search.ts");`,
  ];
  for (const source of reaching) {
    assert.ok(valueReferencesModule(source, "memory-search.ts"), `missed: ${source}`);
  }

  const notReaching = [
    `import type { A } from "./memory-search.ts";`,
    `import { type A, type B } from "./memory-search.ts";`,
    `export type { A } from "./memory-search.ts";`,
    `// import { a } from "./memory-search.ts";`,
    `throw new Error("failed while loading ./memory-search.ts");`,
  ];
  for (const source of notReaching) {
    assert.equal(valueReferencesModule(source, "memory-search.ts"), false, `false positive: ${source}`);
  }
});
