/**
 * THE CSRF DEAD-END, ENDED AT THE DOOR.
 *
 * `csrf_blocked` is a refusal the server issues BEFORE any handler runs, so
 * the request changed nothing and the fetch choke point retries it exactly
 * once. What is locked here:
 *
 *   A. RECOVERY — a 403 csrf_blocked followed by a 200 resolves with the
 *      data, and the retry is the IDENTICAL request (same path, method, body,
 *      and the CSRF custom header re-attached at the same door).
 *   B. HONEST DOUBLE FAILURE — a second csrf_blocked propagates as the typed
 *      error, exactly two attempts (never a loop), and the user-facing
 *      projection now states the retry happened before asking for a reload.
 *   C. NO WIDENING — any OTHER failure (a plain `forbidden` 403 included)
 *      is not retried. Deny-by-default: the retry exists for one code.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { fetchJson } from "../../src/data/broker.ts";
import { ClientError } from "../../src/data/errors.ts";
import { formatErrorMessage } from "../../src/data/error-messages.ts";
import { CSRF_CUSTOM_HEADER } from "../../shared/constants.ts";

const realFetch = globalThis.fetch;

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CSRF_403 = { error: "csrf_blocked", message: "request blocked by the CSRF guard" };

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("A. recovery — blocked once, retried once, succeeded", () => {
  test("the second attempt is the identical request and its data comes back", async () => {
    const seen: { url: string; method: string; body: unknown; csrf: unknown }[] = [];
    let calls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const headers = init?.headers as Record<string, string>;
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body,
        csrf: headers[CSRF_CUSTOM_HEADER],
      });
      return calls === 1 ? response(403, CSRF_403) : response(200, { ok: true });
    }) as typeof fetch;

    const data = await fetchJson<{ ok: boolean }>("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "p" }),
    });
    expect(data).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    // Identical request, both times through the same choke point.
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[0]!.csrf).toBe("1");
  });
});

describe("B. honest double failure", () => {
  test("a second csrf_blocked propagates typed, after exactly two attempts", async () => {
    const mock = vi.fn(async () => response(403, CSRF_403));
    globalThis.fetch = mock as typeof fetch;

    const err = await fetchJson("/projects", { method: "POST", body: "{}" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).code).toBe("csrf_blocked");
    expect(mock).toHaveBeenCalledTimes(2);
  });

  test("the fallback sentence admits the retry before asking for a reload", () => {
    const text = formatErrorMessage({
      code: "csrf_blocked",
      message: "request blocked by the CSRF guard",
      statusCode: 403,
    });
    expect(text).toContain("retried once");
    expect(text).toContain("reload");
  });
});

describe("C. no widening — one code, one retry", () => {
  test("a plain forbidden 403 is never retried", async () => {
    const mock = vi.fn(async () => response(403, { error: "forbidden", message: "not yours" }));
    globalThis.fetch = mock as typeof fetch;

    const err = await fetchJson("/projects", { method: "POST", body: "{}" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as ClientError).code).toBe("forbidden");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  test("a network failure is never retried here", async () => {
    const mock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    globalThis.fetch = mock as typeof fetch;

    const err = await fetchJson("/health").then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as ClientError).code).toBe("network");
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
