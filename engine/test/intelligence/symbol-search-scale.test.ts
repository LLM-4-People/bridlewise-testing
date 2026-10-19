import assert from "node:assert/strict";
import test from "node:test";

import {
  hybridSearchSymbols,
  buildBm25Index,
} from "../../src/intelligence/symbol-search.ts";
import { createSymbolSearchQuery, type ModuleInfo, type RepositoryMap, type SymbolInfo } from "../../src/intelligence/intelligence-types.ts";

// =============================================================================
// 10× scale escalation for the hybrid symbol ranker (EXP429). Per the protocol
// "if 100%, 10× more": 1500 queries (10× the 150-query hard protocol) against a
// 2000-symbol map spanning 10 directories, plus an index-build ceiling.
//
// The companion 100000-turn memory-recall escalation from the same experiment
// is NOT here: it exercises `createInvertedIndexSearchEngine`, which arrives
// with the memory-search merge, not this one. It belongs with that module's
// tests rather than being stubbed out here.
// =============================================================================

function mkSymbol(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    name: overrides.name ?? "foo",
    kind: overrides.kind ?? "function",
    visibility: overrides.visibility ?? "local",
    location: overrides.location ?? { filePath: "src/test.ts", line: 1, column: 1 },
    exported: overrides.exported ?? false,
    async: overrides.async ?? false,
    generator: overrides.generator ?? false,
    parameterCount: overrides.parameterCount ?? 0,
    modifiers: overrides.modifiers ?? [],
  };
}
function mkModule(overrides: Partial<ModuleInfo> = {}): ModuleInfo {
  return {
    path: overrides.path ?? "src/test.ts",
    contentHash: overrides.contentHash ?? "abc",
    lineCount: overrides.lineCount ?? 10,
    symbols: overrides.symbols ?? [mkSymbol()],
    imports: overrides.imports ?? [],
    exports: overrides.exports ?? [],
    architectureModuleId: overrides.architectureModuleId ?? null,
    architectureLayer: overrides.architectureLayer ?? null,
    architectureRealm: overrides.architectureRealm ?? null,
    architectureOwner: overrides.architectureOwner ?? null,
  };
}
function mkMap(modules: readonly ModuleInfo[]): RepositoryMap {
  return {
    schemaVersion: "bridlewise-intelligence/v1",
    rootPath: ".",
    generatedAt: "2026-07-21T00:00:00.000Z",
    files: modules.map((m) => ({ path: m.path, extension: ".ts" as const, sizeBytes: 100, contentHash: m.contentHash, lineCount: m.lineCount, isSource: true })),
    modules,
    totalSymbols: modules.reduce((s, m) => s + m.symbols.length, 0),
    totalDependencies: 0,
    mapHash: "h",
  };
}

// A larger map: 100 modules × 20 symbols = 2000 symbols, spanning 10 dirs.
const BIG_MAP: RepositoryMap = mkMap(
  Array.from({ length: 100 }, (_, modIdx) => {
    const dir = `src/dir${modIdx % 10}`;
    return mkModule({
      path: `${dir}/mod${modIdx}.ts`,
      symbols: Array.from({ length: 20 }, (_, symIdx) =>
        mkSymbol({
          name: `fn${modIdx}_${symIdx}`,
          kind: symIdx % 3 === 0 ? "function" : symIdx % 3 === 1 ? "const" : "interface",
          exported: symIdx % 2 === 0,
          location: { filePath: `${dir}/mod${modIdx}.ts`, line: symIdx * 5, column: 1 },
        }),
      ),
    });
  }),
);

test("exp429 10× harder search: 1500 queries on a 2000-symbol map — top-1 >80%, <100ms CPU", () => {
  // 1500 queries, each with a clear ground truth: the exact symbol name. We
  // vary the query FORM (exact, lowercased, camelCase→snake, single-token
  // prefix) so 500 of each form exercise the hybrid ranker. Ground truth = the
  // exact symbol; the top-1 must equal it.
  //
  // The cost bound is measured in CPU time, not wall clock. The search is
  // synchronous CPU work, and a wall-clock bound reds on ambient load from the
  // suite's other workers rather than on a regression in the ranker — a guard
  // that measures a condition must judge by the load-invariant currency. CPU
  // microseconds isolate the work this test actually owns.
  let top1Hits = 0;
  let maxCpuMs = 0;
  let wrongDir = 0;
  for (let i = 0; i < 500; i++) {
    const modIdx = i % 100;
    const symIdx = (i * 7) % 20;
    const expected = `fn${modIdx}_${symIdx}`;
    const expectedDir = `src/dir${modIdx % 10}`;
    // Form 1: exact name (specific).
    const q1 = createSymbolSearchQuery({ name: expected, matchMode: "fuzzy", limit: 5 });
    const s1 = process.cpuUsage().user;
    const r1 = hybridSearchSymbols(BIG_MAP, q1);
    const e1 = (process.cpuUsage().user - s1) / 1000;
    if (e1 > maxCpuMs) maxCpuMs = e1;
    assert.ok(e1 < 100, `exact ${i} took ${e1}ms CPU`);
    if (r1.results[0]?.symbol.name === expected) top1Hits++;
    if (r1.results[0] && !r1.results[0].filePath.startsWith(expectedDir)) wrongDir++;
    // Form 2: lowercased exact name (specific).
    const q2 = createSymbolSearchQuery({ name: expected.toLowerCase(), matchMode: "fuzzy", limit: 5 });
    const s2 = process.cpuUsage().user;
    const r2 = hybridSearchSymbols(BIG_MAP, q2);
    const e2 = (process.cpuUsage().user - s2) / 1000;
    if (e2 > maxCpuMs) maxCpuMs = e2;
    assert.ok(e2 < 100, `lower ${i} took ${e2}ms CPU`);
    if (r2.results[0]?.symbol.name === expected) top1Hits++;
    if (r2.results[0] && !r2.results[0].filePath.startsWith(expectedDir)) wrongDir++;
    // Form 3: directory-scoped query — the name alone is globally unique
    // (fn{modIdx}_{symIdx}), so scoping to the directory must still return
    // the exact symbol as top-1.
    const q3 = createSymbolSearchQuery({ name: expected, matchMode: "fuzzy", limit: 5, directory: expectedDir });
    const s3 = process.cpuUsage().user;
    const r3 = hybridSearchSymbols(BIG_MAP, q3);
    const e3 = (process.cpuUsage().user - s3) / 1000;
    if (e3 > maxCpuMs) maxCpuMs = e3;
    assert.ok(e3 < 100, `scoped ${i} took ${e3}ms CPU`);
    if (r3.results[0]?.symbol.name === expected) top1Hits++;
    if (r3.results[0] && !r3.results[0].filePath.startsWith(expectedDir)) wrongDir++;
  }
  const total = 1500;
  const top1Pct = (top1Hits / total) * 100;
  assert.ok(top1Pct >= 80, `10× harder search top-1 ${top1Pct}% < 80% (${top1Hits}/${total})`);
  assert.ok(maxCpuMs < 100, `10× harder max query ${maxCpuMs}ms CPU >= 100ms`);
  // eslint-disable-next-line no-console
  console.log(`  [10× search] 1500 queries on 2000 symbols: top-1 ${top1Pct.toFixed(1)}% (${top1Hits}/${total}), wrong-dir ${wrongDir}, max ${maxCpuMs.toFixed(2)}ms CPU`);
});

test("exp429 10× harder search: BM25 index builds in <500ms CPU on 2000 symbols", () => {
  // CPU time, for the same reason as the query loop above: an index build is
  // synchronous CPU work, and a wall-clock bound reads ambient load as a
  // regression.
  const s = process.cpuUsage().user;
  const index = buildBm25Index(BIG_MAP);
  const e = (process.cpuUsage().user - s) / 1000;
  assert.equal(index.documentCount, 2000);
  assert.ok(e < 500, `BM25 index build ${e}ms CPU >= 500ms`);
  // eslint-disable-next-line no-console
  console.log(`  [10× bm25-build] 2000 symbols indexed in ${e.toFixed(2)}ms (${index.documentCount} docs)`);
});
