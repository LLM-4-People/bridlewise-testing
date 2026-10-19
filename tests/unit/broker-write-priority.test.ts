/**
 * A WRITE ASKS TO JUMP THE QUEUE (UIE-044's priority arm).
 *
 * THE DEFECT, MEASURED LIVE. Chrome queues requests against its per-origin
 * HTTP/1.1 pool (six sockets), and the queue is priority-ordered: when the
 * pool is pinned — the multi-tab world that starved the steers — a request
 * that never sends waits for a socket behind everything else queued before
 * it. A steer POST is a person's intent and an observer read is a
 * revalidatable cache refresh, so the write must not sit behind the reads.
 *
 * WHAT IS PINNED: the request METHOD is the one rule — every POST crossing
 * the client's single fetch choke point asks the browser for high priority;
 * GETs keep the browser's default. The rule lives at the choke point so no
 * call site has to remember it (the write doors — block actions, run
 * start/steer/cancel, chat sends — are all POSTs by construction).
 *
 * THE HONEST CAVEAT, asserted as part of the contract: priority REORDERS
 * the queue; it does not add sockets. The socket count itself is the
 * liveness share's fix (`tests/unit/liveness-share.test.ts`), and a POST
 * may still wait when the pool is held by streams — it simply no longer
 * waits behind reads too.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { fetchJson } from "../../src/data/broker.ts";

const realFetch = globalThis.fetch;

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("the write-priority rule at the fetch choke point", () => {
  test("a POST asks for high priority — a write is intent, not a revalidatable read", async () => {
    const seen: (RequestInit | undefined)[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init);
      return response(200, { ok: true });
    }) as typeof fetch;

    await fetchJson("/run/run-x/steer", { method: "POST", body: "{}" });
    expect(seen[0]?.priority, "the steer POST jumps the queue").toBe("high");
  });

  test("a GET keeps the browser's default — reads may yield to writes", async () => {
    const seen: (RequestInit | undefined)[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init);
      return response(200, { ok: true });
    }) as typeof fetch;

    await fetchJson("/projects");
    expect(seen[0]?.priority).toBeUndefined();
  });

  test("the rule is the METHOD alone — no call site passes its own priority", async () => {
    // A caller that tried to override priority on a GET would be fighting
    // the one rule; the door does not forward any caller priority, so the
    // rule cannot be contradicted from outside.
    const seen: (RequestInit | undefined)[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init);
      return response(200, { ok: true });
    }) as typeof fetch;

    await fetchJson("/projects", {
      method: "GET",
      // A deliberate improper usage: the door owns this field, so a caller
      // cannot make its read jump the queue.
      priority: "high",
    } as RequestInit);
    expect(seen[0]?.priority).toBeUndefined();
  });
});
