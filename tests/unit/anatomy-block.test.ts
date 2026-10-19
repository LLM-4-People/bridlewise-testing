// @vitest-environment node
/**
 * Integration test — the `observability.anatomy` block read (the
 * harness-anatomy door).
 *
 * The block is the server's door onto the two anatomy owners: the process
 * census (server/observability/process-census.ts) and the in-process
 * component registry (server/observability/component-registry.ts). It must
 * answer the SAME shapes `scripts/trace.ts anatomy` prints (the CLI consumes
 * this block when the server is up), gate like its sibling observability
 * blocks (requireUserContext — 401 without a session), answer in the block
 * envelope (`{ data, meta }`), and never fabricate: a fresh test server has
 * an EMPTY component registry (nothing registered it did not create) and a
 * census that really walked /proc (this very test process is in it,
 * honestly labelled a bystander).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { createTestUser, type TestUser } from "../helpers/multi-user.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { blockReadPath } from "../../shared/block-contract.ts";
import { registerAuthRoutes } from "../../server/routes/auth.ts";
import { defineAnatomyBlocks } from "../../server/blocks/anatomy.ts";
import { mountBlockRoutes } from "../../server/blocks/define.ts";
import type { CensusProcess } from "../../server/observability/process-census.ts";
import type { RegisteredComponent } from "../../server/observability/component-registry.ts";

const ANATOMY_PATH = blockReadPath("observability.anatomy");

let srv: HttpTestServer;
let user: TestUser;

beforeAll(async () => {
  srv = await startHttpTestServer({
    prefix: "ch-anatomy-block-",
    register: (router, _db, adb) => {
      registerAuthRoutes(router, adb);
      defineAnatomyBlocks(adb);
      mountBlockRoutes(router);
    },
  });
  user = createTestUser(srv.db, "anatomist");
});

afterAll(async () => {
  await srv.stop();
});

type AnatomyData = Readonly<{
  processes?: readonly CensusProcess[];
  components?: readonly RegisteredComponent[];
}>;

describe("the observability.anatomy block read — auth posture + the two anatomy halves", () => {
  test("no session → 401 (the sibling observability blocks' gate)", async () => {
    const res = await jsonRequest(srv.baseUrl, ANATOMY_PATH, { method: "GET" });
    expect(res.status).toBe(401);
  });

  test("authenticated → 200 with { data: { processes, components } } in the owners' shapes", async () => {
    const res = await jsonRequest(srv.baseUrl, ANATOMY_PATH, {
      method: "GET",
      cookie: user.cookie,
    });
    expect(res.status).toBe(200);
    // The block envelope: the payload rides under `data` with content-derived
    // meta (the etag is what makes a re-read of an unchanged anatomy a
    // saved transfer).
    const body = res.body as { data?: AnatomyData; meta?: { etag?: string; asOf?: number } };
    expect(body.meta?.etag, "the envelope carries a content-derived etag").toMatch(/^W\/"[0-9a-f]+"$/);
    expect(typeof body.meta?.asOf).toBe("number");
    const data = body.data ?? {};
    expect(Array.isArray(data.processes), "the census half is a list").toBe(true);
    expect(Array.isArray(data.components), "the registry half is a list").toBe(true);

    // The census really walked /proc: THIS test process (repo cwd, vitest's
    // argv) is in it, honestly labelled a bystander — the block never
    // filters the view to flatter itself.
    expect(data.processes!.length).toBeGreaterThan(0);
    for (const p of data.processes!) {
      expect(p.pid).toBeGreaterThan(0);
      expect(Array.isArray(p.chain)).toBe(true);
      expect(["server-tree", "harness-tool", "bystander"] as const).toContain(p.classification.scope);
      expect(["pidfile-owned", "descendant-of-server", "orphaned", "outside-tree"] as const).toContain(p.provenance.kind);
    }
    const self = data.processes!.find((p) => p.pid === process.pid);
    if (self !== undefined) {
      expect(self.classification.label).toBe("unrelated-bystander");
      expect(self.provenance.kind).toBe("outside-tree");
    }

    // The registry half tells the truth about THIS server process: the
    // http-test helper wires the INLINE async facade (no worker threads of
    // its own), so a fresh test server genuinely registered NOTHING — and
    // that emptiness is what the block must report, never a fabricated or
    // curated list. (The db-thread, worker, feed, sampler and MCP
    // registrations are each proven LIVE in
    // tests/prevention/component-registry.test.ts against the real
    // owners.)
    expect(data.components!.length, "an inline-facade test server has no registered components — report the truth").toBe(0);
    for (const kind of ["db-thread", "worker-thread", "sampler-timer", "folder-watch", "run-feed", "mcp-child"] as const) {
      expect(data.components!.find((c) => c.kind === kind), `${kind} was never created by this server`).toBeUndefined();
    }
  });
});
