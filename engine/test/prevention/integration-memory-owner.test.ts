// test/prevention/integration-memory-owner.test.ts
// SPO R42: Integration memory subsystem owner audit — mechanical enforcement.
//
// Verifies the Single-Party-Owner principle for `integration/src/memory/` +
// `integration/src/shared/memory/`:
// A. Config owner: retrieval boost weights / batch size / large-scale
// threshold live in `unified/unified-config.ts` (single owner), NOT
// hardcoded in `unified/unified-memory-store.ts`.
// B. No swallowed `.catch(() => {})` handlers in the memory subsystem. Every
// other catch (bare `catch {` included) is classified by the ONE shared catch
// classifier through `no-unhandled-errors`, which covers all of `src/`.
// C. No generic `throw new TypeError` for input/config validation in the
// shared memory entry/store/backend (use the typed `InputError`).
// D. The shared-memory-store comment does NOT lie about replacing
// memory-store.ts (memory-store.ts is the live web-UI conversation
// memory owner via server/memory-bridge.ts).
// E. resolveUnifiedConfig validates the new config fields.
//
// Dynamic discovery: no hardcoded file lists — `readdirSync`
// walks the memory trees. Mutation-verified (see bottom).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { InputError } from "../../src/kernel/errors.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

const ROOT = process.cwd();
const MEMORY_DIR = join(ROOT, "src", "memory");
const SHARED_MEMORY_DIR = join(ROOT, "src", "shared", "memory");

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"] })) {
    if (!file.endsWith(".test.ts")) acc.push(file);
  }
  return acc;
}

function read(p: string): string {
  return readFileSync(p, "utf8");
}

// All memory subsystem source files (dynamically discovered).
const memoryFiles: string[] = [...listTsFiles(MEMORY_DIR), ...listTsFiles(SHARED_MEMORY_DIR)];

// --- A. Config owner: boost weights / batch size / threshold are in unified-config, not hardcoded in the store. ---
test("A1: unified-config exports retrievalBoost + embeddingBatchSize + largeScaleIdfFloorThreshold", () => {
  const cfg = read(join(MEMORY_DIR, "unified", "unified-config.ts"));
  assert.match(cfg, /retrievalBoost\s*[:?]/, "unified-config must declare retrievalBoost");
  assert.match(cfg, /embeddingBatchSize\s*[:?]/, "unified-config must declare embeddingBatchSize");
  assert.match(cfg, /largeScaleIdfFloorThreshold\s*[:?]/, "unified-config must declare largeScaleIdfFloorThreshold");
  assert.match(cfg, /RetrievalBoostConfig/, "unified-config must declare RetrievalBoostConfig type");
  assert.match(cfg, /kindFactAwarenessBoost/, "RetrievalBoostConfig must have kindFactAwarenessBoost");
  assert.match(cfg, /DEFAULT_RETRIEVAL_BOOST_CONFIG/, "unified-config must export DEFAULT_RETRIEVAL_BOOST_CONFIG");
});

test("A2: unified-memory-store reads boost/batch/threshold from config (no hardcoded deltas)", () => {
  const store = read(join(MEMORY_DIR, "unified", "unified-memory-store.ts"));
  // Must reference the config-backed fields.
  assert.match(store, /cfg\.retrievalBoost\.kindFactAwarenessBoost/, "store must use cfg.retrievalBoost.kindFactAwarenessBoost");
  assert.match(store, /cfg\.retrievalBoost\.kindDecisionBoost/, "store must use cfg.retrievalBoost.kindDecisionBoost");
  assert.match(store, /cfg\.retrievalBoost\.topicMatchBoost/, "store must use cfg.retrievalBoost.topicMatchBoost");
  assert.match(store, /cfg\.retrievalBoost\.tagMatchBoost/, "store must use cfg.retrievalBoost.tagMatchBoost");
  assert.match(store, /cfg\.retrievalBoost\.hotModuleBoost/, "store must use cfg.retrievalBoost.hotModuleBoost");
  assert.match(store, /cfg\.embeddingBatchSize/, "store must use cfg.embeddingBatchSize");
  assert.match(store, /cfg\.largeScaleIdfFloorThreshold/, "store must use cfg.largeScaleIdfFloorThreshold");
  // Must NOT contain the old hardcoded score deltas (the specific boost pattern).
  assert.doesNotMatch(store, /score\s*\+=\s*0\.20\b/, "store must not hardcode score += 0.20");
  assert.doesNotMatch(store, /score\s*\+=\s*0\.15\b/, "store must not hardcode score += 0.15");
  assert.doesNotMatch(store, /const\s+batchSize\s*=\s*32\b/, "store must not hardcode batchSize = 32");
  assert.doesNotMatch(store, />=\s*100_000\b/, "store must not hardcode the 100_000 scale threshold");
});

test("A3: resolveUnifiedConfig validates the new config fields (rejects bad values)", () => {
  const cfg = read(join(MEMORY_DIR, "unified", "unified-config.ts"));
  assert.match(cfg, /largeScaleIdfFloorThreshold must be >= 1/, "must validate largeScaleIdfFloorThreshold");
  assert.match(cfg, /embeddingBatchSize must be >= 1/, "must validate embeddingBatchSize");
  // The boost validation uses a template literal `${name} must be a finite
  // non-negative number`; match the literal tail (dynamic discovery of the
  // message, not the interpolated variable).
  assert.match(cfg, /must be a finite non-negative number/, "must validate boost bounds");
});

// --- B. No swallowed catches in the memory subsystem (routed through handleError). ---
test("B1: no empty `.catch(() => {})` swallowed catches in memory subsystem", () => {
  const offenders: string[] = [];
  for (const f of memoryFiles) {
    const src = read(f);
    // Match `.catch(() => {` followed by only a comment then `})` — the
    // swallowed pattern. A routed catch binds the error (`(err) =>`).
    const re = /\.catch\(\(\)\s*=>\s*\{[^}]*\}\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const body = m[0];
      // Allow if the body references handleError (routed) — but an empty
      // arrow with no binding cannot route. Flag any ` =>` catch (no
      // error binding) as swallowed.
      if (!body.includes("handleError")) {
        offenders.push(`${f}: ${body.trim()}`);
      }
    }
  }
  assert.equal(offenders.length, 0, `swallowed .catch(() => {}) found:\n${offenders.join("\n")}`);
});

// --- C. No generic `throw new TypeError` for input/config validation in shared memory entry/store/backend. ---
test("C1: shared memory entry/store/backend use InputError (not TypeError) for input validation", () => {
  const targets = [
    join(SHARED_MEMORY_DIR, "memory-entry.ts"),
    join(SHARED_MEMORY_DIR, "shared-memory-store.ts"),
    join(SHARED_MEMORY_DIR, "storage", "backend.ts"),
  ];
  for (const f of targets) {
    if (!existsSync(f)) continue;
    const src = read(f);
    // The input-validation messages must use InputError.
    assert.doesNotMatch(src, /throw new TypeError\(`?(?:buildMemoryEntry:|shared-memory:)?\s*invalid (type|provenance|tier)/, `${f}: must use InputError for invalid type/provenance/tier`);
    assert.doesNotMatch(src, /throw new TypeError\("?(?:search limit|unknown storage)/, `${f}: must use InputError for search limit / unknown storage`);
    // And must import + use InputError.
    assert.match(src, /InputError/, `${f}: must reference InputError`);
  }
});

// --- D. The shared-memory-store comment must not lie about memory-store.ts being gone. ---
test("D1: shared-memory-store does not claim memory-store.ts is gone", () => {
  const src = read(join(SHARED_MEMORY_DIR, "shared-memory-store.ts"));
  assert.doesNotMatch(src, /Both are gone/, "shared-memory-store must not claim both previous stores are gone (memory-store.ts is the live web-UI owner)");
});

// --- E. Behavioral: resolveUnifiedConfig rejects bad new fields. ---
test("E1: resolveUnifiedConfig throws InputError for bad embeddingBatchSize / largeScaleIdfFloorThreshold / retrievalBoost", async () => {
  const { resolveUnifiedConfig } = await import("../../src/memory/unified/unified-config.ts");
  const { InputError } = await import("../../src/kernel/errors.ts");
  const assertInput = (fn: () => unknown, code: string) => {
    try {
      fn();
      assert.fail(`expected InputError for ${code}`);
    } catch (e) {
      assert.ok(e instanceof InputError, `${code}: expected InputError, got ${(e as Error).constructor.name}`);
      assert.equal((e as InputError).code !== undefined, true, `${code}: must have a code`);
    }
  };
  assertInput(() => resolveUnifiedConfig({ embeddingBatchSize: 0 }), "embeddingBatchSize=0");
  assertInput(() => resolveUnifiedConfig({ embeddingBatchSize: Number.NaN }), "embeddingBatchSize=NaN");
  assertInput(() => resolveUnifiedConfig({ largeScaleIdfFloorThreshold: 0 }), "largeScaleIdfFloorThreshold=0");
  assertInput(() => resolveUnifiedConfig({ largeScaleIdfFloorThreshold: Number.NaN }), "largeScaleIdfFloorThreshold=NaN");
  assertInput(() => resolveUnifiedConfig({ retrievalBoost: { kindFactAwarenessBoost: -1, kindDecisionBoost: 0.1, topicMatchBoost: 0.1, tagMatchBoost: 0.1, hotModuleBoost: 0.1 } }), "negative boost");
  assertInput(() => resolveUnifiedConfig({ retrievalBoost: { kindFactAwarenessBoost: Number.NaN, kindDecisionBoost: 0.1, topicMatchBoost: 0.1, tagMatchBoost: 0.1, hotModuleBoost: 0.1 } }), "NaN boost");
});

test("E2: resolveUnifiedConfig accepts good new fields and preserves defaults", async () => {
  const { resolveUnifiedConfig } = await import("../../src/memory/unified/unified-config.ts");
  const cfg = resolveUnifiedConfig({});
  assert.equal(cfg.embeddingBatchSize, 32, "default embeddingBatchSize");
  assert.equal(cfg.largeScaleIdfFloorThreshold, 100_000, "default largeScaleIdfFloorThreshold");
  assert.equal(cfg.retrievalBoost.kindFactAwarenessBoost, 0.20, "default kindFactAwarenessBoost");
  assert.equal(cfg.retrievalBoost.kindDecisionBoost, 0.10, "default kindDecisionBoost");
  assert.equal(cfg.retrievalBoost.topicMatchBoost, 0.15, "default topicMatchBoost");
  assert.equal(cfg.retrievalBoost.tagMatchBoost, 0.10, "default tagMatchBoost");
  assert.equal(cfg.retrievalBoost.hotModuleBoost, 0.10, "default hotModuleBoost");
  const custom = resolveUnifiedConfig({
    embeddingBatchSize: 64,
    largeScaleIdfFloorThreshold: 50_000,
    retrievalBoost: { kindFactAwarenessBoost: 0.5, kindDecisionBoost: 0, topicMatchBoost: 0, tagMatchBoost: 0, hotModuleBoost: 0 },
  });
  assert.equal(custom.embeddingBatchSize, 64, "custom embeddingBatchSize");
  assert.equal(custom.largeScaleIdfFloorThreshold, 50_000, "custom largeScaleIdfFloorThreshold");
  assert.equal(custom.retrievalBoost.kindFactAwarenessBoost, 0.5, "custom kindFactAwarenessBoost");
});

// --- Mutation verification: reintroducing each violation makes a test FAIL. ---
test("MUTATION: re-adding hardcoded `score += 0.20` to unified-memory-store makes A2 fail", () => {
  const store = read(join(MEMORY_DIR, "unified", "unified-memory-store.ts"));
  // Simulate the regression: the config-backed line replaced by a hardcoded delta.
  const mutated = store.replace("cfg.retrievalBoost.kindFactAwarenessBoost", "0.20");
  assert.doesNotMatch(mutated, /score\s*\+=\s*cfg\.retrievalBoost\.kindFactAwarenessBoost/, "mutation: config reference removed");
  assert.match(mutated, /score\s*\+=\s*0\.20\b/, "mutation: hardcoded delta present — A2 would fail");
});

test("MUTATION: re-adding a swallowed `.catch(() => {})` makes B1 fail", () => {
  const fake = "x.catch(() => { /* swallow */ });";
  const re = /\.catch\(\(\)\s*=>\s*\{[^}]*\}\)/g;
  const m = re.exec(fake);
  assert.ok(m !== null, "mutation: swallowed catch pattern detected by B1 regex");
  assert.ok(!m[0].includes("handleError"), "mutation: body has no handleError — B1 flags it");
});

test("MUTATION: reverting memory-entry.ts to `throw new TypeError` makes C1 fail", () => {
  const entry = read(join(SHARED_MEMORY_DIR, "memory-entry.ts"));
  // Confirm the current (fixed) state does NOT have the TypeError for invalid type.
  assert.doesNotMatch(entry, /throw new TypeError\(`buildMemoryEntry: invalid type/, "current: no TypeError for invalid type");
  const mutated = entry.replace("throw new InputError(`buildMemoryEntry: invalid type", "throw new TypeError(`buildMemoryEntry: invalid type");
  assert.match(mutated, /throw new TypeError\(`buildMemoryEntry: invalid type/, "mutation: TypeError restored — C1 would fail");
});
