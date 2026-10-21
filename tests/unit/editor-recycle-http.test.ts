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
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
import { installRecycleSlotRemover } from "../../server/filesystem/editor-bridge.ts";
import { registerProjectRoutes } from "../../server/routes/projects.ts";
import { serverConfig } from "../../server/kernel/config.ts";
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

type CallBody = {
  files?: { id: string }[];
  error?: string;
  recycleId?: string;
  content?: string;
  cleanup?: string;
  [key: string]: unknown;
};

async function call(
  user: TestUser,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: CallBody }> {
  const { status, body } = await jsonRequest(srv.baseUrl, path, {
    method: init?.method,
    body: init?.body,
    cookie: user.cookie,
  });
  return { status, body: body as CallBody };
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

  test("the owner's restore is judged by the project ROW id, not the spelling of its path", async () => {
    const projectPath = join(createTempDir("ch-recycle-spelling-"), "project");
    await newProject(alice, "alice-spelling", projectPath);
    const recycleId = await recycleOne(alice, projectPath, "spelled.ts", "spelled-bytes\n");
    // ONE PLACE, TWO SPELLINGS: a link beside the project names the same
    // folder, and `resolve()` cannot see it — only identity (or the row id)
    // can. The project row is reached BY ID below, so the spelling is not the
    // ownership question.
    const alias = `${projectPath}-alias`;
    symlinkSync(projectPath, alias, "dir");

    // Catch the slot on the committed restore; the injected failure keeps it
    // (and its commit marker) so the retry below can be driven.
    let slotDir = "";
    installRecycleSlotRemover((dir) => {
      slotDir = dir;
      throw new Error("injected recycle-slot cleanup failure keeps the commit marker");
    });
    try {
      const first = await call(alice, "/api/editor/restore", { method: "POST", body: { id: recycleId } });
      expect(first.status, "the owner's first restore must land").toBe(200);
      expect(slotDir).not.toBe("");
    } finally {
      installRecycleSlotRemover(null);
    }
    // Re-spell the recycle record's root through the link. The row probe finds
    // the SAME project by id; the old path comparison refused this owner.
    const metaPath = join(slotDir, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    meta["projectRoot"] = alias;
    writeFileSync(metaPath, `${JSON.stringify(meta)}\n`);

    const listed = await call(alice, "/api/editor/recycle");
    expect((listed.body.files ?? []).map((f) => f.id)).toContain(recycleId);

    const retried = await call(alice, "/api/editor/restore", { method: "POST", body: { id: recycleId } });
    expect(
      retried.status,
      "the same project row reached through another spelling is the same project",
    ).toBe(200);
    expect(readFileSync(join(projectPath, "spelled.ts"), "utf8")).toBe("spelled-bytes\n");
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

describe("a re-linked project cannot restore into the folder another account now holds", () => {
  /** Move A's row to a new folder through the real PATCH door. */
  async function relink(user: TestUser, projectId: string, path: string): Promise<void> {
    mkdirSync(path, { recursive: true });
    const patched = await call(user, `/api/projects/${projectId}`, {
      method: "PATCH",
      body: { path },
    });
    expect(patched.status, "the owner's re-link must succeed").toBe(200);
  }

  test("A's stale recycle record is refused with 409 and B's bytes are untouched", async () => {
    const oldRoot = join(createTempDir("ch-recycle-relink-"), "project");
    const projectId = await newProject(alice, "alice-relink", oldRoot);
    // B must not be able to take the path while A still owns it.
    expect((await call(bob, "/api/projects", { method: "POST", body: { name: "bob-too-early", path: oldRoot } })).status).toBe(409);
    const recycleId = await recycleOne(alice, oldRoot, "planted.ts", "A-PLANTED-BYTES\n");

    const newRoot = join(createTempDir("ch-recycle-relink-new-"), "project");
    await relink(alice, projectId, newRoot);

    // B now registers the folder A left behind (still on disk, now free).
    const bobProject = await call(bob, "/api/projects", { method: "POST", body: { name: "bob-took-it", path: oldRoot } });
    expect(bobProject.status, "the freed path is free for another account").toBe(201);
    const bobFile = join(oldRoot, "bob-owned.ts");
    expect((await call(bob, "/api/editor/create-file", { method: "POST", body: { path: bobFile, content: "B-OWNED\n", root: oldRoot } })).status).toBe(200);

    const restored = await call(alice, "/api/editor/restore", { method: "POST", body: { id: recycleId } });
    expect(
      restored.status,
      "the record's root no longer equals the row's current location, so the restore must refuse",
    ).toBe(409);
    expect(restored.body.error).toBe("recycle_project_moved");
    expect(existsSync(join(oldRoot, "planted.ts")), "A's bytes must not land in B's folder").toBe(false);
    expect(readFileSync(bobFile, "utf8")).toBe("B-OWNED\n");
    expect((await call(bob, `/api/editor/read?path=${encodeURIComponent(bobFile)}&root=${encodeURIComponent(oldRoot)}`)).status).toBe(200);
  });

  test("PATCH on a TRASHED project answers 404 and does NOT move the row", async () => {
    const oldRoot = join(createTempDir("ch-recycle-trash-patch-"), "project");
    const projectId = await newProject(alice, "alice-trash-patch", oldRoot);
    const recycleId = await recycleOne(alice, oldRoot, "kept.ts", "TRASH-BYTES\n");
    expect((await call(alice, `/api/projects/${projectId}`, { method: "DELETE" })).status).toBe(200);

    const newRoot = join(createTempDir("ch-recycle-trash-patch-new-"), "project");
    mkdirSync(newRoot, { recursive: true });
    const patched = await call(alice, `/api/projects/${projectId}`, { method: "PATCH", body: { path: newRoot } });
    expect(patched.status, "a binned project is not a patch target").toBe(404);

    // The row still names the folder the recycle record was made in; the old
    // path is NOT freed by a 404 that had already moved the row.
    const trash = await call(alice, "/api/trash");
    const row = (trash.body as unknown as { projects?: { id: string; path: string }[] }).projects?.find((p) => p.id === projectId);
    expect(row?.path, "the 404 must mean no mutation").toBe(oldRoot);

    // B can never register the old path while A's binned row still owns it,
    // so the enabler for the stale-record write is gone too.
    const bobProject = await call(bob, "/api/projects", { method: "POST", body: { name: "bob-after-trash", path: oldRoot } });
    expect(bobProject.status, "a trashed row still holds its folder").toBe(409);

    const restored = await call(alice, "/api/editor/restore", { method: "POST", body: { id: recycleId } });
    expect(restored.status, "the owner's own binned project still restores").toBe(200);
    expect(readFileSync(join(oldRoot, "kept.ts"), "utf8")).toBe("TRASH-BYTES\n");
  });

  test("a REAL partial slot removal (read-only recycle root) still leaves a retryable entry", async () => {
    const projectPath = join(createTempDir("ch-recycle-partial-"), "project");
    await newProject(alice, "alice-partial", projectPath);
    const recycleId = await recycleOne(alice, projectPath, "partial.ts", "PARTIAL-BYTES\n");
    const recycleRoot = join(dirname(serverConfig.dbPath), "recycle");
    const slotDir = join(recycleRoot, recycleId);

    // No injected remover: the RECYCLE ROOT refuses the slot rename. The old
    // `rmSync(slot, {recursive})` would have unlinked meta.json and the commit
    // marker first and only then failed to rmdir the slot, so the retry found
    // an empty folder (404) for a file that was already home.
    chmodSync(recycleRoot, 0o500);
    try {
      const first = await call(alice, "/api/editor/restore", { method: "POST", body: { id: recycleId } });
      expect(first.status, "the bytes land before cleanup is attempted").toBe(200);
      expect(first.body.cleanup, "a failed removal is retained, not claimed removed").toBe("retained");
      expect(readFileSync(join(projectPath, "partial.ts"), "utf8")).toBe("PARTIAL-BYTES\n");
      expect(existsSync(join(slotDir, "meta.json")), "the record survived the failed cleanup").toBe(true);
      expect(existsSync(join(slotDir, "restored.json")), "the commit marker survived it too").toBe(true);
    } finally {
      chmodSync(recycleRoot, 0o700);
    }

    // The retry finds the record and its marker and answers idempotently,
    // then removes the retained slot now that the root is writable again.
    const retry = await call(alice, "/api/editor/restore", { method: "POST", body: { id: recycleId } });
    expect(retry.status, "a retained slot must remain restorable").toBe(200);
    expect(retry.body.cleanup).toBe("removed");
    expect(readFileSync(join(projectPath, "partial.ts"), "utf8")).toBe("PARTIAL-BYTES\n");
  });
});

describe("a project registered while its path was MISSING cannot become a doorway", () => {
  test("a cross-account symlink is refused for read and write, and B's bytes stand", async () => {
    const bobRoot = join(createTempDir("ch-recycle-alias-bob-"), "project");
    await newProject(bob, "bob-alias-target", bobRoot);
    writeFileSync(join(bobRoot, "secret.txt"), "B-PRIVATE-BYTES\n");

    const alias = join(createTempDir("ch-recycle-alias-a-"), "work");
    // Registered while absent: the create door allows a folder that has not
    // been created yet, and the row stores the resolved (here: missing) path.
    const aProject = await call(alice, "/api/projects", { method: "POST", body: { name: "alice-missing-alias", path: alias } });
    expect(aProject.status, "a not-yet-created folder is a legitimate registration").toBe(201);
    symlinkSync(bobRoot, alias, "dir");

    const read = await call(alice, `/api/editor/read?path=${encodeURIComponent(join(alias, "secret.txt"))}&root=${encodeURIComponent(alias)}`);
    expect(read.status, "the alias now resolves into another account's project").toBe(403);
    const write = await call(alice, "/api/editor/write", {
      method: "PUT",
      body: { path: join(alias, "secret.txt"), content: "OVERWRITTEN-BY-A", root: alias },
    });
    expect(write.status, "the write must be refused for the same reason").toBe(403);
    expect(readFileSync(join(bobRoot, "secret.txt"), "utf8")).toBe("B-PRIVATE-BYTES\n");
  });

  test("a symlink to /etc is refused, never served", async () => {
    const alias = join(createTempDir("ch-recycle-etc-"), "work");
    const aProject = await call(alice, "/api/projects", { method: "POST", body: { name: "alice-missing-etc", path: alias } });
    expect(aProject.status).toBe(201);
    symlinkSync("/etc", alias, "dir");

    const read = await call(alice, `/api/editor/read?path=${encodeURIComponent(join(alias, "debian_version"))}&root=${encodeURIComponent(alias)}`);
    expect(read.status, "a registered path that resolves into /etc is not a project").toBe(403);
    expect(read.body.content, "no system file bytes may travel").toBeUndefined();
  });
});
