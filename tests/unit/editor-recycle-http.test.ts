// @vitest-environment node
/**
 * THE FILE RECYCLE BIN AT ITS AUTHORIZATION CHOKE POINT — over the real router.
 *
 * Round-5 findings (all three reproduced through real HTTP + the real bridge):
 *
 *  1. A recycle entry carried neither the deleting user nor the project row
 *     that produced it, so the listing filtered by project PATH and restore
 *     rebuilt its gate from the record's own `projectRoot`. Two users can
 *     register one path (creation answered 201), so user B could list user
 *     A's deleted file and restore A's bytes. The fix stamps the acting user
 *     and the project row id at delete, filters the listing by both, asserts
 *     both in `restoreFile`, and refuses a project path another user already
 *     registered.
 *
 *  2. A file recycled from the caller's own TRASHED project was listed (the
 *     listing includes trashed rows) but restore answered 403 "not owned"
 *     because the gate was built by path through a probe that hides trashed
 *     rows. The owner's restore must resolve through one trashed-inclusive
 *     row probe.
 *
 * Every assertion here is a real request against a real server, a real DB and
 * the real filesystem bridge; the "another user already holds this path" row
 * is written directly through the DB to model an install that carries one
 * from before the create door refused it.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The recycle bin's location derives from `serverConfig.dbPath`, and the
// timeline ledger from its own config path — both are pointed at a private
// temp root BEFORE any server module resolves the configuration. A test
// that recycled into the checkout's `.bridlewise/` would write inside the
// safety floor.
await vi.hoisted(async () => {
  const { createTempDir } = await import("../helpers/temp-dir.ts");
  const { join: joinPath } = await import("node:path");
  const { readFileSync: read } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = createTempDir("ch-editor-recycle-root-");
  process.env["HARNESS_WEB_PROJECT_ROOT"] = root;
  process.env["HARNESS_WEB_DB_PATH"] = joinPath(root, "web.db");
  process.env["HARNESS_WEB_TIMELINE_DB_PATH"] = joinPath(root, "timeline.db");
  const realConfig = fileURLToPath(new URL("../../engine/bridlewise.config.json", import.meta.url));
  const configPath = joinPath(root, "bridlewise.config.json");
  const { atomicWriteFile } = await import("../../engine/src/filesystem/atomic-write.ts");
  const written = atomicWriteFile(configPath, read(realConfig, "utf8"), { createMode: 0o600 });
  if (!written.success) throw new Error("the test config copy could not be written");
  process.env["HARNESS_CONFIG_PATH"] = configPath;
});

import { registerEditorRoutes } from "../../server/routes/editor.ts";
import { registerProjectRoutes } from "../../server/routes/projects.ts";
import { createTestUser, type TestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

let srv: HttpTestServer;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  srv = await startHttpTestServer({
    prefix: "ch-editor-recycle-",
    register: (router, _db, adb) => {
      registerProjectRoutes(router, adb);
      registerEditorRoutes(router, adb);
    },
  });
  alice = createTestUser(srv.db, "alice-recycle");
  bob = createTestUser(srv.db, "bob-recycle");
});

afterAll(async () => {
  if (srv) await srv.stop();
});

async function call(
  user: TestUser,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: { files?: { id: string }[]; error?: string; recycleId?: string } }> {
  const { status, body } = await jsonRequest(srv.baseUrl, path, {
    method: init?.method,
    body: init?.body,
    cookie: user.cookie,
  });
  return { status, body: body as { files?: { id: string }[]; error?: string; recycleId?: string } };
}

/** Create a project through the real door and answer its id. */
async function newProject(user: TestUser, name: string, path: string): Promise<string> {
  mkdirSync(path, { recursive: true });
  const res = await call(user, "/api/projects", { method: "POST", body: { name, path } });
  expect(res.status, "the project must be created through the real route").toBe(201);
  return (res.body as unknown as { id: string }).id;
}

/** Create + delete one file through the real editor routes; answer the recycle id. */
async function recycleOne(user: TestUser, root: string, file: string, content: string): Promise<string> {
  const created = await call(user, "/api/editor/create-file", {
    method: "POST",
    body: { path: file, content, root },
  });
  expect(created.status).toBe(200);
  const deleted = await call(user, "/api/editor/delete", {
    method: "DELETE",
    body: { path: file, root },
  });
  expect(deleted.status).toBe(200);
  return deleted.body.recycleId!;
}

describe("recycle-bin authorization over real HTTP", () => {
  test("the listing is scoped by the deleting user and project row, not by path", async () => {
    const alicePath = join(createTempDir("ch-recycle-alice-"), "project");
    await newProject(alice, "alice-project", alicePath);
    const recycleId = await recycleOne(alice, alicePath, "alice-secret.ts", "alice-secret\n");

    // THE PRE-FIX STATE: another user holds a project row at the same path.
    // The create door now refuses this (the next test), so the row is written
    // directly — an install upgraded from before that refusal still has one.
    srv.db.createProject({ name: "bob-duplicate", path: alicePath }, bob.userId);

    const listed = await call(bob, "/api/editor/recycle");
    expect(listed.status).toBe(200);
    expect(
      (listed.body.files ?? []).map((f) => f.id),
      "another user's recycle entry must not be listed, even at a path this user also registered",
    ).not.toContain(recycleId);

    // The owner still sees it.
    const ownerList = await call(alice, "/api/editor/recycle");
    expect((ownerList.body.files ?? []).map((f) => f.id)).toContain(recycleId);
    const ownerRestore = await call(alice, "/api/editor/restore", { method: "POST", body: { id: recycleId } });
    expect(ownerRestore.status).toBe(200);
    expect(readFileSync(join(alicePath, "alice-secret.ts"), "utf8")).toBe("alice-secret\n");
  });

  test("restore is scoped by the deleting user and project row, not by path", async () => {
    const alicePath = join(createTempDir("ch-recycle-restore-"), "project");
    await newProject(alice, "alice-restore", alicePath);
    const recycleId = await recycleOne(alice, alicePath, "alice-secret.ts", "alice-secret\n");
    srv.db.createProject({ name: "bob-duplicate-restore", path: alicePath }, bob.userId);

    const restored = await call(bob, "/api/editor/restore", { method: "POST", body: { id: recycleId } });
    expect(restored.status, "another user's recycle entry must not be restorable").toBe(404);
    expect(
      existsSync(join(alicePath, "alice-secret.ts")),
      "B's restore attempt must leave A's deleted bytes deleted",
    ).toBe(false);

    // The owner's own restore still puts the bytes back.
    const ownerRestore = await call(alice, "/api/editor/restore", { method: "POST", body: { id: recycleId } });
    expect(ownerRestore.status).toBe(200);
    expect(readFileSync(join(alicePath, "alice-secret.ts"), "utf8")).toBe("alice-secret\n");
  });

  test("a project path another user already registered is refused at the create door (409)", async () => {
    const sharedPath = join(createTempDir("ch-recycle-shared-"), "project");
    await newProject(alice, "alice-shared", sharedPath);
    const bobCreate = await call(bob, "/api/projects", {
      method: "POST",
      body: { name: "bob-shared", path: sharedPath },
    });
    expect(bobCreate.status, "a second user cannot register a project at an owned path").toBe(409);
    expect(bobCreate.body.error).toBe("project_path_taken");
    // Alice's registration is untouched and still visible only to her.
    const aliceList = await call(alice, "/api/projects");
    expect((aliceList.body as unknown as { path: string }[]).some((p) => p.path === sharedPath)).toBe(true);
    const bobList = await call(bob, "/api/projects");
    expect((bobList.body as unknown as { path: string }[]).some((p) => p.path === sharedPath)).toBe(false);
  });

  test("the owner restores a file from their own trashed project — never 'not owned'", async () => {
    const trashPath = join(createTempDir("ch-recycle-trash-"), "project");
    const projectId = await newProject(alice, "alice-trashed", trashPath);
    const recycleId = await recycleOne(alice, trashPath, "kept.ts", "kept-bytes\n");

    const trashed = await call(alice, `/api/projects/${projectId}`, { method: "DELETE" });
    expect(trashed.status).toBe(200);

    const listed = await call(alice, "/api/editor/recycle");
    expect(
      (listed.body.files ?? []).map((f) => f.id),
      "a file deleted from the owner's trashed project is still the owner's",
    ).toContain(recycleId);

    const restored = await call(alice, "/api/editor/restore", { method: "POST", body: { id: recycleId } });
    expect(
      restored.status,
      "a trashed-but-owned project must not be answered with project_path_not_owned",
    ).toBe(200);
    expect(readFileSync(join(trashPath, "kept.ts"), "utf8")).toBe("kept-bytes\n");
  });
});
