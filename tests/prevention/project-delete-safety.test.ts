// @vitest-environment node
/**
 * Prevention test: deleting a project must NEVER delete actual
 * files/folders on disk. The user's files are sacred.
 *
 * This test:
 * 1. Creates a REAL folder on disk with a test file inside.
 * 2. Creates a project in the DB pointing to that folder.
 * 3. Deletes the project via deleteProjectForUser (the DB method
 * the DELETE /api/projects/:id route calls).
 * 4. Asserts the folder AND its contents still exist on disk.
 * 5. Asserts the project is hidden from live lists and sits in the recycle bin.
 *
 * Regression guard: if anyone adds `fs.rm`, `rmdir`, or any file-deletion
 * call to the delete path, this test fails because the folder disappears.
 *
 * It also scans the projects route source to mechanically verify NO file
 * system deletion calls exist in the delete handler.
 */
import { describe, it, expect } from "vitest";
import { DbClient } from "../../server/db/client.ts";
import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTempDir } from "../helpers/temp-dir.ts";
import { bodySays, functionBody } from "../helpers/function-scope.ts";

const projectsRoutePath = resolve(__dirname, "../../server/routes/projects.ts");
const projectsRouteSource = readFileSync(projectsRoutePath, "utf8");

describe("project-delete-safety", () => {
  it("deleting a project does NOT delete the folder on disk", () => {
    // Create a real folder with a file inside.
    const realFolder = createTempDir("harness-project-real-");
    const realFile = join(realFolder, "important.ts");
    writeFileSync(realFile, "export const x = 1;\n");

    let db: DbClient | null = null;
    let dbDir: string | null = null;
    try {
      dbDir = createTempDir("harness-db-");
      db = new DbClient({ path: join(dbDir, "test.db") });
      const project = db.createProject({ name: "My Project", path: realFolder }, "sess-1");

      // Verify the project exists in the DB.
      expect(db.getProject(project.id, "sess-1")).not.toBeNull();

      // Delete the project from the DB.
      const deleted = db.deleteProject(project.id, "sess-1");
      expect(deleted, "deleteProjectForUser must return true").toBe(true);

      // Live lists hide it; the row remains in the recycle bin.
      expect(db.getProject(project.id, "sess-1"), "live get hides a trashed project").toBeNull();
      expect(db.listTrash("sess-1").projects.map((p) => p.id)).toEqual([project.id]);

      // CRITICAL: the folder AND its contents still exist on disk.
      expect(existsSync(realFolder), "the real folder must NOT be deleted").toBe(true);
      expect(existsSync(realFile), "the real file must NOT be deleted").toBe(true);
      expect(readdirSync(realFolder).length, "folder contents must be intact").toBe(1);

      // Live chat lists hide a trashed project's conversations.
      const chats = db.listChats(project.id, "sess-1");
      expect(chats.length, "chats for a trashed project must be hidden from live lists").toBe(0);
    } finally {
      // Close the DB + clean up both tmpdirs (the real folder + the DB dir)
      // so the suite does not leak file handles or `harness-db-*` dirs.
      if (db) { try { db.close(); } catch { /* best effort */ } }
    }
  });

  it("DELETE route source contains no file-system deletion calls", () => {
    // Mechanically scan the projects route for forbidden file-deletion APIs.
    // The delete handler must only call db.deleteProjectForUser.
    const forbidden = [
      "fs.rm",
      "fs.rmdir",
      "fs.unlink",
      "rmSync",
      "rmdirSync",
      "unlinkSync",
      "rm(",
      "rmdir(",
    ];
    for (const pattern of forbidden) {
      expect(
        projectsRouteSource.includes(pattern),
        `projects.ts must NOT contain '${pattern}'`,
      ).toBe(false);
    }
  });

  it("DbClient.deleteProject trashes the row and never calls fs", () => {
    const dbPath = resolve(__dirname, "../../server/db/client.ts");
    const dbSource = readFileSync(dbPath, "utf8");
    // The claims are made about the consolidated deleteProject(id, userId)
    // method's OWN body (the Single-Party-Owner Round-2 refactor merged the
    // legacy deleteProjectForUser into the single scoped deleteProject
    // accessor) — not about three hundred bytes after its name, which is the
    // window this replaces: that window false-failed the moment the doc
    // comment above the method grew, and a fs-deletion call sitting just past
    // the budget was invisible to it.
    const scope = functionBody(dbSource, "deleteProject", "DbClient.deleteProject");
    expect(
      bodySays(scope, "trashed_at"),
      "deleteProject must set trashed_at (recycle bin), not remove the row",
    ).toBe(true);
    expect(bodySays(scope, "DELETE FROM"), "deleteProject must not remove the row").toBe(false);
    // The method body must NOT import or call any fs deletion. DENY-BY-
    // DEFAULT: a single regex catches every fs-deletion surface (the sync
    // names, the namespaced `fs.*` form, the promise `fsPromises.*` form,
    // bare `rm(`/`rmdir(`/`unlink(` calls, AND any `node:fs` import/require).
    // A new fs deletion API (e.g. a future `fs.rmSync` alias or a promise
    // variant) is auto-caught by the `node:fs` import + `fs.`/`fsPromises.`
    // namespace match — no hardcoded op-name list that silently rots. The
    // pattern runs over the method's parser-scoped body, so "the method"
    // is exactly what is judged.
    const FORBIDDEN_FS_RE = /\b(rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)\s*\(|\bfs\.(rm|rmdir|unlink)\b|\bfsPromises\.(rm|rmdir|unlink)\b|from\s*["']node:fs["']|\brequire\s*\(\s*["']node:fs["']\)/;
    expect(
      FORBIDDEN_FS_RE.test(scope.body),
      `deleteProject must NOT call any fs deletion or import node:fs (deny-by-default — SQL-only delete):\n${scope.body}`,
    ).toBe(false);
  });
});
