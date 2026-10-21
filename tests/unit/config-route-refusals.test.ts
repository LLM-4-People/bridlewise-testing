// @vitest-environment node
/**
 * PUT /api/config PRESERVES A DESIGNED REFUSAL'S TYPE AND STATUS.
 *
 * ── The defect (proven before the fix) ──
 * The route caught every failure and re-threw `new WebError(message, code)`.
 * `WebError` carries no `statusCode`, so the router resolved the code through
 * `CODE_STATUS_MAP`. `forbidden_config_path` — thrown by the prototype-
 * pollution guard in `setByPath` as a `ForbiddenError` (403) — was absent
 * from that map, so a payload with a `__proto__` path segment answered 500
 * and the log said `internal_error`. The guard was correct; the route threw
 * away the evidence.
 *
 * ── The rule ──
 * A typed error passes through the route untouched: the router honours its
 * class status and its taxonomy code. Only a genuinely untyped failure is
 * wrapped, with the closed `config_update_failed` code.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import { registerAllRoutes } from "../../server/routes/registry.ts";
import { isolateHarnessConfig } from "../helpers/isolated-config.ts";
import { createTestUser, type TestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { restoreConfigFileBytes } from "../../server/kernel/harness-config.ts";

const CONFIG_PATH = isolateHarnessConfig("ch-config-route-refusal-");
const SHIPPED = readFileSync(CONFIG_PATH, "utf8");

let srv: HttpTestServer;
let admin: TestUser;

beforeEach(async () => {
  srv = await startHttpTestServer({
    prefix: "ch-config-route-refusal-server-",
    register: (router, _db, adb) => registerAllRoutes(router, adb),
  });
  // The first user on a fresh DB is the admin (mirrors production setup).
  admin = createTestUser(srv.db, "admin-config-refusal");
  restoreConfigFileBytes(SHIPPED);
});

afterEach(async () => {
  restoreConfigFileBytes(SHIPPED);
  if (srv) await srv.stop();
});

function putConfig(body: unknown): ReturnType<typeof jsonRequest> {
  return jsonRequest(srv.baseUrl, "/api/config", { method: "PUT", cookie: admin.cookie, body });
}

test("a __proto__ path segment answers the designed 403, not a 500", async () => {
  const before = readFileSync(CONFIG_PATH);
  const res = await putConfig({ path: "__proto__.polluted", value: true });
  expect(res.status).toBe(403);
  expect(res.body).toMatchObject({ error: "forbidden_config_path" });
  expect(res.body).not.toMatchObject({ error: "internal_error" });
  expect(readFileSync(CONFIG_PATH), "a refused write must not touch the settings file").toEqual(before);
});

test("constructor / prototype segments keep the same typed 403", async () => {
  for (const path of ["constructor.prototype.polluted", "a.prototype.polluted"]) {
    const res = await putConfig({ path, value: true });
    expect(res.status, path).toBe(403);
    expect(res.body, path).toMatchObject({ error: "forbidden_config_path" });
  }
});

test("a sensitive key refusal still answers its own typed code", async () => {
  const res = await putConfig({ path: "runtime.providers.0.apiKey", value: "nope" });
  expect(res.status).toBe(403);
  expect(res.body).toMatchObject({ error: "sensitive_key" });
});
