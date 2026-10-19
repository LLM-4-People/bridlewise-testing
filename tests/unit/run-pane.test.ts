// @vitest-environment node
/**
 * The run-pane data owner (state/run-pane.ts) — the pure projections.
 *
 *   - runProgress: joins the run store to the transcript aggregates;
 *     tokens are null until a usage frame actually landed (the honest
 *     "not measured" — a zero would be a fabricated figure);
 *   - runIdentity: the run view's own id beside the project it is BOUND
 *     to (joined by the run's projectId, never by what is open);
 *   - runTurns: the per-turn drilldown — persisted facts from the
 *     transcript row, live-session facts through the flow's timing
 *     owner, the rate through the latency owner (`turnLatency`), the
 *     steered mark joined from the user message the turn answered;
 *   - runCalls: every call's raw duration terms + attempt count +
 *     refusal mark + stranded incompleteness, oldest first;
 *   - inputPreparation: the dedup/redaction rollups summed across the
 *     conversation's turns from the same per-turn records the flow's
 *     footers read;
 *   - runAgents: the SSE-fed registry, ordered newest-updated first;
 *   - runEdits: the transcript's file-effect calls through the flow's own
 *     vocabulary — a tool added to FILE_EFFECT_TOOLS lands here with no
 *     edit to this module, and a tool outside it never lands a row;
 *   - decodeCodebaseMap: the block payload narrowed defensively — a
 *     malformed payload is absent, never a partial zero;
 *   - codebaseView: a load measured for a different path reads as pending
 *     (staleness by data), and the git projection follows the shared
 *     store's own path keying;
 *   - runRecordRuns: the causal-band map over the streamed window — the
 *     same banding owner the a11y outline reads, so the outline and the
 *     menu can never disagree about what runs exist;
 *   - the ledger: the run-scoped query — the chat scope honored on the
 *     wire, the planted head as the query's own inclusive toWallTime
 *     bound (the past-view resolution for a ROUTE read), the honest
 *     truncation (rows shown beside the server's total), the cursor
 *     load-more, and the filters that narrow rows without touching the
 *     total;
 *   - runActs: the operator intervention trail from the Broker's own
 *     write-door log, joined with the DECLARED words from the served
 *     manifest (the same join the flow's act beats use).
 */
import { beforeEach, describe, expect, test } from "vitest";

import {
  codebaseMapLoad,
  codebaseView,
  decodeCodebaseMap,
  inputPreparation,
  requestCodebaseMap,
  resetCodebaseMapLoad,
  runAgents,
  runCalls,
  runEdits,
  runIdentity,
  runProgress,
  runTurns,
  setCodebaseMapReader,
  runRecordRuns,
  runRecordContents,
  runRecordErrorCodes,
  runLedgerRows,
  runLedgerBeatIds,
  runActs,
  requestRunLedger,
  loadMoreRunLedger,
  resetRunLedgerLoad,
  resetRunLedgerFilters,
  runLedgerCategoryFilter,
  runLedgerOutcomeFilter,
  setRunLedgerReader,
} from "../../src/state/run-pane.ts";
import { resetRunState, setRun, upsertAgent } from "../../src/state/run-state.ts";
import {
  appendAssistantMessage,
  appendToolCall,
  appendUserMessage,
  appendEventMessage,
  clearMessages,
  updateLastAssistantMessage,
} from "../../src/state/chat-messages.ts";
import {
  noteOutputDelta,
  noteTurnEnd,
  noteTurnStart,
  resetTurnTimings,
} from "../../src/cockpit/flow/turn-timing.ts";
import { projects, currentProjectId } from "../../src/state/projects.ts";
import { setGitStatus } from "../../src/state/git.ts";
import { fileEffectToolNames, setTools, resetTools } from "../../src/state/tools.ts";
import { currentChatId } from "../../src/state/chats.ts";
import { plantHead, returnToLive } from "../../src/data/asof.ts";
import { resetLiveSweepBuffer, ingestLiveSweepEvent } from "../../src/cockpit/sweep/sweep-data.ts";
import { TIMELINE_QUERY_LIMIT } from "../../shared/constants.ts";
import { recordAction, clearProvenance } from "../../src/data/ledger.ts";
import { performedActions } from "../../src/state/lens.ts";
import { uiSchema } from "../../src/state/schema-store.ts";
import type { UiSchema } from "../../shared/ui-schema.ts";
import type { ActionOrigin } from "../../shared/provenance.ts";
import type { WebToolEntry } from "../../shared/types";

/** A manifest entry carrying exactly the capabilities the test asks for. */
function toolEntry(name: string, capabilities: readonly ("read" | "write")[]): WebToolEntry {
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
  };
}
import type { AgentState } from "../../shared/types.ts";

function makeAgent(agentId: string, updatedAt: string): AgentState {
  return {
    agentId,
    agentName: agentId,
    runId: "run-1",
    taskId: "task-1",
    attemptId: "att-1",
    lifecycleState: "running",
    turnCount: 1,
    totalPromptTokens: 10,
    totalCompletionTokens: 5,
    totalTokens: 15,
    turns: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt,
    lastError: null,
    compactionSummary: null,
    suspensionReason: null,
  };
}

beforeEach(() => {
  resetRunState();
  clearMessages();
  resetCodebaseMapLoad();
  resetTurnTimings();
  projects.set([]);
  currentProjectId.set(null);
  setGitStatus(null);
});

describe("runProgress", () => {
  test("idle: no run, empty transcript — every figure absent or zeroed-honestly", () => {
    const p = runProgress.get();
    expect(p.status).toBeNull();
    expect(p.startedAt).toBeNull();
    expect(p.turns).toBe(0);
    expect(p.toolCalls).toBe(0);
    expect(p.toolCallsRunning).toBe(0);
    expect(p.totalTokens).toBeNull();
  });

  test("tokens are null until a usage frame lands — never a fabricated zero", () => {
    setRun({ runId: "r1", projectId: "p1", status: "running", startedAt: 1000, modelLabel: null });
    appendAssistantMessage("words, no usage frame");
    expect(runProgress.get().totalTokens).toBeNull();
    updateLastAssistantMessage((m) => ({
      ...m,
      tokenMetrics: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    }));
    expect(runProgress.get().totalTokens).toBe(10);
    expect(runProgress.get().inputTokens).toBe(7);
  });

  test("toolCallsRunning counts only the in-flight calls", () => {
    appendToolCall({ id: "c1", name: "read_file", input: {}, output: null, status: "done", startedAt: 1 });
    appendToolCall({ id: "c2", name: "search_code", input: {}, output: null, status: "running", startedAt: 2 });
    appendToolCall({ id: "c3", name: "search_code", input: {}, output: null, status: "error", startedAt: 3 });
    const p = runProgress.get();
    expect(p.toolCalls).toBe(3);
    expect(p.toolCallsRunning).toBe(1);
  });
});

describe("runIdentity", () => {
  test("no run view → both facts absent", () => {
    expect(runIdentity.get()).toEqual({ runId: null, projectLabel: null });
  });

  test("a live run names its own id and the project it is BOUND to — never the open one", () => {
    projects.set([
      { id: "p1", name: "the open project", path: "/a", createdAt: "t", updatedAt: "t" },
      { id: "p2", name: "the bound project", path: "/b", createdAt: "t", updatedAt: "t" },
    ]);
    currentProjectId.set("p1");
    setRun({ runId: "run-77", projectId: "p2", status: "running", startedAt: 1000, modelLabel: null });
    const identity = runIdentity.get();
    expect(identity.runId).toBe("run-77");
    expect(identity.projectLabel).toBe("the bound project");
  });

  test("a run whose project is not in the list keeps its id and states the binding's absence", () => {
    setRun({ runId: "run-x", projectId: "gone", status: "running", startedAt: 1000, modelLabel: null });
    expect(runIdentity.get()).toEqual({ runId: "run-x", projectLabel: null });
  });
});

describe("runTurns", () => {
  test("empty transcript → no turns", () => {
    expect(runTurns.get()).toEqual([]);
  });

  test("a planted transcript with known timings renders the exact values", () => {
    appendUserMessage("read the file and merge the edit");
    const first = appendAssistantMessage("the answer");
    updateLastAssistantMessage((m) => ({
      ...m,
      tokenMetrics: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
      timingMetrics: { startedAt: 1000, ttftMs: 1200, tps: 7.5 },
      finishReason: "stop",
      responseModel: "google/gemma-4-31b-it",
    }));
    appendUserMessage("and now more", true); // steered into the live run
    appendAssistantMessage("the second answer");
    updateLastAssistantMessage((m) => ({
      ...m,
      incompleteReason: "the run ended before this turn kept a word",
    }));

    const turns = runTurns.get();
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      id: first,
      index: 1,
      live: false,
      steered: false,
      firstWordMs: 1200,
      tokPerSec: 7.5,
      inputTokens: 100,
      outputTokens: 40,
      finishReason: "stop",
      responseModel: "google/gemma-4-31b-it",
    });
    // The live-session measurements are absent for a turn this session
    // did not watch — absence, never a zero.
    expect(turns[0]!.firstOutputMs).toBeUndefined();
    expect(turns[0]!.generationMs).toBeUndefined();
    // The steered mark lands on the turn the queued instruction answered,
    // and the interrupted vocabulary is the turn's own record.
    expect(turns[1]!.steered).toBe(true);
    expect(turns[1]!.incompleteReason).toBe("the run ended before this turn kept a word");
  });

  test("live-session facts join through the flow's timing owner, and the rate follows the owner's arithmetic", () => {
    const id = appendAssistantMessage("streaming turn");
    noteTurnStart(id, 1_000);
    noteOutputDelta(id, "answer", 1_300, 10);
    noteTurnEnd(id, 5_300);
    updateLastAssistantMessage((m) => ({
      ...m,
      tokenMetrics: { inputTokens: 90, outputTokens: 40, totalTokens: 130 },
    }));

    const turns = runTurns.get();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.firstOutputMs).toBe(300);
    expect(turns[0]!.generationMs).toBe(4_000);
    // 40 tokens over the 4s producing window, one decimal — the same
    // number the flow's footer derives from the same owner.
    expect(turns[0]!.tokPerSec).toBe(10);
  });

  test("a recorded rate keeps the row when the live window is gone", () => {
    appendAssistantMessage("a settled turn");
    updateLastAssistantMessage((m) => ({
      ...m,
      timingMetrics: { startedAt: 1000, ttftMs: 500, tps: 12.3 },
    }));
    expect(runTurns.get()[0]!.tokPerSec).toBe(12.3);
  });

  test("the streaming turn is the live one — earlier turns are not", async () => {
    const { isStreaming } = await import("../../src/state/chat-messages.ts");
    appendAssistantMessage("older turn");
    appendAssistantMessage("the turn now streaming");
    isStreaming.set(true);
    try {
      const turns = runTurns.get();
      expect(turns[0]!.live).toBe(false);
      expect(turns[1]!.live).toBe(true);
    } finally {
      isStreaming.set(false);
    }
  });
});

describe("runCalls", () => {
  test("no calls → the empty ledger", () => {
    expect(runCalls.get()).toEqual([]);
  });

  test("every call's facts, oldest first — duration terms raw, refusal typed, stranding observed", () => {
    const m1 = appendToolCall({
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
    const m2 = appendToolCall({
      id: "c2",
      name: "read_file",
      input: { path: "/b.ts" },
      output: null,
      status: "running",
      startedAt: 2_000,
    });
    const m3 = appendToolCall({
      id: "c3",
      name: "edit",
      input: { path: "/c.ts" },
      output: "the gate declined",
      status: "error",
      startedAt: 3_000,
      refused: true,
    });
    const m4 = appendToolCall({
      id: "c4",
      name: "search_code",
      input: {},
      output: null,
      status: "running",
      startedAt: 4_000,
      incompleteReason: "the run ended before this call reported a result",
    });

    const calls = runCalls.get();
    // Keyed by the transcript row id (the row IS the ledger entry here);
    // order is the order the run made them.
    expect(calls.map((c) => c.id)).toEqual([m1, m2, m3, m4]);
    expect(calls[0]).toMatchObject({
      toolName: "edit",
      status: "done",
      startedAt: 100,
      endedAt: 1_600,
      durationMs: 1_500,
      attemptCount: 2,
    });
    expect(calls[1]).toMatchObject({ toolName: "read_file", status: "running", startedAt: 2_000 });
    expect(calls[0]!.refused).toBeUndefined();
    expect(calls[2]!.refused).toBe(true);
    expect(calls[2]!.incompleteReason).toBeUndefined();
    expect(calls[3]!.refused).toBeUndefined();
    expect(calls[3]!.incompleteReason).toBe("the run ended before this call reported a result");
  });
});

describe("inputPreparation", () => {
  test("a transcript with no summaries is the honest nothing — both rollups null", () => {
    appendAssistantMessage("a plain turn with nothing folded or masked");
    expect(inputPreparation.get()).toEqual({ dedup: null, redaction: null });
  });

  test("two turns' dedup frames roll up to the SUM — the arithmetic is the rollup's own", () => {
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

    const dedup = inputPreparation.get().dedup!;
    expect(dedup.framesApplied).toBe(2);
    expect(dedup.charsBefore).toBe(5_000);
    expect(dedup.charsAfter).toBe(2_500);
    expect(dedup.charsSaved).toBe(2_500);
    // The rollup's percentage derives from the sums, never by summing the
    // per-turn percentages.
    expect(dedup.savedPct).toBe(0.5);
    expect(dedup.blocksRemoved).toBe(4);
  });

  test("an unapplied summary folds nothing — the frame is not counted", () => {
    appendAssistantMessage("a call that removed nothing");
    updateLastAssistantMessage((m) => ({
      ...m,
      dedupSummary: {
        applied: false,
        originalChars: 10,
        dedupedChars: 10,
        charReductionPct: 0,
        removedBlocks: 0,
        removedLines: 0,
        messageCount: 1,
      },
    }));
    expect(inputPreparation.get().dedup).toBeNull();
  });

  test("redaction masks sum by kind, and upstream values stay OUTSIDE the count", () => {
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
        proven: 0,
        format: 1,
        inferred: 0,
        maskedUpstream: 0,
        byTier: { api_key: 1, password: 1 },
        reasons: [],
      },
    }));

    const redaction = inputPreparation.get().redaction!;
    expect(redaction.maskedCount).toBe(3);
    expect(redaction.proven).toBe(1);
    expect(redaction.format).toBe(2);
    expect(redaction.maskedUpstream).toBe(1);
    expect(redaction.byTier).toEqual({ api_key: 3, password: 1 });
  });
});

describe("runAgents", () => {
  test("orders newest-updated first", () => {
    upsertAgent(makeAgent("old", "2026-01-01T00:00:01Z"));
    upsertAgent(makeAgent("new", "2026-01-01T00:00:09Z"));
    expect(runAgents.get().map((a) => a.agentId)).toEqual(["new", "old"]);
  });
});

describe("runEdits", () => {
  beforeEach(() => resetTools());

  test("only file-effect tools land rows, oldest first, paths extracted by the flow owner", () => {
    // The effect vocabulary is DERIVED from the served manifest's declared
    // capabilities (write = changes a file), never a hand list. Seed a
    // manifest with one writer and one reader; only the writer lands a row.
    setTools([toolEntry("edit", ["write"]), toolEntry("read_file", ["read"])]);
    appendToolCall({ id: "c1", name: "read_file", input: { path: "/no.ts" }, output: null, status: "done", startedAt: 1 });
    appendToolCall({ id: "c2", name: "edit", input: { path: "/yes.ts" }, output: null, status: "done", startedAt: 2 });
    const edits = runEdits.get();
    expect(edits).toHaveLength(1);
    expect(edits[0]!.path).toBe("/yes.ts");
    expect(edits[0]!.toolName).toBe("edit");
  });

  test("every tool the manifest declares as a writer is covered (dynamic, not a list)", () => {
    // One call per manifest-declared writer: the section must land a row for
    // EVERY one — a tool registered tomorrow carrying `write` is covered by
    // the derivation, not by an edit here.
    setTools([
      toolEntry("edit", ["write"]),
      toolEntry("create_artifact", ["write"]),
      toolEntry("read_file", ["read"]),
    ]);
    const effectTools = fileEffectToolNames();
    expect(effectTools).toEqual(new Set(["edit", "create_artifact"]));
    let at = 1000;
    for (const name of effectTools) {
      appendToolCall({ id: `c-${name}`, name, input: { path: `/f/${name}` }, output: null, status: "done", startedAt: at++ });
    }
    const edits = runEdits.get();
    expect(edits).toHaveLength(effectTools.size);
    expect(new Set(edits.map((e) => e.toolName))).toEqual(effectTools);
  });
});

describe("decodeCodebaseMap", () => {
  test("accepts the block's real shape", () => {
    const decoded = decodeCodebaseMap({
      summary: { fileCount: 3, moduleCount: 1, symbolCount: 9, totalLines: 100, languages: [{ extension: ".ts", fileCount: 3 }] },
      moduleCount: 1,
      fileCount: 3,
    });
    expect(decoded?.fileCount).toBe(3);
    expect(decoded?.languages[0]?.extension).toBe(".ts");
  });

  test("malformed payloads are absent, never partial zeros", () => {
    expect(decodeCodebaseMap(null)).toBeNull();
    expect(decodeCodebaseMap({})).toBeNull();
    expect(decodeCodebaseMap({ summary: { fileCount: 3 } })).toBeNull();
    expect(
      decodeCodebaseMap({
        summary: { fileCount: 3, moduleCount: 1, symbolCount: 1, totalLines: 1, languages: [{ extension: 5 }] },
      }),
    ).toBeNull();
  });
});

describe("codebaseView", () => {
  test("no project → the honest absence", () => {
    const v = codebaseView.get();
    expect(v.map.kind).toBe("absent");
    expect(v.git).toBeNull();
  });

  test("a load measured for a different path reads as pending for the current project", async () => {
    projects.set([{ id: "p1", name: "app", path: "/a", createdAt: "t", updatedAt: "t" }]);
    currentProjectId.set("p1");
    codebaseMapLoad.set({
      path: "/b",
      load: { kind: "measured", map: { fileCount: 9, moduleCount: 9, symbolCount: 9, totalLines: 9, languages: [] } },
    });
    expect(codebaseView.get().map.kind).toBe("pending");
    expect(codebaseView.get().map.kind === "measured").toBe(false);
  });

  test("requestCodebaseMap is idempotent for a measured path and retries a failed one", async () => {
    projects.set([{ id: "p1", name: "app", path: "/a", createdAt: "t", updatedAt: "t" }]);
    currentProjectId.set("p1");
    let calls = 0;
    const restore = setCodebaseMapReader(async () => {
      calls += 1;
      return { summary: { fileCount: 1, moduleCount: 1, symbolCount: 1, totalLines: 1, languages: [] } };
    });
    try {
      await requestCodebaseMap("/a");
      await requestCodebaseMap("/a"); // measured: no second read
      expect(calls).toBe(1);
      expect(codebaseView.get().map.kind).toBe("measured");
    } finally {
      setCodebaseMapReader(restore);
    }
  });

  test("the router's 202 indexing contract reads as the indexing state, with the server's sentence", async () => {
    projects.set([{ id: "p1", name: "app", path: "/a", createdAt: "t", updatedAt: "t" }]);
    currentProjectId.set("p1");
    const restore = setCodebaseMapReader(async () => ({
      status: "indexing",
      code: "map_not_ready",
      message: "Repository map is still indexing in the background. Retry shortly.",
    }));
    try {
      await requestCodebaseMap("/a");
      const v = codebaseView.get();
      expect(v.map.kind).toBe("indexing");
      expect(v.map.kind === "indexing" ? v.map.reason : "").toContain("still indexing");
    } finally {
      setCodebaseMapReader(restore);
    }
  });

  test("an indexing load does NOT suppress the re-ask (the pane polls until the server is done)", async () => {
    projects.set([{ id: "p1", name: "app", path: "/a", createdAt: "t", updatedAt: "t" }]);
    currentProjectId.set("p1");
    let calls = 0;
    const restore = setCodebaseMapReader(async () => {
      calls += 1;
      if (calls === 1) return { status: "indexing", code: "map_not_ready", message: "still reading" };
      return { summary: { fileCount: 5, moduleCount: 1, symbolCount: 9, totalLines: 50, languages: [] } };
    });
    try {
      await requestCodebaseMap("/a");
      expect(codebaseView.get().map.kind).toBe("indexing");
      // The poll's forced re-ask lands the measured answer.
      await requestCodebaseMap("/a", true);
      expect(calls).toBe(2);
      expect(codebaseView.get().map.kind).toBe("measured");
    } finally {
      setCodebaseMapReader(restore);
    }
  });

  test("the git projection follows the shared store's path keying", () => {
    projects.set([{ id: "p1", name: "app", path: "/a", createdAt: "t", updatedAt: "t" }]);
    currentProjectId.set("p1");
    setGitStatus({ path: "/b", repository: true, branch: "main", dirtyFiles: 1, stagedFiles: 0, untrackedFiles: 0, entries: [] });
    expect(codebaseView.get().git, "a snapshot for another path is not this project's tree").toBeNull();
    setGitStatus({ path: "/a", repository: true, branch: "main", dirtyFiles: 1, stagedFiles: 0, untrackedFiles: 0, entries: [] });
    expect(codebaseView.get().git?.branch).toBe("main");
  });
});

// ── The record's map: the run list ───────────────────────────────────────────

describe("runRecordRuns — the causal-band map over the streamed window", () => {
  const T0 = 1_787_000_000_000;

  /** A wire-shaped record, as the run stream forwards them. */
  function ev(
    eventId: string,
    atMs: number,
    over: Readonly<{ eventType?: string; outcome?: string | null; errorCode?: string; runId?: string | null; turnId?: string | null; description?: string }> = {},
  ): Parameters<typeof ingestLiveSweepEvent>[0] {
    return {
      eventId,
      wallTime: new Date(atMs).toISOString(),
      eventType: over.eventType ?? "run",
      outcome: over.outcome ?? null,
      ...(over.errorCode !== undefined ? { errorCode: over.errorCode } : {}),
      runId: over.runId ?? null,
      turnId: over.turnId ?? null,
      description: over.description ?? "",
    };
  }

  beforeEach(() => {
    resetLiveSweepBuffer();
    returnToLive();
    resetRunState();
  });

  test("a planted window with two runs renders the rows exact — spans, counts, error counts, live marking", () => {
    ingestLiveSweepEvent(ev("e1", T0, { runId: "run-a", eventType: "run" }));
    ingestLiveSweepEvent(ev("e2", T0 + 100, { runId: "run-a", eventType: "tool", turnId: "turn-1" }));
    ingestLiveSweepEvent(ev("e3", T0 + 200, { runId: "run-a", eventType: "tool", outcome: "failed", errorCode: "tool_refused", turnId: "turn-1" }));
    ingestLiveSweepEvent(ev("e4", T0 + 300, { runId: "run-a", eventType: "token", turnId: "turn-1" }));
    ingestLiveSweepEvent(ev("e5", T0 + 10_000, { runId: "run-b", eventType: "run" }));
    ingestLiveSweepEvent(ev("e6", T0 + 10_500, { runId: "run-b", eventType: "message" }));
    ingestLiveSweepEvent(ev("e7", T0 + 10_600, { runId: null, eventType: "engine" }));

    const rows = runRecordRuns.get();
    expect(rows).toHaveLength(3);
    // Oldest first: run-a, then run-b, then the unattributed band.
    expect(rows[0]).toEqual({
      runId: "run-a",
      t0: T0,
      t1: T0 + 300,
      eventCount: 4,
      errorCount: 1,
      live: false,
      partial: false,
    });
    expect(rows[1]).toEqual({
      runId: "run-b",
      t0: T0 + 10_000,
      t1: T0 + 10_500,
      eventCount: 2,
      errorCount: 0,
      live: false,
      partial: false,
    });
    // The unattributed events are their own honest row, never hidden.
    expect(rows[2]!.runId).toBeNull();
    expect(rows[2]!.eventCount).toBe(1);
  });

  test("a run whose opening event is outside the window is marked partial — the tail slice is never presented as the run's record", () => {
    // The window holds only run-a's TAIL: its `run` opening event (and the
    // run's first seconds) fell out of the page — the exact shape a later
    // run's stream or a newest-page refresh leaves behind on a long chat.
    ingestLiveSweepEvent(ev("e1", T0 + 5_000, { runId: "run-a", eventType: "tool", turnId: "turn-2" }));
    ingestLiveSweepEvent(ev("e2", T0 + 5_100, { runId: "run-a", eventType: "token", turnId: "turn-2" }));
    const rows = runRecordRuns.get();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.partial).toBe(true);
    // A complete band over the same run — the opening `run` event present —
    // is never partial.
    ingestLiveSweepEvent(ev("e0", T0, { runId: "run-a", eventType: "run" }));
    const complete = runRecordRuns.get();
    expect(complete).toHaveLength(1);
    expect(complete[0]!.partial).toBe(false);
  });

  test("the unattributed band is never partial — it is not a run and has no opening event to miss", () => {
    ingestLiveSweepEvent(ev("u1", T0, { runId: null, eventType: "engine" }));
    ingestLiveSweepEvent(ev("u2", T0 + 1, { runId: null, eventType: "engine" }));
    const rows = runRecordRuns.get();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runId).toBeNull();
    expect(rows[0]!.partial).toBe(false);
  });

  test("the LIVE run is marked while the run view holds it and is active", () => {
    setRun({
      runId: "run-a",
      status: "running",
      modelLabel: "gemma",
      startedAt: T0,
      projectId: "p1",
    });
    ingestLiveSweepEvent(ev("e1", T0, { runId: "run-a" }));
    const rows = runRecordRuns.get();
    expect(rows[0]!.live).toBe(true);
    // A different run's row is never marked live.
    ingestLiveSweepEvent(ev("e2", T0 + 5, { runId: "run-b" }));
    expect(runRecordRuns.get().find((r) => r.runId === "run-b")!.live).toBe(false);
  });

  test("the error count reads the counting-policy owner's own projection — a denied gate block is not an error", () => {
    ingestLiveSweepEvent(ev("d1", T0, { runId: "run-x", eventType: "error", outcome: "denied" }));
    ingestLiveSweepEvent(ev("d2", T0 + 1, { runId: "run-x", eventType: "error", outcome: "failed" }));
    const rows = runRecordRuns.get();
    expect(rows[0]!.eventCount).toBe(2);
    expect(rows[0]!.errorCount).toBe(1);
  });

  test("the contents roll-up counts the window with the same predicate — events beside errors", () => {
    resetLiveSweepBuffer();
    ingestLiveSweepEvent(ev("c1", T0, { runId: "run-a", eventType: "token" }));
    ingestLiveSweepEvent(ev("c2", T0 + 1, { runId: "run-a", eventType: "tool", outcome: "failed" }));
    ingestLiveSweepEvent(ev("c3", T0 + 2, { runId: "run-a", eventType: "tool", errorCode: "boom" }));
    expect(runRecordContents.get()).toEqual({ events: 3, errors: 2 });
  });

  test("the error-code roll-up groups the failures by their recorded codes, failures without a code named by their outcome", () => {
    resetLiveSweepBuffer();
    ingestLiveSweepEvent(ev("x1", T0, { runId: "r", eventType: "tool", outcome: "failed", errorCode: "tool_refused" }));
    ingestLiveSweepEvent(ev("x2", T0 + 1, { runId: "r", eventType: "tool", outcome: "failed", errorCode: "tool_refused" }));
    ingestLiveSweepEvent(ev("x3", T0 + 2, { runId: "r", eventType: "tool", outcome: "failed" }));
    const codes = runRecordErrorCodes.get();
    expect(codes).toEqual([
      { code: "tool_refused", count: 2 },
      { code: "failed", count: 1 },
    ]);
  });
});

// ── The run-scoped event ledger ──────────────────────────────────────────────

describe("the ledger — the run-scoped query, its past-view bound and its honest truncation", () => {
  /** A wire-shaped summary row. */
  function row(
    eventId: string,
    over: Readonly<{ eventType?: string; outcome?: string | null; errorCode?: string | null; runId?: string | null; turnId?: string | null; description?: string; wallTime?: string }> = {},
  ): Record<string, unknown> {
    return {
      eventId,
      eventType: over.eventType ?? "run",
      wallTime: over.wallTime ?? "2026-09-04T12:00:00.000Z",
      outcome: over.outcome ?? null,
      errorCode: over.errorCode ?? null,
      runId: over.runId ?? null,
      turnId: over.turnId ?? null,
      description: over.description ?? "",
      ledgerId: "l",
      sequence: "1",
      recordKind: "event",
      traceId: null,
      parentEventId: null,
    };
  }

  function page(
    events: Record<string, unknown>[],
    total: number,
    hasMore = false,
    nextCursor: string | null = null,
  ): Record<string, unknown> {
    return { events, total, hasMore, nextCursor };
  }

  beforeEach(() => {
    resetRunLedgerLoad();
    resetRunLedgerFilters();
    currentChatId.set("chat-1");
    returnToLive();
  });

  test("the wire body carries the chat scope, the shared page size and the newest-first walk — the scope honored on the wire", async () => {
    const bodies: Record<string, unknown>[] = [];
    const restore = setRunLedgerReader(async (body) => {
      bodies.push(body);
      return page([row("e1")], 1);
    });
    try {
      await requestRunLedger();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!["chatId"], "the chat scope must reach the server").toBe("chat-1");
      expect(bodies[0]!["limit"]).toBe(TIMELINE_QUERY_LIMIT);
      expect(bodies[0]!["ascending"]).toBe(false);
      expect("toWallTime" in bodies[0]!).toBe(false);
    } finally {
      setRunLedgerReader(restore);
    }
  });

  test("THE PAST-VIEW RESOLUTION: a planted head bounds the query by toWallTime — the head's own instant, as an ISO bound", async () => {
    const head = 1_787_123_456_789;
    plantHead(head);
    const bodies: Record<string, unknown>[] = [];
    const restore = setRunLedgerReader(async (body) => {
      bodies.push(body);
      return page([row("e1")], 1);
    });
    try {
      await requestRunLedger();
      expect(bodies[0]!["toWallTime"]).toBe(new Date(head).toISOString());
    } finally {
      setRunLedgerReader(restore);
      returnToLive();
    }
  });

  test("a head change is a different question: the standing load does not serve another head's answer", async () => {
    let calls = 0;
    const restore = setRunLedgerReader(async () => {
      calls += 1;
      return page([row("e1")], 1);
    });
    try {
      await requestRunLedger();
      expect(calls).toBe(1);
      await requestRunLedger(); // same question: idempotent
      expect(calls).toBe(1);
      plantHead(1_787_000_000_000);
      await requestRunLedger(); // a new question: re-asked
      expect(calls).toBe(2);
    } finally {
      setRunLedgerReader(restore);
      returnToLive();
    }
  });

  test("the honest truncation: rows shown beside the server's total, and the load-more appends by cursor without duplicating", async () => {
    const restore = setRunLedgerReader(async (body) => {
      if ((body as Record<string, unknown>)["cursor"] === undefined) {
        return page([row("e1"), row("e2")], 5, true, "2");
      }
      return page([row("e2"), row("e3")], 5, false, null);
    });
    try {
      await requestRunLedger();
      let standing = runLedgerRows.get();
      expect(standing.load.kind).toBe("measured");
      if (standing.load.kind !== "measured") return;
      expect(standing.rows.map((r) => r.eventId)).toEqual(["e1", "e2"]);
      expect(standing.load.total).toBe(5);
      expect(standing.load.hasMore).toBe(true);
      await loadMoreRunLedger();
      standing = runLedgerRows.get();
      if (standing.load.kind !== "measured") return;
      // The duplicated e2 from the next page is deduplicated by eventId.
      expect(standing.rows.map((r) => r.eventId)).toEqual(["e1", "e2", "e3"]);
      expect(standing.load.hasMore).toBe(false);
    } finally {
      setRunLedgerReader(restore);
    }
  });

  test("an unreadable payload is an absence, never a partial page", async () => {
    const restore = setRunLedgerReader(async () => ({ events: "no" }));
    try {
      await requestRunLedger();
      const standing = runLedgerRows.get();
      expect(standing.load.kind).toBe("absent");
    } finally {
      setRunLedgerReader(restore);
    }
  });

  test("a load answering a different chat never paints — staleness by data, the map load's rule", async () => {
    const restore = setRunLedgerReader(async () => {
      currentChatId.set("chat-2"); // the reader left mid-flight
      return page([row("e1")], 1);
    });
    try {
      await requestRunLedger();
      // The view reads a chat-mismatched standing load as pending.
      expect(runLedgerRows.get().load.kind).toBe("pending");
    } finally {
      setRunLedgerReader(restore);
      currentChatId.set("chat-1");
    }
  });

  test("the filters narrow the rows shown, never the recorded total — and the failure word is the counting owner's own predicate", async () => {
    const restore = setRunLedgerReader(async () =>
      page(
        [
          row("ok1", { eventType: "token", outcome: "succeeded" }),
          row("fail1", { eventType: "tool", outcome: "failed", errorCode: "tool_refused" }),
          row("denied1", { eventType: "error", outcome: "denied" }),
          row("coded", { eventType: "tool", outcome: "succeeded", errorCode: "boom" }),
        ],
        4,
      ));
    try {
      await requestRunLedger();
      const all = runLedgerRows.get();
      expect(all.rows).toHaveLength(4);
      expect(all.load.kind === "measured" ? all.load.total : 0).toBe(4);

      runLedgerOutcomeFilter.set("failed");
      const failed = runLedgerRows.get();
      // failed OR error-coded — the counting-policy owner's predicate.
      expect(failed.rows.map((r) => r.eventId)).toEqual(["fail1", "coded"]);

      runLedgerOutcomeFilter.set("denied");
      expect(runLedgerRows.get().rows.map((r) => r.eventId)).toEqual(["denied1"]);

      runLedgerOutcomeFilter.set("ok");
      expect(runLedgerRows.get().rows.map((r) => r.eventId)).toEqual(["ok1"]);

      runLedgerOutcomeFilter.set("all");
      runLedgerCategoryFilter.set("tool");
      const tools = runLedgerRows.get();
      expect(tools.rows.map((r) => r.eventId)).toEqual(["fail1", "coded"]);
      // The total never moved with the chips.
      expect(tools.load.kind === "measured" ? tools.load.total : 0).toBe(4);
    } finally {
      setRunLedgerReader(restore);
      resetRunLedgerFilters();
    }
  });

  test("the row→beat mapping: a message that IS a recorded event carries the reveal address", () => {
    clearMessages();
    const id = appendEventMessage("self-healing", "a recorded inline event", "evt-9");
    const map = runLedgerBeatIds.get();
    expect(map.get("evt-9")).toBe(id);
    expect(runLedgerBeatIds.get().get("evt-nope")).toBeUndefined();
  });
});

// ── The act trail ────────────────────────────────────────────────────────────

describe("runActs — the operator intervention trail, joined with its declared words", () => {
  beforeEach(() => {
    clearProvenance();
    performedActions.set([]);
    uiSchema.set(null);
  });

  function record(
    over: Readonly<{ origin?: ActionOrigin; block?: string; action?: string; state?: "done" | "failed"; errorCode?: string; input?: unknown; settledAt?: number; requestedAt?: number }>,
  ): void {
    recordAction({
      origin: over.origin ?? "operator",
      block: over.block ?? "tools.breaker",
      action: over.action ?? "trip",
      state: over.state ?? "done",
      requestedAt: over.requestedAt ?? 1,
      settledAt: over.settledAt ?? 5,
      ...(over.errorCode !== undefined ? { errorCode: over.errorCode } : {}),
      ...(over.input !== undefined ? { input: over.input } : {}),
    });
  }

  test("the planted acts render the rows exact — declared words joined, failures named by their code, oldest first", () => {
    uiSchema.set({
      blockActions: {
        "tools.breaker": [{ name: "trip", title: "Switch a tool off", consequence: "the tool refuses every call until switched back on", invalidates: [] }],
      },
    } as unknown as UiSchema);
    record({ block: "tools.breaker", action: "trip", requestedAt: 1, settledAt: 100 });
    record({ block: "arm.flags", action: "arm", settledAt: 200, state: "failed", errorCode: "invalid_arm_predicate" });
    const acts = runActs.get();
    expect(acts).toHaveLength(2);
    expect(acts[0]).toEqual({
      key: "tools.breaker/trip",
      block: "tools.breaker",
      action: "trip",
      title: "Switch a tool off",
      consequence: "the tool refuses every call until switched back on",
      state: "done",
      latencyMs: 99,
      at: 100,
    });
    expect(acts[1]!.state).toBe("failed");
    expect(acts[1]!.errorCode).toBe("invalid_arm_predicate");
    // The unlisted action keeps its honest absence — no invented title.
    expect(acts[1]!.title).toBeUndefined();
  });

  test("with no manifest, the rows keep the record's own facts and invent no words", () => {
    record({ block: "tools.breaker", action: "trip", settledAt: 7 });
    const acts = runActs.get();
    expect(acts[0]!.title).toBeUndefined();
    expect(acts[0]!.consequence).toBeUndefined();
    expect(acts[0]!.block).toBe("tools.breaker");
  });

  test("an AUTOMATIC act (the telemetry flush) is not an operator intervention — no row", () => {
    record({ origin: "automatic", block: "client.telemetry", action: "ingest", settledAt: 3 });
    record({ block: "tools.breaker", action: "trip", settledAt: 9 });
    // The witness: the operator act beside it IS a row, so the filter is
    // looking at the right log.
    expect(runActs.get().map((act) => act.key)).toEqual(["tools.breaker/trip"]);
  });
});
