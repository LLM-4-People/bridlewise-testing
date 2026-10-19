// @vitest-environment node
/**
 * ARM ↔ ledger wiring (§6.4) — arm-sync.ts:
 *   - DRIFT PIN: every predicate the client encodes must pass the SERVER's
 *     own `validatePredicate` (grammar + ambient vocabulary) — the two ends
 *     cannot drift;
 *   - record-first with honest fallback: a reachable record → storage
 *     "ledger" / "saved to the record"; an unreachable record → storage
 *     "local" / "kept locally only" (the label switching under test);
 *   - clear: a ledger trigger that cannot reach the record STAYS listed —
 *     removing it locally while the record holds it would lie;
 *   - capture refuses an empty label / empty band instead of faking;
 *   - CAPTURES (UIE-057): the record's range flags LIST from the
 *     `arm.flags` read (ranges only — triggers stay the "cocked" group's)
 *     and CLEAR through the same `arm.flags/clear` contract by id, one and
 *     all; a clear that cannot reach the record leaves the row listed.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/data/broker.ts", () => ({
  action: vi.fn(),
  read: vi.fn(),
}));

import { action as brokerAction, read as brokerRead } from "../../src/data/broker.ts";
import { ClientError } from "../../src/data/errors.ts";
import {
  armPredicateFor,
  armTriggerSynced,
  captureRangeSynced,
  capturedRanges,
  capturedRangesFailure,
  capturedRangesState,
  clearAllCapturedRangesSynced,
  clearArmSynced,
  clearCapturedRangeSynced,
  refreshCapturedRanges,
  type ArmFlagWire,
} from "../../src/cockpit/sweep/arm-sync";
import { armedTriggers } from "../../src/cockpit/sweep/sweep-store";
import { currentChatId } from "../../src/state/chats";
import { resetContextStores } from "../../src/state/store-registry.ts";
// THE PALETTE — every expression the menu OFFERS must be server-acceptable:
// an unarmable offer is a defect, so the rows drift through the same pin.
import { armPaletteRows } from "../../src/cockpit/sweep/arm-palette";
// The SERVER's own validator — the drift guard for the predicate seam.
import { validatePredicate } from "../../server/blocks/arm.ts";

const actionMock = vi.mocked(brokerAction);
const readMock = vi.mocked(brokerRead);

/** A range flag exactly as the record's fold serves it. */
function rangeFlag(id: string, label: string): ArmFlagWire {
  return { id, kind: "range", t0: 100, t1: 900, label, recordedAt: new Date(1000).toISOString() };
}

beforeEach(() => {
  vi.clearAllMocks();
  armedTriggers.set([]);
  currentChatId.set("chat-test");
  // The captures atoms are module state — reset them through the real door
  // so each arm starts from a known list.
  readMock.mockResolvedValue({ flags: [], serverSideFiring: false });
  return refreshCapturedRanges();
});

test("capture revalidation keeps useful rows and only the latest read can settle readiness", async () => {
  const held = rangeFlag("held", "Kept capture");
  readMock.mockResolvedValueOnce({ flags: [held], serverSideFiring: false });
  await refreshCapturedRanges();
  expect(capturedRangesState.get()).toBe("ready");
  let releaseOld!: (value: { flags: ArmFlagWire[] }) => void;
  readMock.mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }));
  const old = refreshCapturedRanges();
  expect(capturedRangesState.get()).toBe("pending");
  expect(capturedRanges.get()).toEqual([held]);
  readMock.mockRejectedValueOnce(new Error("Temporary refusal"));
  await refreshCapturedRanges();
  expect(capturedRangesState.get()).toBe("failed");
  expect(capturedRanges.get()).toEqual([held]);
  expect(capturedRangesFailure.get()).toContain("Temporary refusal");
  releaseOld({ flags: [] });
  await old;
  expect(capturedRangesState.get()).toBe("failed");
  expect(capturedRanges.get()).toEqual([held]);
  readMock.mockResolvedValueOnce({ flags: [], serverSideFiring: false });
  await refreshCapturedRanges();
  expect(capturedRangesState.get()).toBe("ready");
  expect(capturedRanges.get()).toEqual([]);
  expect(capturedRangesFailure.get()).toBeNull();
});

test("a context reset invalidates both late successful and failed capture reads", async () => {
  let resolveOld!: (value: { flags: ArmFlagWire[] }) => void;
  let rejectOld!: (reason: Error) => void;
  readMock.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const oldSuccess = refreshCapturedRanges();
  readMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  const oldFailure = refreshCapturedRanges();
  resetContextStores();
  expect(capturedRangesState.get()).toBe("unread");
  resolveOld({ flags: [rangeFlag("old", "Other conversation")] });
  rejectOld(new Error("Other conversation failed"));
  await Promise.all([oldSuccess, oldFailure]);
  expect(capturedRangesState.get()).toBe("unread");
  expect(capturedRanges.get()).toEqual([]);
  expect(capturedRangesFailure.get()).toBeNull();
});

describe("DRIFT PIN — client predicates validate under the server's own grammar", () => {
  test("every expressible mapping passes server validatePredicate", () => {
    const cases = [
      armPredicateFor("check-fails", null),
      armPredicateFor("tool-errors", null),
      armPredicateFor("context-crosses", "80"),
    ];
    for (const c of cases) {
      expect(c.expressible).toBe(true);
      if (c.expressible) {
        expect(() => validatePredicate(c.predicate)).not.toThrow();
      }
    }
  });

  test("every PALETTE ROW's built predicate is server-acceptable — an unarmable offer is a defect", () => {
    for (const row of armPaletteRows()) {
      // String rows arm through "edit"; the duration row needs a number.
      let built = row.build(row.paramPlaceholder !== null ? "edit" : null);
      if (!("predicate" in built)) {
        built = row.build("500");
      }
      expect(
        "predicate" in built,
        `the palette row "${row.label}" must build an expression`,
      ).toBe(true);
      if ("predicate" in built) {
        expect(() => validatePredicate(built.predicate), `server refused the palette row "${row.label}": ${built.predicate}`).not.toThrow();
      }
    }
  });

  test("the custom kind maps its expression verbatim — an empty one is refused before the wire", () => {
    const c = armPredicateFor("custom", "event.type == 'run' && run.streaming");
    expect(c.expressible).toBe(true);
    if (c.expressible) {
      expect(c.predicate).toBe("event.type == 'run' && run.streaming");
      expect(() => validatePredicate(c.predicate)).not.toThrow();
    }
    const empty = armPredicateFor("custom", "   ");
    expect(empty.expressible).toBe(false);
    if (!empty.expressible) expect(empty.reason).toContain("empty");
  });

  test("file-edited states its inexpressibility honestly (no contains in the grammar)", () => {
    const c = armPredicateFor("file-edited", "src/thing.ts");
    expect(c.expressible).toBe(false);
    if (!c.expressible) expect(c.reason).toContain("contains");
  });

  test("MUTATION: a predicate outside the vocabulary IS refused by the server validator", () => {
    // Proves the drift pin has teeth: if armPredicateFor ever emitted an
    // unbindable root, the pin above would fail the same way this does.
    expect(() => validatePredicate("nonsense.field == 'x'")).toThrow(
      /unknown vocabulary/,
    );
  });
});

test("missing conversation never silently widens a watch or capture to all conversations", async () => {
  currentChatId.set(null);
  expect(await armTriggerSynced("tool-errors")).toEqual({ trigger: null, saved: false, note: "Open a conversation or choose All my conversations before creating a watch." });
  expect(await armTriggerSynced("file-edited", "src/")).toEqual({ trigger: null, saved: false, note: "Open a conversation or choose All my conversations before creating a watch." });
  expect(await captureRangeSynced(100, 900, "snapshot")).toEqual({ saved: false, flag: null, note: "Open a conversation or choose All my conversations before saving a capture." });
  expect(actionMock).not.toHaveBeenCalled();
  expect(armedTriggers.get()).toHaveLength(0);
  actionMock.mockResolvedValue({ id: "all-arm", kind: "trigger", recordedAt: new Date(1000).toISOString() });
  expect((await armTriggerSynced("tool-errors", null, "all")).saved).toBe(true);
  expect(actionMock.mock.calls[0]![2]).not.toHaveProperty("chatId");
});

describe("record-first arming with the honest fallback label", () => {
  test("record reachable → storage 'ledger', 'saved to the record', server id kept", async () => {
    actionMock.mockResolvedValue({
      id: "arm-server-1",
      kind: "trigger",
      predicate: "tool.failed",
      recordedAt: new Date(1000).toISOString(),
    });
    const result = await armTriggerSynced("tool-errors");
    expect(result.saved).toBe(true);
    expect(result.note).toBe("saved to the record");
    expect(result.trigger?.storage).toBe("ledger");
    expect(result.trigger?.id).toBe("arm-server-1");
    expect(actionMock).toHaveBeenCalledWith(
      "arm.flags",
      "set",
      expect.objectContaining({ predicate: "tool.failed" }),
      expect.objectContaining({ invalidates: ["arm:changed"] }),
    );
    expect(armedTriggers.get().some((t) => t.id === "arm-server-1")).toBe(true);
  });

  test("record unreachable → storage 'local', 'kept locally only' with the reason", async () => {
    actionMock.mockRejectedValue(new Error("offline"));
    const result = await armTriggerSynced("check-fails");
    expect(result.saved).toBe(false);
    expect(result.note).toContain("kept locally only");
    expect(result.note).toContain("offline");
    expect(result.trigger?.storage).toBe("local");
    expect(armedTriggers.get()).toHaveLength(1);
  });

  test("an inexpressible predicate arms LOCALLY with its reason — no server call", async () => {
    const result = await armTriggerSynced("file-edited", "src/x.ts");
    expect(actionMock).not.toHaveBeenCalled();
    expect(result.saved).toBe(false);
    expect(result.trigger?.storage).toBe("local");
    expect(result.note).toContain("kept locally only");
  });

  test("an invalid context percentage is REFUSED, not armed", async () => {
    const result = await armTriggerSynced("context-crosses", "500");
    expect(result.trigger).toBeNull();
    expect(armedTriggers.get()).toHaveLength(0);
    expect(actionMock).not.toHaveBeenCalled();
  });

  test("an open chat scopes the flag", async () => {
    currentChatId.set("chat-7");
    actionMock.mockResolvedValue({ id: "a", kind: "trigger", recordedAt: new Date().toISOString() });
    await armTriggerSynced("tool-errors");
    expect(actionMock).toHaveBeenCalledWith(
      "arm.flags",
      "set",
      expect.objectContaining({ chatId: "chat-7" }),
      expect.anything(),
    );
  });

  test("THE SCOPE CHOICE travels on the wire: 'all my chats' omits chatId, 'this chat' sends it", async () => {
    currentChatId.set("chat-7");
    actionMock.mockResolvedValue({ id: "a", kind: "trigger", recordedAt: new Date().toISOString() });
    await armTriggerSynced("tool-errors", null, "all");
    expect(actionMock).toHaveBeenCalledWith(
      "arm.flags",
      "set",
      expect.not.objectContaining({ chatId: expect.anything() }),
      expect.anything(),
    );
    await armTriggerSynced("tool-errors", null, "chat");
    expect(actionMock).toHaveBeenLastCalledWith(
      "arm.flags",
      "set",
      expect.objectContaining({ chatId: "chat-7" }),
      expect.anything(),
    );
    // The row records its own scope, so the row itself answers where it watches.
    const rows = armedTriggers.get();
    expect(rows[0]!.scope).toBe("all");
    expect(rows[1]!.scope).toBe("chat");
  });

  test("THE CUSTOM ENTRY: a server REFUSAL is not armed anywhere — the server's sentence surfaces VERBATIM", async () => {
    currentChatId.set("chat-test");
    // The server's own refusal shape as the client reconstructs it from the
    // 200 envelope (the designed 428 travels as refusal data; the fetch door
    // rebuilds the typed ClientError — same code, same sentence): the
    // message is what the surface must show, word for word.
    actionMock.mockRejectedValue(
      new ClientError("invalid_arm_predicate", "arm predicate does not parse: unexpected end of expression", 428),
    );
    const result = await armTriggerSynced("custom", "tool.name == (");
    expect(actionMock).toHaveBeenCalledOnce();
    expect(result.trigger).toBeNull();
    expect(result.saved).toBe(false);
    expect(result.note).toContain("not armed");
    expect(result.note).toContain("arm predicate does not parse: unexpected end of expression");
    expect(armedTriggers.get()).toHaveLength(0);
  });

  test("the custom entry's vocabulary refusal surfaces verbatim too", async () => {
    actionMock.mockRejectedValue(
      new ClientError(
        "invalid_arm_predicate",
        "arm predicate references unknown vocabulary: nonsense (known roots: event, tool, check, context, run)",
        428,
      ),
    );
    const result = await armTriggerSynced("custom", "nonsense.field == 'x'");
    expect(result.trigger).toBeNull();
    expect(result.note).toContain("unknown vocabulary: nonsense");
  });

  test("the custom entry falls back locally ONLY when the record could not be reached (a 5xx / network answer)", async () => {
    actionMock.mockRejectedValueOnce(new ClientError("http_503", "HTTP 503", 503));
    const fiveHundred = await armTriggerSynced("custom", "event.type == 'run'");
    expect(fiveHundred.saved).toBe(false);
    expect(fiveHundred.trigger?.storage).toBe("local");
    expect(fiveHundred.note).toContain("kept locally only");
    actionMock.mockRejectedValueOnce(new Error("offline"));
    const network = await armTriggerSynced("custom", "event.type == 'run'");
    expect(network.saved).toBe(false);
    expect(network.trigger?.storage).toBe("local");
  });

  test("a valid custom expression arms ON THE RECORD and keeps its expression on the row", async () => {
    actionMock.mockResolvedValue({
      id: "arm-custom-1",
      kind: "trigger",
      predicate: "event.outcome == 'denied'",
      recordedAt: new Date(1000).toISOString(),
    });
    const result = await armTriggerSynced("custom", "event.outcome == 'denied'");
    expect(result.saved).toBe(true);
    expect(result.trigger?.predicate).toBe("event.outcome == 'denied'");
    expect(result.trigger?.kind).toBe("custom");
    expect(actionMock).toHaveBeenCalledWith(
      "arm.flags",
      "set",
      expect.objectContaining({ predicate: "event.outcome == 'denied'" }),
      expect.anything(),
    );
  });
});

describe("clear — the record is the authority for ledger flags", () => {
  test("a ledger trigger clears the record, then the list", async () => {
    actionMock.mockResolvedValueOnce({
      id: "arm-1",
      kind: "trigger",
      recordedAt: new Date().toISOString(),
    });
    const armed = await armTriggerSynced("tool-errors");
    actionMock.mockResolvedValueOnce({ cleared: true, id: "arm-1" });
    const result = await clearArmSynced(armed.trigger!);
    expect(result.cleared).toBe(true);
    expect(result.note).toBe("cleared from the record");
    expect(actionMock).toHaveBeenLastCalledWith(
      "arm.flags",
      "clear",
      { id: "arm-1" },
      expect.objectContaining({ invalidates: ["arm:changed"] }),
    );
    expect(armedTriggers.get()).toHaveLength(0);
  });

  test("MUTATION: an unreachable record leaves the ledger trigger LISTED (no lying removal)", async () => {
    actionMock.mockResolvedValueOnce({
      id: "arm-2",
      kind: "trigger",
      recordedAt: new Date().toISOString(),
    });
    const armed = await armTriggerSynced("tool-errors");
    actionMock.mockRejectedValueOnce(new Error("offline"));
    const result = await clearArmSynced(armed.trigger!);
    expect(result.cleared).toBe(false);
    expect(result.note).toContain("still armed");
    expect(armedTriggers.get()).toHaveLength(1);
  });

  test("a local trigger clears without a server call", async () => {
    const armed = await armTriggerSynced("file-edited", "x.ts");
    actionMock.mockClear();
    const result = await clearArmSynced(armed.trigger!);
    expect(result.cleared).toBe(true);
    expect(actionMock).not.toHaveBeenCalled();
    expect(armedTriggers.get()).toHaveLength(0);
  });
});

describe("capture — a bookmark over the ledger, never faked", () => {
  test("captures through arm.flags/capture with integer bounds", async () => {
    actionMock.mockResolvedValue({
      id: "arm-r1",
      kind: "range",
      t0: 100,
      t1: 900,
      label: "the regression",
      recordedAt: new Date().toISOString(),
    });
    const result = await captureRangeSynced(100.4, 899.2, "the regression");
    expect(result.saved).toBe(true);
    expect(result.note).toContain("captured");
    expect(actionMock).toHaveBeenCalledWith(
      "arm.flags",
      "capture",
      expect.objectContaining({ t0: 100, t1: 900, label: "the regression" }),
      expect.objectContaining({ invalidates: ["arm:changed"] }),
    );
  });

  test("refuses an empty label and an empty band — no server call", async () => {
    expect((await captureRangeSynced(1, 2, "  ")).saved).toBe(false);
    expect((await captureRangeSynced(5, 5, "x")).saved).toBe(false);
    expect(actionMock).not.toHaveBeenCalled();
  });

  test("an unreachable record states the failure — nothing pretends to be saved", async () => {
    actionMock.mockRejectedValue(new Error("offline"));
    const result = await captureRangeSynced(1, 2, "x");
    expect(result.saved).toBe(false);
    expect(result.note).toContain("not captured");
    expect(result.flag).toBeNull();
  });
});

describe("captures — the record's range flags list and clear (UIE-057)", () => {
  test("the list comes from the arm.flags read, ranges only — triggers are not duplicated", async () => {
    readMock.mockResolvedValue({
      flags: [
        { id: "arm-t1", kind: "trigger", predicate: "tool.failed", recordedAt: new Date(1000).toISOString() },
        rangeFlag("arm-r1", "the regression"),
      ],
      serverSideFiring: false,
    });
    await refreshCapturedRanges();
    expect(capturedRanges.get().map((f) => f.id)).toEqual(["arm-r1"]);
    expect(capturedRanges.get()[0]!.label).toBe("the regression");
    expect(capturedRanges.get()[0]!.t0).toBe(100);
    expect(capturedRanges.get()[0]!.t1).toBe(900);
    expect(capturedRangesFailure.get()).toBeNull();
  });

  test("a failed listing keeps the last-known rows and states the failure — no silent empty", async () => {
    readMock.mockResolvedValue({
      flags: [rangeFlag("arm-r1", "kept from the last good read")],
      serverSideFiring: false,
    });
    await refreshCapturedRanges();
    readMock.mockRejectedValue(new Error("offline"));
    await refreshCapturedRanges();
    expect(capturedRanges.get().map((f) => f.id), "last-known stands — it was true when the server said it").toEqual([
      "arm-r1",
    ]);
    expect(capturedRangesFailure.get()).toContain("captures not listed");
    expect(capturedRangesFailure.get()).toContain("offline");
  });

  test("clearing ONE capture hits the record's clear contract by id, then the row leaves the list", async () => {
    readMock.mockResolvedValue({
      flags: [rangeFlag("arm-r1", "the regression"), rangeFlag("arm-r2", "the second")],
      serverSideFiring: false,
    });
    await refreshCapturedRanges();
    actionMock.mockResolvedValue({ cleared: true, id: "arm-r1" });

    const result = await clearCapturedRangeSynced(capturedRanges.get()[0]!);

    expect(result.cleared).toBe(true);
    expect(result.note).toContain("cleared");
    expect(result.note).toContain("the regression");
    expect(actionMock).toHaveBeenCalledWith(
      "arm.flags",
      "clear",
      { id: "arm-r1" },
      expect.objectContaining({ invalidates: ["arm:changed"] }),
    );
    expect(capturedRanges.get().map((f) => f.id)).toEqual(["arm-r2"]);
    expect(capturedRangesFailure.get()).toBeNull();
  });

  test("MUTATION: an unreachable record leaves the capture LISTED (no lying removal)", async () => {
    readMock.mockResolvedValue({
      flags: [rangeFlag("arm-r1", "the regression")],
      serverSideFiring: false,
    });
    await refreshCapturedRanges();
    actionMock.mockRejectedValue(new Error("offline"));

    const result = await clearCapturedRangeSynced(capturedRanges.get()[0]!);

    expect(result.cleared).toBe(false);
    expect(result.note).toContain("still captured");
    expect(result.note).toContain("offline");
    expect(capturedRanges.get().map((f) => f.id), "the row stands while the record holds it").toEqual([
      "arm-r1",
    ]);
  });

  test("clear-all clears every listed capture and says how many", async () => {
    readMock.mockResolvedValue({
      flags: [rangeFlag("arm-r1", "one"), rangeFlag("arm-r2", "two"), rangeFlag("arm-r3", "three")],
      serverSideFiring: false,
    });
    await refreshCapturedRanges();
    actionMock.mockResolvedValue({ cleared: true, id: "cleared-by-clear-all" });

    const result = await clearAllCapturedRangesSynced();

    expect(result.cleared).toBe(true);
    expect(result.note).toBe("cleared 3 captures from the record");
    expect(actionMock).toHaveBeenCalledTimes(3);
    for (const id of ["arm-r1", "arm-r2", "arm-r3"]) {
      expect(actionMock).toHaveBeenCalledWith(
        "arm.flags",
        "clear",
        { id },
        expect.objectContaining({ invalidates: ["arm:changed"] }),
      );
    }
    expect(capturedRanges.get()).toHaveLength(0);
  });

  test("a PARTIAL clear-all states the fraction honestly — no single success sentence over rows that stand", async () => {
    readMock.mockResolvedValue({
      flags: [rangeFlag("arm-r1", "one"), rangeFlag("arm-r2", "two")],
      serverSideFiring: false,
    });
    await refreshCapturedRanges();
    actionMock
      .mockResolvedValueOnce({ cleared: true, id: "arm-r1" })
      .mockRejectedValueOnce(new Error("offline"));

    const result = await clearAllCapturedRangesSynced();

    expect(result.cleared).toBe(false);
    expect(result.note).toContain("cleared 1 of 2");
    expect(result.note).toContain("offline");
    expect(capturedRanges.get().map((f) => f.id)).toEqual(["arm-r2"]);
  });
});
