// @vitest-environment jsdom
/**
 * A RUNNING TOOL CALL IS A SPECTATOR SURFACE.
 *
 * THE USER'S REQUEST, VERBATIM: "I would like a bit more movement and
 * visibility when tool calls are in progress, like the step, retry, tokens,
 * during the call, like for the artifact tool that is long duration".
 *
 * THE DEFECT. `toolCallDurationMs` already returned live elapsed while a
 * call was running. ToolBeat rendered `tool.durationMs` only, so a long
 * `create_artifact` sat with no clock. The arrival rail lived on TurnBeat;
 * a silent model turn hides (`rendersInFlow`), so the rail vanished the
 * moment arguments landed and the tool began executing. Token totals sat
 * on that same hidden turn. A retry wrote `attemptCount` with no spark.
 *
 * WHAT THIS FILE PINS:
 *   - elapsed comes from the duration owner, ticks while live;
 *   - the rail and token totals move onto the tool beat ONLY when the
 *     parent turn is hidden (one instrument);
 *   - they do not duplicate the turn footer while the turn still renders;
 *   - a retry `arrive`s; the clock tick is not a spark.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";

import ToolBeat from "../../src/cockpit/flow/ToolBeat.svelte";
import ToolBeatProbe from "./fixtures/ToolBeatProbe.svelte";
import { rendersInFlow } from "../../src/cockpit/flow/beat-state.ts";
import { appendBeat, clearLog } from "../../src/cockpit/flow/log.ts";
import {
  noteToolInputDelta,
  noteTurnStart,
  resetTurnTimings,
} from "../../src/cockpit/flow/turn-timing.ts";
import { toolCallDurationMs } from "../../src/state/chat-messages.ts";
import { read } from "../helpers/source-scan.ts";
import type { Beat, TurnBody } from "../../src/cockpit/flow/types.ts";

const TOOL_BEAT = "src/cockpit/flow/ToolBeat.svelte";
const ELAPSED = "src/cockpit/flow/elapsed-clock.ts";
const WAIT = "src/cockpit/flow/WaitLine.svelte";

beforeEach(() => {
  clearLog();
  resetTurnTimings();
});
afterEach(() => {
  cleanup();
  clearLog();
  resetTurnTimings();
  vi.useRealTimers();
});

function turnBeat(id: string, turn: Partial<TurnBody> & { sourceId: string }): Beat {
  return {
    id,
    kind: "turn",
    parentId: null,
    turnIndex: 0,
    at: 1,
    abnormal: false,
    bleed: false,
    verbs: [],
    turn: { who: "model", text: "", streaming: false, ...turn },
  };
}

function runningTool(parentId: string | null, startedAt: number, extra: Partial<Beat["tool"]> = {}): Beat {
  return {
    id: "b-tool",
    kind: "tool",
    parentId,
    turnIndex: 0,
    at: startedAt,
    abnormal: false,
    bleed: true,
    verbs: [],
    tool: {
      name: "create_artifact",
      label: "create artifact",
      status: "running",
      input: { title: "Tetris" },
      output: null,
      startedAt,
      ...extra,
    },
  };
}

function anatomyOf(root: Element): string[] {
  return [...root.querySelectorAll("[data-field]")].map((e) => e.getAttribute("data-field") ?? "");
}

describe("elapsed comes from the duration owner, not from durationMs alone", () => {
  test("a running call with no persisted duration still shows live elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { container } = render(ToolBeat, {
      props: { beat: runningTool(null, 8_500), expanded: false },
    });
    const el = container.querySelector('[data-field="duration"]');
    expect(el, "live elapsed must occupy the duration field").not.toBeNull();
    expect(el!.textContent).toBe("1.5s");
    // The owner is what produced that number — not a local `now - startedAt`.
    expect(toolCallDurationMs({ status: "running", startedAt: 8_500 }, 10_000)).toBe(1_500);
  });

  test("the elapsed numeral ticks on the shared clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let set: (b: Beat) => void = () => undefined;
    const { container } = render(ToolBeatProbe, {
      props: {
        initial: runningTool(null, 8_500),
        register: (fn: (b: Beat) => void) => {
          set = fn;
        },
      },
    });
    await tick();
    expect(container.querySelector('[data-field="duration"]')!.textContent).toBe("1.5s");
    vi.advanceTimersByTime(400);
    await tick();
    const later = container.querySelector('[data-field="duration"]')!.textContent;
    expect(later, "the clock must re-read now — a frozen 1.5s is the static indicator NN/g refuses").not.toBe(
      "1.5s",
    );
    expect(later).toMatch(/^\d+(\.\d)?s$/);
    void set;
  });

  test("both spectator clocks share one interval owner", () => {
    const clock = read(ELAPSED);
    expect(clock).toContain("WAIT_ELAPSED_TICK_MS");
    expect(clock).toContain("export function startElapsedTick");
    expect(read(WAIT)).toContain("startElapsedTick");
    expect(read(TOOL_BEAT)).toContain("startElapsedTick");
    expect(read(WAIT), "the wait row must not keep a private interval").not.toMatch(
      /setInterval\s*\(/,
    );
    expect(read(TOOL_BEAT), "the tool beat must not keep a private interval").not.toMatch(
      /setInterval\s*\(/,
    );
  });
});

describe("the rail and tokens move onto the tool beat only when the parent hides", () => {
  test("a silent finished parent + running tool carries the rail and the token totals", async () => {
    const parent = turnBeat("b-turn", {
      sourceId: "msg-art",
      text: "",
      streaming: false,
      inputTokens: 12,
      outputTokens: 80,
    });
    expect(rendersInFlow(parent), "the fixture must actually be a hidden turn").toBe(false);
    appendBeat(parent);
    noteTurnStart("msg-art", 0);
    noteToolInputDelta("msg-art", 5_000, 10);

    const { container } = render(ToolBeat, {
      props: { beat: runningTool("b-turn", Date.now() - 2_500), expanded: false },
    });
    await tick();
    await tick();

    expect(
      container.querySelector(".rail-group"),
      "the rail must survive on the tool beat once the silent turn hides",
    ).not.toBeNull();
    expect(container.querySelector('[data-field="chars"]')?.textContent).toContain("5,000");
    expect(container.querySelector('[data-field="channel"]')?.textContent).toBe(
      "a tool call's input",
    );
    expect(container.querySelector('[data-field="input-tokens"]')?.textContent).toBe("↑12");
    expect(container.querySelector('[data-field="output-tokens"]')?.textContent).toBe("↓80 tok");
    expect(anatomyOf(container)).toContain("live-progress");
  });

  test("a still-rendering parent keeps the rail — the tool beat does not duplicate it", async () => {
    const parent = turnBeat("b-turn", {
      sourceId: "msg-live",
      text: "working on it",
      streaming: true,
    });
    expect(rendersInFlow(parent), "a streaming turn with prose is visible").toBe(true);
    appendBeat(parent);
    noteTurnStart("msg-live", 0);
    noteToolInputDelta("msg-live", 5_000, 10);

    const { container } = render(ToolBeat, {
      props: { beat: runningTool("b-turn", Date.now()), expanded: false },
    });
    await tick();

    expect(
      container.querySelector(".rail-group"),
      "while the turn footer still holds the rail, the tool beat must not mount a second",
    ).toBeNull();
    expect(container.querySelector('[data-field="live-progress"]')).toBeNull();
    expect(container.querySelector('[data-field="input-tokens"]')).toBeNull();
  });

  test("no arrivals and no tokens → no spectator row (absence is absence)", async () => {
    const parent = turnBeat("b-turn", { sourceId: "msg-empty", text: "", streaming: false });
    expect(rendersInFlow(parent)).toBe(false);
    appendBeat(parent);

    const { container } = render(ToolBeat, {
      props: { beat: runningTool("b-turn", Date.now()), expanded: false },
    });
    await tick();
    expect(container.querySelector('[data-field="live-progress"]')).toBeNull();
    expect(container.querySelector('[data-field="duration"]'), "elapsed still belongs").not.toBeNull();
  });
});

describe("a retry is news; a clock tick is not", () => {
  test("attempt count is named on the card and sparks through the motion door", () => {
    const src = read(TOOL_BEAT);
    expect(src).toContain('becauseChanged("this call\'s attempt count"');
    expect(src).toContain('motion: "arrive"');
    expect(src).toContain("use:moves={attemptMotion}");
  });

  test("attempt 2 is visible while the call is still running", () => {
    const { container } = render(ToolBeat, {
      props: {
        beat: runningTool(null, Date.now(), { attemptCount: 2 }),
        expanded: false,
      },
    });
    const el = container.querySelector('[data-field="attempt"]');
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("attempt 2");
  });

  test("mutation: gating duration on durationMs alone is the defect this file exists for", () => {
    const src = read(TOOL_BEAT);
    expect(src).toContain("toolCallDurationMs");
    expect(src).not.toMatch(/tool\.durationMs\s*!==\s*undefined/);
    // The restored defect, written out, fails that pin.
    const restored = `{#if tool.durationMs !== undefined}\n      <span class="meta" data-field="duration">`;
    expect(/tool\.durationMs\s*!==\s*undefined/.test(restored)).toBe(true);
    expect(/toolCallDurationMs/.test(restored)).toBe(false);
  });
});

describe("the live tool beat does not listen to arrivals while the parent still renders", () => {
  test("arrivalVersion is gated on parentHidden", () => {
    // MUTATION: void $arrivalVersion unconditionally in ToolBeat and every
    // argument delta rebuilds the card — the §3.8 trap the turn-timing
    // comment exists to refuse.
    const src = read(TOOL_BEAT);
    expect(src).toMatch(/if\s*\(\s*!live\s*\|\|\s*!parentHidden\s*\)\s*return/);
    expect(src).toContain("void $arrivalVersion");
  });
});
