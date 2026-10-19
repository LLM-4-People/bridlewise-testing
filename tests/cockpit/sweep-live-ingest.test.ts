// @vitest-environment node
/**
 * SWEEP live ingest — the run stream feeds the flight recorder (§6.6).
 *
 * The live-seam defect this pins: the ingest seam existed
 * (`sweep-data.ts`: ingestLiveSweepEvent / markStreamReconnecting /
 * markStreamClosed) but nothing called it from the real run stream — the
 * band stayed "not live — no stream open" through a whole live run.
 *
 * The fix under test: `src/cockpit/flow/run-stream.ts#beginCockpitRun`
 * opens THE run stream (client.ts openRunStream — mocked here, captured)
 * exactly ONCE and attaches the sweep feed as the stream's second
 * consumer. These tests drive the CAPTURED handlers, so they are mutation
 * tests by construction:
 *   - disconnect the ingest (drop onTimelineEvent/onModelEvent from the
 *     handlers) → the tick/live assertions fail;
 *   - open a second stream → the call-count assertion fails;
 *   - stop marking close/reconnect → the honest-state assertions fail.
 *
 * Paint-path honesty stays load-bearing: every edge advance asserted here
 * corresponds to one genuinely received event, and the close/reconnect
 * transitions are asserted NOT to move the edge.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/client.ts", () => ({
  startRun: vi.fn(async () => ({ runId: "run-live-1" })),
  openRunStream: vi.fn(() => ({ close: vi.fn() })),
  sendUserMessage: vi.fn(),
}));

import {
  openRunStream,
  startRun,
  sendUserMessage,
  type StreamHandlers,
} from "../../src/client.ts";
import { activeWorkspaceId, resetWorkspaces, openWorkspace, activateWorkspace } from "../../src/state/workspaces.ts";
import { liveRuns, isParked, resetRunOwnership } from "../../src/cockpit/flow/run-ownership.ts";
import { waitStage, waitStartedAt } from "../../src/cockpit/flow/wait-stage.ts";
import { ClientError } from "../../src/data/errors.ts";
import { setStreaming, appendAssistantMessage, clearMessages } from "../../src/state/chat-messages.ts";
import { turnTimingFor, resetTurnTimings } from "../../src/cockpit/flow/turn-timing.ts";
import { currentChatId } from "../../src/state/chats.ts";
import "../../src/state/reset-all.ts";
import { beginCockpitRun } from "../../src/cockpit/flow/run-stream.ts";
import {
  resetLiveSweepBuffer,
  sweepWindowEvents,
} from "../../src/cockpit/sweep/sweep-data.ts";
import {
  armTrigger,
  armedTriggers,
  nowEdge,
  resetSweep,
  streamState,
  sweepMarks,
} from "../../src/cockpit/sweep/sweep-store.ts";
import { bandStatusLine, bandStatusTone } from "../../src/cockpit/sweep/now-edge.ts";
import type { TimelineEventRecord, ModelEvent } from "../../shared/types.ts";

const openRunStreamMock = vi.mocked(openRunStream);
const startRunMock = vi.mocked(startRun);

function timelineRecord(
  eventId: string,
  wallTime: string,
  overrides: Partial<Record<string, unknown>> = {},
): TimelineEventRecord {
  return {
    eventId,
    eventType: "tool",
    wallTime,
    outcome: "success",
    runId: "run-live-1",
    turnId: null,
    parentEventId: null,
    description: "a real recorded event",
    ...overrides,
  } as unknown as TimelineEventRecord;
}

async function begin(): Promise<StreamHandlers> {
  await beginCockpitRun("p1", "hello", { chatId: "c1", runEndDebounceMs: 0 });
  const call = openRunStreamMock.mock.calls[0];
  expect(call).toBeDefined();
  return call![1];
}

describe("sweep live ingest — the one run stream feeds the band", () => {
  beforeEach(() => {
    resetSweep();
    resetLiveSweepBuffer();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Ends any armed run-boundary watcher (debounce 0 → synchronous).
    setStreaming(false);
    resetSweep();
    resetLiveSweepBuffer();
  });

  test("beginCockpitRun opens exactly ONE stream, for the started run", async () => {
    await begin();
    expect(vi.mocked(sendUserMessage)).toHaveBeenCalledWith("hello");
    expect(startRunMock).toHaveBeenCalledWith({
      projectId: "p1",
      prompt: "hello",
      chatId: "c1",
    });
    expect(openRunStreamMock).toHaveBeenCalledTimes(1);
    expect(openRunStreamMock.mock.calls[0]![0]).toBe("run-live-1");
  });

  test("a received timeline record lands on the band, ticks the edge, flips the chip live", async () => {
    const handlers = await begin();
    // Mutation guard: disconnecting the ingest removes this handler.
    expect(typeof handlers.onTimelineEvent).toBe("function");

    expect(streamState.get().status).toBe("idle");
    expect(bandStatusLine(streamState.get())).toBe("not live — no stream open");

    const at = "2026-07-26T10:00:00.000Z";
    handlers.onTimelineEvent!(timelineRecord("evt-1", at));

    expect(nowEdge.get().ticks).toBe(1);
    expect(nowEdge.get().timeMs).toBe(Date.parse(at));
    expect(streamState.get().status).toBe("live");
    expect(bandStatusLine(streamState.get())).toBeNull(); // live renders no status chip
    expect(sweepWindowEvents.get().some((e) => e.eventId === "evt-1")).toBe(true);
  });

  test("the edge ticks per received event — three records, three ticks, edge at the newest", async () => {
    const handlers = await begin();
    handlers.onTimelineEvent!(timelineRecord("evt-1", "2026-07-26T10:00:00.000Z"));
    handlers.onTimelineEvent!(timelineRecord("evt-2", "2026-07-26T10:00:01.000Z"));
    handlers.onTimelineEvent!(timelineRecord("evt-3", "2026-07-26T10:00:02.000Z"));
    expect(nowEdge.get().ticks).toBe(3);
    expect(nowEdge.get().timeMs).toBe(Date.parse("2026-07-26T10:00:02.000Z"));
    expect(streamState.get().eventsReceived).toBe(3);
  });

  test("a received model event ticks the edge and proves liveness, but fabricates NO band point", async () => {
    const handlers = await begin();
    expect(typeof handlers.onModelEvent).toBe("function");
    clearMessages();
    resetTurnTimings();
    const rowId = appendAssistantMessage("");

    handlers.onModelEvent!({ type: "start" } as ModelEvent);
    handlers.onModelEvent!({ type: "text_delta", outputIndex: 0, delta: "h" } as ModelEvent);

    expect(nowEdge.get().ticks).toBe(2);
    expect(streamState.get().status).toBe("live");
    // Model events are not ledger records — no synthesized band density.
    expect(
      sweepWindowEvents.get().filter((e) => e.eventId.startsWith("live-model-")),
    ).toEqual([]);
    handlers.onModelEvent!({ type: "finish", reason: "stop" } as ModelEvent, true);
    const original = turnTimingFor(rowId);
    expect(original?.observedChars, "the first live output really reached its clock").toBe(1);
    for (const event of [
      { type: "start" },
      { type: "text_delta", outputIndex: 0, delta: "h" },
      { type: "tool_call_delta", outputIndex: 0, callId: "tool", argumentsDelta: "{\"path\":\"same.ts\"}" },
      { type: "finish", reason: "stop" },
    ]) handlers.onModelEvent!(event as ModelEvent, false);
    expect(turnTimingFor(rowId), "rejected replay never restamps the original producing clock").toEqual(original);
    expect(nowEdge.get().ticks, "all actual native frame receipts still tick").toBe(7);
    resetTurnTimings();
    for (const event of [
      { type: "start" },
      { type: "text_delta", outputIndex: 0, delta: "h" },
      { type: "tool_call_delta", outputIndex: 0, callId: "tool", argumentsDelta: "{}" },
      { type: "finish", reason: "stop" },
    ]) handlers.onModelEvent!(event as ModelEvent, true, true);
    expect(turnTimingFor(rowId), "a reload with no clock cannot time retained output as fresh production").toBeUndefined();
    expect(nowEdge.get().ticks, "admitted replay remains native Sweep activity").toBe(11);
    clearMessages();
    resetTurnTimings();
  });

  test("an unplottable record (bad wallTime) does NOT advance the edge — dropped honestly", async () => {
    const handlers = await begin();
    handlers.onTimelineEvent!(timelineRecord("evt-bad", "not-a-time"));
    expect(nowEdge.get().ticks).toBe(0);
    expect(nowEdge.get().timeMs).toBeNull();
    expect(sweepWindowEvents.get().some((e) => e.eventId === "evt-bad")).toBe(false);
  });

  test("transport reconnect → the band says so (with the last real event), edge unmoved", async () => {
    const handlers = await begin();
    const at = "2026-07-26T10:00:00.000Z";
    handlers.onTimelineEvent!(timelineRecord("evt-1", at));
    const edgeBefore = nowEdge.get();

    handlers.onError!(new ClientError("stream_error", "SSE stream error (reconnecting)"));

    expect(streamState.get().status).toBe("reconnecting");
    expect(nowEdge.get()).toEqual(edgeBefore); // status transitions never move the edge
    expect(bandStatusLine(streamState.get())).toMatch(/^stream reconnecting — last event /);
    // A conversation is open and the stream degraded → actionable → alert.
    expect(bandStatusTone(streamState.get(), true)).toBe("alert");
  });

  test("a terminal stream error → honest closed state", async () => {
    const handlers = await begin();
    handlers.onTimelineEvent!(timelineRecord("evt-1", "2026-07-26T10:00:00.000Z"));
    handlers.onError!(new ClientError("stream_closed", "the connection was lost"));
    handlers.onRunSettled!();
    expect(streamState.get().status).toBe("closed");
    expect(bandStatusLine(streamState.get())).toMatch(/^stream closed — last event /);
  });

  test("the debounced run boundary paints the INFERENCE's own word — ending, never closed (UIE-084)", async () => {
    const handlers = await begin();
    setStreaming(true); // what client.ts does when the stream's start event is ingested
    handlers.onTimelineEvent!(timelineRecord("evt-1", "2026-07-26T10:00:00.000Z"));
    expect(streamState.get().status).toBe("live");
    const edgeBefore = nowEdge.get();

    setStreaming(false); // debounce 0 → the boundary is synchronous

    // THE EPILOGUE TRANSIENT: the model output ended; the socket has NOT
    // closed. The boundary's honest word is "ending" — a "closed" that
    // flips back to "live" on the next received event was never a socket
    // death, and wearing alarm ink it false-alarmed every healthy run.
    expect(streamState.get().status).toBe("ending");
    expect(nowEdge.get()).toEqual(edgeBefore); // the inference is not an event
    expect(bandStatusLine(streamState.get())).toMatch(/^stream ending — last event /);

    // REVISABLE BY DESIGN: the epilogue's next received event reclaims
    // "live" (receiving an event IS proof of liveness) — the drive-18 wire
    // shape, one GET and no reconnect, restated as the contract.
    handlers.onTimelineEvent!(timelineRecord("evt-2", "2026-07-26T10:00:02.000Z"));
    expect(streamState.get().status).toBe("live");
  });

  test("the run's natural terminal frames close the stream — the done/cancelled settle (UIE-084)", async () => {
    const handlers = await begin();
    handlers.onTimelineEvent!(timelineRecord("evt-1", "2026-07-26T10:00:00.000Z"));
    expect(streamState.get().status).toBe("live");

    // The natural close (client.ts's done/cancelled listeners call this
    // after es.close()): without it a healthy run's last transport face was
    // the last epilogue event's "live" on a stream that no longer exists.
    handlers.onRunSettled!();

    expect(streamState.get().status).toBe("closed");
    expect(bandStatusLine(streamState.get())).toMatch(/^stream closed — last event /);
  });

  test("a terminal close is not degraded by a later boundary firing — the watcher settles with the run", async () => {
    vi.useFakeTimers();
    try {
      vi.clearAllMocks();
      await beginCockpitRun("p1", "again", { chatId: "c1", runEndDebounceMs: 250 });
      const handlers = openRunStreamMock.mock.calls[0]![1];
      setStreaming(true);
      handlers.onTimelineEvent!(timelineRecord("evt-1", "2026-07-26T10:00:00.000Z"));

      // The last turn's finish starts the boundary clock…
      setStreaming(false);
      // …and the terminal frame lands INSIDE the debounce window: the
      // stream's own close is the truth, and the pending inference must not
      // overwrite it a debounce later.
      handlers.onRunSettled!();
      expect(streamState.get().status).toBe("closed");
      vi.advanceTimersByTime(500);
      expect(streamState.get().status).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a received CONTEXT report fires the armed context trigger (the compose door's live wire)", async () => {
    // THE CONTEXT-CROSSES WIRING: the run's `context` SSE event is the only
    // live wire the context gauge has, and the run stream's sweep feed
    // forwards it to the arm engine's compose door. Disconnecting the
    // forward (dropping onContextEvent from the handlers) must fail this.
    armedTriggers.set([]);
    const t = armTrigger("context-crosses", "80");
    const handlers = await begin();
    handlers.onContextEvent!({
      systemPrompt: "s",
      toolNames: [],
      historyLength: 1,
      contextTokens: 85_000,
      contextTokenLimit: 100_000,
    });
    expect(armedTriggers.get()[0]!.firedAtMs, "the crossing report fired the trigger").not.toBeNull();
    expect(sweepMarks.get().some((m) => m.origin === "arm"), "a flag dropped for the firing").toBe(true);
    void t;
    // single-shot: a second report does not re-fire.
    handlers.onContextEvent!({
      systemPrompt: "s",
      toolNames: [],
      historyLength: 1,
      contextTokens: 95_000,
      contextTokenLimit: 100_000,
    });
    expect(armedTriggers.get()[0]!.firedAtMs).not.toBeNull();
    // A report with no usable measurement fires nothing and never threw.
    armedTriggers.set([]);
    armTrigger("context-crosses", "80");
    handlers.onContextEvent!({
      systemPrompt: "s",
      toolNames: [],
      historyLength: 1,
    });
    expect(armedTriggers.get()[0]!.firedAtMs).toBeNull();
  });

  test("the inter-turn streaming flicker does NOT end the band (debounced boundary)", async () => {
    vi.useFakeTimers();
    try {
      vi.clearAllMocks();
      await beginCockpitRun("p1", "again", { chatId: "c1", runEndDebounceMs: 250 });
      const handlers = openRunStreamMock.mock.calls[0]![1];
      setStreaming(true); // the stream's start event (client ingestion)
      handlers.onTimelineEvent!(timelineRecord("evt-1", "2026-07-26T10:00:00.000Z"));

      setStreaming(false); // finish of turn 1
      vi.advanceTimersByTime(100);
      setStreaming(true); // next turn on the SAME stream — cancels the close
      vi.advanceTimersByTime(500);
      expect(streamState.get().status).toBe("live");

      setStreaming(false); // the run's output genuinely ends
      vi.advanceTimersByTime(300);
      expect(streamState.get().status).toBe("ending");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failed run start opens NO stream and leaves the band honestly idle", async () => {
    startRunMock.mockRejectedValueOnce(new Error("the server refused the run"));
    await expect(
      beginCockpitRun("p1", "x", { chatId: "c1", runEndDebounceMs: 0 }),
    ).rejects.toThrow("the server refused the run");
    expect(openRunStreamMock).not.toHaveBeenCalled();
    expect(streamState.get().status).toBe("idle");
  });

  test("a received event after reconnecting flips the band back to live", async () => {
    const handlers = await begin();
    handlers.onError!(new ClientError("stream_error", "reconnecting"));
    expect(streamState.get().status).toBe("reconnecting");
    handlers.onTimelineEvent!(timelineRecord("evt-2", "2026-07-26T10:00:05.000Z"));
    expect(streamState.get().status).toBe("live");
  });
});


test("an ending epilogue remains parkable, resumes on return, and retires only on terminal", async () => {
  resetRunOwnership();
  resetWorkspaces();
  const a = activeWorkspaceId.get()!;
  vi.clearAllMocks();
  try {
    await beginCockpitRun("p1", "epilogue", { chatId: "chat-A", runEndDebounceMs: 0 });
    const first = openRunStreamMock.mock.results[0]!.value;
    const handlers = openRunStreamMock.mock.calls[0]![1];
    setStreaming(true);
    handlers.onTimelineEvent!(timelineRecord("epilogue-before", "2026-09-05T09:00:00Z"));
    setStreaming(false);
    expect(streamState.get().status).toBe("ending");
    handlers.onError!(new ClientError("parse", "a model frame could not be read"));
    expect(streamState.get().status).toBe("ending");
    expect(liveRuns()).toEqual([{ runId: "run-live-1", workspaceId: a, chatId: "chat-A" }]);
    currentChatId.set("chat-A");
    handlers.onTimelineEvent!(timelineRecord("owned-again", "2026-09-05T09:00:01Z"));
    setStreaming(true);
    setStreaming(false);
    openWorkspace();
    currentChatId.set(null);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(isParked(a)).toBe(true);
    expect(streamState.get().status, "blank context owns no previous stream status").toBe("idle");
    expect(bandStatusLine(streamState.get())).toBe("not live — no stream open");
    expect(nowEdge.get().timeMs).toBeNull();
    expect(sweepWindowEvents.get().some((event) => event.eventId === "owned-again"), "blank context drops the previous live buffer").toBe(false);
    activateWorkspace(a);
    currentChatId.set("chat-A");
    expect(openRunStreamMock).toHaveBeenCalledTimes(2);
    const resumed = openRunStreamMock.mock.calls[1]![1];
    resumed.onTimelineEvent!(timelineRecord("epilogue-after", "2026-09-05T09:00:02Z"));
    expect(streamState.get().status).toBe("live");
    resumed.onRunSettled!();
    expect(streamState.get().status).toBe("closed");
    expect(liveRuns()).toEqual([]);
  } finally { resetRunOwnership(); activeWorkspaceId.set(null); }
});


test("an older terminal leaves the newer run's live band and wait intact", async () => {
  resetRunOwnership();
  resetWorkspaces();
  vi.clearAllMocks();
  try {
    startRunMock.mockResolvedValueOnce({ runId: "run-old" });
    await beginCockpitRun("p1", "old", { chatId: "chat-old", runEndDebounceMs: 0 });
    const old = openRunStreamMock.mock.calls[0]![1];
    old.onTimelineEvent!(timelineRecord("old-point", "2026-09-05T09:00:00Z", { runId: "run-old" }));
    expect(streamState.get().status).toBe("live");
    const newer = openWorkspace();
    startRunMock.mockResolvedValueOnce({ runId: "run-new" });
    await beginCockpitRun("p1", "new", { chatId: "chat-new", runEndDebounceMs: 0 });
    const current = openRunStreamMock.mock.calls[1]![1];
    current.onTimelineEvent!(timelineRecord("new-point", "2026-09-05T09:00:01Z", { runId: "run-new" }));
    expect(streamState.get().status).toBe("live");
    const band = streamState.get();
    const waiting = { stage: waitStage.get(), startedAt: waitStartedAt.get() };
    old.onRunSettled!();
    expect(streamState.get(), "an old close cannot label the foreground transport closed").toEqual(band);
    expect({ stage: waitStage.get(), startedAt: waitStartedAt.get() }).toEqual(waiting);
    expect(liveRuns()).toEqual([{ runId: "run-new", workspaceId: newer.id, chatId: "chat-new" }]);
    current.onRunSettled!();
    expect(streamState.get().status).toBe("closed");
    expect(liveRuns()).toEqual([]);
  } finally { resetRunOwnership(); activeWorkspaceId.set(null); }
});
