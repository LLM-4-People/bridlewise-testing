// @vitest-environment node
import { describe, test, expect, afterAll, beforeAll } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";

import { createRouter, sendJson } from "../../server/router/router.ts";
import { resolveServerConfig } from "../../server/kernel/config.ts";
import { DbClient } from "../../server/db/client";
import { AsyncDbClient } from "../../server/db/async-client";

/**
 * Integration test: spin up a real HTTP server backed by createRouter,
 * make real fetch requests. This exercises the full request/response
 * cycle including body parsing, path matching, and error status codes.
 *
 * (route registry): the router now OWNS auth + CSRF. These
 * mechanics tests bypass auth (all paths public) and opt into CSRF via the
 * documented `X-Requested-With` custom header (the OWASP test opt-in —
 * see server/csrf.ts). This tests routing WITHOUT the cross-cutting
 * middleware; the integration tests (routes.test.ts, multi-user-*) exercise
 * the real auth + CSRF wiring.
 */

const cfg = resolveServerConfig({});
const memDb = new DbClient({ path: ":memory:" });
const memAdb = AsyncDbClient.inline(memDb);

/** Mechanics-only router: every path is public (auth no-op), CSRF opted-in
 * per-request via X-Requested-With. */
function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const router = createRouter({ db: memAdb, isPublicPath: () => true });

  router.get("/api/items/:id", (ctx) => {
    sendJson(ctx.res, { id: ctx.params["id"], query: ctx.query.get("q") });
  });

  router.post("/api/echo", (ctx) => {
    sendJson(ctx.res, ctx.body, 201);
  });

  router.get("/api/noop", () => {
    // handler that does nothing — dispatch should still end the response
  });

  const server = createServer((req, res) => router.dispatch(req, res));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

let harness: { server: Server; baseUrl: string };

beforeAll(async () => {
  harness = await startTestServer();
});

afterAll(async () => {
  await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  memDb.close();
});

/** The CSRF-opt-in header for unsafe-method test requests. */
const CSRF = { "X-Requested-With": "test" };

describe("router", () => {
  test("GET with path param extracts and decodes it", async () => {
    const res = await fetch(`${harness.baseUrl}/api/items/abc%2F123`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: "abc/123", query: null });
  });

  test("GET with query string passes it through", async () => {
    const res = await fetch(`${harness.baseUrl}/api/items/42?q=hello`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: "42", query: "hello" });
  });

  test("unknown path returns 404 with JSON error", async () => {
    const res = await fetch(`${harness.baseUrl}/api/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
    expect(body.path).toBe("/api/nonexistent");
  });

  test("POST with valid JSON body is parsed and forwarded", async () => {
    const res = await fetch(`${harness.baseUrl}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CSRF },
      body: JSON.stringify({ hello: "world", n: 42 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ hello: "world", n: 42 });
  });

  test("POST with empty body resolves to undefined", async () => {
    const res = await fetch(`${harness.baseUrl}/api/echo`, {
      method: "POST",
      headers: { ...CSRF },
    });
    expect(res.status).toBe(201);
    // ctx.body is undefined; sendJson(JSON.stringify(undefined)) writes no
    // body. res.json() would throw on empty body, so we check the text.
    const text = await res.text();
    expect(text).toBe("");
  });

  test("POST with malformed JSON returns 400", async () => {
    const res = await fetch(`${harness.baseUrl}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CSRF },
      body: "{not valid json}",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_json");
  });

  test("POST with body exceeding maxBodyBytes returns 413 (Content-Length pre-check)", async () => {
    // Use a tiny server with a 100-byte cap for this test.
    const router = createRouter({ db: memAdb, isPublicPath: () => true });
    router.post("/api/echo", (ctx) => sendJson(ctx.res, ctx.body, 201));

    // Temporarily override config via a custom readBody path:
    // We test readBody directly by making the body larger than the cap.
    const huge = "x".repeat(cfg.maxBodyBytes + 1);
    const server = createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(huge.length), ...CSRF },
      body: huge,
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("body_too_large");

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("POST with body exceeding a small cap returns 413 (accumulated bytes)", async () => {
    // Test the readBody function directly with a small cap.
    const { readBody, BodySizeLimitError } = await import("../../server/router/router.ts");
    const { Readable } = await import("node:stream");

    const payload = JSON.stringify({ x: "a".repeat(200) });
    const stream = Readable.from([Buffer.from(payload)]);

    // Mimic IncomingMessage enough for readBody.
    const req = stream as unknown as import("node:http").IncomingMessage;
    req.headers = {};

    await expect(readBody(req, 50)).rejects.toThrow(BodySizeLimitError);
  });

  test("POST with valid body under the cap succeeds", async () => {
    const { readBody } = await import("../../server/router/router.ts");
    const { Readable } = await import("node:stream");

    const payload = JSON.stringify({ ok: true });
    const stream = Readable.from([Buffer.from(payload)]);
    const req = stream as unknown as import("node:http").IncomingMessage;
    req.headers = {};

    const body = await readBody(req, 10_000);
    expect(body).toEqual({ ok: true });
  });

  test("malformed JSON via readBody rejects with BodyParseError", async () => {
    const { readBody, BodyParseError } = await import("../../server/router/router.ts");
    const { Readable } = await import("node:stream");

    const stream = Readable.from([Buffer.from("{broken")]);
    const req = stream as unknown as import("node:http").IncomingMessage;
    req.headers = {};

    await expect(readBody(req, 10_000)).rejects.toThrow(BodyParseError);
  });

  test("Content-Length pre-check rejects before reading bytes", async () => {
    const { readBody, BodySizeLimitError } = await import("../../server/router/router.ts");
    const { Readable } = await import("node:stream");

    // Stream that would hang if read (we want to prove pre-check works).
    const stream = Readable.from([]);
    const req = stream as unknown as import("node:http").IncomingMessage;
    req.headers = { "content-length": "999999999" };

    await expect(readBody(req, 100)).rejects.toThrow(BodySizeLimitError);
  });

  // ── TRACE IDENTITY ──
  // The router mints one trace id per request and stamps it on the response
  // before anything else runs, so a client can quote an id that answers
  // "every ledger event this request produced". These tests pin the wire
  // half; the ledger half (the same id inside the recording context) is
  // pinned behaviourally in effect-kind-recording.test.ts.
  describe("trace id header", () => {
    const TRACE_HEADER = "x-trace-id";

    test("every response carries it — success and error alike", async () => {
      for (const path of ["/api/items/1", "/api/nonexistent-404"]) {
        const res = await fetch(`${harness.baseUrl}${path}`);
        const traceId = res.headers.get(TRACE_HEADER);
        expect(traceId, `GET ${path} must carry ${TRACE_HEADER}`).toBeTruthy();
      }
    });

    test("the id uses the canonical generator's format (trace-<uuid>)", async () => {
      const res = await fetch(`${harness.baseUrl}/api/items/1`);
      const traceId = res.headers.get(TRACE_HEADER) ?? "";
      // The canonical `generateId("trace")` shape: the self-describing
      // domain prefix + one UUID. Asserted by SHAPE, never by a hardcoded
      // value.
      expect(traceId).toMatch(/^trace-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    test("each request mints its OWN id — never a shared or repeated one", async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${harness.baseUrl}/api/items/${i}`);
        const traceId = res.headers.get(TRACE_HEADER);
        expect(traceId).toBeTruthy();
        seen.add(traceId as string);
      }
      expect(seen.size).toBe(3);
    });
  });
});

describe("every request is answered at the one dispatch boundary (wf1b-design H1/M6)", () => {
  async function boundaryServer(): Promise<{ server: Server; port: number }> {
    const router = createRouter({ db: memAdb, isPublicPath: () => true });
    router.get("/api/items/:id", (ctx) => { sendJson(ctx.res, { id: ctx.params["id"] }); });
    router.get("/api/hostile", () => {
      // An error nothing can describe: reading its status throws.
      const hostile = new Error("x");
      Object.defineProperty(hostile, "statusCode", { get: () => { throw new Error("the status cannot be read"); } });
      throw hostile;
    });
    const server = createServer((req, res) => {
      // The promise is dropped exactly as server/index.ts drops it: a
      // rejection here would be an unanswered socket.
      void router.dispatch(req, res).catch((error: unknown) => { unanswered.push(error); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    return { server, port: typeof address === "object" && address !== null ? address.port : 0 };
  }
  const unanswered: unknown[] = [];

  function raw(port: number, path: string, host: string): Promise<Readonly<{ status: number; body: string }>> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host }, timeout: 5_000 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("timeout", () => req.destroy(new Error(`${path}: no response (a hung request)`)));
      req.on("error", reject);
      req.end();
    });
  }

  test("a malformed percent-escape and an unparsable Host are typed 400s; an indescribable error is the counted last-resort 503", async () => {
    const { egressFailureCounts } = await import("../../server/router/egress-failures.ts");
    const { server, port } = await boundaryServer();
    try {
      const escape = await raw(port, "/api/items/%E0%A4%A", `127.0.0.1:${String(port)}`);
      expect([escape.status, JSON.parse(escape.body).error]).toEqual([400, "request_path_malformed"]);
      const host = await raw(port, "/api/items/1", "127.0.0.1:abc");
      expect([host.status, JSON.parse(host.body).error]).toEqual([400, "request_host_invalid"]);
      const before = egressFailureCounts().lastResortResponses;
      const hostile = await raw(port, "/api/hostile", `127.0.0.1:${String(port)}`);
      expect(hostile.status).toBe(503);
      expect(JSON.parse(hostile.body)).toEqual({ error: "service_unavailable", message: "The server could not prepare a safe description of this error." });
      expect(egressFailureCounts().lastResortResponses).toBe(before + 1);
      expect(unanswered, "dispatch rejected: the socket would never have been answered").toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
