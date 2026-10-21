// @vitest-environment node
/**
 * Mechanical enforcement: editor bridge owner (Single-Party-Owner
 * EDITOR BRIDGE).
 *
 * ("Single-Party-Owner Principle"): the editor
 * bridge (`server/editor-bridge.ts`) is the SINGLE owner of file
 * read/write/edit/delete. ALL file read/write/edit/delete goes through
 * the bridge — no route or service accesses the filesystem for editing
 * directly. The bridge enforces the fs-gate (path-ownership +
 * traversal + allowed-roots) at the LOWEST level (the choke point), so a
 * route/tool that forgets the gate cannot leak.
 *
 * This test pins the architecture across 6 assurance classes:
 * A. source-scan — the bridge uses fs-gate; routes import from the
 * bridge (not fs); the tool-executor's editor tools import from the
 * bridge (not fs).
 * B. single-owner — the raw read/write primitives are defined ONLY in
 * editor-bridge.ts (the bridge is the sole owner).
 * C. no-bypass — no route accesses fs.* directly for editing; the
 * tool-executor's editor tools (edit_*) + read_file do NOT call
 * readFileSync/writeFileSync directly (they go through the bridge).
 * D. behavioral — the bridge raw primitives enforce fs-gate (traversal
 * + ownership) at the choke point; maxBytes rejects before OOM.
 * E. consolidation — the bridge delegates to fs-gate (not re-implementing
 * resolve+startsWith); no scattered readFileSync/writeFileSync for
 * editing outside the bridge.
 * F. registry — the 5 editor tools are registered through the ONE tool
 * registry (tools-bridge) + dispatched through the ONE executor.
 *
 * CRITICAL: all file lists are DYNAMICALLY DISCOVERED via
 * `readdirSync` — NEVER hardcoded. If a new route or bridge is added, the
 * test automatically includes it (deny-by-default: a new file that
 * bypasses the bridge is caught without updating the test).
 *
 * Mutation-verified: key assertions FAIL when the violation is
 * reintroduced (removing the bridge import from tool-executor,
 * re-adding readFileSync to an editor tool, reverting a route to direct
 * fs access).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { join, relative, sep } from "node:path";
import { walkTs } from "../helpers/source-scan.ts";
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import {
  readFileRaw,
  writeFileRaw,
  readFile,
  writeFile,
  editFile,
  createFile,
  createDirectory,
  deleteFile,
  listRecycledFiles,
  restoreFile,
  installRecycleSlotRemover,
} from "../../server/filesystem/editor-bridge.ts";
import {
  assertProjectPathOwnership,
  resolveWithinProject,
  makeFsGate,
  type FsGate,
} from "../../server/filesystem/fs-gate.ts";
import {
  ForbiddenError,
  PathTraversalError,
  ValidationError,
} from "../../server/kernel/errors.ts";
import { getToolManifest } from "../../server/tools/tools-bridge.ts";
import { executeToolCall, isToolExecutable, listExecutableTools, type ToolExecutionContext } from "../../server/tools/tool-executor.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const SERVER_DIR = join(process.cwd(), "server");
const ROUTES_DIR = join(SERVER_DIR, "routes");

// ── Dynamic file discovery ──

/**
 * List all `.ts` files in the server directory (one level deep). Dynamic —
 * if a new bridge is added, it's automatically included.
 */
function listServerBridgeFiles(): string[] {
  return walkTs(SERVER_DIR)
    .map((f) => relative(SERVER_DIR, f).split(sep).join("/"))
    .filter((f) => f.endsWith("-bridge.ts"))
    .sort();
}

/**
 * List all `.ts` files in the routes directory. Dynamic — if a new route is
 * added, it's automatically included.
 */
function listRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort();
}

/**
 * Read a server file's source (safe — returns "" if not found).
 */
function readServer(rel: string): string {
  try {
    return readFileSync(join(SERVER_DIR, rel), "utf8");
  } catch {
    return "";
  }
}

/**
 * Read a route file's source (safe — returns "" if not found).
 */
function readRoute(rel: string): string {
  try {
    return readFileSync(join(ROUTES_DIR, rel), "utf8");
  } catch {
    return "";
  }
}

// ── Test DB setup ──

let tmpRoot: string;
let db: DbClient;
let userA: { userId: string };
let userB: { userId: string };
let projectAPath: string;
let projectAId: string;
let gateA: FsGate;
let gateB: FsGate;

beforeAll(async () => {
  tmpRoot = createTempDir("ch-editor-bridge-");
  db = new DbClient({ path: join(tmpRoot, "web.db") });
  userA = createTestUser(db, "alice-editor");
  userB = createTestUser(db, "bob-editor");
  projectAPath = join(tmpRoot, "alice-project");
  mkdirSync(projectAPath, { recursive: true });
  writeFileSync(join(projectAPath, "a.ts"), "export const x = 1;\n");
  projectAId = db.createProject({ name: "A-project", path: projectAPath }, userA.userId).id;
  const adb = AsyncDbClient.inline(db);
  gateA = await makeFsGate(userA.userId, adb, projectAPath);
  gateB = await makeFsGate(userB.userId, adb, projectAPath);
});

afterAll(() => {
  if (db) db.close();
});

// ── A. source-scan: the bridge uses fs-gate; routes + tool-executor go through the bridge ──

describe("A. source-scan: editor bridge uses fs-gate; no bypass", () => {
  test("editor-bridge.ts imports from fs-gate (ownership + traversal)", () => {
    const src = readServer("filesystem/editor-bridge.ts");
    expect(src).toContain("from \"./fs-gate.ts\"");
    expect(src).toContain("resolveWithinProject");
    expect(src).toContain("assertProjectPathOwnership");
  });

  test("editor-bridge.ts exports the raw primitives (readFileRaw + writeFileRaw)", () => {
    const src = readServer("filesystem/editor-bridge.ts");
    expect(src).toContain("export function readFileRaw");
    expect(src).toContain("export function writeFileRaw");
    expect(src).toContain("export type FileReadRawResult");
    expect(src).toContain("export type FileWriteRawResult");
  });

  test("tool-executor.ts imports readFileRaw + writeFileRaw from editor-bridge (NOT direct fs)", () => {
    const src = readServer("tools/tool-executor.ts");
    // Must import the raw primitives from the bridge.
    expect(src).toContain("from \"../filesystem/editor-bridge.ts\"");
    expect(src).toContain("readFileRaw");
    expect(src).toContain("writeFileRaw");
  });

  test("routes/editor.ts imports from editor-bridge (NOT direct fs)", () => {
    const src = readRoute("editor.ts");
    expect(src).toContain("from \"../filesystem/editor-bridge.ts\"");
    // The route must NOT import readFileSync/writeFileSync from node:fs.
    expect(src).not.toMatch(/import\b[^\n]*\b(readFileSync|writeFileSync|mkdirSync|rmSync)\b/);
  });

  test("every route file that handles file editing imports from editor-bridge", () => {
    // Dynamic discovery: scan ALL route files for ones that
    // reference editor operations (read/write/edit/create/delete file).
    // A route that edits files without importing the bridge is a bypass.
    const EDIT_OPS_RE = /\b(readFile|writeFile|editFile|createFile|createDirectory|deleteFile|readFileRaw|writeFileRaw)\s*\(/;
    const offenders: string[] = [];
    for (const f of listRouteFiles()) {
      const src = readRoute(f);
      // Skip if the route doesn't call any bridge function.
      if (!EDIT_OPS_RE.test(src)) continue;
      // If it calls a bridge function, it must import from the bridge.
      if (!src.includes("editor-bridge")) {
        offenders.push(f);
      }
    }
    expect(offenders, `Routes calling editor-bridge functions without importing it: ${offenders.join(", ")}`).toEqual([]);
  });

  test("no route file imports writeFileSync/rmSync/unlinkSync from node:fs for file editing", () => {
    // Dynamic discovery: scan ALL route files. A route that
    // imports fs file-write/delete operations is a potential bypass of the
    // bridge. `mkdirSync` is excluded — the folder-picker route
    // (filesystem.ts) legitimately creates directories on the server
    // filesystem BEFORE a project exists (uses assertWithinAllowedRoots,
    // not project-scoped editing).
    const FS_FILE_EDIT_IMPORT_RE = /import\s+\{[^}]*(writeFileSync|rmSync|unlinkSync)/;
    const offenders: string[] = [];
    for (const f of listRouteFiles()) {
      const src = readRoute(f);
      if (FS_FILE_EDIT_IMPORT_RE.test(src)) {
        offenders.push(f);
      }
    }
    expect(offenders, `Routes importing fs file-write/delete operations (bypass the bridge): ${offenders.join(", ")}`).toEqual([]);
  });
});

// ── B. single-owner: raw primitives defined ONLY in editor-bridge.ts ──

describe("B. single-owner: raw read/write primitives defined ONLY in editor-bridge.ts", () => {
  // Dynamic discovery: scan ALL bridge + server files.
  const serverFiles = walkTs(SERVER_DIR).map((f) => relative(SERVER_DIR, f).split(sep).join("/"));

  test("readFileRaw is defined ONLY in editor-bridge.ts", () => {
    const definers: string[] = [];
    for (const f of serverFiles) {
      const src = readServer(f);
      if (/export function readFileRaw/.test(src)) definers.push(f);
    }
    expect(definers).toEqual(["filesystem/editor-bridge.ts"]);
  });

  test("writeFileRaw is defined ONLY in editor-bridge.ts", () => {
    const definers: string[] = [];
    for (const f of serverFiles) {
      const src = readServer(f);
      if (/export function writeFileRaw/.test(src)) definers.push(f);
    }
    expect(definers).toEqual(["filesystem/editor-bridge.ts"]);
  });

  test("readFile is defined ONLY in editor-bridge.ts", () => {
    const definers: string[] = [];
    for (const f of serverFiles) {
      const src = readServer(f);
      if (/export function readFile\b/.test(src)) definers.push(f);
    }
    expect(definers).toEqual(["filesystem/editor-bridge.ts"]);
  });

  test("writeFile is defined ONLY in editor-bridge.ts", () => {
    const definers: string[] = [];
    for (const f of serverFiles) {
      const src = readServer(f);
      if (/export function writeFile\b/.test(src)) definers.push(f);
    }
    expect(definers).toEqual(["filesystem/editor-bridge.ts"]);
  });

  test("editFile is defined ONLY in editor-bridge.ts", () => {
    const definers: string[] = [];
    for (const f of serverFiles) {
      const src = readServer(f);
      if (/export function editFile\b/.test(src)) definers.push(f);
    }
    expect(definers).toEqual(["filesystem/editor-bridge.ts"]);
  });
});

// ── C. no-bypass: tool-executor editor tools do NOT call fs.* directly ──

describe("C. no-bypass: tool-executor editor tools go through the bridge", () => {
  test("the tool-executor's editor tool section does NOT call readFileSync directly", () => {
    const src = readServer("tools/tool-executor.ts");
    // Extract the editor tools section (from readPreimage to the end of
    // toolEditApplyPatch). This is the section that must go through the
    // bridge, NOT direct fs.
    const editorSectionStart = src.indexOf("// ── Editor tools");
    expect(editorSectionStart).toBeGreaterThan(-1);
    const editorSectionEnd = src.indexOf("// ── Intelligence tools");
    expect(editorSectionEnd).toBeGreaterThan(editorSectionStart);
    const editorSection = src.slice(editorSectionStart, editorSectionEnd);
    // The editor section must NOT call readFileSync directly (the bridge
    // owns reads). Comments mentioning readFileSync are allowed.
    const nonCommentLines = editorSection
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const directRead = nonCommentLines.some((l) => /\breadFileSync\s*\(/.test(l));
    expect(directRead, "tool-executor editor tools must NOT call readFileSync directly — route through readFileRaw").toBe(false);
  });

  test("the tool-executor's editor tool section does NOT call writeFileSync directly", () => {
    const src = readServer("tools/tool-executor.ts");
    const editorSectionStart = src.indexOf("// ── Editor tools");
    const editorSectionEnd = src.indexOf("// ── Intelligence tools");
    const editorSection = src.slice(editorSectionStart, editorSectionEnd);
    const nonCommentLines = editorSection
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const directWrite = nonCommentLines.some((l) => /\bwriteFileSync\s*\(/.test(l));
    expect(directWrite, "tool-executor editor tools must NOT call writeFileSync directly — route through writeFileRaw").toBe(false);
  });

  test("the tool-executor's read_file tool routes through readFileRaw (NOT readFileSync)", () => {
    const src = readServer("tools/tool-executor.ts");
    // The toolReadFile function must call readFileRaw, not readFileSync.
    const fnStart = src.indexOf("function toolReadFile(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf("\n}", fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain("readFileRaw");
    expect(fnBody).not.toMatch(/\breadFileSync\s*\(/);
  });

  test("the governed edit factory routes the editor's reads through readFileRaw (NOT readFileSync)", () => {
    const src = readServer("tools/tool-executor.ts");
    const fnStart = src.indexOf("function editToolsForPath(");
    expect(fnStart, "editToolsForPath must exist (the governed editor factory)").toBeGreaterThan(-1);
    const fnEnd = src.indexOf("\n}", fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    // The editor's file reader is the bridge's readFileRaw — edits read
    // through the SAME gated owner as every other file read.
    expect(fnBody).toContain("readFileRaw");
    expect(fnBody).not.toMatch(/\breadFileSync\s*\(/);
  });

  test("the governed edit factory routes the editor's writes through writeFileRaw (NOT writeFileSync)", () => {
    const src = readServer("tools/tool-executor.ts");
    const fnStart = src.indexOf("function editToolsForPath(");
    expect(fnStart, "editToolsForPath must exist (the governed editor factory)").toBeGreaterThan(-1);
    const fnEnd = src.indexOf("\n}", fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    // The editor's atomic writer is the bridge's writeFileRaw — edits write
    // through the SAME gated, recorded owner as a save from the editor room.
    expect(fnBody).toContain("writeFileRaw");
    expect(fnBody).not.toMatch(/\bwriteFileSync\s*\(/);
  });
});

// ── D. behavioral: the bridge raw primitives enforce fs-gate at the choke point ──

describe("D. behavioral: bridge raw primitives enforce fs-gate", () => {
  test("readFileRaw succeeds for an owned project file", () => {
    const result = readFileRaw(join(projectAPath, "a.ts"), projectAPath, gateA);
    expect(result.content).toContain("export const x = 1");
    expect(result.size).toBeGreaterThan(0);
  });

  test("readFileRaw throws ForbiddenError when gate passed + path not owned (deny-by-default)", () => {
    // User B calling readFileRaw with A's project + B's gate → ForbiddenError.
    expect(() => readFileRaw(join(projectAPath, "a.ts"), projectAPath, gateB)).toThrow(ForbiddenError);
  });

  test("readFileRaw throws PathTraversalError when path escapes root", () => {
    expect(() => readFileRaw("../../etc/passwd", projectAPath, gateA)).toThrow(PathTraversalError);
  });

  test("readFileRaw throws ValidationError on missing file", () => {
    expect(() => readFileRaw("nonexistent.ts", projectAPath, gateA)).toThrow(ValidationError);
  });

  test("readFileRaw throws ValidationError on directory (not a file)", () => {
    mkdirSync(join(projectAPath, "subdir"), { recursive: true });
    expect(() => readFileRaw("subdir", projectAPath, gateA)).toThrow(ValidationError);
  });

  test("readFileRaw with maxBytes rejects BEFORE reading (prevents OOM)", () => {
    // Create a file larger than maxBytes.
    const bigPath = join(projectAPath, "big.txt");
    writeFileSync(bigPath, "x".repeat(2048));
    // maxBytes=1024 → the stat size (2048) exceeds → rejects without reading.
    expect(() => readFileRaw("big.txt", projectAPath, gateA, 1024)).toThrow(ValidationError);
    try {
      readFileRaw("big.txt", projectAPath, gateA, 1024);
    } catch (err) {
      expect((err as ValidationError).code).toBe("file_too_large");
    }
  });

  test("readFileRaw without gate trusts the path (server-verified — tool-executor path)", () => {
    const result = readFileRaw(join(projectAPath, "a.ts"), projectAPath);
    expect(result.content).toContain("export const x = 1");
  });

  test("readFileRaw with gate + projectRoot omitted enforces ownership against fallback root (deny-by-default)", () => {
    // When the route omits `root`, the bridge falls back to
    // serverConfig.projectRoot. The gate MUST still run against that
    // fallback — a user who does not own a project there gets a 403.
    // Without this fix, omitting `root` skipped ownership entirely (the
    // server-cwd filesystem leak: any authenticated user could read/write
    // files in process.cwd() without owning a project there). No test user
    // owns serverConfig.projectRoot (= process.cwd() under vitest), so both
    // gateA and gateB must get ForbiddenError (project_path_not_owned).
    // Mutation-verified: reverting the fix (gate skipped when projectRoot
    // is undefined) makes this throw ValidationError(file_not_found) or
    // succeed instead — NOT ForbiddenError — so the test fails on revert.
    for (const gate of [gateA, gateB]) {
      try {
        readFileRaw("a.ts", undefined, gate);
        throw new Error("expected readFileRaw to throw ForbiddenError when projectRoot is omitted");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).code).toBe("project_path_not_owned");
      }
    }
  });

  test("writeFileRaw with gate + projectRoot omitted enforces ownership against fallback root (deny-by-default)", () => {
    // Same invariant as readFileRaw above, for the write primitive. A
    // caller that omits `root` cannot bypass the ownership gate — the
    // gate runs against the fallback root. Mutation-verified: reverting
    // the fix makes this resolve against process.cwd() with no ownership
    // check (a write bypass), not a ForbiddenError. Uses a unique temp
    // name + cleans up so a reverted fix cannot leave an artifact in the
    // project dir (the pre-fix code would write the file before the test
    // catches the missing ForbiddenError).
    const probePath = ".cp-r12-mutation-verify.tmp";
    for (const gate of [gateA, gateB]) {
      try {
        writeFileRaw(probePath, "bad", undefined, gate);
        throw new Error("expected writeFileRaw to throw ForbiddenError when projectRoot is omitted");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).code).toBe("project_path_not_owned");
      }
    }
    // Clean up any file the pre-fix (reverted) code wrote to process.cwd()
    // during mutation-verification. With the fix, the gate throws before
    // any write, so no file is created; rmSync force is a no-op.
    rmSync(join(process.cwd(), probePath), { force: true });
  });

  test("writeFileRaw writes content + returns oldSize", () => {
    const result = writeFileRaw("new.ts", "hello world", projectAPath, gateA);
    expect(result.bytesWritten).toBe(11);
    expect(result.oldSize).toBe(0);
    expect(existsSync(join(projectAPath, "new.ts"))).toBe(true);
    // Overwrite — oldSize should now be 11.
    const result2 = writeFileRaw("new.ts", "hello", projectAPath, gateA);
    expect(result2.oldSize).toBe(11);
  });

  test("writeFileRaw throws ForbiddenError when gate passed + path not owned", () => {
    expect(() => writeFileRaw("evil.ts", "bad", projectAPath, gateB)).toThrow(ForbiddenError);
  });

  test("writeFileRaw throws PathTraversalError when path escapes root", () => {
    expect(() => writeFileRaw("../../etc/evil", "bad", projectAPath, gateA)).toThrow(PathTraversalError);
  });

  test("readFile (UI) delegates to readFileRaw + adds metadata", () => {
    const result = readFile(join(projectAPath, "a.ts"), projectAPath, gateA);
    expect(result.content).toContain("export const x = 1");
    expect(result.language).toBe("typescript");
    expect(result.encoding).toBe("utf-8");
    expect(result.lineCount).toBeGreaterThan(0);
  });

  test("editFile delegates to readFileRaw + writeFileRaw (preimage match)", () => {
    writeFileSync(join(projectAPath, "edit-me.ts"), "old content");
    const result = editFile("edit-me.ts", "old content", "new content", projectAPath, gateA);
    expect(result.success).toBe(true);
    expect(result.oldSize).toBe("old content".length);
    expect(result.newSize).toBe("new content".length);
    // Verify the file was actually changed.
    expect(readFileSync(join(projectAPath, "edit-me.ts"), "utf8")).toBe("new content");
  });

  test("editFile throws ValidationError on preimage mismatch", () => {
    writeFileSync(join(projectAPath, "stale.ts"), "actual content\n");
    expect(() => editFile("stale.ts", "wrong content", "new", projectAPath, gateA)).toThrow(ValidationError);
  });

  test("createFile creates a new file + rejects if exists", () => {
    const result = createFile("created.ts", "content", projectAPath, gateA);
    expect(result.type).toBe("file");
    // Creating again should fail.
    expect(() => createFile("created.ts", "content", projectAPath, gateA)).toThrow(ValidationError);
  });

  test("createDirectory creates a new dir + rejects if exists", () => {
    const result = createDirectory("new-dir", projectAPath, gateA);
    expect(result.type).toBe("directory");
    expect(() => createDirectory("new-dir", projectAPath, gateA)).toThrow(ValidationError);
  });

  test("deleteFile removes a file + throws if missing", () => {
    createFile("to-delete.ts", "temp", projectAPath, gateA);
    const result = deleteFile("to-delete.ts", projectAPath, gateA);
    expect(result.removed).toBe(true);
    expect(() => deleteFile("to-delete.ts", projectAPath, gateA)).toThrow(ValidationError);
  });

  test("deleteFile MOVES to recycle; restoreFile puts the bytes back", () => {
    const contents = "recycle-round-trip\n";
    createFile("recycle-me.ts", contents, projectAPath, gateA);
    const gone = join(projectAPath, "recycle-me.ts");
    const result = deleteFile("recycle-me.ts", projectAPath, gateA);
    expect(existsSync(gone)).toBe(false);
    expect(result.recycleId.length).toBeGreaterThan(0);
    const listed = listRecycledFiles().filter((f) => f.id === result.recycleId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe("recycle-me.ts");
    const restored = restoreFile(result.recycleId, gateA);
    expect(existsSync(gone)).toBe(true);
    expect(readFileSync(gone, "utf8")).toBe(contents);
    expect(restored.recycleId).toBe(result.recycleId);
    expect(listRecycledFiles().some((f) => f.id === result.recycleId)).toBe(false);
  });

  test("the recycle record carries the deleting user and project row, and restore asserts them before the path gate", () => {
    createFile("stamped-owner.ts", "stamped\n", projectAPath, gateA);
    const result = deleteFile("stamped-owner.ts", projectAPath, gateA);
    const record = listRecycledFiles().find((f) => f.id === result.recycleId);
    expect(record, "the deleted entry must be listed while it is still in the bin").toBeDefined();
    expect(record!.deletedByUserId, "the deleting user is stamped at delete").toBe(userA.userId);
    expect(record!.projectId, "the producing project row is stamped at delete").toBe(projectAId);

    // A gate that CLAIMS this path for B — the path gate alone would admit it,
    // so the refusal below proves the stamped identity is asserted first.
    const claimedByB: FsGate = {
      userId: userB.userId,
      decisions: new Map([[projectAPath, db.getProject(projectAId, userA.userId)!]]),
    };
    expect(
      () => restoreFile(result.recycleId, claimedByB),
      "another user's gate must not restore this entry even when it claims the path",
    ).toThrow(ForbiddenError);
    expect(existsSync(join(projectAPath, "stamped-owner.ts"))).toBe(false);
    // The owner's own gate still restores it.
    expect(restoreFile(result.recycleId, gateA).path).toBe(join(projectAPath, "stamped-owner.ts"));
  });

  test("the commit marker is judged by the owning project ROW id, and two spellings of one path are one restore", () => {
    createFile("marker-spelling.ts", "marker-spelling\n", projectAPath, gateA);
    const result = deleteFile("marker-spelling.ts", projectAPath, gateA);

    // A SECOND PROJECT ROW, at a different folder. The gate below claims the
    // deleted entry's path spelling with THIS row: the path is identical, so
    // only the row id can tell the two projects apart.
    const otherPath = join(tmpRoot, "alice-other-project");
    mkdirSync(otherPath, { recursive: true });
    const otherId = db.createProject({ name: "A-other-project", path: otherPath }, userA.userId).id;
    const claimsAnotherProject: FsGate = {
      userId: userA.userId,
      decisions: new Map([[projectAPath, db.getProject(otherId, userA.userId)!]]),
    };
    expect(
      () => restoreFile(result.recycleId, claimsAnotherProject),
      "a different project id at the SAME path spelling must be refused",
    ).toThrow(ForbiddenError);
    expect(existsSync(join(projectAPath, "marker-spelling.ts"))).toBe(false);

    let slotDir = "";
    installRecycleSlotRemover((dir) => {
      slotDir = dir;
      throw new Error("injected recycle-slot cleanup failure keeps the commit marker");
    });
    try {
      const restored = restoreFile(result.recycleId, gateA);
      expect(restored.cleanup).toBe("retained");
      expect(readFileSync(restored.path, "utf8")).toBe("marker-spelling\n");
      const markerPath = join(slotDir, "restored.json");
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;

      // TWO SPELLINGS OF ONE PATH ARE ONE RESTORE. `//` collapses to the same
      // place; the marker's id, not its path text, decides. (Before the fix
      // this was `marker.restoredPath !== dest` and the retry 404'd.)
      const respelled = `${projectAPath}//marker-spelling.ts`;
      writeFileSync(markerPath, `${JSON.stringify({ ...marker, restoredPath: respelled })}\n`);
      expect(
        restoreFile(result.recycleId, gateA).path,
        "a retry that spells the restored path another way is still this restore",
      ).toBe(respelled);
      expect(marker["projectId"], "the marker carries the owning project row id").toBe(projectAId);

      // THE SAME SPELLING, ANOTHER PROJECT ID, IS REFUSED.
      writeFileSync(markerPath, `${JSON.stringify({ ...marker, projectId: otherId })}\n`);
      expect(
        () => restoreFile(result.recycleId, gateA),
        "a marker stamped with another project row must not answer for this one",
      ).toThrow(ValidationError);

      // The owning id again answers idempotently.
      writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
      expect(restoreFile(result.recycleId, gateA).path).toBe(restored.path);
    } finally {
      installRecycleSlotRemover(null);
    }
    // With cleanup working again the slot is removed and the entry is gone.
    expect(restoreFile(result.recycleId, gateA).cleanup).toBe("removed");
    expect(listRecycledFiles().some((f) => f.id === result.recycleId)).toBe(false);
  });

  test("a failed slot cleanup is not a failed restore, and a payload-less retry answers idempotently", () => {
    const contents = "cleanup-failure\n";
    createFile("cleanup-failure.ts", contents, projectAPath, gateA);
    const result = deleteFile("cleanup-failure.ts", projectAPath, gateA);

    installRecycleSlotRemover(() => {
      throw new Error("injected recycle-slot cleanup failure");
    });
    try {
      // The move is the commit point: cleanup never turns it into a 500.
      const restored = restoreFile(result.recycleId, gateA);
      expect(restored.path).toBe(join(projectAPath, "cleanup-failure.ts"));
      expect(restored.cleanup, "the failed cleanup is reported, not hidden").toBe("retained");
      expect(readFileSync(restored.path, "utf8")).toBe(contents);

      // The slot survives (payload-less). A retry must answer the restored
      // path idempotently instead of 404 "gone".
      const retried = restoreFile(result.recycleId, gateA);
      expect(retried.path).toBe(restored.path);
      expect(retried.cleanup).toBe("retained");
      expect(readFileSync(restored.path, "utf8")).toBe(contents);
    } finally {
      installRecycleSlotRemover(null);
    }

    // With cleanup working again, the retry removes the marker slot.
    const final = restoreFile(result.recycleId, gateA);
    expect(final.cleanup).toBe("removed");
    expect(listRecycledFiles().some((f) => f.id === result.recycleId)).toBe(false);
    expect(() => restoreFile(result.recycleId, gateA)).toThrow(ValidationError);
  });
});

// ── E. consolidation: the bridge delegates to fs-gate (no duplicate resolve) ──

describe("E. consolidation: bridge delegates to fs-gate (no scattered logic)", () => {
  test("editor-bridge uses resolveAndCheckGate (shared helper, no inline gate)", () => {
    const src = readServer("filesystem/editor-bridge.ts");
    // The shared helper must exist.
    expect(src).toContain("function resolveAndCheckGate");
    // The bridge must NOT re-implement the gate inline (no duplicate
    // assertProjectPathOwnership calls outside resolveAndCheckGate).
    // Count non-comment lines with assertProjectPathOwnership.
    const gateCalls = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .filter((l) => /assertProjectPathOwnership\s*\(/.test(l));
    // Only the resolveAndCheckGate helper should call it (1 call).
    expect(gateCalls.length).toBe(1);
  });

  test("editor-bridge does NOT re-implement resolveWithinProject inline", () => {
    const src = readServer("filesystem/editor-bridge.ts");
    // The bridge imports + calls resolveWithinProject from fs-gate.
    expect(src).toContain("resolveWithinProject");
    // It must NOT define its own resolve+startsWith logic.
    expect(src).not.toMatch(/if\s*\(![^.]+\.startsWith\(root\s*\+\s*sep\)\)/);
  });
});

// ── F. registry: the 5 editor tools are registered + dispatched through ONE pipeline ──

describe("F. registry: the edit tool is registered + dispatched through ONE pipeline", () => {
  // The ONE model-facing edit tool is named `edit`. Dynamic discovery: the
  // editor tools are the manifest entries routed through the editor adapter
  // (`web-ui-editor`), so a renamed or added editor tool is auto-covered
  // (deny-by-default) without a hardcoded tool-name list that silently rots.
  const editorTools = getToolManifest()
    .filter((e) => e.adapterId === "web-ui-editor")
    .map((e) => e.name);
  expect(editorTools, "the editor adapter exposes exactly one tool, 'edit'").toEqual(["edit"]);

  test("the edit tool is in the manifest (tools-bridge registry)", () => {
    const names = new Set(getToolManifest().map((e) => e.name));
    for (const name of editorTools) {
      expect(names.has(name), `Editor tool '${name}' must be in the manifest`).toBe(true);
    }
  });

  test("the edit tool is executable (dispatched through the ONE executor)", () => {
    const executables = new Set(listExecutableTools());
    for (const name of editorTools) {
      expect(isToolExecutable(name), `Editor tool '${name}' must be executable`).toBe(true);
    }
  });

  test("read_file is in the manifest + executable (goes through the bridge)", () => {
    const names = new Set(getToolManifest().map((e) => e.name));
    expect(names.has("read_file")).toBe(true);
    expect(isToolExecutable("read_file")).toBe(true);
  });

  test("executeToolCall for a non-existent file returns a typed error (NOT a throw)", async () => {
    const ctx: ToolExecutionContext = { projectRoot: projectAPath };
    const result = await executeToolCall("read_file", { path: "does-not-exist.ts" }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Error");
  });
});
