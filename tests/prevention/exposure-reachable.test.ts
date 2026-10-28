// @vitest-environment node
/**
 * Everything registered on the exposure surface is declared, bound, and
 * reachable. A knob that exists only in a registration file is the
 * prohibited class (built but not exposed, or exposed but undeclared).
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  registerAllExposure,
  resetAllRegistrations,
  listCustomizations,
  listSignals,
  listActions,
  listExposureModules,
  isConfigPathDeclared,
  installCustomizationConfigStore,
  getConfigDocumentSchema,
} from "../../server/kernel/canonical.ts";
import { serverConfig } from "../../server/kernel/config.ts";
// The array door's own declaration — the config leaf the settings block
// serves. The census reads the block's export (never a restated path), so the
// door and the census cannot drift: a leaf the block stops serving stops
// being served-by-section here and reds until it is re-disposed.
import { DIAGNOSTIC_MODES_CONFIG_PATH } from "../../server/blocks/settings.ts";
// The search-engine vocabulary's owner — the same source the memory
// registration derives its choices from, so the arm never restates the list.
import { MEMORY_SEARCH_ENGINE_KINDS } from "../../engine/src/memory/memory-types.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

beforeEach(() => {
  let doc: Record<string, unknown> = {};
  installCustomizationConfigStore({
    configFilePath: serverConfig.harnessConfigPath,
    readDocument: () => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
    writeDocument: (next) => {
      doc = next;
    },
  });
  resetAllRegistrations();
  registerAllExposure();
});

afterEach(() => {
  resetAllRegistrations();
});

describe("exposure is declared and reachable", () => {
  test("every customization with a configPath is a declared config key", () => {
    const missing: string[] = [];
    for (const c of listCustomizations()) {
      if (c.configPath === undefined) continue;
      if (!isConfigPathDeclared(c.configPath)) missing.push(`${c.id} → ${c.configPath}`);
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  test("every signal value() and action execute() is a live function", () => {
    for (const s of listSignals()) {
      expect(typeof s.value, s.id).toBe("function");
      const reading = s.value();
      expect(reading === undefined, `${s.id} must not read undefined`).toBe(false);
    }
    for (const a of listActions()) {
      expect(typeof a.execute, a.id).toBe("function");
    }
  });

  test("intelligence auto-index, farm, languages, and drop are on the surface", () => {
    const ids = new Set(listCustomizations().map((c) => c.id));
    expect(ids.has("intelligence.autoIndexOnProjectAdd")).toBe(true);
    expect(
      ids.has("intelligence.rememberIndexInMemory"),
      "census memory is collapsed; this id must not stay on the surface",
    ).toBe(false);
    expect(ids.has("intelligence.watchIndexedProjects")).toBe(true);
    expect(ids.has("intelligence.indexWatchDebounceMs")).toBe(true);
    expect(ids.has("intelligence.farmPerFileTimeoutMs")).toBe(true);
    const signals = new Set(listSignals().map((s) => s.id));
    expect(signals.has("intelligence.treeSitterLanguages")).toBe(true);
    expect(signals.has("intelligence.cachedProjects")).toBe(true);
    expect(listActions().some((a) => a.id === "intelligence.dropCachedMaps")).toBe(true);
    const n = listSignals().find((s) => s.id === "intelligence.treeSitterLanguages")!.value();
    expect(typeof n === "number" && n > 2).toBe(true);
  });

  test("the dedup category serves the memory.dedupCompression facts (every knob bound, no empty category)", () => {
    // The category this arm protects renders in the settings room as
    // "Duplicate and compression savings". While the config schema owned the
    // three dedupCompression facts and no registration published them, the
    // category declared itself and then rendered "nothing to adjust" — a
    // settings surface that names an area while hiding its real knobs. This
    // arm fails on that shape: remove one registration and the category is
    // empty again, which is exactly what must not silently return.
    const declared = listExposureModules().find((m) => m.id === "dedup");
    expect(
      declared,
      "the dedup module must stay declared — its rows group under its category title",
    ).toMatchObject({ title: "Duplicate and compression savings" });

    const knobs = listCustomizations().filter((c) => c.module === "dedup");
    expect(
      knobs.map((c) => c.id).sort(),
      "the dedup category must serve exactly the memory.dedupCompression section's facts — a category that owns real config facts renders them, never 'nothing to adjust'",
    ).toEqual(["dedup.dedupMode", "dedup.enabled", "dedup.llmInputDedup"]);

    const byId = new Map(knobs.map((c) => [c.id, c]));
    for (const [id, path] of [
      ["dedup.enabled", "memory.dedupCompression.enabled"],
      ["dedup.llmInputDedup", "memory.dedupCompression.llmInputDedup"],
      ["dedup.dedupMode", "memory.dedupCompression.dedupMode"],
    ] as const) {
      const knob = byId.get(id)!;
      expect(knob.configPath, `${id} must bind the config fact it adjusts`).toBe(path);
      expect(
        isConfigPathDeclared(knob.configPath!),
        `${id}'s configPath must be declared in the config document schema`,
      ).toBe(true);
    }
    // The recognition mode's choices are the config vocabulary — the write
    // gate refuses anything else, so the offered choices must not promise
    // one the gate would reject.
    expect(byId.get("dedup.dedupMode")!.enum).toEqual(["none", "line", "block", "semantic"]);
  });

  test("the memory module serves the real memory store's knobs the config declares", () => {
    // The `memory` config section owns two families: the working-memory
    // window knobs (already rows) and the REAL store's whole-context facts —
    // the token budget the run's context manager trims within, the tier
    // capacities, the per-entry size ceilings, and the search engine. The
    // real store consumes them (server/context/context-bridge.ts resolves the
    // section per process; server/context/memory-bridge.ts builds the store
    // with it), so while they sat unregistered the room named the area and
    // hid its real knobs. This arm fails on that shape: unregister any one of
    // the ten and the family is broken by name. Each declares the restart
    // timing its cached consumer actually has — a row promising immediacy
    // here would be the lie the language guard's sweep exists to catch.
    const knobs = new Map(
      listCustomizations().filter((c) => c.module === "memory").map((c) => [c.id, c]),
    );
    for (const [id, path] of [
      ["memory.contextTokenLimit", "memory.contextTokenLimit"],
      ["memory.contextTrimThreshold", "memory.trimThreshold"],
      ["memory.recentTurnWindow", "memory.recentTurnWindow"],
      ["memory.summaryMaxTokens", "memory.summaryMaxTokens"],
      ["memory.shortTermTurnLimit", "memory.shortTermTurnLimit"],
      ["memory.longTermFactLimit", "memory.longTermFactLimit"],
      ["memory.searchEngine", "memory.searchEngine"],
      ["memory.contentMaxCharacters", "memory.contentMaxCharacters"],
      ["memory.maxTagsPerEntry", "memory.maxTagsPerEntry"],
      ["memory.maxTopicCharacters", "memory.maxTopicCharacters"],
    ] as const) {
      const knob = knobs.get(id);
      expect(
        knob,
        `${id} must be a served row — the real memory store's whole-context knobs are adjustable from settings, none skipped`,
      ).toBeDefined();
      expect(knob!.configPath, `${id} must bind the config fact it adjusts`).toBe(path);
      expect(
        isConfigPathDeclared(knob!.configPath!),
        `${id}'s configPath must be declared in the config document schema`,
      ).toBe(true);
      expect(
        knob!.contract && "effect" in knob!.contract ? knob!.contract.effect : undefined,
        `${id} resolves its section once per process — the honest timing is restart`,
      ).toBe("restart");
    }
    // The search engine's choices are the store's own vocabulary — derived
    // from the owner the registration itself reads, so an engine kind added
    // tomorrow is offered the day it lands and the offered choices never
    // promise an engine the resolver would refuse.
    expect(knobs.get("memory.searchEngine")!.enum).toEqual([...MEMORY_SEARCH_ENGINE_KINDS]);
  });

  test("the memory module serves the capture-and-search leaves the config declares", () => {
    // The `memory` section's capture-and-search family: the search route's
    // default limit and ceiling, the recall count, the saved-turn caps, and
    // the recalled-context preview length. Their consumers read the config
    // file on each call (the mtime-cached harness-config reader), so each
    // row declares the immediate timing the consumer actually has — a row
    // promising a restart here, or immediacy on a process-cached knob,
    // would be the lie the language guard's sweep exists to catch. The
    // default limit's row exists because its consumer now reads the
    // declared leaf: for years the route's real default came from a reader
    // of an undeclared twin spelling the write gate refused, while the
    // declared leaf sat unconsumed. This arm fails on that shape's return:
    // unregister any one of the seven and the family is broken by name.
    const knobs = new Map(
      listCustomizations().filter((c) => c.module === "memory").map((c) => [c.id, c]),
    );
    for (const [id, path] of [
      ["memory.searchResultLimit", "memory.searchResultLimit"],
      ["memory.searchMaxLimit", "memory.searchMaxLimit"],
      ["memory.retrievalLimit", "memory.retrievalLimit"],
      ["memory.interactionContentMaxChars", "memory.interactionContentMaxChars"],
      ["memory.toolResultContentMaxChars", "memory.toolResultContentMaxChars"],
      ["memory.toolResultArgsMaxChars", "memory.toolResultArgsMaxChars"],
      ["memory.previewMaxChars", "memory.previewMaxChars"],
    ] as const) {
      const knob = knobs.get(id);
      expect(
        knob,
        `${id} must be a served row — the memory section's capture-and-search leaves are adjustable from settings, none skipped`,
      ).toBeDefined();
      expect(knob!.configPath, `${id} must bind the config fact it adjusts`).toBe(path);
      expect(
        isConfigPathDeclared(knob!.configPath!),
        `${id}'s configPath must be declared in the config document schema`,
      ).toBe(true);
      expect(
        knob!.contract && "effect" in knob!.contract ? knob!.contract.effect : undefined,
        `${id} reads the config file on each call — the honest timing is immediate`,
      ).toBe("immediate");
    }
  });

  test("every memory.* leaf the config document schema declares is a served row (no zombie leaves)", () => {
    // The phantom-leaf shape this arm exists to catch: a leaf the config
    // contract declares (so the settings write gate ACCEPTS it and a user can
    // set it) that no row serves — a knob that writes to nothing, invisible
    // in the room while writable through the door. The measured instance sat
    // declared-and-writable for years with no consumer and no row while its
    // undeclared twin spelling carried the real behavior. The leaf set below
    // is DERIVED by walking the schema's memory shape — never restated — so
    // a leaf added to the contract tomorrow must gain a row the same day or
    // this arm reds naming it.
    type ShapeLike = {
      _def?: { type?: string; innerType?: unknown };
      shape?: Record<string, unknown>;
    };
    // Unwrap optional/default/nullable/readonly wrappers — the memory section
    // is declared `.optional()` at the document level, so its shape lives on
    // the wrapped inner schema (the same introspection idiom the
    // config-binding owner uses for `isConfigPathDeclared`).
    const unwrap = (schema: unknown): ShapeLike | undefined => {
      let current = schema as ShapeLike | undefined;
      while (current?._def?.type !== undefined && ["optional", "default", "nullable", "readonly"].includes(current._def.type)) {
        current = current._def.innerType as ShapeLike | undefined;
      }
      return current;
    };
    const memorySchema = unwrap((CONFIG_DOCUMENT_SCHEMA as unknown as ShapeLike).shape?.memory);
    expect(memorySchema, "the config document schema must declare the memory section").toBeDefined();
    const declared = new Set<string>();
    const walk = (schema: ShapeLike, prefix: string): void => {
      for (const [key, leaf] of Object.entries(schema.shape ?? {})) {
        const path = `${prefix}.${key}`;
        const inner = unwrap(leaf);
        if (inner?.shape !== undefined) {
          walk(inner, path);
        } else {
          declared.add(path);
        }
      }
    };
    walk(memorySchema!, "memory");
    expect(declared.size, "the memory section must declare real leaves").toBeGreaterThan(0);
    const served = new Set(listCustomizations().map((c) => c.configPath).filter((p): p is string => p !== undefined));
    const unserved = [...declared].filter((path) => !served.has(path));
    expect(
      unserved,
      "every memory.* leaf the contract declares must be a served row — a declared leaf with no row is a knob that writes to nothing",
    ).toEqual([]);
  });

  test("the quality module serves every fail-the-check gate flag the config declares", () => {
    // The four severity bands each own a "does a finding at this band fail
    // the check" switch, and all four are one family: same projection field
    // shape, same config-binding map, same consumer (`bandFailsGate` decides
    // `recheck`'s verdict). Three were registered rows while
    // `quality.failOnLow` — whose projection, binding map and consumer all
    // existed — was skipped with nothing explaining the skip: a knob the
    // settings room could not turn while its three identical siblings were
    // turnable. This arm fails on that shape: unregister any one of the
    // four and the family is broken by name.
    const knobs = new Map(
      listCustomizations().filter((c) => c.module === "quality").map((c) => [c.id, c]),
    );
    for (const id of ["quality.failOnCritical", "quality.failOnHigh", "quality.failOnMedium", "quality.failOnLow"] as const) {
      const knob = knobs.get(id);
      expect(
        knob,
        `${id} must be a served row — every severity band's fail-the-check switch is adjustable from settings, none skipped`,
      ).toBeDefined();
      expect(knob!.configPath, `${id} must bind its own config fact`).toBe(id);
      expect(knob!.type).toBe("boolean");
      expect(
        isConfigPathDeclared(knob!.configPath!),
        `${id}'s configPath must be declared in the config document schema`,
      ).toBe(true);
    }
  });

  test("the redaction module serves the redaction section's one bound with its measured twin", () => {
    // The `redaction` config section owns exactly one leaf — the bound on
    // the web redaction owner's re-hiding store — and that leaf has a real
    // consumer (server/llm/redaction.ts sizes the store from it at module
    // evaluation), so while it sat unregistered the room was missing a knob
    // the write gate already accepted. This arm fails on that shape: remove
    // the row and the section is unserved again. The store's own live
    // occupancy is the row's measurement, served through the same module.
    const declared = listExposureModules().find((m) => m.id === "redaction");
    expect(
      declared,
      "the redaction module must stay declared — its row groups under its category title",
    ).toBeDefined();

    const knob = listCustomizations().find((c) => c.id === "redaction.toolCallArgumentsCacheEntries");
    expect(
      knob,
      "redaction.toolCallArgumentsCacheEntries must be a served row — the section's one bound has a live consumer, so it renders as a row, never as an unserved fact",
    ).toBeDefined();
    expect(knob!.configPath, "the row must bind the config fact it adjusts").toBe("redaction.toolCallArgumentsCacheEntries");
    expect(
      isConfigPathDeclared(knob!.configPath!),
      "the row's configPath must be declared in the config document schema",
    ).toBe(true);
    // The consumer sizes the store once per process, so the honest timing is
    // restart — a row promising immediacy here would be the lie the language
    // guard's sweep exists to catch.
    expect(knob!.contract, "the row must declare the restart timing its consumer actually has").toMatchObject({
      effect: "restart",
    });
    expect(knob!.measuredBy, "the row must name its measurement").toBe("redaction.memoEntries");
    const signal = listSignals().find((s) => s.id === "redaction.memoEntries");
    expect(
      signal,
      "redaction.memoEntries must be a registered signal — the row's measurement must resolve",
    ).toBeDefined();
    expect(signal!.module).toBe("redaction");
  });

  test("every performance.* leaf has an honest disposition: a served row, a read-only budget, or a filed reason", () => {
    // The performance section is the engine's own observability vocabulary
    // — 41 declared leaves, of which the settings room historically served
    // three. This census is the section's leaf-by-leaf honesty: the walk
    // derives the leaf set from the schema (never a restated list), and
    // every leaf must land in exactly one of three dispositions —
    //   (a) a SERVED ROW, for leaves whose file-fed consumer delivers real
    //       behavior (the sampler/deltas rows the server reads live; the
    //       benchmark run bounds and the diagnostic mode timeout the
    //       harness's benchmark and diagnostic commands read per
    //       invocation);
    //   (b) a READ-ONLY BUDGET SIGNAL, for the two detection budgets that
    //       decide the benchmark tool's own verdicts — visible, never
    //       writable from the room;
    //   (c) a SERVED-BY-SECTION leaf, for the array-valued leaf the row
    //       grammar cannot write (the sheet refuses array JSON by design):
    //       served through the settings block family's own array door, the
    //       mcpServers-list precedent for a shape the row grammar could not
    //       express — pinned both directions by the sectionServed checks;
    //   (d) a FILED REASON, for every leaf that would today promise
    //       behavior nothing delivers.
    // A leaf added to the schema tomorrow reds here until it is registered
    // or filed — the deny-by-default direction of the memory zombie sweep,
    // inverted for a section whose honest state is mostly "not reachable
    // from any live consumer".
    type ShapeLike = {
      _def?: { type?: string; innerType?: unknown };
      shape?: Record<string, unknown>;
    };
    const unwrap = (schema: unknown): ShapeLike | undefined => {
      let current = schema as ShapeLike | undefined;
      while (current?._def?.type !== undefined && ["optional", "default", "nullable", "readonly"].includes(current._def.type)) {
        current = current._def.innerType as ShapeLike | undefined;
      }
      return current;
    };
    const performanceSchema = unwrap((CONFIG_DOCUMENT_SCHEMA as unknown as ShapeLike).shape?.performance);
    expect(performanceSchema, "the config document schema must declare the performance section").toBeDefined();
    const declared = new Set<string>();
    const walk = (schema: ShapeLike, prefix: string): void => {
      for (const [key, leaf] of Object.entries(schema.shape ?? {})) {
        const path = `${prefix}.${key}`;
        const inner = unwrap(leaf);
        if (inner?.shape !== undefined) {
          walk(inner, path);
        } else {
          declared.add(path);
        }
      }
    };
    walk(performanceSchema!, "performance");
    expect(declared.size, "the performance section must declare real leaves").toBeGreaterThan(0);

    // The read-only budgets: the registry's signal primitive is its read
    // tier, so these two leaves must be SERVED AS SIGNALS and must never be
    // writable customizations — a budget that decides the benchmark tool's
    // verdict is the tool's contract, not a knob a settings write can
    // loosen.
    const signalsByModule = new Map(listSignals().filter((s) => s.module === "performance").map((s) => [s.id, s]));
    const customizationsByModule = new Map(
      listCustomizations()
        .filter((c) => c.module === "performance" && c.configPath !== undefined)
        .map((c) => [c.configPath!, c]),
    );
    const readOnlyBudgets = [
      ["performance.benchmarkRegressionBudgetPercent", "performance.budgets.regressionBudgetPercent"],
      ["performance.benchmarkOverheadBudgetPercent", "performance.budgets.overheadBudgetPercent"],
    ] as const;
    for (const [signalId, path] of readOnlyBudgets) {
      const signal = signalsByModule.get(signalId);
      expect(signal, `${signalId} must be a served signal — the detection budget is visible read-only`).toBeDefined();
      expect(
        customizationsByModule.has(path),
        `${path} must never be a writable customization — a UI write to a detection budget would silently weaken what the benchmark report's verdict means`,
      ).toBe(false);
    }
    // The budget signals read the config document: install a store carrying
    // distinctive budget values and the signals must serve them back.
    installCustomizationConfigStore({
      configFilePath: serverConfig.harnessConfigPath,
      readDocument: () => ({
        performance: { budgets: { regressionBudgetPercent: 12, overheadBudgetPercent: 4 } },
      }),
      writeDocument: () => {},
    });
    expect(signalsByModule.get("performance.benchmarkRegressionBudgetPercent")!.value()).toBe(12);
    expect(signalsByModule.get("performance.benchmarkOverheadBudgetPercent")!.value()).toBe(4);

    // The filed leaves — every disposition restated here is a REASON, not a
    // value: what the leaf would promise, and why nothing delivers it
    // today. Three classes:
    const NO_READER =
      "no code reads this leaf — declared, writable through the gate, consumed by nothing (the zombie class)";
    const COLLECTOR_INERT =
      "the metrics collector honors this leaf, but the only document-fed collector lives in the harness metrics command, which snapshots a fresh process's zero state by design — the web server's live collector is built from the frozen defaults (server/observability/metrics-bridge.ts), so no document-fed path ever records through it";
    const filed: Record<string, string> = {
      "performance.schemaVersion":
        "the section's identity literal — exactly one legal value, not an adjustable behavior",
      "performance.enabled": COLLECTOR_INERT,
      "performance.scope.excludedModules":
        "the manifest generator consumes this leaf, but no production path ever passes the document's section to it — only tests build manifests, with their own configs (a wiring gap, not a served behavior)",
      "performance.sampling.traceSamplingRate": COLLECTOR_INERT,
      "performance.sampling.maxTracesPerScope": COLLECTOR_INERT,
      "performance.sampling.maxTraceDepth": NO_READER,
      "performance.histograms.bucketCount": COLLECTOR_INERT,
      "performance.histograms.maxDurationMs": COLLECTOR_INERT,
      "performance.histograms.bucketStrategy": COLLECTOR_INERT,
      "performance.histograms.explicitBounds": COLLECTOR_INERT,
      "performance.retention.maxSnapshots": NO_READER,
      "performance.retention.maxSnapshotAgeMs": NO_READER,
      "performance.retention.maxRawSamples": NO_READER,
      "performance.exporters.enabledExporters": NO_READER,
      "performance.exporters.exportIntervalMs": NO_READER,
      "performance.exporters.maxExportBatchSize": NO_READER,
      "performance.labelSchema.maxLabelCount": NO_READER,
      "performance.labelSchema.maxLabelLength": COLLECTOR_INERT,
      "performance.labelSchema.forbiddenLabelNames":
        "the label admission gate consumes this list, but the gate is only reached by the document-fed collector that never records (see the collector-inert class) — and emptying a redaction list from a settings cookie is the masker-weakening decision that needs its own safety review before any row",
      "performance.cardinality.maxSeriesPerScope": NO_READER,
      "performance.cardinality.maxTotalSeries": COLLECTOR_INERT,
      "performance.privacy.redactCredentials":
        "the label redactor consumes this switch, but only through the document-fed collector that never records — and a redaction-off switch writable from a settings cookie is the masker-weakening decision that needs its own safety review before any row",
      "performance.privacy.redactPii": NO_READER,
      "performance.privacy.redactPrompts": NO_READER,
      "performance.privacy.redactFileContents": NO_READER,
      "performance.privacy.maxLabelValueLength": NO_READER,
      "performance.backpressure.maxQueueDepth": NO_READER,
      "performance.backpressure.policy": NO_READER,
      "performance.failureBehavior.onCollectorError": NO_READER,
      "performance.failureBehavior.onExporterError": NO_READER,
      "performance.diagnosticModes.modeBudgetMs": NO_READER,
    };

    const rows = new Set(customizationsByModule.keys());
    const signalPaths = new Set<string>(readOnlyBudgets.map(([, path]) => path));
    // The SERVED-BY-SECTION disposition: an array-valued leaf the served-row
    // grammar cannot write (the sheet refuses array JSON by design) gets its
    // own section door — the settings block family's array door. The set is
    // DERIVED from the block's own exported declaration, never restated
    // here, so the census and the door cannot drift.
    const sectionServed = new Set<string>([DIAGNOSTIC_MODES_CONFIG_PATH]);
    const undisposed: string[] = [];
    const wronglyServed: string[] = [];
    for (const path of declared) {
      const isRow = rows.has(path);
      const isSignal = signalPaths.has(path);
      const isSection = sectionServed.has(path);
      const reason = filed[path];
      if (reason === undefined) {
        // No disposition on record: the leaf must be served one of the three
        // sanctioned ways, or it reds until someone disposes of it honestly.
        if (!isRow && !isSignal && !isSection) undisposed.push(path);
        continue;
      }
      // A filed leaf must not be served at all — the filing says the room
      // must not promise it. This is the direction the zombie-registered
      // mutation proves: a leaf filed as unreachable that later appears as a
      // row or a signal is a promise the filing already contradicts.
      if (isRow) wronglyServed.push(`${path}: filed ("${reason}") but served as a writable row`);
      if (isSignal) wronglyServed.push(`${path}: filed ("${reason}") but served as a signal`);
      if (isSection) wronglyServed.push(`${path}: filed ("${reason}") but served by a section door`);
    }
    expect(
      undisposed,
      "every performance.* leaf the contract declares must be a served row, a read-only budget signal, served by a declared section door, or carry a filed reason — a new leaf reds here until it is disposed honestly",
    ).toEqual([]);
    expect(wronglyServed, wronglyServed.join("\n")).toEqual([]);
    // The section-served direction, pinned both ways: the door's declared
    // path must be a real declared leaf (a dropped leaf or a renamed path
    // reds here, not silently), and it must be an ARRAY-typed leaf — the
    // door exists FOR the array shape, and a scalar leaf served by it would
    // be a second grammar where the row grammar already answers.
    const staleSections = [...sectionServed].filter((path) => !declared.has(path));
    expect(
      staleSections,
      "a section door's declared leaf must be a real config leaf — prune the declaration when the schema drops the leaf",
    ).toEqual([]);
    for (const path of sectionServed) {
      const leaf = unwrap((CONFIG_DOCUMENT_SCHEMA as unknown as ShapeLike).shape?.performance)?.shape?.diagnosticModes;
      const inner = unwrap(leaf && (leaf as ShapeLike).shape?.excludedModes);
      expect(
        inner?._def?.type,
        `${path} is served by the array door — the leaf it names must stay array-typed (a scalar would belong to the row grammar)`,
      ).toBe("array");
      expect(
        rows.has(path),
        `${path} is served by a section door and must never also appear as a writable row — one leaf, one grammar`,
      ).toBe(false);
      expect(
        signalPaths.has(path),
        `${path} is served by a section door and must never also appear as a signal — one leaf, one grammar`,
      ).toBe(false);
    }
    // A filed reason that no longer matches a declared leaf is stale prose —
    // the census must not carry dispositions for leaves that no longer exist.
    const stale = Object.keys(filed).filter((path) => !declared.has(path));
    expect(stale, "filed dispositions must name real leaves — prune them when the schema drops a leaf").toEqual([]);
    // And the rows themselves must bind declared paths — the generic arm at
    // the top of this file already checks that for every customization; this
    // one pins the section's family shape: the seven rows, their paths, and
    // the honest effect each consumer actually has.
    const expectedRows: ReadonlyArray<readonly [string, "immediate" | "restart" | "next-run"]> = [
      ["performance.resourceDeltas.enabled", "immediate"],
      ["performance.resourceSampler.enabled", "restart"],
      ["performance.resourceSampler.intervalMs", "restart"],
      ["performance.budgets.minBenchmarkRepetitions", "next-run"],
      ["performance.budgets.maxBenchmarkRepetitions", "next-run"],
      ["performance.budgets.maxBenchmarkDurationMs", "next-run"],
      ["performance.diagnosticModes.modeTimeoutMs", "next-run"],
    ];
    for (const [path, effect] of expectedRows) {
      const knob = customizationsByModule.get(path);
      expect(knob, `${path} must be a served row — its file-fed consumer delivers real behavior`).toBeDefined();
      expect(
        knob!.contract && "effect" in knob!.contract ? knob!.contract.effect : undefined,
        `${path} must declare the timing its consumer actually has`,
      ).toBe(effect);
    }
    expect(rows.size, "the performance module serves exactly its seven disposed rows").toBe(expectedRows.length);
  });

  test("every workspaceGit.* leaf has an honest disposition: a served row, a read-only pinned fact, or a filed reason", () => {
    // The workspaceGit section is the harness's git-door contract — 57
    // declared leaves (the round-21 audit's count, re-derived here by the
    // walk), of which the settings room historically served none. This
    // census is the section's leaf-by-leaf honesty, the performance arm's
    // shape applied to a safety-flavored section: the walk derives the leaf
    // set from the schema (never a restated list), and every leaf must land
    // in exactly one of three dispositions —
    //   (a) a SERVED ROW, for leaves whose file-fed consumer delivers real
    //       behavior through a production door (the three timeout run
    //       bounds the workspace and integrate commands resolve per
    //       invocation);
    //   (b) a READ-ONLY PINNED FACT, for the git executable path — the
    //       binary the doors pin and execute on the user's workspace is
    //       shown, never writable from the room (the executable-path
    //       settings class: a cookie write naming another binary is the
    //       posture-widening decision, not a preference);
    //   (c) a FILED REASON, for every leaf that would today promise
    //       behavior nothing delivers — the no-reader zombies, and the
    //       wiring-gap leaves whose reader code exists but no production
    //       path constructs it.
    // A leaf added to the schema tomorrow reds here until it is registered
    // or filed; a filed leaf that later appears as a row or a signal reds
    // too (the filing says the room must not promise it).
    type ShapeLike = {
      _def?: { type?: string; innerType?: unknown };
      shape?: Record<string, unknown>;
    };
    const unwrap = (schema: unknown): ShapeLike | undefined => {
      let current = schema as ShapeLike | undefined;
      while (current?._def?.type !== undefined && ["optional", "default", "nullable", "readonly"].includes(current._def.type)) {
        current = current._def.innerType as ShapeLike | undefined;
      }
      return current;
    };
    const workspaceGitSchema = unwrap((CONFIG_DOCUMENT_SCHEMA as unknown as ShapeLike).shape?.workspaceGit);
    expect(workspaceGitSchema, "the config document schema must declare the workspaceGit section").toBeDefined();
    const declared = new Set<string>();
    const walk = (schema: ShapeLike, prefix: string): void => {
      for (const [key, leaf] of Object.entries(schema.shape ?? {})) {
        const path = `${prefix}.${key}`;
        const inner = unwrap(leaf);
        if (inner?.shape !== undefined) {
          walk(inner, path);
        } else {
          declared.add(path);
        }
      }
    };
    walk(workspaceGitSchema!, "workspaceGit");
    expect(declared.size, "the workspaceGit section must declare real leaves").toBeGreaterThan(0);

    const signalsByModule = new Map(listSignals().filter((s) => s.module === "workspaceGit").map((s) => [s.id, s]));
    const customizationsByModule = new Map(
      listCustomizations()
        .filter((c) => c.module === "workspaceGit" && c.configPath !== undefined)
        .map((c) => [c.configPath!, c]),
    );

    // The read-only pinned fact: the git executable path must be SERVED AS A
    // SIGNAL and must never be a writable customization — the row would let
    // a settings cookie name the binary the harness executes on the user's
    // workspace, and the pinning machinery cannot tell git from anything
    // else that lives at a path.
    const readOnlyPinned = [
      ["workspaceGit.gitExecutablePath", "workspaceGit.gitExecutablePath"],
    ] as const;
    for (const [signalId, path] of readOnlyPinned) {
      const signal = signalsByModule.get(signalId);
      expect(signal, `${signalId} must be a served signal — the pinned executable is visible read-only`).toBeDefined();
      expect(
        customizationsByModule.has(path),
        `${path} must never be a writable customization — a UI write naming the binary the harness executes on the workspace would silently widen the executable reach of a settings cookie`,
      ).toBe(false);
    }
    // The pinned-fact signal reads the config document: install a store
    // carrying a distinctive executable and the signal must serve it back.
    installCustomizationConfigStore({
      configFilePath: serverConfig.harnessConfigPath,
      readDocument: () => ({
        workspaceGit: { gitExecutablePath: "/opt/pinned-git-under-test/bin/git" },
      }),
      writeDocument: () => {},
    });
    expect(signalsByModule.get("workspaceGit.gitExecutablePath")!.value()).toBe("/opt/pinned-git-under-test/bin/git");

    // The filed leaves — every disposition restated here is a REASON, not a
    // value: what the leaf would promise, and why nothing delivers it today.
    // Two classes, plus the leaves whose reason needs its own sentence:
    const NO_READER =
      "no code reads this leaf — declared, writable through the gate, consumed by nothing (the zombie class)";
    const WIRING_GAP =
      "real reader code exists in the git tools and the workspace lifecycle, but no production path constructs either entry point — only tests build createGitTools and createWorkspaceLifecycle — so the document-fed door that would honor this leaf is unwired";
    const filed: Record<string, string> = {
      "workspaceGit.remoteRoles.fetch.name": NO_READER,
      "workspaceGit.remoteRoles.fetch.urlIdentity": NO_READER,
      "workspaceGit.remoteRoles.fetch.refspecs": NO_READER,
      "workspaceGit.remoteRoles.fetch.branch": NO_READER,
      "workspaceGit.remoteRoles.push.name": NO_READER,
      "workspaceGit.remoteRoles.push.urlIdentity": NO_READER,
      "workspaceGit.remoteRoles.push.refspecs": NO_READER,
      "workspaceGit.remoteRoles.push.branch": NO_READER,
      "workspaceGit.allowedHosts":
        "no code reads this leaf — the remote-url gate checks transports but never hosts — and a host allowlist is gate-family, so when a reader lands it needs the transport-gate safety review before any writable row",
      "workspaceGit.clone.depth": NO_READER,
      "workspaceGit.clone.filter": NO_READER,
      "workspaceGit.clone.rejectShallow": NO_READER,
      "workspaceGit.clone.checkoutPolicy": NO_READER,
      "workspaceGit.clone.submoduleMode": NO_READER,
      "workspaceGit.clone.lfsMode": NO_READER,
      "workspaceGit.reconciliation.mode": NO_READER,
      "workspaceGit.reconciliation.unrelatedHistory": NO_READER,
      "workspaceGit.push.refspecs": NO_READER,
      "workspaceGit.push.atomic": NO_READER,
      "workspaceGit.push.signed": NO_READER,
      "workspaceGit.push.force":
        "the schema pins this leaf to its single legal value false and the git port re-refuses any force request, so it is a written-down invariant, not an adjustable behavior",
      "workspaceGit.push.protectedRefs": NO_READER,
      "workspaceGit.push.leaseCapabilityRef": NO_READER,
      "workspaceGit.timeouts.fetchMs": NO_READER,
      "workspaceGit.timeouts.pushMs": NO_READER,
      "workspaceGit.timeouts.verifyMs": NO_READER,
      "workspaceGit.retries.inspectAttempts": NO_READER,
      "workspaceGit.retries.fetchAttempts": NO_READER,
      "workspaceGit.retries.pushAttempts": NO_READER,
      "workspaceGit.retries.verifyAttempts": NO_READER,
      "workspaceGit.checkpoint.namespace": WIRING_GAP,
      "workspaceGit.checkpoint.retention": NO_READER,
      "workspaceGit.checkpoint.compensation": NO_READER,
      "workspaceGit.credentials.providerRefs": NO_READER,
      "workspaceGit.credentials.allowedMethods": NO_READER,
      "workspaceGit.capabilities.objectFormat": NO_READER,
      "workspaceGit.capabilities.refStorage": NO_READER,
      "workspaceGit.capabilities.credential": NO_READER,
      "workspaceGit.capabilities.host": NO_READER,
      "workspaceGit.capabilities.submodule": NO_READER,
      "workspaceGit.capabilities.lfs": NO_READER,
      "workspaceGit.capabilities.signer": NO_READER,
      "workspaceGit.capabilities.filesystem": NO_READER,
      "workspaceGit.interaction.safeRecommendation": NO_READER,
      "workspaceGit.interaction.approvalRequired": NO_READER,
      "workspaceGit.neverPush.additiveRules":
        "the never-push scan reads this list (the commit and promote guards that refuse to stage or push secret-shaped files), but only through the unwired entry points — and it is a SAFETY LIST: the settings room's array door exists (the diagnostic-modes section, the served-by-section disposition), but a UI write here could remove a rule and widen what the next wired commit may stage, so the wiring AND the gate safety review must both land before any row or section serves it",
      "workspaceGit.allowedTransports":
        "the remote-url gate reads this list (validateRemoteUrl refuses a transport not in it), but only through the unwired git-tools entry point — and a transport allowlist is a gate: when the wiring lands, serving it writable from the room is the loosen-the-gate decision that needs its own safety review first",
      "workspaceGit.defaultBranch": WIRING_GAP,
      "workspaceGit.gitIoLimits.maxOutputBytes": WIRING_GAP,
      "workspaceGit.gitIoLimits.maxErrorBytes": WIRING_GAP,
      "workspaceGit.gitIoLimits.maxInputBytes": WIRING_GAP,
      "workspaceGit.pythonExecutable":
        "no code reads this leaf — the verification environment owns its own frozen python path in root-policy, the safety-invariant file — so this spelling is an inert twin of a deliberately non-configurable fact",
      "workspaceGit.gitAskPass":
        "no code reads this leaf — the verification environment owns its own frozen GIT_ASKPASS in root-policy, the safety-invariant file — so this spelling is an inert twin of a deliberately non-configurable fact",
    };

    const rows = new Set(customizationsByModule.keys());
    const signalPaths = new Set<string>(readOnlyPinned.map(([, path]) => path));
    const undisposed: string[] = [];
    const wronglyServed: string[] = [];
    for (const path of declared) {
      const isRow = rows.has(path);
      const isSignal = signalPaths.has(path);
      const reason = filed[path];
      if (reason === undefined) {
        // No disposition on record: the leaf must be served one of the two
        // sanctioned ways, or it reds until someone disposes of it honestly.
        if (!isRow && !isSignal) undisposed.push(path);
        continue;
      }
      // A filed leaf must not be served at all — the filing says the room
      // must not promise it, in either the row or the signal direction.
      if (isRow) wronglyServed.push(`${path}: filed ("${reason}") but served as a writable row`);
      if (isSignal) wronglyServed.push(`${path}: filed ("${reason}") but served as a signal`);
    }
    expect(
      undisposed,
      "every workspaceGit.* leaf the contract declares must be a served row, a read-only pinned fact, or carry a filed reason — a new leaf reds here until it is disposed honestly",
    ).toEqual([]);
    expect(wronglyServed, wronglyServed.join("\n")).toEqual([]);
    // A filed reason that no longer matches a declared leaf is stale prose —
    // the census must not carry dispositions for leaves that no longer exist.
    const stale = Object.keys(filed).filter((path) => !declared.has(path));
    expect(stale, "filed dispositions must name real leaves — prune them when the schema drops a leaf").toEqual([]);
    // And the rows themselves must bind declared paths with the honest
    // timing each consuming door actually has — the three timeout run
    // bounds, each resolved from the pinned file once per command run.
    const expectedRows: ReadonlyArray<readonly [string, "next-run"]> = [
      ["workspaceGit.timeouts.inspectMs", "next-run"],
      ["workspaceGit.timeouts.addMs", "next-run"],
      ["workspaceGit.timeouts.commitMs", "next-run"],
    ];
    for (const [path, effect] of expectedRows) {
      const knob = customizationsByModule.get(path);
      expect(knob, `${path} must be a served row — its file-fed consumer delivers real behavior`).toBeDefined();
      expect(
        knob!.contract && "effect" in knob!.contract ? knob!.contract.effect : undefined,
        `${path} must declare the timing its consumer actually has`,
      ).toBe(effect);
    }
    expect(rows.size, "the workspaceGit module serves exactly its three disposed rows").toBe(expectedRows.length);
  });

  test("every safety.* leaf has an honest disposition: a served row, a read-only posture or budget signal, or a filed reason", () => {
    // The safety section is the model-facing gate layer — the pre-dispatch
    // tool-call gate and the four event-feed detectors. The round-21 audit
    // counted 50 leaves with 6 served; the walk re-derives the set from the
    // schema (never a restated list) — 49 today, the difference being the
    // one consumerless leaf pruned with this census (the zombie class, the
    // round-46 shape). Every leaf must land in exactly one of —
    //   (a) a SERVED ROW, for the administrative leaves whose consumers
    //       shape how a refusal or a pause behaves (the recovery memory, the
    //       message escalation, the pause-ask interaction) — never whether a
    //       check happens;
    //   (b) a READ-ONLY SIGNAL, in two flavors: the POSTURE leaves (a gate
    //       check or detector's armed state — visible, never a switch; the
    //       weakening values are refused at the write gate, the boot pin,
    //       and the per-run resolution) and the DETECTION BUDGET leaves (a
    //       threshold that decides what a verdict means — the file is the
    //       machine administrator's path, the room never offers the write);
    //   (c) a FILED REASON, for the array leaves (the settings sheet refuses
    //       array JSON by design — the multi-select door decision, the
    //       mcpServers precedent) and the wiring-gap leaves (reader code
    //       exists, no production door constructs it).
    // A leaf added to the schema tomorrow reds here until it is registered
    // or filed; a filed leaf that later appears as a row or a signal reds
    // too (the filing says the room must not promise it); and a posture or
    // budget leaf that appears as a WRITABLE row reds hardest of all — the
    // read-only pin is the room's whole safety doctrine for this section.
    type ShapeLike = {
      _def?: { type?: string; innerType?: unknown };
      shape?: Record<string, unknown>;
    };
    const unwrap = (schema: unknown): ShapeLike | undefined => {
      let current = schema as ShapeLike | undefined;
      while (current?._def?.type !== undefined && ["optional", "default", "nullable", "readonly"].includes(current._def.type)) {
        current = current._def.innerType as ShapeLike | undefined;
      }
      return current;
    };
    const safetySchema = unwrap((CONFIG_DOCUMENT_SCHEMA as unknown as ShapeLike).shape?.safety);
    expect(safetySchema, "the config document schema must declare the safety section").toBeDefined();
    const declared = new Set<string>();
    const walk = (schema: ShapeLike, prefix: string): void => {
      for (const [key, leaf] of Object.entries(schema.shape ?? {})) {
        const path = `${prefix}.${key}`;
        const inner = unwrap(leaf);
        if (inner?.shape !== undefined) {
          walk(inner, path);
        } else {
          declared.add(path);
        }
      }
    };
    walk(safetySchema!, "safety");
    // The audit's 50 minus the one pruned consumerless leaf (the census's
    // own zombie finding, pinned by the engine-side consumption arm).
    expect(declared.size, "the safety section must declare real leaves (50 at the round-21 audit, minus the pruned zombie)").toBe(49);

    const signalsByModule = new Map(listSignals().filter((s) => s.module === "safety").map((s) => [s.id, s]));
    const customizationsByModule = new Map(
      listCustomizations()
        .filter((c) => c.module === "safety" && c.configPath !== undefined)
        .map((c) => [c.configPath!, c]),
    );

    // (b) The read-only tier: the posture leaves (a check's or detector's
    // armed state) and the detection budgets (a verdict's threshold) are
    // SERVED AS SIGNALS reading their config paths — and must NEVER be
    // writable customizations. A settings-cookie write to any of these
    // would either disarm a gate or silently change what a verdict means.
    const readOnlyPinned: ReadonlyArray<readonly [string, string]> = [
      ["safety.gateGhostToolDetection", "safety.toolCallGate.enableGhostToolDetection"],
      ["safety.gateSchemaValidation", "safety.toolCallGate.enableSchemaValidation"],
      ["safety.gateLoopDetection", "safety.toolCallGate.enableLoopDetection"],
      ["safety.familyBandaidArmed", "safety.eventFeed.families.bandaid.enabled"],
      ["safety.familyWorkaroundArmed", "safety.eventFeed.families.workaround.enabled"],
      ["safety.familyDeviationArmed", "safety.eventFeed.families.deviation.enabled"],
      ["safety.familyStepSkipArmed", "safety.eventFeed.families.stepSkip.enabled"],
      ["safety.longCommentCheckArmed", "safety.eventFeed.longCommentDeferredEnabled"],
      ["safety.workaroundToolsMode", "safety.eventFeed.workaroundConsequentialToolsMode"],
      ["safety.gateMaxRepeatCount", "safety.toolCallGate.maxRepeatCount"],
      ["safety.gateLoopWindow", "safety.toolCallGate.loopWindow"],
      ["safety.gateBlockAutoTripAfter", "safety.toolCallGate.blockAutoTripAfter"],
      ["safety.bandaidMinEvents", "safety.eventFeed.families.bandaid.minEvents"],
      ["safety.workaroundMinEvents", "safety.eventFeed.families.workaround.minEvents"],
      ["safety.deviationMinEvents", "safety.eventFeed.families.deviation.minEvents"],
      ["safety.stepSkipMinEvents", "safety.eventFeed.families.stepSkip.minEvents"],
      ["safety.longCommentMinRatio", "safety.eventFeed.longCommentMinRatio"],
      ["safety.longCommentMinCommentLength", "safety.eventFeed.longCommentMinCommentLength"],
      ["safety.bandaidMinRootCauseOverlap", "safety.eventFeed.bandaidMinRootCauseOverlap"],
      ["safety.bandaidMinEditLines", "safety.eventFeed.bandaidMinEditLines"],
      ["safety.workaroundSwitchWindow", "safety.eventFeed.workaroundSwitchWindow"],
      ["safety.deviationMinTaskSimilarity", "safety.eventFeed.deviationMinTaskSimilarity"],
      ["safety.deviationMinTurnsBeforeDeviation", "safety.eventFeed.deviationMinTurnsBeforeDeviation"],
      ["safety.deviationWindowSize", "safety.eventFeed.deviationWindowSize"],
      ["safety.deviationPersistentThreshold", "safety.eventFeed.deviationPersistentThreshold"],
      ["safety.stepSkipEditBeforeReadWindow", "safety.eventFeed.stepSkipEditBeforeReadWindow"],
      ["safety.investigationRootCauseOverlapFloor", "safety.eventFeed.investigationRootCauseOverlapFloor"],
    ];
    for (const [signalId, path] of readOnlyPinned) {
      const signal = signalsByModule.get(signalId);
      expect(signal, `${signalId} must be a served signal — the gate's posture and verdict budgets are visible read-only`).toBeDefined();
      expect(
        customizationsByModule.has(path),
        `${path} must never be a writable customization — a settings-cookie write here would either disarm a safety gate or silently change what its verdict means`,
      ).toBe(false);
    }
    // The pinned signals read the config document: install a store carrying
    // a distinctive value at every pinned path and each signal must serve it
    // back — the read path is live, not a constant face.
    const planted: Record<string, unknown> = {
      safety: {
        toolCallGate: {
          enableGhostToolDetection: true,
          enableSchemaValidation: true,
          enableLoopDetection: true,
          maxRepeatCount: 42,
          loopWindow: 43,
          blockAutoTripAfter: 44,
        },
        eventFeed: {
          families: {
            bandaid: { enabled: true, minEvents: 7 },
            workaround: { enabled: true, minEvents: 8 },
            deviation: { enabled: true, minEvents: 9 },
            stepSkip: { enabled: true, minEvents: 10 },
          },
          longCommentDeferredEnabled: true,
          longCommentMinRatio: 11,
          longCommentMinCommentLength: 12,
          bandaidMinRootCauseOverlap: 0.42,
          bandaidMinEditLines: 13,
          workaroundSwitchWindow: 14,
          workaroundConsequentialToolsMode: "list",
          deviationMinTaskSimilarity: 0.43,
          deviationMinTurnsBeforeDeviation: 15,
          deviationWindowSize: 16,
          deviationPersistentThreshold: 17,
          stepSkipEditBeforeReadWindow: 18,
          investigationRootCauseOverlapFloor: 0.44,
        },
      },
    };
    installCustomizationConfigStore({
      configFilePath: serverConfig.harnessConfigPath,
      readDocument: () => JSON.parse(JSON.stringify(planted)) as Record<string, unknown>,
      writeDocument: () => {},
    });
    const expectSignalValue = (signalId: string, expected: unknown) => {
      expect(signalsByModule.get(signalId)!.value(), `${signalId} must serve the planted config value`).toBe(expected);
    };
    expectSignalValue("safety.gateGhostToolDetection", true);
    expectSignalValue("safety.gateSchemaValidation", true);
    expectSignalValue("safety.gateLoopDetection", true);
    expectSignalValue("safety.familyBandaidArmed", true);
    expectSignalValue("safety.familyWorkaroundArmed", true);
    expectSignalValue("safety.familyDeviationArmed", true);
    expectSignalValue("safety.familyStepSkipArmed", true);
    expectSignalValue("safety.longCommentCheckArmed", true);
    expectSignalValue("safety.workaroundToolsMode", "list");
    expectSignalValue("safety.gateMaxRepeatCount", 42);
    expectSignalValue("safety.gateLoopWindow", 43);
    expectSignalValue("safety.gateBlockAutoTripAfter", 44);
    expectSignalValue("safety.bandaidMinEvents", 7);
    expectSignalValue("safety.workaroundMinEvents", 8);
    expectSignalValue("safety.deviationMinEvents", 9);
    expectSignalValue("safety.stepSkipMinEvents", 10);
    expectSignalValue("safety.longCommentMinRatio", 11);
    expectSignalValue("safety.longCommentMinCommentLength", 12);
    expectSignalValue("safety.bandaidMinRootCauseOverlap", 0.42);
    expectSignalValue("safety.bandaidMinEditLines", 13);
    expectSignalValue("safety.workaroundSwitchWindow", 14);
    expectSignalValue("safety.deviationMinTaskSimilarity", 0.43);
    expectSignalValue("safety.deviationMinTurnsBeforeDeviation", 15);
    expectSignalValue("safety.deviationWindowSize", 16);
    expectSignalValue("safety.deviationPersistentThreshold", 17);
    expectSignalValue("safety.stepSkipEditBeforeReadWindow", 18);
    expectSignalValue("safety.investigationRootCauseOverlapFloor", 0.44);

    // (c) The filed leaves — every disposition restated here is a REASON, not
    // a value. Two classes: the array leaves (the sheet refuses array JSON,
    // so the door decision is the mcpServers-class multi-select round) and
    // the wiring-gap leaves (the learner that reads them has no production
    // caller — the relearn door that would drive it is itself unwired).
    const ARRAY_DOOR =
      "the settings sheet refuses array JSON by design, so this list waits for the multi-select door decision (the mcpServers precedent) — a registered-but-unwritable row would be the dead-on-save control class";
    const WIRING_GAP =
      "the pattern learner reads these bounds, but no production path ever calls the learner — the relearn action that would drive it lives in the bandaid exposure module, which itself has no production caller — so the document-fed door that would honor this leaf is unwired";
    const filed: Record<string, string> = {
      "safety.eventFeed.bandaidPatterns":
        "the bandaid detector compiles these user patterns against added lines — ADDITIVE by design (the default is empty; the structural and learned detectors stay on regardless) — but the settings sheet refuses array JSON, so the multi-select door decision must land before any row",
      "safety.eventFeed.learnedSuppressionPragmas":
        "the detector compiles these LEARNED pragma regexes (mined from the codebase at runtime; empty by default) — a hand-written override would replace what the learner mined, and the settings sheet refuses array JSON, so the multi-select door decision must land before any row",
      "safety.eventFeed.learnedDeferredMarkers":
        "the detector compiles these LEARNED deferred-marker regexes (mined at runtime; empty by default) — a hand-written override would replace what the learner mined, and the settings sheet refuses array JSON, so the multi-select door decision must land before any row",
      "safety.eventFeed.workaroundConsequentialTools":
        "the workaround detector reads this list in 'list' mode (a non-empty list is the one narrowing the posture floor accepts) — the sheet refuses array JSON, so the mode and its list must land together through the multi-select door decision",
      "safety.eventFeed.workaroundManualApproachPatterns":
        "the workaround detector compiles these manual-approach patterns — ADDITIVE by design (the default is empty; AST detection stays on regardless) — but the sheet refuses array JSON, so the multi-select door decision must land before any row",
      "safety.eventFeed.deviationStopwords": ARRAY_DOOR,
      "safety.eventFeed.stepSkipExpectations": ARRAY_DOOR,
      "safety.eventFeed.learnOptions.minSupport": WIRING_GAP,
      "safety.eventFeed.learnOptions.maxPragmaLength": WIRING_GAP,
      "safety.eventFeed.learnOptions.maxDeferredLength": WIRING_GAP,
      "safety.eventFeed.learnOptions.includeLongCommentHeuristic": WIRING_GAP,
    };

    const rows = new Set(customizationsByModule.keys());
    const signalPaths = new Set<string>(readOnlyPinned.map(([, path]) => path));
    const undisposed: string[] = [];
    const wronglyServed: string[] = [];
    for (const path of declared) {
      const isRow = rows.has(path);
      const isSignal = signalPaths.has(path);
      const reason = filed[path];
      if (reason === undefined) {
        // No disposition on record: the leaf must be served one of the two
        // sanctioned ways, or it reds until someone disposes of it honestly.
        if (!isRow && !isSignal) undisposed.push(path);
        continue;
      }
      // A filed leaf must not be served at all — the filing says the room
      // must not promise it, in either the row or the signal direction.
      if (isRow) wronglyServed.push(`${path}: filed ("${reason}") but served as a writable row`);
      if (isSignal) wronglyServed.push(`${path}: filed ("${reason}") but served as a signal`);
    }
    expect(
      undisposed,
      "every safety.* leaf the contract declares must be a served row, a read-only posture or budget signal, or carry a filed reason — a new leaf reds here until it is disposed honestly",
    ).toEqual([]);
    expect(wronglyServed, wronglyServed.join("\n")).toEqual([]);
    // A filed reason that no longer matches a declared leaf is stale prose —
    // the census must not carry dispositions for leaves that no longer exist.
    const stale = Object.keys(filed).filter((path) => !declared.has(path));
    expect(stale, "filed dispositions must name real leaves — prune them when the schema drops a leaf").toEqual([]);
    // And the rows themselves must bind declared paths with the honest
    // timing each consuming door actually has — the top-level knobs feed the
    // module's own live state (immediate), and every per-run consumer (the
    // gate instance, the safety runtime) resolves the pinned file at run
    // start, so the honest timing for the rest is next-run.
    const expectedRows: ReadonlyArray<readonly [string, "immediate" | "next-run"]> = [
      ["safety.threshold", "immediate"],
      ["safety.whitelistEnabled", "immediate"],
      ["safety.groundingEnabled", "immediate"],
      ["safety.failClosed", "immediate"],
      ["safety.groundingMode", "immediate"],
      ["safety.eventFeed.pauseAskWaitTimeoutMs", "next-run"],
      ["safety.toolCallGate.enablePartialArgumentMemory", "next-run"],
      ["safety.toolCallGate.partialArgumentsLimit", "next-run"],
      ["safety.toolCallGate.blockEscalationAfter", "next-run"],
      ["safety.eventFeed.pauseAskEnabled", "next-run"],
      ["safety.eventFeed.pauseAskMaxMessageLength", "next-run"],
    ];
    for (const [path, effect] of expectedRows) {
      const knob = customizationsByModule.get(path);
      expect(knob, `${path} must be a served row — its file-fed consumer delivers real behavior`).toBeDefined();
      expect(
        knob!.contract && "effect" in knob!.contract ? knob!.contract.effect : undefined,
        `${path} must declare the timing its consumer actually has`,
      ).toBe(effect);
    }
    expect(rows.size, "the safety module serves exactly its eleven disposed rows").toBe(expectedRows.length);
  });

  test("every webUi.* leaf has an honest disposition: a served row, a read-only budget signal, or a filed reason", () => {
    // The web-UI tunables section: the code map's knobs, the metrics poll,
    // the self-improving thresholds, the quality composite, the prompt
    // generator's option catalogs, and the performance gate's own budgets.
    // The round-21 audit counted 72 leaves with 54 served and 18 pending;
    // this census disposes of all 72, never trusting the stale count — the
    // walk re-derives the set from the schema. Every leaf must land in
    // exactly one of —
    //   (a) a SERVED ROW: the 54 administrative knobs the graph and quality
    //       modules already serve (the live-read consumers);
    //   (b) a READ-ONLY SIGNAL: the 13 `webUi.performance.*` ceilings —
    //       the perf-profile regression gate's OWN verdict budgets, the
    //       read-only doctrine's sharpest case (a settings write that
    //       loosened one would silently weaken what the gate's green
    //       means; the numbers change through the config file, with the
    //       re-derivation recorded beside the change — the round-59
    //       shape);
    //   (c) a FILED REASON: the 5 `webUi.promptGenerator.*` catalogs —
    //       array-of-object leaves the settings sheet cannot write, whose
    //       consuming panel was deleted at the cutover (the array-door
    //       decision owes the consumer too).
    // A leaf added to the schema tomorrow reds here until it is registered
    // or filed; a filed leaf that later appears as a row or a signal reds
    // too; and a budget leaf that appears as a WRITABLE row reds hardest
    // of all — the read-only pin is this section's whole doctrine.
    type ShapeLike = {
      _def?: { type?: string; innerType?: unknown };
      shape?: Record<string, unknown>;
    };
    const unwrap = (schema: unknown): ShapeLike | undefined => {
      let current = schema as ShapeLike | undefined;
      while (current?._def?.type !== undefined && ["optional", "default", "nullable", "readonly"].includes(current._def.type)) {
        current = current._def.innerType as ShapeLike | undefined;
      }
      return current;
    };
    const webUiSchema = unwrap((CONFIG_DOCUMENT_SCHEMA as unknown as ShapeLike).shape?.webUi);
    expect(webUiSchema, "the config document schema must declare the webUi section").toBeDefined();
    const declared = new Set<string>();
    const walk = (schema: ShapeLike, prefix: string): void => {
      for (const [key, leaf] of Object.entries(schema.shape ?? {})) {
        const path = `${prefix}.${key}`;
        const inner = unwrap(leaf);
        if (inner?.shape !== undefined) {
          walk(inner, path);
        } else {
          declared.add(path);
        }
      }
    };
    walk(webUiSchema!, "webUi");
    // 30 graph + 2 metrics + 5 selfImproving + 13 quality + 4 lintGate +
    // 5 promptGenerator + 13 performance — the walk derives every name.
    expect(declared.size, "the webUi section must declare real leaves (72 at the round-21 audit)").toBe(72);

    // The section's rows live in TWO modules (graph + quality) — the census
    // binds by config path, not by module, so a row moved between modules
    // stays disposed and a row registered anywhere else for a webUi leaf is
    // still caught here.
    const rowsByPath = new Map(
      listCustomizations()
        .filter((c) => c.configPath !== undefined && c.configPath.startsWith("webUi."))
        .map((c) => [c.configPath!, c]),
    );
    const signalsByModule = new Map(listSignals().filter((s) => s.module === "webPerformance").map((s) => [s.id, s]));

    // (b) The read-only tier: the performance gate's own budgets are served
    // as signals reading their config paths — and must NEVER be writable
    // customizations. A settings-cookie write to any of these would loosen
    // the ceiling the regression gate judges the tree by.
    const readOnlyBudgets: ReadonlyArray<readonly [string, string]> = [
      ["webPerformance.lcpMaxMs", "webUi.performance.lcpMaxMs"],
      ["webPerformance.clsMax", "webUi.performance.clsMax"],
      ["webPerformance.longTaskWorstMaxMs", "webUi.performance.longTaskWorstMaxMs"],
      ["webPerformance.longTaskTotalMaxMs", "webUi.performance.longTaskTotalMaxMs"],
      ["webPerformance.tabSwitchMaxMs", "webUi.performance.tabSwitchMaxMs"],
      ["webPerformance.tabDomNodesMax", "webUi.performance.tabDomNodesMax"],
      ["webPerformance.typingMeanMaxMs", "webUi.performance.typingMeanMaxMs"],
      ["webPerformance.apiResponseMaxMs", "webUi.performance.apiResponseMaxMs"],
      ["webPerformance.longSessionHeapGrowthMaxMb", "webUi.performance.longSessionHeapGrowthMaxMb"],
      ["webPerformance.longSessionDomGrowthMax", "webUi.performance.longSessionDomGrowthMax"],
      ["webPerformance.longChatRenderMaxMs", "webUi.performance.longChatRenderMaxMs"],
      ["webPerformance.manyProjectsRenderMaxMs", "webUi.performance.manyProjectsRenderMaxMs"],
      ["webPerformance.viewportLcpMaxMs", "webUi.performance.viewportLcpMaxMs"],
    ];
    for (const [signalId, path] of readOnlyBudgets) {
      const signal = signalsByModule.get(signalId);
      expect(signal, `${signalId} must be a served signal — the performance gate's verdict budgets are visible read-only`).toBeDefined();
      expect(
        rowsByPath.has(path),
        `${path} must never be a writable customization — a settings-cookie write here would silently loosen the ceiling the performance gate judges the tree by`,
      ).toBe(false);
    }
    // The budget signals read the config document: install a store carrying
    // a distinctive value at every budget path and each signal must serve it
    // back — the read path is live, not a constant face.
    const plantedPerformance: Record<string, number> = {
      lcpMaxMs: 1501,
      clsMax: 0.13,
      longTaskWorstMaxMs: 101,
      longTaskTotalMaxMs: 801,
      tabSwitchMaxMs: 201,
      tabDomNodesMax: 8001,
      typingMeanMaxMs: 61,
      apiResponseMaxMs: 251,
      longSessionHeapGrowthMaxMb: 13,
      longSessionDomGrowthMax: 1501,
      longChatRenderMaxMs: 2001,
      manyProjectsRenderMaxMs: 3001,
      viewportLcpMaxMs: 2001,
    };
    const planted = { webUi: { performance: plantedPerformance } };
    installCustomizationConfigStore({
      configFilePath: serverConfig.harnessConfigPath,
      readDocument: () => JSON.parse(JSON.stringify(planted)) as Record<string, unknown>,
      writeDocument: () => {},
    });
    for (const [signalId, path] of readOnlyBudgets) {
      const leaf = path.split(".").pop()!;
      expect(
        signalsByModule.get(signalId)!.value(),
        `${signalId} must serve the planted config value at ${path}`,
      ).toBe(plantedPerformance[leaf]);
    }
    // NO DEFAULTS MIRROR any more (design M8): the
    // config document is the one source of every performance budget; the
    // server accessor refuses an undeclared one by name
    // (tests/unit/harness-config-webui.test.ts pins the refusal).

    // (c) The filed leaves — every disposition restated here is a REASON,
    // not a value. One class: the prompt-generator catalogs are lists of
    // option OBJECTS (id + label + instruction), a shape the settings
    // sheet cannot write at all (it refuses array JSON by design), so the
    // multi-select door decision is their precondition (the mcpServers
    // precedent) — and the panel that consumed the catalog was deleted at
    // the cutover, so the door round owes the consumer too: a readable
    // catalog with no builder to compose it would be the dead-display
    // class, and a registered-but-unwritable row the dead-on-save class.
    const PROMPT_CATALOG_DOOR =
      "a list of option objects the settings sheet cannot write (it refuses array JSON by design), waiting for the multi-select door decision (the mcpServers precedent) — and the panel that consumed this catalog was deleted at the cutover, so the door round owes the composer that reads it too";
    const filed: Record<string, string> = {
      "webUi.promptGenerator.roles": `the prompt composer's role catalog — ${PROMPT_CATALOG_DOOR}`,
      "webUi.promptGenerator.tones": `the prompt composer's tone catalog — ${PROMPT_CATALOG_DOOR}`,
      "webUi.promptGenerator.outputFormats": `the prompt composer's output-format catalog — ${PROMPT_CATALOG_DOOR}`,
      "webUi.promptGenerator.languages": `the prompt composer's language catalog — ${PROMPT_CATALOG_DOOR}`,
      "webUi.promptGenerator.constraints": `the prompt composer's constraint catalog — ${PROMPT_CATALOG_DOOR}`,
    };

    const signalPaths = new Set<string>(readOnlyBudgets.map(([, path]) => path));
    const undisposed: string[] = [];
    const wronglyServed: string[] = [];
    for (const path of declared) {
      const isRow = rowsByPath.has(path);
      const isSignal = signalPaths.has(path);
      const reason = filed[path];
      if (reason === undefined) {
        // No disposition on record: the leaf must be served one of the two
        // sanctioned ways, or it reds until someone disposes of it honestly.
        if (!isRow && !isSignal) undisposed.push(path);
        continue;
      }
      // A filed leaf must not be served at all — the filing says the room
      // must not promise it, in either the row or the signal direction.
      if (isRow) wronglyServed.push(`${path}: filed ("${reason}") but served as a writable row`);
      if (isSignal) wronglyServed.push(`${path}: filed ("${reason}") but served as a signal`);
    }
    expect(
      undisposed,
      "every webUi.* leaf the contract declares must be a served row, a read-only budget signal, or carry a filed reason — a new leaf reds here until it is disposed honestly",
    ).toEqual([]);
    expect(wronglyServed, wronglyServed.join("\n")).toEqual([]);
    // A filed reason that no longer matches a declared leaf is stale prose —
    // the census must not carry dispositions for leaves that no longer exist.
    const stale = Object.keys(filed).filter((path) => !declared.has(path));
    expect(stale, "filed dispositions must name real leaves — prune them when the schema drops a leaf").toEqual([]);
    // And the rows themselves: every webUi.* row binds a declared path (the
    // generic arm at the top of this file already checks that), every one
    // of them declares the honest `immediate` timing (each consumer reads
    // the live config per call — the graph layout, the metrics poll, the
    // analyzer, the quality bridge), and the count is the arithmetic the
    // census derives: 72 declared − 13 budget signals − 5 filed = 54 rows.
    expect(rowsByPath.size, "the webUi section serves exactly its fifty-four disposed rows (72 leaves minus 13 read-only budgets minus 5 filed catalogs)").toBe(72 - readOnlyBudgets.length - Object.keys(filed).length);
    for (const [path, knob] of rowsByPath) {
      expect(
        knob.contract && "effect" in knob.contract ? knob.contract.effect : undefined,
        `${path} must declare the timing its live-read consumer actually has`,
      ).toBe("immediate");
    }
  });

  test("every testExecution/harness/evaluation/resourceLock/qualityPacks/contracts/data/state/project/agents leaf has an honest disposition: a served row, a read-only budget signal, or a filed reason", () => {
    // The UIE-070 class — the last tranche of the round-21 everything-
    // exposed audit: the test/evaluation machinery's own budgets and the
    // runner's bounds, the harness command doors' bounds, the agents
    // orchestration section, and the infra-identity sections (contracts,
    // data, state, project, schemaVersion, alignmentCheckpoint) the audit
    // filed as "not behaviors". This census re-derives every leaf from the
    // schema (never trusting the audit's counts) and disposes of each:
    //   (a) a SERVED ROW — the runner's run bounds and the command doors'
    //       bounds (fresh-process consumers, next-run), and the agents
    //       orchestration knobs (the web bridge reads the section live per
    //       call, immediate);
    //   (b) a READ-ONLY BUDGET SIGNAL — the leaves that decide what the
    //       suites' own gates' green MEANS: the web suite's rolling CPU
    //       baseline (its recorded floor, its population, its window, the
    //       drift tolerance, the noise band and the ratchet count), the
    //       per-file worker-time share cap, the flaky-test lookback window,
    //       and the engine suite's own budget phase (the round-39/63
    //       doctrine: a settings write that loosened one would silently
    //       weaken the verdict — shown, never writable);
    //   (c) a FILED REASON — the union leaf no scalar row can spell, the
    //       host-derived-default leaf, the default-less pruning bounds, the
    //       wiring-gap leaves whose consumer never receives the document's
    //       value, the array leaves the sheet cannot write, the wire
    //       contracts and infra identity the file owns, and the
    //       no-reader-zombie checkpoint cadence.
    // A leaf added to any of these sections tomorrow reds here until it is
    // disposed honestly; a filed leaf served as a row or a signal reds too.
    type ShapeLike = {
      _def?: { type?: string; innerType?: unknown };
      shape?: Record<string, unknown>;
    };
    const unwrap = (schema: unknown): ShapeLike | undefined => {
      let current = schema as ShapeLike | undefined;
      while (current?._def?.type !== undefined && ["optional", "default", "nullable", "readonly"].includes(current._def.type)) {
        current = current._def.innerType as ShapeLike | undefined;
      }
      return current;
    };
    const documentShape = (CONFIG_DOCUMENT_SCHEMA as unknown as ShapeLike).shape ?? {};
    const declared = new Set<string>();
    const walk = (schema: ShapeLike, prefix: string): void => {
      for (const [key, leaf] of Object.entries(schema.shape ?? {})) {
        const path = prefix === "" ? key : `${prefix}.${key}`;
        const inner = unwrap(leaf);
        if (inner?.shape !== undefined) {
          walk(inner, path);
        } else {
          declared.add(path);
        }
      }
    };
    // The class's section census — every count is the MEASURED walk's own
    // value (re-derived here, pinned as a number, never a re-imported
    // constant: the walk is the derivation, this map is the record).
    const expectedSectionCounts: Readonly<Record<string, number>> = {
      // 24 → 23: the watchdog's wall-clock verdict (two leaves) became one
      // hard ceiling (wf1a-design M-1). 23 → 25: the engine suite's own
      // watchdog (engineSuiteWatchdog: a stall bound and a hard ceiling).
      // 29 → 30: the instrument lock's poll interval (the one instrument lock: the wait's
      // pace is config, never a literal default in code). 30 → 31: the flaky-cause
      // reproduction door's statistical N (FLAKE-REPRO). 31 → 30: the CPU streak
      // (`overCapRunsBeforeRed`) and the flaky lookback window
      // (`flakyTestLookbackRuns`) deleted (UR-24-BUDGETS; design NH-E), the
      // reproduction door's α (`flakeReproduction.significance`) added. 30 → 32:
      // the instruments heavy by kind (`instrumentLock.wholeInstruments`)
      // and the deterministic shims (`flakeReproduction.deterministicShims`).
      // 32 → 26: `webUiSuiteCpuBudget` became a phase-dependent UNION
      // (accumulation | rolling). The census walks `strictObject` shapes; a
      // union is ONE declared leaf to it, so its branch leaves are not
      // counted here — the budget's own tests assert the branches' required
      // fields and the signals read them directly. 26 → 29: the per-test
      // limits (TEST-CPU-CLASSES): the default CPU ceiling, the classes
      // (one array leaf) and the hang backstop, all served read-only.
      testExecution: 30, // 29 → 30: the instrument lock's poll interval became the per-run caps (memoryMaxPercent, cpuWeight; NO-LOAD-BLOCK)
      // 1 → 3: the ONE command runner's errored-class retries (PROMO-1).
      // 3 → 2: the typecheck's wall limit (`typecheckTimeoutMs`) deleted; a
      // typecheck is bounded by CPU work and one hang backstop (NO-LOAD-BLOCK A-17).
      harness: 9,
      evaluation: 2,
      resourceLock: 3,
      qualityPacks: 1,
      contracts: 17,
      data: 1,
      state: 2,
      project: 2,
      schemaVersion: 1,
      alignmentCheckpoint: 7,
      agents: 5,
    };
    const sectionCounts: Record<string, number> = {};
    for (const section of Object.keys(expectedSectionCounts)) {
      sectionCounts[section] = 0;
      const sectionSchema = unwrap(documentShape[section]);
      expect(sectionSchema, `the config document schema must declare the ${section} section`).toBeDefined();
      const before = declared.size;
      if (sectionSchema!.shape !== undefined) {
        walk(sectionSchema!, section);
      } else {
        // A section that is itself a leaf (schemaVersion's policy literal):
        // the leaf IS the section, at the top level of the document.
        declared.add(section);
      }
      sectionCounts[section] = declared.size - before;
    }
    expect(sectionCounts, "each section must declare exactly its measured leaves — a new leaf reds its own section here").toEqual(expectedSectionCounts);
    expect(declared.size, "the class's twelve sections declare eighty leaves in total").toBe(80);

    // The class's rows live in THREE modules (testExecution,
    // harnessCommands, agents) spanning FIVE sections — the census binds
    // by config path, never by module, so a row moved between modules stays
    // disposed and a row registered anywhere else for a class leaf is
    // still caught here.
    const rowsByPath = new Map(
      listCustomizations()
        .filter((c) => c.configPath !== undefined && declared.has(c.configPath))
        .map((c) => [c.configPath!, c]),
    );
    const signalsByModule = new Map(listSignals().filter((s) => s.module === "testExecution").map((s) => [s.id, s]));

    // (b) The read-only tier: the budget leaves are served as signals
    // reading their config paths — and must NEVER be writable
    // customizations, at the leaf, at any sub-field, or at the parent
    // object a customization could otherwise bind whole.
    const readOnlyBudgets: ReadonlyArray<readonly [string, string]> = [
      ["testExecution.webSuiteCpuCap", "testExecution.webUiSuiteCpuBudget.baselineFloorMsPerTestFile"],
      ["testExecution.webSuiteBaselineWindow", "testExecution.webUiSuiteCpuBudget.baselineWindowRuns"],
      ["testExecution.webSuiteCpuPopulation", "testExecution.webUiSuiteCpuBudget.derivedAtTestFileCount"],
      ["testExecution.webSuitePopulationDriftTolerance", "testExecution.webUiSuiteCpuBudget.maxPopulationDriftFraction"],
      ["testExecution.webSuiteNoiseSpread", "testExecution.webUiSuiteCpuBudget.sameTreeSpreadFraction"],
      ["testExecution.webSuiteAmbientInflationSlope", "testExecution.webUiSuiteCpuBudget.ambientInflationSlopePerCpu"],
      ["testExecution.webSuiteAmbientInflationCap", "testExecution.webUiSuiteCpuBudget.ambientInflationCapFraction"],
      ["testExecution.webTestFileCostShareMax", "testExecution.webUiTestFileCostShareMax"],
      ["testExecution.integrationSuiteBudgetPhase", "testExecution.integrationSuiteCpuBudget"],
      ["testExecution.webSuiteStallTimeout", "testExecution.webSuiteWatchdog.stallTimeoutMs"],
      ["testExecution.webSuiteHardCeiling", "testExecution.webSuiteWatchdog.hardCeilingMs"],
      ["testExecution.engineSuiteStallTimeout", "testExecution.engineSuiteWatchdog.stallTimeoutMs"],
      ["testExecution.engineSuiteHardCeiling", "testExecution.engineSuiteWatchdog.hardCeilingMs"],
      ["testExecution.webSuiteKillGrace", "testExecution.webSuiteWatchdog.killGraceMs"],
      ["testExecution.engineSuiteKillGrace", "testExecution.engineSuiteWatchdog.killGraceMs"],
      ["testExecution.instrumentLockFile", "testExecution.instrumentLock.cacheRelativeLockPath"],
      ["testExecution.instrumentLockHeavyAt", "testExecution.instrumentLock.minimumTestFiles"],
      ["testExecution.perRunMemoryCap", "testExecution.instrumentLock.perRun.memoryMaxPercent"],
      ["testExecution.perRunCpuWeight", "testExecution.instrumentLock.perRun.cpuWeight"],
      ["testExecution.flakeReproductionRuns", "testExecution.flakeReproduction.statisticalRuns"],
      ["testExecution.flakeReproductionSignificance", "testExecution.flakeReproduction.significance"],
      ["testExecution.instrumentLockWholeInstruments", "testExecution.instrumentLock.wholeInstruments"],
      ["testExecution.flakeReproductionShims", "testExecution.flakeReproduction.deterministicShims"],
      ["testExecution.testCpuDefaultCeiling", "testExecution.testCpuClasses.defaultCeilingMs"],
      ["testExecution.testCpuClasses", "testExecution.testCpuClasses.classes"],
      ["testExecution.testHangBackstop", "testExecution.testHangBackstopMs"],
    ];
    const neverWritablePrefixes = [
      "testExecution.webUiSuiteCpuBudget",
      "testExecution.integrationSuiteCpuBudget",
      "testExecution.webUiTestFileCostShareMax",
      "testExecution.webSuiteWatchdog",
      "testExecution.engineSuiteWatchdog",
      "testExecution.instrumentLock",
      "testExecution.flakeReproduction",
      "testExecution.testCpuClasses",
      "testExecution.testHangBackstopMs",
    ];
    for (const customization of listCustomizations()) {
      const path = customization.configPath;
      if (path === undefined) continue;
      const budgetBound = neverWritablePrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));
      expect(
        budgetBound,
        `${path} must never be a writable customization — a settings-cookie write here would silently weaken what the suite gates' green means`,
      ).toBe(false);
    }
    for (const [signalId, path] of readOnlyBudgets) {
      const signal = signalsByModule.get(signalId);
      expect(signal, `${signalId} must be a served signal — the suite gates' own verdict budgets are visible read-only`).toBeDefined();
      expect(
        rowsByPath.has(path),
        `${path} must never be a writable customization — a settings-cookie write here would silently loosen the ceiling a suite gate judges the tree by`,
      ).toBe(false);
    }
    // The budget signals read the config document: install a store carrying
    // distinctive values at every budget path and each signal must serve
    // them back — the read path is live, not a constant face.
    const plant = (testExecution: Record<string, unknown>) =>
      installCustomizationConfigStore({
        configFilePath: serverConfig.harnessConfigPath,
        readDocument: () => JSON.parse(JSON.stringify({ testExecution })) as Record<string, unknown>,
        writeDocument: () => {},
      });
    plant({
      webUiSuiteCpuBudget: {
        metric: "calibrated-work/v1",
        calibrationDriftMaxFraction: 0.15,
        validThroughLoad5PerCpu: 1.25,
        baselineFloorUnitsPerTestFile: 1616,
        derivedAtTestFileCount: 481,
        maxPopulationDriftFraction: 0.031,
        sameTreeSpreadFraction: 0.027,
        baselineWindowRuns: 13,
        ambientInflationSlopePerCpu: 0.055,
        ambientInflationCapFraction: 0.13,
      },
      webUiTestFileCostShareMax: 0.06,
      integrationSuiteCpuBudget: { phase: "accumulation", minimumJudgedRuns: 6, maxPopulationDriftFraction: 0.031 },
      webSuiteWatchdog: { stallTimeoutMs: 240_000, hardCeilingMs: 1_500_000, killGraceMs: 2_000 },
      engineSuiteWatchdog: { stallTimeoutMs: 250_000, hardCeilingMs: 1_600_000, killGraceMs: 4_000 },
      instrumentLock: { cacheRelativeLockPath: "planted/instrument.lock", minimumTestFiles: 3, wholeInstruments: ["playwright", "coverage"], perRun: { memoryMaxPercent: 37, cpuWeight: 42 } },
      flakeReproduction: { statisticalRuns: 7, significance: 0.02, deterministicShims: ["engine/test/support/planted-shim.ts"] },
    });
    const expectSignal = (signalId: string, expected: unknown) => {
      expect(signalsByModule.get(signalId)!.value(), `${signalId} must serve the planted config value`).toBe(expected);
    };
    expectSignal("testExecution.instrumentLockFile", "<cache>/planted/instrument.lock");
    expectSignal("testExecution.instrumentLockHeavyAt", "a run of 3 or more test files is heavy");
    expectSignal("testExecution.perRunMemoryCap", "a heavy run may use at most 37% of the host's memory");
    expectSignal("testExecution.perRunCpuWeight", "a heavy run's CPU weight is 42");
    expectSignal("testExecution.flakeReproductionRuns", "7 runs on each side of a statistical reproduction");
    expectSignal("testExecution.flakeReproductionSignificance", "a reproduction counts only when a no-op fix shows its counts at most 0.02 of the time");
    expectSignal("testExecution.instrumentLockWholeInstruments", "heavy by kind: playwright, coverage");
    expectSignal("testExecution.flakeReproductionShims", "deterministic shims: engine/test/support/planted-shim.ts");
    expectSignal(
      "testExecution.webSuiteCpuCap",
      "1616 calibration units of work per test file (calibrated-work/v1) — the cap",
    );
    expectSignal("testExecution.webSuiteBaselineWindow", "the stale-floor check reads the median of the last 13 clean judged runs");
    expectSignal("testExecution.webSuiteCpuPopulation", "judged against 481 test files");
    expectSignal("testExecution.webSuitePopulationDriftTolerance", "3.1% suite-size drift before re-deriving");
    expectSignal("testExecution.webSuiteNoiseSpread", "2.7% same-tree spread decides which runs feed the baseline");
    // No streak count is exposed: one judged run over the cap fails (UR-24-BUDGETS).
    expect(signalsByModule.has("testExecution.webSuiteOverCapStreak")).toBe(false);
    expectSignal(
      "testExecution.webSuiteAmbientInflationSlope",
      "the gate pays 5.5% more allowance per unit of recorded 5-minute ambient load per CPU",
    );
    expectSignal("testExecution.webSuiteAmbientInflationCap", "the ambient allowance is capped at 13.0% of the baseline");
    expectSignal("testExecution.webTestFileCostShareMax", "one test file may take at most 6% of the pool's worker time");
    expectSignal("testExecution.integrationSuiteBudgetPhase", "accumulation — at least 6 judged runs before the cap is derived");
    expectSignal("testExecution.webSuiteStallTimeout", "a run that prints nothing for 240 s is killed");
    expectSignal("testExecution.webSuiteHardCeiling", "a run still going after 1500 s is killed");
    expectSignal("testExecution.engineSuiteStallTimeout", "a phase that reports nothing for 250 s is killed");
    expectSignal("testExecution.engineSuiteHardCeiling", "a run still going after 1600 s is killed");
    expectSignal("testExecution.webSuiteKillGrace", "a stopped run has 2 s before it is killed");
    expectSignal("testExecution.engineSuiteKillGrace", "a stopped run has 4 s before it is killed");
    // The engine suite's budget is a UNION — both shapes must read live.
    plant({
      integrationSuiteCpuBudget: {
        phase: "derived",
        metric: "calibrated-work/v1",
        calibrationDriftMaxFraction: 0.15,
        validThroughLoad5PerCpu: 1.25,
        unitsPerTestFile: 1500,
        derivedAtTestFileCount: 480,
        maxPopulationDriftFraction: 0.03,
        ambientInflationSlopePerCpu: 0,
        ambientInflationCapFraction: 0,
      },
    });
    expectSignal("testExecution.integrationSuiteBudgetPhase", "derived — 1500 calibration units of work per test file over 480 files");
    // And the honest absence: these leaves are default-less BY DESIGN, so a
    // document without them must state the refusal in words, never invent
    // a number.
    plant({});
    const NOT_DECLARED =
      "not declared — the gate that reads it refuses to judge a run until it is measured and set in the config file";
    // The engine suite's watchdog is the one read-only budget WITH a default
    // (like its sibling per-test kill timeout): absent, it says the default applies.
    const withDefault = new Set(["testExecution.engineSuiteStallTimeout", "testExecution.engineSuiteHardCeiling", "testExecution.engineSuiteKillGrace"]);
    for (const [signalId] of readOnlyBudgets) {
      if (!withDefault.has(signalId)) expectSignal(signalId, NOT_DECLARED);
    }
    expectSignal("testExecution.engineSuiteStallTimeout", "not declared — the default applies: a phase that reports nothing for 300 s is killed");
    expectSignal("testExecution.engineSuiteHardCeiling", "not declared — the default applies: a run still going after 1800 s is killed");
    expectSignal("testExecution.engineSuiteKillGrace", "not declared — the default applies: a stopped run has 3 s before it is killed");

    // (c) The filed leaves — every disposition restated here is a REASON,
    // not a value.
    const UNION_VALUE_SPACE =
      "the value space is a union the settings sheet cannot spell honestly — 'auto' (a word), false (a switch) or a bounded whole number in one leaf; a row of any scalar type could write only one spelling, and its return-to-default ('auto') would fail the row's own validation, so the union waits for its own door decision";
    const HOST_DERIVED_DEFAULT =
      "the designed default is derived from the machine's own parallelism at each run (the runner clamps it into 2..16 — engine/src/workflow/test-result-collector.ts:553), so a settings row would present a host-derived number as a contract default; the override stays a file edit, the same class as the 'auto' spelling it shadows";
    const DEFAULTLESS_BOUND =
      "the pruning bounds are deliberately default-less in their consuming owner (absent means no pruning plus a printed note naming the key — a bound nobody chose is not a bound), and a settings row must declare a default: the omit-on-default write would prune the operator's chosen bound and present the file's current choice as the contract's default";
    const WIRE_IDENTITY =
      "a literal pinned to the root policy with exactly one legal value — the wire identity, not an adjustable behavior (the schemaVersion class)";
    const WIRE_VOCABULARY =
      "the wire vocabulary both trees agree on; changing it from a settings cookie changes the protocol the harness speaks — the deliberate-fix decision this class's filing asked for, and the config file is the record";
    const filed: Record<string, string> = {
      "testExecution.concurrency": UNION_VALUE_SPACE,
      "testExecution.parallelConcurrency": HOST_DERIVED_DEFAULT,
      "testExecution.compileCachePruning.maxEntryAgeDays": DEFAULTLESS_BOUND,
      "testExecution.compileCachePruning.maxEntries": DEFAULTLESS_BOUND,
      "testExecution.compileCachePruning.timeBudgetMs": DEFAULTLESS_BOUND,
      "evaluation.maxOutputTokens":
        "the wiring gap: the matrix generator accepts an output-token knob, but no production path forwards the document's evaluation.maxOutputTokens into it (the evaluation CLI builds its matrix config without the field — engine/src/evaluation/cli.ts:173-174), so a settings row would read as saved and do nothing",
      "testExecution.webUiSuiteCpuBudget":
        "a PHASE-DEPENDENT UNION (accumulation | rolling) that the census walks as one leaf; its branch leaves are read by the budget's leaf signals (metric, floor, window, population, drift, spread, slopes), but the union itself must not be a writable row — a settings write would have to choose the phase and rewrite every branch field at once, which is the measuring tool's job, not a settings-cookie write",
      "qualityPacks.enabled":
        "the quality-pack registry factory reads the enabled-packs list (engine/src/runtime/quality-tools.ts:93), but no production path constructs it with the document's section — AND the leaf is an array of pack ids the settings sheet refuses by design, so both the wiring and the multi-select door must land before any row",
      "agents.profiles":
        "an array of agent-profile objects — an entity list the settings sheet cannot write (it refuses array JSON by design); it waits for the mcpServers-class add/edit/remove door, which owes the profiles editor too",
      "contracts.preferredModelProtocol": WIRE_VOCABULARY,
      "contracts.enabledProtocols": WIRE_VOCABULARY,
      "contracts.schemaDialect": WIRE_IDENTITY,
      "contracts.endpoints.chatCompletions": WIRE_IDENTITY,
      "contracts.endpoints.responses": WIRE_IDENTITY,
      "contracts.mcpProtocolVersion": WIRE_IDENTITY,
      "contracts.chatStreamDoneSentinel": WIRE_IDENTITY,
      "contracts.responsesStore": WIRE_IDENTITY,
      "contracts.unknownMetadataClassification": WIRE_IDENTITY,
      "contracts.limits.maximumIdentifierCharacters": WIRE_VOCABULARY,
      "contracts.limits.maximumTextCharacters": WIRE_VOCABULARY,
      "contracts.limits.maximumTools": WIRE_VOCABULARY,
      "contracts.limits.maximumMessages": WIRE_VOCABULARY,
      "contracts.limits.maximumEvents": WIRE_VOCABULARY,
      "contracts.limits.maximumToolSchemaDepth": WIRE_VOCABULARY,
      "contracts.limits.maximumToolSchemaProperties": WIRE_VOCABULARY,
      "contracts.limits.maximumLosses": WIRE_VOCABULARY,
      "data.defaultClassification":
        "the default privacy classification for harness data — a privacy-shaping decision (the classification decides how payloads are treated), read only by the engine's preflight receipt (engine/src/kernel/preflight.ts:161); the deliberate classification choice stays a file edit",
      "state.root":
        "a literal pinned to the state path the harness boots against (read at engine/src/runtime/harness-bootstrap.ts:113 and the workflow doors) — one legal value, the infra-identity class",
      "state.receipts.executionEvidence":
        "a literal pinned to the evidence-receipts path the workflow doors write under — one legal value, the infra-identity class",
      "project.id":
        "the harness's own project identity, read at preflight (engine/src/kernel/preflight.ts:164-165, :254-265) — infra identity, not an adjustable behavior",
      "project.root":
        "a literal pinned to the project-root policy value — one legal value, the infra-identity class",
      "schemaVersion":
        "the config document's own version literal, pinned by the policy — exactly one legal value (the identity class)",
      "alignmentCheckpoint.cadence.maximumEventsBetweenCheckpoints":
        "no production code reads document.alignmentCheckpoint — the cadence, budgets and observer profile are declared, write-gated and shipped in the file, consumed by nothing (the no-reader zombie class); the alignment-checkpoint machinery they describe is unwired, and pruning a required section is a schema redesign this census pins, not makes",
      "alignmentCheckpoint.cadence.maximumActionsBetweenCheckpoints":
        "no production code reads document.alignmentCheckpoint — declared, write-gated, shipped, consumed by nothing (the no-reader zombie class)",
      "alignmentCheckpoint.cadence.maximumProviderInputTokensBetweenCheckpoints":
        "no production code reads document.alignmentCheckpoint — declared, write-gated, shipped, consumed by nothing (the no-reader zombie class)",
      "alignmentCheckpoint.cadence.maximumWallClockSecondsBetweenSafeBoundaryChecks":
        "no production code reads document.alignmentCheckpoint — declared, write-gated, shipped, consumed by nothing (the no-reader zombie class)",
      "alignmentCheckpoint.budgets.maximumProjectionBytes":
        "no production code reads document.alignmentCheckpoint — declared, write-gated, shipped, consumed by nothing (the no-reader zombie class)",
      "alignmentCheckpoint.budgets.maximumObserverInputTokens":
        "no production code reads document.alignmentCheckpoint — declared, write-gated, shipped, consumed by nothing (the no-reader zombie class)",
      "alignmentCheckpoint.observerProfile":
        "no production code reads document.alignmentCheckpoint — declared, write-gated, shipped, consumed by nothing (the no-reader zombie class)",
    };

    const signalPaths = new Set<string>(readOnlyBudgets.map(([, path]) => path));
    const undisposed: string[] = [];
    const wronglyServed: string[] = [];
    for (const path of declared) {
      const isRow = rowsByPath.has(path);
      const isSignal = signalPaths.has(path);
      const reason = filed[path];
      if (reason === undefined) {
        // No disposition on record: the leaf must be served one of the two
        // sanctioned ways, or it reds until someone disposes of it honestly.
        if (!isRow && !isSignal) undisposed.push(path);
        continue;
      }
      // A filed leaf must not be served at all — the filing says the room
      // must not promise it, in either the row or the signal direction.
      if (isRow) wronglyServed.push(`${path}: filed ("${reason}") but served as a writable row`);
      if (isSignal) wronglyServed.push(`${path}: filed ("${reason}") but served as a signal`);
    }
    expect(
      undisposed,
      "every UIE-070 class leaf the contract declares must be a served row, a read-only budget signal, or carry a filed reason — a new leaf reds here until it is disposed honestly",
    ).toEqual([]);
    expect(wronglyServed, wronglyServed.join("\n")).toEqual([]);
    // A filed reason that no longer matches a declared leaf is stale prose —
    // the census must not carry dispositions for leaves that no longer exist.
    const stale = Object.keys(filed).filter((path) => !declared.has(path));
    expect(stale, "filed dispositions must name real leaves — prune them when the schema drops a leaf").toEqual([]);
    // And the rows themselves: the partition's arithmetic, every row's
    // honest timing (the runner and command doors resolve the pinned file
    // once per fresh-process invocation; the agents bridge re-reads the
    // file live per call), the defaults-mirror — each row's declared
    // default must equal the value its consuming door serves when the key
    // is absent, pinned here as VALUES (never re-imported constants) — and
    // the unit each row's control prints beside its number: the settings
    // room renders "N <unit>" in its provenance sentence, so a lane-count
    // row declaring "milliseconds" makes the room speak a duration for a
    // count. The unit is pinned as the literal word, per row, the same
    // severance-proof shape as the default.
    // PINNED as the measured count: the census walks the phase-dependent
    // `webUiSuiteCpuBudget` union as ONE leaf, so the leaves it used to
    // contribute individually are no longer in `declared` and a subtraction
    // from that set would promise a partition it no longer has. The loops
    // above already assert every declared leaf is a row, a signal or filed,
    // and that a filed leaf is never served; this pin is the row count.
    expect(rowsByPath.size, "the class serves exactly its twenty-two disposed rows").toBe(22);
    const expectedRows: ReadonlyArray<readonly [string, "immediate" | "next-run", unknown, string | undefined]> = [
      ["testExecution.runtimeBudgetMs", "next-run", 120000, "milliseconds"],
      ["testExecution.serialPhaseConcurrency", "next-run", 2, "lanes"],
      ["testExecution.fullSuiteSerialPhaseConcurrency", "next-run", 8, "lanes"],
      ["testExecution.fullSuiteInProcessSerialPhaseConcurrency", "next-run", 4, "lanes"],
      ["testExecution.fullSuiteParallelConcurrency", "next-run", 12, "lanes"],
      ["harness.commandErroredRetries", "next-run", 2, "retries"],
      ["harness.commandRetryBackoffMs", "next-run", 60000, "milliseconds"],
      ["harness.subprocessBounds.cpuBudgetMs", "next-run", 1800000, "milliseconds"],
      ["harness.subprocessBounds.minimumCpuRate", "next-run", 0.05, "fraction"],
      ["harness.subprocessBounds.stallMs", "next-run", 1800000, "milliseconds"],
      ["harness.subprocessBounds.hangBackstopMs", "next-run", 7200000, "milliseconds"],
      ["harness.subprocessBounds.pollMs", "next-run", 1000, "milliseconds"],
      ["harness.subprocessBounds.killGraceMs", "next-run", 5000, "milliseconds"],
      ["harness.subprocessBounds.outputBytes", "next-run", 268435456, "bytes"],
      ["resourceLock.timeoutMs", "next-run", 120000, "milliseconds"],
      ["resourceLock.pollIntervalMs", "next-run", 100, "milliseconds"],
      ["resourceLock.staleMs", "next-run", 300000, "milliseconds"],
      ["evaluation.identityAttestationTimeoutMs", "next-run", 30000, "milliseconds"],
      ["agents.maximumConcurrentAgents", "immediate", 0, "agents"],
      ["agents.orchestration.alignmentMonitorIntervalMs", "immediate", 30000, "milliseconds"],
      ["agents.orchestration.alignmentDriftThresholdMs", "immediate", 60000, "milliseconds"],
      ["agents.orchestration.conflictDetectionEnabled", "immediate", true, undefined],
    ];
    for (const [path, effect, defaultValue, unit] of expectedRows) {
      const knob = rowsByPath.get(path);
      expect(knob, `${path} must be a served row — its file-fed consumer delivers real behavior`).toBeDefined();
      expect(
        knob!.contract && "effect" in knob!.contract ? knob!.contract.effect : undefined,
        `${path} must declare the timing its consumer actually has`,
      ).toBe(effect);
      expect(knob!.default, `${path} must declare the default its consuming door serves when the key is absent`).toEqual(defaultValue);
      expect(knob!.unit, `${path} must declare the unit its quantity actually is — the room prints "N ${unit === undefined ? "on/off" : unit}" for this row, and any other word would misname the number`).toBe(unit);
    }
    expect(rowsByPath.size, "the class's row table names every served row exactly once").toBe(expectedRows.length);
  });
});
