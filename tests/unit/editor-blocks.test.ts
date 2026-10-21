// @vitest-environment node
/**
 * The edit tool's block surface, driven end-to-end over real HTTP.
 *
 * The model-facing `edit` tool stays a tool; these blocks are the read/action
 * surface around it — a preview (resolve the string preimage + compute the
 * postimage WITHOUT writing) and the rollback verb. These tests prove the
 * block contract on the real path:
 *
 *   1. The routes are mounted by the block registry (no hand-wired route).
 *   2. An unauthenticated call is refused by the router's auth gate.
 *   3. A preview resolves a preimage and reports the postimage hash while
 *      leaving the file byte-for-byte unchanged.
 *   4. A refused preview (absent preimage) returns a structured reason, not a
 *      stack trace, and writes nothing.
 *   5. Rollback honestly reports "nothing to restore" when no snapshot exists.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { registerProjectRoutes } from "../../server/routes/projects.ts";
import { registerAuthRoutes } from "../../server/routes/auth.ts";
import { defineEditorBlocks } from "../../server/blocks/editor.ts";
import { mountBlockRoutes } from "../../server/blocks/define.ts";
import { createTestUser, type TestUser } from "../helpers/multi-user.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { registerAllExposure } from "../../server/kernel/canonical.ts";

let srv: HttpTestServer;
let user: TestUser;
let projectRoot: string;

async function call(userOrNull: TestUser | null, path: string, init?: { method?: string; body?: unknown }) {
  const { status, body } = await jsonRequest(srv.baseUrl, path, {
    method: init?.method,
    body: init?.body,
    cookie: userOrNull === null ? null : userOrNull.cookie,
  });
  return { status, body } as { status: number; body: { data?: Record<string, unknown> } };
}

beforeAll(async () => {
  registerAllExposure();
  projectRoot = createTempDir("ch-editor-block-");
  writeFileSync(join(projectRoot, "code.ts"), "export const a = 1;\n");
  srv = await startHttpTestServer({
    prefix: "ch-editor-block-srv-",
    register: (router, db, adb) => {
      registerAuthRoutes(router, adb);
      registerProjectRoutes(router, adb);
      defineEditorBlocks(adb);
      mountBlockRoutes(router);
    },
  });
  user = createTestUser(srv.db, "editor-user");
  // Register the on-disk project so the fs-gate owns it for this user.
  const r = await call(user, "/api/projects", { method: "POST", body: { name: "editor-proj", path: projectRoot } });
  expect(r.status).toBe(201);
});

afterAll(async () => {
  if (srv) await srv.stop();
});

describe("editor blocks over real HTTP", () => {
  test("the block routes are mounted (the read answers, not a 404)", async () => {
    const res = await call(user, "/api/b/editor.history");
    expect(res.status, "the editor.history read must be mounted by the block registry").toBe(200);
  });

  test("an unauthenticated read is refused by the router auth gate", async () => {
    const res = await call(null, "/api/b/editor.history");
    expect(res.status).toBe(401);
  });

  test("an unauthenticated action is refused", async () => {
    const res = await call(null, "/api/b/editor.preview/preview", { method: "POST", body: { path: projectRoot, file: "code.ts", oldString: "a = 1", newString: "a = 2" } });
    expect(res.status).toBe(401);
  });

  test("preview resolves a preimage and reports the postimage hash WITHOUT writing", async () => {
    const before = readFileSync(join(projectRoot, "code.ts"), "utf8");
    const res = await call(user, "/api/b/editor.preview/preview", {
      method: "POST",
      body: { path: projectRoot, file: "code.ts", oldString: "a = 1", newString: "a = 2" },
    });
    expect(res.status).toBe(200);
    const data = res.body.data!;
    expect(data.ok).toBe(true);
    expect(data.strategy).toBe("exact");
    expect(typeof data.expectedPostimageHash).toBe("string");
    // The whole point of a preview: the file is untouched.
    expect(readFileSync(join(projectRoot, "code.ts"), "utf8")).toBe(before);
  });

  test("a preview with an absent preimage returns a structured refusal and writes nothing", async () => {
    const before = readFileSync(join(projectRoot, "code.ts"), "utf8");
    const res = await call(user, "/api/b/editor.preview/preview", {
      method: "POST",
      body: { path: projectRoot, file: "code.ts", oldString: "text that is not present", newString: "x" },
    });
    expect(res.status).toBe(200);
    const data = res.body.data!;
    expect(data.ok).toBe(false);
    expect(data.reason).toBe("old_content_not_found");
    expect(typeof data.detail).toBe("string");
    expect(readFileSync(join(projectRoot, "code.ts"), "utf8")).toBe(before);
  });

  test("a preview of a file the caller does not own is refused by the fs-gate", async () => {
    const res = await call(user, "/api/b/editor.preview/preview", {
      method: "POST",
      body: { path: "/tmp/not-owned-by-this-user", file: "x.ts", oldString: "<all>", newString: "y" },
    });
    // The fs-gate denies the un-owned path; the router maps the refusal.
    expect([400, 403, 404]).toContain(res.status);
  });

  test("a preview of a path outside the project is refused as a traversal, never laundered into file_not_found", async () => {
    const res = await call(user, "/api/b/editor.preview/preview", {
      method: "POST",
      body: { path: projectRoot, file: "../../etc/passwd", oldString: "root", newString: "x" },
    });
    // A traversal is an access refusal, not a missing file. The old catch-all
    // absorbed PathTraversalError and answered 200 reason=file_not_found.
    expect(res.status).toBe(403);
  });

  test("a preview of a directory is refused as not-a-file, never laundered into file_not_found", async () => {
    mkdirSync(join(projectRoot, "folder"));
    const res = await call(user, "/api/b/editor.preview/preview", {
      method: "POST",
      body: { path: projectRoot, file: "folder", oldString: "x", newString: "y" },
    });
    // A directory inside the project is not a missing file: the typed
    // not_a_file refusal must reach the router.
    expect(res.status).toBe(400);
  });

  test("a missing file still answers the structured file_not_found preview", async () => {
    const res = await call(user, "/api/b/editor.preview/preview", {
      method: "POST",
      body: { path: projectRoot, file: "absent.ts", oldString: "x", newString: "y" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data!.ok).toBe(false);
    expect(res.body.data!.reason).toBe("file_not_found");
  });

  test("rollback with no retained snapshot honestly reports nothing restored", async () => {
    const res = await call(user, "/api/b/editor.preview/rollback", { method: "POST", body: {} });
    expect(res.status).toBe(200);
    const data = res.body.data!;
    expect(data.rolledBack).toBe(false);
    expect(typeof data.reason).toBe("string");
  });
});
