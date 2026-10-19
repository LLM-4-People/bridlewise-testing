// @vitest-environment node
/**
 * ADVERSARIAL integration tests for POST /api/auth/change-password.
 *
 * Spins up a real HTTP server backed by a fresh file-based SQLite DB +
 * registerAuthRoutes, then exercises the full change-password flow:
 * success (correct current + valid new + session → password rotated;
 * old fails login, new works)
 * wrong current password → 401
 * no session cookie → 401 (defense-in-depth, even with correct current)
 * new === current → rejection (no silent no-op)
 * new too short (< 8) → 400 (zod validation — the router-level ZodError→400 fix)
 * no password set → 401 (auth_not_setup)
 *
 * hard, realistic, no faking — real scrypt (async), real DB,
 * real session cookies. Escalates: the defense-in-depth session check, the
 * no-op rejection, and the post-rotation login proof.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { createRouter } from "../../server/router/router.ts";
import { isPublicPath } from "../../server/routes/registry.ts";
import { registerAuthRoutes } from "../../server/routes/auth.ts";
import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { runMigrations } from "../../server/db/migrations.ts";
import { SCHEMA_VERSION_LATEST } from "../../server/db/schema.ts";
import { createNoopDbCrypto } from "../../server/db/db-crypto.ts";
import { DatabaseSync } from "node:sqlite";
import { createTempDir } from "../helpers/temp-dir.ts";

let tmpRoot = "";
let server: Server;
let baseUrl: string;
let db: DbClient;

beforeAll(async () => {
  tmpRoot = createTempDir("ch-changepw-");
  db = new DbClient({ path: join(tmpRoot, "web.db") });
  runMigrations(db["db" as keyof DbClient] as unknown as DatabaseSync, SCHEMA_VERSION_LATEST, createNoopDbCrypto());

  const adb = AsyncDbClient.inline(db);
  const router = createRouter({ db: adb, isPublicPath });
  registerAuthRoutes(router, adb);
  server = createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (db) db.close();
});

async function req(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string | null } = {},
): Promise<{ status: number; body: unknown; setCookie: string | null }> {
  const headers: Record<string, string> = { "X-Requested-With": "test" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.cookie !== undefined && init.cookie !== null) headers["Cookie"] = init.cookie;
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : null,
  });
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  let body: unknown = undefined;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body, setCookie };
}

/** Extract the harness_auth cookie value from a Set-Cookie header. */
function authCookieFrom(setCookie: string | null): string | null {
  if (setCookie === null) return null;
  const m = setCookie.match(/harness_auth=([^;]+)/);
  return m ? `harness_auth=${m[1]}` : null;
}

const OLD_PW = "old-password-1";
const NEW_PW = "new-password-2";
const USERNAME = "admin";

describe("POST /api/auth/change-password", () => {
  let sessionCookie: string | null = null;

  beforeAll(async () => {
    // v12: register a user (the first becomes the admin) via the register
    // route, which auto-logs-in and issues a session cookie. This avoids
    // coupling the change-password tests to the legacy single-password setup.
    const reg = await req("/api/auth/register", { method: "POST", body: { username: USERNAME, password: OLD_PW } });
    expect(reg.status).toBe(200);
    sessionCookie = authCookieFrom(reg.setCookie);
    expect(sessionCookie).not.toBeNull();
  });

  test("success: correct current + valid new + session → 200; the password is rotated", async () => {
    const r = await req("/api/auth/change-password", {
      method: "POST",
      body: { currentPassword: OLD_PW, newPassword: NEW_PW },
      cookie: sessionCookie,
    });
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);

    // Proof the rotation took effect: the OLD password no longer logs in.
    const oldLogin = await req("/api/auth/login", { method: "POST", body: { username: USERNAME, password: OLD_PW } });
    expect(oldLogin.status).toBe(401);
    // The NEW password logs in.
    const newLogin = await req("/api/auth/login", { method: "POST", body: { username: USERNAME, password: NEW_PW } });
    expect(newLogin.status).toBe(200);
    // Refresh the session cookie for the subsequent tests (the new login
    // issued a fresh session).
    sessionCookie = authCookieFrom(newLogin.setCookie) ?? sessionCookie;
  });

  test("wrong current password → 401 (typed auth_current_password_invalid)", async () => {
    const r = await req("/api/auth/change-password", {
      method: "POST",
      body: { currentPassword: "totally-wrong", newPassword: "another-new-3" },
      cookie: sessionCookie,
    });
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe("auth_current_password_invalid");
    // The password must NOT have changed (NEW_PW still logs in).
    const stillWorks = await req("/api/auth/login", { method: "POST", body: { username: USERNAME, password: NEW_PW } });
    expect(stillWorks.status).toBe(200);
  });

  test("no session cookie → 401 even with the correct current password (defense-in-depth)", async () => {
    const r = await req("/api/auth/change-password", {
      method: "POST",
      body: { currentPassword: NEW_PW, newPassword: "yet-another-4" },
      cookie: null,
    });
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe("auth_change_password_no_session");
  });

  test("new === current → rejection (no silent no-op rotation)", async () => {
    const r = await req("/api/auth/change-password", {
      method: "POST",
      body: { currentPassword: NEW_PW, newPassword: NEW_PW },
      cookie: sessionCookie,
    });
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe("auth_password_unchanged");
  });

  test("new password too short (< 8) → 400 validation_failed (router ZodError→400 fix)", async () => {
    const r = await req("/api/auth/change-password", {
      method: "POST",
      body: { currentPassword: NEW_PW, newPassword: "short" },
      cookie: sessionCookie,
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("validation_failed");
  });

  test("missing currentPassword field → 400 validation_failed", async () => {
    const r = await req("/api/auth/change-password", {
      method: "POST",
      body: { newPassword: "valid-new-pw-5" },
      cookie: sessionCookie,
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("validation_failed");
  });
});

describe("POST /api/auth/change-password — no users registered (setup mode)", () => {
  test("returns 401 when no users have been registered", async () => {
    // A fresh DB with no password. (Isolated from the seeded DB above via a
    // throwaway router+server bound to a separate in-memory DB.)
    const db2 = new DbClient({ path: join(tmpRoot, "nopw.db") });
    runMigrations(db2["db" as keyof DbClient] as unknown as DatabaseSync, SCHEMA_VERSION_LATEST, createNoopDbCrypto());
    const adb2 = AsyncDbClient.inline(db2);
    const router2 = createRouter({ db: adb2, isPublicPath });
    registerAuthRoutes(router2, adb2);
    const srv = createServer((req, res) => router2.dispatch(req, res));
    await new Promise<void>((resolve) => {
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
    const r = await req("/api/auth/change-password", {
      method: "POST",
      body: { currentPassword: "anything-here", newPassword: "valid-new-pw-6" },
    });
    expect(r.status).toBe(401);
    // v12: with no users + no session, the route rejects with the no-session
    // error (the change-password identity gate).
    expect((r.body as { error: string }).error).toBe("auth_change_password_no_session");
    await new Promise<void>((res) => srv.close(() => res()));
    db2.close();
  });
});
