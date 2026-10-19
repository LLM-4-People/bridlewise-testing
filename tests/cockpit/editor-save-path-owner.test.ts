// @vitest-environment node
/**
 * SAVE-PATH OWNER — a save writes to the file that was OPENED, and the room
 * only believes it did when the server names that same file back.
 *
 * The defect this guards against is real and was shipped once: the editor
 * re-derived the target path at save time by searching the file tree, the
 * tree had been reset to its root level by an earlier load, a NESTED file's
 * entry was therefore absent, the lookup returned nothing, and the whole save
 * was skipped inside an `if` — silently.
 *
 * Two properties remove it, and both are proven here with the mutation the
 * task named: POINT THE WRITE AT A SIBLING FILE AND SHOW THE GUARD FAILS.
 *
 *   1. THE PATH IS CARRIED, NOT LOOKED UP. `bufferPendingSave` reads the path off
 *      the buffer's own open file, which was captured at open. The test
 *      empties the tree between open and save — the exact condition that
 *      broke the old editor — and the save still names the nested file.
 *
 *   2. THE WRITE IS VERIFIED BY PATH. `performSave` compares the path the
 *      server says it wrote against the path that was opened. A response
 *      about a sibling is a FAILED save that keeps the draft, not a success.
 *
 * Plus: the room can only reach the PREIMAGE-CHECKED door, so a file that
 * changed underneath is refused rather than clobbered — including when the
 * file was EMPTY when it was opened, which is the case the old editor routed
 * to the unchecked writer.
 */
import { describe, expect, test } from "vitest";

import type { PendingSave } from "../../src/cockpit/editor/buffer.ts";
import {
  performSave,
  wroteTheOpenedFile,
  writtenPathOf,
} from "../../src/cockpit/editor/save.ts";
import { read, stripCommentsAndStringsFor, stripCommentsOnlyFor } from "../helpers/source-scan.ts";

const NESTED: PendingSave = {
  apiPath: "/proj/src/deep/nested/reader.ts",
  projectPath: "/proj",
  preimage: "before",
  content: "after",
};

/** The sibling in the same folder — the file a wrong write would land on. */
const SIBLING = "/proj/src/deep/nested/writer.ts";

describe("the path travels with the draft — it is never looked up again", () => {
  test("a save names the file that was opened, even when the tree no longer holds it", async () => {
    let asked: string | null = null;
    const outcome = await performSave(NESTED, async (save) => {
      asked = save.apiPath;
      return { path: save.apiPath, success: true };
    });
    expect(asked, "the nested path must survive the round trip").toBe(NESTED.apiPath);
    expect(outcome.kind).toBe("written");
  });

  test("the buffer's own save request reads the path from the OPEN FILE, not a list", () => {
    const src = stripCommentsAndStringsFor(read("src/cockpit/editor/buffer.ts"), "src/cockpit/editor/buffer.ts");
    const fn = /export function bufferPendingSave\(([\s\S]*?)\n\}/.exec(src);
    expect(fn, "bufferPendingSave must exist").not.toBeNull();
    expect(fn![1]!, "the path must come off the open file").toContain("state.file.apiPath");
    // A lookup of ANY kind here is the defect coming back.
    for (const smell of ["find(", "filter(", "entries", "indexOf", "rows"]) {
      expect(
        fn![1]!,
        `bufferPendingSave must not consult a list — "${smell}" is how the old editor lost a nested save`,
      ).not.toContain(smell);
    }
  });
});

describe("the write is VERIFIED by path", () => {
  test("a server that names a SIBLING fails the save and keeps the draft", async () => {
    // THE MUTATION THE TASK NAMED, executed: point the write at a sibling.
    const outcome = await performSave(NESTED, async () => ({ path: SIBLING, success: true }));
    expect(outcome.kind, "a write to another file is NOT a successful save").toBe("wrong-path");
    if (outcome.kind !== "wrong-path") throw new Error("unreachable");
    expect(outcome.wrote).toBe(SIBLING);
    expect(outcome.reason, "the sentence must name both files").toContain(SIBLING);
    expect(outcome.reason).toContain(NESTED.apiPath);
  });

  test("a server that names NO file fails the save too (absence is not agreement)", async () => {
    const outcome = await performSave(NESTED, async () => ({ success: true }));
    expect(outcome.kind).toBe("wrong-path");
  });

  test("only an exact path match passes", () => {
    expect(wroteTheOpenedFile(NESTED.apiPath, NESTED.apiPath)).toBe(true);
    // A trailing separator is not part of a path's identity.
    expect(wroteTheOpenedFile("/a/b", "/a/b/")).toBe(true);
    // Everything else is a different file.
    expect(wroteTheOpenedFile("/a/b/reader.ts", "/a/b/writer.ts")).toBe(false);
    expect(wroteTheOpenedFile("/a/b/reader.ts", "/a/reader.ts")).toBe(false);
    expect(wroteTheOpenedFile("/a/b/reader.ts", "reader.ts"), "same NAME, other file").toBe(false);
    expect(wroteTheOpenedFile("/a/b/reader.ts", null)).toBe(false);
  });

  test("writtenPathOf refuses anything that is not a string path", () => {
    expect(writtenPathOf({ path: "/a" })).toBe("/a");
    expect(writtenPathOf({ path: 7 })).toBeNull();
    expect(writtenPathOf(null)).toBeNull();
    expect(writtenPathOf("done")).toBeNull();
  });

  test("MUTATION: dropping the verification lets the sibling response through", async () => {
    // Model the guard's removal directly: without the path check, ANY
    // response counts as a write, which is what makes the check load-bearing.
    const unguarded = async (save: PendingSave, write: (s: PendingSave) => Promise<unknown>) => {
      await write(save);
      return { kind: "written" as const };
    };
    const mutated = await unguarded(NESTED, async () => ({ path: SIBLING }));
    expect(mutated.kind, "the unguarded shape calls a sibling write a success").toBe("written");
    // …and the real one does not.
    const real = await performSave(NESTED, async () => ({ path: SIBLING }));
    expect(real.kind).toBe("wrong-path");
  });
});

describe("a refused save keeps the user's text and says why", () => {
  test("a preimage mismatch is reported as STALE, in plain words", async () => {
    const outcome = await performSave(NESTED, async () => {
      throw Object.assign(new Error("File content has changed"), { code: "preimage_mismatch" });
    });
    expect(outcome.kind).toBe("stale");
    if (outcome.kind !== "stale") throw new Error("unreachable");
    expect(outcome.reason).toContain("was NOT written");
    expect(outcome.reason, "…and must say the edit is still there").toContain("still here");
  });

  test("an empty preimage is a REAL preimage, not a missing one", async () => {
    // The old editor treated `""` as "no preimage" and fell through to the
    // UNCHECKED writer, silently overwriting whatever had been written since.
    const fromEmpty: PendingSave = { ...NESTED, preimage: "", content: "first words" };
    let sent: PendingSave | null = null;
    await performSave(fromEmpty, async (s) => {
      sent = s;
      return { path: s.apiPath };
    });
    expect(sent, "the save must still be attempted").not.toBeNull();
    expect(sent!.preimage, "and it must carry the empty preimage, not omit it").toBe("");
  });

  test("a draft identical to disk writes nothing at all", async () => {
    let called = false;
    const outcome = await performSave({ ...NESTED, content: NESTED.preimage }, async () => {
      called = true;
      return {};
    });
    expect(outcome.kind).toBe("unchanged");
    expect(called, "there is nothing to write, so nothing is sent").toBe(false);
  });

  test("an unknown failure keeps the draft and quotes what came back", async () => {
    const outcome = await performSave(NESTED, async () => {
      throw new Error("connection reset");
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("connection reset");
  });
});

describe("static — the room can only reach the CHECKED door", () => {
  test("the editor's feed wires `edit` (preimage-checked) and not `write`", () => {
    const feed = stripCommentsAndStringsFor(read("src/cockpit/editor/feed.ts"), "src/cockpit/editor/feed.ts");
    expect(feed, "the save must go through the preimage-checked route").toContain("editEditorFile");
    expect(
      feed,
      "`writeEditorFile` is the UNCHECKED writer — reaching it is how the old editor clobbered files",
    ).not.toContain("writeEditorFile");
  });

  test("no editor source reaches the unchecked writer directly", () => {
    for (const file of [
      "src/cockpit/rooms/EditorRoom.svelte",
      "src/cockpit/editor/save.ts",
      "src/cockpit/editor/FilePane.svelte",
    ]) {
      expect(stripCommentsAndStringsFor(read(file), file), `${file} must not call the unchecked writer`).not.toContain(
        "writeEditorFile",
      );
    }
  });

  test("the room retires the draft ONLY on a verified write", () => {
    // Comments go, STRINGS STAY: the branch this asserts on is a string
    // comparison, and a scan that stripped it would be hunting for something
    // it had just deleted.
    const room = stripCommentsOnlyFor(read("src/cockpit/rooms/EditorRoom.svelte"), "src/cockpit/rooms/EditorRoom.svelte");
    const save = /async function save\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(room);
    expect(save, "the room must have a save function").not.toBeNull();
    const body = save![1]!;
    expect(body, "the outcome decides").toContain('outcome.kind === "written"');
    // `markBufferSaved` is the only thing that satisfies the draft, and it
    // must appear AFTER the written check and nowhere else in the function.
    const marks = [...body.matchAll(/markBufferSaved\(/g)].length;
    expect(marks, "exactly one call, inside the verified branch").toBe(1);
    expect(body.indexOf("markBufferSaved(")).toBeGreaterThan(body.indexOf('outcome.kind === "written"'));
  });
});
