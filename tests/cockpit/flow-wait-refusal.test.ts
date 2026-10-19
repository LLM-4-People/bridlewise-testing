// @vitest-environment jsdom
/**
 * A REFUSED RUN MUST NOT WAIT FOREVER.
 *
 * The defect, driven live before the fix: `beginCockpitRun` starts the wait
 * clock, then awaits `startRun`. A server that REFUSES the run (428 — the
 * guided family: no provider configured, no model chosen) settles that await
 * by THROWING, so no milestone ever arrives and no stream boundary ever
 * fires — and the wait row ticked "waiting for the harness to take the run"
 * forever over a run the server had already declined.
 *
 * What must hold now:
 *   - the refusal UNWINDS the wait at the one door every caller passes
 *     (composer route and retry verb alike): clock stopped, stage back to
 *     absence;
 *   - the standing state SPEAKS THE GRAMMAR: a principled refusal renders
 *     REFUSED with the server's own sentence (`data-answer="refused"`),
 *     a broken attempt renders FAILED — never a tick, never a spinner;
 *   - the next send clears the standing outcome (it is not that send's
 *     outcome);
 *   - the composer route reports the same distinction on the hint line.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/client.ts", async (importOriginal) => {
  // `adoptLiveRun` stays REAL: it only plants the run-state store, and the
  // adoption chain this file owns — a raced refusal names a live run, the
  // send path adopts it, the NEXT send routes to the steer door the
  // refusal's sentence promises — is provable only against the real store.
  const actual = await importOriginal<typeof import("../../src/client.ts")>();
  return {
    ...actual,
    startRun: vi.fn(),
    openRunStream: vi.fn(() => ({ close: vi.fn() })),
    sendUserMessage: vi.fn(() => "beat-refusal-1"),
    withdrawUserMessage: vi.fn(),
    createChat: vi.fn(async () => ({ id: "c1" })),
    steerCurrentRun: vi.fn(async () => true),
  };
});

import { cleanup, render } from "@testing-library/svelte";

import { startRun, withdrawUserMessage, steerCurrentRun, openRunStream } from "../../src/client.ts";
import { activeWorkspaceId, openWorkspace, activateWorkspace, closeWorkspace, resetWorkspaces } from "../../src/state/workspaces.ts";
import { liveRuns, isParked, resetRunOwnership } from "../../src/cockpit/flow/run-ownership.ts";
import { ClientError } from "../../src/data/errors.ts";
import { beginCockpitRun } from "../../src/cockpit/flow/run-stream.ts";
import { routeComposerSubmission } from "../../src/cockpit/flow/composer-router.ts";
import {
  beginWait,
  resetWait,
  waitEnd,
  waitStage,
  waitStartedAt,
} from "../../src/cockpit/flow/wait-stage.ts";
import { clearMessages } from "../../src/state/chat-messages.ts";
import { resetRunState, currentRun, isRunActive } from "../../src/state/run-state.ts";
import { setChats, currentChatId } from "../../src/state/chats.ts";
import { setProjects, selectProject } from "../../src/state/projects.ts";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";
import Flow from "../../src/cockpit/flow/Flow.svelte";
import WaitLine from "../../src/cockpit/flow/WaitLine.svelte";

const startRunMock = vi.mocked(startRun);
const withdrawUserMessageMock = vi.mocked(withdrawUserMessage);
const steerCurrentRunMock = vi.mocked(steerCurrentRun);
const openRunStreamMock = vi.mocked(openRunStream);

/** jsdom has no layout engine; the flow's virtualizer only needs the shape. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** The server's own sentence — the 428 names the remedy. */
const REFUSAL_SENTENCE =
  "No model provider is configured yet — add one under settings to run anything.";

function refusal428(): ClientError {
  return new ClientError("provider_not_configured", REFUSAL_SENTENCE, 428);
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  resetWait();
  clearMessages();
  resetRunState();
  startRunMock.mockReset();
  withdrawUserMessageMock.mockClear();
  steerCurrentRunMock.mockClear();
  openRunStreamMock.mockClear();
});
afterEach(() => {
  cleanup();
  resetWait();
  clearMessages();
  vi.unstubAllGlobals();
});

describe("a refused startRun unwinds the wait", () => {
  test("a 428 ends the wait REFUSED with the server's sentence, clock stopped", async () => {
    startRunMock.mockRejectedValueOnce(refusal428());
    await expect(
      beginCockpitRun("p1", "hello", { chatId: "c1", runEndDebounceMs: 0 }),
    ).rejects.toMatchObject({ code: "provider_not_configured", statusCode: 428 });
    // The standing outcome speaks the grammar, quoting the server.
    expect(waitEnd.get()).toEqual({ kind: "refused", reason: REFUSAL_SENTENCE });
    // The clock stopped: no send is outstanding, nothing may tick.
    expect(waitStartedAt.get()).toBeNull();
    expect(waitStage.get()).toBe("idle");
    // A refused start PERSISTED NOTHING, so the optimistic beat is taken
    // back at the door that raised it — a client-only row was a phantom a
    // reload would erase.
    expect(withdrawUserMessageMock).toHaveBeenCalledWith("beat-refusal-1");
  });

  test("a broken attempt (no server sentence) ends the wait FAILED, not refused", async () => {
    startRunMock.mockRejectedValueOnce(new ClientError("network", "fetch failed"));
    await expect(
      beginCockpitRun("p1", "hello", { chatId: "c1", runEndDebounceMs: 0 }),
    ).rejects.toMatchObject({ code: "network" });
    const end = waitEnd.get();
    expect(end).not.toBeNull();
    expect(end!.kind).toBe("failed");
    expect(waitStartedAt.get()).toBeNull();
    // A FAILED send genuinely left: the beat stays as the record of the
    // attempt — the withdrawal is the REFUSAL contract's, not the failure's.
    expect(withdrawUserMessageMock).not.toHaveBeenCalled();
  });

  test("a bare gateway 503 (http_503 fallback code) is a FAILURE — no server sentence to quote", async () => {
    startRunMock.mockRejectedValueOnce(new ClientError("http_503", "HTTP 503", 503));
    await expect(
      beginCockpitRun("p1", "hello", { chatId: "c1", runEndDebounceMs: 0 }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(waitEnd.get()!.kind).toBe("failed");
  });

  test("the next send clears the standing refusal — it is not that send's outcome", async () => {
    startRunMock.mockRejectedValueOnce(refusal428());
    await beginCockpitRun("p1", "hello", { chatId: "c1", runEndDebounceMs: 0 }).catch(
      () => undefined,
    );
    expect(waitEnd.get()).not.toBeNull();
    beginWait();
    expect(waitEnd.get()).toBeNull();
    expect(waitStartedAt.get()).not.toBeNull();
  });
});

describe("a raced chat_run_live that NAMES its run adopts that run", () => {
  // The refusal's own subject, carried on the wire since the adoption fix:
  // the run already live in this conversation (a raw-API start, a second
  // window, a raced door). Until the fix, that run streamed server-side
  // with NOTHING attached on this side — its beats never rendered (only a
  // reload brought them in) and the sentence's steer remedy was
  // unreachable, because the composer's steer door needs a run view this
  // client never had. The adoption does both at once: the stream opens (the
  // beats render live) and the view is planted (the next send steers).
  const CHAT_RUN_LIVE_SENTENCE =
    "a run is already live in this conversation — steer it with your next message, or let it settle before starting another";

  test("the named live run is adopted: the view is planted and its stream opened", async () => {
    startRunMock.mockRejectedValueOnce(
      new ClientError("chat_run_live", CHAT_RUN_LIVE_SENTENCE, 428, undefined, "run-live-1"),
    );
    await expect(
      beginCockpitRun("p1", "hello", { chatId: "c1", runEndDebounceMs: 0 }),
    ).rejects.toMatchObject({ code: "chat_run_live", statusCode: 428 });
    // The refused send itself stays refused: the beat was taken back…
    expect(withdrawUserMessageMock).toHaveBeenCalledWith("beat-refusal-1");
    // …and the wait ended on the server's sentence.
    expect(waitEnd.get()).toEqual({ kind: "refused", reason: CHAT_RUN_LIVE_SENTENCE });
    // THE ADOPTION, both halves: the named run's stream opens — the beats of
    // a run this client did not start RENDER LIVE instead of waiting for a
    // reload — and the run view is planted on the real store, so the pane
    // shows the run the sentence is about.
    expect(openRunStreamMock).toHaveBeenCalledWith("run-live-1", expect.anything());
    expect(currentRun.get()).toMatchObject({ runId: "run-live-1", projectId: "p1" });
    expect(isRunActive.get()).toBe(true);
  });

  test("the next send routes to the steer door the refusal's sentence promises", async () => {
    // The full raced-refused-then-client-send sequence: the refused send
    // adopts the named live run, and the send AFTER it steers that run —
    // before the adoption, the sentence's remedy ("steer it with your next
    // message") was unreachable from the composer, because the client had no
    // run view to route on and every send until settle was refused again
    // with the same lying promise.
    startRunMock.mockRejectedValueOnce(
      new ClientError("chat_run_live", CHAT_RUN_LIVE_SENTENCE, 428, undefined, "run-live-1"),
    );
    await expect(
      beginCockpitRun("p1", "hello", { chatId: "c1", runEndDebounceMs: 0 }),
    ).rejects.toMatchObject({ code: "chat_run_live" });
    expect(isRunActive.get()).toBe(true);
    const outcome = await routeComposerSubmission("steer it now", {
      projectId: "p1",
      chatId: "c1",
      projectPath: "/tmp/p1",
    });
    expect(outcome.kind).toBe("steered");
    expect(steerCurrentRunMock).toHaveBeenCalledWith("steer it now", expect.anything());
  });

  test("a chat_run_live with NO named run (the gate raced a run that settled) adopts nothing", async () => {
    startRunMock.mockRejectedValueOnce(
      new ClientError("chat_run_live", CHAT_RUN_LIVE_SENTENCE, 428),
    );
    await expect(
      beginCockpitRun("p1", "hello", { chatId: "c1", runEndDebounceMs: 0 }),
    ).rejects.toMatchObject({ code: "chat_run_live" });
    expect(withdrawUserMessageMock).toHaveBeenCalledWith("beat-refusal-1");
    expect(openRunStreamMock).not.toHaveBeenCalled();
    expect(currentRun.get()).toBeNull();
  });

  test("a non-chat_run_live refusal (no run is live to name) never adopts", async () => {
    startRunMock.mockRejectedValueOnce(refusal428());
    await expect(
      beginCockpitRun("p1", "hello", { chatId: "c1", runEndDebounceMs: 0 }),
    ).rejects.toMatchObject({ code: "provider_not_configured" });
    expect(openRunStreamMock).not.toHaveBeenCalled();
    expect(currentRun.get()).toBeNull();
  });

  test("a broken attempt (no server sentence) adopts nothing", async () => {
    startRunMock.mockRejectedValueOnce(new ClientError("network", "fetch failed"));
    await expect(
      beginCockpitRun("p1", "hello", { chatId: "c1", runEndDebounceMs: 0 }),
    ).rejects.toMatchObject({ code: "network" });
    expect(openRunStreamMock).not.toHaveBeenCalled();
    expect(currentRun.get()).toBeNull();
  });
});

describe("the wait row renders the outcome, not a tick", () => {
  test("a refused end renders data-answer=refused with the server's sentence and no clock", () => {
    const { container } = render(WaitLine, {
      props: {
        stage: "idle",
        startedAt: null,
        end: { kind: "refused", reason: REFUSAL_SENTENCE },
      },
    });
    const refusedEl = container.querySelector('[data-answer="refused"]');
    expect(refusedEl).not.toBeNull();
    expect(refusedEl!.textContent).toContain(REFUSAL_SENTENCE);
    // No elapsed clock and no milestone claim may stand beside a refusal.
    expect(container.querySelector('[data-field="wait-elapsed"]')).toBeNull();
    expect(container.querySelector('[data-field="wait-steps"]')).toBeNull();
    expect(container.textContent).not.toContain("waiting for the harness");
  });

  test("a failed end renders data-answer=failed", () => {
    const { container } = render(WaitLine, {
      props: {
        stage: "idle",
        startedAt: null,
        end: { kind: "failed", reason: "fetch failed" },
      },
    });
    expect(container.querySelector('[data-answer="failed"]')).not.toBeNull();
    expect(container.querySelector('[data-answer="refused"]')).toBeNull();
  });
});

describe("the composer route speaks the same grammar", () => {
  test("a 428 comes back as kind=refused quoting the server", async () => {
    startRunMock.mockRejectedValueOnce(refusal428());
    const outcome = await routeComposerSubmission("hello there", {
      projectId: "p1",
      chatId: "c1",
      projectPath: "/tmp/p1",
    });
    expect(outcome.kind).toBe("refused");
    expect(outcome.message).toBe(REFUSAL_SENTENCE);
  });

  test("a transport failure comes back as kind=failed", async () => {
    startRunMock.mockRejectedValueOnce(new ClientError("network", "fetch failed"));
    const outcome = await routeComposerSubmission("hello there", {
      projectId: "p1",
      chatId: "c1",
      projectPath: "/tmp/p1",
    });
    expect(outcome.kind).toBe("failed");
    expect(outcome.message).toContain("fetch failed");
  });
});

describe("the FLOW gives a refused send's words back to the box", () => {
  // The box's half of the refusal contract (the transcript's half is pinned
  // above): a raced start the server refuses had ALREADY emptied the
  // composer on its optimistic commit, and the reader's words existed
  // nowhere — cleared from the box, phantom in the flow, never persisted.
  // The outcome handler returns them: the beat is withdrawn at the send's
  // own door, and the box takes the words back for correction.
  let submitted: ((text: string) => void) | null = null;
  const cleared: string[] = [];
  const restored: string[] = [];
  const hints: string[] = [];

  function shellStub(): ShellApi {
    return {
      revealAt: () => 0,
      openRoom: () => {},
      closeRoom: () => {},
      openScope: () => {},
      closeScope: () => {},
      setAnnunciators: () => {},
      setMonitors: () => {},
      claimKey: () => () => {},
      pushDismiss: () => () => {},
      hint: (t) => hints.push(t),
      composerText: () => "",
      onComposerSubmit: (handler) => {
        submitted = handler;
        return () => {
          submitted = null;
        };
      },
      prefillComposer: () => {},
      clearComposer: (sent) => cleared.push(sent),
      restoreComposerText: (text) => restored.push(text),
      onComposerChange: () => () => {},
      setDeskLine: () => {},
    };
  }

  beforeEach(() => {
    submitted = null;
    cleared.length = 0;
    restored.length = 0;
    hints.length = 0;
    setChats([
      {
        id: "c1",
        projectId: "p1",
        title: "raced",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-25T00:00:00Z",
        modelId: null,
        pinned: false,
      },
    ]);
    currentChatId.set("c1");
    setProjects([
      {
        id: "p1",
        name: "proj",
        path: "/tmp/p1",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-25T00:00:00Z",
      },
    ]);
    selectProject("p1");
  });

  afterEach(() => {
    cleanup();
    selectProject(null);
    currentChatId.set(null);
    setChats([]);
    setProjects([]);
  });

  test("a raced 428 puts the words back in the box after the commit cleared it", async () => {
    const { } = render(Flow, { props: { shell: shellStub(), ingest: false } });
    // The flow registered its submit handler on the shell.
    await vi.waitFor(() => expect(submitted).not.toBeNull());
    startRunMock.mockRejectedValueOnce(
      new ClientError("chat_run_live", "a run is already live in this conversation", 428),
    );
    submitted!("raced start D");
    await vi.waitFor(() => expect(restored).toHaveLength(1));
    // The box emptied on EXACTLY the sent snapshot…
    expect(cleared).toEqual(["raced start D"]);
    // …and the refusal gave those words back, with the server's sentence on
    // the hint line beside them.
    expect(restored).toEqual(["raced start D"]);
    expect(hints).toContain("a run is already live in this conversation");
    expect(withdrawUserMessageMock).toHaveBeenCalledWith("beat-refusal-1");
  });

  test("an accepted send empties the box and never restores", async () => {
    const { } = render(Flow, { props: { shell: shellStub(), ingest: false } });
    await vi.waitFor(() => expect(submitted).not.toBeNull());
    startRunMock.mockResolvedValueOnce({ runId: "run-ok" });
    submitted!("a good send");
    await vi.waitFor(() => expect(cleared).toEqual(["a good send"]));
    expect(restored).toEqual([]);
  });
});


test.each(["accepted", "adopted-refusal"])("a delayed %s retains the workspace that sent the request", async (outcome) => {
  resetRunOwnership();
  resetWorkspaces();
  const a = activeWorkspaceId.get()!;
  let settle!: () => void;
  startRunMock.mockImplementationOnce(() => new Promise((resolve, reject) => {
    settle = () => outcome === "accepted" ? resolve({ runId: "run-late-A" })
      : reject(new ClientError("chat_run_live", "a run is already live in this conversation", 428, undefined, "run-late-A"));
  }));
  try {
    const pending = beginCockpitRun("project-A", "A's instruction", { chatId: "chat-A", runEndDebounceMs: 0 });
    const settled = pending.then(() => "accepted", (error: unknown) => {
      expect(error).toMatchObject({ code: "chat_run_live", statusCode: 428 });
      return "adopted-refusal";
    });
    openWorkspace();
    beginWait();
    const foregroundWait = { stage: waitStage.get(), started: waitStartedAt.get(), end: waitEnd.get() };
    settle();
    expect(await settled).toBe(outcome);
    expect(liveRuns()).toEqual([{ runId: "run-late-A", workspaceId: a, chatId: "chat-A" }]);
    expect(isParked(a)).toBe(true);
    expect(openRunStreamMock.mock.results[0]!.value.close).toHaveBeenCalledTimes(1);
    expect(currentRun.get(), "a refused background adoption cannot plant A's run in B").toBeNull();
    expect({ stage: waitStage.get(), started: waitStartedAt.get(), end: waitEnd.get() }).toEqual(foregroundWait);
    activateWorkspace(a);
    expect(openRunStreamMock).toHaveBeenCalledTimes(2);
  } finally { resetRunOwnership(); activeWorkspaceId.set(null); }
});

test("accepted and raced-adopted starts for the same run retain one open controller", async () => {
  resetRunOwnership();
  resetWorkspaces();
  const raced = activeWorkspaceId.get()!;
  let accept!: () => void;
  let refuse!: () => void;
  startRunMock.mockImplementationOnce(() => new Promise((resolve) => { accept = () => resolve({ runId: "run-raced" }); }));
  startRunMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    refuse = () => reject(new ClientError("chat_run_live", "this chat already has a run", 428, undefined, "run-raced"));
  }));
  try {
    const first = beginCockpitRun("p1", "first", { chatId: "chat-raced", runEndDebounceMs: 0 });
    const second = beginCockpitRun("p1", "second", { chatId: "chat-raced", runEndDebounceMs: 0 });
    const refused = expect(second).rejects.toMatchObject({ code: "chat_run_live", statusCode: 428 });
    accept();
    await first;
    const old = openRunStreamMock.mock.results[0]!.value;
    expect(old.close).not.toHaveBeenCalled();
    refuse();
    await refused;
    expect(openRunStreamMock).toHaveBeenCalledTimes(2);
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(openRunStreamMock.mock.results[1]!.value.close).not.toHaveBeenCalled();
    expect(liveRuns()).toEqual([{ runId: "run-raced", workspaceId: raced, chatId: "chat-raced" }]);
  } finally { resetRunOwnership(); activeWorkspaceId.set(null); }
});


test("closed and reset workspaces release local run ownership without stopping other workspaces", async () => {
  resetRunOwnership();
  resetWorkspaces();
  const a = activeWorkspaceId.get()!;
  startRunMock.mockResolvedValueOnce({ runId: "close-A" });
  await beginCockpitRun("p1", "A", { chatId: "chat-A", runEndDebounceMs: 0 });
  const first = openRunStreamMock.mock.results[0]!.value;
  const b = openWorkspace();
  expect(first.close).toHaveBeenCalledTimes(1);
  startRunMock.mockResolvedValueOnce({ runId: "close-B" });
  await beginCockpitRun("p1", "B", { chatId: "chat-B", runEndDebounceMs: 0 });
  const second = openRunStreamMock.mock.results[1]!.value;
  const c = openWorkspace();
  activateWorkspace(b.id);
  const secondReopened = openRunStreamMock.mock.results[2]!.value;
  expect(liveRuns()).toHaveLength(2);
  expect(closeWorkspace(a)).toBe(true);
  expect(first.close, "retiring a parked entry does not close it twice").toHaveBeenCalledTimes(1);
  expect(liveRuns().map((r) => r.runId)).toEqual(["close-B"]);
  expect(secondReopened.close).not.toHaveBeenCalled();
  expect(closeWorkspace(b.id)).toBe(true);
  expect(second.close).toHaveBeenCalledTimes(1);
  expect(secondReopened.close).toHaveBeenCalledTimes(1);
  expect(activeWorkspaceId.get()).toBe(c.id);
  expect(liveRuns()).toEqual([]);
  startRunMock.mockResolvedValueOnce({ runId: "reset-C" });
  await beginCockpitRun("p1", "C", { chatId: "chat-C", runEndDebounceMs: 0 });
  const third = openRunStreamMock.mock.results[3]!.value;
  resetWorkspaces();
  expect(third.close).toHaveBeenCalledTimes(1);
  expect(liveRuns()).toEqual([]);
  expect(activateWorkspace(c.id)).toBe(false);
  expect(openRunStreamMock).toHaveBeenCalledTimes(4);
});

test.each(["accepted", "adopted-refusal"])("a delayed %s after workspace removal cannot recreate local ownership", async (outcome) => {
  resetRunOwnership();
  resetWorkspaces();
  const a = activeWorkspaceId.get()!;
  let settle!: () => void;
  startRunMock.mockImplementationOnce(() => new Promise((resolve, reject) => {
    settle = () => outcome === "accepted" ? resolve({ runId: "closed-late-A" })
      : reject(new ClientError("chat_run_live", "already live", 428, undefined, "closed-late-A"));
  }));
  const pending = beginCockpitRun("p1", "A", { chatId: "chat-A", runEndDebounceMs: 0 });
  const settled = pending.catch((error: unknown) => { expect(error).toMatchObject({ code: "chat_run_live" }); });
  openWorkspace();
  expect(closeWorkspace(a)).toBe(true);
  settle();
  await settled;
  expect(openRunStreamMock, "the removed workspace has no future reattachment door").not.toHaveBeenCalled();
  expect(liveRuns()).toEqual([]);
});
