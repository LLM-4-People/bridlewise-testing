// @vitest-environment jsdom
/**
 * EDITOR BUFFER OWNER — an unsaved edit survives EVERY way out of the room.
 *
 * The harness has lost a user's work in an editor before, and the fix that
 * held was structural rather than a check: no code path may take the buffer
 * away from a live draft without SAYING what happens to that draft, and every
 * navigation path says "keep it".
 *
 * This file proves the property the room actually promises, path by path:
 *
 *   A. clicking another file in the tree keeps it;
 *   B. switching FILE and coming back restores it, with its own preimage;
 *   C. closing the room keeps it;
 *   D. switching project / workspace keeps it;
 *   E. signing out keeps it (the store reset PARKS, it does not clear);
 *   F. a RELOAD keeps it — the write-through is read back by a buffer in the
 *      state a fresh page leaves it in (see `freshBuffer` below);
 *   G. only two paths destroy work, and both are the user saying so.
 *
 * Every one is MUTATION-TESTED below: the destructive shape is modelled
 * directly and shown to break the assertion that covers it, so a guard that
 * could not fail cannot pass here.
 *
 * The STATIC half is what keeps the property from being re-lost by a future
 * edit: the room's sources may not call the destructive disposition anywhere
 * except at the two controls that mean it, and the buffer may not grow a
 * second, unguarded write path.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { authState, initialAuth } from "../../src/state/auth.ts";
import * as buffer from "../../src/cockpit/editor/buffer.ts";
import { read, relpath, stripCommentsAndStringsFor, walk } from "../helpers/source-scan.ts";

const BUFFER = "src/cockpit/editor/buffer.ts";
const EDITOR_SOURCES = ["src/cockpit/editor", "src/cockpit/rooms/EditorRoom.svelte"];

/**
 * THE BUFFER AS A PAGE RELOAD LEAVES IT: signed in as `user`, nothing in
 * memory, the browser's storage untouched.
 *
 * That is exactly the state a fresh module instance starts in — the live
 * buffer empty, no parked drafts held, and no user loaded — so the next call
 * into the module runs its lazy restore against whatever storage holds. Every
 * "survives a reload" claim in this file rests on this shape.
 *
 * It is deliberately NOT `vi.resetModules()`. This suite runs under
 * `isolate: false`, where the module registry is shared across every file in
 * the worker: resetting it here silently re-instantiated other suites'
 * singletons and broke thirteen tests in two unrelated files. A test that
 * damages its neighbours is a worse guard than the one it replaces.
 */
function freshBuffer(user = "ada"): typeof buffer {
  authState.set({ ...initialAuth, authenticated: true, username: user });
  buffer.forgetEditorBufferForTests();
  return buffer;
}

const FILE_A = {
  projectId: "p1",
  projectPath: "/proj",
  apiPath: "/proj/src/deep/nested/reader.ts",
  relativePath: "src/deep/nested/reader.ts",
  name: "reader.ts",
  language: "typescript",
  size: 120,
} as const;

const FILE_B = {
  projectId: "p1",
  projectPath: "/proj",
  apiPath: "/proj/src/deep/nested/writer.ts",
  relativePath: "src/deep/nested/writer.ts",
  name: "writer.ts",
  language: "typescript",
  size: 80,
} as const;

const FILE_OTHER_PROJECT = { ...FILE_A, projectId: "p2", projectPath: "/other" };

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  authState.set(initialAuth);
});

describe("A–D. every navigation path KEEPS the edit", () => {
  test("A. opening another file parks the draft and B. returning restores it", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "on disk", "park");
    b.beginBufferEdit();
    b.setBufferDraft("my unsaved words");
    expect(b.bufferIsDirty(b.fileBuffer.get())).toBe(true);

    // The tree click: the room parks, then opens the other file.
    b.openBufferFile(FILE_B, "other file", "park");
    expect(b.fileBuffer.get().draft).toBeNull();
    expect(b.parkedDrafts().map((d) => d.file.apiPath)).toEqual([FILE_A.apiPath]);

    // …and back.
    b.openBufferFile(FILE_A, "on disk", "park");
    const state = b.fileBuffer.get();
    expect(state.draft).toBe("my unsaved words");
    expect(state.restored, "a restored draft must announce itself").toBe(true);
    expect(state.base, "…and must keep the preimage it was written against").toBe("on disk");
  });

  test("B2. a restored draft keeps its OWN base even when the file changed on disk", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "version one", "park");
    b.beginBufferEdit();
    b.setBufferDraft("version one, edited");
    b.openBufferFile(FILE_B, "b", "park");
    // The file changed underneath while the draft was parked.
    b.openBufferFile(FILE_A, "version TWO, written by an agent", "park");
    expect(
      b.bufferPendingSave(b.fileBuffer.get())?.preimage,
      "the save must carry the OLD preimage so the server refuses it — " +
        "refreshing the base would turn a rejected save into a clobbered file",
    ).toBe("version one");
  });

  test("C. closing the room keeps it", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "on disk", "park");
    b.beginBufferEdit();
    b.setBufferDraft("half a sentence");
    b.closeBufferFile("park");
    expect(b.fileBuffer.get().file).toBeNull();
    expect(b.parkedDrafts()).toHaveLength(1);
    expect(b.parkedDrafts()[0]!.draft).toBe("half a sentence");
  });

  test("D. switching project keeps it, and the other project does not see it", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "on disk", "park");
    b.beginBufferEdit();
    b.setBufferDraft("project one's words");
    // The room's project-change effect.
    b.closeBufferFile("park");
    // The same PATH under a different project id is a different draft.
    b.openBufferFile(FILE_OTHER_PROJECT, "on disk", "park");
    expect(b.fileBuffer.get().draft, "another project must not inherit the draft").toBeNull();
    expect(b.parkedDrafts().map((d) => d.file.projectId)).toEqual(["p1"]);
  });
});

describe("E. signing out parks — it does not clear", () => {
  test("the registered store reset keeps the work under the outgoing user", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "on disk", "park");
    b.beginBufferEdit();
    b.setBufferDraft("written just before signing out");
    b.resetEditorBuffer();
    expect(b.fileBuffer.get().file, "the buffer itself is cleared").toBeNull();

    // Signing back in as the same person finds it.
    const after = freshBuffer("ada");
    expect(after.parkedDrafts()[0]?.draft).toBe("written just before signing out");
  });

  test("another user does NOT see it", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "on disk", "park");
    b.beginBufferEdit();
    b.setBufferDraft("ada's private words");
    b.resetEditorBuffer();

    const other = freshBuffer("grace");
    expect(other.parkedDrafts(), "a draft is keyed by user; the next person sees none").toEqual([]);
  });
});

describe("F. a RELOAD keeps it", () => {
  test("a fresh module instance reads the live draft back out of storage", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "on disk", "park");
    b.beginBufferEdit();
    b.setBufferDraft("typed, never saved, then the tab reloaded");
    // The exit handlers do this; call it directly so the test does not depend
    // on jsdom firing pagehide.
    b.flushEditorDrafts();

    const afterReload = freshBuffer();
    const kept = afterReload.parkedDrafts();
    expect(kept, "the reload must find the edit").toHaveLength(1);
    expect(kept[0]!.draft).toBe("typed, never saved, then the tab reloaded");
    expect(kept[0]!.base, "…with the preimage it was written against").toBe("on disk");
    // And it comes back on reopen, in edit mode.
    afterReload.openBufferFile(FILE_A, "on disk", "park");
    expect(afterReload.fileBuffer.get().draft).toBe("typed, never saved, then the tab reloaded");
  });

  test("the first keystroke is persisted immediately (leading edge), not after a delay", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "on disk", "park");
    b.beginBufferEdit();
    b.setBufferDraft("x");
    // NOTHING is flushed by hand here — this is the write-through's own job.
    const raw = localStorage.getItem("bridlewise:cockpit-editor-drafts:ada");
    expect(raw, "an edit not yet written anywhere is an edit a crash loses").not.toBeNull();
    expect(raw!).toContain("\"draft\":\"x\"");
  });

  test("a corrupted storage slot loses that entry and nothing else", async () => {
    localStorage.setItem("bridlewise:cockpit-editor-drafts:ada", "{not json");
    const b = freshBuffer();
    expect(b.parkedDrafts(), "a half-parsed draft is text we cannot vouch for").toEqual([]);
    // …and the buffer still works afterwards.
    b.openBufferFile(FILE_A, "on disk", "park");
    expect(b.fileBuffer.get().file?.apiPath).toBe(FILE_A.apiPath);
  });
});

describe("G. only a deliberate act destroys work", () => {
  test("discard drops the live draft AND any older park for that file", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "on disk", "park");
    b.beginBufferEdit();
    b.setBufferDraft("first attempt");
    b.closeBufferFile("park");
    b.openBufferFile(FILE_A, "on disk", "park");
    b.setBufferDraft("second attempt");
    b.endBufferEdit("discard");
    expect(b.fileBuffer.get().draft).toBeNull();
    expect(b.parkedDrafts(), "a discarded edit must not reappear on the next open").toEqual([]);
  });

  test("discarding a PARKED draft by name removes exactly that one", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "a", "park");
    b.beginBufferEdit();
    b.setBufferDraft("keep me");
    b.openBufferFile(FILE_B, "b", "park");
    b.beginBufferEdit();
    b.setBufferDraft("drop me");
    b.closeBufferFile("park");
    b.discardParkedDraft(FILE_B);
    expect(b.parkedDrafts().map((d) => d.file.name)).toEqual([FILE_A.name]);
  });

  test("a save satisfies the draft but does not end the edit session", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "on disk", "park");
    b.beginBufferEdit();
    b.setBufferDraft("saved words");
    b.markBufferSaved("saved words");
    const state = b.fileBuffer.get();
    // The session the screen still shows stays live: the saved text is both
    // the base and the draft, so nothing is UNSAVED (draft === base) and the
    // next keystroke extends a live session. Retiring the draft here was the
    // silent data-entry loss: a live edit-mode textarea over a draft-less
    // buffer swallowed every keystroke (UIE-012).
    expect(state.draft, "the edit session survives its own save").toBe("saved words");
    expect(state.base, "the new base is what was written").toBe("saved words");
    expect(b.bufferIsDirty(state)).toBe(false);
    expect(b.parkedDrafts()).toEqual([]);
    // …and typing on from there registers instead of dying on the null guard.
    b.setBufferDraft("saved words, and more");
    expect(b.fileBuffer.get().draft).toBe("saved words, and more");
    expect(b.bufferIsDirty(b.fileBuffer.get())).toBe(true);
  });
});

describe("the buffer cannot be written from outside", () => {
  test("the exported handle has no setter AT RUNTIME (not merely in its type)", async () => {
    const b = freshBuffer();
    const handle = b.fileBuffer as unknown as Record<string, unknown>;
    expect(handle.set, "a `set` here is a second writer — a cast defeats a type, not this").toBeUndefined();
    expect(Object.isFrozen(b.fileBuffer)).toBe(true);
  });

  test("`beginBufferEdit` cannot overwrite an existing draft", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "on disk", "park");
    b.beginBufferEdit();
    b.setBufferDraft("in progress");
    b.beginBufferEdit();
    expect(b.fileBuffer.get().draft, "re-entering edit mode must not reset the text").toBe(
      "in progress",
    );
  });
});

// ── MUTATION SELF-CHECKS ──────────────────────────────────────────────────
//
// Each models the DESTRUCTIVE shape directly and shows the property the guard
// above asserts is the one that breaks. A guard whose mutation still passes is
// a guard that proves nothing.

describe("mutation — the destructive shapes really do fail these assertions", () => {
  test("MUTATION: a navigation that says `discard` loses the edit (A/C/D would fail)", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "on disk", "park");
    b.beginBufferEdit();
    b.setBufferDraft("about to be lost");
    // The mutation: the room passes "discard" where it passes "park".
    b.openBufferFile(FILE_B, "b", "discard");
    expect(b.parkedDrafts(), "this is exactly the data loss the room must not have").toEqual([]);
  });

  test("MUTATION: a reset that CLEARS instead of parking loses it (E would fail)", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "on disk", "park");
    b.beginBufferEdit();
    b.setBufferDraft("about to be lost");
    // The mutation: a sign-out reset that resolves "discard".
    b.endBufferEdit("discard");
    b.closeBufferFile("discard");
    b.flushEditorDrafts();
    const after = freshBuffer();
    expect(after.parkedDrafts()).toEqual([]);
  });

  test("MUTATION: without the write-through a reload finds nothing (F would fail)", async () => {
    const b = freshBuffer();
    b.openBufferFile(FILE_A, "on disk", "park");
    b.beginBufferEdit();
    b.setBufferDraft("typed");
    // The mutation: storage is unavailable / never written.
    localStorage.clear();
    const after = freshBuffer();
    expect(after.parkedDrafts()).toEqual([]);
  });
});

// ── STATIC: the shape cannot be re-lost by a later edit ───────────────────

describe("static — the disposition is stated at every call site, and `discard` is rare", () => {
  const sources = EDITOR_SOURCES.flatMap((p) =>
    p.endsWith(".svelte") ? [p] : walk(p, { exts: [".ts", ".svelte"] }).map(relpath),
  );

  test("the scan found the room's sources (it is not vacuous)", () => {
    expect(sources.length).toBeGreaterThan(4);
    expect(sources).toContain("src/cockpit/rooms/EditorRoom.svelte");
  });

  test("every mutator that can take the buffer away REQUIRES a disposition", () => {
    const src = read(BUFFER);
    for (const fn of ["openBufferFile", "closeBufferFile", "endBufferEdit"]) {
      const sig = new RegExp(`export function ${fn}\\(([^)]*)\\)`, "s").exec(src);
      expect(sig, `${fn} must exist`).not.toBeNull();
      expect(
        sig![1]!,
        `${fn} must take a PendingWork with no default — an optional disposition is a forgettable one`,
      ).toMatch(/pending:\s*PendingWork/);
      expect(sig![1]!, `${fn}'s disposition must not have a default`).not.toMatch(
        /pending:\s*PendingWork\s*=/,
      );
    }
  });

  test("`discard` appears at exactly the places that MEAN it", () => {
    const hits: string[] = [];
    for (const file of sources) {
      if (file === BUFFER) continue; // the owner defines the vocabulary
      const code = stripCommentsAndStringsFor(read(file), file);
      // The stripper removes string literals, so the disposition survives only
      // as the quoted argument — scan the raw source for the call form.
      for (const m of read(file).matchAll(/(?:closeBufferFile|endBufferEdit|openBufferFile)\(\s*(?:[^)]*?,\s*)?"discard"\s*\)/g)) {
        hits.push(`${file}: ${m[0]}`);
        void code;
      }
    }
    // Exactly two: `discard changes` (the user throwing away their own edit)
    // and the confirmed delete (keeping a draft for a deleted file would offer
    // to write it back).
    expect(
      hits,
      `"discard" destroys unsaved work. Every occurrence must be a control whose whole ` +
        `meaning is "throw this away". Found:\n${hits.join("\n")}`,
    ).toHaveLength(2);
  });

  test("the buffer holds no SECOND write path to its state", () => {
    const code = stripCommentsAndStringsFor(read(BUFFER), BUFFER);
    const writes = [...code.matchAll(/buffer\.set\(/g)].length;
    // open (2 branches), close, begin, setDraft, end, markSaved, reset,
    // forget-for-tests. Every one is inside an exported mutator that either
    // cannot lose work or demands a disposition. A tenth would be a path
    // nobody has argued about.
    expect(
      writes,
      "a new `buffer.set` is a new way to replace the user's text — argue for it here first",
    ).toBeLessThanOrEqual(9);
    expect(code, "the atom itself must stay module-private").not.toMatch(/export\s+const\s+buffer\b/);
  });
});
