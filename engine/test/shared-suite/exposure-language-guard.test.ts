import assert from "node:assert/strict";
import test from "node:test";

import {
  clearAll,
  countCustomizations,
  customizationLanguageViolation,
  customizationUnitViolation,
  getSignal,
  LANGUAGE_ENFORCED_MODULES,
  listCustomizations,
  listSignals,
  listCustomizationsMeasuredBy,
  registerCustomization,
  registerSignal,
  resolveContract,
  validateSignalAbnormal,
  type Customization,
} from "../../src/shared/exposure/index.ts";
import {
  createEngineCustomizationConfigStore,
  installCustomizationConfigStore,
} from "../../src/shared/exposure/config-binding.ts";
import {
  registerAllExposure,
  registeredModuleNames,
  resetAllRegistrations,
} from "../../src/shared/exposure/registrations/index.ts";

/**
 * SERVED-LANGUAGE GUARD + REGISTRATION ENRICHMENT — mutation-tested.
 *
 * Every clause of the language guard, the measuredBy validation, and the
 * signal `abnormal` validation has a mutant here that MUST be rejected and a
 * compliant twin that MUST pass, so deleting any clause fails a named test.
 * The sweep at the bottom freezes the honest enrichment shape of the live 80:
 * effect timing is declared exactly where consuming code was verified, and
 * every declared measurement linkage resolves.
 */

/** A compliant customization in an ENFORCED module, overridable per test. */
function enforcedCustomization(overrides: Partial<Customization>): Customization {
  let current = 5;
  return {
    id: "search.probeKnob",
    module: "search",
    name: "How many probes run at once",
    description: "How many probe operations may run at the same time. Higher = more parallel work.",
    type: "number",
    default: 5,
    min: 0,
    max: 10,
    current: () => current,
    set: (v) => { current = Number(v); },
    ...overrides,
  } as Customization;
}

test("language guard: a compliant registration in an enforced module passes", () => {
  clearAll();
  try {
    assert.doesNotThrow(() => registerCustomization(enforcedCustomization({})));
  } finally {
    clearAll();
  }
});

test("language guard mutation: a Title-Cased id as name is rejected (full id and tail)", () => {
  clearAll();
  try {
    assert.throws(
      () => registerCustomization(enforcedCustomization({ name: "Search Probe Knob" })),
      /restates the id/,
      "the full id Title-Cased must be rejected",
    );
    assert.throws(
      () => registerCustomization(enforcedCustomization({ name: "Probe Knob" })),
      /restates the id/,
      "the id tail Title-Cased must be rejected",
    );
  } finally {
    clearAll();
  }
});

test("language guard mutation: a label-length description is rejected", () => {
  clearAll();
  try {
    assert.throws(
      () => registerCustomization(enforcedCustomization({ description: "Probe concurrency limit." })),
      /consequence description needs at least/,
    );
  } finally {
    clearAll();
  }
});

test("language guard mutation: leading jargon is rejected; the same term in a parenthetical passes", () => {
  clearAll();
  try {
    assert.throws(
      () =>
        registerCustomization(
          enforcedCustomization({
            description: "The BM25 score threshold below which probe results are dropped entirely.",
          }),
        ),
      /implementation vocabulary/,
    );
    assert.doesNotThrow(() =>
      registerCustomization(
        enforcedCustomization({
          description:
            "Probe results scoring below this are dropped (the underlying relevance score is BM25).",
        }),
      ),
    );
  } finally {
    clearAll();
  }
});

test("language guard mutation: internal unit tokens and non-plain units are rejected", () => {
  clearAll();
  try {
    assert.throws(
      () => registerCustomization(enforcedCustomization({ unit: "ms" })),
      /internal shorthand/,
    );
    assert.throws(
      () => registerCustomization(enforcedCustomization({ unit: "Milliseconds" })),
      /printable plain word/,
    );
    assert.doesNotThrow(() => registerCustomization(enforcedCustomization({ unit: "milliseconds" })));
  } finally {
    clearAll();
  }
});

test("language guard scope: a non-enforced (test/legacy) module is not language-checked", () => {
  clearAll();
  try {
    assert.ok(!LANGUAGE_ENFORCED_MODULES.has("demo"), "test modules must not be enforced");
    let current = 1;
    assert.doesNotThrow(() =>
      registerCustomization({
        id: "demo.knob",
        module: "demo",
        name: "Knob",
        description: "Knob.",
        type: "number",
        default: 1,
        current: () => current,
        set: (v) => { current = Number(v); },
      }),
    );
  } finally {
    clearAll();
  }
});

test("language guard scope: every customization-serving module served by registerAllExposure is enforced", () => {
  // The guard's subject is the SETTINGS surface — the customizations a module
  // serves. A signals-only module (one whose readings have no knob to
  // word) contributes nothing to that surface, so there is nothing to
  // language-check; requiring it in the enforced set would force a dead store
  // (a control that changes nothing) just to satisfy the list. The covered
  // universe is therefore the modules that ACTUALLY serve a customization,
  // derived from the live registry rather than a hand list — and the enforced
  // set must cover every one of them.
  resetAllRegistrations();
  registerAllExposure();
  try {
    const serving = new Set(listCustomizations().map((c) => c.module));
    // Non-vacuity: the registry must serve customizations for this to mean
    // anything, and at least one served module must be a customization server.
    assert.ok(serving.size > 0, "no module served a customization — the coverage check would be vacuous");
    for (const module of serving) {
      assert.ok(
        LANGUAGE_ENFORCED_MODULES.has(module),
        `customization-serving module "${module}" is not language-enforced — a served control must not dodge the guard`,
      );
    }
    // And the reverse: a module in the enforced set must actually serve
    // customizations, or the enforcement claim is pointed at nothing.
    for (const module of LANGUAGE_ENFORCED_MODULES) {
      assert.ok(
        serving.has(module),
        `language-enforced module "${module}" serves no customization — the enforcement is pointed at an empty surface`,
      );
    }
  } finally {
    resetAllRegistrations();
  }
});

test("measuredBy mutation: a dangling signal id is rejected in ANY module; a real one passes", () => {
  clearAll();
  try {
    // Non-enforced module: the language rules are skipped but the linkage is
    // still deny-by-default.
    let current = true;
    const base = {
      id: "demo.flag",
      module: "demo",
      name: "Flag",
      description: "Flag.",
      type: "boolean" as const,
      default: true,
      current: () => current,
      set: (v: unknown) => { current = Boolean(v); },
    };
    assert.throws(
      () => registerCustomization({ ...base, measuredBy: "demo.noSuchSignal" }),
      /not a registered signal/,
    );
    registerSignal({
      id: "demo.flagMirror",
      module: "demo",
      name: "Flag Mirror",
      description: "Mirrors the flag.",
      type: "boolean",
      value: () => current,
    });
    assert.doesNotThrow(() => registerCustomization({ ...base, measuredBy: "demo.flagMirror" }));
    assert.deepEqual(
      listCustomizationsMeasuredBy("demo.flagMirror").map((c) => c.id),
      ["demo.flag"],
      "the inverse signal→customization lookup must resolve the declared linkage",
    );
  } finally {
    clearAll();
  }
});

test("signal abnormal mutation: non-numeric type, empty block, and inverted bounds are rejected", () => {
  assert.throws(
    () => validateSignalAbnormal("demo.s", "boolean", { warnAbove: 0 }),
    /not numeric/,
  );
  assert.throws(() => validateSignalAbnormal("demo.s", "gauge", {}), /empty abnormal block/);
  assert.throws(
    () => validateSignalAbnormal("demo.s", "gauge", { warnAbove: 1, warnBelow: 2 }),
    /inverted/,
  );
  assert.throws(
    () => validateSignalAbnormal("demo.s", "gauge", { warnAbove: Number.NaN }),
    /finite/,
  );
  assert.doesNotThrow(() => validateSignalAbnormal("demo.s", "counter", { warnAbove: 0 }));
  // And the choke point: registration itself rejects the mutant.
  clearAll();
  try {
    assert.throws(() =>
      registerSignal({
        id: "demo.badBounds",
        module: "demo",
        name: "Bad Bounds",
        description: "Boolean with bounds.",
        type: "boolean",
        abnormal: { warnAbove: 0 },
        value: () => true,
      }),
    );
  } finally {
    clearAll();
  }
});

test("pure validators: violation functions return null on good input, a reason on bad", () => {
  assert.equal(customizationUnitViolation("tokens"), null);
  assert.match(customizationUnitViolation("num") ?? "", /internal shorthand/);
  assert.equal(
    customizationLanguageViolation({
      id: "search.threshold",
      name: "Minimum match score",
      description: "Search results scoring below this are dropped from every result list you see.",
    }),
    null,
  );
  assert.match(
    customizationLanguageViolation({
      id: "search.threshold",
      name: "Search Threshold",
      description: "Search results scoring below this are dropped from every result list you see.",
    }) ?? "",
    /restates the id/,
  );
});

// ---------------------------------------------------------------------------
// The enrichment sweep, over whatever the registry actually serves.
//
// This sweep used to pin the surface at a written-out 80 in three places,
// including its own title. The privacy module registers one control per PII
// type in a loop, so the surface GROWS whenever the PII registry gains an
// entry — and it did, twice, while the number here stayed 80. The file went
// red and stayed red across several commits, because the number that failed
// was bookkeeping rather than an invariant, and a failure nobody can act on
// is a failure everybody scrolls past.
//
// What actually matters is asserted below, over the live set: every served
// control declares an effect that matches whether a consumer was verified,
// the undeclared list is empty, and the sweep is not running over nothing.
// Adding a PII type no longer breaks this file; removing a control's
// consumer still does.
// ---------------------------------------------------------------------------

/**
 * Controls whose stored value is consumed by NO behaviour in the current
 * stubs. Their effect timing would be genuinely unverifiable from code, so it
 * would stay undeclared.
 *
 * The list is now EMPTY. It held 24 dead stores — the whole of the four
 * modules the earlier inert-control sweep never covered (editor, quality,
 * tools, search): the setter worked and the value survived, but no code path
 * read it, which is the same lie about capability as a no-op setter, one
 * level deeper. All 24 were wired into their module's real behaviour and are
 * proved behaviourally in `exposure-customization-liveness.test.ts` (set →
 * execute the module operation → observe a DIFFERENT outcome → restore).
 * Keeping the list (rather than deleting it) is what makes a regression
 * loud: a control that loses its consumer must be re-listed here
 * consciously, and the count assertion below fails until it is.
 */
const HONESTLY_UNDECLARED: readonly string[] = [];

/**
 * Controls whose declared effect is NON-immediate on purpose — the consumer
 * provably re-reads the value at a boundary the name describes. A knob whose
 * consumer resolves the config at each run's setup honestly declares
 * "next-run", not "immediate"; requiring "immediate" would force a lie about
 * the timing. Membership is earned by an independent wiring proof
 * (`safety-runtime-wired.test.ts` drives `pause_answer_timeout` from this
 * knob through the real executor), and each entry names its consumer so a new
 * non-immediate knob without one is refused by the sweep below. This set is
 * the honest-timing counterpart to HONESTLY_UNDECLARED: it exists so the sweep
 * can require BOTH "verified consumption" AND "the declared timing matches how
 * the consumer actually reads", instead of collapsing both to "immediate".
 */
const VERIFIED_NON_IMMEDIATE: ReadonlyMap<string, string> = new Map([
  [
    "mcp.retryCount",
    "server/integrations/mcp-runtime-bridge.ts freezes the MCP module defaults into each connection when the registry is built (mcpClientFactoryOptions / resolveConfiguredMcpServers at buildAndStartRegistry); a changed default moves configFingerprint and the NEXT use rebuilds the connections, so the honest timing is the next connection (next-run); tests/unit/mcp-servers-route.test.ts proves the rebuild on a config change",
  ],
  [
    "mcp.retryBackoff",
    "server/integrations/mcp-runtime-bridge.ts freezes the MCP module defaults into each connection when the registry is built (mcpClientFactoryOptions / resolveConfiguredMcpServers at buildAndStartRegistry); a changed default moves configFingerprint and the NEXT use rebuilds the connections, so the honest timing is the next connection (next-run); tests/unit/mcp-servers-route.test.ts proves the rebuild on a config change",
  ],
  [
    "mcp.timeout",
    "server/integrations/mcp-runtime-bridge.ts freezes the MCP module defaults into each connection when the registry is built (mcpClientFactoryOptions / resolveConfiguredMcpServers at buildAndStartRegistry); a changed default moves configFingerprint and the NEXT use rebuilds the connections, so the honest timing is the next connection (next-run); tests/unit/mcp-servers-route.test.ts proves the rebuild on a config change",
  ],
  [
    "mcp.closeGraceMs",
    "server/integrations/mcp-runtime-bridge.ts freezes the MCP module defaults into each connection when the registry is built (mcpClientFactoryOptions / resolveConfiguredMcpServers at buildAndStartRegistry); a changed default moves configFingerprint and the NEXT use rebuilds the connections, so the honest timing is the next connection (next-run); tests/unit/mcp-servers-route.test.ts proves the rebuild on a config change",
  ],
  [
    "mcp.sseReconnectMs",
    "server/integrations/mcp-runtime-bridge.ts freezes the MCP module defaults into each connection when the registry is built (mcpClientFactoryOptions / resolveConfiguredMcpServers at buildAndStartRegistry); a changed default moves configFingerprint and the NEXT use rebuilds the connections, so the honest timing is the next connection (next-run); tests/unit/mcp-servers-route.test.ts proves the rebuild on a config change",
  ],
  [
    "mcp.sseRetryMaxMs",
    "server/integrations/mcp-runtime-bridge.ts freezes the MCP module defaults into each connection when the registry is built (mcpClientFactoryOptions / resolveConfiguredMcpServers at buildAndStartRegistry); a changed default moves configFingerprint and the NEXT use rebuilds the connections, so the honest timing is the next connection (next-run); tests/unit/mcp-servers-route.test.ts proves the rebuild on a config change",
  ],
  [
    "mcp.resumeAttempts",
    "server/integrations/mcp-runtime-bridge.ts freezes the MCP module defaults into each connection when the registry is built (mcpClientFactoryOptions / resolveConfiguredMcpServers at buildAndStartRegistry); a changed default moves configFingerprint and the NEXT use rebuilds the connections, so the honest timing is the next connection (next-run); tests/unit/mcp-servers-route.test.ts proves the rebuild on a config change",
  ],
  [
    "mcp.serverRequestBacklog",
    "server/integrations/mcp-runtime-bridge.ts freezes the MCP module defaults into each connection when the registry is built (mcpClientFactoryOptions / resolveConfiguredMcpServers at buildAndStartRegistry); a changed default moves configFingerprint and the NEXT use rebuilds the connections, so the honest timing is the next connection (next-run); tests/unit/mcp-servers-route.test.ts proves the rebuild on a config change",
  ],
  [
    "mcp.stderrLinesPerSecond",
    "server/integrations/mcp-runtime-bridge.ts freezes the MCP module defaults into each connection when the registry is built (mcpClientFactoryOptions / resolveConfiguredMcpServers at buildAndStartRegistry); a changed default moves configFingerprint and the NEXT use rebuilds the connections, so the honest timing is the next connection (next-run); tests/unit/mcp-servers-route.test.ts proves the rebuild on a config change",
  ],
  [
    "mcp.stderrTailBytes",
    "server/integrations/mcp-runtime-bridge.ts freezes the MCP module defaults into each connection when the registry is built (mcpClientFactoryOptions / resolveConfiguredMcpServers at buildAndStartRegistry); a changed default moves configFingerprint and the NEXT use rebuilds the connections, so the honest timing is the next connection (next-run); tests/unit/mcp-servers-route.test.ts proves the rebuild on a config change",
  ],
  [
    "network.userPrivateAddresses",
    "server/llm/providers.ts reads privateAddressesAllowedFor at each credential mint (mintCredential / credentialForDiscovery) and stamps the rule on the credential; an llm-bridge client already built for a provider keeps the rule it was minted with, so the honest timing is next-run; tests/unit/provider-destination-rule.test.ts proves the mint consumes it (admin allow lets a non-admin reach a private address)",
  ],
  [
    "safety.pauseAskWaitTimeoutMs",
    "server/run/run-executor.ts resolves safety.eventFeed.pauseAskWaitTimeoutMs into each run's safetyRuntime at run setup (next-run), and tests/prevention/safety-runtime-wired.test.ts proves the pause_answer_timeout path consumes it",
  ],
  [
    "safety.gatePartialArgumentMemory",
    "server/safety/safety-bridge.ts resolves safety.toolCallGate once per run into the per-run gate instance (createRunSafetyGate → getSafetyGateConfig, called at server/run/run-executor.ts run setup), and engine/test/safety/tool-call-gate.test.ts proves the gate's partial-argument memory consumes it",
  ],
  [
    "safety.gatePartialArgumentsLimit",
    "server/safety/safety-bridge.ts resolves safety.toolCallGate once per run into the per-run gate instance (createRunSafetyGate → getSafetyGateConfig, called at server/run/run-executor.ts run setup), and engine/test/safety/tool-call-gate.test.ts proves the retained-partials bound is enforced inside the gate",
  ],
  [
    "safety.gateBlockEscalationAfter",
    "server/safety/safety-bridge.ts resolves safety.toolCallGate once per run into the per-run gate instance (createRunSafetyGate → getSafetyGateConfig, called at server/run/run-executor.ts run setup), and engine/test/safety/tool-call-gate.test.ts proves the escalation counter consumes it inside the gate",
  ],
  [
    "safety.pauseAskEnabled",
    "server/safety/safety-runtime-bridge.ts resolves safety.eventFeed once per run into the safety runtime's pause-ask builder (createRunSafetyRuntime → getEventFeedSafetyConfig, called at server/run/run-executor.ts run setup), and engine/test/safety/pause-ask.test.ts proves buildPause consults it",
  ],
  [
    "safety.pauseAskMaxMessageLength",
    "server/safety/safety-runtime-bridge.ts resolves safety.eventFeed once per run into the safety runtime's pause-ask builder (createRunSafetyRuntime → getEventFeedSafetyConfig, called at server/run/run-executor.ts run setup), and engine/test/safety/pause-ask.test.ts proves the message cap is applied when the pause is built",
  ],
  [
    "performance.resourceSamplerEnabled",
    "server/observability/metrics-bridge.ts startResourceSampler resolves performance.resourceSampler.enabled once at server boot — a running sampler is never retrofitted with a new switch, so the honest timing is restart — and tests/unit/harness-config.test.ts proves the consumed accessor (resourceSamplerConfig) reads the config file live",
  ],
  [
    "performance.resourceSamplerIntervalMs",
    "server/observability/metrics-bridge.ts startResourceSampler resolves performance.resourceSampler.intervalMs once at server boot into the sampler timer and its registered anatomy facts, so the honest timing is restart; tests/unit/harness-config.test.ts proves the consumed accessor (resourceSamplerConfig) reads the config file live, with the declared default as the out-of-range fallback",
  ],
  [
    "intelligence.farmPerFileTimeoutMs",
    "server/intelligence/repository-map-worker.ts passes getFarmConfig().perFileTimeoutMs into generateRepositoryMapIsolated on the next map build",
  ],
  [
    "intelligence.farmInitTimeoutMs",
    "server/intelligence/repository-map-worker.ts passes getFarmConfig().initTimeoutMs into generateRepositoryMapIsolated on the next map build",
  ],
  [
    "intelligence.farmMaxInitFailures",
    "server/intelligence/repository-map-worker.ts passes getFarmConfig().maxInitFailures into generateRepositoryMapIsolated on the next map build",
  ],
  [
    "memory.contextTokenLimit",
    "server/context/context-bridge.ts resolves the memory section once per process (cachedUnifiedConfig, :130/:171-175) and bridges contextTokenLimit into every run's context-manager budget when the model declares no window (bridgedUnifiedOverrides :182-190, createRunContextManager :213-247; consumed at run.ts:276 and blocks/compose.ts:578-582), so the honest timing is restart; tests/unit/harness-config.test.ts proves the consumed accessor (getMemoryConfig) reads the config file",
  ],
  [
    "memory.contextTrimThreshold",
    "server/context/context-bridge.ts resolves the memory section once per process (cachedUnifiedConfig, :130/:171-175) and bridges trimThreshold into the run's context trim trigger (bridgedUnifiedOverrides :182-190), so the honest timing is restart; tests/unit/harness-config.test.ts proves the consumed accessor (getMemoryConfig) reads the config file",
  ],
  [
    "memory.recentTurnWindow",
    "server/context/context-bridge.ts resolves the memory section once per process (cachedUnifiedConfig, :130/:171-175) and bridges recentTurnWindow into the trimmer's verbatim recent-window keep (bridgedUnifiedOverrides :182-190), so the honest timing is restart; tests/unit/harness-config.test.ts proves the consumed accessor (getMemoryConfig) reads the config file",
  ],
  [
    "memory.summaryMaxTokens",
    "server/context/context-bridge.ts resolves the memory section once per process (cachedUnifiedConfig, :130/:171-175) and maps summaryMaxTokens onto the summarizer's token budget (bridgedUnifiedOverrides :182-190), so the honest timing is restart; tests/unit/harness-config.test.ts proves the consumed accessor (getMemoryConfig) reads the config file",
  ],
  [
    "memory.shortTermTurnLimit",
    "server/context/memory-bridge.ts creates the real memory store once per process with the resolved section (store singleton, :145-157) and engine/src/memory/memory-store.ts evicts short-term entries beyond shortTermTurnLimit (:290-292), so the honest timing is restart; tests/unit/harness-config.test.ts proves the consumed accessor (getMemoryConfig) reads the config file",
  ],
  [
    "memory.longTermFactLimit",
    "server/context/memory-bridge.ts creates the real memory store once per process with the resolved section (store singleton, :145-157) and engine/src/memory/memory-store.ts evicts long-term entries beyond longTermFactLimit (:297-299), so the honest timing is restart; tests/unit/harness-config.test.ts proves the consumed accessor (getMemoryConfig) reads the config file",
  ],
  [
    "memory.searchEngine",
    "server/context/memory-bridge.ts creates the real memory store once per process with the resolved section (store singleton, :145-157) and engine/src/memory/memory-store.ts resolves the search engine once at creation (:123), so the honest timing is restart; tests/unit/harness-config.test.ts proves the consumed accessor (getMemoryConfig) reads the config file",
  ],
  [
    "memory.contentMaxCharacters",
    "server/context/memory-bridge.ts creates the real memory store once per process with the resolved section (store singleton, :145-157) and engine/src/memory/memory-store.ts refuses content larger than contentMaxCharacters (:141-143), so the honest timing is restart; tests/unit/harness-config.test.ts proves the consumed accessor (getMemoryConfig) reads the config file",
  ],
  [
    "memory.maxTagsPerEntry",
    "server/context/memory-bridge.ts creates the real memory store once per process with the resolved section (store singleton, :145-157) and engine/src/memory/memory-store.ts refuses entries with more tags than maxTagsPerEntry (:151-153), so the honest timing is restart; tests/unit/harness-config.test.ts proves the consumed accessor (getMemoryConfig) reads the config file",
  ],
  [
    "memory.maxTopicCharacters",
    "server/context/memory-bridge.ts creates the real memory store once per process with the resolved section (store singleton, :145-157) and engine/src/memory/memory-store.ts refuses topics longer than maxTopicCharacters (:162-164), so the honest timing is restart; tests/unit/harness-config.test.ts proves the consumed accessor (getMemoryConfig) reads the config file",
  ],
  [
    "redaction.toolCallArgumentsCacheEntries",
    "server/llm/redaction.ts sizes the re-hiding store once at module evaluation (the LruCache at :294 is constructed from getToolCallArgumentsCacheEntries, server/kernel/harness-config.ts:1487-1491, which reads redaction.toolCallArgumentsCacheEntries from the config file), so a running process keeps its store size until restart — the honest timing is restart; tests/prevention/pii-redaction-owner.test.ts proves the store is bounded at the configured capacity with LRU eviction, and tests/unit/harness-config.test.ts proves the consumed accessor reads the config file through the real write gate",
  ],
  [
    "performance.benchmarkMinRepetitions",
    "engine/src/performance/benchmark-cli.ts resolves the performance section from the pinned config document once per command invocation (:98-109, a fresh process per run) and hands it to createBenchmarkRunner, which floors every target's cold and warm repetition counts at budgets.minBenchmarkRepetitions (benchmark-runner.ts:172, :285-287), so the honest timing is next-run; engine/test/performance/performance-hostile.test.ts proves the runner consumes the repetition bounds, and engine/test/workflow/harness-commands-cli-fixes.test.ts drives the real CLI door",
  ],
  [
    "performance.benchmarkMaxRepetitions",
    "engine/src/performance/benchmark-cli.ts resolves the performance section from the pinned config document once per command invocation (:98-109, a fresh process per run) and hands it to createBenchmarkRunner, which caps every target's repetition counts at budgets.maxBenchmarkRepetitions (benchmark-runner.ts:173, :288-290), so the honest timing is next-run; engine/test/performance/performance-hostile.test.ts proves the runner consumes the repetition bounds, and engine/test/workflow/harness-commands-cli-fixes.test.ts drives the real CLI door",
  ],
  [
    "performance.benchmarkMaxDurationMs",
    "engine/src/performance/benchmark-cli.ts resolves the performance section from the pinned config document once per command invocation (:98-109, a fresh process per run) and hands it to createBenchmarkRunner, which stops adding repetitions for a target once it has run past budgets.maxBenchmarkDurationMs (benchmark-runner.ts:174, :291-293), so the honest timing is next-run; engine/test/performance/performance-hostile.test.ts proves the runner consumes the duration bound, and engine/test/workflow/harness-commands-cli-fixes.test.ts drives the real CLI door",
  ],
  [
    "performance.diagnosticModeTimeoutMs",
    "engine/src/performance/diagnostic-cli.ts resolves the performance section from the pinned config document once per command invocation (:69-79, a fresh process per run) and hands it to createDiagnosticRunner, which arms each mode's timeout from diagnosticModes.modeTimeoutMs (diagnostic-modes.ts:129, :146-149) and reports the mode as timed out when it fires, so the honest timing is next-run; engine/test/performance/diagnostic-modes.test.ts proves the runner consumes the timeout, and engine/test/workflow/harness-commands-cli-fixes.test.ts drives the real CLI door",
  ],
  [
    "workspaceGit.timeoutsInspectMs",
    "engine/src/workflow/workspace-cli.ts resolves the workspaceGit section from the pinned config document once per command invocation (runWorkspaceCli, a fresh process per `harness workspace` run) and threads timeouts.inspectMs into every workspace-manager inspection — the worktree's HEAD and tree (revParse), its status (status), the changed set (diffNameOnly), the registry's common dir and the checkout's top level — so the honest timing is next-run; engine/test/workflow/harness-commands-timeouts.test.ts proves the section's pinned-file timeout resolution contract",
  ],
  [
    "workspaceGit.timeoutsAddMs",
    "engine/src/workflow/workspace-cli.ts resolves the workspaceGit section from the pinned config document once per command invocation (runWorkspaceCli) and threads timeouts.addMs into the worktree operations — worktreeAdd/worktreeAddDetached at create, worktreeRemove/worktreeLock/worktreeUnlock at abort, sweep and teardown, and the land (mergeFfOnly, updateRef) — so the honest timing is next-run; engine/test/workflow/harness-commands-timeouts.test.ts proves the resolution reads the configured addMs from the pinned file",
  ],
  [
    "workspaceGit.timeoutsCommitMs",
    "engine/src/workflow/workspace-cli.ts resolves the workspaceGit section from the pinned config document once per command invocation (runWorkspaceCli) and threads timeouts.commitMs into the workspace merge commit (workspace-manager.ts merge: git.commit, whose hooks run the commit guard), so the honest timing is next-run; engine/test/workflow/harness-commands-timeouts.test.ts proves the resolution reads the configured commitMs from the pinned file",
  ],
  [
    "testExecution.serialPhaseConcurrency",
    "engine/src/workflow/test-result-collector.ts resolves the testExecution section from the pinned config document once per runner invocation (readTestExecutionConfig :318-353) and threads serialPhaseConcurrency into the serial phase's tier scheduling (:333, consumed by buildSerialPhases), so the honest timing is next-run; engine/test/workflow/test-execution-config.test.ts drives the real harness-test door consuming the section",
  ],
  [
    "testExecution.fullSuiteSerialPhaseConcurrency",
    "engine/src/workflow/test-result-collector.ts resolves the testExecution section from the pinned config document once per runner invocation (readTestExecutionConfig :318-353) and threads fullSuiteSerialPhaseConcurrency into the full suite's subprocess-spawning serial tier (:334), so the honest timing is next-run; engine/test/workflow/test-execution-config.test.ts drives the real harness-test door consuming the section",
  ],
  [
    "testExecution.fullSuiteInProcessSerialPhaseConcurrency",
    "engine/src/workflow/test-result-collector.ts resolves the testExecution section from the pinned config document once per runner invocation (readTestExecutionConfig :318-353) and threads fullSuiteInProcessSerialPhaseConcurrency into the full suite's in-process serial tier (:335), so the honest timing is next-run; engine/test/workflow/test-execution-config.test.ts drives the real harness-test door consuming the section",
  ],
  [
    "testExecution.fullSuiteParallelConcurrency",
    "engine/src/workflow/test-result-collector.ts resolves the testExecution section from the pinned config document once per runner invocation (readTestExecutionConfig :318-353) and threads fullSuiteParallelConcurrency into the full suite's parallel phase lane count (:330-331), so the honest timing is next-run; engine/test/workflow/test-execution-config.test.ts drives the real harness-test door consuming the section",
  ],
  [
    "harnessCommands.lockTimeoutMs",
    "engine/src/workflow/harness-commands.ts resolves the resourceLock section from the pinned config document once per command invocation (resolveLockOptions :1305-1312, a fresh process per run) and hands timeoutMs to the shared lock the harness-test door holds (:527), so the honest timing is next-run; engine/test/workflow/resource-lock.test.ts proves the lock machinery consumes its acquire options",
  ],
  [
    "harnessCommands.lockPollIntervalMs",
    "engine/src/workflow/harness-commands.ts resolves the resourceLock section from the pinned config document once per command invocation (resolveLockOptions :1305-1312) and hands pollIntervalMs to the shared lock the harness-test door holds (:527), so the honest timing is next-run; engine/test/workflow/resource-lock.test.ts proves the lock machinery consumes its acquire options",
  ],
  [
    "harnessCommands.lockStaleMs",
    "engine/src/workflow/harness-commands.ts resolves the resourceLock section from the pinned config document once per command invocation (resolveLockOptions :1305-1312) and hands staleMs to the shared lock the harness-test door holds (:527) as its unreadable-lock bound (unreadableAfterMs: a live holder is never taken over), so the honest timing is next-run; engine/test/workflow/resource-lock.test.ts proves the lock machinery consumes its acquire options",
  ],
  [
    "harnessCommands.subprocessCpuBudgetMs",
    "engine/src/workflow/workflow-config.ts subprocessBounds resolves harness.subprocessBounds.cpuBudgetMs from the pinned config document (configuredSubprocessBounds, once per command invocation; the commit guard reads its pinned document per commit), and every consumer hands it to the ONE bounded run (runCpuBounded, src/process/supervised-run.ts): runScriptSubprocess and runTypecheck (harness-commands.ts, each `harness sync`/`check` a fresh process), the commit guard's compile legs, and the instrument lock's admitted run (the kernel CPU limit it derives), so the honest timing is next-run; engine/test/workflow/harness-commands-cli-fixes.test.ts drives each bound through runScriptSubprocess and engine/test/workflow/harness-commands-timeouts.test.ts proves the configured value is the one resolved",
  ],
  [
    "harnessCommands.subprocessStallMs",
    "engine/src/workflow/workflow-config.ts subprocessBounds resolves harness.subprocessBounds.stallMs from the pinned config document (configuredSubprocessBounds, once per command invocation; the commit guard reads its pinned document per commit), and every consumer hands it to the ONE bounded run (runCpuBounded, src/process/supervised-run.ts): runScriptSubprocess and runTypecheck (harness-commands.ts, each `harness sync`/`check` a fresh process), the commit guard's compile legs, and the instrument lock's admitted run (the kernel CPU limit it derives), so the honest timing is next-run; engine/test/workflow/harness-commands-cli-fixes.test.ts drives each bound through runScriptSubprocess and engine/test/workflow/harness-commands-timeouts.test.ts proves the configured value is the one resolved",
  ],
  [
    "harnessCommands.subprocessHangBackstopMs",
    "engine/src/workflow/workflow-config.ts subprocessBounds resolves harness.subprocessBounds.hangBackstopMs from the pinned config document (configuredSubprocessBounds, once per command invocation; the commit guard reads its pinned document per commit), and every consumer hands it to the ONE bounded run (runCpuBounded, src/process/supervised-run.ts): runScriptSubprocess and runTypecheck (harness-commands.ts, each `harness sync`/`check` a fresh process), the commit guard's compile legs, and the instrument lock's admitted run (the kernel CPU limit it derives), so the honest timing is next-run; engine/test/workflow/harness-commands-cli-fixes.test.ts drives each bound through runScriptSubprocess and engine/test/workflow/harness-commands-timeouts.test.ts proves the configured value is the one resolved",
  ],
  [
    "harnessCommands.subprocessPollMs",
    "engine/src/workflow/workflow-config.ts subprocessBounds resolves harness.subprocessBounds.pollMs from the pinned config document (configuredSubprocessBounds, once per command invocation; the commit guard reads its pinned document per commit), and every consumer hands it to the ONE bounded run (runCpuBounded, src/process/supervised-run.ts): runScriptSubprocess and runTypecheck (harness-commands.ts, each `harness sync`/`check` a fresh process), the commit guard's compile legs, and the instrument lock's admitted run (the kernel CPU limit it derives), so the honest timing is next-run; engine/test/workflow/harness-commands-cli-fixes.test.ts drives each bound through runScriptSubprocess and engine/test/workflow/harness-commands-timeouts.test.ts proves the configured value is the one resolved",
  ],
  [
    "harnessCommands.subprocessKillGraceMs",
    "engine/src/workflow/workflow-config.ts subprocessBounds resolves harness.subprocessBounds.killGraceMs from the pinned config document (configuredSubprocessBounds, once per command invocation; the commit guard reads its pinned document per commit), and every consumer hands it to the ONE bounded run (runCpuBounded, src/process/supervised-run.ts): runScriptSubprocess and runTypecheck (harness-commands.ts, each `harness sync`/`check` a fresh process), the commit guard's compile legs, and the instrument lock's admitted run (the kernel CPU limit it derives), so the honest timing is next-run; engine/test/workflow/harness-commands-cli-fixes.test.ts drives each bound through runScriptSubprocess and engine/test/workflow/harness-commands-timeouts.test.ts proves the configured value is the one resolved",
  ],
  [
    "harnessCommands.subprocessOutputBytes",
    "engine/src/workflow/workflow-config.ts subprocessBounds resolves harness.subprocessBounds.outputBytes from the pinned config document (configuredSubprocessBounds, once per command invocation; the commit guard reads its pinned document per commit), and every consumer hands it to the ONE bounded run (runCpuBounded, src/process/supervised-run.ts): runScriptSubprocess and runTypecheck (harness-commands.ts, each `harness sync`/`check` a fresh process), the commit guard's compile legs, and the instrument lock's admitted run (the kernel CPU limit it derives), so the honest timing is next-run; engine/test/workflow/harness-commands-cli-fixes.test.ts drives each bound through runScriptSubprocess and engine/test/workflow/harness-commands-timeouts.test.ts proves the configured value is the one resolved",
  ],
  [
    "harnessCommands.commandErroredRetries",
    "engine/src/workflow/workflow-config.ts commandRetryPolicy resolves harness.commandErroredRetries from the pinned config document once per command invocation, and configuredCheckoutCommandRunner (src/workflow/checkout-setup.ts) hands it to the ONE runner of every consumer — `harness workspace` (workspace-cli.ts), the candidate checkout and `harness promote` (context.ts lockfileRun), each a fresh process per run — so the honest timing is next-run; engine/test/workflow/working-copy.test.ts proves the runner retries an errored command exactly that many times and never a failed one, including a workspace phase's command, and engine/test/workflow/promotion/transforms.test.ts proves the lockfile derivation's attempts follow the policy",
  ],
  [
    "harnessCommands.commandRetryBackoffMs",
    "engine/src/workflow/workflow-config.ts commandRetryPolicy resolves harness.commandRetryBackoffMs from the pinned config document once per command invocation, and configuredCheckoutCommandRunner hands it to the ONE runner (runCheckoutCommand, src/workflow/checkout-setup.ts) as the first wait, doubled per retry, for every consumer (workspace, candidate checkout, promotion), so the honest timing is next-run; engine/test/workflow/working-copy.test.ts and engine/test/workflow/promotion/transforms.test.ts prove the doubling waits",
  ],
  [
    "release.train",
    "engine/src/workflow/promotion/release-cli.ts resolves the promotion.release section from the pinned config document once per command invocation (releaseVerb: resolveRepositoryContext reads the pinned snapshot; `harness release` is a fresh process on every land) and hands it to planRelease (release-train.ts), which reads the train mode (manual waits for --manual, approval sets the approval flag), so the honest timing is next-run; engine/test/workflow/promotion/release.test.ts drives the real release door with the section and proves the plan consumes it",
  ],
  [
    "release.minIntervalHours",
    "engine/src/workflow/promotion/release-cli.ts resolves the promotion.release section from the pinned config document once per command invocation (releaseVerb: resolveRepositoryContext reads the pinned snapshot; `harness release` is a fresh process on every land) and hands it to planRelease (release-train.ts), which reads minIntervalHours (the interval reason), so the honest timing is next-run; engine/test/workflow/promotion/release.test.ts drives the real release door with the section and proves the plan consumes it",
  ],
  [
    "release.profile",
    "engine/src/workflow/promotion/release-cli.ts resolves the promotion.release section from the pinned config document once per command invocation (releaseVerb: resolveRepositoryContext reads the pinned snapshot; `harness release` is a fresh process on every land) and hands it to planRelease (release-train.ts), which reads profile (the product ref is that profile's target), so the honest timing is next-run; engine/test/workflow/promotion/release.test.ts drives the real release door with the section and proves the plan consumes it",
  ],
  [
    "release.tagPrefix",
    "engine/src/workflow/promotion/release-cli.ts resolves the promotion.release section from the pinned config document once per command invocation (releaseVerb: resolveRepositoryContext reads the pinned snapshot; `harness release` is a fresh process on every land) and hands it to planRelease (release-train.ts), which reads tagPrefix (the release tag and the previous release's tags), so the honest timing is next-run; engine/test/workflow/promotion/release.test.ts drives the real release door with the section and proves the plan consumes it",
  ],
  [
    "release.discussionCategory",
    "engine/src/workflow/promotion/release-cli.ts resolves the promotion.release section from the pinned config document once per command invocation (releaseVerb: resolveRepositoryContext reads the pinned snapshot; `harness release` is a fresh process on every land) and hands it to planRelease (release-train.ts), which reads discussionCategory (the plan names the announcement's category), so the honest timing is next-run; engine/test/workflow/promotion/release.test.ts drives the real release door with the section and proves the plan consumes it",
  ],
  [
    "harnessCommands.identityAttestationTimeoutMs",
    "engine/src/evaluation/cli.ts resolves the evaluation section from the pinned config document once per command invocation (:235, a fresh process per run) and hands identityAttestationTimeoutMs to createScenarioRunner, whose runner bounds the identity probe with it (scenario-runner.ts:91, consumed by attestIdentity at :230), so the honest timing is next-run; engine/test/evaluation/identity-attestation.test.ts proves the attestation probe consumes its timeout bound, and engine/test/config/config-sections.test.ts pins the section's schema bounds",
  ],
]);

test("enrichment sweep: every served customization declares effect iff consumption was verified", () => {
  resetAllRegistrations();
  registerAllExposure();
  try {
    const customizations = listCustomizations();
    // Non-vacuity, not a pinned total: a sweep over an empty registry passes
    // every assertion below it, which is the one way this test could lie.
    assert.equal(countCustomizations(), customizations.length);
    assert.ok(customizations.length > 0, "the registry served nothing — the sweep would pass over nothing");
    const modulesSeen = new Set(customizations.map((c) => c.module));
    // The sweep's subject is customizations. A registered module that serves
    // only signals (no customizations) has no control for this sweep to inspect, so it is
    // legitimately absent from `modulesSeen`; what must be true is that every
    // module the sweep DID see is a real registered module (no orphan
    // namespace), which the per-module assertions below already rely on.
    const known = new Set(registeredModuleNames());
    assert.deepEqual(
      [...modulesSeen].filter((m) => !known.has(m)),
      [],
      "a customization was served under a module registerAllExposure does not register — an orphan namespace",
    );

    const undeclaredSet = new Set<string>(HONESTLY_UNDECLARED);
    assert.equal(undeclaredSet.size, 0, "no served control may be a dead store");
    const misdeclared: string[] = [];
    let immediate = 0;
    for (const customization of customizations) {
      const effect = resolveContract(customization.contract).effect;
      if (undeclaredSet.has(customization.id)) {
        if (effect !== "unspecified") misdeclared.push(`${customization.id}: declared "${effect}" but no consumer was verified`);
        continue;
      }
      const nonImmediateConsumer = VERIFIED_NON_IMMEDIATE.get(customization.id);
      if (nonImmediateConsumer !== undefined) {
        // A verified non-immediate knob must declare the timing its consumer
        // actually has — and must NOT drift back to "immediate" (the lie the
        // other direction), which a bare acceptance would never catch.
        if (effect === "immediate" || effect === "unspecified") {
          misdeclared.push(`${customization.id}: consumer is verified ${nonImmediateConsumer.includes("next-run") ? "next-run" : "non-immediate"} but declared "${effect}"`);
        }
        continue;
      }
      if (effect !== "immediate") misdeclared.push(`${customization.id}: expected verified "immediate", got "${effect}"`);
      immediate += 1;
    }
    assert.deepEqual(misdeclared, [], misdeclared.join("\n"));
    assert.equal(immediate, customizations.length - HONESTLY_UNDECLARED.length - VERIFIED_NON_IMMEDIATE.size);
  } finally {
    resetAllRegistrations();
  }
});

test("enrichment sweep: every declared measuredBy resolves to a same-module registered signal", () => {
  resetAllRegistrations();
  registerAllExposure();
  try {
    let linked = 0;
    for (const customization of listCustomizations()) {
      if (customization.measuredBy === undefined) continue;
      linked += 1;
      const signal = getSignal(customization.measuredBy);
      assert.ok(signal !== undefined, `${customization.id} measuredBy dangles`);
      assert.equal(
        signal.module,
        customization.module,
        `${customization.id} claims measurement by another module's signal`,
      );
    }
    // Every linkage above is verified individually; what a total adds is
    // only that the loop ran, so that is what is asserted. The exact count
    // was the same bookkeeping that kept this file red.
    assert.ok(linked > 0, "no customization declared a measuredBy — the linkage check ran over nothing");
  } finally {
    resetAllRegistrations();
  }
});

/**
 * The MISDECLARATION sweep — the class the `awareness.lastUpdate` defect
 * belonged to: a declaration that tells a generic renderer to format a value
 * as something it is not. Two mechanical rules over every registered signal.
 */
/**
 * Prose that names a point in time: "epoch", "instant", or "at" as a
 * preposition of time. "At least" and "at most" are quantities, not instants:
 * "not measured until at least one call is recorded" describes a duration's
 * availability, and reading it as an instant misdeclared two correct timers.
 */
const DESCRIBES_AN_INSTANT = /epoch|instant|\bat\b(?!\s+(?:least|most)\b)/iu;

test("the instant reading: a preposition of time is an instant; 'at least' and 'at most' are not", () => {
  for (const instant of ["The epoch ms of the last edit.", "The instant the turn began.", "When the run started, at the wall clock."]) {
    assert.ok(DESCRIBES_AN_INSTANT.test(instant), instant);
  }
  for (const quantity of ["Not measured until at least one call is recorded.", "Kept for at most an hour.", "The median duration of every call."]) {
    assert.ok(!DESCRIBES_AN_INSTANT.test(quantity), quantity);
  }
});

test("misdeclaration sweep: an epoch instant is typed `timestamp`, never a duration `timer`", () => {
  resetAllRegistrations();
  registerAllExposure();
  try {
    const misdeclared: string[] = [];
    for (const signal of listSignals()) {
      const describesAnInstant = DESCRIBES_AN_INSTANT.test(signal.description) || /At$|lastUpdate$/.test(signal.id);
      if (describesAnInstant && signal.type === "timer") {
        misdeclared.push(
          `${signal.id}: describes an instant but is typed "timer" — a renderer will format it as a duration`,
        );
      }
      // And the inverse: a `timestamp` must not claim a duration unit.
      if (signal.type === "timestamp" && signal.unit !== undefined && /^ms$|millisecond/.test(signal.unit)) {
        misdeclared.push(`${signal.id}: a timestamp must not declare a bare duration unit "${signal.unit}"`);
      }
    }
    assert.deepEqual(misdeclared, [], misdeclared.join("\n"));
    // Not vacuous: the two known instants ARE declared as timestamps.
    for (const id of ["awareness.lastUpdate", "editor.lastEditAt"]) {
      assert.equal(getSignal(id)?.type, "timestamp", `${id} must be a timestamp`);
    }
  } finally {
    resetAllRegistrations();
  }
});

test("misdeclaration sweep: a config-mirror signal declares the SAME unit as the customization it mirrors", () => {
  resetAllRegistrations();
  registerAllExposure();
  try {
    // A signal sharing a customization's exact id USUALLY reports that same
    // stored quantity. Two different unit words for one quantity means one of
    // the two surfaces prints the wrong thing.
    //
    // There is NO exemption any more. `tools.retryCount` used to be one: the
    // SIGNAL read `toolsState.retryCount` (retries issued so far — a running
    // total) while the CUSTOMIZATION read `toolsState.retryLimit` (the
    // per-call cap). One id, two genuinely different quantities. The wire id
    // turned out to be persisted nowhere (customization values live only in
    // the per-process registry; every client learns the id list from the
    // schema at request time), so the collision was RENAMED away —
    // `tools.retryLimit` — instead of being documented forever. An exemption
    // that can be deleted is better than an exemption that is explained.
    const disagreements: string[] = [];
    let mirrors = 0;
    for (const customization of listCustomizations()) {
      const mirror = getSignal(customization.id);
      if (mirror === undefined) continue;
      mirrors += 1;
      if (mirror.unit === undefined && customization.unit === undefined) continue;
      if (mirror.unit !== customization.unit) {
        disagreements.push(
          `${customization.id}: control prints "${customization.unit ?? "(none)"}" but its mirror signal declares "${mirror.unit ?? "(none)"}"`,
        );
      }
    }
    assert.ok(mirrors > 5, `discovery found only ${mirrors} config-mirror signals`);
    assert.deepEqual(disagreements, [], disagreements.join("\n"));
    // The rename must STAY: the per-call cap is its own id, and the signal
    // that counts retries issued must not acquire a colliding control again.
    assert.ok(
      listCustomizations().some((c) => c.id === "tools.retryLimit"),
      "the per-call retry cap is registered under its own id",
    );
    assert.equal(
      listCustomizations().find((c) => c.id === "tools.retryCount"),
      undefined,
      "tools.retryCount is a SIGNAL only — a control under that id would mean two quantities, one name, again",
    );
  } finally {
    resetAllRegistrations();
  }
});

/**
 * A control's `default` is what the settings surface prints as "Default:" and
 * what `resetCustomizationValue` writes. If it disagrees with the value the
 * control actually serves when nothing overrides it, the surface names a
 * default the module never had — and "reset" silently CHANGES behaviour
 * instead of restoring it. Two controls did exactly that:
 * `quality.enabledChecks` and `awareness.enabledSignals` each advertised `""`
 * (run/watch none) while their module started with a populated set, so a
 * reset would have turned every quality check, and every watched reading,
 * off. Both now derive the state and the default from ONE constant, which is
 * why the sweep can be exact — once it is split by binding class, because
 * "nothing overrides it" means a different thing for each:
 *   - an IN-MEMORY control starts at a constant its module owns, so its
 *     default must equal its `current()` at fresh registration;
 *   - a CONFIG-BOUND control starts at the install's own file, whose
 *     standing overrides are the settings room's whole purpose (judging
 *     against the real file would red on every operator override ever
 *     saved), so its default must equal its `current()` when every config
 *     key is ABSENT — the state where a default is the truth, and the
 *     exact state "return to default" restores through the omit-on-default
 *     write.
 */
test("enrichment sweep: every in-memory control's declared default is the value its module starts at", () => {
  // The sweep's subject is now the class it was written for: controls whose
  // start state is a constant the module itself owns (an in-memory
  // projection). Config-bound controls are EXCLUDED here and owned by the
  // sweep below — for them "the value the module starts at" is the
  // install's own file, whose standing overrides are the settings room's
  // whole purpose, so demanding `default === current()` against the real
  // file would red on every operator override ever saved. The original
  // defect (a sheet printing a default the control does not serve) is
  // caught for BOTH classes, each at its own root.
  resetAllRegistrations();
  registerAllExposure();
  try {
    const mismatches: string[] = [];
    let checked = 0;
    for (const customization of listCustomizations()) {
      if (customization.configPath !== undefined) continue;
      checked += 1;
      const actual = JSON.stringify(customization.current());
      const declared = JSON.stringify(customization.default);
      if (actual !== declared) {
        mismatches.push(
          `${customization.id}: prints default ${declared} but a fresh process starts at ${actual} — "reset" would change behaviour, not restore it`,
        );
      }
    }
    assert.ok(checked > 0, "the sweep must run over the in-memory rows — a vacuous pass proves nothing");
    assert.deepEqual(mismatches, [], mismatches.join("\n"));
  } finally {
    resetAllRegistrations();
  }
});

test("enrichment sweep: every config-bound control's declared default is its own absent-key reading", () => {
  // The config-bound twin of the sweep above, judged at the state where a
  // default is the truth: EVERY KEY ABSENT (a fresh install whose file
  // carries no overrides). A config-bound row's `current()` must serve
  // exactly the `default` it prints when the config carries nothing — a
  // row whose reader falls back to a different literal than the default
  // it declares is the original "names a default the module never had"
  // defect, caught at its own root. The override direction is NOT a lie
  // and is deliberately not judged here: a file carrying a non-default
  // value is an operator's standing choice the row honestly shows as its
  // current value, and "return to default" stays honest because the
  // omit-on-default write prunes the key, so the consumer's own fallback
  // — the same contract default the row serves here — is what runs.
  const empty: Record<string, unknown> = {};
  installCustomizationConfigStore({
    configFilePath: createEngineCustomizationConfigStore().configFilePath,
    readDocument: () => empty,
    writeDocument: () => {},
  });
  resetAllRegistrations();
  registerAllExposure();
  try {
    const mismatches: string[] = [];
    let checked = 0;
    for (const customization of listCustomizations()) {
      if (customization.configPath === undefined) continue;
      checked += 1;
      const actual = JSON.stringify(customization.current());
      const declared = JSON.stringify(customization.default);
      if (actual !== declared) {
        mismatches.push(
          `${customization.id}: prints default ${declared} but serves ${actual} when the config carries no override — the sheet would name a default its own reader never falls back to`,
        );
      }
    }
    assert.ok(checked > 0, "the sweep must run over the config-bound rows — a vacuous pass proves nothing");
    assert.deepEqual(mismatches, [], mismatches.join("\n"));
  } finally {
    // Restore the engine's own file-backed store so later tests in this
    // process read the real config again, then re-register clean.
    installCustomizationConfigStore(createEngineCustomizationConfigStore());
    resetAllRegistrations();
  }
});

test("enrichment sweep: every number-typed customization declares a printable unit", () => {
  resetAllRegistrations();
  registerAllExposure();
  try {
    for (const customization of listCustomizations()) {
      if (customization.type !== "number") continue;
      assert.ok(
        customization.unit !== undefined,
        `${customization.id} is a number without a unit — its control cannot print one`,
      );
      assert.equal(
        customizationUnitViolation(customization.unit),
        null,
        `${customization.id} unit "${customization.unit}" is not printable`,
      );
    }
  } finally {
    resetAllRegistrations();
  }
});

test("language contract: the escalation row's description tells the coupling truth it was caught hiding", () => {
  // `safety.gateBlockEscalationAfter` shipped claiming "the call is refused
  // either way; only the message changes" — false as a mechanism claim: the
  // gate's auto-trip only fires once the message escalates, so a value PAST
  // the switch-off count silently delays the switch-off. The floor refuses
  // that write now, and the description must disclose BOTH halves — the
  // bound and the refusal — or the row sells a writable knob as freer than
  // the gate lets it be. The pin is phrase-based, not full-text: the prose
  // may evolve, but the load-bearing facts may not silently leave.
  resetAllRegistrations();
  registerAllExposure();
  try {
    const row = listCustomizations().find((c) => c.id === "safety.gateBlockEscalationAfter");
    assert.ok(row !== undefined, "the safety module must serve the escalation row");
    assert.ok(
      row.description.includes("may not be raised past"),
      "the escalation row must disclose the bound: it may not be raised past the switch-off count",
    );
    assert.ok(
      row.description.includes("the write is refused"),
      "the escalation row must say the over-bound write is refused, not silently narrowed",
    );
    assert.ok(
      !row.description.includes("only the message changes"),
      "the escalation row may not carry the unqualified claim that only the message changes — past the switch-off count it would silently delay the trip",
    );
  } finally {
    resetAllRegistrations();
  }
});
