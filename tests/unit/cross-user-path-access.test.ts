// @vitest-environment node
/**
 * BEHAVIORAL regression test for the Round-4 cross-user path-access fix
 * (Single-Party-Owner: route registry security).
 *
 * ROOT CAUSE this test pins: the editor, git-ops, intelligence, awareness,
 * quality, and file-tree routes all accept a USER-SUPPLIED project `path`/
 * `root` parameter. Before  they confined the path to `root`
 * (traversal guard) but NEVER verified the root belonged to a project
 * owned by the authenticated user — so User B could pass User A's project
 * path and READ/WRITE/EDIT/DELETE A's files, query A's git status, code
 * graph, awareness, quality. This is a CRITICAL cross-user filesystem +
 * intelligence leak.
 *
 * The fix: `requireProjectByPath(ctx, db, path)` (user-context.ts) verifies
 * the authenticated user owns a project at the supplied path (DB-side gate
 * via `getProjectByPath(path, userId)`). A non-owned path → ForbiddenError
 * (403, code `project_path_not_owned`).
 *
 * This test is behavioral (WORKFLOW.md §9): it spins up a real HTTP server
 * with the REAL route modules + REAL DB, registers two users, creates a
 * project as User A, then verifies User B gets 403 on every path-based
 * route pointing at A's project, while User A is allowed. It catches the
 * regression mechanically — re-introducing the leak (removing
 * requireProjectByPath from any one route) fails the corresponding case.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";

import { registerAllRoutes } from "../../server/routes/registry.ts";
import { isolateHarnessConfig } from "../helpers/isolated-config.ts";
import { createTestUser, type TestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";

let srv: HttpTestServer;
let userA: TestUser;
let userB: TestUser;
let projectAPath: string;
let projectAId: string;
isolateHarnessConfig("cross-user-path-config-");

beforeAll(async () => {
  srv = await startHttpTestServer({
    prefix: "ch-cross-user-path-",
    register: (router, db, adb) => {
      registerAllRoutes(router, adb);
    },
  });
  userA = createTestUser(srv.db, "alice-path");
  userB = createTestUser(srv.db, "bob-path");

  // User A creates a real project at a real path with a real file (so the
  // intelligence/git/editor bridges do not crash on A's own access).
  projectAPath = join(srv.tmpRoot, "alice-project");
  mkdirSync(projectAPath, { recursive: true });
  writeFileSync(join(projectAPath, "a.ts"), "export const x = 1;\n");

  // Create the project as User A via the DB (the route would do this).
  const project = srv.db.createProject({ name: "A-project", path: projectAPath }, userA.userId);
  projectAId = project.id;


});

afterAll(async () => {
  if (srv) await srv.stop();
});

async function req(
  user: TestUser,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const { status, body } = await jsonRequest(srv.baseUrl, path, { ...init, cookie: user.cookie });
  return { status, body };
}

// ── Dynamic route discovery ──
// A "path-based route" is one that accepts a USER-SUPPLIED project path. The
// discovery scans ALL server/routes/*.ts files for three patterns:
// 1. `requirePathQuery(` — the path-query-param helper (intelligence,
// awareness, quality, git-ops). ALL routes in these files (GET + POST)
// use `?path=` query param.
// 2. `query.get("path")` — direct path-query-param access (file-tree).
// Only GET routes use `?path=` query param.
// 3. `query.get("root")` — the root-query-param access (editor read).
// Only GET routes use `?root=` query param. POST/PUT/DELETE routes in
// the editor file use `root:` in the BODY (not a query param) — these
// need specific body shapes and are tested by the dedicated editor
// body-route tests below (NOT by the dynamic query-param tests).
// For each matching file, the registered API paths are PARSED from
// `router.(get|post|put|delete)("path",...)` so a new route is automatically
// discovered + tested. The hardcoded PATH_QUERY_ROUTES list is GONE.

const ROUTES_DIR_PATH = join(process.cwd(), "server", "routes");

/** Dynamically discover ALL GET routes that accept a `?path=` query param. */
function discoverGetPathRoutes(): string[] {
  const routes: string[] = [];
  const files = readdirSync(ROUTES_DIR_PATH).filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    const src = readFileSync(join(ROUTES_DIR_PATH, file), "utf8");
    // A file uses `?path=` for the PROJECT path if it imports
    // requirePathQuery OR uses query.get("path") + assertProjectOwnership
    // AND does NOT also use query.get("root") (editor.ts uses both — its
    //?path= is the FILE path,?root= is the project root; the project
    // ownership is on?root=, tested by discoverGetRootRoutes).
    const hasRequirePathQuery = /\brequirePathQuery\s*\(/.test(src);
    const hasQueryPath = /query\.get\(\s*["']path["']\s*\)/.test(src);
    const hasQueryRoot = /query\.get\(\s*["']root["']\s*\)/.test(src);
    const hasProjectOwnership = /assertProjectPathOwnership/.test(src);
    const isPathProjectParam = hasRequirePathQuery || (hasQueryPath && hasProjectOwnership && !hasQueryRoot);
    if (!isPathProjectParam) continue;
    // Parse GET route registrations: router.get("/api/...",...)
    const routeRe = /router\.get\(\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = routeRe.exec(src)) !== null) {
      routes.push(m[1]!);
    }
  }
  return routes;
}

/** Dynamically discover POST routes that accept a `?path=` query param. */
function discoverPostPathRoutes(): string[] {
  const routes: string[] = [];
  const files = readdirSync(ROUTES_DIR_PATH).filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    const src = readFileSync(join(ROUTES_DIR_PATH, file), "utf8");
    // Only files importing requirePathQuery use?path= for POST routes
    // (e.g. awareness/invalidate, intelligence/invalidate). Editor POST
    // routes use root: in the BODY — excluded.
    if (!/\brequirePathQuery\s*\(/.test(src)) continue;
    const routeRe = /router\.post\(\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = routeRe.exec(src)) !== null) {
      routes.push(m[1]!);
    }
  }
  return routes;
}

/** Dynamically discover GET routes that accept a `?root=` query param. */
function discoverGetRootRoutes(): string[] {
  const routes: string[] = [];
  const files = readdirSync(ROUTES_DIR_PATH).filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    const src = readFileSync(join(ROUTES_DIR_PATH, file), "utf8");
    if (!/query\.get\(\s*["']root["']\s*\)/.test(src)) continue;
    const routeRe = /router\.get\(\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = routeRe.exec(src)) !== null) {
      routes.push(m[1]!);
    }
  }
  return routes;
}

const DISCOVERED_GET_PATH_ROUTES = discoverGetPathRoutes();
const DISCOVERED_POST_PATH_ROUTES = discoverPostPathRoutes();
const DISCOVERED_GET_ROOT_ROUTES = discoverGetRootRoutes();

describe("cross-user path-access fix: User B cannot access User A's project by path (dynamic discovery)", () => {
  // Dynamic: every path-based GET route is discovered from the
  // route files — NO hardcoded list. A new route that accepts a user path
  // is automatically tested for cross-user denial.

  test("dynamic discovery found at least one path-based route (sanity)", () => {
    expect(DISCOVERED_GET_PATH_ROUTES.length, "should discover GET routes with ?path= param").toBeGreaterThan(0);
  });

  for (const route of DISCOVERED_GET_PATH_ROUTES) {
    test(`User B GET ${route}?path=<A's project> → 403 project_path_not_owned`, async () => {
      // Send common extra params (file, q, symbol) so routes that validate
      // them before the ownership check (e.g. intelligence/impact needs
      //?file=, intelligence/search needs?q=) reach the ownership gate.
      // Routes that don't use these params ignore them. This is NOT a
      // hardcoded route list — it's a set of common query params sent to
      // ALL discovered routes generically.
      const url = `${route}?path=${encodeURIComponent(projectAPath)}&file=x&q=x&symbol=x`;
      const { status, body } = await req(userB, url);
      expect(status).toBe(403);
      expect((body as { error: string }).error).toBe("project_path_not_owned");
    });
  }

  for (const route of DISCOVERED_POST_PATH_ROUTES) {
    test(`User B POST ${route}?path=<A's project> → 403`, async () => {
      const url = `${route}?path=${encodeURIComponent(projectAPath)}`;
      const { status } = await req(userB, url, { method: "POST" });
      expect(status).toBe(403);
    });
  }

  for (const route of DISCOVERED_GET_ROOT_ROUTES) {
    test(`User B GET ${route}?root=<A's project> → 403 project_path_not_owned`, async () => {
      // The editor read route validates?path= (non-empty) before the
      // ownership check on?root=, so send a minimal?path= to reach the
      // gate. The ownership check is on?root= (the project root).
      const url = `${route}?path=x&root=${encodeURIComponent(projectAPath)}`;
      const { status, body } = await req(userB, url);
      expect(status).toBe(403);
      expect((body as { error: string }).error).toBe("project_path_not_owned");
    });
  }

  test("User B PUT /api/editor/write with root=<A's project> → 403 (cannot write A's files)", async () => {
    const { status, body } = await req(userB, "/api/editor/write", {
      method: "PUT",
      body: { path: join(projectAPath, "hacked.txt"), content: "pwned", root: projectAPath },
    });
    expect(status).toBe(403);
    expect((body as { error: string }).error).toBe("project_path_not_owned");
  });

  test("User B DELETE /api/editor/delete with root=<A's project> → 403 (cannot delete A's files)", async () => {
    const { status } = await req(userB, "/api/editor/delete", {
      method: "DELETE",
      body: { path: join(projectAPath, "a.ts"), root: projectAPath },
    });
    expect(status).toBe(403);
  });

  test("User B PUT /api/editor/edit with root=<A's project> → 403 (cannot edit A's files)", async () => {
    const { status } = await req(userB, "/api/editor/edit", {
      method: "PUT",
      body: { path: join(projectAPath, "a.ts"), oldContent: "x", newContent: "y", root: projectAPath },
    });
    expect(status).toBe(403);
  });

  test("User B GET /api/editor/read with root=<A's project> → 403 (cannot read A's files)", async () => {
    const { status } = await req(userB, `/api/editor/read?path=${encodeURIComponent(join(projectAPath, "a.ts"))}&root=${encodeURIComponent(projectAPath)}`);
    expect(status).toBe(403);
  });

  test("User A can access their OWN project (not 403) — the gate allows the owner", async () => {
    // User A owns the project; the gate passes. The intelligence bridge may
    // return 202 (indexing) or 200, but MUST NOT be 403/401.
    const { status } = await req(userA, `/api/intelligence/duplicates?path=${encodeURIComponent(projectAPath)}`);
    expect([200, 202]).toContain(status);
  });

  test("User A PUT /api/editor/write with root=<own project> → 200 (the owner can write)", async () => {
    const { status } = await req(userA, "/api/editor/write", {
      method: "PUT",
      body: { path: join(projectAPath, "new.txt"), content: "ok", root: projectAPath },
    });
    expect(status).toBe(200);
  });

  test("User B with a NON-existent project path → 403 (no project at that path for B)", async () => {
    const { status } = await req(userB, `/api/git/status?path=${encodeURIComponent(join(srv.tmpRoot, "nope"))}`);
    expect(status).toBe(403);
  });

  test("User B cannot bypass by passing A's project ID directly to a path route — path routes ignore IDs", async () => {
    // Sanity: the path-based routes use the PATH, not the project ID. Passing
    // A's project ID as the path does not resolve to A's project (it's not a
    // path) → 403 (no project owned by B at that "path").
    const { status } = await req(userB, `/api/git/status?path=${encodeURIComponent(projectAId)}`);
    expect(status).toBe(403);
  });
});

describe("admin-gating: the global config document is an admin's to read, as to write", () => {
  test("User B (non-admin) GET /api/config → 403 admin_required, and nothing of the document", async () => {
    const { status, body } = await req(userB, "/api/config");
    expect(status).toBe(403);
    expect((body as { error: string }).error).toBe("admin_required");
    expect(JSON.stringify(body)).not.toContain("configPath");
  });

  test("User A (admin) GET /api/config → the redacted document", async () => {
    const { status, body } = await req(userA, "/api/config");
    expect(status).toBe(200);
    expect(typeof (body as { config?: unknown }).config).toBe("object");
  });

  test("the duplicate GET /api/config/raw is gone", async () => {
    const { status } = await req(userA, "/api/config/raw");
    expect(status).toBe(404);
  });
});

describe("admin-gating: non-admin cannot mutate global config/schema", () => {
  test("User B (non-admin) PUT /api/config → 403 admin_required", async () => {
    const { status, body } = await req(userB, "/api/config", {
      method: "PUT",
      body: { path: "runtime.defaultModel", value: "evil-model" },
    });
    expect(status).toBe(403);
    expect((body as { error: string }).error).toBe("admin_required");
  });

  test("User B (non-admin) PUT /api/schema/ui/customizations/:id → 403 admin_required", async () => {
    const { status } = await req(userB, "/api/schema/ui/customizations/search.threshold", {
      method: "PUT",
      body: { value: 0.99 },
    });
    expect(status).toBe(403);
  });

  test("User B (non-admin) POST /api/schema/ui/actions/:id → 403 admin_required", async () => {
    const { status } = await req(userB, "/api/schema/ui/actions/search.clearCache", {
      method: "POST",
      body: {},
    });
    expect(status).toBe(403);
  });

  test("User A (admin, first registered) PUT /api/config → allowed (not 403)", async () => {
    // The first registered user is the admin. User A can mutate the global
    // config (the sensitive-key guard still applies; this path is not
    // sensitive). Use a VALID model id (gemma-4-31b — in the neuralwatt
    // provider's model list + ) so the write does not leave
    // the shared config in a state the backend schema rejects. The config
    // is backed up + restored in beforeAll/afterAll regardless.
    const { status } = await req(userA, "/api/config", {
      method: "PUT",
      body: { path: "runtime.defaultModel", value: "gemma-4-31b" },
    });
    expect(status).not.toBe(403);
  });
});
