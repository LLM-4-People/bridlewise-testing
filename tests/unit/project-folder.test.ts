// @vitest-environment node
/**
 * PROJECT FOLDER PRESENCE + RELINK — the server-side half, over real HTTP.
 *
 * What must hold, and the mutations each one refuses:
 *   - a project's view carries the folder's MEASURED presence, answered at
 *     read time — delete the folder after creation and the very next read
 *     says "missing" (a view that remembered "present" from creation fails
 *     here);
 *   - PATCH /api/projects/:id accepts a `path` update (relink) and the
 *     answer re-measures the folder (the badge clears from the SAME
 *     answer, not a second fetch);
 *   - a relink to a folder that does NOT exist is refused — re-creating
 *     the missing state through the verb that ends it is the one outcome
 *     the verb must never produce;
 *   - a relink still renames when only `name` is sent (the old shape keeps
 *     working — one schema, both fields optional);
 *   - a relink of a project the caller does not own is a 404 (ownership is
 *     scoped at the DB layer, and a non-owned path update cannot move
 *     another user's project).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { createTempDir } from "../helpers/temp-dir.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { registerProjectRoutes } from "../../server/routes/projects.ts";
import { serverConfig } from "../../server/kernel/config.ts";

let srv: HttpTestServer;
let tmpRoot: string;
let req: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

beforeAll(async () => {
  tmpRoot = createTempDir("ch-proj-folder-");
  srv = await startHttpTestServer({
    prefix: "ch-proj-folder-",
    register: (router, _db, adb) => {
      registerProjectRoutes(router, adb);
    },
  });
  const cookie = createTestUser(srv.db, "folder-tester").cookie;
  req = async (method, path, body) => {
    const { status, body: json } = await jsonRequest(srv.baseUrl, path, {
      method,
      cookie,
      ...(body !== undefined ? { body } : {}),
    });
    return { status, json };
  };
});

afterAll(async () => {
  if (srv) await srv.stop();
});

type ProjectViewWire = {
  id: string;
  name: string;
  path: string;
  folder?: "present" | "missing" | "unreadable";
};

async function makeProject(name: string, path: string): Promise<ProjectViewWire> {
  const { status, json } = await req("POST", "/api/projects", { name, path });
  expect(status).toBe(201);
  return json as ProjectViewWire;
}

describe("the folder presence is measured at read time", () => {
  test("a project over a real folder reads folder: present", async () => {
    const dir = join(tmpRoot, "here");
    mkdirSync(dir);
    const view = await makeProject("present-one", dir);
    expect(view.folder).toBe("present");
  });

  test("wiping the folder after creation turns the NEXT read to missing", async () => {
    const dir = join(tmpRoot, "wiped");
    mkdirSync(dir);
    const view = await makeProject("wiped-one", dir);
    expect(view.folder).toBe("present");
    rmSync(dir, { recursive: true, force: true });
    const { json } = await req("GET", `/api/projects/${view.id}`);
    expect((json as ProjectViewWire).folder).toBe("missing");
  });

  test("the LIST answers the same per-project presence", async () => {
    const dir = join(tmpRoot, "listed");
    mkdirSync(dir);
    const made = await makeProject("listed-one", dir);
    rmSync(dir, { recursive: true, force: true });
    const { status, json } = await req("GET", "/api/projects");
    expect(status).toBe(200);
    const row = (json as ProjectViewWire[]).find((p) => p.id === made.id);
    expect(row?.folder).toBe("missing");
  });
});

describe("PATCH /api/projects/:id — relink", () => {
  test("relinking to a real folder updates the path and clears the missing state", async () => {
    const gone = join(tmpRoot, "gone");
    mkdirSync(gone);
    const made = await makeProject("relink-me", gone);
    rmSync(gone, { recursive: true, force: true });
    const replacement = join(tmpRoot, "replacement");
    mkdirSync(replacement);
    const { status, json } = await req("PATCH", `/api/projects/${made.id}`, { path: replacement });
    expect(status).toBe(200);
    const view = json as ProjectViewWire;
    expect(view.path).toBe(replacement);
    expect(view.folder).toBe("present");
    // A later read agrees (nothing was cached on the answer).
    const { json: reread } = await req("GET", `/api/projects/${made.id}`);
    expect((reread as ProjectViewWire).folder).toBe("present");
  });

  test("relinking to a folder that does NOT exist is refused (400) and changes nothing", async () => {
    const dir = join(tmpRoot, "still-here");
    mkdirSync(dir);
    const made = await makeProject("refuse-relink", dir);
    const { status, json } = await req("PATCH", `/api/projects/${made.id}`, {
      path: join(tmpRoot, "no-such-folder"),
    });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe("invalid_path");
    // The record was not moved.
    const { json: reread } = await req("GET", `/api/projects/${made.id}`);
    expect((reread as ProjectViewWire).path).toBe(dir);
  });

  test("a name-only PATCH still renames (the schema admits either field)", async () => {
    const dir = join(tmpRoot, "rename-stays");
    mkdirSync(dir);
    const made = await makeProject("old-name", dir);
    const { status, json } = await req("PATCH", `/api/projects/${made.id}`, { name: "new-name" });
    expect(status).toBe(200);
    expect((json as ProjectViewWire).name).toBe("new-name");
    expect((json as ProjectViewWire).path).toBe(dir);
  });

  test("a bare {} PATCH is refused (at least one field is required)", async () => {
    const dir = join(tmpRoot, "bare-patch");
    mkdirSync(dir);
    const made = await makeProject("bare-patch", dir);
    const { status } = await req("PATCH", `/api/projects/${made.id}`, {});
    expect(status).toBe(400);
  });

  test("a relink names a system directory is refused by the shared path rules", async () => {
    const dir = join(tmpRoot, "forbidden-relink");
    mkdirSync(dir);
    const made = await makeProject("forbidden-relink", dir);
    const { status } = await req("PATCH", `/api/projects/${made.id}`, { path: "/etc" });
    expect(status).toBe(400);
  });

  test("creating a project at the harness root is refused — landlock cannot confine it", async () => {
    const { status, json } = await req("POST", "/api/projects", {
      name: "inside-harness",
      path: serverConfig.projectRoot,
    });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe("invalid_path");
    const body = JSON.stringify(json);
    expect(body).toMatch(/harness/i);
  });

  test("creating a project in a folder inside the harness is refused the same way", async () => {
    const { status, json } = await req("POST", "/api/projects", {
      name: "inside-src",
      path: join(serverConfig.projectRoot, "src"),
    });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe("invalid_path");
    expect(JSON.stringify(json)).toMatch(/harness/i);
  });

  test("creating a project on a parent of the harness is refused — contains-harness", async () => {
    const parent = dirname(serverConfig.projectRoot);
    const { status, json } = await req("POST", "/api/projects", {
      name: "parent-of-harness",
      path: parent,
    });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe("invalid_path");
    expect(JSON.stringify(json)).toMatch(/contains|harness/i);
  });

  test("a relink of a project the caller does not own is a 404, and the path does not move", async () => {
    const dir = join(tmpRoot, "owned-dir");
    mkdirSync(dir);
    const made = await makeProject("owned", dir);
    // A second user on the same server.
    const otherCookie = createTestUser(srv.db, "other-user").cookie;
    const replacement = join(tmpRoot, "other-replacement");
    mkdirSync(replacement);
    const { status } = await jsonRequest(srv.baseUrl, `/api/projects/${made.id}`, {
      method: "PATCH",
      cookie: otherCookie,
      body: { path: replacement },
    });
    expect(status).toBe(404);
    const { json: reread } = await req("GET", `/api/projects/${made.id}`);
    expect((reread as ProjectViewWire).path).toBe(dir);
  });

  test("a PATCH on a TRASHED project answers 404 and moves NOTHING", async () => {
    const dir = join(tmpRoot, "trashed-patch");
    mkdirSync(dir);
    const made = await makeProject("trashed-patch", dir);
    expect((await req("DELETE", `/api/projects/${made.id}`)).status).toBe(200);

    const replacement = join(tmpRoot, "trashed-replacement");
    mkdirSync(replacement);
    const patched = await req("PATCH", `/api/projects/${made.id}`, { path: replacement });
    expect(patched.status, "a binned project is not a live patch target").toBe(404);

    // The false 404 used to hide a real mutation: the row had moved, which
    // freed the old folder for another account. 404 now means no mutation.
    const { json: trash } = await req("GET", "/api/trash");
    const trashed = (trash as { projects: ProjectViewWire[] }).projects.find((p) => p.id === made.id);
    expect(trashed?.path, "the trashed row still names the folder it was binned from").toBe(dir);
  });
});
