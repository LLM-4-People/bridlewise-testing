// @vitest-environment node
/**
 * THE COMPOSER EMPTIES WHEN THE WORDS ARE RECORDED — not when the server
 * finishes accepting the run.
 *
 * THE REPORTED DEFECT: the message "stays a long time in the message box" while
 * the reply area reads "your message is in" for five to ten seconds. Both
 * halves are the same cause. `beginCockpitRun` writes the user turn
 * SYNCHRONOUSLY (`sendUserMessage` — which is what puts the beat on screen and
 * what the "your message is in" milestone reports) and only THEN awaits
 * `startRun`, the server accepting the run. The composer was cleared on the
 * resolved promise, so for that whole window the reader saw their own sentence
 * twice: once as a beat in the flow, once still sitting in the box.
 *
 * The fix ties the box to the fact that decides it. `onCommitted` fires between
 * those two steps, so the box empties in the same frame the beat appears.
 *
 * WHAT MUST NOT REGRESS WITH IT: a refusal that never reached the transcript
 * still keeps the user's words for correction. That is the whole reason the
 * clear was gated on the outcome in the first place, and it is the assertion
 * below that would catch a fix that simply cleared unconditionally.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * ONLY `client.ts` IS FAKED. The composer router and `beginCockpitRun` are the
 * REAL modules, which is the whole point: an earlier version of this file
 * mocked `run-stream.ts` and therefore replaced the very code the fix lives in
 * — deleting `onCommitted` from the real source left it green, proving nothing.
 * The seam under test is inside `beginCockpitRun`, so `beginCockpitRun` has to
 * be the real one.
 *
 * `startRun` is held open deliberately: the server taking seconds to accept is
 * exactly the condition the defect needed.
 */
let acceptRun: ((v: { runId: string }) => void) | null = null;
vi.mock("../../src/client.ts", () => ({
  createChat: vi.fn(async () => ({
    id: "chat-1",
    projectId: "p1",
    title: "t",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    modelId: null,
    pinned: false,
  })),
  sendUserMessage: vi.fn(() => "beat-1"),
  withdrawUserMessage: vi.fn(),
  startRun: vi.fn(
    () =>
      new Promise<{ runId: string }>((resolve) => {
        acceptRun = resolve;
      }),
  ),
  openRunStream: vi.fn(() => ({ close: vi.fn() })),
}));

import { sendUserMessage, withdrawUserMessage } from "../../src/client.ts";
import { ClientError } from "../../src/data/errors.ts";
import { routeComposerSubmission } from "../../src/cockpit/flow/composer-router.ts";

const sendUserMessageMock = vi.mocked(sendUserMessage);
const withdrawUserMessageMock = vi.mocked(withdrawUserMessage);

beforeEach(() => {
  vi.clearAllMocks();
  acceptRun = null;
});

describe("the box empties on the transcript write, not on the round trip", () => {
  test("emptied BEFORE the server accepts the run", async () => {
    // MUTATION: drop the `opts.onCommitted?.()` call from `beginCockpitRun`
    // (run-stream.ts), or move the clear back onto the resolved promise in
    // Flow.svelte, and `committed` is still false here — which is the reported
    // five-to-ten-second window with the sentence on screen twice.
    let committed = false;
    const pending = routeComposerSubmission("what is 3 to the power of 7?", {
      projectId: "p1",
      chatId: "chat-1",
      projectPath: "/tmp/p1",
      onCommitted: () => {
        committed = true;
      },
    });
    // Let the synchronous half of the send run, and no further.
    await Promise.resolve();
    await Promise.resolve();

    expect(
      sendUserMessageMock,
      "the words must already be in the transcript",
    ).toHaveBeenCalledTimes(1);
    expect(
      committed,
      "…so the box must already be empty",
    ).toBe(true);
    expect(acceptRun, "…and the server has NOT accepted the run yet").not.toBeNull();

    acceptRun!({ runId: "run-1" });
    expect((await pending).kind).toBe("sent");
  });

  test("a refusal that never touched the transcript keeps the user's words", async () => {
    // The property the outcome-gated clear existed to protect. MUTATION: clear
    // the composer unconditionally and this fails — a refused send would wipe
    // what the reader typed and has to retype.
    let committed = false;
    const outcome = await routeComposerSubmission("no project for this", {
      projectId: null,
      chatId: null,
      projectPath: null,
      onCommitted: () => {
        committed = true;
      },
    });
    expect(outcome.kind).toBe("refused");
    expect(committed, "nothing was recorded, so nothing may be emptied").toBe(false);
  });

  test("an empty submission is refused without touching the box", async () => {
    let committed = false;
    const outcome = await routeComposerSubmission("   ", {
      projectId: "p1",
      chatId: "chat-1",
      projectPath: "/tmp/p1",
      onCommitted: () => {
        committed = true;
      },
    });
    expect(outcome.kind).toBe("refused");
    expect(committed).toBe(false);
  });
});

describe("a send the server refuses AFTER the commit gives everything back", () => {
  // The raced-start shape (the 428 chat_run_live family): the words were
  // recorded optimistically and the box emptied on exactly that fact, and
  // THEN the server declined the run. The refusal contract has to hold from
  // the other side: the send never happened, so its optimistic beat is
  // taken back (nothing persisted it) and the outcome tells the caller the
  // words are unconsumed — the box's half is Flow.svelte's
  // `restoreComposerText`, driven by its own test.
  const RACED = "a run is already live in this conversation — steer it with your next message, or let it settle before starting another";

  function refused428(): ClientError {
    return new ClientError("chat_run_live", RACED, 428);
  }

  test("the 428 refused send withdraws the optimistic beat it appended", async () => {
    const startRun = await import("../../src/client.ts").then((m) => m.startRun);
    vi.mocked(startRun).mockRejectedValueOnce(refused428());
    let committed = false;
    const outcome = await routeComposerSubmission("raced start", {
      projectId: "p1",
      chatId: "chat-1",
      projectPath: "/tmp/p1",
      onCommitted: () => {
        committed = true;
      },
    });
    // The commit DID fire — this is the after-commit refusal shape.
    expect(committed).toBe(true);
    // …and the beat it committed is taken back: the refusal persisted
    // nothing, so the optimistic row was a phantom a reload would erase.
    expect(sendUserMessageMock).toHaveBeenCalledWith("raced start");
    expect(withdrawUserMessageMock).toHaveBeenCalledWith("beat-1");
    // The outcome quotes the server's own sentence for the hint line.
    expect(outcome.kind).toBe("refused");
    expect(outcome.message).toBe(RACED);
  });

  test("an ACCEPTED send never withdraws — the beat is the record", async () => {
    const pending = routeComposerSubmission("a good send", {
      projectId: "p1",
      chatId: "chat-1",
      projectPath: "/tmp/p1",
      onCommitted: () => undefined,
    });
    // Let the synchronous half run, then hand the mock its acceptance.
    await Promise.resolve();
    await Promise.resolve();
    acceptRun!({ runId: "run-1" });
    expect((await pending).kind).toBe("sent");
    expect(withdrawUserMessageMock).not.toHaveBeenCalled();
  });

  test("a FAILED send keeps its beat — the attempt genuinely left", async () => {
    // The refusal contract is for refusals: a network failure is not a
    // designed refusal, and the reader's words stay in the flow as the
    // record of what was attempted (the box keeps the emptied state).
    const startRun = await import("../../src/client.ts").then((m) => m.startRun);
    vi.mocked(startRun).mockRejectedValueOnce(new Error("fetch failed"));
    const outcome = await routeComposerSubmission("a broken send", {
      projectId: "p1",
      chatId: "chat-1",
      projectPath: "/tmp/p1",
      onCommitted: () => undefined,
    });
    expect(outcome.kind).toBe("failed");
    expect(withdrawUserMessageMock).not.toHaveBeenCalled();
  });
});
