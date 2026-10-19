// @vitest-environment node
/**
 * THE BROKER HOLDS A PRINCIPLED REFUSAL — the negative half of the cache.
 *
 * The defect: a read the server refuses DETERMINISTICALLY (a typed 503 —
 * `git_not_run`, the self-protection class) was re-polled on every
 * revalidation pass. Measured in one session: 130+ identical 503s, every
 * one a real network trip for an answer known in advance. The Broker is
 * the one choke point every read passes, so the hold lives here and no
 * feed has to build its own.
 *
 * The tenure is exactly "until something changes":
 *   - force (the explicit retry) bypasses and re-asks;
 *   - an invalidation event registered by the read drops the hold;
 *   - clearCache (context switch / sign-out) drops everything;
 *   - a landed answer for the key ends its refusal.
 * A TRANSPORT failure is never held: it says nothing about the next try.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  clearCache,
  fireInvalidation,
  read,
} from "../../src/data/broker.ts";
import { clearProvenance, provenanceLog } from "../../src/data/ledger.ts";
import { ClientError } from "../../src/data/errors.ts";

const realFetch = globalThis.fetch;

const SENTENCE =
  "The unsaved change counts could not be read because this server would not run git: confinement is active";

function refusing503(counter: { calls: number }): typeof globalThis.fetch {
  return vi.fn(async () => {
    counter.calls += 1;
    return new Response(JSON.stringify({ error: "git_not_run", message: SENTENCE }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

function envelope(data: unknown): Response {
  return new Response(
    JSON.stringify({ data, meta: { etag: 'W/"ok"', asOf: 1700000000000 } }),
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

describe("the hold", () => {
  test("N reads of a refused key make exactly 1 request; each re-read rethrows the refusal", async () => {
    const counter = { calls: 0 };
    globalThis.fetch = refusing503(counter);
    const opts = { params: { projectId: "p1" }, ttlMs: 5000, invalidateOn: ["custody:changed"] };

    await expect(read("custody.state", opts)).rejects.toMatchObject({
      code: "git_not_run",
      statusCode: 503,
    });
    expect(counter.calls).toBe(1);

    // Every revalidation pass after it: same answer, zero network.
    for (let i = 0; i < 5; i += 1) {
      await expect(read("custody.state", opts)).rejects.toMatchObject({
        code: "git_not_run",
        message: SENTENCE,
      });
    }
    expect(counter.calls).toBe(1);
    // The serve-from-hold is honest provenance: recorded as `refused`.
    const refusedRecords = provenanceLog().filter((r) => r.cacheState === "refused");
    expect(refusedRecords.length).toBe(5);
    expect(refusedRecords[0]!.errorCode).toBe("git_not_run");
  });

  test("force — the explicit retry — bypasses the hold, and a landed answer ends it", async () => {
    const counter = { calls: 0 };
    let refuse = true;
    globalThis.fetch = vi.fn(async () => {
      counter.calls += 1;
      if (refuse) {
        return new Response(JSON.stringify({ error: "git_not_run", message: SENTENCE }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return envelope({ repository: true });
    }) as unknown as typeof globalThis.fetch;
    const opts = { params: { projectId: "p1" }, ttlMs: 5000 };

    await expect(read("custody.state", opts)).rejects.toMatchObject({ code: "git_not_run" });
    expect(counter.calls).toBe(1);

    refuse = false;
    const data = await read<{ repository: boolean }>("custody.state", { ...opts, force: true });
    expect(data.repository).toBe(true);
    expect(counter.calls).toBe(2);

    // The refusal is over: an unforced read now answers from the cache.
    const again = await read<{ repository: boolean }>("custody.state", opts);
    expect(again.repository).toBe(true);
    expect(counter.calls).toBe(2);
  });

  test("the invalidation the read registered drops the hold — a custody write re-opens the question", async () => {
    const counter = { calls: 0 };
    globalThis.fetch = refusing503(counter);
    const opts = { params: { projectId: "p1" }, ttlMs: 5000, invalidateOn: ["custody:changed"] };

    await expect(read("custody.state", opts)).rejects.toMatchObject({ code: "git_not_run" });
    await expect(read("custody.state", opts)).rejects.toMatchObject({ code: "git_not_run" });
    expect(counter.calls).toBe(1);

    fireInvalidation("custody:changed");
    await expect(read("custody.state", opts)).rejects.toMatchObject({ code: "git_not_run" });
    expect(counter.calls).toBe(2);
  });

  test("clearCache (context switch) drops the hold", async () => {
    const counter = { calls: 0 };
    globalThis.fetch = refusing503(counter);
    const opts = { params: { projectId: "p1" }, ttlMs: 5000 };
    await expect(read("custody.state", opts)).rejects.toMatchObject({ code: "git_not_run" });
    clearCache();
    await expect(read("custody.state", opts)).rejects.toMatchObject({ code: "git_not_run" });
    expect(counter.calls).toBe(2);
  });

  test("a TRANSPORT failure is never held — every attempt re-asks", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const opts = { params: { projectId: "p1" }, ttlMs: 5000 };
    await expect(read("custody.state", opts)).rejects.toBeInstanceOf(ClientError);
    await expect(read("custody.state", opts)).rejects.toMatchObject({ code: "network" });
    expect(calls).toBe(2);
  });

  test("a last-known value outranks the hold for DISPLAY: served, and still no re-ask", async () => {
    let refuse = false;
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (refuse) {
        return new Response(JSON.stringify({ error: "git_not_run", message: SENTENCE }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return envelope({ repository: true });
    }) as unknown as typeof globalThis.fetch;
    // ttlMs 1: the entry is stale by the next read, so only the hold can
    // explain the absence of a revalidation request.
    const opts = { params: { projectId: "p1" }, ttlMs: 1 };
    const first = await read<{ repository: boolean }>("custody.state", opts);
    expect(first.repository).toBe(true);
    expect(calls).toBe(1);

    // The next revalidation refuses — the value stands, the refusal holds.
    refuse = true;
    await new Promise((r) => setTimeout(r, 5));
    const second = await read<{ repository: boolean }>("custody.state", opts);
    expect(second.repository).toBe(true); // last-known served
    await new Promise((r) => setTimeout(r, 5)); // the SWR revalidation lands (503) and holds
    expect(calls).toBe(2);

    // Further stale reads: served from last-known, ZERO further requests.
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 2));
      const again = await read<{ repository: boolean }>("custody.state", opts);
      expect(again.repository).toBe(true);
    }
    expect(calls).toBe(2);
  });
});

describe("the refusal now travels in the 200 envelope", () => {
  /**
   * WHY THE WIRE CHANGED. The browser logs every non-2xx STATUS itself,
   * before any page code runs — so the Switch's boot-time custody badge probe
   * for the self-protected project printed "Failed to load resource: 503"
   * in every healthy session and no client `console.error` existed to
   * remove. A principled refusal is an ANSWER (deterministic, typed, with
   * the server's own sentence), so the block read route serves it in the
   * 200 envelope and THE BROKER RECONSTRUCTS THE TYPED ERROR HERE, at the
   * single read door. Every consumer below the Broker — the REFUSED
   * rendering (`refusalReason`), the absence wording, the hold — must see
   * exactly what it saw when the refusal traveled as a 503.
   */
  function refusalEnvelope(): Response {
    return new Response(
      JSON.stringify({
        data: null,
        meta: { etag: 'W/"refused"', asOf: 1700000000000 },
        refusal: { code: "git_not_run", message: SENTENCE, status: 503 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  test("a 200 refusal envelope rejects with the SAME typed error the 503 carried", async () => {
    const counter = { calls: 0 };
    globalThis.fetch = vi.fn(async () => {
      counter.calls += 1;
      return refusalEnvelope();
    }) as unknown as typeof globalThis.fetch;
    const opts = { params: { projectId: "p1" }, ttlMs: 5000 };

    let caught: unknown = null;
    try {
      await read("custody.state", opts);
    } catch (err) {
      caught = err;
    }
    // The typed refusal, reconstructed — not an untyped blob and not silence.
    expect(caught).toBeInstanceOf(ClientError);
    expect(caught).toMatchObject({
      code: "git_not_run",
      message: SENTENCE,
      statusCode: 503,
    });
    // The REFUSED rendering the custody feed consumes still works verbatim.
    const { refusalReason } = await import("../../src/data/absence.ts");
    expect(refusalReason(caught)).toBe(SENTENCE);

    // AND THE HOLD STILL HOLDS: N reads of the refused key, 1 request.
    for (let i = 0; i < 4; i += 1) {
      await expect(read("custody.state", opts)).rejects.toMatchObject({ code: "git_not_run" });
    }
    expect(counter.calls).toBe(1);
    // The refusal landed as a FAILED read in provenance (never as fresh
    // data): a refusal measured nothing.
    const failed = provenanceLog().filter((r) => r.cacheState === "failed");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]!.errorCode).toBe("git_not_run");
    const fresh = provenanceLog().filter((r) => r.cacheState === "fresh");
    expect(fresh).toEqual([]);
  });

  test("a 200 envelope with NO refusal is a measured answer — the reconstruction stays silent", async () => {
    globalThis.fetch = vi.fn(async () => envelope({ repository: true })) as unknown as typeof fetch;
    const data = await read<{ repository: boolean }>("custody.state", {
      params: { projectId: "p2" },
      ttlMs: 5000,
    });
    expect(data.repository).toBe(true);
  });

  test("an envelope whose refusal claims a status OUTSIDE the family is not a refusal", async () => {
    // A buggy or hostile server cannot silence a 500 by dressing it up as a
    // refusal: the family is 428/503 (shared/errors.ts owns the pair), and
    // anything else reads as the data it carries — loudly, not laundered.
    const { blockRefusalOf } = await import("../../src/data/broker.ts");
    expect(
      blockRefusalOf({ data: null, meta: {}, refusal: { code: "x", message: "m", status: 500 } }),
    ).toBeNull();
    expect(blockRefusalOf({ data: null, meta: {} })).toBeNull();
    expect(blockRefusalOf(null)).toBeNull();
    // BOTH DIRECTIONS: the real family reconstructs.
    const err = blockRefusalOf({
      data: null,
      meta: {},
      refusal: { code: "git_not_run", message: SENTENCE, status: 503 },
    });
    expect(err).toBeInstanceOf(ClientError);
    expect(err).toMatchObject({ code: "git_not_run", statusCode: 503 });
  });

  test("fetchJson ITSELF reconstructs the typed error — the hand routes' door", async () => {
    // The git-ops REST family (status, diff, diff-patch, log, branches) joined
    // the envelope after the block routes did, and its consumers do NOT go
    // through `read()` — the run pane's working-tree probe, the flow's
    // effect-beat diffs, the custody diff sheet all call `fetchJson`
    // directly. The reconstruction therefore lives at THAT door (the one
    // choke point every request passes), and this arm proves it in
    // isolation: a 200 carrying a refusal envelope rejects with the same
    // typed error the 503 used to carry, and a 200 without one resolves.
    const { fetchJson } = await import("../../src/data/broker.ts");

    globalThis.fetch = vi.fn(async () => refusalEnvelope()) as unknown as typeof globalThis.fetch;
    let caught: unknown = null;
    try {
      await fetchJson<unknown>("/git/status?path=/x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClientError);
    expect(caught).toMatchObject({
      code: "git_not_run",
      message: SENTENCE,
      statusCode: 503,
    });

    // The same door stays silent for a measured answer — the reconstruction
    // is not a blanket "reject anything with a refusal-shaped key". The git
    // family's measured shape is the RAW body (no block envelope).
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ branch: "main", dirtyFiles: 2, stagedFiles: 0, untrackedFiles: 0, entries: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const data = await fetchJson<{ dirtyFiles: number }>("/git/status?path=/x");
    expect(data.dirtyFiles).toBe(2);
  });
});
