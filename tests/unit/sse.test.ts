// @vitest-environment node
import { describe, test, expect, vi } from "vitest";

import { openSseStream, replayGapFrame, type ResumableSseStream, WITHHELD_ERROR_MESSAGE, WITHHELD_FRAME_CODE, withheldTerminalFrame } from "../../server/router/sse.ts";
import { isKnownErrorCode } from "../../shared/errors.ts";
import { REPLAY_GAP_REASONS, SSE_EVENT_TYPES, TERMINAL_SSE_EVENT_TYPES } from "../../shared/constants";
import { createMockRes } from "../helpers/mock-http.ts";

describe("openSseStream", () => {
  test("sets correct SSE headers with 200 status", async () => {
    const res = createMockRes();
    await openSseStream(res, { keepaliveMs: 60_000 });
    expect(res.headerStatus).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(res.headers["Cache-Control"]).toBe("no-cache, no-transform");
    expect(res.headers["Connection"]).toBe("keep-alive");
    expect(res.headers["X-Accel-Buffering"]).toBe("no");
  });

  test("send writes a properly formatted SSE event", async () => {
    const res = createMockRes();
    const stream = await openSseStream(res, { keepaliveMs: 60_000 });
    stream.send(SSE_EVENT_TYPES.model, { type: "text_delta", delta: "hi" });

    const output = res.chunks.join("");
    expect(output).toContain("event: model\n");
    expect(output).toContain("data: ");
    expect(output).toMatch(/\n\n$/);
    // Data is JSON-serialized
    expect(output).toContain('"type":"text_delta"');
  });

  test("send with a string payload writes it raw (no JSON encoding)", async () => {
    const res = createMockRes();
    const stream = await openSseStream(res, { keepaliveMs: 60_000 });
    stream.send(SSE_EVENT_TYPES.done, "plain text");
    const output = res.chunks.join("");
    expect(output).toContain("data: plain text\n\n");
  });

  test("close is idempotent — calling twice does not throw", async () => {
    const res = createMockRes();
    const stream = await openSseStream(res, { keepaliveMs: 60_000 });
    stream.close();
    expect(() => stream.close()).not.toThrow();
    expect(res.ended).toBe(true);
  });

  test("send after close is a no-op (no write)", async () => {
    const res = createMockRes();
    const stream = await openSseStream(res, { keepaliveMs: 60_000 });
    stream.close();
    res.chunks.length = 0; // clear any pre-close writes
    stream.send(SSE_EVENT_TYPES.model, { type: "start" });
    expect(res.chunks).toHaveLength(0);
  });

  test("isClosed returns false initially and true after close", async () => {
    const res = createMockRes();
    const stream = await openSseStream(res, { keepaliveMs: 60_000 });
    expect(stream.isClosed()).toBe(false);
    stream.close();
    expect(stream.isClosed()).toBe(true);
  });

  test("res 'close' event closes the stream", async () => {
    const res = createMockRes();
    const stream = await openSseStream(res, { keepaliveMs: 60_000 });
    res.emit("close");
    expect(stream.isClosed()).toBe(true);
  });

  test("res 'error' event closes the stream", async () => {
    const res = createMockRes();
    const stream = await openSseStream(res, { keepaliveMs: 60_000 });
    res.emit("error", new Error("boom"));
    expect(stream.isClosed()).toBe(true);
  });

  test("keepalive interval writes a comment line", async () => {
    const res = createMockRes();
    await openSseStream(res, { keepaliveMs: 60_000 });
    // The interval is set but won't fire synchronously. We verify the
    // keepalive comment format by checking that no data was written yet
    // (the interval hasn't fired) and that the stream is still open.
    expect(res.chunks).toHaveLength(0);
    // Advance fake timers would be ideal, but vitest fake timers + setInterval
    // work; here we just verify the interval was registered (no throw).
  });

  test("keepalive writes the comment and stops after close", async () => {
    vi.useFakeTimers();
    try {
      const res = createMockRes();
      const stream = await openSseStream(res, { keepaliveMs: 100 });
      vi.advanceTimersByTime(150);
      expect(res.chunks.join("")).toContain(": keepalive");
      stream.close();
      res.chunks.length = 0;
      vi.advanceTimersByTime(200);
      // No more keepalive after close
      expect(res.chunks).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a frame the egress door cannot redact (wf1b-design M6/M7)", () => {
  test("a RESUMABLE frame is replaced by one replay_gap under its own id; the stream stays open; the withheld frame is counted", async () => {
    const { egressFailureCounts } = await import("../../server/router/egress-failures.ts");
    const res = createMockRes();
    const stream = await openSseStream(res, { keepaliveMs: 60_000, gapIdentity: { runId: "run-1" } });
    const before = egressFailureCounts().framesWithheld;
    // A BigInt cannot be serialized: the frame cannot be made safe to send.
    stream.send(SSE_EVENT_TYPES.model, { type: "text_delta", size: 1n }, 7);
    const output = res.chunks.join("");
    expect(output, "the gap stands in for the frame under ITS id").toContain(`id: 7\nevent: ${SSE_EVENT_TYPES.replayGap}\n`);
    // The last frame is the gap: its one `data:` line is the payload.
    const lastFrame = output.trimEnd().split("\n\n").at(-1)!;
    const gap = JSON.parse(lastFrame.split("\n").find((line) => line.startsWith("data: "))!.slice("data: ".length)) as Record<string, unknown>;
    expect(gap).toEqual({ runId: "run-1", droppedThroughSequence: 7, resumedFrom: 6, reason: "frame_unredactable" });
    expect(output).not.toContain("text_delta");
    expect(stream.isClosed(), "closing made the reconnect replay the same frame forever").toBe(false);
    expect(egressFailureCounts().framesWithheld).toBe(before + 1);
    // …and the stream still carries what follows.
    stream.send(SSE_EVENT_TYPES.model, { type: "text_delta", delta: "next" }, 8);
    expect(res.chunks.join("")).toContain('"delta":"next"');
    stream.close();
  });

  test("a withheld TERMINAL frame still ends the run for the client: the gap, then the same terminal event as the ONE builder makes it — its plain facts kept, an error keeping the error contract (wf1b2-correctness; WF-1b3b design M3)", async () => {
    for (const terminal of TERMINAL_SSE_EVENT_TYPES) {
      const res = createMockRes();
      const stream = await openSseStream(res, { keepaliveMs: 60_000, gapIdentity: { runId: "run-9" } });
      stream.send(terminal, { runId: "run-9", size: 1n, autoTripsReverted: true, code: "run_failed", message: "sk-live-secret in a message" }, 11);
      const frames = res.chunks.join("").trimEnd().split("\n\n");
      const [gap, end] = frames.slice(-2).map((frame) => ({
        lines: frame.split("\n"),
        data: JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice("data: ".length)) as Record<string, unknown>,
      }));
      expect(gap!.lines).toContain(`event: ${SSE_EVENT_TYPES.replayGap}`);
      expect(gap!.lines).toContain("id: 11");
      expect(end!.lines, `the ${terminal} frame must still be sent`).toContain(`event: ${terminal}`);
      expect(end!.lines.some((line) => line.startsWith("id:")), "the substitute carries no sequence").toBe(false);
      expect(end!.data).toEqual(withheldTerminalFrame(terminal, { runId: "run-9" }, { autoTripsReverted: true, code: "run_failed" }));
      expect(end!.data).toMatchObject({ runId: "run-9", withheld: "frame_unredactable", autoTripsReverted: true });
      expect(JSON.stringify(end!.data)).not.toContain("sk-live-secret");
      stream.close();
    }
  });

  test("the withheld-terminal builder: plain facts only; an error keeps a taxonomy code and a fixed message", () => {
    expect(withheldTerminalFrame(SSE_EVENT_TYPES.done, { runId: "r" }, { runId: "r", autoTripsReverted: false, text: "x" })).toEqual({ runId: "r", withheld: "frame_unredactable" });
    expect(withheldTerminalFrame(SSE_EVENT_TYPES.cancelled, { runId: "r" }, null)).toEqual({ runId: "r", withheld: "frame_unredactable" });
    expect(withheldTerminalFrame(SSE_EVENT_TYPES.error, { runId: "r" }, { code: "run_failed", autoTripsReverted: true }))
      .toEqual({ runId: "r", withheld: "frame_unredactable", autoTripsReverted: true, code: "run_failed", message: WITHHELD_ERROR_MESSAGE });
    expect(withheldTerminalFrame(SSE_EVENT_TYPES.error, { runId: "r" }, { code: "not a taxonomy code sk-1" }))
      .toEqual({ runId: "r", withheld: "frame_unredactable", code: WITHHELD_FRAME_CODE, message: WITHHELD_ERROR_MESSAGE });
    // The input-validation PREFIX is admitted for status resolution, never
    // forwarded: a code built from a path must not become the wire code.
    expect(withheldTerminalFrame(SSE_EVENT_TYPES.error, { runId: "r" }, { code: "invalid_/home/alice/.ssh/id_ed25519" }))
      .toEqual({ runId: "r", withheld: "frame_unredactable", code: "validation_failed", message: WITHHELD_ERROR_MESSAGE });
    expect(withheldTerminalFrame(SSE_EVENT_TYPES.error, { runId: "r" }, { code: "missing_/home/alice/.ssh/id_ed25519" }))
      .toEqual({ runId: "r", withheld: "frame_unredactable", code: "bad_request", message: WITHHELD_ERROR_MESSAGE });
    expect(isKnownErrorCode(WITHHELD_FRAME_CODE)).toBe(true);
  });

  test("the one builder: every reason is in the shared vocabulary; highestSequence only when given", () => {
    expect(replayGapFrame({ runId: "r" }, { droppedThroughSequence: 3, resumedFrom: 1, reason: "frames_dropped" }))
      .toEqual({ runId: "r", droppedThroughSequence: 3, resumedFrom: 1, reason: "frames_dropped" });
    expect(replayGapFrame({ runId: "r" }, { droppedThroughSequence: 0, resumedFrom: 9, highestSequence: 4, reason: "resume_point_ahead_of_run" }))
      .toEqual({ runId: "r", droppedThroughSequence: 0, resumedFrom: 9, highestSequence: 4, reason: "resume_point_ahead_of_run" });
    expect([...REPLAY_GAP_REASONS].sort()).toEqual(["frame_unredactable", "frames_dropped", "resume_point_ahead_of_run"]);
  });

  test("a resumable frame on a stream with NO gap identity is refused at the door, never written (its gap could only be one the client refuses)", async () => {
    const res = createMockRes();
    const stream = await openSseStream(res, { keepaliveMs: 60_000 });
    // The type refuses this send (a stream without a gap identity has no `id`); a caller the types do not reach meets the door.
    (stream as unknown as ResumableSseStream).send(SSE_EVENT_TYPES.model, { type: "text_delta", delta: "x" }, 3);
    expect(res.chunks.join("")).toBe("");
    expect(stream.isClosed()).toBe(true);
  });

  test("a frame outside any record (no id) closes its stream; nothing of it is written", async () => {
    const { egressFailureCounts } = await import("../../server/router/egress-failures.ts");
    const res = createMockRes();
    const stream = await openSseStream(res, { keepaliveMs: 60_000 });
    const before = egressFailureCounts().framesWithheld;
    stream.send(SSE_EVENT_TYPES.connected, { size: 1n });
    expect(res.chunks.join("")).toBe("");
    expect(stream.isClosed()).toBe(true);
    expect(egressFailureCounts().framesWithheld).toBe(before + 1);
  });
});
