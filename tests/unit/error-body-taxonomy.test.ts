// @vitest-environment node
/**
 * THE ERROR BODY AND STATUS COME FROM THE TAXONOMY-OWNED TYPED HIERARCHY.
 *
 * ── The defect (proven before the fix) ──
 * `errorBody` forwarded `err.code`/`err.message` for any Error whose `code`
 * was a string, and `statusForError` honoured any numeric `statusCode`.
 * `GET /api/editor/read` on a mode-000 file therefore answered 500 with
 * `{ error: "EACCES", message: "EACCES: permission denied, open
 * '/abs/path/to/file'" }` — a raw OS error, with the absolute path, on the
 * wire. `PUT /api/config` is the same hole from the other side: it re-wrapped
 * a typed 403 into a status-less `WebError`, and because
 * `forbidden_config_path` was absent from `CODE_STATUS_MAP` the designed
 * refusal became a 500.
 *
 * ── The rule ──
 * A status and a sentence may only be chosen by an error of the shared typed
 * hierarchy whose code the shared taxonomy declares. Everything else is the
 * fixed `internal_error` body; the operator still gets the real error through
 * the central log at the catch site. A zod body failure is the one
 * router-constructed exception: its path/message names the caller's field,
 * never a raw value.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerAllRoutes } from "../../server/routes/registry.ts";
import { isolateHarnessConfig } from "../helpers/isolated-config.ts";
import { createTestUser, type TestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { ForbiddenError, WebError } from "../../server/kernel/errors.ts";

isolateHarnessConfig("ch-error-body-config-");

let srv: HttpTestServer;
let user: TestUser;
let projectPath: string;
let unreadableFile: string;

/** The fixed body: no code, no message, nothing an error carried. */
const FIXED_BODY = { error: "internal_error", message: "Internal error. See the local log for details." };

beforeAll(async () => {
  srv = await startHttpTestServer({
    prefix: "ch-error-body-",
    register: (router, db, adb) => {
      registerAllRoutes(router, adb);
      // A raw OS-shaped error: Node's own `EACCES` carries the code and an
      // absolute path, and a foreign client may attach a numeric status.
      router.get("/api/test/raw-os-error", () => {
        const err = new Error(`EACCES: permission denied, open '${unreadableFile}'`) as Error & { code: string; statusCode: number };
        err.code = "EACCES";
        err.statusCode = 418;
        throw err;
      });
      // A typed error whose code the taxonomy does not declare: still a
      // programmer defect, never a wire contract.
      router.get("/api/test/unknown-typed-code", () => {
        throw new WebError(`EACCES: permission denied, open '${unreadableFile}'`, "zz_not_a_taxonomy_code");
      });
      // A typed error the taxonomy DOES declare: its code and sentence are
      // the contract and must survive.
      router.get("/api/test/declared-typed-error", () => {
        throw new ForbiddenError("this refusal is the contract", "forbidden_config_path");
      });
    },
  });
  user = createTestUser(srv.db, "error-body-user");
  projectPath = join(srv.tmpRoot, "project");
  mkdirSync(projectPath, { recursive: true });
  unreadableFile = join(projectPath, "unreadable.ts");
  writeFileSync(unreadableFile, "export const secret = 1;\n", { mode: 0o600 });
  chmodSync(unreadableFile, 0o000);
  srv.db.createProject({ name: "error-body-project", path: projectPath }, user.userId);
});

afterAll(async () => {
  // A mode-000 file cannot be re-read by the cleanup sweep; restore it first.
  try { chmodSync(unreadableFile, 0o600); } catch { /* the temp owner removes the tree */ }
  if (srv) await srv.stop();
});

function get(path: string): ReturnType<typeof jsonRequest> {
  return jsonRequest(srv.baseUrl, path, { cookie: user.cookie });
}

describe("a raw OS error never reaches the wire", () => {
  test("GET /api/editor/read on a mode-000 file answers the fixed body, with no errno and no path", async () => {
    const res = await get(`/api/editor/read?path=${encodeURIComponent(unreadableFile)}&root=${encodeURIComponent(projectPath)}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual(FIXED_BODY);
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain("EACCES");
    expect(wire).not.toContain(unreadableFile);
    expect(wire).not.toContain("permission denied");
  });

  test("a non-hierarchy Error carrying a numeric statusCode cannot choose the response", async () => {
    const res = await get("/api/test/raw-os-error");
    expect(res.status).toBe(500);
    expect(res.body).toEqual(FIXED_BODY);
    expect(JSON.stringify(res.body)).not.toContain("EACCES");
  });

  test("a typed error whose code the taxonomy does not declare is the fixed body, not that code", async () => {
    const res = await get("/api/test/unknown-typed-code");
    expect(res.status).toBe(500);
    expect(res.body).toEqual(FIXED_BODY);
  });
});

describe("the taxonomy-owned typed contract still travels", () => {
  test("a declared typed code forwards its code, its authored sentence and its status", async () => {
    const res = await get("/api/test/declared-typed-error");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden_config_path", message: "this refusal is the contract" });
  });

  test("the existing 404 contract for a missing editor file is unchanged", async () => {
    const missing = join(projectPath, "not-there.ts");
    const res = await get(`/api/editor/read?path=${encodeURIComponent(missing)}&root=${encodeURIComponent(projectPath)}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "file_not_found" });
  });
});
