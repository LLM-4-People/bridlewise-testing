// @vitest-environment jsdom
/**
 * THE RAIL MUST SEE EVERY CHANNEL A TURN STREAMS.
 *
 * THE USER'S REPORT, VERBATIM: "i noticed that the animation for the artifact
 * tool, when its running does not work, it does work for llm. basically the
 * animation shows up, but always stop moving and counting between 400-600
 * tokens, until it fully finishes. i am not not sure if it is happening with
 * other tool calls".
 *
 * THE CAUSE, confirmed at the source rather than assumed. The rail advances one
 * cell per observed arrival and freezes when nothing arrives — deliberately, so
 * a stall is visible as a stall. It was fed the ANSWER TEXT ONLY. A model turn
 * streams three things:
 *
 *     reasoning_delta   the model thinking
 *     text_delta        the reply            ← the only one the rail could see
 *     tool_call_delta   a tool call's arguments
 *
 * and `src/client.ts` discards every `tool_call_delta` outright ("Partial
 * arguments are not accumulated"), so those frames reached NO STORE AT ALL.
 * The 400–600 the user measured is the length of the prose preamble before the
 * tool call; everything after it was an argument object carrying a whole HTML
 * document, and the rail was blind to all of it.
 *
 * IT WAS NEVER ARTIFACT-SPECIFIC, which answers the user's open question:
 * `read_file` and `execute_command` stream their arguments through the same
 * frame type, so any tool call froze the rail for as long as its arguments
 * took. Artifacts are simply the largest by orders of magnitude, which turned a
 * blink into a stall. Both are exercised below.
 *
 * COUNTING THESE FRAMES DOES NOT BEND THE INSTRUMENT'S LAW. The law is that
 * motion must be caused by something genuinely arriving; a tool-call argument
 * delta is a received frame. The law is re-asserted at the end of this file: a
 * genuine stall must still freeze it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/client.ts", () => ({
  startRun: vi.fn(async () => ({ runId: "run-ch-1" })),
  openRunStream: vi.fn(() => ({ close: vi.fn() })),
  sendUserMessage: vi.fn(),
}));

import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";

import { openRunStream, type StreamHandlers } from "../../src/client.ts";
import { beginCockpitRun } from "../../src/cockpit/flow/run-stream.ts";
import {
  observedFor,
  resetTurnTimings,
  turnTimingFor,
} from "../../src/cockpit/flow/turn-timing.ts";
import {
  appendAssistantMessage,
  appendUserMessage,
  clearMessages,
  messages,
  setStreaming,
} from "../../src/state/chat-messages.ts";
import { resetSweep } from "../../src/cockpit/sweep/sweep-store.ts";
import { resetLiveSweepBuffer } from "../../src/cockpit/sweep/sweep-data.ts";
import { resetWait } from "../../src/cockpit/flow/wait-stage.ts";
import StreamPulseProbe from "./fixtures/StreamPulseProbe.svelte";
import type { ModelEvent } from "../../shared/types.ts";

const openRunStreamMock = vi.mocked(openRunStream);

/** The one place a model event enters the cockpit's own stream consumer. */
async function openStream(): Promise<(e: ModelEvent) => void> {
  openRunStreamMock.mockClear();
  await beginCockpitRun("p1", "make me an artifact", {
    chatId: "c1",
    runEndDebounceMs: 0,
  });
  const handlers = openRunStreamMock.mock.calls[0]![1] as StreamHandlers;
  return (e: ModelEvent) => handlers.onModelEvent?.(e);
}

/** The assistant message the frames stream into. `openRunStream` is mocked, so
 *  client.ts's own `start` ingestion does not run and the test appends it — the
 *  same message the real path would have appended on the same frame. */
function openTurn(): string {
  appendAssistantMessage("");
  const list = messages.get();
  return list[list.length - 1]!.id;
}

let seq = 0;
function ev(over: Partial<ModelEvent> & { type: ModelEvent["type"] }): ModelEvent {
  seq += 1;
  return { sequence: seq, protocol: "openai-chat", ...over } as ModelEvent;
}

beforeEach(() => {
  clearMessages();
  resetTurnTimings();
  resetWait();
  resetSweep();
  resetLiveSweepBuffer();
  setStreaming(false);
});
afterEach(() => {
  cleanup();
  clearMessages();
  resetTurnTimings();
  resetWait();
  resetSweep();
  resetLiveSweepBuffer();
  setStreaming(false);
});

// ── The frames reach the count ────────────────────────────────────────────

describe("every channel a turn streams is observed", () => {
  test("an artifact call: text, then a long argument stream, then text — no frozen window", async () => {
    // THE REPORTED SHAPE, reproduced: a ~500-character preamble, then an HTML
    // document emitted as tool-call arguments, then the reply resuming.
    // MUTATION: drop the `tool_call_delta` branch from `noteOutputFrame`
    // (run-stream.ts) — i.e. restore text-only counting — and the plateau
    // assertion below fails with a 60-arrival frozen window, which is exactly
    // what the user was watching.
    const emit = await openStream();
    const id = openTurn();
    emit(ev({ type: "start" }));

    const counts: number[] = [];
    const record = (): void => {
      counts.push(observedFor(id).chars);
    };

    // The prose preamble the user measured at 400–600 tokens.
    for (let i = 0; i < 10; i += 1) {
      emit(ev({ type: "text_delta", outputIndex: 0, delta: "preamble ".repeat(6) }));
      record();
    }
    const afterPreamble = observedFor(id).chars;
    expect(observedFor(id).channel).toBe("answer");

    // The artifact itself: one whole HTML document, as arguments.
    emit(ev({ type: "tool_call_start", outputIndex: 0, callId: "c-1", name: "create_artifact" }));
    for (let i = 0; i < 60; i += 1) {
      emit(
        ev({
          type: "tool_call_delta",
          outputIndex: 0,
          callId: "c-1",
          argumentsDelta: "<div>a chunk of the artifact's html</div>",
        }),
      );
      record();
    }
    expect(
      observedFor(id).chars,
      "the argument stream must be observed, not discarded",
    ).toBeGreaterThan(afterPreamble);
    expect(
      observedFor(id).channel,
      "…and the reader must be told these are not the reply",
    ).toBe("tool-input");

    emit(ev({ type: "tool_call_done", outputIndex: 0, callId: "c-1", arguments: {} }));

    // The reply resumes.
    for (let i = 0; i < 5; i += 1) {
      emit(ev({ type: "text_delta", outputIndex: 0, delta: "and here it is. " }));
      record();
    }
    expect(observedFor(id).channel).toBe("answer");

    // THE CLAIM: no frozen window anywhere in the turn.
    const plateaus: string[] = [];
    for (let i = 1; i < counts.length; i += 1) {
      if (counts[i]! <= counts[i - 1]!) plateaus.push(`arrival ${i}: ${counts[i - 1]} → ${counts[i]}`);
    }
    expect(
      plateaus.slice(0, 8),
      `the rail must advance on every received frame:\n${plateaus.slice(0, 8).join("\n")}`,
    ).toEqual([]);
  });

  test("…and it is NOT artifact-specific — any tool's arguments count", async () => {
    // The user's open question, answered: "i am not not sure if it is happening
    // with other tool calls". It was.
    const emit = await openStream();
    const id = openTurn();
    emit(ev({ type: "start" }));
    for (const name of ["read_file", "execute_command"]) {
      const before = observedFor(id).chars;
      emit(ev({ type: "tool_call_start", outputIndex: 0, callId: `c-${name}`, name }));
      emit(
        ev({
          type: "tool_call_delta",
          outputIndex: 0,
          callId: `c-${name}`,
          argumentsDelta: '{"path":"src/cockpit/flow/Flow.svelte"}',
        }),
      );
      expect(observedFor(id).chars, `${name} arguments must be observed`).toBeGreaterThan(before);
    }
  });

  test("thinking counts too — the same blindness, on the other side of the turn", async () => {
    // MUTATION: drop `reasoning_delta` from `noteOutputFrame` and this fails —
    // that is the rail frozen on "the model is answering" for the length of a
    // long think, which on this provider is routinely tens of seconds.
    const emit = await openStream();
    const id = openTurn();
    emit(ev({ type: "start" }));
    emit(ev({ type: "reasoning_delta", outputIndex: 0, delta: "let me work through this" }));
    expect(observedFor(id).chars).toBe("let me work through this".length);
    expect(observedFor(id).channel).toBe("thinking");
  });

  test("a tool call never claims the answer began, and never stops the ttft clock", async () => {
    // A tool call is not the model beginning to answer. MUTATION: route
    // `tool_call_delta` through `noteOutputDelta(..., "answer", ...)` and the
    // thinking block folds away on a tool call instead of on the reply.
    const emit = await openStream();
    const id = openTurn();
    emit(ev({ type: "start" }));
    emit(ev({ type: "reasoning_delta", outputIndex: 0, delta: "hmm" }));
    const ttft = turnTimingFor(id)?.firstOutputMs;
    emit(ev({ type: "tool_call_start", outputIndex: 0, callId: "c-9", name: "read_file" }));
    emit(ev({ type: "tool_call_delta", outputIndex: 0, callId: "c-9", argumentsDelta: '{"path":"x"}' }));
    expect(turnTimingFor(id)?.answerStarted).toBe(false);
    expect(turnTimingFor(id)?.firstOutputMs).toBe(ttft);
  });
});

// ── The rail, on screen ───────────────────────────────────────────────────

function mountRail(): {
  container: HTMLElement;
  feed: (n: number) => Promise<void>;
} {
  let set: (t: string | number) => void = () => undefined;
  const { container } = render(StreamPulseProbe, {
    props: { register: (fn: (t: string | number) => void) => (set = fn) },
  });
  return {
    container,
    feed: async (n: number) => {
      set(n);
      await tick();
      await tick();
    },
  };
}

function headIndex(container: HTMLElement): number {
  return [...container.querySelectorAll(".cell")].findIndex((c) =>
    c.classList.contains("head"),
  );
}

describe("on screen: the head advances through a tool call, and still freezes on a stall", () => {
  test("no frozen window across text → tool arguments → text", async () => {
    // MUTATION: feed the rail `railTail.length` instead of `observed.chars` in
    // TurnBeat (the pre-existing behaviour) and the head sits still for the
    // whole argument window, because the tool's characters are not in the tail.
    const { container, feed } = mountRail();
    let total = 0;
    const heads: number[] = [];
    // The preamble, the artifact's arguments, then the reply — one cumulative
    // count, exactly as `observedFor` reports it.
    for (const chunk of [40, 40, 40, 900, 900, 900, 900, 900, 30, 30]) {
      total += chunk;
      await feed(total);
      heads.push(headIndex(container));
    }
    const stuck: string[] = [];
    for (let i = 1; i < heads.length; i += 1) {
      if (heads[i] === heads[i - 1]) stuck.push(`arrival ${i} did not move the head`);
    }
    expect(stuck, stuck.join("\n")).toEqual([]);
  });

  test("A GENUINE STALL STILL FREEZES IT — the law is intact", async () => {
    // The whole point of the instrument. Counting more channels must not turn
    // it into something that moves when nothing arrived.
    const { container, feed } = mountRail();
    await feed(100);
    const at = headIndex(container);
    await new Promise((r) => setTimeout(r, 60));
    await tick();
    expect(headIndex(container), "no arrival, no movement").toBe(at);
    await feed(100); // the same count — not an arrival
    expect(headIndex(container)).toBe(at);
  });

  test("the readout names the channel, so the count cannot be misread", async () => {
    // "Do not silently blend them into one number that reads as 'the answer so
    // far'." MUTATION: delete the `.channel` span from StreamPulse and this
    // fails — the reader is then watching a character count that corresponds
    // to no text they will ever see.
    let setChannel: (c: "thinking" | "answer" | "tool-input" | null) => void = () => undefined;
    let set: (t: string | number) => void = () => undefined;
    const { container } = render(StreamPulseProbe, {
      props: {
        register: (fn: (t: string | number) => void) => (set = fn),
        registerChannel: (fn: (c: "thinking" | "answer" | "tool-input" | null) => void) =>
          (setChannel = fn),
      },
    });
    await tick();
    set(500);
    setChannel("tool-input");
    await tick();
    await tick();
    const channel = container.querySelector('[data-field="channel"]');
    expect(channel?.textContent).toBe("a tool call's input");
    // Plain words only — no wire vocabulary at a reader (§1.1).
    expect(container.textContent).not.toContain("tool_call_delta");
    expect(container.textContent).not.toContain("arguments");

    setChannel("thinking");
    await tick();
    expect(container.querySelector('[data-field="channel"]')?.textContent).toBe("thinking");
    setChannel("answer");
    await tick();
    expect(container.querySelector('[data-field="channel"]')?.textContent).toBe("the reply");
  });
});
