// @vitest-environment node
/**
 * Drift-prevention test for the exposure surface — every registered signal,
 * action and customization, and the modules they belong to, all wired.
 *
 * NO SIZE IS WRITTEN HERE. This sentence used to say "110 signals, 55 actions,
 * 88 customizations across 11 modules" while the floors below stood at
 * 119/61/96/12 and the live surface was larger still, so the first thing a
 * reader learned about this file was four numbers that had all moved. The
 * ratchet floors are the only figures in this file, they are named constants,
 * and the failure messages report what the run actually measured.
 *
 * WHAT THIS GUARDS, AND WHY IT IS A RATCHET RATHER THAN A PIN
 *
 * The binding architectural guideline is "expose as many events, signals,
 * options and actions as possible... single source of truth for everything",
 * with the exposure registry as that source and the UI, the LLM tool
 * manifest, the docs and these tests as PROJECTIONS of it. Adding a
 * capability must therefore be cheap and safe.
 *
 * This test previously pinned the surface to EXACTLY 110/55/88/11 and
 * required EXACTLY 10 signals per module. That inverted the guideline:
 * registering a new backend signal FAILED CI, and adding the 11th signal to
 * any one module failed the even-distribution assertion. The gate intended
 * to protect the surface was preventing it from growing.
 *
 * The genuine regression it was built to catch is a registration being
 * silently DROPPED — a projection losing entries. That is preserved here,
 * expressed as invariants that survive growth:
 *
 *   1. RATCHET FLOORS — the surface may grow freely but must never shrink
 *      below the established baseline. A dropped registration still fails.
 *      When the surface grows deliberately, raise the floors.
 *   2. PROJECTION PARITY (the important one) — `buildUiSchema()` must emit
 *      exactly what the registry holds, asserted as a RELATIONSHIP to the
 *      live registry rather than against a hardcoded number. This is what
 *      actually enforces "one registry, many projections": a projection that
 *      silently drops entries fails no matter how the surface changes.
 *   3. STRUCTURE — every signal carries a module and a recognized type;
 *      every action and customization id is namespaced `module.name` so
 *      generated grouping works; every module contributes at least one
 *      signal.
 *
 * The even-distribution rule is deliberately GONE: nothing about the
 * architecture requires modules to expose equal numbers of signals, and
 * requiring it blocks the guideline this registry exists to serve.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildUiSchema,
  resetUiSchemaCache,
} from "../../server/schema/ui-schema.ts";
import {
  registerAllExposure,
  resetAllRegistrations,
  listSignals,
  listActions,
  listCustomizations,
} from "../../server/kernel/canonical.ts";

import { modulePath } from "../helpers/module-resolver.ts";
// Ratchet floors — the established baseline of the exposure surface. The
// surface may grow above these freely; dropping below any of them means a
// registration was lost. Raise a floor when the surface grows deliberately.
// (Raised 119 → 124 when the five live event-feed safety signals landed.)
// (Raised 140 → 162 when the timeline + performance observability modules
// landed: the recorded-ledger knob's mirror and the metrics-bridge signals.)
// (Raised 162 → 163 when the redaction module landed: the re-hiding store's
// live occupancy gauge, the bound row's own measurement.)
// (Raised 163 → 165 when the performance section's two detection budgets
// landed as read-only signals — the benchmark tool's regression and
// overhead budgets, visible to the room, never writable from it.)
// (Raised 165 → 166 when the workspaceGit section's pinned executable
// landed as a read-only signal — the git binary the workspace doors pin,
// shown to the room, never writable from it.)
// (Raised 166 → 193 when the safety section's posture and detection budgets
// landed as read-only signals — the three gate checks' armed states, the
// four event-feed detector families' armed states, the long-comment finding
// path, the consequential-tools mode, and the seventeen verdict thresholds
// (loop repeat/window/auto-trip, per-family min-events, the long-comment
// heuristic's bounds, the bandaid overlap and scan floors, the workaround
// switch window, the off-task similarity/warm-up/window/persistence, the
// skipped-step window, and the investigation's legitimacy floor) — visible
// to the instruments room, never writable from the settings room.)
// (Raised 193 → 208 when the webUi section's thirteen performance ceilings
// landed as read-only signals — the perf-profile regression gate's own
// verdict budgets (load paint, layout shift, worst and total long tasks,
// tab switch, tab DOM nodes, typing settle, slowest API response, the long
// session's heap and DOM growth, the long-chat and many-projects renders,
// and the narrow-viewport paint) — the file is the machine administrator's
// path, the room shows them and offers no write. The floor is the MEASURED
// live count, not the previous floor plus the addition, so a single
// dropped signal reds here too, beside the census that names it.)
// (Raised 208 → 216 when the UIE-070 class landed: the suite gates' own
// verdict numbers became read-only signals — the web suite's per-file CPU
// cap with the population, drift tolerance, same-tree spread and
// over-cap streak it was derived against (the streak count's signal was
// deleted with the streak itself, UR-24-BUDGETS), the per-file worker-time share
// cap, the flaky-test lookback window both suites' guards read, and the
// engine suite's own budget phase. Same doctrine as the thirteen above,
// same measured-live-count floor.)
// (Raised 216 → 217 when the web budget became a rolling baseline: the cap
// is derived at read time now, so the floor it never drops below and the
// window the median is taken over are each their own read-only signal —
// one more verdict number a settings write must not loosen.)
// (Raised 217 → 219 when the ambient-inflation envelope landed: the slope
// the gate pays per unit of recorded 5-minute ambient load, and the cap
// that bounds the whole allowance — the two numbers that let a clean run
// at a busy ambient judge clean and keep the teeth at every ambient. Same
// measured-live-count doctrine: a single dropped signal reds here too.)
const MIN_SIGNALS = 219;
const MIN_ACTIONS = 64;
// Eight customizations were REMOVED (2026-07-26) because the promised
// capability does not exist. Keeping fake controls to hold a count target is
// the prohibited class itself; every remaining control has behavioral proof.
// The floor moved with them rather than being narrated beside them.
// Raised 218 → 221 for auto-index + remember-in-memory + watch-debounce.
// Census-in-memory was collapsed (store gone, not default-off), so 220.
// Raised 220 → 224 for the observability knobs (provider-payload capture,
// resource deltas, the resource sampler's switch + interval).
// Raised 224 → 238 for the real memory store's whole-context knobs (the
// token budget, trim trigger, recent window, summary budget, tier
// capacities, search engine, and the per-entry size ceilings).
// Raised 238 → 245 for the memory section's capture-and-search leaves (the
// search default limit and ceiling, the recall count, the saved-turn caps,
// and the recalled-context preview length).
// Raised 245 → 246 for the redaction section's one bound (the re-hiding
// store's capacity — the section's one leaf, whose consumer sizes the store
// once per process).
// Raised 246 → 250 for the performance section's benchmark run bounds and
// the diagnostic mode timeout (the leaves whose file-fed consumers — the
// harness benchmark and diagnostic commands — deliver real behavior).
// Raised 250 → 253 for the workspaceGit section's three timeout run bounds
// (the leaves whose file-fed consumers — the harness workspace and
// integrate commands — deliver real behavior through live CLI doors).
// Raised 253 → 258 for the safety section's five administrative leaves (the
// gate's partial-argument recovery + its memory bound + the refusal
// message's escalation point, and the pause-ask interaction's on/off +
// message cap — knobs that shape how a refusal or a pause behaves, never
// whether a check happens).
// Raised 258 → 272 for the UIE-070 class's fourteen writable rows: the
// engine test runner's five run bounds (the per-test kill timeout and the
// four phase lane counts), the harness command doors' five bounds (the
// typecheck step, the shared lock's timeout/poll/staleness, and the
// evaluation runner's identity probe), and the agents orchestration
// section's four shaping knobs (the concurrency cap, the alignment
// monitor's interval and drift threshold, and the conflict-detection
// switch) — every one backed by a real file-fed consumer.
const MIN_CUSTOMIZATIONS = 272;
// (Raised 12 → 16: the timeline + performance modules both contribute
// signals, and the ratchet counts signal-owning modules.)
// (Raised 16 → 17 when the webPerformance module landed — the webUi
// performance ceilings' read-only home, thirteen signals and no rows.)
// (Raised 17 → 18 when the testExecution module landed — the suite gates'
// eight read-only budget signals. The harnessCommands and agents modules
// serve rows only, so they do not join this signal-owning module floor.)
// (Raised 18 → 20 when the inherited slack was closed: the measured live
// count is 20 signal-owning modules, so the floor now matches it exactly,
// the same measured-live-count doctrine as the signals and customizations
// floors — a single dropped module reds here too, beside the census that
// names it.)
const MIN_MODULES = 20;
// The number of UI-declared actions merged into the schema on top of the
// backend registry (currently just "new-project"). Derived as a relationship
// below rather than folded into a hardcoded total.
const UI_DECLARED_ACTIONS = 1;

// DYNAMIC discovery: the recognized signal types are derived from the
// canonical `SIGNAL_TYPES` constant in the exposure owner (NOT a hardcoded
// set that silently rots when a new type is added). A new signal type
// added to SIGNAL_TYPES is auto-recognized; a signal registered with an
// undeclared type is still flagged (deny-by-default).
const SIGNAL_TYPES_SRC = readFileSync(
  modulePath("signal.ts"),
  "utf8",
);
const SIGNAL_TYPES_MATCH = SIGNAL_TYPES_SRC.match(/SIGNAL_TYPES\s*=\s*(?:deepFreeze\(\s*)?\[([\s\S]*?)\]\s*as\s+const/);
const RECOGNIZED_SIGNAL_TYPES = new Set<string>(
  SIGNAL_TYPES_MATCH
    ? Array.from(SIGNAL_TYPES_MATCH[1]!.matchAll(/"([^"]+)"/g), (m) => m[1]!)
    : [],
);
// Sanity: the canonical source must declare signal types (deny-by-default —
// if the parse failed, the test is not vacuous).
expect(RECOGNIZED_SIGNAL_TYPES.size, "must discover SIGNAL_TYPES from the canonical exposure owner").toBeGreaterThan(0);

beforeEach(() => {
  resetAllRegistrations();
  registerAllExposure();
  resetUiSchemaCache();
});

describe("exposure registry — surface may grow, never shrink (ratchet guard)", () => {
  test("registers at least the baseline signal surface", () => {
    expect(
      listSignals().length,
      `signal registrations must never drop below the ${MIN_SIGNALS} baseline (growth is expected and allowed)`,
    ).toBeGreaterThanOrEqual(MIN_SIGNALS);
  });

  test("registers at least the baseline action surface", () => {
    expect(
      listActions().length,
      `action registrations must never drop below the ${MIN_ACTIONS} baseline`,
    ).toBeGreaterThanOrEqual(MIN_ACTIONS);
  });

  test("registers at least the baseline customization surface", () => {
    expect(
      listCustomizations().length,
      `customization registrations must never drop below the ${MIN_CUSTOMIZATIONS} baseline`,
    ).toBeGreaterThanOrEqual(MIN_CUSTOMIZATIONS);
  });

  test("every module contributes at least one signal", () => {
    const byModule = new Map<string, number>();
    for (const s of listSignals()) byModule.set(s.module, (byModule.get(s.module) ?? 0) + 1);
    expect(
      byModule.size,
      `at least ${MIN_MODULES} modules must contribute signals`,
    ).toBeGreaterThanOrEqual(MIN_MODULES);
    // Presence, not parity: a module registered with zero signals is a wiring
    // bug, but modules are not required to expose equal numbers.
    for (const [mod, count] of byModule) {
      expect(count, `module '${mod}' registered a signal group but exposes none`).toBeGreaterThan(0);
    }
  });

  test("signal ids are unique (a collision silently overwrites a registration)", () => {
    const ids = listSignals().map((s) => s.id);
    expect(new Set(ids).size, "duplicate signal ids would drop entries from every projection").toBe(ids.length);
  });

  test("every signal has a non-empty module + a recognized type", () => {
    for (const s of listSignals()) {
      expect(s.module.length, `signal '${s.id}' needs a module`).toBeGreaterThan(0);
      expect(RECOGNIZED_SIGNAL_TYPES.has(s.type), `signal '${s.id}' has unknown type '${s.type}' (not in the canonical SIGNAL_TYPES)`).toBe(true);
    }
  });

  test("every action + customization id is namespaced (module.name) so grouping works", () => {
    for (const a of listActions()) {
      expect(a.id.includes("."), `action '${a.id}' must be namespaced module.name`).toBe(true);
    }
    for (const c of listCustomizations()) {
      expect(c.id.includes("."), `customization '${c.id}' must be namespaced module.name`).toBe(true);
    }
  });
});

describe("buildUiSchema — exposure projection matches the registry", () => {
  // These are the assertions that make "one registry, many projections" real.
  // Each compares the projection to the LIVE registry rather than to a
  // hardcoded number, so they keep working as the surface grows and still
  // fail the moment a projection drops an entry.

  test("schema signals === registry signals (no projection loss)", () => {
    const schema = buildUiSchema();
    const registry = listSignals();
    expect(schema.signals.length, "every registered signal must reach the schema").toBe(registry.length);
    const projected = new Set(schema.signals.map((s) => s.id));
    for (const s of registry) {
      expect(projected.has(s.id), `signal '${s.id}' is registered but missing from the UI schema`).toBe(true);
    }
  });

  test("schema actions === registry actions + the UI-declared ones", () => {
    const schema = buildUiSchema();
    const registry = listActions();
    expect(schema.actions.length).toBe(registry.length + UI_DECLARED_ACTIONS);
    expect(schema.actions.find((a) => a.id === "new-project")).toBeDefined();
    const projected = new Set(schema.actions.map((a) => a.id));
    for (const a of registry) {
      expect(projected.has(a.id), `action '${a.id}' is registered but missing from the UI schema`).toBe(true);
    }
  });

  test("schema settings === registry customizations (all carry customizationId)", () => {
    const schema = buildUiSchema();
    const registry = listCustomizations();
    expect(schema.settings.length, "every customization must reach the schema as a setting").toBe(registry.length);
    for (const s of schema.settings) {
      expect(s.customizationId, `setting '${s.id}' must be a backend customization`).toBeDefined();
    }
    const projected = new Set(schema.settings.map((s) => s.customizationId));
    for (const c of registry) {
      expect(projected.has(c.id), `customization '${c.id}' is registered but missing from the UI schema`).toBe(true);
    }
  });
});
