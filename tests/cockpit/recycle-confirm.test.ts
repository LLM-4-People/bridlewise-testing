// @vitest-environment node
/**
 * Recycle is recoverable and still needs a second press. The rule is
 * pure: first press arms, a second press of the same id after settle
 * fires, a different id or an expired window re-arms.
 */
import { describe, expect, test } from "vitest";
import { RECYCLE_CONFIRM_SETTLE_MS, RECYCLE_CONFIRM_WINDOW_MS } from "../../src/cockpit/rooms/switch-config.ts";
import { VERB_MARK, VERB_MARK_WORD } from "../../src/cockpit/shell/verb-marks.ts";
import {
  RECYCLE_CONFIRM_FACE,
  recycleFace,
  takeRecyclePress,
} from "../../src/cockpit/rooms/recycle-confirm.ts";

const NEXT = { kind: "chat" as const, id: "c1", name: "talk" };

describe("takeRecyclePress", () => {
  test("the first press arms and does not fire", () => {
    const r = takeRecyclePress(null, NEXT, 1_000);
    expect(r.fire).toBe(false);
    expect(r.arm).toEqual({ ...NEXT, armedAt: 1_000 });
  });

  test("a second press of the same id after settle fires", () => {
    const first = takeRecyclePress(null, NEXT, 1_000);
    const second = takeRecyclePress(first.arm, NEXT, 1_000 + RECYCLE_CONFIRM_SETTLE_MS);
    expect(second.fire).toBe(true);
    expect(second.arm).toBeNull();
  });

  test("a press inside the settle window re-arms and does not fire", () => {
    const first = takeRecyclePress(null, NEXT, 1_000);
    const bounce = takeRecyclePress(first.arm, NEXT, 1_000 + RECYCLE_CONFIRM_SETTLE_MS - 1);
    expect(bounce.fire).toBe(false);
    expect(bounce.arm?.armedAt).toBe(1_000 + RECYCLE_CONFIRM_SETTLE_MS - 1);
  });

  test("a different id re-arms", () => {
    const first = takeRecyclePress(null, NEXT, 1_000);
    const other = takeRecyclePress(
      first.arm,
      { kind: "chat", id: "c2", name: "other" },
      1_000 + RECYCLE_CONFIRM_SETTLE_MS,
    );
    expect(other.fire).toBe(false);
    expect(other.arm?.id).toBe("c2");
  });

  test("an expired window re-arms", () => {
    const first = takeRecyclePress(null, NEXT, 1_000);
    const late = takeRecyclePress(first.arm, NEXT, 1_000 + RECYCLE_CONFIRM_WINDOW_MS + 1);
    expect(late.fire).toBe(false);
  });

  test("mutation: a same-id press after settle is the fire", () => {
    const armed = { ...NEXT, armedAt: 0 };
    expect(takeRecyclePress(armed, NEXT, RECYCLE_CONFIRM_SETTLE_MS).fire).toBe(true);
    expect(takeRecyclePress(null, NEXT, RECYCLE_CONFIRM_SETTLE_MS).fire).toBe(false);
  });
});

describe("recycleFace", () => {
  test("the armed face is the confirmation word, never the bin", () => {
    expect(recycleFace(false)).toBe(VERB_MARK.recycle);
    expect(recycleFace(true)).toBe(RECYCLE_CONFIRM_FACE);
    expect(recycleFace(false, VERB_MARK_WORD.recycle)).toBe(VERB_MARK_WORD.recycle);
    expect(recycleFace(true, VERB_MARK_WORD.recycle)).toBe(RECYCLE_CONFIRM_FACE);
  });

  test("mutation: an armed control that still shows the bin is not a confirmation", () => {
    expect(recycleFace(true)).not.toBe(VERB_MARK.recycle);
    expect(recycleFace(true)).not.toBe(recycleFace(false));
  });
});
