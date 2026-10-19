// @vitest-environment node
/**
 * Mechanical enforcement: the Single-Party-Owner principle for ROUTE
 * REGISTRATION ("Routes: a single route registry module.
 * Adding a route = register it once; the registry handles auth middleware,
 * CSRF, rate limiting, input validation, error mapping — NOT each route
 * file").
 *
 * extension: the single registry moved from `server/index.ts`
 * (27 ad-hoc `register*Routes` calls) into `server/routes/registry.ts`
 * (`registerAllRoutes`). `index.ts` now calls ONLY `registerAllRoutes`.
 * The router (`server/router.ts`) OWNS the cross-cutting middleware (auth,
 * CSRF, rate limiting, error mapping, body parsing); each route file
 * defines ONLY its handler logic.
 *
 * This test is DYNAMIC (no hardcoded allowlist): it scans the
 * routes/ dir + registry.ts so a newly added route file is automatically
 * required to be wired. It fails when:
 * a route file exports `register*Routes` but registry.ts does NOT call
 * it (a forgotten registration — the routes would silently never mount),
 * registry.ts calls `register*Routes(...)` without a matching import OR
 * a matching export (a broken registry that would crash at boot),
 * a route is registered ad-hoc outside a `register*Routes` body,
 * `server/index.ts` registers routes directly (bypassing the registry),
 * the router's `createRouter` is called without `db`/`isPublicPath`
 * (a production caller bypassing the auth gate — security hole),
 * `ConflictError` (the 409 typed error) is defined outside errors.ts
 * (the single typed-error owner).
 */
import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_PATH_PREFIXES } from "../../server/routes/registry.ts";
import { stripCommentsOnly } from "../helpers/source-scan.ts";

const ROUTES_DIR = join(process.cwd(), "server", "routes");
const INDEX_PATH = join(process.cwd(), "server", "index.ts");
const REGISTRY_PATH = join(process.cwd(), "server", "routes", "registry.ts");
const ERRORS_PATH = join(process.cwd(), "server", "kernel", "errors.ts");
const ROUTER_PATH = join(process.cwd(), "server", "router", "router.ts");

function listRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"));
}

const REGISTER_EXPORT_RE = /export\s+function\s+(register\w+Routes)\s*\(/g;
const REGISTER_CALL_RE = /\b(register\w+Routes)\s*\(/g;
// registry.ts imports route modules as `./auth.ts`, `./health.ts`, etc. The
// path may include `.` (the `.ts` extension), so the capture is `[^"']+`
// (everything up to the closing quote). The `.ts` is stripped before
// comparing to the export file basename.
const IMPORT_RE = /import\s+\{\s*([^}]+)\s*\}\s+from\s+["']\.\/([^"']+)["']/g;

function collectMatches(re: RegExp, src: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]!);
  return out;
}

describe("Single-Party-Owner: route registry — every register*Routes is wired in registry.ts", () => {
  test("registry.ts exists (the single route-registration owner)", () => {
    expect(existsSync(REGISTRY_PATH)).toBe(true);
  });

  const registrySrc = existsSync(REGISTRY_PATH) ? stripCommentsOnly(readFileSync(REGISTRY_PATH, "utf8")) : "";
  const calledInRegistry = new Set(collectMatches(REGISTER_CALL_RE, registrySrc));

  // Map: register*Routes name → file (from the registry.ts import statements).
  const importedByRegistry = new Map<string, string>();
  let im: RegExpExecArray | null;
  const importReGlobal = new RegExp(IMPORT_RE.source, "g");
  while ((im = importReGlobal.exec(registrySrc)) !== null) {
    const names = im[1]!.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    for (const n of names) importedByRegistry.set(n, im[2]!);
  }

  // Map: register*Routes name → file (from the route files' exports).
  const exportedByRoute = new Map<string, string>();
  for (const file of listRouteFiles()) {
    const src = stripCommentsOnly(readFileSync(join(ROUTES_DIR, file), "utf8"));
    for (const name of collectMatches(REGISTER_EXPORT_RE, src)) {
      exportedByRoute.set(name, file);
    }
  }

  test("every register*Routes exported by a route file is called in registry.ts (no forgotten registration)", () => {
    const unwired = [...exportedByRoute.keys()].filter((n) => !calledInRegistry.has(n));
    if (unwired.length > 0) {
      throw new Error(
        `Route registration bypass: these register*Routes are exported but NOT wired in server/routes/registry.ts ` +
          `(add them inside registerAllRoutes):\n` +
          unwired.map((n) => `  ${exportedByRoute.get(n)} exports ${n}`).join("\n"),
      );
    }
  });

  test("every register*Routes call in registry.ts resolves to a real import + a real export (no broken registry)", () => {
    const broken: string[] = [];
    for (const name of calledInRegistry) {
      // `registerAllRoutes` is DEFINED in registry.ts (the single registry
      // function), not imported — exclude it from the import-resolution
      // check. Every OTHER register*Routes call must resolve to an import.
      if (name === "registerAllRoutes") continue;
      const importedFile = importedByRegistry.get(name);
      const exportedFile = exportedByRoute.get(name);
      if (importedFile === undefined) {
        broken.push(`${name} is called in registry.ts but has no matching import from ./routes/*`);
      } else if (exportedFile === undefined) {
        broken.push(`${name} is called in registry.ts but no route file exports it`);
      } else {
        const imp = importedFile.replace(/\.ts$/, "");
        const exp = exportedFile.replace(/\.ts$/, "");
        if (imp !== exp) {
          broken.push(
            `${name} is imported from ./${importedFile} but exported by ${exportedFile} (import/export mismatch)`,
          );
        }
      }
    }
    if (broken.length > 0) {
      throw new Error(
        `Broken route registry in server/routes/registry.ts:\n  ` + broken.join("\n  "),
      );
    }
  });

  test("no route file registers routes ad-hoc outside a register*Routes body (router.* only inside the registry function)", () => {
    for (const file of listRouteFiles()) {
      const src = stripCommentsOnly(readFileSync(join(ROUTES_DIR, file), "utf8"));
      const fnMatch = src.match(/export\s+function\s+register\w+Routes\s*\([^)]*\)\s*:\s*void\s*\{/);
      if (fnMatch === null) continue; // helper file (no registry fn) — skip
      const bodyStart = src.indexOf(fnMatch[0]!);
      const before = src.slice(0, bodyStart);
      const adHoc = before.match(/\brouter\.(get|post|put|patch|delete)\s*\(/);
      if (adHoc !== null) {
        throw new Error(
          `${file} registers a route ad-hoc (router.${adHoc[1]} outside the register*Routes body) — ` +
            `move it inside the registry function (Single-Party-Owner: one registration path).`,
        );
      }
    }
  });

  test("server/index.ts does NOT register routes directly (it must call registerAllRoutes only)", () => {
    // index.ts is the bootstrap; it must NOT import or call any individual
    // register*Routes — that bypasses the registry. The single allowed
    // registration call is `registerAllRoutes` from./routes/registry.ts.
    const indexSrc = stripCommentsOnly(readFileSync(INDEX_PATH, "utf8"));
    const direct = indexSrc.match(/\b(register(?!AllRoutes)\w+Routes)\s*\(/);
    if (direct !== null) {
      throw new Error(
        `server/index.ts calls ${direct[1]} directly — route registration must go through ` +
          `registerAllRoutes in server/routes/registry.ts (Single-Party-Owner: one registration path).`,
      );
    }
    // index.ts must call registerAllRoutes exactly once.
    const allCalls = collectMatches(/\b(registerAllRoutes)\s*\(/g, indexSrc);
    expect(allCalls.length).toBe(1);
  });

  test("registry.ts exports registerAllRoutes + the public-path predicate (isPublicPath)", () => {
    expect(registrySrc).toMatch(/export\s+function\s+registerAllRoutes\s*\(/);
    expect(registrySrc).toMatch(/export\s+function\s+isPublicPath\s*\(/);
    expect(registrySrc).toMatch(/export\s+const\s+PUBLIC_PATH_PREFIXES/);
  });
});

describe("Single-Party-Owner: router owns the cross-cutting middleware (auth/CSRF/rate-limit/error-map)", () => {
  const routerSrc = stripCommentsOnly(readFileSync(ROUTER_PATH, "utf8"));

  test("createRouter requires a db + isPublicPath option (no auth-bypass by omission)", () => {
    // The router factory MUST take options carrying the DB (for auth) and
    // the public-path predicate. A caller that omits them must NOT compile —
    // this test pins that the options are required (not optional defaults
    // that silently disable auth — a security hole).
    expect(routerSrc).toMatch(/export\s+type\s+RouterOptions\s*=/);
    expect(routerSrc).toMatch(/readonly\s+db\s*:\s*AsyncDbClient/);
    expect(routerSrc).toMatch(/readonly\s+isPublicPath\s*:/);
    expect(routerSrc).toMatch(/export\s+function\s+createRouter\s*\(\s*opts\s*:\s*RouterOptions\s*\)/);
  });

  test("the router's dispatch applies the auth gate + CSRF guard (not the bootstrap)", () => {
    // The auth gate + CSRF guard must live in router.ts's dispatch, not in
    // index.ts. This pins that the router OWNS them (Single-Party-Owner).
    expect(routerSrc).toMatch(/authGate|isPublicPath/);
    expect(routerSrc).toMatch(/checkCsrf/);
    // index.ts must NOT define its own auth middleware or call checkCsrf.
    const indexSrc = stripCommentsOnly(readFileSync(INDEX_PATH, "utf8"));
    expect(indexSrc).not.toMatch(/function\s+authMiddleware/);
    expect(indexSrc).not.toMatch(/\bcheckCsrf\s*\(/);
  });

  test("error mapping (statusForError + errorBody) is centralized in the router", () => {
    expect(routerSrc).toMatch(/function\s+statusForError/);
    expect(routerSrc).toMatch(/function\s+errorBody/);
  });

  test("the router maps typed errors via statusCode + the code→status table (statusForCode)", () => {
    expect(routerSrc).toMatch(/statusForCode/);
  });
});

describe("Single-Party-Owner: typed-error hierarchy — ConflictError lives in errors.ts", () => {
  test("errors.ts exports ConflictError (the single owner of the 409 contract)", () => {
    const errorsSrc = stripCommentsOnly(readFileSync(ERRORS_PATH, "utf8"));
    expect(errorsSrc).toMatch(/export\s+class\s+ConflictError/);
    expect(errorsSrc).toMatch(/readonly\s+statusCode\s*=\s*409/);
  });

  test("no route file defines its own ConflictError (the typed-error owner is errors.ts)", () => {
    for (const file of listRouteFiles()) {
      const src = stripCommentsOnly(readFileSync(join(ROUTES_DIR, file), "utf8"));
      if (/class\s+ConflictError\b/.test(src)) {
        throw new Error(
          `${file} defines its own ConflictError — typed errors must live in server/errors.ts.`,
        );
      }
    }
  });
});

describe("Single-Party-Owner: every non-public route handler calls a user gate (defense-in-depth)", () => {
  // The router's auth gate protects every non-public route (the outer 401
  // gate). The per-route `requireUserContext` / `requireAdminContext` gate
  // is DEFENSE-IN-DEPTH: it gives the typed userId for scoping + survives a
  // future router regression. This test mechanically verifies every handler
  // in every non-public route file calls at least one gate, so a newly
  // added route that forgets the per-route gate is caught.
  //
  // Dynamic exempt set: a route file is exempt if it has NO
  // route registrations (a pure helper like registry.ts/views.ts) OR if
  // ALL its registered routes match a public path prefix (derived from
  // the registry's PUBLIC_PATH_PREFIXES — the single owner of public
  // paths). No hardcoded file list — a new public route file is
  // automatically exempted if its routes are public; a new non-public
  // route file is automatically checked.
  const PUBLIC_PREFIXES = PUBLIC_PATH_PREFIXES;
  const ROUTE_PATH_RE = /\brouter\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;

  function isExemptFile(fileName: string): boolean {
    const src = stripCommentsOnly(readFileSync(join(ROUTES_DIR, fileName), "utf8"));
    const routes: string[] = [];
    let m: RegExpExecArray | null;
    ROUTE_PATH_RE.lastIndex = 0;
    while ((m = ROUTE_PATH_RE.exec(src)) !== null) {
      routes.push(m[2]!);
    }
    // No route registrations → pure helper (registry.ts, views.ts).
    if (routes.length === 0) return true;
    // All routes are public → exempt (auth.ts, health.ts).
    return routes.every((p) => PUBLIC_PREFIXES.some((prefix) => p.startsWith(prefix)));
  }

  const GATE_RE = /\b(requireUserContext|requireAdminContext)\s*\(/;
  const ROUTE_REG_RE = /\brouter\.(get|post|put|patch|delete)\s*\(/g;

  test("every handler in every non-public route file calls requireUserContext / requireAdminContext / requireProjectByPath", () => {
    const offenders: string[] = [];
    for (const file of listRouteFiles()) {
      if (isExemptFile(file)) continue;
      const src = stripCommentsOnly(readFileSync(join(ROUTES_DIR, file), "utf8"));
      // Split on each `router.<method>(` registration. The chunk AFTER each
      // split point is the handler body (up to the next registration or the
      // end of the register function). The first chunk (before any route)
      // is the prefix (imports/helpers) — skip it.
      const parts = src.split(ROUTE_REG_RE);
      // split with a capturing group interleaves the method name: parts
      // = [prefix, method1, body1, method2, body2,...]. The handler bodies
      // are at odd indices 2, 4, 6,... (every 2nd element after the prefix).
      for (let i = 2; i < parts.length; i += 2) {
        const handlerBody = parts[i] ?? "";
        // A handler that does not call a gate is a defense-in-depth bypass.
        // (The body is truncated to the next `router.<method>(` naturally
        // by the split, so a gate in a LATER handler is not counted here.)
        if (!GATE_RE.test(handlerBody)) {
          offenders.push(`${file}: a router.${parts[i - 1]} handler does not call requireUserContext/requireAdminContext`);
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Route gate bypass — these handlers skip the per-route user gate (defense-in-depth):\n  ` +
          offenders.join("\n  "),
      );
    }
  });
});
