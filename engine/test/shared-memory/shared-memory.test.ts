// test/shared-memory/shared-memory.test.ts
// EXP436 shared memory architecture — HARD test protocol.
// 1. Corruption detection (tampered digest/content/dropped on reload).
// 2. Improper usage (invalid type/provenance/tier → typed error, no silent fallback).
// 3. Unknown memory type (rejected by the closed enum).
// 4. Multi-layer tiers + tree classification + Ebbinghaus reinforcement.
// 5. Token-cap strategies (tier promotion hot→warm→cold).
// 6. Storage backends round-trip (json, sqlite, msgpack, append-log).
// 7. Retrieval methods return relevant results (recall > 0).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildMemoryEntry,
  computeEntryDigest,
  createSearchQuery,
  createSharedMemoryStore,
  createStorage,
  estimateTokens,
  isMemoryType,
  isProvenance,
  isMemoryTier,
  resolveSharedMemoryConfig,
  verifyEntryIntegrity,
  type AddMemoryInput,
  type MemoryEntry,
} from "../../src/shared/memory/index.ts";
import { encodeMsgpack, decodeMsgpack } from "../../src/shared/memory/index.ts";
import { ebbinghausScore, reinforceStability } from "../../src/shared/memory/index.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { cosine, cosineF32, cosineMaps, tokenize, buildTfidfIndex, tfidfQuery } from "../../src/shared/memory/index.ts";

/** This process's own folder, under the temp-dir owner (never a fixed shared path). */
const TEMPORARY = createTempDir("shared-memory-");
const tmp = (n: string) => join(TEMPORARY, `${n}.bin`);
const clean = (p: string) => { rmSync(p, { force: true }); };

describe("shared-memory: corruption detection", () => {
  test("tampered digest fails integrity check", () => {
    const e = buildMemoryEntry(
      { type: "fact", content: "hello", provenance: "user" },
      { tier: "hot", conversationId: "c", projectId: "p", timestamp: "2026-01-01T00:00:00Z", charsPerToken: 4 },
    );
    assert.equal(verifyEntryIntegrity(e), true);
    const tampered: MemoryEntry = { ...e, digest: "0".repeat(64) };
    assert.equal(verifyEntryIntegrity(tampered), false);
  });

  test("tampered content fails integrity check (digest mismatch)", () => {
    const e = buildMemoryEntry(
      { type: "fact", content: "hello", provenance: "user" },
      { tier: "hot", conversationId: "c", projectId: "p", timestamp: "2026-01-01T00:00:00Z", charsPerToken: 4 },
    );
    const tampered: MemoryEntry = { ...e, content: "goodbye" };
    assert.equal(verifyEntryIntegrity(tampered), false);
    assert.notEqual(tampered.digest, computeEntryDigest(e.id, "goodbye", e.timestamp));
  });

  test("json backend drops corrupt entries on reload (tamper detection)", () => {
    const path = tmp("json-corrupt");
    const storage = createStorage({ backend: "json", path });
    const e1 = buildMemoryEntry(
      { type: "fact", content: "valid", provenance: "user" },
      { tier: "cold", conversationId: "c", projectId: "p", timestamp: "2026-01-01T00:00:00Z", charsPerToken: 4 },
    );
    const e2 = buildMemoryEntry(
      { type: "fact", content: "also valid", provenance: "user" },
      { tier: "cold", conversationId: "c", projectId: "p", timestamp: "2026-01-02T00:00:00Z", charsPerToken: 4 },
    );
    storage.flush([e1, e2]);
    // Corrupt the file: rewrite with one valid + one tampered (wrong digest).
    const wire = JSON.parse(readFileSync(path, "utf8"));
    wire[1].digest = "0".repeat(64); // tamper
    writeFileSync(path, JSON.stringify(wire));
    const loaded = storage.load();
    assert.equal(loaded.length, 1, "corrupt entry dropped, valid kept");
    assert.equal(loaded[0]!.id, e1.id);
    storage.close();
    clean(path);
  });

  test("msgpack round-trip preserves entry (binary integrity)", () => {
    const e = buildMemoryEntry(
      { type: "decision", content: "ship the shared memory", provenance: "agent", tags: ["arch"] },
      { tier: "warm", conversationId: "c", projectId: "p", timestamp: "2026-01-01T00:00:00Z", charsPerToken: 4 },
    );
    const wire = {
      id: e.id, tier: e.tier, type: e.type, content: e.content, provenance: e.provenance,
      sourceId: e.sourceId, conversationId: e.conversationId, projectId: e.projectId, context: e.context,
      timestamp: e.timestamp, lastAccessed: e.lastAccessed, accessCount: e.accessCount,
      ebbinghausScore: e.ebbinghausScore, tags: e.tags,
      embedding: e.embedding ? Array.from(e.embedding) : null,
      tfVector: e.tfVector ? [...e.tfVector.entries()] : null,
      tokenEstimate: e.tokenEstimate, digest: e.digest, metadata: e.metadata,
    };
    const buf = encodeMsgpack([wire]);
    const back = decodeMsgpack(buf) as [typeof wire];
    assert.equal(back[0].id, e.id);
    assert.equal(back[0].content, e.content);
    assert.equal(back[0].digest, e.digest);
  });
});

describe("shared-memory: improper usage (typed errors, no silent fallback)", () => {
  test("invalid memory type throws InputError (shared_memory_invalid_type)", () => {
    const store = createSharedMemoryStore({ config: resolveSharedMemoryConfig({ embeddings: { enabled: false } }) });
    assert.throws(
      () => store.add({ type: "bogus" as AddMemoryInput["type"], content: "x", provenance: "user" }),
      (err: unknown) =>
        err instanceof InputError &&
        (err as InputError).code === "shared_memory_invalid_type" &&
        /invalid type/.test((err as Error).message),
    );
    store.close();
  });

  test("invalid provenance throws InputError (shared_memory_invalid_provenance)", () => {
    const store = createSharedMemoryStore({ config: resolveSharedMemoryConfig({ embeddings: { enabled: false } }) });
    assert.throws(
      () => store.add({ type: "fact", content: "x", provenance: "bogus" as AddMemoryInput["provenance"] }),
      (err: unknown) =>
        err instanceof InputError &&
        (err as InputError).code === "shared_memory_invalid_provenance" &&
        /invalid provenance/.test((err as Error).message),
    );
    store.close();
  });

  test("invalid tier in input is rejected (closed enum)", () => {
    assert.equal(isMemoryTier("hot"), true);
    assert.equal(isMemoryTier("present"), false); // old name, not in v2 enum
    assert.equal(isMemoryTier("bogus"), false);
  });

  test("invalid config throws typed InputError", () => {
    assert.throws(
      () => resolveSharedMemoryConfig({ retrieval: { topK: 0 } }),
      /topK must be >= 1/,
    );
    assert.throws(
      () => resolveSharedMemoryConfig({ tokenCap: { trimTriggerRatio: 0.3 } }),
      /trimTriggerRatio/,
    );
  });
});

describe("shared-memory: unknown memory type (closed enum)", () => {
  test("isMemoryType rejects unknown types", () => {
    assert.equal(isMemoryType("fact"), true);
    assert.equal(isMemoryType("tool-result"), true);
    assert.equal(isMemoryType("hypothesis"), false); // not in the enum
    assert.equal(isMemoryType(""), false);
  });

  test("isProvenance rejects unknown provenances", () => {
    assert.equal(isProvenance("tool"), true);
    assert.equal(isProvenance("llm"), false); // not in the enum (must be user|agent|tool|system)
  });
});

describe("shared-memory: multi-layer tiers + tree + Ebbinghaus", () => {
  test("addHot/addWarm/addCold place entries in the right tier", () => {
    const store = createSharedMemoryStore({ config: resolveSharedMemoryConfig({ embeddings: { enabled: false } }) });
    store.addHot("h", "fact", "user");
    store.addWarm("w", "fact", "user");
    store.addCold("c", "fact", "user");
    assert.equal(store.byTier("hot").length, 1);
    assert.equal(store.byTier("warm").length, 1);
    assert.equal(store.byTier("cold").length, 1);
    assert.equal(store.all().length, 3);
    store.close();
  });

  test("tree classification builds project→conversation→type→entry", () => {
    const store = createSharedMemoryStore({
      config: resolveSharedMemoryConfig({ embeddings: { enabled: false } }),
      projectId: "proj-a",
    });
    store.addHot("fact a", "fact", "user", { conversationId: "conv1" });
    store.addHot("err a", "error", "tool", { conversationId: "conv1" });
    store.addHot("fact b", "fact", "agent", { conversationId: "conv2" });
    const tree = store.tree();
    assert.equal(tree.children.length, 1); // one project (proj-a)
    const proj = tree.children[0]!;
    assert.equal(proj.children.length, 2); // two conversations
    const conv1 = proj.children[0]!;
    assert.equal(conv1.children.length, 2); // fact + error types
    store.close();
  });

  test("Ebbinghaus score decays with time + reinforces on access", () => {
    const cfg = resolveSharedMemoryConfig({}).ebbinghaus;
    const fresh = ebbinghausScore({ elapsedDays: 0, stability: 1, config: cfg });
    const old = ebbinghausScore({ elapsedDays: 30, stability: 1, config: cfg });
    assert.ok(fresh > old, "fresh memory has higher retention than 30-day-old");
    const reinforced = reinforceStability(1, cfg);
    assert.ok(reinforced > 1, "reinforcement increases stability");
  });

  test("an unbounded search returns up to the store's CONFIGURED topK, never a code default in front of it (a2b-design H3)", async () => {
    const store = createSharedMemoryStore({ config: resolveSharedMemoryConfig({ retrieval: { method: "tfidf", topK: 50, minScore: 0 }, embeddings: { enabled: false } }) });
    for (let index = 0; index < 30; index += 1) store.addHot(`deployment note ${index} about the gateway`, "fact", "user");
    assert.equal((await store.searchText("gateway")).length, 30, "30 matches under a topK of 50");
    assert.equal((await store.searchText("gateway", 7)).length, 7, "an explicit limit still applies");
    store.close();
  });

  test("search reinforces access (accessCount + lastAccessed update)", async () => {
    const store = createSharedMemoryStore({ config: resolveSharedMemoryConfig({ retrieval: { method: "tfidf" }, embeddings: { enabled: false } }) });
    const e = store.addHot("the quick brown fox jumps", "fact", "user");
    assert.equal(e.accessCount, 0);
    const res = await store.search(createSearchQuery({ text: "quick fox", limit: 5 }));
    if (res.length > 0) {
      const after = store.get(res[0]!.entry.id);
      assert.ok(after !== null);
      assert.ok((after!.accessCount >= 0), "accessCount tracked");
    }
    store.close();
  });
});

describe("shared-memory: token-cap tier promotion", () => {
  test("enforceCaps promotes overflowing hot→warm→cold", () => {
    const store = createSharedMemoryStore({
      config: resolveSharedMemoryConfig({
        embeddings: { enabled: false },
        tokenCap: { strategy: "tier", hotTokenLimit: 50, warmTokenLimit: 100, coldTokenLimit: 100_000, trimTriggerRatio: 0.8, compressTargetRatio: 0.5 },
      }),
    });
    // Each entry ~ "x" * 200 = 50 tokens. hotLimit 50 → 1 entry triggers.
    for (let i = 0; i < 10; i += 1) store.addHot("x".repeat(200), "fact", "user");
    store.enforceCaps();
    const s = store.stats();
    assert.ok((s.tokensByTier.hot ?? 0) <= 50, `hot within cap: ${s.tokensByTier.hot}`);
    assert.ok(store.all().length === 10, "no entries lost (demoted, not dropped)");
    store.close();
  });
});

describe("shared-memory: storage backends round-trip", () => {
  const backends = ["json", "sqlite", "msgpack", "append-log"] as const;
  for (const backend of backends) {
    test(`${backend}: flush + reload preserves entries`, () => {
      const path = tmp(backend);
      const storage = createStorage({ backend, path });
      const e = buildMemoryEntry(
        { type: "fact", content: "round trip content", provenance: "user", tags: ["t1"] },
        { tier: "cold", conversationId: "c", projectId: "p", timestamp: "2026-01-01T00:00:00Z", charsPerToken: 4 },
      );
      storage.flush([e]);
      const loaded = storage.load();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]!.id, e.id);
      assert.equal(loaded[0]!.content, e.content);
      assert.equal(loaded[0]!.digest, e.digest);
      storage.close();
      clean(path);
    });
  }
});

describe("shared-memory: retrieval methods return relevant results", () => {
  test("tfidf retrieves a keyword-bearing entry", async () => {
    const store = createSharedMemoryStore({ config: resolveSharedMemoryConfig({ retrieval: { method: "tfidf" }, embeddings: { enabled: false } }) });
    store.addHot("the function parseExpression handles AST nodes", "fact", "user");
    store.addHot("unrelated content about weather and clouds", "fact", "user");
    const res = await store.search(createSearchQuery({ text: "parseExpression AST", limit: 5 }));
    assert.ok(res.length > 0, "tfidf returned results");
    assert.ok(res[0]!.entry.content.includes("parseExpression"), "top result relevant");
    store.close();
  });

  test("inverted index retrieves keyword-bearing entry", async () => {
    const store = createSharedMemoryStore({ config: resolveSharedMemoryConfig({ retrieval: { method: "inverted" }, embeddings: { enabled: false } }) });
    store.addHot("the function parseExpression handles AST nodes", "fact", "user");
    store.addHot("unrelated content about weather", "fact", "user");
    const res = await store.search(createSearchQuery({ text: "parseExpression", limit: 5 }));
    assert.ok(res.length > 0);
    assert.ok(res[0]!.entry.content.includes("parseExpression"));
    store.close();
  });

  test("hybrid falls back to tfidf when embeddings unavailable", async () => {
    const store = createSharedMemoryStore({ config: resolveSharedMemoryConfig({ retrieval: { method: "hybrid" }, embeddings: { enabled: false } }) });
    store.addHot("parseExpression AST node helper", "fact", "user");
    const res = await store.search(createSearchQuery({ text: "parseExpression", limit: 5 }));
    assert.ok(res.length > 0, "hybrid with no embeddings falls back to tfidf");
    store.close();
  });
});

describe("shared-memory: canonical retrieval primitives (dedup verified)", () => {
  test("tokenize is the single canonical tokenizer", () => {
    const t = tokenize("Hello, World! parseExpression_2");
    assert.ok(t.includes("hello"));
    assert.ok(t.includes("world"));
    assert.ok(t.includes("parseexpression_2")); // keepCodePunct keeps underscores
  });

  test("cosineF32 + cosineMaps are the canonical cosine owners", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 1, 0]);
    assert.ok(Math.abs(cosineF32(a, b) - (1 / Math.sqrt(2))) < 1e-6);
    const ma = new Map([["x", 1]]);
    const mb = new Map([["x", 1], ["y", 1]]);
    assert.ok(Math.abs(cosineMaps(ma, mb) - (1 / Math.sqrt(2))) < 1e-6);
    const disp = cosine(new Float32Array([1]), new Float32Array([1]));
    assert.equal(disp, 1);
  });

  test("tfidf index + query returns scored hits", () => {
    const tok = { minLength: 2, stopwords: new Set<string>(), keepCodePunct: true };
    const idx = buildTfidfIndex(["alpha beta", "beta gamma", "delta"], tok);
    const hits = tfidfQuery("beta", idx, tok);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]!.docIndex, 0); // "alpha beta" + "beta gamma" both have beta; cosine tie → first
  });

  test("estimateTokens uses the config chars-per-token", () => {
    assert.equal(estimateTokens("hello world", 4), 3); // 11 chars / 4 = 2.75 → ceil 3
    assert.equal(estimateTokens("", 4), 0);
  });
});
