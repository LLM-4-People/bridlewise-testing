// @vitest-environment node
/**
 * THE DELETE SHIELD — deleting a file cannot happen by accident, and cannot
 * happen to the wrong file.
 *
 * Deletion MOVES the file to the harness recycle bin. Restore puts it back.
 * The shield is still a RULE (a pure function under test), not a click-through
 * dialog: stray clicks must not recycle a file.
 *
 * Three independent conditions, each proven here and each MUTATED to show the
 * guard can actually fail:
 *
 *   ARMED   — for this exact path, and recently.
 *   REACHED — a pointer or focus arrived on the confirm control AFTER it had
 *             existed long enough for an in-flight click to have landed.
 *   NAMED   — the file's own name was typed. No accident types a word.
 *
 * The last one is the one that cannot be satisfied by any sequence of clicks,
 * which is why it is not optional and why it is what makes the confirmation
 * state WHICH file is about to be destroyed.
 */
import { describe, expect, test } from "vitest";

import {
  deleteBlockReason,
  deleteLossLine,
  deleteReady,
  type DeleteArm,
  type DeleteReach,
} from "../../src/cockpit/editor/destructive.ts";
import {
  DELETE_CONFIRM_SETTLE_MS,
  DELETE_CONFIRM_WINDOW_MS,
} from "../../src/cockpit/editor/editor-config.ts";
import { read, stripCommentsOnlyFor } from "../helpers/source-scan.ts";

const T0 = 1_000_000;

const ARM: DeleteArm = {
  path: "/proj/src/notes.md",
  name: "notes.md",
  isDirectory: false,
  armedAt: T0,
};

/** A reach that satisfies every condition — each test breaks exactly one. */
function goodReach(over: Partial<DeleteReach> = {}): DeleteReach {
  return {
    arm: ARM,
    reachedAt: T0 + DELETE_CONFIRM_SETTLE_MS + 10,
    typedName: ARM.name,
    now: T0 + DELETE_CONFIRM_SETTLE_MS + 20,
    targetPath: ARM.path,
    ...over,
  };
}

describe("all three conditions together, and only together", () => {
  test("the complete reach is ready", () => {
    expect(deleteBlockReason(goodReach())).toBeNull();
    expect(deleteReady(goodReach())).toBe(true);
  });

  test("nothing armed → refused, and it SAYS so", () => {
    const why = deleteBlockReason(goodReach({ arm: null }));
    expect(why).toBe("nothing is armed for deletion");
  });

  test("armed for ANOTHER file → refused (a confirmation cannot be redirected)", () => {
    const why = deleteBlockReason(goodReach({ targetPath: "/proj/src/other.md" }));
    expect(why, "arming one file and deleting another is the worst possible bug here").toContain(
      "armed for a different file",
    );
  });

  test("expired → refused, with the way to try again", () => {
    const why = deleteBlockReason(
      goodReach({ now: T0 + DELETE_CONFIRM_WINDOW_MS + 1, typedName: ARM.name }),
    );
    expect(why).toContain("timed out");
    expect(why).toContain("press delete again");
  });
});

describe("REACHED — a stray click cannot press it", () => {
  test("a pointer that never arrived → refused", () => {
    expect(deleteBlockReason(goodReach({ reachedAt: null }))).toContain("move onto this button");
  });

  test("a control that APPEARED UNDER a stationary pointer → refused", () => {
    // The button reports an arrival at ~armedAt because it materialised there.
    // That is precisely the second half of a double click, and it is refused.
    const why = deleteBlockReason(goodReach({ reachedAt: T0, now: T0 + 1 }));
    expect(why).toContain("stray click");
  });

  test("an arrival one millisecond inside the settling window → still refused", () => {
    const why = deleteBlockReason(goodReach({ reachedAt: T0 + DELETE_CONFIRM_SETTLE_MS - 1 }));
    expect(why).toContain("stray click");
  });

  test("an arrival exactly at the settling boundary → allowed", () => {
    expect(deleteBlockReason(goodReach({ reachedAt: T0 + DELETE_CONFIRM_SETTLE_MS }))).toBeNull();
  });
});

describe("NAMED — the condition no accident satisfies", () => {
  test("nothing typed → refused, and the sentence names the file", () => {
    const why = deleteBlockReason(goodReach({ typedName: "" }));
    expect(why).toContain("notes.md");
    expect(why).toContain("recycle bin");
    expect(why).not.toMatch(/cannot be undone|nothing here can bring it back/i);
  });

  test("a near miss is not a match (case, whitespace, prefix)", () => {
    for (const typed of ["Notes.md", "notes.md ", " notes.md", "notes", "notes.mdx"]) {
      expect(deleteBlockReason(goodReach({ typedName: typed })), `"${typed}"`).not.toBeNull();
    }
  });

  test("the exact name is the only thing that passes", () => {
    expect(deleteBlockReason(goodReach({ typedName: "notes.md" }))).toBeNull();
  });
});

describe("the loss is stated, and never overstated", () => {
  test("a file states its measured size", () => {
    expect(deleteLossLine(ARM, 4096)).toContain("4,096 bytes");
    expect(deleteLossLine(ARM, 4096)).toContain("notes.md");
    expect(deleteLossLine(ARM, 4096)).toContain("recycle bin");
    expect(deleteLossLine(ARM, 4096)).not.toMatch(/cannot be undone|nothing here can bring it back/i);
  });

  test("an unmeasured size is omitted rather than guessed at", () => {
    expect(deleteLossLine(ARM, null)).not.toMatch(/\d/);
  });

  test("a FOLDER says everything inside goes, and invents no count", () => {
    const folder: DeleteArm = { ...ARM, name: "src", isDirectory: true };
    const line = deleteLossLine(folder, null);
    expect(line).toContain("everything inside it");
    expect(line, "the room has not walked the folder, so it must not claim a number").not.toMatch(
      /\d+ files?/,
    );
  });
});

// ── MUTATION SELF-CHECKS ──────────────────────────────────────────────────

describe("mutation — each weakened rule really does let the delete through", () => {
  test("MUTATION: dropping the NAME condition lets a pure-click delete fire", () => {
    // Model the rule without its last condition. Everything a mouse can do is
    // now sufficient, which is exactly what the real rule refuses.
    const withoutName = (r: DeleteReach): boolean =>
      r.arm !== null &&
      r.arm.path === r.targetPath &&
      r.now - r.arm.armedAt <= DELETE_CONFIRM_WINDOW_MS &&
      r.reachedAt !== null &&
      r.reachedAt - r.arm.armedAt >= DELETE_CONFIRM_SETTLE_MS;
    const clicksOnly = goodReach({ typedName: "" });
    expect(withoutName(clicksOnly), "the weakened rule fires").toBe(true);
    expect(deleteReady(clicksOnly), "the real rule does not").toBe(false);
  });

  test("MUTATION: dropping the SETTLING condition lets the click-through fire", () => {
    const withoutSettle = (r: DeleteReach): boolean =>
      r.arm !== null && r.arm.path === r.targetPath && r.typedName === r.arm.name;
    const materialisedUnderPointer = goodReach({ reachedAt: T0, now: T0 + 1 });
    expect(withoutSettle(materialisedUnderPointer)).toBe(true);
    expect(deleteReady(materialisedUnderPointer)).toBe(false);
  });

  test("MUTATION: dropping the PATH condition deletes the wrong file", () => {
    const withoutPath = (r: DeleteReach): boolean =>
      r.arm !== null && r.typedName === r.arm.name && r.reachedAt !== null;
    const redirected = goodReach({ targetPath: "/proj/src/production.ts" });
    expect(withoutPath(redirected)).toBe(true);
    expect(deleteReady(redirected)).toBe(false);
  });
});

// ── STATIC: the rule is the only way in ──────────────────────────────────

describe("static — nothing reaches the delete except through the rule", () => {
  const CONFIRM = "src/cockpit/editor/DeleteConfirm.svelte";
  const ROOM = "src/cockpit/rooms/EditorRoom.svelte";

  test("the confirm control re-judges the rule AT THE PRESS, not from a stale value", () => {
    const src = stripCommentsOnlyFor(read(CONFIRM), CONFIRM);
    const fn = /function confirm\(\): void \{([\s\S]*?)\n  \}/.exec(src);
    expect(fn, "the confirm handler must exist").not.toBeNull();
    expect(
      fn![1]!,
      "a `disabled` attribute computed half a second ago must not be what lets a delete through",
    ).toMatch(/deleteBlockReason\(\{[^}]*now:\s*Date\.now\(\)/);
    expect(fn![1]!, "…and it must refuse rather than continue").toContain("return");
  });

  test("the room's delete is reachable ONLY from the confirmation", () => {
    const src = stripCommentsOnlyFor(read(ROOM), ROOM);
    // `removePath` (the deleting door) may appear exactly once, inside the
    // confirmed-delete function.
    const calls = [...src.matchAll(/removePath\(/g)];
    expect(calls, "one call site — the confirmed delete").toHaveLength(1);
    const fn = /async function confirmDelete\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(src);
    expect(fn, "confirmDelete must exist").not.toBeNull();
    expect(fn![1]!, "and that call site is inside it").toContain("removePath(");
    expect(fn![1]!, "…guarded by something actually being armed").toMatch(/armed === null/);
  });

  test("no tree row can delete anything (the list is not a destructive surface)", () => {
    const tree = stripCommentsOnlyFor(read("src/cockpit/editor/FileTree.svelte"), "src/cockpit/editor/FileTree.svelte");
    expect(tree, "a delete on a row is one stray click away from a lost file").not.toMatch(
      /ondelete|removePath|deleteEditorFile/,
    );
  });

  test("the confirmation is a Popover alertdialog, so Esc closes it first", () => {
    const pane = stripCommentsOnlyFor(read("src/cockpit/editor/FilePane.svelte"), "src/cockpit/editor/FilePane.svelte");
    expect(pane).toMatch(/<Popover[^>]*kind="alertdialog"/);
    expect(pane).toMatch(/<DeleteConfirm/);
    expect(stripCommentsOnlyFor(read(ROOM), ROOM)).not.toMatch(/pushDismiss\(\{\s*label:\s*"the delete confirmation"/);
  });
});
