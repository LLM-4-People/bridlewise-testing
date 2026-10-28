// @vitest-environment node
/**
 * The CHOKE POINT: provenance is captured by the Broker, by nobody else, and
 * without any call site opting in.
 *
 * This is the test that makes LENS structural rather than conventional. Every
 * assertion below is written from the caller's point of view — `read()` is
 * invoked exactly as any feature would invoke it, passing NOTHING about
 * provenance — and then the ledger is inspected. If provenance required
 * cooperation from the call site, every one of these would fail.
 *
 * The second theme is non-fabrication. A read that returns no `asOf`, a read
 * that fails, a superseded response: each has a test proving the ledger
 * records what actually happened rather than a plausible reconstruction.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import { clearCache, read } from "../../src/data/broker.ts";
import {
  clearProvenance,
  currentProvenance,
  provenanceFor,
  provenanceListenerCount,
  provenanceLog,
  subscribeProvenance,
} from "../../src/data/ledger.ts";
import { PROVENANCE_HISTORY_LIMIT } from "../../shared/provenance.ts";

const realFetch = globalThis.fetch;

/** Build a Response carrying a block envelope. */
function envelopeResponse(data: unknown, meta: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data, meta }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  clearCache();
  clearProvenance();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("A. a plain read produces provenance with no call-site cooperation", () => {
  test("the caller passes nothing, and the ledger still knows everything", async () => {
    globalThis.fetch = vi.fn(async () =>
      envelopeResponse({ nodes: [] }, { etag: 'W/"1"', asOf: 1_700_000_000_000 }),
    ) as unknown as typeof fetch;

    await read("code.graph");

    const record = provenanceFor("code.graph");
    expect(record, "no provenance was captured for a normal read").toBeDefined();
    expect(record?.block).toBe("code.graph");
    expect(record?.cacheState).toBe("fresh");
    expect(record?.asOf).toBe(1_700_000_000_000);
    expect(record?.etag).toBe('W/"1"');
    expect(record?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("params travel into the key, so two parameterisations are two records", async () => {
    globalThis.fetch = vi.fn(async () =>
      envelopeResponse({}, { etag: 'W/"1"', asOf: 1 }),
    ) as unknown as typeof fetch;

    await read("code.deps", { params: { path: "/p", file: "a.ts" } });
    await read("code.deps", { params: { path: "/p", file: "b.ts" } });

    const keys = currentProvenance().map((r) => r.key);
    expect(keys).toContain("code.deps?file=a.ts&path=%2Fp");
    expect(keys).toContain("code.deps?file=b.ts&path=%2Fp");
  });

  test("the ttl that governed the read is recorded, so staleness has a yardstick", async () => {
    globalThis.fetch = vi.fn(async () =>
      envelopeResponse({}, { etag: 'W/"1"', asOf: 1 }),
    ) as unknown as typeof fetch;

    await read("code.search", { ttlMs: 15_000 });
    expect(provenanceFor("code.search")?.ttlMs).toBe(15_000);
  });
});

describe("B. the cache state is what the Broker actually did", () => {
  test("a cache hit records `cached` and does NOT re-issue a request", async () => {
    const spy = vi.fn(async () =>
      envelopeResponse({}, { etag: 'W/"1"', asOf: 1_000 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = spy;

    await read("code.map", { ttlMs: 60_000 });
    await read("code.map", { ttlMs: 60_000 });

    expect((spy as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(provenanceFor("code.map")?.cacheState).toBe("cached");
  });

  test("a cache hit keeps the ORIGINAL asOf — staleness is not reset by the hit", async () => {
    // If the hit rewrote `asOf` to now, a value could sit in cache for an hour
    // and keep reporting itself as freshly produced. That is the single most
    // dangerous lie this feature could tell.
    globalThis.fetch = vi.fn(async () =>
      envelopeResponse({}, { etag: 'W/"1"', asOf: 1_234 }),
    ) as unknown as typeof fetch;

    await read("code.map", { ttlMs: 60_000 });
    await read("code.map", { ttlMs: 60_000 });

    expect(provenanceFor("code.map")?.asOf).toBe(1_234);
  });

  test("an expired entry re-issues and passes through `revalidating`", async () => {
    globalThis.fetch = vi.fn(async () =>
      envelopeResponse({}, { etag: 'W/"1"', asOf: 1 }),
    ) as unknown as typeof fetch;

    const states: string[] = [];
    const stop = subscribeProvenance(() => {
      const r = provenanceFor("checks.auto");
      if (r !== undefined) states.push(r.cacheState);
    });

    // ttl 0 means "always revalidate", so the second read must go to network.
    await read("checks.auto", { ttlMs: 0 });
    await read("checks.auto", { ttlMs: 0 });
    stop();

    expect(states, `observed states: ${states.join(",")}`).toContain("revalidating");
    expect(provenanceFor("checks.auto")?.cacheState).toBe("fresh");
  });

  test("a failed read is recorded with its typed code, and the error still propagates", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "path_traversal", message: "nope" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    // The specific code matters: the point is that the SERVER's typed code
    // survives into the provenance record, not merely that something threw.
    await expect(read("code.graph")).rejects.toThrow(/nope/);

    const record = provenanceFor("code.graph");
    expect(record?.cacheState).toBe("failed");
    expect(record?.errorCode).toBe("path_traversal");
  });
});

describe("C. non-fabrication", () => {
  test("a response with no asOf yields NO age, not an age of zero", async () => {
    globalThis.fetch = vi.fn(async () =>
      envelopeResponse({}, { etag: 'W/"1"' }),
    ) as unknown as typeof fetch;

    await read("code.map");
    expect(provenanceFor("code.map")?.asOf).toBeUndefined();
  });

  test("a key nothing has read has no record — the Broker does not pre-seed", async () => {
    expect(provenanceFor("code.duplicates")).toBeUndefined();
  });

  test("causal ids are absent because the envelope does not carry them", async () => {
    // Documents the honest gap. When `BlockMeta` grows `eventId`/`traceId`,
    // this test is what will show the change taking effect.
    globalThis.fetch = vi.fn(async () =>
      envelopeResponse({}, { etag: 'W/"1"', asOf: 1 }),
    ) as unknown as typeof fetch;

    await read("code.map");
    expect(provenanceFor("code.map")?.causality).toEqual({});
  });

  test("when the envelope DOES carry causal ids, they are picked up unchanged", async () => {
    globalThis.fetch = vi.fn(async () =>
      envelopeResponse({}, { etag: 'W/"1"', asOf: 1, eventId: "e9", traceId: "t9", actor: "user:u1" }),
    ) as unknown as typeof fetch;

    await read("code.map");
    expect(provenanceFor("code.map")?.causality).toEqual({
      eventId: "e9", traceId: "t9", actor: "user:u1",
    });
  });
});

describe("D. the reconstruction log", () => {
  test("settled reads are logged in order; `revalidating` is not", async () => {
    globalThis.fetch = vi.fn(async () =>
      envelopeResponse({}, { etag: 'W/"1"', asOf: 1 }),
    ) as unknown as typeof fetch;

    await read("code.map", { ttlMs: 0 });
    await read("code.map", { ttlMs: 0 });

    const states = provenanceLog().map((r) => r.cacheState);
    expect(states).toEqual(["fresh", "fresh"]);
  });

  test("the log is bounded — an open app cannot leak memory through LENS", async () => {
    globalThis.fetch = vi.fn(async () =>
      envelopeResponse({}, { etag: 'W/"1"', asOf: 1 }),
    ) as unknown as typeof fetch;

    for (let i = 0; i < PROVENANCE_HISTORY_LIMIT + 20; i++) {
      await read("code.map", { ttlMs: 0 });
    }
    expect(provenanceLog().length).toBe(PROVENANCE_HISTORY_LIMIT);
  });

  test("clearing drops every record — provenance keys carry project paths", async () => {
    globalThis.fetch = vi.fn(async () =>
      envelopeResponse({}, { etag: 'W/"1"', asOf: 1 }),
    ) as unknown as typeof fetch;

    await read("code.graph", { params: { path: "/home/user/secret-project" } });
    expect(currentProvenance().length).toBe(1);
    clearProvenance();
    expect(currentProvenance().length).toBe(0);
    expect(provenanceLog().length).toBe(0);
  });
});

describe("E. costs nothing when nobody is looking", () => {
  test("no listener is attached until something subscribes", () => {
    expect(provenanceListenerCount()).toBe(0);
  });

  test("a subscription is fully released on unsubscribe", () => {
    const stop = subscribeProvenance(() => undefined);
    expect(provenanceListenerCount()).toBe(1);
    stop();
    expect(provenanceListenerCount()).toBe(0);
  });

  test("recording happens whether or not anyone is subscribed", async () => {
    // The inverse of the zero-cost claim, and the more important half:
    // recording must NOT be conditional on someone watching, or the first
    // question about an already-rendered value can never be answered.
    globalThis.fetch = vi.fn(async () =>
      envelopeResponse({}, { etag: 'W/"1"', asOf: 1 }),
    ) as unknown as typeof fetch;

    expect(provenanceListenerCount()).toBe(0);
    await read("code.map");
    expect(provenanceFor("code.map")).toBeDefined();
  });
});
