// @vitest-environment node
import { describe, test, expect, beforeEach, vi } from "vitest";

import {
  currentRun,
  isRunActive,
  agents,
  activeAgents,
  agentsByState,
  agentCount,
  setRun,
  updateRunStatus,
  upsertAgent,
  resetRunState,
  retireRunView,
  type RunView,
} from "../../src/state/run-state";
import { RUN_STATUS_CLEAR_DELAY_MS } from "../../src/client-config";
import type { AgentState } from "../../shared/types";

function makeRun(status: RunView["status"] = "starting"): RunView {
  return { runId: "run-1", projectId: "p1", status, startedAt: 1000, modelLabel: null };
}

function makeAgent(
  agentId: string,
  lifecycleState: AgentState["lifecycleState"],
): AgentState {
  return {
    agentId,
    agentName: agentId,
    runId: "run-1",
    taskId: "task-1",
    attemptId: "att-1",
    lifecycleState,
    turnCount: 1,
    totalPromptTokens: 100,
    totalCompletionTokens: 50,
    totalTokens: 150,
    turns: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastError: null,
    compactionSummary: null,
    suspensionReason: null,
  };
}

describe("run-state store", () => {
  beforeEach(() => resetRunState());

  test("setRun sets the current run", () => {
    setRun(makeRun("running"));
    expect(currentRun.get()?.runId).toBe("run-1");
    expect(currentRun.get()?.status).toBe("running");
  });

  test("updateRunStatus transitions the status without losing other fields", () => {
    setRun(makeRun("starting"));
    updateRunStatus("done");
    const run = currentRun.get();
    expect(run?.status).toBe("done");
    expect(run?.runId).toBe("run-1");
    expect(run?.startedAt).toBe(1000);
  });

  test("updateRunStatus is a no-op when no run is set", () => {
    expect(() => updateRunStatus("done")).not.toThrow();
    expect(currentRun.get()).toBeNull();
  });

  // ── the view's settle and retirement live at the status owner ──────────
  //
  // A terminal status SETTLES the view (liveness gone, the pane's clock
  // stops, the stop verb vanishes, sends fall back to a new run) and then
  // RETIRES it after the outcome delay. Both halves are the owner's, so
  // every terminal door gets them by REPORTING its status — the measured
  // defect this shape ends: the error frame's listener did everything
  // else and never settled the view, because the settle lived in the
  // doors that remembered it instead of in the vocabulary that owns it.

  test("a TERMINAL status report settles the view and retires it after the outcome delay — every terminal status", () => {
    vi.useFakeTimers();
    try {
      for (const status of ["done", "error", "cancelled"] as const) {
        resetRunState();
        setRun(makeRun("running"));
        upsertAgent(makeAgent("a1", "succeeded"));
        updateRunStatus(status);
        // THE SETTLE is immediate: the status is the honest outcome and the
        // liveness is gone before any delay runs.
        expect(currentRun.get()?.status, `${status} settles the view`).toBe(status);
        expect(isRunActive.get(), `${status} is not live`).toBe(false);
        expect(currentRun.get(), "the outcome shows for the delay first").not.toBeNull();
        vi.advanceTimersByTime(RUN_STATUS_CLEAR_DELAY_MS);
        expect(currentRun.get(), `${status} retires the view at the delay`).toBeNull();
        expect(agentCount.get(), "the registry survives the retirement — it is the chat's record").toBe(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test("a LIVE status report cancels a pending retirement — a turn reopening is not settling", () => {
    // The steered-drain shape: a terminal-looking settle raced in from one
    // door while the run opened another turn. The live report must cancel
    // the retirement, or it fires mid-run and retires a live run's view.
    vi.useFakeTimers();
    try {
      setRun(makeRun("running"));
      updateRunStatus("done");
      updateRunStatus("running");
      vi.advanceTimersByTime(RUN_STATUS_CLEAR_DELAY_MS + 1);
      expect(currentRun.get()?.status, "a retirement never fires into a live run").toBe("running");
      expect(isRunActive.get()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("setRun drops the previous run's pending retirement — a new run's view is not retired by the old run's timer", () => {
    vi.useFakeTimers();
    try {
      setRun(makeRun("running"));
      updateRunStatus("done");
      setRun({ ...makeRun("starting"), runId: "run-2" });
      vi.advanceTimersByTime(RUN_STATUS_CLEAR_DELAY_MS + 1);
      expect(currentRun.get()?.runId).toBe("run-2");
      expect(currentRun.get()?.status).toBe("starting");
      expect(isRunActive.get()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("isRunActive is true for 'starting' and 'running'", () => {
    setRun(makeRun("starting"));
    expect(isRunActive.get()).toBe(true);
    updateRunStatus("running");
    expect(isRunActive.get()).toBe(true);
  });

  test("isRunActive is false for 'done', 'error', and idle (null run)", () => {
    setRun(makeRun("done"));
    expect(isRunActive.get()).toBe(false);
    updateRunStatus("error");
    expect(isRunActive.get()).toBe(false);
    resetRunState();
    expect(isRunActive.get()).toBe(false);
  });

  test("upsertAgent adds/updates an agent in the registry", () => {
    upsertAgent(makeAgent("a1", "running"));
    expect(agentCount.get()).toBe(1);
    expect(agents.get()["a1"]?.lifecycleState).toBe("running");
    upsertAgent(makeAgent("a1", "succeeded"));
    expect(agentCount.get()).toBe(1);
    expect(agents.get()["a1"]?.lifecycleState).toBe("succeeded");
  });

  test("activeAgents filters to running + pending", () => {
    upsertAgent(makeAgent("a1", "running"));
    upsertAgent(makeAgent("a2", "pending"));
    upsertAgent(makeAgent("a3", "succeeded"));
    upsertAgent(makeAgent("a4", "idle"));
    const active = activeAgents.get();
    expect(active).toHaveLength(2);
    expect(active.map((a) => a.agentId).sort()).toEqual(["a1", "a2"]);
  });

  test("agentsByState groups agents by lifecycle state", () => {
    upsertAgent(makeAgent("a1", "running"));
    upsertAgent(makeAgent("a2", "failed"));
    const grouped = agentsByState.get();
    expect(grouped.running).toHaveLength(1);
    expect(grouped.failed).toHaveLength(1);
    expect(grouped.idle).toHaveLength(0);
  });

  test("resetRunState clears both run and agents", () => {
    setRun(makeRun("running"));
    upsertAgent(makeAgent("a1", "running"));
    resetRunState();
    expect(currentRun.get()).toBeNull();
    expect(agentCount.get()).toBe(0);
  });

  test("retireRunView clears the run view but KEEPS the agent registry (a finished run's agents are the chat's record)", () => {
    setRun(makeRun("done"));
    upsertAgent(makeAgent("a1", "succeeded"));
    retireRunView();
    expect(currentRun.get()).toBeNull();
    expect(agentCount.get(), "the agent record must survive the run view clearing").toBe(1);
  });

  test("setRun is the boundary that clears the previous run's agents (a new run starts a fresh registry)", () => {
    upsertAgent(makeAgent("a1", "succeeded"));
    setRun(makeRun("running"));
    expect(agentCount.get(), "a new run must not list the previous run's agents").toBe(0);
    expect(currentRun.get()?.runId).toBe("run-1");
  });
});
