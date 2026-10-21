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
import { ForbiddenError, BadRequestError, ProjectPathError, ServiceUnavailableError, WebError } from "../../server/kernel/errors.ts";

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
      // A DECLARED code whose throw site interpolates runtime detail. The
      // code is in the taxonomy; the sentence is not authored, so the
      // taxonomy's fixed sentence must replace it on the wire.
      router.get("/api/test/declared-runtime-sentence", () => {
        throw new ProjectPathError(
          `Project path is not accessible: ${projectPath} (EACCES: permission denied, stat '${projectPath}')`,
          "project_path_inaccessible",
        );
      });
      // A typed error whose CODE is not declared, but whose CLASS declares a
      // status: the status is still the class's answer. The body is not.
      router.get("/api/test/typed-status-unmapped-code", () => {
        throw new ServiceUnavailableError(
          `a typed refusal whose message names ${unreadableFile}`,
          "zz_unmapped_service_unavailable",
        );
      });
      // The client-error half of the same separation: a 400 class keeps its
      // 400 even when the code has not been taught to the taxonomy yet.
      router.get("/api/test/typed-400-unmapped-code", () => {
        throw new BadRequestError(
          `a typed refusal whose message names ${unreadableFile}`,
          "zz_unmapped_bad_request",
        );
      });
      // THE PREFIX CONVENTION IS NOT A WIRE CONTRACT. `isKnownErrorCode`
      // admits any `invalid_`/`missing_` code (the input-validation naming
      // convention), but only a DECLARED code may forward its spelling and
      // its sentence. A code built from an absolute path is neither.
      router.get("/api/test/prefixed-invalid-code", () => {
        throw new ServiceUnavailableError(
          `a typed refusal whose message names ${unreadableFile}`,
          `invalid_${unreadableFile}`,
        );
      });
      router.get("/api/test/prefixed-missing-code", () => {
        throw new BadRequestError(
          `a typed refusal whose message names ${unreadableFile}`,
          `missing_${unreadableFile}`,
        );
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

describe("status and body are separate decisions for a typed error", () => {
  test("an unmapped code cannot erase a 503 class status, but its sentence stays off the wire", async () => {
    const res = await get("/api/test/typed-status-unmapped-code");
    expect(res.status, "the class owns the status, independent of the code table").toBe(503);
    expect(res.body).toEqual(FIXED_BODY);
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain(unreadableFile);
    expect(wire).not.toContain("zz_unmapped_service_unavailable");
  });

  test("the same separation keeps a typed 400 a 400", async () => {
    const res = await get("/api/test/typed-400-unmapped-code");
    expect(res.status).toBe(400);
    expect(res.body).toEqual(FIXED_BODY);
    expect(JSON.stringify(res.body)).not.toContain(unreadableFile);
  });
});

describe("the input-validation PREFIX is a status convention, not a wire code", () => {
  // `invalid_`/`missing_` are admitted by the taxonomy so a new guard gets
  // the right STATUS without a map entry. They are not declared codes, so
  // the router must not repeat one on the wire — especially when the suffix
  // is an absolute path. The body gets a fixed declared code and an authored
  // sentence; the class still chooses the status.
  test("a 503 class keeps its status; an invalid_<path> code and sentence stay off the wire", async () => {
    const res = await get("/api/test/prefixed-invalid-code");
    expect(res.status, "the class owns the status").toBe(503);
    expect(res.body).toEqual({
      error: "validation_failed",
      message: "The request did not pass validation.",
    });
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain(unreadableFile);
    expect(wire).not.toContain("invalid_");
  });

  test("a 400 class keeps its status; a missing_<path> code and sentence stay off the wire", async () => {
    const res = await get("/api/test/prefixed-missing-code");
    expect(res.status, "the class owns the status").toBe(400);
    expect(res.body).toEqual({
      error: "bad_request",
      message: "The request is missing a required value.",
    });
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain(unreadableFile);
    expect(wire).not.toContain("missing_");
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

  test("a recycle entry that is gone answers 404 — the status its code declares, not the class's 400", async () => {
    // THE DEFECT THIS PINS: `recycle_not_found` is mapped 404 in the one
    // taxonomy, but POST /api/editor/restore threw `BadRequestError`, whose
    // class status is 400 and wins in the router. The class and the map are
    // one owner of the status; the wire must answer the map's 404.
    const res = await jsonRequest(srv.baseUrl, "/api/editor/restore", {
      method: "POST",
      body: { id: "00000000-0000-4000-8000-000000000000" },
      cookie: user.cookie,
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "recycle_not_found", message: "That recycle entry is gone" });
  });
});

// ── a declared code is a vocabulary, not an authored sentence ───────────
//
// `isDeclaredErrorCode` proves the code belongs to the taxonomy. It does not
// prove the message beside it is safe: `project_path_inaccessible`
// interpolated `err.message` (EACCES + `stat '/abs/path'`) and
// `file_not_found` interpolated the resolved absolute path. Both reached the
// wire because the code was declared. The taxonomy now owns a fixed sentence
// for these codes, and the throw-site detail goes to the log.
describe("a declared code whose throw site carries runtime detail answers a fixed sentence", () => {
  test("project_path_inaccessible carries no errno and no absolute path", async () => {
    const res = await get("/api/test/declared-runtime-sentence");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "project_path_inaccessible",
      message: "The project folder is not accessible. Check its permissions and re-create the project.",
    });
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain("EACCES");
    expect(wire).not.toContain("permission denied");
    expect(wire).not.toContain("stat");
    expect(wire).not.toContain(projectPath);
  });

  test("GET /api/intelligence/map on an inaccessible project answers the fixed sentence", async () => {
    const lockedParent = join(srv.tmpRoot, "locked-parent");
    const lockedProject = join(lockedParent, "project");
    mkdirSync(lockedProject, { recursive: true });
    srv.db.createProject({ name: "locked-project", path: lockedProject }, user.userId);
    chmodSync(lockedParent, 0o000);
    try {
      const res = await get(`/api/intelligence/map?path=${encodeURIComponent(lockedProject)}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: "project_path_inaccessible",
        message: "The project folder is not accessible. Check its permissions and re-create the project.",
      });
      const wire = JSON.stringify(res.body);
      expect(wire).not.toContain("EACCES");
      expect(wire).not.toContain("permission denied");
      expect(wire).not.toContain(lockedProject);
    } finally {
      chmodSync(lockedParent, 0o755);
    }
  });

  test("a missing editor file names the fixed sentence, never the absolute path", async () => {
    const missing = join(projectPath, "not-there.ts");
    const res = await get(`/api/editor/read?path=${encodeURIComponent(missing)}&root=${encodeURIComponent(projectPath)}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "file_not_found",
      message: "That file no longer exists. It may have been moved or deleted.",
    });
    expect(JSON.stringify(res.body)).not.toContain(projectPath);
  });
});
