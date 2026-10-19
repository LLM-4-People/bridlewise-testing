/**
 * Shared HTTP test-server lifecycle helper.
 *
 * 14+ integration tests (every `tests/unit/*-routes.test.ts` +
 * `tests/prevention/*-http.test.ts` + `auth-owner.test.ts`) spin up the
 * SAME real HTTP server backed by a fresh file-based SQLite DB: mkdtemp
 * → DbClient → createRouter → register routes → createServer → listen
 * on an ephemeral port → afterAll close server + db + rm tmpRoot. That
 * 12-line setup + 6-line teardown was copied verbatim into every file
 * (with only the `prefix` string + the `register(router, db)` callback
 * varying). The copies had already drifted: some used `() => true` for
 * `isPublicPath`, some imported the real `isPublicPath`; some passed
 * `keyPath`/`crypto`; some computed the port two different ways.
 *
 * This module is the single owner of that lifecycle: every test calls
 * `startHttpTestServer({ register, prefix })` and gets back
 * `{ server, baseUrl, db, tmpRoot, stop }`. The `stop()` closes the
 * server + DB + removes the tmpRoot (best effort — never throws on
 * cleanup). A fix to the lifecycle (port handling, cleanup ordering,
 * isPublicPath wiring) fixes every consumer, and a new test gets a
 * tested helper instead of a fresh copy.
 *
 * The `register` callback is the per-test variance (which routes to
 * mount). The DB is created BEFORE `register` is called so the test can
 * `createTestUser(db, ...)` inside or outside `register`. The router
 * uses the real `isPublicPath` from the route registry by default so
 * the auth gate mirrors production; a test that wants every path public
 * (e.g. a router-only unit test) passes `isPublicPath: () => true`.
 */
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { createTempDir } from "./temp-dir.ts";
import { createRouter, type Router, type RouterOptions } from "../../server/router/router.ts";
import { isPublicPath } from "../../server/routes/registry.ts";
import { DbClient, type DbClientConfig } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { readConfigRaw } from "../../server/kernel/harness-config.ts";
import { serverConfig } from "../../server/kernel/config.ts";
import { installCustomizationConfigStore } from "../../server/kernel/canonical.ts";
import { hasCustomizationConfigStore } from "../../engine/src/shared/exposure/index.ts";

/** A live HTTP test server + its backing DB + tmpdir. Call `stop()` in `afterAll`. */
export interface HttpTestServer {
  /** The live node HTTP server (ephemeral port). */
  readonly server: Server;
  /** The base URL (`http://127.0.0.1:<port>`) to send requests to. */
  readonly baseUrl: string;
  /** The fresh file-based SQLite DB backing the router. */
  readonly db: DbClient;
  /** The async facade over THAT SAME client. Inline, so the test server has
   * exactly one connection and one writer — the same property the production
   * process holds while the call-site migration is in flight. */
  readonly adb: AsyncDbClient;
  /** The tmpdir holding the DB file (removed by `stop()`). */
  readonly tmpRoot: string;
  /** Tear down: close the server + DB + remove the tmpRoot (best effort). */
  stop(): Promise<void>;
}

/** Optional overrides for the test server. Defaults mirror production. */
export interface StartHttpTestServerOptions {
  /** The tmpdir prefix (defaults to `ch-http-test-`). */
  prefix?: string;
  /** Mount routes on the router. The DB is created before this is called
   * so the callback can seed users / projects directly. */
  register: (router: Router, db: DbClient, adb: AsyncDbClient) => void;
  /** The public-path predicate (defaults to the real `isPublicPath` so the
   * auth gate mirrors production). Pass `() => true` for router-only tests. */
  isPublicPath?: RouterOptions["isPublicPath"];
  /** Extra DbClient config (e.g. `crypto`, `keyPath`) for tests that need
   * encryption-at-rest or a custom schema version. `path` is set by the
   * helper. */
  dbConfig?: Omit<DbClientConfig, "path">;
}

/**
 * Start a real HTTP server on an ephemeral port backed by a fresh
 * file-based SQLite DB. The router is created with the real `isPublicPath`
 * (unless overridden) and the `register` callback mounts the routes. The
 * returned `stop()` tears everything down — call it in `afterAll`.
 *
 * Usage:
 * ```ts
 * let srv: HttpTestServer;
 * beforeAll(async () => {
 *   srv = await startHttpTestServer({
 *     prefix: "ch-routes-",
 *     register: (router, db, adb) => {
 *       registerProjectRoutes(router, adb);
 *       registerChatRoutes(router, db);
 *     },
 *   });
 *   authCookie = createTestUser(srv.db, "tester").cookie;
 * });
 * afterAll(() => srv.stop());
 * ```
 */
export async function startHttpTestServer(
  opts: StartHttpTestServerOptions,
): Promise<HttpTestServer> {
  const prefix = opts.prefix ?? "ch-http-test-";
  // Customization writes through the route surface land wherever the installed
  // config store points. With no store installed, `registerAllExposure` falls
  // back to the engine's file-backed store and a test POSTing
  // `settings.customizations/set` writes the real `bridlewise.config.json` —
  // measured: a round-trip to a declared default omitted the key and the
  // source-tree-immutability guard caught the file drifted at teardown. A test
  // server is never the host that persists real config, so install an
  // in-memory store (seeded from the real config, so reads mirror production)
  // unless the test file already installed its own.
  if (!hasCustomizationConfigStore()) {
    let doc: Record<string, unknown> = readConfigRaw();
    installCustomizationConfigStore({
      // The real config path: this fake mirrors the real store's shape, and
      // the write lock keyed on it stays vacuous here (nothing writes the
      // file) — the declaration exists so the store contract cannot lie
      // about which file a host persists to.
      configFilePath: serverConfig.harnessConfigPath,
      readDocument: () => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
      writeDocument: (next) => {
        doc = next;
      },
    });
  }
  // The temp dir belongs to the single owner (tests/helpers/temp-dir.ts), which
  // registered its removal in this same call. `stop()` therefore closes the
  // server + DB but no longer unlinks the directory — one owner, one remover.
  const tmpRoot = createTempDir(prefix);
  const dbPath = join(tmpRoot, "web.db");
  const db = new DbClient({ path: dbPath, ...opts.dbConfig });
  const adb = AsyncDbClient.inline(db);
  const router = createRouter({
    db: adb,
    isPublicPath: opts.isPublicPath ?? isPublicPath,
  });
  opts.register(router, db, adb);
  const server = createServer((req, res) => router.dispatch(req, res));
  let baseUrl = "";
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  return {
    server,
    baseUrl,
    db,
    adb,
    tmpRoot,
    async stop() {
      if (server) await new Promise<void>((r) => server.close(() => r()));
      if (db) db.close();
      // tmpRoot is removed by the temp-dir owner, not here.
    },
  };
}
