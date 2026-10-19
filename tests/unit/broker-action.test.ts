/**
 * `broker.action` — the client half of the action fabric, at its choke point.
 *
 * What is locked here, mirroring the read-side choke-point suite:
 *
 *   A. PATH — the action URL is derived from the contract and composes with
 *      `API_BASE` without the doubled `/api/api/` prefix the read side
 *      already fixed once.
 *   B. SUCCESS — the POST carries the input as its JSON body; the envelope's
 *      data comes back; the action ledger records `done` WITH the envelope's
 *      causality; the block's cached reads are dropped; declared
 *      invalidation events drop other registered keys and reach
 *      subscribers. The READ log stays untouched — verbs must not corrupt
 *      the reconstruction of what was displayed.
 *   C. FAILURE — the typed server code surfaces unchanged; the ledger
 *      records `failed`; and NOTHING is invalidated: a failed action changed
 *      nothing, so dropping caches would disguise the failure as a refresh.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import {
  action,
  blockActionRequestPath,
  read,
  clearCache,
  onInvalidation,
} from "../../src/data/broker.ts";
import { blockActionPath } from "../../shared/block-contract.ts";
import { DEFAULT_API_BASE } from "../../src/client-config.ts";
import {
  actionLog,
  actionProvenanceFor,
  provenanceLog,
  clearProvenance,
} from "../../src/data/ledger.ts";
import { ClientError } from "../../src/data/errors.ts";

const realFetch = globalThis.fetch;

function envelopeResponse(data: unknown, meta: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ data, meta: { etag: 'W/"1"', asOf: 1700000000000, ...meta } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

beforeEach(() => {
  clearCache();
  clearProvenance();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("A. path derivation", () => {
  test("the action request path composes with API_BASE into the contract path", () => {
    const composed = `${DEFAULT_API_BASE}${blockActionRequestPath("checks.auto", "rerun")}`;
    expect(composed).toBe(blockActionPath("checks.auto", "rerun"));
    expect(composed).not.toContain(`${DEFAULT_API_BASE}${DEFAULT_API_BASE}/`);
  });
});

describe("B. success", () => {
  test("POSTs the input as the body and returns the envelope's data", async () => {
    let seen: { url: string; method?: string | undefined; body?: unknown } | null = null;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      seen = {
        url: String(url),
        method: init?.method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      return envelopeResponse({ checks: [{ id: "c1" }] });
    }) as unknown as typeof fetch;

    const data = await action<{ checks: unknown[] }>("checks.auto", "rerun", {
      projectId: "p-1",
      checkName: "typecheck",
    });

    expect(data.checks).toHaveLength(1);
    expect(seen!.url).toContain("/api/b/checks.auto/rerun");
    expect(seen!.method).toBe("POST");
    expect(seen!.body).toEqual({ projectId: "p-1", checkName: "typecheck" });
  });

  test("records `done` with the envelope's causality; the read log is untouched", async () => {
    globalThis.fetch = vi.fn(async () =>
      envelopeResponse({ ok: 1 }, { actor: "user:u-1", traceId: "trace-9" }),
    ) as unknown as typeof fetch;

    await action("checks.auto", "rerun", { projectId: "p-1" });

    const record = actionProvenanceFor("checks.auto/rerun");
    expect(record).toBeDefined();
    expect(record!.state).toBe("done");
    expect(record!.block).toBe("checks.auto");
    expect(record!.action).toBe("rerun");
    expect(record!.causality).toEqual({ actor: "user:u-1", traceId: "trace-9" });
    expect(record!.asOf).toBe(1700000000000);
    // Verbs never leak into the read-side reconstruction log.
    expect(provenanceLog()).toHaveLength(0);
    expect(actionLog()).toHaveLength(1);
  });

  test("records who initiated it: an operator unless the caller declares it automatic", async () => {
    // The flow and the run pane show only operator acts; the telemetry flush
    // declares itself automatic. The record states the origin either way,
    // succeeded or failed, so no consumer filters a guess.
    globalThis.fetch = vi.fn(async () => envelopeResponse({ ok: 1 })) as unknown as typeof fetch;
    await action("tools.breaker", "trip", { toolName: "x" });
    await action("client.telemetry", "ingest", { events: [] }, { origin: "automatic" });
    expect(actionProvenanceFor("tools.breaker/trip")!.origin).toBe("operator");
    expect(actionProvenanceFor("client.telemetry/ingest")!.origin).toBe("automatic");

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "not_found", message: "gone" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    await expect(action("client.telemetry", "ingest", {}, { origin: "automatic" })).rejects.toBeInstanceOf(ClientError);
    const failed = actionProvenanceFor("client.telemetry/ingest")!;
    expect(failed.state).toBe("failed");
    expect(failed.origin).toBe("automatic");
  });

  test("drops the block's cached reads, so the next read refetches", async () => {
    const spy = vi.fn(async () => envelopeResponse({ n: 1 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    await read("checks.auto", { params: { projectId: "p-1" }, ttlMs: 60_000 });
    await read("checks.auto", { params: { projectId: "p-1" }, ttlMs: 60_000 });
    expect(spy.mock.calls.length).toBe(1); // second read was a cache hit

    await action("checks.auto", "rerun", { projectId: "p-1" });
    await read("checks.auto", { params: { projectId: "p-1" }, ttlMs: 60_000 });
    // read + action + post-action read — the cache entry was really gone.
    expect(spy.mock.calls.length).toBe(3);
  });

  test("fires declared invalidation events: registered keys drop, subscribers hear", async () => {
    const spy = vi.fn(async () => envelopeResponse({ n: 1 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    // Another block's read registered under the event the action declares.
    await read("code.map", {
      params: { path: "/p" },
      ttlMs: 60_000,
      invalidateOn: ["index:ready"],
    });
    await read("code.map", { params: { path: "/p" }, ttlMs: 60_000 });
    expect(spy.mock.calls.length).toBe(1);

    const heard = vi.fn();
    const unsubscribe = onInvalidation("index:ready", heard);
    await action("code.map", "reindex", { path: "/p" }, { invalidates: ["index:ready"] });
    expect(heard).toHaveBeenCalledTimes(1);

    await read("code.map", { params: { path: "/p" }, ttlMs: 60_000 });
    expect(spy.mock.calls.length).toBe(3); // dropped by the event, not by TTL
    unsubscribe();
  });
});

describe("C. failure", () => {
  test("surfaces the typed code, records `failed`, invalidates nothing", async () => {
    const spy = vi.fn(async () => envelopeResponse({ n: 1 }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await read("checks.auto", { params: { projectId: "p-1" }, ttlMs: 60_000 });
    expect(spy.mock.calls.length).toBe(1);

    const heard = vi.fn();
    const unsubscribe = onInvalidation("check:complete", heard);
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "not_found", message: "Project p-x not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    await expect(
      action("checks.auto", "rerun", { projectId: "p-x" }, { invalidates: ["check:complete"] }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      action("checks.auto", "rerun", { projectId: "p-x" }),
    ).rejects.toBeInstanceOf(ClientError);

    const record = actionProvenanceFor("checks.auto/rerun");
    expect(record!.state).toBe("failed");
    expect(record!.errorCode).toBe("not_found");

    // Nothing changed server-side, so nothing may be dropped client-side.
    expect(heard).not.toHaveBeenCalled();
    globalThis.fetch = spy as unknown as typeof fetch;
    await read("checks.auto", { params: { projectId: "p-1" }, ttlMs: 60_000 });
    expect(spy.mock.calls.length).toBe(1); // still the original cache entry
    unsubscribe();
  });
});
