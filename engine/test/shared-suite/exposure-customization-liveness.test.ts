import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { join } from "node:path";

import {
  countAll,
  countSignals,
  executeAction,
  installCustomizationConfigStore,
  listCustomizations,
  listSignals,
  readSignal,
  resetCustomizationValue,
  setCustomizationValue,
} from "../../src/shared/exposure/index.ts";
import { registerAllExposure } from "../../src/shared/exposure/registrations/index.ts";
import { createEditorTools } from "../../src/editor/edit-tools.ts";
import { mkTempDir } from "../support/temp-dir.ts";
import { memoryState } from "../../src/shared/exposure/registrations/memory.ts";
import { contextState } from "../../src/shared/exposure/registrations/context.ts";
import { searchState } from "../../src/shared/exposure/registrations/search.ts";
import { fixtureConfigPath } from "../support/fixture-config-store.ts";

/**
 * CUSTOMIZATION LIVENESS — every rendered control must CHANGE BEHAVIOUR.
 *
 * Twelve registered customizations were quarantined by the web-side
 * control-plane guard (`tests/prevention/customization-write-path-owner.test.ts`
 * in the web repository) because their `set` was a no-op and/or their
 * `current` returned a constant. A rendered control that changes nothing is
 * a lie about capability. This suite is the harness-side proof of the fix,
 * and it proves MORE than a round-trip: for every customization in the
 * seven affected modules (memory, awareness, safety, learning, context,
 * hallucination, bias) it exercises the REAL code path — set the knob,
 * execute the module's behaviour, observe a different outcome, restore.
 *
 * A value that persists but influences nothing is the same lie one level
 * deeper, so a plain read-back test would not be enough.
 *
 * SECOND SWEEP — the four modules the first one never covered (editor,
 * quality, tools, search) held exactly that deeper lie: 24 controls whose
 * `set` worked and whose value survived, read by NO code path. Their proofs
 * are below, to the same standard, and the fresh probes at the bottom now
 * run over every served module — including a structural probe that
 * fails on any customization whose state field no signal, action, or helper
 * reads.
 */

// Config-bound customizations write through the installed config store.
// Install an IN-MEMORY store (seeded empty — every knob reads its declared
// default, which is all these behaviour probes need) so the suite never writes
// the real `bridlewise.config.json`. Without this, `setCustomizationValue`
// on a config-bound knob would persist to disk and a mid-run crash would leave
// the operator config drifted.
let livenessConfigDoc: Record<string, unknown> = {};
installCustomizationConfigStore({
  // The file this store would persist to — a scratch path in the suite's
  // own temp world: the store is in-memory and never writes it, but the
  // store contract declares the path so the write lock is never keyed on a
  // guess.
  configFilePath: fixtureConfigPath(mkTempDir("exposure-liveness-config-")),
  readDocument: () => JSON.parse(JSON.stringify(livenessConfigDoc)) as Record<string, unknown>,
  writeDocument: (next) => {
    livenessConfigDoc = next;
  },
});

registerAllExposure();

const run = async (
  id: string,
  args?: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> =>
  (await executeAction(id, args)) as Record<string, unknown>;

/** Ids removed because their module has no such capability (see registrations). */
const REMOVED_FOR_ABSENT_CAPABILITY = [
  "memory.decayRate",
  "memory.retentionDays",
  "safety.maxRetries",
  "safety.redactSecrets",
  "safety.biasTypes",
  "learning.teacherStudentEnabled",
  "learning.ruleFormat",
  "bias.detectionStrategy",
] as const;

/** The web-side KNOWN_INERT quarantine (12 ids) — every one must be resolved. */
const QUARANTINED = [
  "memory.maxCorrupted",
  "awareness.detailedReport",
  "safety.biasTypes",
  "safety.groundingMode",
  "learning.recallThreshold",
  "context.retrievalTopK",
  "context.retrievalMinScore",
  "hallucination.evidenceTopK",
  "hallucination.correctivePrompt",
  "bias.escalateToOperator",
  "bias.maxAuditRows",
  "bias.detectionStrategy",
] as const;

const MODULES = [
  "memory", "awareness", "safety", "learning", "context", "hallucination", "bias",
  // The second sweep — the four modules whose controls were dead stores.
  "editor", "quality", "tools", "search",
  // The observability modules (the recorded ledger's knob + the
  // performance section's knobs) — both config-direct, so the round-trip
  // probe covers them and the dead-store probe skips them by design.
  "timeline", "performance",
] as const;

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

test("memory.maxCorrupted gates addEntry: writes refused beyond the tolerance", async () => {
  const originalCorrupted = memoryState.corruptedEntries;
  try {
    memoryState.corruptedEntries = 3;
    resetCustomizationValue("memory.maxCorrupted"); // default 0 < 3 -> refuse
    const before = memoryState.entryCount;
    const refused = await run("memory.addEntry", { tokens: 1 });
    assert.equal(refused.added, false);
    assert.equal(refused.refused, true);
    assert.equal(memoryState.entryCount, before, "a refused write must not add an entry");

    setCustomizationValue("memory.maxCorrupted", 5); // 3 <= 5 -> accept
    const accepted = await run("memory.addEntry", { tokens: 1 });
    assert.equal(accepted.added, true);
    assert.equal(memoryState.entryCount, before + 1);
  } finally {
    memoryState.corruptedEntries = originalCorrupted;
    resetCustomizationValue("memory.maxCorrupted");
  }
});

test("memory.windowSize / trimThreshold / trimStep drive present-window trimming", async () => {
  try {
    await run("memory.clear");
    setCustomizationValue("memory.windowSize", 1000);
    setCustomizationValue("memory.trimThreshold", 0.5);
    setCustomizationValue("memory.trimStep", 0.1);
    const a = await run("memory.addEntry", { tier: "present", tokens: 600 });
    assert.equal(a.trimmedTokens, 100, "600 > 0.5*1000 -> one 0.1*1000 chunk trimmed");

    setCustomizationValue("memory.trimStep", 0.2);
    await run("memory.clear");
    const b = await run("memory.addEntry", { tier: "present", tokens: 600 });
    assert.equal(b.trimmedTokens, 200, "a larger trimStep must trim more per pass");

    setCustomizationValue("memory.trimThreshold", 0.7);
    await run("memory.clear");
    const c = await run("memory.addEntry", { tier: "present", tokens: 600 });
    assert.equal(c.trimmedTokens, 0, "600 <= 0.7*1000 -> below threshold, no trim");

    setCustomizationValue("memory.windowSize", 700);
    await run("memory.clear");
    const d = await run("memory.addEntry", { tier: "present", tokens: 600 });
    assert.ok((d.trimmedTokens as number) > 0, "a smaller window must start trimming sooner");
  } finally {
    for (const id of ["memory.windowSize", "memory.trimThreshold", "memory.trimStep"]) {
      resetCustomizationValue(id);
    }
    await run("memory.clear");
  }
});

test("memory.promoteOnTurnBoundary gates turn-boundary promotion", async () => {
  try {
    await run("memory.clear");
    setCustomizationValue("memory.promoteOnTurnBoundary", true);
    await run("memory.addEntry", { tier: "present", tokens: 1 });
    await run("memory.addEntry", { tier: "present", tokens: 1 });
    const promoted = await run("memory.turnBoundary");
    assert.equal(promoted.promoted, 2);
    assert.equal(memoryState.presentCount, 0);

    setCustomizationValue("memory.promoteOnTurnBoundary", false);
    await run("memory.addEntry", { tier: "present", tokens: 1 });
    const skipped = await run("memory.turnBoundary");
    assert.equal(skipped.promoted, 0, "promotion must not run when disabled");
    assert.equal(memoryState.presentCount, 1);
  } finally {
    resetCustomizationValue("memory.promoteOnTurnBoundary");
    await run("memory.clear");
  }
});

test("memory.defaultTier decides where addEntry stores", async () => {
  try {
    await run("memory.clear");
    setCustomizationValue("memory.defaultTier", "long");
    await run("memory.addEntry", { tokens: 1 });
    assert.equal(memoryState.longTermCount, 1);
    setCustomizationValue("memory.defaultTier", "present");
    await run("memory.addEntry", { tokens: 1 });
    assert.equal(memoryState.presentCount, 1);
  } finally {
    resetCustomizationValue("memory.defaultTier");
    await run("memory.clear");
  }
});

// ---------------------------------------------------------------------------
// awareness
// ---------------------------------------------------------------------------

test("awareness.detailedReport adds per-signal detail rows to refresh", async () => {
  try {
    setCustomizationValue("awareness.detailedReport", false);
    const plain = await run("awareness.refresh");
    assert.ok(!("signals" in plain), "no detail rows unless detailedReport is on");

    setCustomizationValue("awareness.detailedReport", true);
    setCustomizationValue("awareness.enabledSignals", "memory.entryCount,search.queryCount");
    const detailed = await run("awareness.refresh");
    const rows = detailed.signals as Array<{ id: string; value: unknown }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.id).toSorted(), ["memory.entryCount", "search.queryCount"]);
  } finally {
    resetCustomizationValue("awareness.detailedReport");
    resetCustomizationValue("awareness.enabledSignals");
  }
});

test("awareness.metric selects which registry count the view reports", async () => {
  try {
    setCustomizationValue("awareness.metric", "all");
    const all = await run("awareness.refresh");
    assert.equal(all.viewCount, countAll());
    setCustomizationValue("awareness.metric", "signals");
    const signals = await run("awareness.refresh");
    assert.equal(signals.viewCount, countSignals());
    assert.notEqual(all.viewCount, signals.viewCount);
  } finally {
    resetCustomizationValue("awareness.metric");
  }
});

test("awareness.compactMaxTokens caps the detailed report", async () => {
  try {
    setCustomizationValue("awareness.detailedReport", true);
    const manyIds = listSignals().slice(0, 60).map((s) => s.id).join(",");
    setCustomizationValue("awareness.enabledSignals", manyIds);

    setCustomizationValue("awareness.compactMaxTokens", 256);
    const capped = await run("awareness.refresh");
    const cappedRows = capped.signals as unknown[];
    assert.equal(capped.truncated, true, "60 rows must not fit in 256 tokens");

    setCustomizationValue("awareness.compactMaxTokens", 1_000_000);
    const uncapped = await run("awareness.refresh");
    const uncappedRows = uncapped.signals as unknown[];
    assert.equal(uncapped.truncated, false);
    assert.ok(uncappedRows.length > cappedRows.length, "a larger cap must retain more rows");
  } finally {
    resetCustomizationValue("awareness.detailedReport");
    resetCustomizationValue("awareness.enabledSignals");
    resetCustomizationValue("awareness.compactMaxTokens");
  }
});

test("awareness.backgroundMonitor + refreshInterval run a real background heartbeat", async () => {
  try {
    setCustomizationValue("awareness.backgroundMonitor", false);
    setCustomizationValue("awareness.refreshInterval", 100);
    setCustomizationValue("awareness.backgroundMonitor", true);
    const before = Number(readSignal("awareness.refreshCount"));
    await sleep(380);
    const after = Number(readSignal("awareness.refreshCount"));
    assert.ok(after > before, `background monitor must refresh on its own (before=${before}, after=${after})`);

    setCustomizationValue("awareness.backgroundMonitor", false);
    const stopped = Number(readSignal("awareness.refreshCount"));
    await sleep(250);
    assert.equal(Number(readSignal("awareness.refreshCount")), stopped, "a disabled monitor must not tick");
  } finally {
    resetCustomizationValue("awareness.refreshInterval");
    resetCustomizationValue("awareness.backgroundMonitor");
  }
});

test("awareness.alertThreshold drives the alertActive signal", async () => {
  try {
    // Guarantee a positive, bounded update rate: computationTimeMs >= 10
    // and one monitored signal -> 0 < updateRate <= 100.
    setCustomizationValue("awareness.enabledSignals", "memory.entryCount");
    await run("awareness.tick", { signals: 1, timeMs: 10 });
    await run("awareness.refresh");
    setCustomizationValue("awareness.alertThreshold", 1000);
    assert.equal(readSignal("awareness.alertActive"), false);
    setCustomizationValue("awareness.alertThreshold", 0);
    assert.equal(readSignal("awareness.alertActive"), true);
  } finally {
    resetCustomizationValue("awareness.alertThreshold");
    resetCustomizationValue("awareness.enabledSignals");
  }
});

// ---------------------------------------------------------------------------
// safety
// ---------------------------------------------------------------------------

test("safety.threshold judges score-based observations", async () => {
  try {
    setCustomizationValue("safety.threshold", 0.5);
    const caught = await run("safety.reportHallucination", { score: 0.6 });
    assert.equal(caught.caught, true);
    setCustomizationValue("safety.threshold", 0.7);
    const missed = await run("safety.reportHallucination", { score: 0.6 });
    assert.equal(missed.caught, false);
  } finally {
    resetCustomizationValue("safety.threshold");
    await run("safety.clear");
  }
});

test("safety.failClosed decides the uncertain-input default", async () => {
  try {
    setCustomizationValue("safety.failClosed", true);
    assert.equal((await run("safety.reportHallucination")).caught, true);
    assert.equal((await run("safety.reportBias")).prevented, true);
    setCustomizationValue("safety.failClosed", false);
    assert.equal((await run("safety.reportHallucination")).caught, false);
    assert.equal((await run("safety.reportBias")).prevented, false);
  } finally {
    resetCustomizationValue("safety.failClosed");
    await run("safety.clear");
  }
});

test("safety.whitelistEnabled exempts whitelisted items and counts the hit", async () => {
  try {
    setCustomizationValue("safety.whitelistEnabled", true);
    const hitsBefore = Number(readSignal("safety.whitelistHitCount"));
    const countBefore = Number(readSignal("safety.hallucinationCount"));
    const passed = await run("safety.reportHallucination", { whitelisted: true });
    assert.equal(passed.whitelisted, true);
    assert.equal(Number(readSignal("safety.whitelistHitCount")), hitsBefore + 1);
    assert.equal(Number(readSignal("safety.hallucinationCount")), countBefore, "whitelisted items are not counted");

    setCustomizationValue("safety.whitelistEnabled", false);
    const counted = await run("safety.reportHallucination", { whitelisted: true });
    assert.ok(!("whitelisted" in counted), "a disabled whitelist exempts nothing");
    assert.equal(Number(readSignal("safety.hallucinationCount")), countBefore + 1);
  } finally {
    resetCustomizationValue("safety.whitelistEnabled");
    await run("safety.clear");
  }
});

test("safety.groundingEnabled + groundingMode drive enforcement", async () => {
  try {
    setCustomizationValue("safety.groundingEnabled", false);
    const disabled = await run("safety.enforceGrounding");
    assert.equal(disabled.enforced, false);

    setCustomizationValue("safety.groundingEnabled", true);
    setCustomizationValue("safety.groundingMode", "off");
    assert.equal((await run("safety.enforceGrounding")).enforced, false);

    setCustomizationValue("safety.groundingMode", "warn");
    const warn = await run("safety.enforceGrounding");
    assert.equal(warn.enforced, true);
    assert.equal(warn.blocked, false);

    setCustomizationValue("safety.groundingMode", "strict");
    assert.equal((await run("safety.enforceGrounding", { grounded: false })).blocked, true);
    assert.equal((await run("safety.enforceGrounding", { grounded: true })).blocked, false);

    setCustomizationValue("safety.groundingMode", "block");
    assert.equal((await run("safety.enforceGrounding", { grounded: true })).blocked, true);
  } finally {
    resetCustomizationValue("safety.groundingEnabled");
    resetCustomizationValue("safety.groundingMode");
    await run("safety.clear");
  }
});

// ---------------------------------------------------------------------------
// learning
// ---------------------------------------------------------------------------

test("learning.recallThreshold gates rule recall", async () => {
  try {
    setCustomizationValue("learning.recallThreshold", 0.6);
    const notRecalled = await run("learning.applyRule", { score: 0.5 });
    assert.equal(notRecalled.recalled, false);
    setCustomizationValue("learning.recallThreshold", 0.4);
    const recalled = await run("learning.applyRule", { score: 0.5 });
    assert.equal(recalled.recalled, true);
  } finally {
    resetCustomizationValue("learning.recallThreshold");
    await run("learning.clearRules");
  }
});

test("learning.minConfidence gates rule retention", async () => {
  try {
    await run("learning.clearRules");
    setCustomizationValue("learning.minConfidence", 0.7);
    assert.equal((await run("learning.addRule", { confidence: 0.65 })).added, false);
    setCustomizationValue("learning.minConfidence", 0.6);
    assert.equal((await run("learning.addRule", { confidence: 0.65 })).added, true);
  } finally {
    resetCustomizationValue("learning.minConfidence");
    await run("learning.clearRules");
  }
});

test("learning.maxRules caps the retained rule set", async () => {
  try {
    await run("learning.clearRules");
    setCustomizationValue("learning.maxRules", 0);
    const refused = await run("learning.addRule", { confidence: 0.9 });
    assert.equal(refused.added, false);
    assert.equal(refused.reason, "maxRules reached");
    setCustomizationValue("learning.maxRules", 100);
    assert.equal((await run("learning.addRule", { confidence: 0.9 })).added, true);
  } finally {
    resetCustomizationValue("learning.maxRules");
    await run("learning.clearRules");
  }
});

test("learning.autoLearnEnabled learns a corrective rule from a rejection", async () => {
  try {
    await run("learning.clearRules");
    setCustomizationValue("learning.autoLearnEnabled", true);
    const learned = await run("learning.applyRule", { accepted: false });
    assert.equal(learned.autoLearned, true);
    assert.equal(Number(readSignal("learning.ruleCount")), 1);

    setCustomizationValue("learning.autoLearnEnabled", false);
    const notLearned = await run("learning.applyRule", { accepted: false });
    assert.equal(notLearned.autoLearned, false);
    assert.equal(Number(readSignal("learning.ruleCount")), 1);
  } finally {
    resetCustomizationValue("learning.autoLearnEnabled");
    await run("learning.clearRules");
  }
});

test("learning.relearnInterval triggers automatic relearn passes", async () => {
  try {
    await run("learning.clearRules");
    setCustomizationValue("learning.relearnInterval", 1);
    const relearned = await run("learning.applyRule", { accepted: false });
    assert.equal(relearned.relearned, true);
    setCustomizationValue("learning.relearnInterval", 1_000_000);
    const notRelearned = await run("learning.applyRule", { accepted: false });
    assert.equal(notRelearned.relearned, false);
  } finally {
    resetCustomizationValue("learning.relearnInterval");
    await run("learning.clearRules");
  }
});

test("learning.plateauThreshold classifies improvement deltas", async () => {
  try {
    setCustomizationValue("learning.plateauThreshold", 0.05);
    await run("learning.setReduction", { rate: 0.5 });
    assert.equal((await run("learning.setReduction", { rate: 0.52 })).plateaued, true);
    setCustomizationValue("learning.plateauThreshold", 0.01);
    assert.equal((await run("learning.setReduction", { rate: 0.55 })).plateaued, false);
  } finally {
    resetCustomizationValue("learning.plateauThreshold");
    await run("learning.setReduction", { rate: 0 });
  }
});

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

test("context.retrievalTopK caps injected entries per retrieval pass", async () => {
  try {
    setCustomizationValue("context.retrievalMinScore", 0.3);
    setCustomizationValue("context.retrievalTopK", 5);
    const five = await run("context.retrieveMemory", { scores: "0.9,0.8,0.7,0.6,0.5,0.4" });
    assert.equal(five.injected, 5);
    setCustomizationValue("context.retrievalTopK", 2);
    const two = await run("context.retrieveMemory", { scores: "0.9,0.8,0.7,0.6,0.5,0.4" });
    assert.equal(two.injected, 2);
  } finally {
    resetCustomizationValue("context.retrievalTopK");
    resetCustomizationValue("context.retrievalMinScore");
  }
});

test("context.retrievalMinScore filters low-scoring entries", async () => {
  try {
    setCustomizationValue("context.retrievalTopK", 10);
    setCustomizationValue("context.retrievalMinScore", 0.3);
    assert.equal((await run("context.retrieveMemory", { scores: "0.9,0.5,0.2" })).injected, 2);
    setCustomizationValue("context.retrievalMinScore", 0.6);
    assert.equal((await run("context.retrieveMemory", { scores: "0.9,0.5,0.2" })).injected, 1);
  } finally {
    resetCustomizationValue("context.retrievalTopK");
    resetCustomizationValue("context.retrievalMinScore");
  }
});

test("context.preserveSystem shields system tokens from trims", async () => {
  try {
    await run("context.clear");
    setCustomizationValue("context.preserveSystem", true);
    setCustomizationValue("context.preserveLast", false);
    await run("context.addTokens", { count: 1000, kind: "system" });
    const shielded = await run("context.forceTrim", { amount: 1000 });
    assert.equal(shielded.amount, 0, "system tokens must survive the trim");

    setCustomizationValue("context.preserveSystem", false);
    const trimmed = await run("context.forceTrim", { amount: 1000 });
    assert.equal(trimmed.amount, 1000);
  } finally {
    resetCustomizationValue("context.preserveSystem");
    resetCustomizationValue("context.preserveLast");
    await run("context.clear");
  }
});

test("context.preserveLast shields the most recent message from trims", async () => {
  try {
    await run("context.clear");
    setCustomizationValue("context.preserveSystem", false);
    setCustomizationValue("context.preserveLast", true);
    await run("context.addTokens", { count: 500 });
    assert.equal((await run("context.forceTrim", { amount: 500 })).amount, 0);
    setCustomizationValue("context.preserveLast", false);
    assert.equal((await run("context.forceTrim", { amount: 500 })).amount, 500);
  } finally {
    resetCustomizationValue("context.preserveSystem");
    resetCustomizationValue("context.preserveLast");
    await run("context.clear");
  }
});

test("context.compactStrategy changes what a trim does with the tokens", async () => {
  const prime = async (): Promise<void> => {
    await run("context.clear");
    await run("context.addTokens", { count: 1000 });
  };
  try {
    setCustomizationValue("context.preserveSystem", false);
    setCustomizationValue("context.preserveLast", false);

    setCustomizationValue("context.compactStrategy", "oldest");
    await prime();
    const oldest = await run("context.forceTrim", { amount: 500 });
    assert.equal(oldest.residue, 0);
    assert.equal(oldest.offloaded, 0);
    assert.equal(oldest.remaining, 500);

    setCustomizationValue("context.compactStrategy", "summary");
    await prime();
    const summary = await run("context.forceTrim", { amount: 500 });
    assert.equal(summary.residue, 50, "summary retains a compressed residue");
    assert.equal(summary.remaining, 550);

    setCustomizationValue("context.compactStrategy", "vector");
    const offloadedBefore = contextState.offloadedTokens;
    await prime();
    const vector = await run("context.forceTrim", { amount: 500 });
    assert.equal(vector.offloaded, 500);
    assert.equal(contextState.offloadedTokens, offloadedBefore + 500);
  } finally {
    resetCustomizationValue("context.compactStrategy");
    resetCustomizationValue("context.preserveSystem");
    resetCustomizationValue("context.preserveLast");
    await run("context.clear");
  }
});

test("context.maxContext / trimThreshold / trimStep drive overflow + auto-trim", async () => {
  const prime = async (): Promise<void> => {
    await run("context.clear");
    await run("context.addTokens", { count: 500 });
  };
  try {
    setCustomizationValue("context.preserveSystem", false);
    setCustomizationValue("context.preserveLast", false);

    // maxContext: adding past the window overflows.
    await run("context.clear");
    setCustomizationValue("context.maxContext", 1024);
    const overflowBefore = Number(readSignal("context.overflowCount"));
    await run("context.addTokens", { count: 2000 });
    assert.equal(Number(readSignal("context.overflowCount")), overflowBefore + 1);

    // trimThreshold: utilization 500/1024 = 0.49 trims only below-threshold.
    setCustomizationValue("context.trimThreshold", 0.85);
    await prime();
    assert.equal((await run("context.autoTrim")).trimmed, false);
    setCustomizationValue("context.trimThreshold", 0.4);
    await prime();
    assert.equal((await run("context.autoTrim")).trimmed, true);

    // trimStep: the pass drops trimStep of the current window.
    setCustomizationValue("context.trimStep", 0.1);
    await prime();
    assert.equal((await run("context.autoTrim")).amount, 50);
    setCustomizationValue("context.trimStep", 0.5);
    await prime();
    assert.equal((await run("context.autoTrim")).amount, 250);
  } finally {
    resetCustomizationValue("context.maxContext");
    resetCustomizationValue("context.trimThreshold");
    resetCustomizationValue("context.trimStep");
    resetCustomizationValue("context.preserveSystem");
    resetCustomizationValue("context.preserveLast");
    await run("context.clear");
  }
});

// ---------------------------------------------------------------------------
// hallucination
// ---------------------------------------------------------------------------

test("hallucination.threshold judges score-based traps", async () => {
  try {
    setCustomizationValue("hallucination.threshold", 0.5);
    assert.equal((await run("hallucination.fireTrap", { score: 0.6 })).caught, true);
    setCustomizationValue("hallucination.threshold", 0.7);
    assert.equal((await run("hallucination.fireTrap", { score: 0.6 })).caught, false);
  } finally {
    resetCustomizationValue("hallucination.threshold");
    await run("hallucination.reset");
  }
});

test("hallucination.groundingThreshold judges evidence-based traps", async () => {
  try {
    setCustomizationValue("hallucination.groundingThreshold", 0.7);
    const grounded = await run("hallucination.fireTrap", { evidenceScores: "0.8,0.8" });
    assert.equal(grounded.grounded, true);
    assert.equal(grounded.caught, false);
    setCustomizationValue("hallucination.groundingThreshold", 0.9);
    const ungrounded = await run("hallucination.fireTrap", { evidenceScores: "0.8,0.8" });
    assert.equal(ungrounded.grounded, false);
    assert.equal(ungrounded.caught, true);
  } finally {
    resetCustomizationValue("hallucination.groundingThreshold");
    await run("hallucination.reset");
  }
});

test("hallucination.evidenceTopK bounds the evidence considered per claim", async () => {
  try {
    setCustomizationValue("hallucination.groundingThreshold", 0.7);
    setCustomizationValue("hallucination.evidenceTopK", 5);
    const wide = await run("hallucination.fireTrap", { evidenceScores: "0.9,0.1,0.1" });
    assert.equal(wide.evidenceConsidered, 3);
    assert.equal(wide.grounded, false, "mean(0.9,0.1,0.1) < 0.7");

    setCustomizationValue("hallucination.evidenceTopK", 1);
    const narrow = await run("hallucination.fireTrap", { evidenceScores: "0.9,0.1,0.1" });
    assert.equal(narrow.evidenceConsidered, 1);
    assert.equal(narrow.grounded, true, "mean(top-1) = 0.9 >= 0.7");
  } finally {
    resetCustomizationValue("hallucination.evidenceTopK");
    resetCustomizationValue("hallucination.groundingThreshold");
    await run("hallucination.reset");
  }
});

test("hallucination.autoCorrect corrects caught traps by default", async () => {
  try {
    setCustomizationValue("hallucination.autoCorrect", true);
    assert.equal((await run("hallucination.fireTrap", { caught: true })).corrected, true);
    setCustomizationValue("hallucination.autoCorrect", false);
    assert.equal((await run("hallucination.fireTrap", { caught: true })).corrected, false);
  } finally {
    resetCustomizationValue("hallucination.autoCorrect");
    await run("hallucination.reset");
  }
});

test("hallucination.correctivePrompt re-prompts on correction", async () => {
  try {
    setCustomizationValue("hallucination.correctivePrompt", true);
    assert.equal((await run("hallucination.fireTrap", { caught: true, corrected: true })).reprompted, true);
    setCustomizationValue("hallucination.correctivePrompt", false);
    assert.equal((await run("hallucination.fireTrap", { caught: true, corrected: true })).reprompted, false);
  } finally {
    resetCustomizationValue("hallucination.correctivePrompt");
    await run("hallucination.reset");
  }
});

test("hallucination.escalateOnMiss escalates missed traps", async () => {
  try {
    setCustomizationValue("hallucination.escalateOnMiss", true);
    assert.equal((await run("hallucination.fireTrap", { caught: false })).escalated, true);
    setCustomizationValue("hallucination.escalateOnMiss", false);
    assert.equal((await run("hallucination.fireTrap", { caught: false })).escalated, false);
  } finally {
    resetCustomizationValue("hallucination.escalateOnMiss");
    await run("hallucination.reset");
  }
});

test("hallucination.layers + layerMode gate which traps fire", async () => {
  try {
    setCustomizationValue("hallucination.layers", "factual,logical,self-contradiction,temporal");
    setCustomizationValue("hallucination.layerMode", "all");
    assert.equal((await run("hallucination.fireTrap", { layer: "temporal", caught: true })).fired, true);

    setCustomizationValue("hallucination.layerMode", "factual");
    assert.equal((await run("hallucination.fireTrap", { layer: "temporal", caught: true })).fired, false);
    assert.equal((await run("hallucination.fireTrap", { layer: "factual", caught: true })).fired, true);

    setCustomizationValue("hallucination.layers", "logical,temporal");
    assert.equal((await run("hallucination.fireTrap", { layer: "factual", caught: true })).fired, false,
      "an inactive layer must not fire even when the mode admits it");
  } finally {
    resetCustomizationValue("hallucination.layers");
    resetCustomizationValue("hallucination.layerMode");
    await run("hallucination.reset");
  }
});

// ---------------------------------------------------------------------------
// bias
// ---------------------------------------------------------------------------

test("bias.threshold gates whether a scored finding is flagged", async () => {
  try {
    setCustomizationValue("bias.threshold", 0.5);
    assert.equal((await run("bias.reportDetection", { type: "gender", score: 0.6 })).flagged, true);
    setCustomizationValue("bias.threshold", 0.7);
    const below = await run("bias.reportDetection", { type: "gender", score: 0.6 });
    assert.equal(below.flagged, false);
    assert.equal(below.reason, "below threshold");
  } finally {
    resetCustomizationValue("bias.threshold");
    await run("bias.reset");
  }
});

test("bias.biasTypes is the surveillance gate for detections", async () => {
  try {
    setCustomizationValue("bias.biasTypes", "gender,race");
    const outside = await run("bias.reportDetection", { type: "zodiac" });
    assert.equal(outside.flagged, false);
    assert.equal(outside.reason, "type not under surveillance");
    setCustomizationValue("bias.biasTypes", "gender,race,zodiac");
    assert.equal((await run("bias.reportDetection", { type: "zodiac" })).flagged, true);
  } finally {
    resetCustomizationValue("bias.biasTypes");
    await run("bias.reset");
  }
});

test("bias.preventionMode decides the default action on a finding", async () => {
  try {
    setCustomizationValue("bias.preventionMode", "warn");
    const warn = await run("bias.reportDetection", { type: "gender" });
    assert.equal(warn.prevented, false);
    assert.equal(warn.warned, true);

    setCustomizationValue("bias.preventionMode", "block");
    const block = await run("bias.reportDetection", { type: "gender" });
    assert.equal(block.prevented, true);
    assert.equal(block.warned, false);

    setCustomizationValue("bias.preventionMode", "off");
    const off = await run("bias.reportDetection", { type: "gender" });
    assert.equal(off.prevented, false);
    assert.equal(off.warned, false);
  } finally {
    resetCustomizationValue("bias.preventionMode");
    await run("bias.reset");
  }
});

test("bias.escalateToOperator controls escalation of findings", async () => {
  try {
    setCustomizationValue("bias.escalateToOperator", true);
    assert.equal((await run("bias.reportDetection", { type: "gender" })).escalated, true);
    setCustomizationValue("bias.escalateToOperator", false);
    assert.equal((await run("bias.reportDetection", { type: "gender" })).escalated, false);
  } finally {
    resetCustomizationValue("bias.escalateToOperator");
    await run("bias.reset");
  }
});

test("bias.auditMode + recordInputs control the audit log rows", async () => {
  try {
    await run("bias.reset");
    setCustomizationValue("bias.auditMode", "off");
    const unaudited = await run("bias.reportDetection", { type: "gender" });
    assert.equal(unaudited.audited, false);
    assert.equal(Number(readSignal("bias.auditRowCount")), 0);

    setCustomizationValue("bias.auditMode", "detailed");
    setCustomizationValue("bias.recordInputs", false);
    await run("bias.reportDetection", { type: "gender", input: "resume text" });
    let rows = (await run("bias.readAudit")).rows as string[];
    assert.ok(!rows[rows.length - 1]!.includes("resume text"), "inputs must not be audited unless enabled");

    setCustomizationValue("bias.recordInputs", true);
    await run("bias.reportDetection", { type: "gender", input: "resume text" });
    rows = (await run("bias.readAudit")).rows as string[];
    assert.ok(rows[rows.length - 1]!.includes("input=resume text"));
  } finally {
    resetCustomizationValue("bias.auditMode");
    resetCustomizationValue("bias.recordInputs");
    await run("bias.reset");
  }
});

test("bias.maxAuditRows caps the audit log, immediately and on write", async () => {
  try {
    await run("bias.reset");
    setCustomizationValue("bias.auditMode", "summary");
    setCustomizationValue("bias.maxAuditRows", 2);
    for (let i = 0; i < 5; i += 1) await run("bias.reportDetection", { type: "gender" });
    assert.equal(Number(readSignal("bias.auditRowCount")), 2);

    setCustomizationValue("bias.maxAuditRows", 1);
    assert.equal(Number(readSignal("bias.auditRowCount")), 1, "a lowered cap applies immediately");
  } finally {
    resetCustomizationValue("bias.maxAuditRows");
    resetCustomizationValue("bias.auditMode");
    await run("bias.reset");
  }
});

// ---------------------------------------------------------------------------
// editor — five dead stores, now read by applyEdit/rollback
// ---------------------------------------------------------------------------

test("editor.fuzzyThreshold decides whether an edit can be placed at all", async () => {
  try {
    await run("editor.clearHistory");
    setCustomizationValue("editor.fuzzyThreshold", 0.85);
    const refused = await run("editor.applyEdit", { matchScore: 0.8 });
    assert.equal(refused.applied, false);
    assert.equal(refused.reason, "match below edit-match strictness");
    assert.equal(refused.attempts, 0, "a placement the editor cannot find is never attempted");

    setCustomizationValue("editor.fuzzyThreshold", 0.7);
    const placed = await run("editor.applyEdit", { matchScore: 0.8 });
    assert.equal(placed.applied, true, "a more forgiving strictness admits the same edit");
  } finally {
    resetCustomizationValue("editor.fuzzyThreshold");
    await run("editor.clearHistory");
  }
});

test("editor.maxRetries decides whether a flaky edit lands, and how many attempts it takes", async () => {
  try {
    await run("editor.clearHistory");
    setCustomizationValue("editor.maxRetries", 1);
    const gaveUp = await run("editor.applyEdit", { failAttempts: 2 });
    assert.equal(gaveUp.applied, false);
    assert.equal(gaveUp.attempts, 2, "one retry beyond the first attempt");

    setCustomizationValue("editor.maxRetries", 3);
    const rescued = await run("editor.applyEdit", { failAttempts: 2 });
    assert.equal(rescued.applied, true, "more retries rescue the same edit");
    assert.equal(rescued.attempts, 3);
    assert.equal(rescued.retries, 2);
  } finally {
    resetCustomizationValue("editor.maxRetries");
    await run("editor.clearHistory");
  }
});

test("editor.backupOnEdit decides whether a rollback has anything to restore", async () => {
  // The preview path carries no file, so the RESTORE side is driven through
  // the real edit tool (a snapshot of bytes that genuinely existed) — the
  // synthetic path only proves the knob REPORTS the right backup decision.
  const dir = mkTempDir("editor-liveness-backup-");
  try {
    await run("editor.clearHistory");
    setCustomizationValue("editor.backupOnEdit", false);
    const unbacked = await run("editor.applyEdit");
    assert.equal(unbacked.backedUp, false);
    const refused = await run("editor.rollback");
    assert.equal(refused.rolledBack, false, "nothing was snapshotted, so nothing can be restored");
    assert.equal(refused.reason, "no retained snapshot to restore");

    setCustomizationValue("editor.backupOnEdit", true);
    writeFileSync(join(dir, "b.ts"), "export const v = 1;\n");
    const tools = createEditorTools({ repositoryRoot: dir, writeSet: new Set(["b.ts"]) });
    const edit = tools.handlers.edit!({ path: "b.ts", oldString: "v = 1", newString: "v = 2" });
    assert.equal(edit.success, true, "the real edit applied");
    const restored = await run("editor.rollback");
    assert.equal(restored.rolledBack, true, "a real edit's snapshot restores");
    assert.equal(restored.path, "b.ts");
    assert.equal(readFileSync(join(dir, "b.ts"), "utf8"), "export const v = 1;\n", "the file's bytes were restored");
  } finally {
    resetCustomizationValue("editor.backupOnEdit");
    await run("editor.clearHistory");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("editor.viewportLines decides how much context each edit captures and restores", async () => {
  // A synthetic preview's rollback honestly refuses (there is no file to
  // restore), so the captured-context knob is asserted on the preview's own
  // report; the RESTORE of real context is the backupOnEdit arm above.
  try {
    await run("editor.clearHistory");
    setCustomizationValue("editor.backupOnEdit", true);
    setCustomizationValue("editor.viewportLines", 10);
    const narrow = await run("editor.applyEdit", { hunks: 2 });
    assert.equal(narrow.contextLines, 20, "2 hunks x 10 lines of surrounding context");

    setCustomizationValue("editor.viewportLines", 200);
    const wide = await run("editor.applyEdit", { hunks: 2 });
    assert.equal(wide.contextLines, 400, "a wider viewport captures more context");
    // The previews pushed restorable-nothing entries; the knob's restore side
    // is proven against a real file in the backupOnEdit arm.
    assert.equal((await run("editor.rollback")).rolledBack, false, "a preview snapshot is never restored as if it were a file");
  } finally {
    resetCustomizationValue("editor.viewportLines");
    resetCustomizationValue("editor.backupOnEdit");
    await run("editor.clearHistory");
  }
});

test("editor.historyRetention caps how far back rollbacks reach, immediately and on write", async () => {
  // Drive REAL edits so the retention cap is proven against snapshots that
  // genuinely restore — the preview-only shape let a retention bug hide
  // behind entries that were never undoable.
  const dir = mkTempDir("editor-liveness-retention-");
  try {
    await run("editor.clearHistory");
    setCustomizationValue("editor.backupOnEdit", true);
    setCustomizationValue("editor.historyRetention", 2);
    writeFileSync(join(dir, "r.ts"), "export const v = 0;\n");
    const tools = createEditorTools({ repositoryRoot: dir, writeSet: new Set(["r.ts"]) });
    for (let i = 1; i <= 4; i += 1) {
      const r = tools.handlers.edit!({ path: "r.ts", oldString: `v = ${i - 1}`, newString: `v = ${i}` });
      assert.equal(r.success, true, `edit ${i} applied`);
    }
    // 4 real edits, retention 2 → the two oldest snapshots were dropped.
    assert.equal((await run("editor.rollback")).historyDepth, 1, "only 2 of the 4 snapshots were kept");
    assert.equal((await run("editor.rollback")).rolledBack, true);
    assert.equal((await run("editor.rollback")).rolledBack, false, "the third rollback has nothing left");

    for (let i = 5; i <= 7; i += 1) {
      const r = tools.handlers.edit!({ path: "r.ts", oldString: `v = ${i - 1}`, newString: `v = ${i}` });
      assert.equal(r.success, true);
    }
    setCustomizationValue("editor.historyRetention", 1);
    assert.equal((await run("editor.rollback")).historyDepth, 0, "a lowered cap drops older snapshots right away");
    assert.equal((await run("editor.rollback")).rolledBack, false);
  } finally {
    resetCustomizationValue("editor.historyRetention");
    resetCustomizationValue("editor.backupOnEdit");
    await run("editor.clearHistory");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("editor.atomicWriteEnabled decides whether a failed edit leaves partial hunks behind", async () => {
  try {
    await run("editor.clearHistory");
    setCustomizationValue("editor.maxRetries", 0);
    setCustomizationValue("editor.atomicWriteEnabled", true);
    const atomic = await run("editor.applyEdit", { succeed: false, hunks: 5, partialHunks: 3 });
    assert.equal(atomic.applied, false);
    assert.equal(atomic.retainedHunks, 0, "an all-or-nothing save leaves the file untouched");

    setCustomizationValue("editor.atomicWriteEnabled", false);
    const partial = await run("editor.applyEdit", { succeed: false, hunks: 5, partialHunks: 3 });
    assert.equal(partial.retainedHunks, 3, "without atomicity the hunks that landed stay landed");
  } finally {
    resetCustomizationValue("editor.atomicWriteEnabled");
    resetCustomizationValue("editor.maxRetries");
    await run("editor.clearHistory");
  }
});

test("editor.syntaxValidationEnabled decides whether an unparsable edit is caught", async () => {
  try {
    await run("editor.clearHistory");
    setCustomizationValue("editor.syntaxValidationEnabled", true);
    const caught = await run("editor.applyEdit", { syntaxOk: false });
    assert.equal(caught.applied, false);
    assert.equal(caught.reason, "post-edit syntax validation failed");

    setCustomizationValue("editor.syntaxValidationEnabled", false);
    const uncaught = await run("editor.applyEdit", { syntaxOk: false });
    assert.equal(uncaught.applied, true, "with validation off the same broken edit counts as done");
    assert.equal(uncaught.syntaxChecked, false);
  } finally {
    resetCustomizationValue("editor.syntaxValidationEnabled");
    await run("editor.clearHistory");
  }
});

test("editor.feedbackLoopEnabled decides whether the previous failure reaches the next edit", async () => {
  try {
    await run("editor.clearHistory");
    setCustomizationValue("editor.maxRetries", 0);
    setCustomizationValue("editor.feedbackLoopEnabled", true);
    await run("editor.applyEdit", { succeed: false });
    assert.equal(
      (await run("editor.applyEdit")).priorFailure,
      "write failed after every retry",
      "the loop feeds the last outcome into the next edit",
    );

    setCustomizationValue("editor.feedbackLoopEnabled", false);
    await run("editor.applyEdit", { succeed: false });
    assert.equal((await run("editor.applyEdit")).priorFailure, "", "with the loop off nothing is carried over");
  } finally {
    resetCustomizationValue("editor.feedbackLoopEnabled");
    resetCustomizationValue("editor.maxRetries");
    await run("editor.clearHistory");
  }
});

// ---------------------------------------------------------------------------
// quality — six dead stores, now read by addFinding/recheck
// ---------------------------------------------------------------------------

test("quality's four severity cutoffs band every finding they classify", async () => {
  const band = async (score: number): Promise<unknown> =>
    (await run("quality.addFinding", { score })).severity;
  try {
    await run("quality.clear");
    // Defaults: critical < 0, high < 0.25, medium < 0.5, low < 0.75.
    assert.equal(await band(0.1), "high");
    assert.equal(await band(0.3), "medium");
    assert.equal(await band(0.6), "low");
    assert.equal(await band(0.9), "none");

    setCustomizationValue("quality.thresholdCritical", 0.2);
    assert.equal(await band(0.1), "critical", "raising the Critical cutoff pulls the same score into Critical");

    setCustomizationValue("quality.thresholdCritical", 0);
    setCustomizationValue("quality.thresholdHigh", 0.05);
    assert.equal(await band(0.1), "medium", "lowering the High cutoff pushes the same score down a band");

    setCustomizationValue("quality.thresholdMedium", 0.2);
    assert.equal(await band(0.3), "low");

    setCustomizationValue("quality.thresholdLow", 0.95);
    assert.equal(await band(0.9), "low", "raising the Low cutoff makes a previously unbanded score a finding");
  } finally {
    for (const id of ["thresholdCritical", "thresholdHigh", "thresholdMedium", "thresholdLow"]) {
      resetCustomizationValue(`quality.${id}`);
    }
    await run("quality.clear");
  }
});

test("quality.failOnHigh decides the check's verdict on a High finding", async () => {
  try {
    await run("quality.clear");
    setCustomizationValue("quality.failOnHigh", false);
    assert.equal((await run("quality.addFinding", { score: 0.1 })).failsGate, false);
    assert.equal((await run("quality.recheck")).passed, true);

    setCustomizationValue("quality.failOnHigh", true);
    assert.equal((await run("quality.addFinding", { score: 0.1 })).failsGate, true);
    const failed = await run("quality.recheck");
    assert.equal(failed.passed, false, "one High finding now fails the whole check");
    assert.deepEqual(failed.failedOn, ["high"]);
  } finally {
    resetCustomizationValue("quality.failOnHigh");
    await run("quality.clear");
  }
});

test("quality.failOnMedium decides the check's verdict on a Medium finding", async () => {
  try {
    await run("quality.clear");
    setCustomizationValue("quality.failOnMedium", false);
    await run("quality.addFinding", { score: 0.3 });
    assert.equal((await run("quality.recheck")).passed, true);

    setCustomizationValue("quality.failOnMedium", true);
    const failed = await run("quality.recheck");
    assert.equal(failed.passed, false, "the gate is re-read on every recheck, not frozen at the finding");
    assert.deepEqual(failed.failedOn, ["medium"]);
  } finally {
    resetCustomizationValue("quality.failOnMedium");
    await run("quality.clear");
  }
});

// ---------------------------------------------------------------------------
// tools — six dead stores, now read by invoke
// ---------------------------------------------------------------------------

test("tools.maxConcurrent refuses a call that arrives while the bound is full", async () => {
  try {
    await run("tools.clearInFlight");
    setCustomizationValue("tools.maxConcurrent", 1);
    assert.equal((await run("tools.invoke", { hold: true })).admitted, true);
    const refused = await run("tools.invoke");
    assert.equal(refused.admitted, false, "one call is already running and the bound is one");
    assert.equal(refused.reason, "concurrency limit reached");

    setCustomizationValue("tools.maxConcurrent", 3);
    assert.equal((await run("tools.invoke")).admitted, true, "a wider bound admits the same call");
  } finally {
    resetCustomizationValue("tools.maxConcurrent");
    await run("tools.clearInFlight");
    await run("tools.resetCounters");
  }
});

test("tools.timeout abandons a call that runs past the limit", async () => {
  try {
    await run("tools.resetCounters");
    setCustomizationValue("tools.timeout", 200);
    const abandoned = await run("tools.invoke", { latencyMs: 500 });
    assert.equal(abandoned.timedOut, true);
    assert.equal(abandoned.succeed, false);
    assert.equal(abandoned.latencyMs, 200, "an abandoned call consumed exactly its budget, not the full 500");
    assert.equal(Number(readSignal("tools.timeoutCount")), 1);

    setCustomizationValue("tools.timeout", 600000);
    const completed = await run("tools.invoke", { latencyMs: 500 });
    assert.equal(completed.timedOut, false);
    assert.equal(completed.latencyMs, 500);
  } finally {
    resetCustomizationValue("tools.timeout");
    await run("tools.resetCounters");
  }
});

test("tools.retryLimit decides whether a flaky call lands, and moves the retries-issued signal", async () => {
  try {
    await run("tools.resetCounters");
    setCustomizationValue("tools.retryLimit", 1);
    const gaveUp = await run("tools.invoke", { failAttempts: 2, latencyMs: 10 });
    assert.equal(gaveUp.succeed, false);
    assert.equal(gaveUp.attempts, 2);
    assert.equal(Number(readSignal("tools.retryCount")), 1, "the signal counts retries ISSUED, not the cap");

    setCustomizationValue("tools.retryLimit", 3);
    const rescued = await run("tools.invoke", { failAttempts: 2, latencyMs: 10 });
    assert.equal(rescued.succeed, true, "a higher cap rescues the same call");
    assert.equal(rescued.retries, 2);
    assert.equal(Number(readSignal("tools.retryCount")), 3);
  } finally {
    resetCustomizationValue("tools.retryLimit");
    await run("tools.resetCounters");
  }
});

test("tools.retryBackoff changes the wait schedule between retries", async () => {
  try {
    await run("tools.resetCounters");
    setCustomizationValue("tools.retryLimit", 3);
    const schedule = async (): Promise<unknown> =>
      (await run("tools.invoke", { failAttempts: 3, latencyMs: 10 })).retryDelaysMs;

    setCustomizationValue("tools.retryBackoff", "fixed");
    assert.deepEqual(await schedule(), [10, 10, 10], "the same wait every time");
    setCustomizationValue("tools.retryBackoff", "linear");
    assert.deepEqual(await schedule(), [10, 20, 30], "growing steadily");
    setCustomizationValue("tools.retryBackoff", "exponential");
    assert.deepEqual(await schedule(), [10, 20, 40], "doubling each time");
  } finally {
    resetCustomizationValue("tools.retryBackoff");
    resetCustomizationValue("tools.retryLimit");
    await run("tools.resetCounters");
  }
});

test("tools.propagateErrors decides whether the caller is told what went wrong", async () => {
  try {
    await run("tools.resetCounters");
    setCustomizationValue("tools.retryLimit", 0);
    setCustomizationValue("tools.propagateErrors", true);
    const reported = await run("tools.invoke", { succeed: false });
    assert.equal(reported.error, "failed after 1 attempts");
    assert.ok(!("swallowed" in reported));

    setCustomizationValue("tools.propagateErrors", false);
    const swallowed = await run("tools.invoke", { succeed: false });
    assert.ok(!("error" in swallowed), "a swallowed failure tells the caller nothing");
    assert.equal(swallowed.swallowed, true);
  } finally {
    resetCustomizationValue("tools.propagateErrors");
    resetCustomizationValue("tools.retryLimit");
    await run("tools.resetCounters");
  }
});

test("tools.failClosed decides whether a final failure stops the operation", async () => {
  try {
    await run("tools.resetCounters");
    setCustomizationValue("tools.retryLimit", 0);
    setCustomizationValue("tools.failClosed", true);
    assert.equal((await run("tools.invoke", { succeed: false })).raised, true);
    setCustomizationValue("tools.failClosed", false);
    assert.equal(
      (await run("tools.invoke", { succeed: false })).raised,
      false,
      "failing open passes the failure along as a result instead of raising",
    );
  } finally {
    resetCustomizationValue("tools.failClosed");
    resetCustomizationValue("tools.retryLimit");
    await run("tools.resetCounters");
  }
});

test("tools.recordInputs + recordOutputs decide what a call records", async () => {
  try {
    await run("tools.resetCounters");
    setCustomizationValue("tools.recordInputs", false);
    setCustomizationValue("tools.recordOutputs", false);
    const bare = await run("tools.invoke", { input: "the request", output: "the reply" });
    assert.deepEqual(bare.record, {}, "nothing is recorded unless recording is on");
    assert.equal(readSignal("tools.lastCallRecord"), "succeeded=true");

    setCustomizationValue("tools.recordInputs", true);
    const withInput = await run("tools.invoke", { input: "the request", output: "the reply" });
    assert.deepEqual(withInput.record, { input: "the request" });

    setCustomizationValue("tools.recordOutputs", true);
    const both = await run("tools.invoke", { input: "the request", output: "the reply" });
    assert.deepEqual(both.record, { input: "the request", output: "the reply" });
    assert.equal(readSignal("tools.lastCallRecord"), "succeeded=true input=the request output=the reply");
  } finally {
    resetCustomizationValue("tools.recordInputs");
    resetCustomizationValue("tools.recordOutputs");
    await run("tools.resetCounters");
  }
});

// ---------------------------------------------------------------------------
// search — seven dead stores, now read by query
// ---------------------------------------------------------------------------

/** Three exact matches plus one near-miss, so ordering rules differ visibly. */
const CANDIDATES = "alphaOne:0.5:ts,alphaTwo:0.9:ts,alphaThree:0.7:ts,alphx:0.95:ts";

/** Query with a freshly built index, so a rebuild never confuses the subject. */
async function query(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  searchState.indexBuiltAt = Date.now();
  return run("search.query", { text: "alpha", ...args });
}

test("search.indexFreshness decides whether a query rebuilds the index first", async () => {
  try {
    searchState.indexBuiltAt = Date.now() - 10_000;
    setCustomizationValue("search.indexFreshness", 300);
    const fresh = await run("search.query", { text: "alpha" });
    assert.equal(fresh.reindexed, false, "a 10-second-old index is inside a 300-second shelf life");

    searchState.indexBuiltAt = Date.now() - 10_000;
    setCustomizationValue("search.indexFreshness", 1);
    const beforeVersion = Number(readSignal("search.indexVersion"));
    const stale = await run("search.query", { text: "alpha" });
    assert.equal(stale.reindexed, true, "a shorter shelf life makes the same index stale");
    assert.equal(Number(readSignal("search.indexVersion")), beforeVersion + 1);
  } finally {
    resetCustomizationValue("search.indexFreshness");
    await run("search.resetCounters");
  }
});

test("search.queryTimeout abandons a query whose work exceeds the limit", async () => {
  try {
    setCustomizationValue("search.queryTimeout", 100);
    const abandoned = await query({ candidates: CANDIDATES, workMs: 500 });
    assert.equal(abandoned.timedOut, true);
    assert.equal(abandoned.results, 0, "an abandoned query returns nothing, not a partial list");

    setCustomizationValue("search.queryTimeout", 60000);
    const completed = await query({ candidates: CANDIDATES, workMs: 500 });
    assert.equal(completed.timedOut, false);
    assert.ok(Number(completed.results) > 0);
  } finally {
    resetCustomizationValue("search.queryTimeout");
    await run("search.resetCounters");
  }
});

test("search.caseSensitive decides whether capitalisation separates two terms", async () => {
  try {
    setCustomizationValue("search.caseSensitive", false);
    const folded = await query({ candidates: "Alpha:0.9:ts,alpha:0.9:ts" });
    assert.deepEqual(folded.names, ["Alpha", "alpha"], "capitalisation ignored — both match");

    setCustomizationValue("search.caseSensitive", true);
    const exact = await query({ candidates: "Alpha:0.9:ts,alpha:0.9:ts" });
    assert.deepEqual(exact.names, ["alpha"], "'Alpha' and 'alpha' are now different terms");
  } finally {
    resetCustomizationValue("search.caseSensitive");
    await run("search.resetCounters");
  }
});

test("search.fuzzyThreshold decides whether a near-miss still counts as a match", async () => {
  try {
    // "alphx" shares 4 of the 5 characters of "alpha" as a leading run: 0.8.
    setCustomizationValue("search.fuzzyThreshold", 0.85);
    assert.deepEqual((await query({ candidates: "alphx:0.9:ts" })).names, [], "0.8 is not close enough");
    setCustomizationValue("search.fuzzyThreshold", 0.75);
    assert.deepEqual((await query({ candidates: "alphx:0.9:ts" })).names, ["alphx"], "a looser strictness admits it");
  } finally {
    resetCustomizationValue("search.fuzzyThreshold");
    await run("search.resetCounters");
  }
});

test("search.languageFilter restricts a search to one language", async () => {
  try {
    setCustomizationValue("search.languageFilter", "");
    const everything = await query({ candidates: "alphaOne:0.9:ts,alphaTwo:0.9:js" });
    assert.equal(everything.results, 2);

    setCustomizationValue("search.languageFilter", "ts");
    const restricted = await query({ candidates: "alphaOne:0.9:ts,alphaTwo:0.9:js" });
    assert.deepEqual(restricted.names, ["alphaOne"]);
  } finally {
    resetCustomizationValue("search.languageFilter");
    await run("search.resetCounters");
  }
});

test("search.threshold drops results below the minimum match score", async () => {
  try {
    setCustomizationValue("search.threshold", 0.5);
    assert.deepEqual((await query({ candidates: "alphaOne:0.9:ts,alphaTwo:0.3:ts" })).names, ["alphaOne"]);
    setCustomizationValue("search.threshold", 0.2);
    assert.equal((await query({ candidates: "alphaOne:0.9:ts,alphaTwo:0.3:ts" })).results, 2);
  } finally {
    resetCustomizationValue("search.threshold");
    await run("search.resetCounters");
  }
});

test("search.maxResults stops a search after that many results", async () => {
  try {
    setCustomizationValue("search.fuzzyThreshold", 0.75);
    setCustomizationValue("search.maxResults", 50);
    assert.equal((await query({ candidates: CANDIDATES })).results, 4);
    setCustomizationValue("search.maxResults", 2);
    assert.equal((await query({ candidates: CANDIDATES })).results, 2, "a tighter cap returns a shorter list");
  } finally {
    resetCustomizationValue("search.maxResults");
    resetCustomizationValue("search.fuzzyThreshold");
    await run("search.resetCounters");
  }
});

test("search.sortBy changes the order results come back in", async () => {
  try {
    setCustomizationValue("search.fuzzyThreshold", 0.75);
    setCustomizationValue("search.sortBy", "relevance");
    assert.deepEqual(
      (await query({ candidates: CANDIDATES })).names,
      ["alphaTwo", "alphaThree", "alphaOne", "alphx"],
      "best match first: exact matches ahead of the near-miss, then by score",
    );

    setCustomizationValue("search.sortBy", "score");
    assert.deepEqual(
      (await query({ candidates: CANDIDATES })).names,
      ["alphx", "alphaTwo", "alphaThree", "alphaOne"],
      "raw score only: the near-miss with the top score leads",
    );

    setCustomizationValue("search.sortBy", "recency");
    assert.deepEqual(
      (await query({ candidates: CANDIDATES })).names,
      ["alphx", "alphaThree", "alphaTwo", "alphaOne"],
      "newest first: the most recently indexed document leads",
    );
  } finally {
    resetCustomizationValue("search.sortBy");
    resetCustomizationValue("search.fuzzyThreshold");
    await run("search.resetCounters");
  }
});

// ---------------------------------------------------------------------------
// The fresh probe: nothing inert remains in the served modules
// ---------------------------------------------------------------------------

test("fresh probe: the web-side quarantine is fully resolved (wired or removed)", () => {
  const registered = new Set(listCustomizations().map((c) => c.id));
  for (const id of QUARANTINED) {
    if ((REMOVED_FOR_ABSENT_CAPABILITY as readonly string[]).includes(id)) {
      assert.ok(!registered.has(id), `${id} must NOT be registered: the capability does not exist`);
    } else {
      assert.ok(registered.has(id), `${id} must still be registered (it was wired, not removed)`);
    }
  }
  for (const id of REMOVED_FOR_ABSENT_CAPABILITY) {
    assert.ok(!registered.has(id), `${id} was removed for absent capability and must stay unregistered`);
  }
});

test("fresh probe: every customization in the served modules round-trips through set/current", () => {
  const failures: string[] = [];
  for (const customization of listCustomizations()) {
    if (!(MODULES as readonly string[]).includes(customization.module)) continue;
    const original = customization.current();
    let alternative: number | string | boolean | undefined;
    switch (customization.type) {
      case "number": {
        const min = customization.min ?? (original as number) - 1;
        const max = customization.max ?? (original as number) + 1;
        alternative = [min, max, (min + max) / 2].find((v) => v !== original);
        break;
      }
      case "boolean":
        alternative = !(original as boolean);
        break;
      case "enum":
        alternative = (customization.enum ?? []).find((v) => v !== original);
        break;
      case "string":
        // Append a new element in canonical CSV form (the string-typed
        // customizations here are comma-separated sets; a canonical value
        // round-trips exactly).
        alternative = String(original) === "" ? "probe" : `${String(original)},probe`;
        break;
      default:
        break;
    }
    if (alternative === undefined) {
      failures.push(`${customization.id}: contract admits no second legal value`);
      continue;
    }
    setCustomizationValue(customization.id, alternative);
    if (JSON.stringify(customization.current()) !== JSON.stringify(alternative)) {
      failures.push(`${customization.id}: set ${JSON.stringify(alternative)}, read back ${JSON.stringify(customization.current())}`);
    }
    setCustomizationValue(customization.id, original);
  }
  assert.deepEqual(failures, [], `inert controls found:\n${failures.join("\n")}`);
});

test("fresh probe: no no-op setters or constant `current` literals remain in the served registration files", () => {
  const registrationsDir = new URL("../../src/shared/exposure/registrations/", import.meta.url);
  for (const module of MODULES) {
    const source = readFileSync(new URL(`${module}.ts`, registrationsDir), "utf8");
    assert.ok(!/set:\s*\(\)\s*=>\s*\{\s*\/\*/.test(source), `${module}.ts still contains a no-op setter`);
    assert.ok(!/current:\s*\(\)\s*=>\s*(\d|true\b|false\b|")/.test(source), `${module}.ts still contains a constant current()`);
  }
});

test("fresh probe: every customization value in the served modules is READ by its module (no dead stores)", () => {
  // Structural check: for each registered customization, the state field its
  // getter reads must ALSO be referenced somewhere in the module's
  // signals/actions/helpers — i.e. BEFORE the `--- Customizations` marker.
  // A field only its own getter/setter touches is a dead store: the value
  // persists but influences nothing.
  const registrationsDir = new URL("../../src/shared/exposure/registrations/", import.meta.url);
  const stateNames: Record<string, string> = {
    memory: "memoryState",
    awareness: "awarenessState",
    safety: "safetyState",
    learning: "learningState",
    context: "contextState",
    hallucination: "hallucinationState",
    bias: "biasState",
    editor: "editorState",
    quality: "qualityState",
    tools: "toolsState",
    search: "searchState",
  };
  const failures: string[] = [];
  for (const customization of listCustomizations()) {
    const module = customization.module;
    if (!(MODULES as readonly string[]).includes(module)) continue;
    const source = readFileSync(new URL(`${module}.ts`, registrationsDir), "utf8");
    const markerIndex = source.indexOf("--- Customizations");
    assert.ok(markerIndex > 0, `${module}.ts must have a Customizations section marker`);
    const behaviourSource = source.slice(0, markerIndex);
    // Find the state field the getter reads, e.g. `current: () => memoryState.maxCorrupted`.
    const getterMatch = new RegExp(
      `id: "${customization.id.replace(".", "\\.")}"[\\s\\S]{0,600}?current: \\(\\) => (?:Array\\.from\\()?${stateNames[module]}\\.([A-Za-z]+)`,
    ).exec(source);
    if (!getterMatch) {
      // A config-direct knob has no per-process state field: `current` reads
      // the document and the live consumer reads the same path. The dead-store
      // probe is about stub state that no signal or action touches.
      if (customization.configPath !== undefined) continue;
      failures.push(`${customization.id}: current() does not read module state`);
      continue;
    }
    const field = getterMatch[1]!;
    if (!behaviourSource.includes(`${stateNames[module]}.${field}`)) {
      failures.push(`${customization.id}: ${stateNames[module]}.${field} is stored but never read by a signal, action, or helper`);
    }
  }
  assert.deepEqual(failures, [], `dead-store customizations found:\n${failures.join("\n")}`);
});
