// @vitest-environment jsdom
/**
 * THE RUN PANE — the conversation's right-side inspector, live in jsdom.
 *
 * What must hold on screen:
 *   - each of the seven sections (progress / agents / turns / calls / edits /
 *     codebase / preparation) renders from the ONE store that owns its data,
 *     as an expandable/collapsible disclosure (shell/Disclosure.svelte) that
 *     defaults by its data's presence, and an honest absence in plain words
 *     when that store holds nothing;
 *   - the AGENTS section is driven by the SSE-fed registry: an
 *     `upsertAgent` repaints the list (the store→component binding is the
 *     thing under test — a subscribed-but-discarded store is exactly the
 *     wired-but-inert class this suite exists to catch);
 *   - the PROGRESS section reads the transcript's own measurements (turns,
 *     tool calls, tokens) and marks unmeasured figures "not measured yet";
 *   - the EDITS section reads the transcript's file-effect tool calls via
 *     the flow's own vocabulary (a tool OUTSIDE FILE_EFFECT_TOOLS never
 *     lands a row);
 *   - the CODEBASE section loads through the injectable reader and refuses
 *     to show a value measured for a DIFFERENT project's path;
 *   - the turn/call/edit ROW HEADS are real buttons whose clicks ask the
 *     flow for the row's deep surface (flow/beat-request.ts) or open the
 *     difference sheet — the row paths are covered by the seam's own suite
 *     (tests/cockpit/right-menu-row-paths.test.ts); this suite proves the
 *     rows' measured facts.
 *
 * The column chrome (the close control, the complementary landmark) is the
 * HOST's since the single menu — its contracts live in
 * tests/cockpit/run-pane-shell.test.ts, against the whole Cockpit.
 *
 * Mutation discipline: the assertions name evidence only the real binding
 * can produce (an agent's own name, a file's own path, a measured count) —
 * never ordering, never "something rendered".
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tick } from "svelte";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";

import RunPane from "../../src/cockpit/flow/RunPane.svelte";
import {
  agents,
  currentRun,
  queuedSteers,
  resetRunState,
  retireRunView,
  setRun,
  upsertAgent,
} from "../../src/state/run-state.ts";
import {
  appendAssistantMessage,
  appendToolCall,
  appendUserMessage,
  clearMessages,
  updateLastAssistantMessage,
  updateToolCallById,
} from "../../src/state/chat-messages.ts";
import { projects, currentProjectId } from "../../src/state/projects.ts";
import { gitStatus, gitRefusal, setGitStatus, setGitRefusal } from "../../src/state/git.ts";
import {
  codebaseMapLoad,
  requestCodebaseMap,
  resetCodebaseMapLoad,
  setCodebaseMapReader,
  resetRunLedgerLoad,
  resetRunLedgerFilters,
  setRunLedgerReader,
} from "../../src/state/run-pane.ts";
import type { AgentState } from "../../shared/types.ts";
import { setTools, resetTools } from "../../src/state/tools.ts";
import type { WebToolEntry } from "../../shared/types.ts";
import { resetTimelineScope, scopeTimelineToChat, scopeTimelineToTrace } from "../../src/client.ts";
import { timelineScope } from "../../src/state/timeline-query.ts";
import {
  assertLiveForWrite,
  plantHead,
  returnToLive,
  PAST_VIEW_ACT_REASON,
} from "../../src/data/asof.ts";
import { isStreaming, messages, appendEventMessage } from "../../src/state/chat-messages.ts";
import { streamState } from "../../src/cockpit/sweep/sweep-store.ts";
import { INITIAL_STREAM_STATE } from "../../src/cockpit/sweep/types.ts";
import {
  advanceWait,
  beginWait,
  resetWait,
} from "../../src/cockpit/flow/wait-stage.ts";
import { resetTurnTimings } from "../../src/cockpit/flow/turn-timing.ts";
import { consumeBandGoRequest } from "../../src/cockpit/sweep/band-request.ts";
import { consumeBeatRequest } from "../../src/cockpit/flow/beat-request.ts";
import { resetLiveSweepBuffer, ingestLiveSweepEvent } from "../../src/cockpit/sweep/sweep-data.ts";
import { recordAction, clearProvenance } from "../../src/data/ledger.ts";
import { performedActions } from "../../src/state/lens.ts";
import { uiSchema } from "../../src/state/schema-store.ts";
import type { UiSchema } from "../../shared/ui-schema.ts";
import { currentChatId, setChats } from "../../src/state/chats.ts";

/** A manifest entry declaring the given capabilities + label. */
function toolEntry(
  name: string,
  capabilities: readonly ("read" | "write")[],
  label?: string,
): WebToolEntry {
  return {
    id: name,
    name,
    description: `${name} tool`,
    inputSchema: {},
    capabilities: Object.freeze([...capabilities]),
    bounds: { timeoutMs: 1000, maxOutputBytes: 0, maxMemoryBytes: 0 },
    adapterId: "adapter",
    category: "built-in",
    kind: "filesystem",
    ...(label !== undefined ? { label } : {}),
  };
}

function makeAgent(
  agentId: string,
  lifecycleState: AgentState["lifecycleState"],
  extra: Partial<AgentState> = {},
): AgentState {
  return {
    agentId,
    agentName: agentId,
    runId: "run-1",
    taskId: "task-1",
    attemptId: "att-1",
    lifecycleState,
    turnCount: 2,
    totalPromptTokens: 120,
    totalCompletionTokens: 80,
    totalTokens: 200,
    turns: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastError: null,
    compactionSummary: null,
    suspensionReason: null,
    ...extra,
  };
}

/** The disclosure's BODY element — the content region the named section's
 * grip controls. Sections default by their data's presence, so this opens
 * a collapsed section through its own grip (the reader's click path)
 * before returning the body: a test asserting a section's content states
 * what the reader sees AFTER asking for it. */
async function sectionBody(container: HTMLElement, name: string): Promise<HTMLElement> {
  const body = container.querySelector(`#run-sec-${name}`);
  if (body !== null) return body as HTMLElement;
  const grip = container.querySelector<HTMLButtonElement>(
    `[data-verb-id="disclosure.run-sec-${name}"]`,
  );
  if (grip === null) throw new Error(`no disclosure section named ${name}`);
  grip.click();
  await tick();
  const opened = container.querySelector(`#run-sec-${name}`);
  if (opened === null) throw new Error(`opening ${name} produced no body`);
  return opened as HTMLElement;
}

const MAP_WIRE = {
  summary: {
    fileCount: 42,
    moduleCount: 7,
    symbolCount: 310,
    totalLines: 9000,
    languages: [
      { extension: ".ts", fileCount: 30 },
      { extension: ".svelte", fileCount: 12 },
    ],
  },
  moduleCount: 7,
  fileCount: 42,
};

/** The fetch the pane tests may replace per-arm (restored after each). */
const originalPaneFetch = globalThis.fetch;

beforeEach(() => {
  cleanup();
  resetRunState();
  clearMessages();
  resetCodebaseMapLoad();
  resetTurnTimings();
  resetWait();
  streamState.set(INITIAL_STREAM_STATE);
  projects.set([]);
  currentProjectId.set("p1");
  projects.set([{ id: "p1", name: "Inspector project", path: "/test/inspector", createdAt: "t", updatedAt: "t" }]);
  setChats([{ id: "inspector-chat", projectId: "p1", title: "Inspector conversation", createdAt: "t", updatedAt: "t", modelId: null, pinned: false }]);
  currentChatId.set("inspector-chat");
  gitStatus.set(null);
  gitRefusal.set(null);
  // The trace filter arms drive the real scope store; every test starts
  // from the honest global scope (and the module-local displaced-scope
  // memory follows resetTimelineScope, which is the production reset too).
  resetTimelineScope();
  // The file-effect vocabulary + labels derive from the served manifest.
  // Seed it: `edit` is the writer (with its declared label); the readers
  // stay out of the edits section. `create_artifact` declares the write
  // capability too (the real manifest does) — the edits section must
  // still refuse it, because it writes an artifact, not a file (UIE-037).
  setTools([
    toolEntry("edit", ["write"], "edit file"),
    toolEntry("create_artifact", ["write"], "create artifact"),
    toolEntry("read_file", ["read"]),
    toolEntry("execute_command", ["read"]),
    toolEntry("search_code", ["read"]),
  ]);
  // Hermetic by default: no test may reach the network through the live
  // Broker reader. Tests that exercise the load install their own reader
  // over this floor.
  setCodebaseMapReader(async () => {
    throw new Error("run-pane test: the live map reader was reached");
  });
  // The ledger's live reader gets the same floor: a test that opens the
  // ledger section without planting a page reader has failed to be
  // hermetic, and the floor says so instead of reaching the network.
  setRunLedgerReader(async () => {
    throw new Error("run-pane test: the live ledger reader was reached");
  });
  resetRunLedgerLoad();
  resetRunLedgerFilters();
  // The runs section's open asks the shared timeline refresh for the
  // streamed window; the same floor governs every other fetch the pane's
  // own doors could reach. A test that needs a real-shaped answer stubs
  // fetch per-arm (the two existing stubs below replace this floor).
  globalThis.fetch = (async () => {
    throw new Error("run-pane test: an unexpected network fetch was reached");
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  resetTools();
  globalThis.fetch = originalPaneFetch;
});

describe("the progress section", () => {
  test("no run renders the honest absence, not a spinner and not a zero", async () => {
    const { container, getByText } = render(RunPane, {});
    const section = await sectionBody(container, "progress");
    expect(section.textContent).toContain("no active run");
    expect(getByText("Current run")).toBeTruthy();
  });

  test("a live run renders status, elapsed, turns, tool calls and measured tokens", async () => {
    setRun({ runId: "r1", projectId: "p1", status: "running", startedAt: Date.now() - 2500, modelLabel: "gemma-4-31b" });
    appendAssistantMessage("first answer");
    updateLastAssistantMessage((m) => ({
      ...m,
      tokenMetrics: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
    }));
    appendToolCall({ id: "c1", name: "read_file", input: {}, output: null, status: "done", startedAt: Date.now() - 100 });
    appendToolCall({ id: "c2", name: "search_code", input: {}, output: null, status: "running", startedAt: Date.now() });

    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "progress");
    expect(section.textContent).toContain("running");
    expect(section.textContent).toContain("gemma-4-31b");
    expect(section.textContent).toContain("2.5s");
    expect(section.textContent).toContain("140");
    // One call still running of two.
    expect(section.textContent).toMatch(/1 of 2 running/);
  });

  test("a turn with no usage frame reports tokens as not measured, never a zero", async () => {
    setRun({ runId: "r1", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    appendAssistantMessage("words but no usage frame yet");
    const { container } = render(RunPane, {});
    expect((await sectionBody(container, "progress")).textContent).toContain("not measured yet");
  });

  // ── the trace id: the latest recorded run's address, from the transcript ──

  test("a recorded trace id renders with a copy affordance that carries the full id", async () => {
    setRun({ runId: "r1", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: "gemma-4-31b" });
    appendAssistantMessage("the answer");
    updateLastAssistantMessage((m) => ({ ...m, traceId: "trace-11111111-2222-3333-4444-555555555555" }));
    const { container, getByRole } = render(RunPane, {});
    const section = await sectionBody(container, "progress");
    expect(section.textContent).toContain("trace-11111111-2222-3333-4444-555555555555");
    // The copy affordance is the shared primitive and names its subject.
    const copy = getByRole("button", { name: "copy the trace id" });
    expect(copy).toBeTruthy();
  });

  test("the trace row outlives the run view — retiring the run keeps the recorded address on screen", async () => {
    setRun({ runId: "r1", projectId: "p1", status: "done", startedAt: Date.now(), modelLabel: null });
    appendAssistantMessage("the answer");
    updateLastAssistantMessage((m) => ({ ...m, traceId: "trace-aaaa1111-2222-3333-4444-555555555555" }));
    const { container, getByRole } = render(RunPane, {});
    await waitFor(async () => {
      expect((await sectionBody(container, "progress")).textContent).toContain("trace-aaaa1111");
    });
    // The run view retires moments after a run ends; the trace is a RECORD
    // fact read from the transcript, so it must still be on screen.
    retireRunView();
    await waitFor(async () => {
      const section = await sectionBody(container, "progress");
      expect(section.textContent).toContain("no active run");
      expect(section.textContent).toContain("trace-aaaa1111-2222-3333-4444-555555555555");
      expect(getByRole("button", { name: "copy the trace id" })).toBeTruthy();
    });
  });

  test("a transcript with no recorded trace id renders the honest absence, never a blank row", async () => {
    setRun({ runId: "r1", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    appendAssistantMessage("an older turn recorded before traces existed");
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "progress");
    expect(section.textContent).not.toContain("trace-");
    expect(section.textContent).toContain("not recorded yet");
  });

  test("no run and no recorded trace renders the section's own absence only", async () => {
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "progress");
    expect(section.textContent).toContain("no active run");
    expect(section.textContent).not.toContain("not recorded yet");
  });

  test("the newest assistant turn's trace wins — an older run's id never overwrites it", async () => {
    appendAssistantMessage("older turn");
    updateLastAssistantMessage((m) => ({ ...m, traceId: "trace-old0000-0000-0000-0000-000000000000" }));
    appendAssistantMessage("newer turn");
    updateLastAssistantMessage((m) => ({ ...m, traceId: "trace-new0000-0000-0000-0000-000000000000" }));
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "progress");
    expect(section.textContent).toContain("trace-new0000-0000-0000-0000-000000000000");
    expect(section.textContent).not.toContain("trace-old0000-0000-0000-0000-000000000000");
  });

  // ── the stop verb: the run's own control, beside the facts it acts on ──

  /**
   * A live run could not be stopped from the UI for the harness's whole
   * life: `cancelRun` existed with zero callers and no control anywhere.
   * The verb must appear ONLY while a run of the open chat is live (the run
   * store is cleared on chat switch, so a live view is the open chat's),
   * post the EXISTING cancel route with the run's own id, and disappear
   * when the run settles — as `cancelled`, never dressed up as `done`.
   */
  test("no stop verb exists while no run is live", async () => {
    const { container } = render(RunPane, {});
    expect(container.querySelector('[data-verb-id="run.stop"]')).toBeNull();
  });

  test("a settled run shows no stop verb either — done is not stoppable", async () => {
    setRun({ runId: "r1", projectId: "p1", status: "done", startedAt: Date.now(), modelLabel: null });
    const { container } = render(RunPane, {});
    expect(container.querySelector('[data-verb-id="run.stop"]')).toBeNull();
  });

  test("an error-settled run shows no stop verb, and its status fact wears the honest alarm ink (UIE-056)", async () => {
    // The surface half of the error-terminal settle: a run that ended at
    // an `error` frame settles the pane — the verb that would post a 404
    // to a run the server already settled is gone, and the status fact
    // wears the failure's own ink, never a live face. The failure's beat
    // (the alarm copy in the transcript) is the flow's own surface; this
    // pane states the outcome.
    setRun({ runId: "r-err", projectId: "p1", status: "error", startedAt: Date.now(), modelLabel: null });
    const { container } = render(RunPane, {});
    expect(container.querySelector('[data-verb-id="run.stop"]')).toBeNull();
    const status = container.querySelector<HTMLElement>(".fact dd[data-outcome]")!;
    expect(status.textContent).toContain("error");
    expect(status.getAttribute("data-outcome")).toBe("alarm");
  });

  test("a queued steering instruction is stated on the progress section, only while the run is live", async () => {
    // The steer routing queues words for the run's next turn; the pane is the
    // run's inspector, so the waiting instruction belongs HERE — counted by
    // the server (the steer answer + each `steered` frame), announced as
    // status, and gone the moment the run settles.
    setRun({ runId: "r-q", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    queuedSteers.set(2);
    const live = render(RunPane, {});
    const line = live.container.querySelector('[data-field="queued-steers"]');
    expect(line?.getAttribute("role")).toBe("status");
    expect(line?.textContent).toContain("2 instructions queued");
    expect(line?.textContent).toContain("after this turn");

    // Settled: nothing waits, the line goes with the run's liveness.
    setRun({ runId: "r-q", projectId: "p1", status: "done", startedAt: Date.now(), modelLabel: null });
    const settled = render(RunPane, {});
    expect(settled.container.querySelector('[data-field="queued-steers"]')).toBeNull();
  });

  test("a live run shows the stop verb; one press posts the existing cancel route and the run settles as cancelled", async () => {
    setRun({ runId: "r-live", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: "gemma-4-31b" });
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      calls.push(String(input));
      return { ok: true, status: 200, json: async () => ({ cancelled: true, runId: "r-live" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { container, getByText } = render(RunPane, {});
    const stop = container.querySelector<HTMLButtonElement>('[data-verb-id="run.stop"]')!;
    expect(stop).not.toBeNull();
    expect(stop.disabled).toBe(false);
    // The consequence sentence teaches what the press does.
    expect(stop.title).toContain("the run settles as cancelled");

    await fireEvent.click(stop);
    await waitFor(async () => {
      // THE EXISTING ROUTE, with the live run's own id — no new surface.
      expect(calls).toContain("/api/run/r-live/cancel");
      expect(getByText("cancelled")).toBeTruthy();
    });
    // The verb disappeared with the run's liveness.
    expect(container.querySelector('[data-verb-id="run.stop"]')).toBeNull();
    // And the settle is honest ink: cancelled is attention, not a completion.
    const status = container.querySelector<HTMLElement>(".fact dd[data-outcome]")!;
    expect(status.getAttribute("data-outcome")).toBe("warn");
    globalThis.fetch = originalPaneFetch;
  });

  test("a refused stop states its sentence beside the verb, and the run stays live", async () => {
    setRun({ runId: "r-refused", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      return {
        ok: false, status: 404,
        json: async () => ({ error: "not_found", message: "Run r-refused not found or already completed" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const { container } = render(RunPane, {});
    const stop = container.querySelector<HTMLButtonElement>('[data-verb-id="run.stop"]')!;
    await fireEvent.click(stop);
    await waitFor(async () => {
      expect((await sectionBody(container, "progress")).textContent).toContain("the run was not stopped");
      expect((await sectionBody(container, "progress")).textContent).toContain("already completed");
    });
    // A press that did not land leaves the run live and the verb armed.
    expect(container.querySelector('[data-verb-id="run.stop"]')).not.toBeNull();
    expect(container.querySelector(".fact dd[data-outcome]")!.textContent).toContain("running");
    globalThis.fetch = originalPaneFetch;
  });

  test("a planted past view disarms the stop — read-only is the pane's promise too", async () => {
    setRun({ runId: "r-past", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    plantHead(1_700_000_000_000);
    try {
      const { container } = render(RunPane, {});
      const stop = container.querySelector<HTMLButtonElement>('[data-verb-id="run.stop"]')!;
      expect(stop, "the verb renders, but it must not pretend to work").not.toBeNull();
      expect(stop.disabled, "§6.2 — a past view cannot write, so the verb disarms").toBe(true);
      expect(stop.title).toContain(PAST_VIEW_ACT_REASON);
      // AND THE DOOR ITSELF REFUSES — the disabled attribute is the courtesy:
      // a stop that slipped through still throws at the write's own door.
      let refused: unknown = null;
      try {
        assertLiveForWrite();
      } catch (err) {
        refused = err;
      }
      expect((refused as Error)?.message).toContain(PAST_VIEW_ACT_REASON);
    } finally {
      returnToLive();
    }
  });

  // ── the trace FILTER action: the recorded address becomes a scope ──

  test("the trace row's filter action scopes the timeline to the trace and toggles to its way back", async () => {
    setRun({ runId: "r1", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    appendAssistantMessage("the answer");
    const TRACE = "trace-11111111-2222-3333-4444-555555555555";
    updateLastAssistantMessage((m) => ({ ...m, traceId: TRACE }));
    const { getByRole } = render(RunPane, {});
    // THE CONTROL IS ONE WORD, the verb-chip register every other verb on
    // this pane speaks; the full sentence teaches from the tooltip (the
    // 231px sentence-in-a-fact-row was the menu body's widest overflow).
    const filter = getByRole("button", { name: "filter" });
    expect(filter.getAttribute("aria-pressed")).toBe("false");
    expect(filter.getAttribute("title")).toBe("filter the band by this trace");

    fireEvent.click(filter);
    const scoped = timelineScope.get();
    expect(scoped.kind).toBe("trace");
    expect(scoped.traceId).toBe(TRACE);
    expect(scoped.label).toBe("one request's trace");
    // The active state is the WORD (the way back) plus the pressed mark —
    // the label never lies about what the click will do. (The repaint lands
    // on the next microtask — Svelte batches the store→derived flush.)
    const clear = await waitFor(() =>
      getByRole("button", { name: "clear" }),
    );
    expect(clear.getAttribute("aria-pressed")).toBe("true");
    expect(clear.getAttribute("title")).toBe("clear the trace filter");

    fireEvent.click(clear);
    // From no context the way back is global — never a stuck trace scope.
    await waitFor(async () => {
      expect(timelineScope.get().kind).toBe("global");
    });
  });

  test("clearing the trace filter restores the displaced chat scope, not an invented global", async () => {
    // The user was IN a conversation when they filtered by the trace; the
    // way back is that conversation, and the displaced-scope memory (owned
    // by client.ts, module-local navigation state) is what holds it.
    scopeTimelineToChat("chat-1", ["run-1"], "chat-1");
    setRun({ runId: "r1", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    appendAssistantMessage("the answer");
    const TRACE = "trace-bbbb1111-2222-3333-4444-555555555555";
    updateLastAssistantMessage((m) => ({ ...m, traceId: TRACE }));
    const { getByRole } = render(RunPane, {});
    fireEvent.click(getByRole("button", { name: "filter" }));
    expect(timelineScope.get().kind).toBe("trace");
    const clear = await waitFor(() =>
      getByRole("button", { name: "clear" }),
    );
    fireEvent.click(clear);
    await waitFor(async () => {
      const restored = timelineScope.get();
      expect(restored.kind).toBe("chat");
      expect(restored.chatId).toBe("chat-1");
      expect(restored.label).toBe("chat-1");
    });
  });

  test("the button reads the SCOPE store, not local state — a filter set elsewhere still shows its way back", async () => {
    setRun({ runId: "r1", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    appendAssistantMessage("the answer");
    const TRACE = "trace-cccc1111-2222-3333-4444-555555555555";
    updateLastAssistantMessage((m) => ({ ...m, traceId: TRACE }));
    const { getByRole } = render(RunPane, {});
    // The scope is set by the OTHER surface (the keyboard seam, a future
    // room) — the pane's own action must still present the way back.
    scopeTimelineToTrace(TRACE);
    const clear = await waitFor(() =>
      getByRole("button", { name: "clear" }),
    );
    expect(clear.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(clear);
    await waitFor(async () => {
      expect(timelineScope.get().kind).toBe("global");
    });
  });
});

describe("the agents section", () => {
  test("no agents renders the honest absence", async () => {
    const { container } = render(RunPane, {});
    expect((await sectionBody(container, "agents")).textContent).toContain("no agents yet");
  });

  test("upsertAgent repaints the rendered list — the store→component binding is live", async () => {
    const { container } = render(RunPane, {});
    expect((await sectionBody(container, "agents")).textContent).toContain("no agents yet");

    upsertAgent(makeAgent("researcher-1", "running"));
    await waitFor(async () => {
      const section = await sectionBody(container, "agents");
      expect(section.textContent).toContain("researcher-1");
      expect(section.textContent).toContain("running");
      expect(section.textContent).toContain("2 turns");
    });

    // A state transition repaints in place (succeeded, alarm on failure).
    upsertAgent(makeAgent("researcher-1", "failed", { lastError: "budget exhausted" }));
    await waitFor(async () => {
      const section = await sectionBody(container, "agents");
      expect(section.textContent).toContain("failed");
      expect(section.textContent).toContain("budget exhausted");
    });
  });

  test("a chat switch empties the registry and the section follows (context reset)", async () => {
    upsertAgent(makeAgent("a1", "running"));
    const { container } = render(RunPane, {});
    await waitFor(async () => expect((await sectionBody(container, "agents")).textContent).toContain("a1"));
    // The reset the chat-change signal fires (run-state self-registers it).
    resetRunState();
    await waitFor(async () => expect((await sectionBody(container, "agents")).textContent).toContain("no agents yet"));
  });
});

describe("the edits section", () => {
  test("no file-effect calls renders the honest absence", async () => {
    appendToolCall({ id: "c1", name: "read_file", input: { path: "/x.ts" }, output: "…", status: "done", startedAt: 1 });
    const { container } = render(RunPane, {});
    expect((await sectionBody(container, "edits")).textContent).toContain("no files touched yet");
  });

  test("a file-effect call lands a row named by its path; a non-effect call never does", async () => {
    const { container } = render(RunPane, {});
    appendToolCall({
      id: "c1",
      name: "edit",
      input: { path: "/src/app.ts" },
      output: null,
      status: "running",
      startedAt: 1000,
    });
    appendToolCall({
      id: "c2",
      name: "execute_command",
      input: { command: "npm test" },
      output: null,
      status: "done",
      startedAt: 1001,
    });
    await waitFor(async () => {
      const section = await sectionBody(container, "edits");
      expect(section.textContent).toContain("/src/app.ts");
      expect(section.textContent).toContain("running");
      expect(section.textContent).not.toContain("npm test");
    });
    // The call settles — the row follows its status.
    updateToolCallById("c1", (tc) => ({ ...tc, status: "done" as const, endedAt: 2000 }));
    await waitFor(async () => {
      const section = await sectionBody(container, "edits");
      expect(section.textContent).toContain("done");
    });
  });

  test("an effect call whose input carried no path is NOT an edit — the section stays files-only (UIE-037)", async () => {
    // REWRITTEN from the pre-037 pin ("still shown, named by its tool").
    // That shape was honest for the case it imagined — a file edit that
    // failed to name its file — but the vocabulary it keyed on
    // ("write-capable") also admits calls that are not file edits at all:
    // measured live, a SUCCEEDED create_artifact (which declares the write
    // capability and names no file) rendered here as an ERROR-shaped row
    // ("no path in the call"). A call that names no file is not an edit;
    // its own tool beat in the flow is where it lives. The section keeps
    // its heading's promise: the FILES the run touched.
    const { container } = render(RunPane, {});
    appendToolCall({
      id: "c1",
      name: "edit",
      input: { newString: "@@" },
      output: null,
      status: "done",
      startedAt: 1000,
    });
    // `tick()` inside the poll flushes Svelte's effects BEFORE the read —
    // without it the first poll reads the pre-append DOM and the absence
    // assertion passes before the row could ever have rendered (the
    // vacuous-pass shape the mutation check caught).
    await waitFor(async () => {
      await tick();
      const section = await sectionBody(container, "edits");
      expect(section.textContent).not.toContain("no path in the call");
      expect(section.textContent).toContain("no files touched yet");
    });
  });

  test("a succeeded create_artifact never appears in the edits section (UIE-037)", async () => {
    // The exact live shape: the artifact tool declares the write capability,
    // so the old filter admitted it — and with no file path in its input it
    // rendered as an error row while the artifact it made was fine.
    const { container } = render(RunPane, {});
    appendToolCall({
      id: "c1",
      name: "create_artifact",
      input: { type: "html", title: "board", content: "<p>x</p>" },
      output: '{"ok":true,"type":"html"}',
      status: "done",
      startedAt: 1000,
    });
    // The flush-before-read shape (see the arm above): the assertion must
    // see the post-append DOM, not the absence that merely has not
    // re-rendered yet. The label (with its space) is what a leaked row
    // would render as.
    await waitFor(async () => {
      await tick();
      const section = await sectionBody(container, "edits");
      expect(section.textContent).not.toContain("create artifact");
      expect(section.textContent).not.toContain("create_artifact");
      expect(section.textContent).toContain("no files touched yet");
    });
  });
});

describe("the codebase section", () => {
  test("no project open renders the honest absence", async () => {
    currentProjectId.set(null);
    projects.set([]);
    const { container } = render(RunPane, {});
    expect((await sectionBody(container, "codebase")).textContent).toContain("no project open");
  });

  test("a measured map + git snapshot render real numbers for the open project", async () => {
    projects.set([
      { id: "p1", name: "app", path: "/home/x/app", createdAt: "t", updatedAt: "t" },
    ]);
    currentProjectId.set("p1");
    const restore = setCodebaseMapReader(async () => MAP_WIRE);
    try {
      setGitStatus({
        path: "/home/x/app",
        repository: true,
        branch: "main",
        dirtyFiles: 3,
        stagedFiles: 1,
        untrackedFiles: 2,
        entries: [],
      });
      const { container } = render(RunPane, {});
      await waitFor(async () => {
        const section = await sectionBody(container, "codebase");
        expect(section.textContent).toContain("42");
        expect(section.textContent).toContain(".ts ×30");
        expect(section.textContent).toContain("main");
        expect(section.textContent).toContain("3 changed");
      });
    } finally {
      setCodebaseMapReader(restore);
    }
  });

  test("a project with NO repository renders the honest absence — never 'detached' + 'clean'", async () => {
    // Two fabricated facts, one root cause: the zeroed status shape used to
    // read as a detached-HEAD repo with a clean tree for a folder with no
    // repository at all. The typed `repository: false` fact is what the
    // pane needs to say the custody room's own sentence instead.
    projects.set([
      { id: "p1", name: "app", path: "/home/x/app", createdAt: "t", updatedAt: "t" },
    ]);
    currentProjectId.set("p1");
    const restore = setCodebaseMapReader(async () => MAP_WIRE);
    try {
      setGitStatus({
        path: "/home/x/app",
        repository: false,
        branch: null,
        dirtyFiles: 0,
        stagedFiles: 0,
        untrackedFiles: 0,
        entries: [],
      });
      const { container } = render(RunPane, {});
      await waitFor(async () => {
        const section = await sectionBody(container, "codebase");
        expect(section.textContent).toContain("not under version control");
        expect(section.textContent).not.toContain("detached");
        expect(section.textContent).not.toContain("clean");
      });
    } finally {
      setCodebaseMapReader(restore);
    }
  });

  test("a tree with ONLY untracked files reads 'N untracked' — never 'clean'", async () => {
    // The API's own dirtyFiles deliberately excludes untracked files; a
    // label that keys cleanliness on dirtyFiles alone calls a tree with a
    // fresh file "clean", and a reader believes nothing changed.
    projects.set([
      { id: "p1", name: "app", path: "/home/x/app", createdAt: "t", updatedAt: "t" },
    ]);
    currentProjectId.set("p1");
    const restore = setCodebaseMapReader(async () => MAP_WIRE);
    try {
      setGitStatus({
        path: "/home/x/app",
        repository: true,
        branch: "main",
        dirtyFiles: 0,
        stagedFiles: 0,
        untrackedFiles: 1,
        entries: [{ status: "untracked", path: "notes/scratch.md", staged: false }],
      });
      const { container } = render(RunPane, {});
      await waitFor(async () => {
        const section = await sectionBody(container, "codebase");
        expect(section.textContent).toContain("1 untracked");
        expect(section.textContent).not.toContain("clean");
      });
    } finally {
      setCodebaseMapReader(restore);
    }
  });

  test("a map measured for a DIFFERENT path is never shown as the current project's codebase", async () => {
    projects.set([
      { id: "p1", name: "app", path: "/home/x/app", createdAt: "t", updatedAt: "t" },
    ]);
    currentProjectId.set("p1");
    // Preload a measurement for a different project entirely.
    codebaseMapLoad.set({ path: "/other/repo", load: { kind: "measured", map: MAP_WIRE.summary } });
    const restore = setCodebaseMapReader(async () => MAP_WIRE);
    try {
      const { container } = render(RunPane, {});
      // The section starts pending for /home/x/app (never the other repo's
      // numbers), then fills from the real read.
      await waitFor(async () => {
        const section = await sectionBody(container, "codebase");
        expect(section.textContent).toContain("42");
      });
    } finally {
      setCodebaseMapReader(restore);
    }
  });

  test("THE ZERO FACE'S DISCLOSURE — a prose-shaped project's zeros state what the scan covers; a code project's counts speak alone (UIE-086)", async () => {
    // The map counts CODE FILES ONLY (the language registry has no markdown
    // grammar), so a prose-only project measures honest zeros — and bare
    // zeros let a reader not tell "no code files" from "the map is broken".
    // The disclosure sentence renders at the zero face alone.
    projects.set([
      { id: "p1", name: "prose ideas", path: "/home/x/ideas", createdAt: "t", updatedAt: "t" },
    ]);
    currentProjectId.set("p1");
    const proseMapWire = {
      summary: {
        fileCount: 0,
        moduleCount: 0,
        symbolCount: 0,
        totalLines: 0,
        languages: [],
      },
      moduleCount: 0,
      fileCount: 0,
    };
    const restore = setCodebaseMapReader(async () => proseMapWire);
    try {
      const { container } = render(RunPane, {});
      await waitFor(async () => {
        const section = await sectionBody(container, "codebase");
        // The zeros are the measurement — they still render…
        expect(section.textContent).toContain("0");
        // …and beside them the disclosure says what they mean.
        expect(section.textContent).toContain("the map reads code files only");
        expect(section.textContent).toContain("no code files were found, not a failed read");
      });

      // A CODE project does not render the disclosure — its counts speak.
      projects.set([
        { id: "p2", name: "app", path: "/home/x/app", createdAt: "t", updatedAt: "t" },
      ]);
      currentProjectId.set("p2");
      const restoreCode = setCodebaseMapReader(async () => MAP_WIRE);
      try {
        await waitFor(async () => {
          const section = await sectionBody(container, "codebase");
          expect(section.textContent).toContain("42");
          expect(section.textContent).not.toContain("the map reads code files only");
        });
      } finally {
        setCodebaseMapReader(restoreCode);
      }
    } finally {
      setCodebaseMapReader(restore);
    }
  });

  test("an indexing answer renders the server's own sentence as a pending measurement", async () => {
    projects.set([
      { id: "p1", name: "app", path: "/home/x/app", createdAt: "t", updatedAt: "t" },
    ]);
    currentProjectId.set("p1");
    const restore = setCodebaseMapReader(async () => ({
      status: "indexing",
      code: "map_not_ready",
      message: "Repository map is still indexing in the background. Retry shortly.",
    }));
    try {
      const { container } = render(RunPane, {});
      await waitFor(async () => {
        expect((await sectionBody(container, "codebase")).textContent).toContain("still indexing");
      });
    } finally {
      setCodebaseMapReader(restore);
    }
  });

  test("a failed read renders the absence in plain words, never a zero", async () => {
    projects.set([
      { id: "p1", name: "app", path: "/home/x/app", createdAt: "t", updatedAt: "t" },
    ]);
    currentProjectId.set("p1");
    const restore = setCodebaseMapReader(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    try {
      const { container } = render(RunPane, {});
      await waitFor(async () => {
        const section = await sectionBody(container, "codebase");
        expect(section.textContent).toMatch(/could not|unreachable|absent|reading/i);
        expect(section.textContent).not.toContain("42");
      });
    } finally {
      setCodebaseMapReader(restore);
    }
  });

  test("a REFUSED working-tree read renders the server's own sentence — not 'not checked yet'", async () => {
    // The self-protected project's designed refusal (typed 503 git_not_run,
    // served in the 200 envelope). "not checked yet" would claim nobody
    // looked; the pane states what actually happened, in the guardian's
    // own words, exactly as the custody room does for the same refusal.
    projects.set([
      { id: "p1", name: "app", path: "/home/x/app", createdAt: "t", updatedAt: "t" },
    ]);
    currentProjectId.set("p1");
    const restore = setCodebaseMapReader(async () => MAP_WIRE);
    try {
      setGitRefusal({
        path: "/home/x/app",
        reason:
          "The working tree could not be read because this server would not run git: this folder holds the harness's own program code. Choose a different project folder.",
      });
      const { container } = render(RunPane, {});
      await waitFor(async () => {
        const section = await sectionBody(container, "codebase");
        expect(section.textContent).toContain("would not run git");
        expect(section.textContent).toContain("Choose a different project folder");
        expect(section.textContent).not.toContain("working tree not checked yet");
        expect(section.textContent).not.toContain("clean");
      });
    } finally {
      setCodebaseMapReader(restore);
    }
  });
});

// ── the run identity: the run's own address, beside the trace's ──

describe("the run identity rows", () => {
  test("no run view renders no run-id row — the trace row keeps the recorded address", async () => {
    const { container, queryByRole } = render(RunPane, {});
    const section = await sectionBody(container, "progress");
    expect(section.textContent).toContain("no active run");
    expect(queryByRole("button", { name: "copy the run id" })).toBeNull();
  });

  test("a live run renders its id with the copy affordance carrying the full value", async () => {
    setRun({ runId: "run-a1b2c3d4-e5f6", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    const { container, getByRole } = render(RunPane, {});
    const section = await sectionBody(container, "progress");
    expect(section.textContent).toContain("run-a1b2c3d4-e5f6");
    expect(getByRole("button", { name: "copy the run id" })).toBeTruthy();
  });

  test("the started-at clock renders beside the elapsed, in the shell's own format", async () => {
    // A fixed instant whose logTime rendering is stable in this zone:
    // logTime formats with toLocaleTimeString, so pin the instant and
    // assert the FACT renders (the elapsed's own start), not the wall
    // string (a machine's zone is not the surface's contract).
    const started = Date.now() - 5_000;
    setRun({ runId: "r-clock", projectId: "p1", status: "running", startedAt: started, modelLabel: null });
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "progress");
    expect(section.textContent).toContain("started");
    // elapsed renders its own figure beside it (5s ± a frame).
    expect(section.textContent).toMatch(/elapsed/);
  });

  test("the project binding names the project the RUN is bound to", async () => {
    projects.set([
      { id: "p1", name: "the open project", path: "/a", createdAt: "t", updatedAt: "t" },
      { id: "p2", name: "millivolt ideas", path: "/m", createdAt: "t", updatedAt: "t" },
    ]);
    currentProjectId.set("p1");
    setRun({ runId: "r-bind", projectId: "p2", status: "running", startedAt: Date.now(), modelLabel: null });
    const { container } = render(RunPane, {});
    expect((await sectionBody(container, "progress")).textContent).toContain("millivolt ideas");
  });

  test("the stream transport fact reads the sweep's own store — status, events, last clock", async () => {
    setRun({ runId: "r-stream", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    streamState.set(Object.freeze({ status: "live", lastEventMs: 1_700_000_000_000, eventsReceived: 12 }));
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "progress");
    expect(section.textContent).toContain("stream");
    expect(section.textContent).toMatch(/live · 12 events/);
    // The reconnecting state wears the band's own attention tone.
    streamState.set(Object.freeze({ status: "reconnecting", lastEventMs: null, eventsReceived: 0 }));
    await waitFor(async () => {
      await tick();
      const dd = (await sectionBody(container, "progress")).querySelector<HTMLElement>('[data-field="stream"]');
      expect(dd?.getAttribute("data-outcome")).toBe("warn");
      expect(dd?.textContent).toContain("reconnecting");
    });
  });

  test("THE EPILOGUE TRANSIENT READS CALM — the boundary's 'ending' face carries no alarm ink (UIE-084)", async () => {
    // The drive-18 shape: the debounced isStreaming boundary fires between
    // the last model character and the epilogue's next event, BESIDE a run
    // view still reading "running". The row's word is the inference's own
    // ("ending"), and its ink is calm — alarm here sent the reader reaching
    // for reload/reconnect mid-finish on every healthy run.
    setRun({ runId: "r-end", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    streamState.set(Object.freeze({ status: "ending", lastEventMs: 1_700_000_000_000, eventsReceived: 2_676 }));
    const { container } = render(RunPane, {});
    await waitFor(async () => {
      await tick();
      const dd = (await sectionBody(container, "progress")).querySelector<HTMLElement>('[data-field="stream"]');
      expect(dd?.textContent).toContain("ending");
      expect(dd?.getAttribute("data-outcome")).toBeNull();
    });
  });

  test("A REAL MID-RUN DEATH STILL ALARMS — 'closed' beside an unsettled or errored run stays loud (UIE-084)", async () => {
    // The r72-class real disconnect: the stream's own terminal fact while
    // the run did not complete — the error frame / the lost connection both
    // settle the run "error", and the row keeps the alarm.
    setRun({ runId: "r-dead", projectId: "p1", status: "error", startedAt: Date.now(), modelLabel: null });
    streamState.set(Object.freeze({ status: "closed", lastEventMs: 1_700_000_000_000, eventsReceived: 262 }));
    const { container } = render(RunPane, {});
    await waitFor(async () => {
      await tick();
      const dd = (await sectionBody(container, "progress")).querySelector<HTMLElement>('[data-field="stream"]');
      expect(dd?.textContent).toContain("closed");
      expect(dd?.getAttribute("data-outcome")).toBe("alarm");
    });

    // And the still-live variant: a closed stream while the run view still
    // expects events (a parse-error close, the lost-connection window
    // before the settle lands) is the loudest shape of all.
    setRun({ runId: "r-dead2", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    await waitFor(async () => {
      await tick();
      const dd = (await sectionBody(container, "progress")).querySelector<HTMLElement>('[data-field="stream"]');
      expect(dd?.getAttribute("data-outcome")).toBe("alarm");
    });
  });

  test("THE NATURAL CLOSE READS CALM — 'closed' beside a done/cancelled run is the honest settle (UIE-084)", async () => {
    setRun({ runId: "r-done", projectId: "p1", status: "done", startedAt: Date.now(), modelLabel: null });
    streamState.set(Object.freeze({ status: "closed", lastEventMs: 1_700_000_000_000, eventsReceived: 2_726 }));
    const { container } = render(RunPane, {});
    await waitFor(async () => {
      await tick();
      const dd = (await sectionBody(container, "progress")).querySelector<HTMLElement>('[data-field="stream"]');
      expect(dd?.textContent).toContain("closed");
      expect(dd?.getAttribute("data-outcome")).toBeNull();
    });

    // A deliberate stop is a natural settle too — the run view already
    // wears the warn on its own status fact; the stream row stays calm.
    setRun({ runId: "r-canx", projectId: "p1", status: "cancelled", startedAt: Date.now(), modelLabel: null });
    await waitFor(async () => {
      await tick();
      const dd = (await sectionBody(container, "progress")).querySelector<HTMLElement>('[data-field="stream"]');
      expect(dd?.getAttribute("data-outcome")).toBeNull();
    });
  });

  test("the wait milestones mirror the flow's own words while a send is outstanding, and only then", async () => {
    setRun({ runId: "r-wait", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    const { container } = render(RunPane, {});
    expect(container.querySelector('[data-field="wait-stage"]')).toBeNull();

    beginWait();
    advanceWait("accepted");
    await waitFor(async () => {
      const line = container.querySelector('[data-field="wait-stage"]');
      expect(line?.getAttribute("role")).toBe("status");
      // The owner's own sentence and the owner's own step arithmetic.
      expect(line?.textContent).toContain("the run was accepted");
      expect(line?.textContent).toContain("step 1 of 3");
    });
    advanceWait("answering");
    await waitFor(async () => {
      expect(container.querySelector('[data-field="wait-stage"]')?.textContent)
        .toContain("the model is answering");
    });
    // The wait ends — the mirror goes with it, exactly as the flow's row does.
    resetWait();
    await waitFor(async () => {
      await tick();
      expect(container.querySelector('[data-field="wait-stage"]')).toBeNull();
    });
  });

  test("no wait mirror while no run is live — the flow's row is the only manifestation", async () => {
    beginWait();
    advanceWait("accepted");
    const { container } = render(RunPane, {});
    expect(container.querySelector('[data-field="wait-stage"]')).toBeNull();
    resetWait();
  });
});

// ── the turns drilldown: every model turn's measured facts ──

describe("the turns section", () => {
  test("no assistant turns renders the honest absence", async () => {
    const { container } = render(RunPane, {});
    expect((await sectionBody(container, "turns")).textContent).toContain("no turns yet");
  });

  test("a measured turn renders its own exact numbers", async () => {
    setRun({ runId: "r1", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    appendAssistantMessage("the answer");
    updateLastAssistantMessage((m) => ({
      ...m,
      tokenMetrics: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
      timingMetrics: { startedAt: 1000, ttftMs: 1200, tps: 7.5 },
      finishReason: "stop",
      responseModel: "google/gemma-4-31b-it",
    }));
    const { container } = render(RunPane, {});
    await waitFor(async () => {
      await tick();
      const section = await sectionBody(container, "turns");
      expect(section.textContent).toContain("Turn 1");
      expect(section.textContent).toContain("first word 1.2s");
      expect(section.textContent).toContain("7.5 tok/s");
      expect(section.textContent).toContain("100 in · 40 out");
      expect(section.textContent).toContain("stop");
      expect(section.textContent).toContain("google/gemma-4-31b-it");
    });
  });

  test("the live in-flight turn says which facts are still being earned — never a zero", async () => {
    setRun({ runId: "r-live", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    appendAssistantMessage("streaming…");
    isStreaming.set(true);
    try {
      const { container } = render(RunPane, {});
      await waitFor(async () => {
        await tick();
        const section = await sectionBody(container, "turns");
        expect(section.textContent).toContain("streaming");
        // Every fact still being earned states it, and no zero renders.
        expect(section.textContent).toContain("not measured yet");
        expect(section.textContent).not.toContain("not recorded");
      });
    } finally {
      isStreaming.set(false);
    }
  });

  test("a settled turn nobody measured says not recorded — the other honest absence", async () => {
    setRun({ runId: "r-settled", projectId: "p1", status: "done", startedAt: Date.now(), modelLabel: null });
    appendAssistantMessage("an older turn from before this session");
    const { container } = render(RunPane, {});
    await waitFor(async () => {
      await tick();
      const section = await sectionBody(container, "turns");
      expect(section.textContent).toContain("not recorded");
      expect(section.textContent).not.toContain("not measured yet");
    });
  });

  test("the steered mark lands on the turn that answered the queued instruction", async () => {
    setRun({ runId: "r-steer", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    appendUserMessage("read the file and merge the edit");
    appendAssistantMessage("first answer");
    appendUserMessage("one more thing", true);
    appendAssistantMessage("second answer");
    const { container } = render(RunPane, {});
    await waitFor(async () => {
      await tick();
      const section = await sectionBody(container, "turns");
      expect(section.textContent).toContain("steered — this turn answered a queued instruction");
    });
  });

  test("an interrupted turn renders its own ending with the warn face, and no ok ink", async () => {
    setRun({ runId: "r-inc", projectId: "p1", status: "done", startedAt: Date.now(), modelLabel: null });
    appendAssistantMessage("a turn whose run died mid-stream");
    updateLastAssistantMessage((m) => ({
      ...m,
      incompleteReason: "the run ended before any word was kept",
    }));
    const { container } = render(RunPane, {});
    await waitFor(async () => {
      await tick();
      expect((await sectionBody(container, "turns")).textContent)
        .toContain("the run ended before any word was kept");
      const row = container.querySelector<HTMLElement>('#run-sec-turns .row');
      expect(row?.getAttribute("data-outcome")).toBe("warn");
    });
  });
});

// ── the calls drilldown: every tool call's measured facts ──

describe("the calls section", () => {
  test("no tool calls renders the honest absence", async () => {
    const { container } = render(RunPane, {});
    expect((await sectionBody(container, "calls")).textContent).toContain("no calls yet");
  });

  test("a call renders its label, measured duration and attempt count", async () => {
    setRun({ runId: "r1", projectId: "p1", status: "running", startedAt: Date.now(), modelLabel: null });
    appendToolCall({
      id: "c1",
      name: "edit",
      input: { path: "/a.ts" },
      output: "ok",
      status: "done",
      startedAt: 100,
      endedAt: 1_600,
      durationMs: 1_500,
      attemptCount: 2,
    });
    const { container } = render(RunPane, {});
    await waitFor(async () => {
      await tick();
      const section = await sectionBody(container, "calls");
      // The registry's own label ("edit file" — seeded in beforeEach).
      expect(section.textContent).toContain("edit file");
      expect(section.textContent).toContain("1.5s");
      expect(section.textContent).toContain("attempt 2");
    });
  });

  test("a refused call wears its typed mark, and a stranded call its observed ending", async () => {
    appendToolCall({
      id: "c2",
      name: "edit",
      input: { path: "/b.ts" },
      output: "the gate declined",
      status: "error",
      startedAt: 100,
      endedAt: 200,
      durationMs: 100,
      refused: true,
    });
    appendToolCall({
      id: "c3",
      name: "search_code",
      input: {},
      output: null,
      status: "running",
      startedAt: Date.now(),
      incompleteReason: "the run ended before this call reported a result",
    });
    const { container } = render(RunPane, {});
    await waitFor(async () => {
      await tick();
      const section = await sectionBody(container, "calls");
      expect(section.textContent).toContain("refused");
      expect(section.textContent).toContain("the run ended before this call reported a result");
      // The refused row keeps its failure ink (its status earned it); the
      // stranded row is ATTENTION, never working ink — it is not working.
      const outcomes = [...container.querySelectorAll<HTMLElement>('#run-sec-calls .row')]
        .map((r) => r.getAttribute("data-outcome"));
      expect(outcomes).toEqual(["alarm", "warn"]);
    });
  });

  test("a running call shows its live elapsed through the duration owner, never not measured", async () => {
    setRun({ runId: "r-run", projectId: "p1", status: "running", startedAt: Date.now() - 60_000, modelLabel: null });
    appendToolCall({
      id: "c-live",
      name: "read_file",
      input: { path: "/c.ts" },
      output: null,
      status: "running",
      startedAt: Date.now() - 2_000,
    });
    const { container } = render(RunPane, {});
    await waitFor(async () => {
      await tick();
      const section = await sectionBody(container, "calls");
      expect(section.textContent).toContain("running");
      expect(section.textContent).not.toContain("not measured");
    });
  });
});

// ── the preparation rollups: what the harness did to the input ──

describe("the preparation section", () => {
  test("a transcript with nothing folded or masked states both honest nothings", async () => {
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "preparation");
    expect(section.textContent).toContain("nothing folded yet");
    expect(section.textContent).toContain("nothing masked yet");
  });

  test("two turns' dedup frames render the summed savings — the rollup's own arithmetic", async () => {
    appendAssistantMessage("turn one");
    updateLastAssistantMessage((m) => ({
      ...m,
      dedupSummary: {
        applied: true,
        originalChars: 4_000,
        dedupedChars: 2_000,
        charReductionPct: 50,
        removedBlocks: 3,
        removedLines: 30,
        messageCount: 4,
      },
    }));
    appendAssistantMessage("turn two");
    updateLastAssistantMessage((m) => ({
      ...m,
      dedupSummary: {
        applied: true,
        originalChars: 1_000,
        dedupedChars: 500,
        charReductionPct: 50,
        removedBlocks: 1,
        removedLines: 10,
        messageCount: 2,
      },
    }));
    const { container } = render(RunPane, {});
    await waitFor(async () => {
      await tick();
      const rollup = (await sectionBody(container, "preparation")).querySelector('[data-field="dedup-rollup"]');
      expect(rollup?.textContent).toContain("2 calls folded");
      expect(rollup?.textContent).toContain("5,000→2,500 chars");
      expect(rollup?.textContent).toContain("−50%");
      expect(rollup?.textContent).toContain("4 repeated blocks removed");
      expect((await sectionBody(container, "preparation")).textContent).toContain("nothing masked yet");
    });
  });

  test("the redaction rollup leads with the count, splits by confidence, and names the kinds", async () => {
    appendAssistantMessage("turn one");
    updateLastAssistantMessage((m) => ({
      ...m,
      redactionNotice: {
        maskedCount: 2,
        proven: 1,
        format: 1,
        inferred: 0,
        maskedUpstream: 1,
        byTier: { api_key: 2 },
        reasons: [],
      },
    }));
    appendAssistantMessage("turn two");
    updateLastAssistantMessage((m) => ({
      ...m,
      redactionNotice: {
        maskedCount: 1,
        proven: 1,
        format: 0,
        inferred: 0,
        maskedUpstream: 0,
        byTier: { api_key: 1, password: 1 },
        reasons: [],
      },
    }));
    const { container } = render(RunPane, {});
    await waitFor(async () => {
      await tick();
      const rollup = (await sectionBody(container, "preparation")).querySelector('[data-field="redaction-rollup"]');
      expect(rollup?.textContent).toContain("3 values hidden");
      expect(rollup?.textContent).toContain("2 proven");
      expect(rollup?.textContent).toContain("1 format-matched");
      expect(rollup?.textContent).toContain("1 more was hidden upstream");
      expect(rollup?.textContent).toContain("api_key ×3");
      expect(rollup?.textContent).toContain("password ×1");
      expect((await sectionBody(container, "preparation")).textContent).toContain("nothing folded yet");
    });
  });
});

// ── the record's depth: the run list, the diagnostic roll-up, the ledger,
// the act trail ──

describe("the runs section — the record's map", () => {
  const T0 = 1_787_000_000_000;

  function ev(
    eventId: string,
    atMs: number,
    over: Readonly<{ eventType?: string; outcome?: string | null; errorCode?: string | null; runId?: string | null }> = {},
  ): Parameters<typeof ingestLiveSweepEvent>[0] {
    return {
      eventId,
      wallTime: new Date(atMs).toISOString(),
      eventType: over.eventType ?? "run",
      outcome: over.outcome ?? null,
      ...(over.errorCode !== undefined ? { errorCode: over.errorCode } : {}),
      runId: over.runId ?? null,
      turnId: null,
      description: "",
    };
  }

  beforeEach(() => {
    resetLiveSweepBuffer();
    returnToLive();
  });

  test("an empty band states the honest absence", async () => {
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "runs");
    expect(section.textContent).toContain("no runs on the band yet");
  });

  test("the planted window's runs render their spans, counts and errors — and the live run is marked", async () => {
    setRun({ runId: "run-live", status: "running", modelLabel: "gemma", startedAt: T0, projectId: "p1" });
    ingestLiveSweepEvent(ev("e1", T0, { runId: "run-live" }));
    ingestLiveSweepEvent(ev("e2", T0 + 900, { runId: "run-live", eventType: "tool", outcome: "failed", errorCode: "tool_refused" }));
    ingestLiveSweepEvent(ev("e3", T0 + 50_000, { runId: "run-old" }));
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "runs");
    const rows = section.querySelectorAll("li.row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("live");
    expect(rows[0]!.textContent).toContain("2 events");
    expect(rows[0]!.textContent).toContain("1 error");
    expect(rows[1]!.textContent).toContain("recorded");
    expect(rows[1]!.textContent).toContain("run-old".slice(0, 8));
  });

  test("a tail slice names its figures as in view — the row never presents the slice as the run's whole record", async () => {
    // run-old's opening `run` event is not in view — only its tail is: the
    // shape a later run's stream or a newest-page refresh leaves behind on
    // a long chat (measured live on a 2,343-event chat: a 33.8s, 200-event
    // run displayed as "719ms · 38 events"). The sentence states the
    // DETECTION'S OWN TRUTH — the opening record is not in view — never a
    // cause the window-local detection cannot distinguish (paged out,
    // streamed before this window, or dropped as unparseable).
    ingestLiveSweepEvent(ev("e1", T0 + 5_000, { runId: "run-old", eventType: "tool" }));
    ingestLiveSweepEvent(ev("e2", T0 + 5_100, { runId: "run-old", eventType: "token", outcome: "failed" }));
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "runs");
    const row = section.querySelector("li.row");
    expect(row!.textContent).toContain("in view from");
    expect(row!.textContent).toContain("the opening record of this run is not in view");
    expect(row!.textContent).not.toContain("the run began before this window");
    expect(row!.textContent).toContain("2 events in view");
    expect(row!.textContent).toContain("1 error in view");
    const go = row!.querySelector<HTMLButtonElement>('[data-verb-id="run-pane.run-go"]');
    expect(go!.title).toContain("first event in view");
    expect(go!.title).toContain("this run's opening record is not in this window");
  });

  test("THE GO: the row's go verb asks the band seam for the run's t0 — a read, so it lives in a past view too", async () => {
    ingestLiveSweepEvent(ev("e1", T0, { runId: "run-a" }));
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "runs");
    const go = section.querySelector<HTMLButtonElement>('[data-verb-id="run-pane.run-go"]');
    expect(go).not.toBeNull();
    // A head is already planted — the go still works: planting is a READ.
    plantHead(T0 - 5_000);
    go!.click();
    await tick();
    expect(consumeBandGoRequest()).toBe(T0);
    expect(consumeBandGoRequest()).toBeNull();
    returnToLive();
  });

  test("opening the map asks the ONE shared timeline refresh for the window — a reloaded page's runs fill from the record, scoped on the wire", async () => {
    // The hermetic fetch floor replaced per-arm: answer the shared query with
    // a real-shaped page scoped by the chat the client-side net accepts. The
    // captured bodies pin that the refresh carries the SCOPE's chat id (the
    // server-side resolution) — the unscoped global page measured as an empty
    // window on a busy ledger, every row foreign to the chat.
    scopeTimelineToChat("the open chat", ["run-live"], "chat-map");
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(init?.body !== undefined ? JSON.parse(String(init.body)) : null);
      return new Response(
        JSON.stringify({
          events: [
            {
              eventId: "q1",
              wallTime: new Date(T0).toISOString(),
              eventType: "run",
              outcome: null,
              runId: "run-live",
              turnId: null,
              description: "run started",
            },
          ],
          total: 1,
          hasMore: false,
          nextCursor: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const { container } = render(RunPane, {});
      const section = await sectionBody(container, "runs");
      await waitFor(async () => {
        await tick();
        expect(section.textContent).toContain("run run-live");
      });
      const scoped = bodies.find(
        (b) => (b as Record<string, unknown> | null)?.["chatId"] === "chat-map",
      );
      expect(scoped, "the refresh must carry the scope's chatId on the wire").toBeDefined();
    } finally {
      globalThis.fetch = originalPaneFetch;
      resetTimelineScope();
    }
  });
});

describe("the record section — the diagnostic roll-up", () => {
  const T0 = 1_787_000_000_000;

  beforeEach(() => {
    resetLiveSweepBuffer();
  });

  test("an empty window states the honest nothing", async () => {
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "record");
    expect(section.textContent).toContain("nothing recorded on the band yet");
  });

  test("the window's figures render beside the error codes, and the interrupted turns wear their own ending sentences", async () => {
    ingestLiveSweepEvent({
      eventId: "w1",
      wallTime: new Date(T0).toISOString(),
      eventType: "tool",
      outcome: "failed",
      errorCode: "tool_refused",
      runId: "run-a",
      turnId: null,
      description: "",
    });
    ingestLiveSweepEvent({
      eventId: "w2",
      wallTime: new Date(T0 + 1).toISOString(),
      eventType: "token",
      outcome: null,
      runId: "run-a",
      turnId: null,
      description: "",
    });
    // A COMPLETE turn beside the interrupted one: the roll-up's incomplete
    // face must hold only the turn that never answered — a severed filter
    // that lists every turn reds on this assertion.
    appendAssistantMessage("a complete turn");
    appendAssistantMessage("an interrupted turn");
    updateLastAssistantMessage((m) => ({ ...m, incompleteReason: "the run was stopped before this turn reported an answer" }));
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "record");
    const contents = section.querySelector('[data-field="record-contents"]');
    expect(contents?.textContent).toContain("2 events");
    expect(contents?.textContent).toContain("1 error");
    expect(section.querySelector('[data-field="record-error-codes"]')?.textContent).toContain("tool_refused ×1");
    const incomplete = section.querySelectorAll('[data-verb-id="run-pane.incomplete-turn-scope"]');
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]!.textContent).toContain("Turn 2");
    expect(section.textContent).toContain("the run was stopped before this turn reported an answer");
  });

  test("an interrupted turn's row head asks the beat seam for its fact sheet", async () => {
    appendAssistantMessage("an interrupted turn");
    updateLastAssistantMessage((m) => ({ ...m, incompleteReason: "interrupted" }));
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "record");
    const id = messages.get()[0]!.id;
    section.querySelector<HTMLButtonElement>('[data-verb-id="run-pane.incomplete-turn-scope"]')!.click();
    await tick();
    const ask = consumeBeatRequest();
    expect(ask).toEqual({ id, want: "scope" });
  });
});

describe("the ledger section — the run-scoped event ledger", () => {
  const T0 = 1_787_000_000_000;

  function row(
    eventId: string,
    over: Readonly<{ eventType?: string; outcome?: string | null; errorCode?: string | null; description?: string }> = {},
  ): Record<string, unknown> {
    return {
      eventId,
      eventType: over.eventType ?? "run",
      wallTime: new Date(T0).toISOString(),
      outcome: over.outcome ?? null,
      errorCode: over.errorCode ?? null,
      runId: "run-a",
      turnId: null,
      description: over.description ?? "",
      ledgerId: "l",
      sequence: "1",
      recordKind: "event",
      traceId: null,
      parentEventId: null,
    };
  }

  function page(events: Record<string, unknown>[], total: number, hasMore = false, nextCursor: string | null = null): Record<string, unknown> {
    return { events, total, hasMore, nextCursor };
  }

  /** Installs a reader answering `makePage` and returns the bodies it saw,
   * plus the restore that puts the hermetic floor back (the seam returns the
   * previous READER, so the restore wraps the reinstall rather than being
   * the reader itself — calling the reader would invoke the floor). */
  function plantReader(makePage: (body: Record<string, unknown>) => Record<string, unknown>): { bodies: Record<string, unknown>[]; restore: () => void } {
    const bodies: Record<string, unknown>[] = [];
    const prev = setRunLedgerReader(async (body) => {
      bodies.push(body);
      return makePage(body);
    });
    return { bodies, restore: () => setRunLedgerReader(prev) };
  }

  beforeEach(() => {
    resetLiveSweepBuffer();
    resetRunLedgerLoad();
    resetRunLedgerFilters();
    setChats([{ id: "chat-ledger", projectId: "p1", title: "Ledger conversation", createdAt: "t", updatedAt: "t", modelId: null, pinned: false }]);
    currentChatId.set("chat-ledger");
    returnToLive();
  });

  afterEach(() => {
    currentChatId.set(null);
  });

  test("the section opens on its grip and its question reaches the wire with the chat scope", async () => {
    const { bodies, restore } = plantReader(() => page([row("e1", { description: "run started" })], 1));
    try {
      const { container } = render(RunPane, {});
      const section = await sectionBody(container, "ledger");
      await waitFor(async () => {
        await tick();
        expect(section.textContent).toContain("run started");
      });
      expect(bodies[0]!["chatId"]).toBe("chat-ledger");
    } finally {
      restore();
    }
  });

  test("THE FILTERS: the outcome chip narrows the rows shown while the recorded total never moves", async () => {
    const { restore } = plantReader(() =>
      page(
        [
          row("ok1", { eventType: "token", outcome: "succeeded", description: "tokens recorded" }),
          row("bad1", { eventType: "tool", outcome: "failed", description: "the tool failed" }),
          row("denied1", { eventType: "error", outcome: "denied", description: "the gate denied" }),
        ],
        7,
      ));
    try {
      const { container } = render(RunPane, {});
      const section = await sectionBody(container, "ledger");
      await waitFor(async () => {
        await tick();
        expect(section.textContent).toContain("the tool failed");
      });
      const countBefore = section.querySelector('[data-field="ledger-count"]')!.textContent;
      expect(countBefore).toContain("Matches: 3 · 3 loaded · 7 recorded");
      // The row INK paints by the counting-policy owner's predicate — the
      // same `isErrorEvent` the chips narrow by (delegated, never
      // re-spelled): a failed row alarm, a denied row warn (NOT alarm — a
      // denied gate block is not an error), an ok row ok.
      const ink = (needle: string): string | null =>
        [...container.querySelectorAll<HTMLElement>(".ledger-row")]
          .find((r) => r.textContent!.includes(needle))!
          .getAttribute("data-outcome");
      expect(ink("tokens recorded")).toBe("ok");
      expect(ink("the tool failed")).toBe("alarm");
      expect(ink("the gate denied")).toBe("warn");
      const failedChip = section.querySelector<HTMLButtonElement>('[data-verb-id="run-pane.ledger-outcome"]');
      // The chips render in the fixed order: all, failed, denied, ok.
      const chips = section.querySelectorAll<HTMLButtonElement>('[data-verb-id="run-pane.ledger-outcome"]');
      chips[1]!.click();
      await tick();
      const narrowed = await sectionBody(container, "ledger");
      expect(narrowed.textContent).toContain("the tool failed");
      expect(narrowed.textContent).not.toContain("tokens recorded");
      expect(narrowed.querySelector('[data-field="ledger-count"]')!.textContent).toContain("Matches: 1 · 3 loaded · 7 recorded");
    } finally {
      restore();
    }
  });

  test("the honest load-more: the next page appends by cursor and the count sentence follows", async () => {
    const { bodies, restore } = plantReader((body) => {
      if (body["cursor"] === undefined) return page([row("e1", { description: "first page row" })], 3, true, "1");
      return page([row("e2", { description: "second page row" })], 3, false, null);
    });
    try {
      const { container } = render(RunPane, {});
      let section = await sectionBody(container, "ledger");
      await waitFor(async () => {
        await tick();
        expect(section.textContent).toContain("first page row");
      });
      const more = section.querySelector<HTMLButtonElement>('[data-verb-id="run-pane.ledger-more"]');
      expect(more).not.toBeNull();
      more!.click();
      await waitFor(async () => {
        await tick();
        section = await sectionBody(container, "ledger");
        expect(section.textContent).toContain("second page row");
      });
      expect(bodies[1]!["cursor"]).toBe("1");
      expect(section.querySelector('[data-field="ledger-count"]')!.textContent).toContain("Matches: 2 · 2 loaded · 3 recorded");
    } finally {
      restore();
    }
  });

  test("THE ROW REVEAL: an event the transcript holds a beat for renders the reveal verb and it asks the beat seam; a ledger-only row renders none", async () => {
    const messageId = appendEventMessage("self-healing", "an inline recorded event", "evt-live");
    const { restore } = plantReader(() =>
      page(
        [
          row("evt-live", { eventType: "self-healing", description: "an inline recorded event" }),
          row("evt-only", { eventType: "token", description: "a ledger-only milestone" }),
        ],
        2,
      ));
    try {
      const { container } = render(RunPane, {});
      const section = await sectionBody(container, "ledger");
      await waitFor(async () => {
        await tick();
        expect(section.textContent).toContain("a ledger-only milestone");
      });
      const reveal = section.querySelector<HTMLButtonElement>('[data-verb-id="run-pane.ledger-reveal"]');
      expect(reveal).not.toBeNull();
      reveal!.click();
      await tick();
      const ask = consumeBeatRequest();
      expect(ask).toEqual({ id: messageId, want: "reveal" });
      // The ledger-only row renders as the fact it is — no reveal affordance.
      const rows = section.querySelectorAll(".ledger-row");
      expect(rows[1]!.querySelector('[data-verb-id="run-pane.ledger-reveal"]')).toBeNull();
    } finally {
      restore();
    }
  });

  test("THE LIVE REVEAL: a safety finding that arrived LIVE with its ledger address renders its reveal verb immediately — the drive-18 asymmetry's face; one that honestly carried no address renders none", async () => {
    // The live safety-findings wire stamps each finding's own eventId (the
    // persist-first order) and the client appends WITH it — so the reveal
    // map holds the entry the moment the finding lands and the ledger row
    // reveals without a reload. The honest-absent case (a run bound to no
    // chat, or a persist that failed) carries no address and its row stays
    // the plain fact it honestly is.
    const liveId = appendEventMessage(
      "safety-finding",
      "Safety finding (workaround): a live-arrived finding with its address",
      "evt-safety-live",
    );
    const secondLiveId = appendEventMessage(
      "safety-finding",
      "Safety finding (workaround): a live-arrived finding with its address",
      "evt-safety-second",
    );
    const { restore } = plantReader(() =>
      page([
        row("evt-safety-live", {
          eventType: "quality",
          description: "Safety finding (workaround): a live-arrived finding with its address",
        }),
        row("evt-safety-second", {
          eventType: "quality",
          description: "Safety finding (workaround): a live-arrived finding with its address",
        }),
        row("evt-safety-anon", {
          eventType: "quality",
          description: "Safety finding (workaround): a live-arrived finding the wire could not address",
        }),
      ], 3),
    );
    try {
      const { container } = render(RunPane, {});
      const section = await sectionBody(container, "ledger");
      await waitFor(async () => {
        await tick();
        expect(section.textContent).toContain("a live-arrived finding the wire could not address");
      });
      const rows = section.querySelectorAll(".ledger-row");
      expect(rows.length).toBe(3);
      // The ADDRESSED finding's row: the reveal verb exists NOW, not after
      // a reload — and it asks the beat seam for the live beat the client
      // appended (the reveal map's entry keyed by the wire's own id).
      const addressed = rows[0]!.querySelector<HTMLButtonElement>('[data-verb-id="run-pane.ledger-reveal"]');
      expect(addressed, "a live finding carrying its ledger address reveals immediately").not.toBeNull();
      addressed!.click();
      await tick();
      const ask = consumeBeatRequest();
      expect(ask).toEqual({ id: liveId, want: "reveal" });
      const second = rows[1]!.querySelector<HTMLButtonElement>('[data-verb-id="run-pane.ledger-reveal"]');
      expect(second, "the distinct same-word incident has its own reveal").not.toBeNull();
      second!.click();
      await tick();
      expect(consumeBeatRequest()).toEqual({ id: secondLiveId, want: "reveal" });
      expect(secondLiveId).not.toBe(liveId);
      // The ANONYMOUS finding's row: no reveal affordance pretending a beat
      // exists — the honest plain fact, exactly as before the wiring.
      expect(
        rows[2]!.querySelector('[data-verb-id="run-pane.ledger-reveal"]'),
        "a finding the wire could not address renders no reveal affordance",
      ).toBeNull();
    } finally {
      restore();
    }
  });

  test("THE PAST-VIEW FACE: opening the section under a planted head bounds the wire read and says so on the surface", async () => {
    const head = T0 + 123;
    plantHead(head);
    const { bodies, restore } = plantReader(() => page([row("e1", { description: "a bounded row" })], 1));
    try {
      const { container } = render(RunPane, {});
      const section = await sectionBody(container, "ledger");
      await waitFor(async () => {
        await tick();
        expect(section.textContent).toContain("a bounded row");
      });
      expect(bodies[0]!["toWallTime"]).toBe(new Date(head).toISOString());
      expect(section.querySelector('[data-field="ledger-bounded"]')!.textContent).toContain("viewing up to");
    } finally {
      restore();
      returnToLive();
    }
  });
});

describe("the acts section — the operator intervention trail", () => {
  beforeEach(() => {
    clearProvenance();
    performedActions.set([]);
    uiSchema.set(null);
  });

  test("no interventions state the honest nothing, naming the log's own scope", async () => {
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "acts");
    expect(section.textContent).toContain("no interventions recorded this session");
  });

  test("a planted act renders its declared words, its typed state and the input it was issued with", async () => {
    uiSchema.set({
      blockActions: {
        "tools.breaker": [{ name: "trip", title: "Switch a tool off", consequence: "the tool refuses every call until switched back on", invalidates: [] }],
      },
    } as unknown as UiSchema);
    recordAction({
      block: "tools.breaker",
      origin: "operator",
      action: "trip",
      state: "done",
      requestedAt: 1,
      settledAt: 90,
      input: { tool: "execute_command" },
    });
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "acts");
    expect(section.querySelector('[data-field="act-title"]')?.textContent).toContain("Switch a tool off");
    expect(section.textContent).toContain("the tool refuses every call until switched back on");
    expect(section.textContent).toContain("execute_command");
    expect(section.textContent).toContain("done");
    // The caption names the STEER exclusion: a steered run shows no steer
    // row — steers ride the transcript, not the broker's write-door log —
    // so the absence a reader might expect is stated at the section's own
    // foot, never left to be read as a missing row.
    expect(section.textContent).toContain(
      "a steered run shows no steer row: steers ride the transcript, not the broker's write-door log",
    );
  });

  test("a failed act states that nothing changed, naming the recorded code", async () => {
    recordAction({
      block: "arm.flags",
      origin: "operator",
      action: "arm",
      state: "failed",
      requestedAt: 1,
      settledAt: 2,
      errorCode: "invalid_arm_predicate",
    });
    const { container } = render(RunPane, {});
    const section = await sectionBody(container, "acts");
    expect(section.querySelector('[data-field="act-outcome"]')?.textContent).toContain("invalid_arm_predicate");
    expect(section.textContent).toContain("so nothing about the run changed");
  });
});

// THE PANE FRAME'S TWO OLD ARMS — the close control and the complementary
// landmark — moved to the shell suite with the single menu: the
// column chrome (the one landmark, the cap, the close verb) is the HOST's
// now (shell/RightMenuHost.svelte), so its contracts are proven where the
// host is mounted for real (tests/cockpit/run-pane-shell.test.ts, against
// the whole Cockpit rather than around it).
