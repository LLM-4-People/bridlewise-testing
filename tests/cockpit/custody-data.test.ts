// @vitest-environment node
/**
 * CUSTODY — pure data helpers (§7.2), mutation-armed.
 *
 * Everything the room renders comes through these functions, so their
 * honesty properties are pinned at the unit: defensive decoding (malformed
 * wire → null, never a guess), the suggested message QUOTES the producing
 * turn's own words (never invents one), the loss line is exact arithmetic
 * over the parcel's measured counts, new files are never offered to undo,
 * and the reel badge counts ONLY conversation-attributed files.
 */
import { describe, expect, test } from "vitest";

import {
  SUGGESTION_CAP,
  countPatch,
  countsLine,
  custodyCountsByChat,
  decodeCustodyHistory,
  decodeCustodyState,
  lossLine,
  parcelTitle,
  suggestedMessage,
  undoableFiles,
  undoConfirmBlockReason,
  undoConfirmReady,
  emptyPatchLine,
  UNRESTORABLE_STATES,
  type CustodyStateWire,
  type ParcelWire,
} from "../../src/cockpit/rooms/custody-data.ts";
import {
  UNDO_CONFIRM_SETTLE_MS,
  UNDO_CONFIRM_WINDOW_MS,
} from "../../src/cockpit/rooms/custody-config.ts";

const CONV = {
  kind: "conversation" as const,
  runId: "run-1",
  chatId: "c1",
  chatTitle: "fix flaky test",
  turn: 7,
  requestText: "refactor the reader path\nand keep the tests green",
  lastTouchedAt: "2026-07-25T14:02:00Z",
};

const FILES = [
  { path: "a.ts", state: "changed", insertions: 42, deletions: 8 },
  { path: "b.ts", state: "changed", insertions: 11, deletions: 0 },
  { path: "n.md", state: "new", insertions: null, deletions: null, countsAbsentReason: "new file" },
] as const;

const PARCEL: ParcelWire = {
  id: "run-1",
  attribution: CONV,
  files: FILES,
  insertions: 53,
  deletions: 8,
  derivation: "t",
};

function stateWith(parcels: readonly ParcelWire[]): CustodyStateWire {
  return {
    repository: true,
    branch: "main",
    parcels,
    join: {
      changedFiles: 3,
      attributedFiles: 2,
      filesBeyondPathCap: 0,
      fileEffectEventsExamined: 9,
      undecodableEffects: 0,
      truncated: false,
      withheldRuns: 0,
    },
  };
}

describe("defensive decoding — malformed wire is null, never a guess", () => {
  test("a valid state decodes; each mutilation is refused", () => {
    const good = stateWith([PARCEL]);
    expect(decodeCustodyState(good)).not.toBeNull();
    expect(decodeCustodyState(null)).toBeNull();
    expect(decodeCustodyState("nope")).toBeNull();
    expect(decodeCustodyState({ ...good, repository: "yes" })).toBeNull();
    expect(decodeCustodyState({ ...good, parcels: "none" })).toBeNull();
    expect(decodeCustodyState({ ...good, join: 4 })).toBeNull();
    expect(decodeCustodyState({ ...good, parcels: [{ id: 1 }] })).toBeNull();
    expect(decodeCustodyState({ ...good, parcels: [{ ...PARCEL, attribution: "x" }] })).toBeNull();
  });

  test("history decodes the same way", () => {
    const good = { repository: true, commits: [{ hash: "h", message: "m" }], remoteConfigured: false };
    expect(decodeCustodyHistory(good)).not.toBeNull();
    expect(decodeCustodyHistory({ ...good, commits: [{ hash: 1 }] })).toBeNull();
    expect(decodeCustodyHistory({ ...good, repository: 1 })).toBeNull();
    expect(decodeCustodyHistory([])).toBeNull();
  });
});

describe("the suggested message quotes the request's own words", () => {
  test("first line, marked as from the request", () => {
    expect(suggestedMessage(CONV)).toEqual({ text: "refactor the reader path", fromRequest: true });
  });

  test("long requests are capped with an ellipsis", () => {
    const long = { ...CONV, requestText: "x".repeat(200) };
    const s = suggestedMessage(long);
    expect(s.text.length).toBe(SUGGESTION_CAP);
    expect(s.text.endsWith("…")).toBe(true);
  });

  test("MUTATION: no recorded words → an EMPTY suggestion, never an invented one", () => {
    expect(suggestedMessage({ ...CONV, requestText: null })).toEqual({ text: "", fromRequest: false });
    expect(suggestedMessage({ kind: "outside", reason: "r" })).toEqual({ text: "", fromRequest: false });
    expect(suggestedMessage({ ...CONV, requestText: "  \n" })).toEqual({ text: "", fromRequest: false });
  });
});

describe("parcel language", () => {
  test("titles speak conversations, not git nouns", () => {
    expect(parcelTitle(CONV)).toBe("from “fix flaky test” · turn 7");
    expect(parcelTitle({ ...CONV, turn: null })).toBe("from “fix flaky test”");
    expect(parcelTitle({ kind: "outside", reason: "r" })).toBe("not from a recorded conversation");
  });

  test("counts render measured pairs; absence renders empty", () => {
    expect(countsLine(42, 8)).toBe("+42 −8");
    expect(countsLine(null, 8)).toBe("");
  });

  test("the loss line is exact arithmetic over the measured files", () => {
    expect(lossLine(FILES.slice(0, 2))).toBe("returns +53 −8 across 2 files to the last saved state");
    expect(lossLine([FILES[0]!])).toBe("returns +42 −8 across 1 file to the last saved state");
  });

  test("new files are never offered to undo (no earlier saved version)", () => {
    expect(undoableFiles(PARCEL).map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("countPatch — real arithmetic over a unified diff", () => {
  const PATCH = [
    "diff --git a/x b/x",
    "--- a/x",
    "+++ b/x",
    "@@ -1,3 +1,4 @@",
    " keep",
    "-old",
    "+new",
    "+added",
    "@@ -9,1 +10,1 @@",
    "-tail",
    "+tail2",
  ].join("\n");

  test("± counted excluding headers; first hunk sliced at the hunk boundary", () => {
    const { added, removed, firstHunk } = countPatch(PATCH);
    expect({ added, removed }).toEqual({ added: 3, removed: 2 });
    expect(firstHunk.startsWith("@@ -1,3 +1,4 @@")).toBe(true);
    expect(firstHunk).not.toContain("tail");
  });

  test("an empty patch counts nothing and previews nothing", () => {
    expect(countPatch("")).toEqual({ added: 0, removed: 0, firstHunk: "" });
  });
});

describe("the reel badge derivation", () => {
  test("counts ONLY conversation-attributed files; the outside bucket badges nobody", () => {
    const outside: ParcelWire = {
      id: "outside",
      attribution: { kind: "outside", reason: "r" },
      files: [{ path: "n.md", state: "changed", insertions: 1, deletions: 1 }],
      insertions: 1,
      deletions: 1,
      derivation: "t",
    };
    const second: ParcelWire = { ...PARCEL, id: "run-2", attribution: { ...CONV, runId: "run-2" } };
    const counts = custodyCountsByChat(stateWith([PARCEL, second, outside]));
    // Two parcels of the SAME chat sum; the outside files count nowhere.
    expect(counts).toEqual({ c1: 6 });
  });
});

// ── The destructive verb's shield (a stray click must not discard work) ────

describe("the armed-undo shield", () => {
  const T = 1_000_000;

  test("nothing armed is never ready, and says so", () => {
    expect(undoConfirmReady({ armedAt: null, reachedAt: null, now: T })).toBe(false);
    expect(undoConfirmBlockReason({ armedAt: null, reachedAt: T, now: T })).toBe("nothing is armed");
  });

  test("a press with no ARRIVAL on the control is refused however long it waits", () => {
    // The hazard: the pointer was already resting where the confirmation
    // appeared, so waiting alone must never authorise it.
    const late = { armedAt: T, reachedAt: null, now: T + UNDO_CONFIRM_SETTLE_MS + 5_000 };
    expect(undoConfirmReady(late)).toBe(false);
    expect(undoConfirmBlockReason(late)).toMatch(/move onto this button/);
  });

  test("an arrival INSIDE the settle window is refused — that is a click already travelling", () => {
    const early = { armedAt: T, reachedAt: T + UNDO_CONFIRM_SETTLE_MS - 1, now: T + 5_000 };
    expect(undoConfirmReady(early)).toBe(false);
  });

  test("an arrival after the settle window, inside the confirm window, is ready", () => {
    const ok = { armedAt: T, reachedAt: T + UNDO_CONFIRM_SETTLE_MS, now: T + UNDO_CONFIRM_SETTLE_MS };
    expect(undoConfirmReady(ok)).toBe(true);
    expect(undoConfirmBlockReason(ok)).toBeNull();
  });

  test("the confirmation expires rather than lingering as a live hazard", () => {
    const stale = {
      armedAt: T,
      reachedAt: T + UNDO_CONFIRM_SETTLE_MS,
      now: T + UNDO_CONFIRM_WINDOW_MS + 1,
    };
    expect(undoConfirmReady(stale)).toBe(false);
    expect(undoConfirmBlockReason(stale)).toMatch(/timed out/);
  });

  test("the settle window is real (a zero window would close nothing)", () => {
    expect(UNDO_CONFIRM_SETTLE_MS).toBeGreaterThan(0);
    expect(UNDO_CONFIRM_SETTLE_MS).toBeLessThan(UNDO_CONFIRM_WINDOW_MS);
  });
});

// ── What "see what changed" may claim about an EMPTY patch ─────────────────

describe("the empty-patch sentence", () => {
  test("a changed file that differs in nothing really does match its last save", () => {
    expect(emptyPatchLine("changed")).toBe(
      "no difference to show — the file matches its last saved state",
    );
  });

  test("a NEVER-SAVED file is never told it matches a save it does not have", () => {
    const line = emptyPatchLine("new");
    expect(line).not.toContain("matches its last saved state");
    expect(line).toContain("never been saved");
  });

  test("a MOVED file is told the truth about its path, not about its content", () => {
    const line = emptyPatchLine("moved");
    expect(line).not.toContain("matches its last saved state");
    expect(line).toContain("moved here");
  });

  test("an unknown state falls back to the plain sentence, never to a guess", () => {
    expect(emptyPatchLine(undefined)).toBe(
      "no difference to show — the file matches its last saved state",
    );
  });
});

describe("which files undo may be offered on", () => {
  test("a MOVED file is not offered: the last save holds no file at that path", () => {
    const moved: ParcelWire = {
      ...PARCEL,
      files: [
        { path: "kept.ts", state: "changed", insertions: 1, deletions: 1 },
        { path: "arrived.ts", state: "moved", insertions: 0, deletions: 0 },
        { path: "fresh.ts", state: "new", insertions: null, deletions: null },
      ],
    };
    expect(undoableFiles(moved).map((f) => f.path)).toEqual(["kept.ts"]);
    expect(UNRESTORABLE_STATES.has("moved")).toBe(true);
    expect(UNRESTORABLE_STATES.has("new")).toBe(true);
    expect(UNRESTORABLE_STATES.has("changed")).toBe(false);
    expect(UNRESTORABLE_STATES.has("deleted")).toBe(false);
  });
});
