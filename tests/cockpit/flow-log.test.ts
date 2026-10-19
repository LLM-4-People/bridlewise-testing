// @vitest-environment node
/**
 * The beat log (spec §3.8): a PLAIN module array outside any reactive
 * proxy — the only reactive surface is the version counter. These tests
 * pin that contract (append is O(1) on the array, subscribers see version
 * bumps, batches coalesce) and the causal-chain walk.
 */
import { beforeEach, describe, expect, test } from "vitest";

import {
  appendBeat,
  batch,
  beatAt,
  beatById,
  beatCount,
  causalChainOf,
  clearLog,
  indexOfBeat,
  lastBeat,
  logVersion,
  replaceBeat,
  updateBeat,
  windowSlice,
} from "../../src/cockpit/flow/log.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

function mk(id: string, parentId: string | null = null, turnIndex = 0): Beat {
  return {
    id,
    kind: "event",
    parentId,
    turnIndex,
    at: 1000,
    abnormal: false,
    bleed: true,
    verbs: [],
    event: { eventKind: "steering", text: id },
  };
}

beforeEach(() => clearLog());

describe("flow log — outside reactive state", () => {
  test("append/read/window basics", () => {
    appendBeat(mk("a"));
    appendBeat(mk("b", "a"));
    expect(beatCount()).toBe(2);
    expect(beatAt(1)?.id).toBe("b");
    expect(indexOfBeat("b")).toBe(1);
    expect(lastBeat()?.id).toBe("b");
    expect(windowSlice(0, 5).map((b) => b.id)).toEqual(["a", "b"]);
  });

  test("duplicate ids are refused — ids are the causal join key", () => {
    appendBeat(mk("a"));
    expect(() => appendBeat(mk("a"))).toThrow(/already in the log/);
  });

  test("version bumps once per mutation, once per batch", () => {
    const v0 = logVersion.get();
    appendBeat(mk("a"));
    expect(logVersion.get()).toBe(v0 + 1);
    batch(() => {
      appendBeat(mk("b"));
      appendBeat(mk("c"));
      updateBeat("a", (b) => ({ ...b, abnormal: true }));
    });
    expect(logVersion.get()).toBe(v0 + 2);
    expect(beatById("a")?.abnormal).toBe(true);
  });

  test("an empty batch does not bump the version", () => {
    const v0 = logVersion.get();
    batch(() => {});
    expect(logVersion.get()).toBe(v0);
  });

  test("replace keeps identity; id changes are refused", () => {
    appendBeat(mk("a"));
    expect(replaceBeat("a", { ...mk("a"), abnormal: true })).toBe(true);
    expect(beatById("a")?.abnormal).toBe(true);
    expect(() => replaceBeat("a", mk("z"))).toThrow(/cannot change/);
    expect(replaceBeat("missing", mk("missing"))).toBe(false);
  });

  test("causalChain walks the log's own parentage", () => {
    appendBeat(mk("run"));
    appendBeat(mk("turn", "run"));
    appendBeat(mk("call", "turn"));
    appendBeat(mk("effect", "call"));
    expect(causalChainOf("effect")).toEqual(["effect", "call", "turn", "run"]);
    expect(causalChainOf("run")).toEqual(["run"]);
  });

  test("a parentage cycle terminates instead of hanging", () => {
    appendBeat(mk("a", "b"));
    appendBeat(mk("b", "a"));
    expect(causalChainOf("a").length).toBeLessThanOrEqual(1000);
  });
});
