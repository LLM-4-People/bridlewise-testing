// @vitest-environment node
/**
 * Plain-send auto-create (§5.3 + the live-seam walkthrough): with a project
 * open but NO conversation, a plain composer send CREATES the conversation
 * first (client.ts createChat — which also selects it, so the HORIZON
 * place updates the moment it exists) and then begins the run in it. With
 * no project there is nothing to create into — the refusal says so. With a
 * conversation already open, none is created.
 *
 * THE LIVE-RUN ROUTING (the steer door): a plain send while the OPEN chat's
 * run is live STEERS it — the words queue for the run's next turn, no
 * second run starts, and the outcome states the queue. The two arms are one
 * invariant: which of steer/begin answers a plain send is decided by the
 * client's own run state alone.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/client.ts", () => ({
  createChat: vi.fn(async (_projectId: string, input: { title: string }) => ({
    id: "chat-auto-1",
    projectId: "p1",
    title: input.title,
    createdAt: "2026-07-26T10:00:00.000Z",
    updatedAt: "2026-07-26T10:00:00.000Z",
    modelId: null,
    pinned: false,
  })),
  steerCurrentRun: vi.fn(async () => false),
}));
vi.mock("../../src/cockpit/flow/run-stream.ts", () => ({
  beginCockpitRun: vi.fn(async () => ({ close: vi.fn() })),
}));

import { createChat, steerCurrentRun } from "../../src/client.ts";
import { beginCockpitRun } from "../../src/cockpit/flow/run-stream.ts";
import { routeComposerSubmission } from "../../src/cockpit/flow/composer-router.ts";
import { ClientError } from "../../src/data/errors.ts";
import { resetRunState, setRun } from "../../src/state/run-state.ts";

const createChatMock = vi.mocked(createChat);
const beginRunMock = vi.mocked(beginCockpitRun);
const steerMock = vi.mocked(steerCurrentRun);

describe("composer plain send — conversation auto-create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("no conversation open: the send creates one (titled with the user's words) and runs in it", async () => {
    const outcome = await routeComposerSubmission("fix the failing test", {
      projectId: "p1",
      chatId: null,
      projectPath: "/tmp/p1",
    });
    expect(createChatMock).toHaveBeenCalledWith("p1", { title: "fix the failing test" });
    expect(beginRunMock).toHaveBeenCalledWith("p1", "fix the failing test", {
      chatId: "chat-auto-1",
    });
    expect(outcome.kind).toBe("sent");
  });

  test("a long prompt is trimmed to a plain one-line title, never invented", async () => {
    const prompt = `please ${"x".repeat(80)}\nsecond line`;
    await routeComposerSubmission(prompt, {
      projectId: "p1",
      chatId: null,
      projectPath: "/tmp/p1",
    });
    const title = createChatMock.mock.calls[0]![1].title;
    expect(title.length).toBeLessThanOrEqual(49); // 48 + ellipsis
    expect(title.startsWith("please x")).toBe(true);
    expect(title).not.toContain("\n");
  });

  test("a conversation already open: nothing is created", async () => {
    const outcome = await routeComposerSubmission("hello again", {
      projectId: "p1",
      chatId: "c-existing",
      projectPath: "/tmp/p1",
    });
    expect(createChatMock).not.toHaveBeenCalled();
    expect(beginRunMock).toHaveBeenCalledWith("p1", "hello again", {
      chatId: "c-existing",
    });
    expect(outcome.kind).toBe("sent");
  });

  test("no project open: refused in plain words, nothing created, no run", async () => {
    const outcome = await routeComposerSubmission("hello", {
      projectId: null,
      chatId: null,
      projectPath: null,
    });
    expect(outcome.kind).toBe("refused");
    expect(outcome.message).toContain("no project is open");
    expect(createChatMock).not.toHaveBeenCalled();
    expect(beginRunMock).not.toHaveBeenCalled();
  });

  test("a failed chat-create is a failed send — the user's words are kept", async () => {
    createChatMock.mockRejectedValueOnce(new Error("server said no"));
    const outcome = await routeComposerSubmission("hello", {
      projectId: "p1",
      chatId: null,
      projectPath: "/tmp/p1",
    });
    expect(outcome.kind).toBe("failed");
    expect(outcome.message).toContain("send failed");
    expect(beginRunMock).not.toHaveBeenCalled();
  });
});

describe("composer plain send — the live-run routing (steer, never a second run)", () => {
  const liveRun = () =>
    setRun({
      runId: "run-live-1",
      status: "running",
      startedAt: Date.now(),
      modelLabel: "gemma-4-31b",
      projectId: "p1",
    });

  beforeEach(() => {
    vi.clearAllMocks();
    resetRunState();
  });

  test("a plain send under a LIVE run steers it — no second run starts, and the outcome says so", async () => {
    liveRun();
    steerMock.mockResolvedValueOnce(true);
    const outcome = await routeComposerSubmission("use the other approach", {
      projectId: "p1",
      chatId: "c-live",
      projectPath: "/tmp/p1",
    });
    expect(steerMock).toHaveBeenCalledWith(
      "use the other approach",
      expect.objectContaining({}),
    );
    // THE CONCURRENT-RUN DEFECT, DEAD BY CONSTRUCTION: the second run never
    // starts while the conversation's own run is live.
    expect(beginRunMock).not.toHaveBeenCalled();
    expect(createChatMock).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("steered");
    expect(outcome.message).toContain("steered the live run");
    expect(outcome.message).toContain("after this turn");
  });

  test("no live run → the send begins a run as it always did (the arm is unreachable after settle)", async () => {
    // A settled view (done) is NOT live: the next plain send is a new run.
    setRun({
      runId: "run-done-1",
      status: "done",
      startedAt: Date.now(),
      modelLabel: null,
      projectId: "p1",
    });
    const outcome = await routeComposerSubmission("hello again", {
      projectId: "p1",
      chatId: "c-live",
      projectPath: "/tmp/p1",
    });
    expect(steerMock).not.toHaveBeenCalled();
    expect(beginRunMock).toHaveBeenCalledWith("p1", "hello again", { chatId: "c-live" });
    expect(outcome.kind).toBe("sent");
  });

  test("the race — the run retires between the check and the steer call — falls through to a new run", async () => {
    // steerCurrentRun re-checks liveness at its own door; `false` is its
    // "no live run" answer, and the send must complete as a new run rather
    // than silently doing nothing.
    liveRun();
    steerMock.mockResolvedValueOnce(false);
    const outcome = await routeComposerSubmission("just missed it", {
      projectId: "p1",
      chatId: "c-live",
      projectPath: "/tmp/p1",
    });
    expect(beginRunMock).toHaveBeenCalledWith("p1", "just missed it", { chatId: "c-live" });
    expect(outcome.kind).toBe("sent");
  });

  test("a raced start the one-run gate refuses (the 428 envelope) surfaces as the hint, not a failure", async () => {
    // THE RACED WINDOW (UIE-014): the client's run view retired a moment
    // before the POST, so the plain send fell through to the new-run arm
    // while the server's registry still held the conversation. The refusal
    // is DESIGNED — the typed 428 now travels in the 200 envelope, so the
    // browser logs no resource error — and the composer must render it the
    // way it renders every principled refusal: REFUSED, quoting the
    // server's own sentence (the remedy names steering), never "send
    // failed", and never silence.
    beginRunMock.mockRejectedValueOnce(
      new ClientError(
        "chat_run_live",
        "a run is already live in this conversation — steer it with your next message, or let it settle before starting another",
        428,
      ),
    );
    const outcome = await routeComposerSubmission("racing a just-ended run", {
      projectId: "p1",
      chatId: "c-live",
      projectPath: "/tmp/p1",
    });
    expect(outcome.kind).toBe("refused");
    expect(outcome.message).toContain("a run is already live");
    expect(outcome.message).toContain("steer it");
  });

  test("a steer whose POST is refused (the run ended mid-send) surfaces the server's sentence honestly", async () => {
    liveRun();
    steerMock.mockRejectedValueOnce(
      Object.assign(new Error("Run not found or already completed"), {
        name: "ClientError",
      }),
    );
    const outcome = await routeComposerSubmission("too late", {
      projectId: "p1",
      chatId: "c-live",
      projectPath: "/tmp/p1",
    });
    // The steer route's own contract for a dead run is the refusal; the
    // composer quotes it rather than inventing a retry.
    expect(outcome.kind).toBe("failed");
    expect(outcome.message).toContain("already completed");
    expect(beginRunMock).not.toHaveBeenCalled();
  });
});
