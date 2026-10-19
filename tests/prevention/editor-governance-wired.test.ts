// @vitest-environment node
/**
 * Mechanical enforcement: the web server's edit tool routes through the
 * engine's governed transactional editor — never an inline write.
 *
 * The governed editor (`engine/src/editor/transactional-editor.ts`) is the
 * SINGLE owner of edit governance: preimage verification, write-set
 * authorization, syntax validation, atomic write, post-write verification,
 * and rollback. There is exactly ONE model-facing edit tool, `edit`
 * (path/oldString/newString); its handler resolves the string preimage to a
 * byte range and hands the change to that governed editor. This guard asserts,
 * and would re-catch, the "edit governance is not bypassed" invariant across
 * two classes:
 *
 *   STRUCTURAL — the `edit` tool's handler delegates to the governed editor
 *     (through `createEditorTools`), and the executor never computes + writes
 *     an edit inline (no `writeFileSync`, no bare `writeFileRaw(` outside the
 *     governed editor's injected writer). Deny-by-default: a NEW edit tool or
 *     an inline write is caught.
 *
 *   BEHAVIORAL — drive the real path and prove the governance actually runs:
 *       1. a post-write mismatch rolls the file back to its preimage;
 *       2. a syntax-invalid edit to a parseable file is refused and the
 *          file is left unchanged;
 *       3. an edit to a path outside the declared write set is refused
 *          (write-set authorization);
 *       4. a refused edit (ambiguous / not-found preimage) is a zero-delta.
 *
 * Mutation contract (verified by the round): (a) reverting the handler to an
 *   inline `writeFileRaw(...)` write reds the STRUCTURAL arm; (b) removing
 *   the editor's post-write verify/rollback reds BEHAVIORAL arm 1; (c)
 *   removing the write-set check reds arm 3.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { executeToolCall, type ToolExecutionContext } from "../../server/tools/tool-executor.ts";
import { getToolManifest } from "../../server/tools/tools-bridge.ts";
import { createTransactionalEditor } from "../../engine/src/editor/transactional-editor.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const EXECUTOR = join(process.cwd(), "server", "tools", "tool-executor.ts");

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function readExecutor(): string {
  return readFileSync(EXECUTOR, "utf8");
}

let projectRoot: string;
let ctx: ToolExecutionContext;

beforeEach(() => {
  projectRoot = createTempDir("ch-edit-gov-");
  ctx = { projectRoot };
});

// ── STRUCTURAL: the edit tool routes through the governed editor ──

describe("structural: the edit tool routes through the governed editor", () => {
  test("the manifest exposes exactly one edit tool, named 'edit'", () => {
    const editToolNames = getToolManifest()
      .map((e) => e.name)
      .filter((n) => n === "edit" || n.startsWith("edit_"));
    expect(editToolNames, "exactly one edit tool, and it is 'edit'").toEqual(["edit"]);
  });

  test("the edit handler delegates to the governed editor (no inline write)", () => {
    const src = readExecutor();
    // The handler registered for `edit` in TOOL_HANDLERS.
    const m = /\bedit:\s*(\w+)/.exec(src);
    expect(m, "the 'edit' tool must be registered in TOOL_HANDLERS").not.toBeNull();
    const handlerName = m![1]!;
    const fnStart = src.indexOf(`function ${handlerName}(`);
    expect(fnStart, `handler '${handlerName}' must exist`).toBeGreaterThan(-1);
    const fnEnd = src.indexOf("\n}", fnStart);
    const body = src.slice(fnStart, fnEnd);
    // It reaches the governed editor through the editor-tools factory.
    expect(
      body.includes("editToolsForPath"),
      `edit handler '${handlerName}' must delegate to editToolsForPath (the governed editor), not write inline`,
    ).toBe(true);
    expect(
      /\bwriteFileSync\s*\(/.test(body) || /\bwriteFileRaw\s*\(/.test(body),
      `edit handler '${handlerName}' must NOT call writeFileSync/writeFileRaw directly — that bypasses the governed editor`,
    ).toBe(false);
  });

  test("the governed editor factory is the ONLY place edit writes leave the executor", () => {
    const src = readExecutor();
    // No edit handler section may call writeFileSync.
    const directWriteFileSync = /\bwriteFileSync\s*\(/.test(src);
    expect(directWriteFileSync, "tool-executor must not call writeFileSync anywhere").toBe(false);
    // writeFileRaw may appear ONLY as the editor's injected atomicWriter.
    const writeCalls = src.split("\n").filter((l) => /\bwriteFileRaw\s*\(/.test(l) && !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    for (const line of writeCalls) {
      expect(
        line.includes("writeFileRaw(resolvedPath"),
        `every writeFileRaw call must be the editor's injected atomicWriter (writeFileRaw(resolvedPath, …)); got: ${line.trim()}`,
      ).toBe(true);
    }
    expect(writeCalls.length, "exactly one sanctioned edit write site (the injected atomicWriter)").toBe(1);
  });

  test("the executor reaches the governed editor through the engine's editor tools", () => {
    const src = readExecutor();
    expect(src).toContain("createEditorTools");
    expect(src).toContain("../engine/src/editor/edit-tools.ts");
  });
});

// ── BEHAVIORAL: the governance actually runs on the real path ──

describe("behavioral: edit governance runs end-to-end", () => {
  test("a syntax-invalid whole-file edit to a TypeScript file is REFUSED and the file is unchanged", async () => {
    const rel = "code.ts";
    const original = "export const x: number = 1;\n";
    writeFileSync(join(projectRoot, rel), original);
    const broken = "export const = := 1((( unusable";
    const res = await executeToolCall("edit", { path: rel, oldString: "<all>", newString: broken }, ctx);
    expect(res.success, "a syntactically invalid edit must be refused").toBe(false);
    expect(res.output.toLowerCase()).toContain("syntax");
    // The governance the inline path lacked: the broken content never landed.
    expect(readFileSync(join(projectRoot, rel), "utf8")).toBe(original);
  });

  test("a valid edit to a TypeScript file LANDS (syntax gate does not over-refuse)", async () => {
    const rel = "ok.ts";
    const original = "export const a = 1;\n";
    writeFileSync(join(projectRoot, rel), original);
    const res = await executeToolCall("edit", { path: rel, oldString: "a = 1", newString: "a = 2" }, ctx);
    expect(res.success).toBe(true);
    expect(readFileSync(join(projectRoot, rel), "utf8")).toBe("export const a = 2;\n");
  });

  test("an edit naming a path that escapes the write set is REFUSED (write-set authorization)", async () => {
    // The write set is derived per call from the named path, so a path that
    // fails the editor's path validation (traversal) is refused before any
    // write — the editor never authorizes a path it did not declare valid.
    writeFileSync(join(projectRoot, "real.txt"), "content");
    const res = await executeToolCall("edit", { path: "../escape.txt", oldString: "<all>", newString: "x" }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/traversal|outside|invalid/i);
  });

  test("an edit to a path OUTSIDE the authorized write set is refused with write_set_denied", () => {
    // Direct write-set authorization: the editor is constructed authorizing
    // ONLY "authorized.txt"; an edit request naming a different in-root file
    // must be refused as write_set_denied — the file must keep its bytes.
    // This is the mutation target for "write-set check removed".
    const authorized = "authorized.txt";
    const other = "other.txt";
    writeFileSync(join(projectRoot, authorized), "A");
    writeFileSync(join(projectRoot, other), "B");
    const editor = createTransactionalEditor({
      repositoryRoot: projectRoot,
      writeSet: new Set([authorized]),
      skipUnknownExtensions: true,
    });
    const res = editor.applyEdit({ path: other, preimageHash: sha256("B"), operation: { kind: "replaceFile", newContent: "tampered" } });
    expect(res.success, "an edit to a path outside the write set must be refused").toBe(false);
    expect(res.feedback?.errorType, "the refusal is write-set authorization, not a generic error").toBe("write_set_denied");
    expect(readFileSync(join(projectRoot, other), "utf8")).toBe("B");
  });

  test("a not-found preimage is refused and the file keeps its current bytes (zero-delta)", async () => {
    const rel = "stable.txt";
    const original = "the real current content";
    writeFileSync(join(projectRoot, rel), original);
    const res = await executeToolCall("edit", { path: rel, oldString: "text that is not present", newString: "clobber" }, ctx);
    expect(res.success).toBe(false);
    // The file is byte-for-byte its preimage — a refused edit is a zero-delta.
    expect(readFileSync(join(projectRoot, rel), "utf8")).toBe(original);
  });

  test("an empty oldString on an existing file is refused and never wipes it", async () => {
    const rel = "wipe.txt";
    const original = "do not lose me";
    writeFileSync(join(projectRoot, rel), original);
    const res = await executeToolCall("edit", { path: rel, oldString: "", newString: "replacement" }, ctx);
    expect(res.success).toBe(false);
    expect(readFileSync(join(projectRoot, rel), "utf8")).toBe(original);
  });

  test("a post-write mismatch ROLLS BACK to the preimage (the governance the inline write lacked)", () => {
    // Drive the SAME governed editor the executor uses, with a writer that
    // lands corrupt bytes on the edit write but a clean restore on rollback.
    // The inline handlers had no post-write verification at all: a torn write
    // was reported as success and the corrupt bytes stayed. This arm is the
    // mutation target for "rollback removed" — without the post-write verify
    // the edit reports success and the file keeps the corruption.
    const rel = "rollback.txt";
    const original = "original-bytes";
    writeFileSync(join(projectRoot, rel), original);
    let writes = 0;
    const editor = createTransactionalEditor({
      repositoryRoot: projectRoot,
      writeSet: new Set([rel]),
      skipUnknownExtensions: true,
      atomicWriter: (p: string, c: string) => {
        writes += 1;
        writeFileSync(p, writes === 1 ? c + "CORRUPTED" : c);
        return { success: true as const };
      },
    });
    const res = editor.applyEdit({ path: rel, preimageHash: sha256(original), operation: { kind: "replaceFile", newContent: "new-bytes" } });
    expect(res.success, "a post-write mismatch must not report success").toBe(false);
    expect(res.rolledBack, "the edit must roll back to the preimage").toBe(true);
    expect(readFileSync(join(projectRoot, rel), "utf8")).toBe(original);
  });
});
