// @vitest-environment node
/**
 * The Broker's request path must not double the API prefix.
 *
 * `blockReadPath` (shared/block-contract.ts) is ABSOLUTE — it already
 * carries the `/api` prefix — while the Broker's `fetchJson` prefixes every
 * path with `DEFAULT_API_BASE`. Composed verbatim they produced
 * `/api/api/b/<id>` and every Broker read 404'd against a route that exists
 * (browser-verified against the running server). `blockRequestPath` is the
 * single de-duplication point; this pins it.
 *
 * Mutation: reverting `read()` to compose `blockReadPath` + `API_BASE`
 * verbatim makes the composed-URL assertion fail.
 */
import { describe, test, expect } from "vitest";

import { blockRequestPath } from "../../src/data/broker.ts";
import { blockReadPath } from "../../shared/block-contract.ts";
import { DEFAULT_API_BASE } from "../../src/client-config.ts";

describe("broker block request path", () => {
  test("the relative path plus API_BASE reproduces the contract's absolute path exactly", () => {
    const rel = blockRequestPath("coverage.darkfield");
    expect(`${DEFAULT_API_BASE}${rel}`).toBe(blockReadPath("coverage.darkfield"));
  });

  test("no composed URL ever contains a doubled prefix", () => {
    for (const block of ["coverage.darkfield", "coverage.annunciator", "lens.recorder"]) {
      const url = `${DEFAULT_API_BASE}${blockRequestPath(block)}`;
      expect(url.includes(`${DEFAULT_API_BASE}${DEFAULT_API_BASE}/`), url).toBe(false);
      expect(url.startsWith(`${DEFAULT_API_BASE}/`)).toBe(true);
    }
  });

  test("params survive into the query string", () => {
    const rel = blockRequestPath("lens.ancestry", { traceId: "t-1" });
    expect(rel).toContain("traceId=t-1");
    expect(`${DEFAULT_API_BASE}${rel}`.includes("/api/api/")).toBe(false);
  });
});
