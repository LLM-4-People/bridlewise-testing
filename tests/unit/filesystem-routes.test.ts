// @vitest-environment node
import { vi, describe, test, expect, beforeAll, afterAll } from "vitest";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../helpers/temp-dir.ts";

/**
 * Integration test: real HTTP server with the filesystem route. Uses a
 * temporary directory tree to verify directory listing, parent navigation,
 * hidden-file filtering, file omission, and error handling.
 *
 * The project root is overridden via an env var set in vi.hoisted BEFORE
 * the config module is imported (serverConfig is frozen at import time).
 */

// Set the project root env var BEFORE the config module is imported so
// resolveServerConfig picks up our temp dir. vi.hoisted runs before all
// static imports are initialized, so imported bindings are in TDZ — the
// temp-dir owner is therefore pulled in with a dynamic `import()`.
//
// This previously hardcoded "/tmp/fs-route-test" and created the directory
// separately in beforeAll: an unowned fixed path that two concurrent runs of
// this file would fight over. `createTempDir` creates it and registers its
// removal in the same call.
await vi.hoisted(async () => {
  const { createTempDir } = await import("../helpers/temp-dir.ts");
  process.env.HARNESS_WEB_PROJECT_ROOT = createTempDir("ch-fs-route-");
});

import { registerFilesystemRoutes } from "../../server/routes/filesystem.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";

let srv: HttpTestServer;
let req: (method: string, path: string) => Promise<{ status: number; json: unknown }>;
// Single source of truth: the same path the server config resolved as its
// project root, read back rather than re-derived.
const tmpRoot = process.env.HARNESS_WEB_PROJECT_ROOT!;

beforeAll(async () => {
  srv = await startHttpTestServer({
    prefix: "ch-fs-routes-",
    register: (router, _db, adb) => {
      registerFilesystemRoutes(router, adb);
    },
  });
  const authCookie = createTestUser(srv.db, "fs-tester").cookie;
  req = async (method, path) => {
    const { status, body: json } = await jsonRequest(srv.baseUrl, path, { method, cookie: authCookie });
    return { status, json };
  };
  // Build the temp tree (the root itself was created by the hoisted block):
  // tmpRoot/
  // sub/
  // nested/
  //.hidden/ (dotfile — filtered)
  // afile.txt (file — filtered, only dirs listed)
  // inaccessible/ (chmod 000 — best effort)
  mkdirSync(join(tmpRoot, "sub"));
  mkdirSync(join(tmpRoot, "sub", "nested"));
  mkdirSync(join(tmpRoot, ".hidden"));
  mkdirSync(join(tmpRoot, "inaccessible"));
  writeFileSync(join(tmpRoot, "afile.txt"), "hello");
  try {
    chmodSync(join(tmpRoot, "inaccessible"), 0o000);
  } catch {
    // best effort
  }
});

afterAll(async () => {
  try {
    chmodSync(join(tmpRoot, "inaccessible"), 0o755);
  } catch {
    // best effort
  }
  // tmpRoot is removed by the temp-dir owner. The chmod restore above must
  // stay: a 0o000 subdirectory would make the owner's recursive remove fail.
  if (srv) await srv.stop();
});

describe("filesystem route: /api/filesystem/list", () => {
  test("lists directories at a path (files and dotfiles excluded)", async () => {
    const { status, json } = await req("GET", `/api/filesystem/list?path=${encodeURIComponent(tmpRoot)}`);
    expect(status).toBe(200);
    const result = json as { path: string; parent: string | null; entries: { name: string; accessible: boolean }[]; accessible: boolean };
    expect(result.path).toBe(tmpRoot);
    expect(result.parent).not.toBeNull();
    expect(result.accessible).toBe(true);
    const names = result.entries.map((e) => e.name);
    expect(names).toContain("sub");
    // Files are omitted (only directories).
    expect(names).not.toContain("afile.txt");
    // Hidden directories (dotfiles) are omitted.
    expect(names).not.toContain(".hidden");
  });

  test("parent navigation returns the parent directory", async () => {
    const { json } = await req("GET", `/api/filesystem/list?path=${encodeURIComponent(join(tmpRoot, "sub"))}`);
    const result = json as { parent: string | null; entries: { name: string }[] };
    expect(result.parent).toBe(tmpRoot);
    expect(result.entries.map((e) => e.name)).toContain("nested");
  });

  test("nested directory has no children", async () => {
    const { json } = await req("GET", `/api/filesystem/list?path=${encodeURIComponent(join(tmpRoot, "sub", "nested"))}`);
    const result = json as { entries: unknown[]; parent: string };
    expect(result.entries).toHaveLength(0);
    expect(result.parent).toBe(join(tmpRoot, "sub"));
  });

  test("404 for a nonexistent path", async () => {
    const { status, json } = await req("GET", `/api/filesystem/list?path=${encodeURIComponent(join(tmpRoot, "nope"))}`);
    expect(status).toBe(404);
    expect((json as { error: string }).error).toBe("not_found");
  });

  test("400 for a path that is not a directory", async () => {
    const { status, json } = await req("GET", `/api/filesystem/list?path=${encodeURIComponent(join(tmpRoot, "afile.txt"))}`);
    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe("not_a_directory");
  });

  test("default path resolves to the project root when no path is given", async () => {
    const { status, json } = await req("GET", "/api/filesystem/list");
    expect(status).toBe(200);
    const result = json as { path: string; entries: unknown[]; restriction?: string };
    // The default is the overridden project root (our temp dir).
    expect(result.path).toBe(tmpRoot);
    expect(Array.isArray(result.entries)).toBe(true);
    // In this suite the temp dir IS the harness root, so the listing names
    // why it cannot be a project — Landlock cannot confine a run here.
    expect(result.restriction).toMatch(/harness/i);
  });

  test("null bytes in path are rejected (400)", async () => {
    const { status } = await req("GET", `/api/filesystem/list?path=${encodeURIComponent("foo\0bar")}`);
    expect(status).toBe(400);
  });
});

describe("filesystem route: /api/filesystem/roots", () => {
  test("returns at least the home and server root", async () => {
    const { status, json } = await req("GET", "/api/filesystem/roots");
    expect(status).toBe(200);
    const result = json as { roots: { label: string; path: string; restriction?: string }[] };
    expect(Array.isArray(result.roots)).toBe(true);
    expect(result.roots.length).toBeGreaterThan(0);
    const paths = result.roots.map((r) => r.path);
    expect(paths).toContain(homedir());
    const server = result.roots.find((r) => r.path === tmpRoot);
    expect(server, "server root is the overridden harness").toBeDefined();
    expect(server).toMatchObject({ restriction: expect.stringMatching(/harness/i) });
  });

  test("roots are de-duplicated by path", async () => {
    const { json } = await req("GET", "/api/filesystem/roots");
    const result = json as { roots: { path: string }[] };
    const paths = result.roots.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
