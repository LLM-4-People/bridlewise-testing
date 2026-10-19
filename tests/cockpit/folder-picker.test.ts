// @vitest-environment node
/**
 * THE FOLDER PICKER — the state machine, in Node (no DOM, no fetch).
 *
 * What must hold, and the mutations each one refuses:
 *   - the visible list is DERIVED from state (anchor + expanded + reads) —
 *     a machine that mutated a nested node tree instead would fail the
 *     expansion/collapse derivations;
 *   - a directory is read EXACTLY ONCE per open picker (`needsRead`), and a
 *     refusal is KEPT with the refusal's words (never folded into "empty");
 *   - the keyboard walk is the APG tree grammar: Right opens a closed row,
 *     Left closes an open row, Up/Down move within the visible rows,
 *     clamped at the ends;
 *   - the picker can never name a path the server did not say (the state
 *     machine has no path-arithmetic over raw input — a name becomes a
 *     folder only through the server's mkdir answer);
 *   - a new-folder name is validated BEFORE the server is asked, and the
 *     refusal names why.
 */
import { describe, expect, test } from "vitest";

import {
  applyListing,
  applyRefusal,
  enterDirectory,
  focusPath,
  initialPickerState,
  markReading,
  moveFocus,
  needsRead,
  newFolderNameProblem,
  selectPath,
  stepUp,
  toggleExpanded,
  visibleRows,
  type PickerListing,
} from "../../src/cockpit/rooms/folder-picker.ts";

const ROOTS = [
  { name: "home", path: "/home/u", accessible: true },
  { name: "srv", path: "/srv", accessible: true },
] as const;

function listing(path: string, parent: string | null, names: readonly string[]): PickerListing {
  return {
    path,
    parent,
    accessible: true,
    entries: names.map((name) => ({ name, path: `${path}/${name}`, accessible: true })),
  };
}

describe("the visible list is derived from state", () => {
  test("the opening view is the roots, one row each", () => {
    const s = initialPickerState([...ROOTS]);
    const rows = visibleRows(s);
    expect(rows.map((r) => (r.kind === "dir" ? r.entry.path : "up"))).toEqual(["/home/u", "/srv"]);
  });

  test("entering a directory anchors the listing and shows its children", () => {
    let s = initialPickerState([...ROOTS]);
    s = enterDirectory(s, "/home/u");
    s = applyListing(s, listing("/home/u", null, ["a", "b"]));
    const rows = visibleRows(s);
    // No parent (parent: null) ⇒ no up row.
    expect(rows.map((r) => (r.kind === "dir" ? r.entry.path : "up"))).toEqual(["/home/u/a", "/home/u/b"]);
  });

  test("an anchor with a parent offers the up row first", () => {
    let s = initialPickerState([...ROOTS]);
    s = enterDirectory(s, "/home/u/a");
    s = applyListing(s, listing("/home/u/a", "/home/u", ["x"]));
    const rows = visibleRows(s);
    expect(rows[0]).toMatchObject({ kind: "up", path: "/home/u" });
    expect(rows[1]).toMatchObject({ kind: "dir" });
  });

  test("expansion nests children under their directory; collapse hides them", () => {
    let s = initialPickerState([...ROOTS]);
    s = enterDirectory(s, "/home/u");
    s = applyListing(s, listing("/home/u", null, ["a"]));
    s = applyListing(s, listing("/home/u/a", "/home/u", ["deep"]));
    s = toggleExpanded(s, "/home/u/a");
    const open = visibleRows(s).map((r) => (r.kind === "dir" ? r.entry.path : "up"));
    expect(open).toEqual(["/home/u/a", "/home/u/a/deep"]);
    // The nested row is one level deeper and knows its parent row.
    const deep = visibleRows(s)[1]!;
    expect(deep.kind).toBe("dir");
    if (deep.kind === "dir") {
      expect(deep.depth).toBe(1);
      expect(deep.parentPath).toBe("/home/u/a");
    }
    s = toggleExpanded(s, "/home/u/a");
    const closed = visibleRows(s).map((r) => (r.kind === "dir" ? r.entry.path : "up"));
    expect(closed).toEqual(["/home/u/a"]);
  });
});

describe("reads are exactly-once and refusals are kept", () => {
  test("needsRead is true only before any answer arrives", () => {
    let s = initialPickerState([...ROOTS]);
    expect(needsRead(s, "/home/u")).toBe(true);
    s = markReading(s, "/home/u");
    expect(needsRead(s, "/home/u")).toBe(false);
    s = applyListing(s, listing("/home/u", null, []));
    expect(needsRead(s, "/home/u")).toBe(false);
  });

  test("a refused read keeps the refusal's words on the row", () => {
    let s = initialPickerState([...ROOTS]);
    s = enterDirectory(s, "/home/u");
    s = applyListing(s, listing("/home/u", null, ["a"]));
    s = applyRefusal(s, "/home/u/a", "outside the folders this server lets you browse");
    const row = visibleRows(s)[0]!;
    expect(row.kind).toBe("dir");
    if (row.kind === "dir") {
      expect(row.state).toEqual({ kind: "refused", reason: "outside the folders this server lets you browse" });
    }
    // A refusal is a KNOWN answer — it is not re-asked in a loop.
    expect(needsRead(s, "/home/u/a")).toBe(false);
  });

  test("markReading is idempotent (a second mark does not churn state)", () => {
    let s = initialPickerState([...ROOTS]);
    s = markReading(s, "/home/u");
    const once = s;
    s = markReading(s, "/home/u");
    expect(s).toBe(once);
  });
});

describe("the keyboard walk (APG tree grammar)", () => {
  function walkedState(): ReturnType<typeof initialPickerState> {
    let s = initialPickerState([...ROOTS]);
    s = enterDirectory(s, "/home/u");
    s = applyListing(s, listing("/home/u", null, ["a", "b", "c"]));
    return s;
  }

  test("Down/Up walk the visible rows, clamped at both ends", () => {
    let s = walkedState();
    s = focusPath(s, null);
    s = moveFocus(s, 1);
    expect(s.focus).toBe("/home/u/a");
    s = moveFocus(s, 1);
    expect(s.focus).toBe("/home/u/b");
    // Clamp at the bottom.
    s = moveFocus(s, 5);
    expect(s.focus).toBe("/home/u/c");
    // Clamp at the top.
    s = moveFocus(s, -10);
    expect(s.focus).toBe("/home/u/a");
  });

  test("the up-row is not a focusable position", () => {
    let s = initialPickerState([...ROOTS]);
    s = enterDirectory(s, "/home/u/a");
    s = applyListing(s, listing("/home/u/a", "/home/u", ["x", "y"]));
    s = focusPath(s, null);
    s = moveFocus(s, 1);
    // First focusable is the first DIRECTORY, not the up verb.
    expect(s.focus).toBe("/home/u/a/x");
  });

  test("expanding focuses nothing new; the walk reaches the new rows", () => {
    let s = walkedState();
    s = applyListing(s, listing("/home/u/b", "/home/u", ["inner"]));
    s = focusPath(s, "/home/u/b");
    s = toggleExpanded(s, "/home/u/b");
    s = moveFocus(s, 1);
    expect(s.focus).toBe("/home/u/b/inner");
  });
});

describe("up navigation", () => {
  test("stepUp walks to the anchor's parent", () => {
    let s = initialPickerState([...ROOTS]);
    s = enterDirectory(s, "/home/u/a");
    s = applyListing(s, listing("/home/u/a", "/home/u", []));
    s = stepUp(s);
    expect(s.at).toBe("/home/u");
  });

  test("stepUp at a parentless root returns to the roots view", () => {
    let s = initialPickerState([...ROOTS]);
    s = enterDirectory(s, "/home/u");
    s = applyListing(s, listing("/home/u", null, []));
    s = stepUp(s);
    expect(s.at).toBe(null);
    expect(visibleRows(s).map((r) => (r.kind === "dir" ? r.entry.path : "up"))).toEqual([
      "/home/u",
      "/srv",
    ]);
  });
});

describe("the answer is always a server-said path", () => {
  test("selection records the chosen path", () => {
    let s = initialPickerState([...ROOTS]);
    s = selectPath(s, "/home/u/a");
    expect(s.selected).toBe("/home/u/a");
    expect(s.focus).toBe("/home/u/a");
  });
});

describe("a new folder's name is validated before the server is asked", () => {
  test("an empty name is refused", () => {
    expect(newFolderNameProblem("   ")).toBe("a name is needed");
  });
  test("dot segments are refused", () => {
    expect(newFolderNameProblem(".")).not.toBeNull();
    expect(newFolderNameProblem("..")).not.toBeNull();
  });
  test("separators are refused", () => {
    expect(newFolderNameProblem("a/b")).not.toBeNull();
    expect(newFolderNameProblem("a\\b")).not.toBeNull();
  });
  test("a real name passes", () => {
    expect(newFolderNameProblem("my project")).toBeNull();
  });
});
