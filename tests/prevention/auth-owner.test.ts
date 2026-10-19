// @vitest-environment node
/**
 * Mechanical enforcement: the Single-Party-Owner "AUTH OWNER" principle
 * (Part A). AUTH has ONE owner module (`server/user-context.ts` →
 * `requireUserContext` / `requireAdminContext`). The router (`server/router.ts`)
 * OWNS the cross-cutting auth gate; the route registry
 * (`server/routes/registry.ts`) owns the public-path set. Together they
 * enforce DENY-BY-DEFAULT: every non-public route requires a valid session,
 * and a route that is not registered returns 404 (never accidentally
 * accessible).
 *
 * This test pins four invariants ("Deny-by-Default / Explicit-Add"):
 * (a) The public-path set is EXPLICIT + FINITE — a literal array of exact
 * path strings, no wildcards/regex/variables (so a new public route
 * must be added deliberately, never accidentally matched).
 * (b) The router's auth gate runs BEFORE route matching, and `isPublicPath`
 * is the ONLY exemption (no second public-path allowlist elsewhere).
 * (c) The global-mutation routes (PUT /api/config, POST/PUT /api/schema/ui)
 * call `requireAdminContext` (not just `requireUserContext`) — a
 * regular user cannot mutate global harness state.
 * (d) DENY-BY-DEFAULT behavior: an UNREGISTERED non-public path returns 404
 * (when authenticated) and 401 (when not); a registered non-public path
 * returns 401 when unauthenticated; a public path returns 200 when
 * unauthenticated.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { walk } from "../helpers/source-scan.ts";

import { createRouter } from "../../server/router/router.ts";
import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import {
  registerAllRoutes,
  isPublicPath,
  PUBLIC_PATH_PREFIXES,
} from "../../server/routes/registry.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const REGISTRY_PATH = join(process.cwd(), "server", "routes", "registry.ts");
const ROUTER_PATH = join(process.cwd(), "server", "router", "router.ts");
const INDEX_PATH = join(process.cwd(), "server", "index.ts");
const ROUTES_DIR = join(process.cwd(), "server", "routes");

describe("Auth owner — public-path set is explicit + finite (no wildcards)", () => {
  test("PUBLIC_PATH_PREFIXES is a literal array of exact path strings (no wildcards/regex/variables)", () => {
    // The public-path set must be a finite, explicit list. Deny-by-default
    // requires that NO path is public unless it is literally listed here —
    // a wildcard or a variable would silently open routes. Each entry must
    // be a string literal starting with "/api/" (the API surface).
    expect(Array.isArray(PUBLIC_PATH_PREFIXES)).toBe(true);
    expect(PUBLIC_PATH_PREFIXES.length).toBeGreaterThan(0);
    expect(PUBLIC_PATH_PREFIXES.length).toBeLessThan(20); // finite + small
    for (const prefix of PUBLIC_PATH_PREFIXES) {
      expect(typeof prefix).toBe("string");
      expect(prefix.startsWith("/api/")).toBe(true);
      // No regex metacharacters used as wildcards (a literal prefix only).
      expect(/[.*+?^${}()|[\]\\]/.test(prefix)).toBe(false);
    }
  });

  test("the registry SOURCE declares PUBLIC_PATH_PREFIXES as a readonly string literal array (no dynamic computation)", () => {
    const src = readFileSync(REGISTRY_PATH, "utf8");
    // The declaration must be a literal array `[... ]`, not a function call
    // or a spread of a variable (which could grow dynamically).
    expect(src).toMatch(/export\s+const\s+PUBLIC_PATH_PREFIXES\s*:\s*readonly\s+string\[\]\s*=\s*\[/);
    // No `.map`/`.filter`/spread that could derive the list dynamically.
    const decl = src.match(/export\s+const\s+PUBLIC_PATH_PREFIXES[\s\S]*?\];/);
    expect(decl).not.toBeNull();
    expect(decl![0]).not.toMatch(/\.\w+\(|\.\.\./);
  });

  test("isPublicPath is the ONLY public-path predicate (no second allowlist in the router or bootstrap)", () => {
    // The router must consult `isPublicPath` (from the registry) — it must
    // NOT define its own public-path list or inline `path === "/api/..."` checks.
    const routerSrc = readFileSync(ROUTER_PATH, "utf8");
    expect(routerSrc).toMatch(/isPublicPath/);
    // The router must NOT hardcode a public path literal (a second allowlist).
    expect(routerSrc).not.toMatch(/path\s*===\s*["']\/api\/(auth|health)/);
    // The bootstrap must NOT define its own public-path check either.
    const indexSrc = readFileSync(INDEX_PATH, "utf8");
    expect(indexSrc).not.toMatch(/path\s*===\s*["']\/api\/(auth|health)/);
    expect(indexSrc).not.toMatch(/path\.startsWith\(\s*["']\/api\/auth/);
  });
});

describe("Auth owner — the router's auth gate runs BEFORE route matching (deny-by-default)", () => {
  const routerSrc = readFileSync(ROUTER_PATH, "utf8");

  test("dispatch calls the auth gate before the route-matching loop", () => {
    // The auth gate call must appear textually BEFORE the `for (const route of routes)`
    // loop in dispatch — so an unauthenticated request to ANY non-public path
    // (even an unregistered one) is rejected before route matching.
    // The whole of serving a request lives in `serveRequest`, which
    // `dispatch` wraps in its one catch (every request is answered).
    const dispatchStart = routerSrc.indexOf("async function serveRequest(");
    expect(dispatchStart).toBeGreaterThan(-1);
    const loopStart = routerSrc.indexOf("for (const route of routes)", dispatchStart);
    expect(loopStart).toBeGreaterThan(-1);
    const gatePos = routerSrc.indexOf("authGate(", dispatchStart);
    expect(gatePos).toBeGreaterThan(-1);
    expect(gatePos).toBeLessThan(loopStart);
  });

  test("the auth gate THROWS AuthError (not writes a 401) when blocked — the router maps it (-V9 fix)", () => {
    // The gate must: (1) check isPublicPath FIRST (return to allow), (2)
    // reject setup mode, (3) reject no/invalid session. The presence of
    // all three guards is pinned so a refactor cannot drop one. 
    // (-V9): the gate THROWS `AuthError` instead of writing its own
    // 401 response — the router's error mapping (`statusForError` +
    // `errorBody`) owns the 401 (Single-Party-Owner: error responses have
    // one owner — the router; routes + guards throw, the router maps).
    const gateFn = routerSrc.match(/function authGate\([\s\S]*?^  }/m);
    expect(gateFn).not.toBeNull();
    const body = gateFn![0];
    expect(body).toMatch(/isPublicPath/);
    expect(body).toMatch(/countUsers\(\)/);
    expect(body).toMatch(/resolveAuthUser/);
    // authGate throws typed AuthError (with setup_required / unauthorized
    // codes) — the router maps AuthError.statusCode (401) to the response.
    expect(body).toMatch(/throw new AuthError/);
    expect(body).toMatch(/setup_required/);
    expect(body).toMatch(/unauthorized/);
    // authGate must NOT write the response directly (writeHead/end) — the
    // router owns response headers + error bodies (-V9 fix). It no
    // longer takes a `res` param (it has no use for one).
    expect(body).not.toMatch(/res\.writeHead/);
    expect(body).not.toMatch(/res\.end/);
    // The signature no longer takes `res: ServerResponse` — it only needs
    // the request + path (it throws; the caller maps).
    expect(body).toMatch(/function authGate\(\s*req:\s*IncomingMessage,\s*path:\s*string\s*\)/);
  });
});

describe("Auth owner — admin-gating: global-mutation routes call requireAdminContext", () => {
  test("config PUT + schema POST/PUT actions/customizations call requireAdminContext (not just requireUserContext)", () => {
    const configSrc = readFileSync(join(ROUTES_DIR, "config.ts"), "utf8");
    const schemaSrc = readFileSync(join(ROUTES_DIR, "schema.ts"), "utf8");
    // The admin gate must guard each global-mutation handler.
    expect(configSrc).toMatch(/router\.put\([\s\S]*?requireAdminContext\(/);
    expect(schemaSrc).toMatch(/router\.post\([\s\S]*?requireAdminContext\(/);
    expect(schemaSrc).toMatch(/router\.put\([\s\S]*?requireAdminContext\(/);
  });

  test("requireAdminContext is the SINGLE admin gate, owned by user-context.ts (not redefined elsewhere)", () => {
    // The admin gate must be defined ONCE (user-context.ts). No route or
    // bridge redefines its own admin check (a scattered-helper + an
    // inconsistent privilege boundary).
    const ctxSrc = readFileSync(join(process.cwd(), "server", "auth", "user-context.ts"), "utf8");
    expect(ctxSrc).toMatch(/export\s+async\s+function\s+requireAdminContext\s*\(/);
    const serverRoot = join(process.cwd(), "server");
    for (const f of walk(serverRoot, { exts: [".ts"] })) {
      const src = readFileSync(f, "utf8");
      // A `function requireAdminContext` DEFINITION outside user-context.ts.
      if (/export\s+async\s+function\s+requireAdminContext\s*\(/.test(src) && !f.endsWith("user-context.ts")) {
        throw new Error(`${f} redefines requireAdminContext — the admin gate must live ONLY in server/user-context.ts.`);
      }
    }
  });
});

describe("Auth owner — deny-by-default behavior (unregistered → 404, unauth → 401, public → 200)", () => {
  let server: Server;
  let baseUrl: string;
  let authCookie: string;
  let tmpRoot: string;
  let db: DbClient;

  beforeAll(async () => {
    tmpRoot = createTempDir("ch-auth-owner-");
    db = new DbClient({ path: join(tmpRoot, "web.db") });
    authCookie = createTestUser(db, "auth-owner-admin").cookie;
    // Register EVERY route (the real registry) so the behavioral test
    // exercises the same path set production uses.
    const adb = AsyncDbClient.inline(db);
    const router = createRouter({ db: adb, isPublicPath });
    registerAllRoutes(router, adb);
    server = createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (db) db.close();
  });

  async function get(path: string, cookie: string | null): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { "X-Requested-With": "test" };
    if (cookie !== null) headers["Cookie"] = cookie;
    const res = await fetch(`${baseUrl}${path}`, { method: "GET", headers });
    const text = await res.text();
    let body: unknown = undefined;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  }

  test("an UNREGISTERED non-public path returns 404 when authenticated (not accidentally accessible)", async () => {
    const { status } = await get("/api/this-route-does-not-exist-anywhere", authCookie);
    expect(status).toBe(404);
  });

  test("an UNREGISTERED non-public path returns 401 when NOT authenticated (auth gate runs before matching)", async () => {
    const { status } = await get("/api/this-route-does-not-exist-anywhere", null);
    expect(status).toBe(401);
  });

  test("a REGISTERED non-public path returns 401 when NOT authenticated (deny-by-default)", async () => {
    const { status } = await get("/api/projects", null);
    expect(status).toBe(401);
  });

  test("a PUBLIC path returns 200 when NOT authenticated (the explicit exemption)", async () => {
    const { status } = await get("/api/health", null);
    expect(status).toBe(200);
    const { status: authStatus } = await get("/api/auth/status", null);
    expect(authStatus).toBe(200);
  });

  test("a REGISTERED non-public path returns 200 when authenticated (the gate admits a valid session)", async () => {
    const { status } = await get("/api/projects", authCookie);
    expect(status).toBe(200);
  });

  test("a public-path prefix does NOT accidentally match a longer unrelated path (no wildcard leak)", async () => {
    // `/api/health` is public; `/api/health-check` (unregistered) must NOT
    // be treated as public — it should require auth (401 unauth) and 404 authed.
    const { status: unauth } = await get("/api/health-check", null);
    expect(unauth).toBe(401);
    const { status: authed } = await get("/api/health-check", authCookie);
    expect(authed).toBe(404);
  });
});

describe("Auth owner — the router maps thrown AuthError + CsrfError to the HTTP response (-V8/V9)", () => {
  // authGate + checkCsrf now THROW typed errors instead of writing
  // their own 401/403 responses. The router's dispatch catches BOTH + maps
  // them via the centralized error-mapping choke point (statusForError +
  // errorBody). These behavioral tests verify the FULL path through the real
  // router + real route registry: the gate throws, the router catches, the
  // response has the correct status + body. This is the end-to-end proof that
  // the consolidation did not regress the live behavior (unauth → 401,
  // no-CSRF → 403, authed+CSRF → 200).
  let server: Server;
  let baseUrl: string;
  let authCookie: string;
  let tmpRoot: string;
  let db: DbClient;

  beforeAll(async () => {
    tmpRoot = createTempDir("ch-auth-owner-csrf-");
    db = new DbClient({ path: join(tmpRoot, "web.db") });
    authCookie = createTestUser(db, "auth-owner-csrf").cookie;
    const adb = AsyncDbClient.inline(db);
    const router = createRouter({ db: adb, isPublicPath });
    registerAllRoutes(router, adb);
    server = createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (db) db.close();
  });

  /** POST without the CSRF custom header + a CROSS-origin Origin (so neither
   * CSRF defense passes). `cookie` controls auth. */
  async function postNoCsrf(path: string, cookie: string | null): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { "Origin": "https://evil.example.com" };
    if (cookie !== null) headers["Cookie"] = cookie;
    const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: "{}" });
    const text = await res.text();
    let body: unknown = undefined;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  }

  test("an UNAUTHENTICATED POST returns 401 (authGate throws AuthError BEFORE checkCsrf runs)", async () => {
    // Auth runs before CSRF, so a missing cookie → 401 `unauthorized` even
    // though the request also lacks CSRF headers. The router maps the
    // thrown AuthError (statusCode 401) → the response.
    const { status, body } = await postNoCsrf("/api/projects", null);
    expect(status).toBe(401);
    expect((body as { error?: string }).error).toBe("unauthorized");
  });

  test("an AUTHENTICATED POST with NO CSRF defense returns 403 csrf_blocked (checkCsrf throws → router maps)", async () => {
    // Auth passes (valid cookie); CSRF fails (cross-origin + no custom
    // header) → checkCsrf throws CsrfError → the router catches it +
    // maps to 403 `csrf_blocked`. This is the -V8 fix: the router owns
    // the 403 response (the guard no longer writes it).
    const { status, body } = await postNoCsrf("/api/projects", authCookie);
    expect(status).toBe(403);
    expect((body as { error?: string }).error).toBe("csrf_blocked");
    expect((body as { message?: string }).message).toContain("Cross-site request blocked");
  });

  test("an AUTHENTICATED POST WITH the CSRF custom header is admitted past the CSRF gate (no 403)", async () => {
    // Same-origin OR custom header exempts CSRF. Send the custom header →
    // the CSRF gate throws nothing → the route handler runs (200/4xx from
    // the handler, but NOT 403 csrf_blocked). This proves the custom-header
    // defense still works end-to-end through the consolidated path.
    const headers: Record<string, string> = {
      "Cookie": authCookie,
      "X-Requested-With": "test",
      "Content-Type": "application/json",
    };
    const res = await fetch(`${baseUrl}/api/projects`, { method: "POST", headers, body: "{}" });
    expect(res.status).not.toBe(403);
    const text = await res.text();
    let body: unknown = undefined;
    try { body = JSON.parse(text); } catch { body = text; }
    expect((body as { error?: string }).error).not.toBe("csrf_blocked");
  });
});
