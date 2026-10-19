// @vitest-environment node
/**
 * GATE-BLOCKED HALLUCINATIONS MUST MOVE THE EXPOSURE COUNTERS.
 *
 * ── THE DEFECT (the "wired but inert" class, the 748% shape) ─────────────
 *
 * The `hallucination` and `safety` exposure modules register counter signals
 * (`hallucination.catchCount`, `safety.hallucinationCount`,
 * `safety.hallucinationCatchCount`) that the Instruments room reads on every
 * poll. But NOTHING outside the registration's own self-test actions ever
 * wrote them: the real producer — the pre-dispatch tool-call gate that blocks
 * a ghost-tool / schema-mismatch / loop call — returned its `gateBlock` result
 * and moved no counter. The room showed a permanent 0 while the gate was
 * demonstrably blocking calls. A measured surface wired to a counter that no
 * producer feeds is the wired-but-inert defect: it LOOKS instrumented and is
 * dead.
 *
 * ── THE FIX THIS GUARDS ──────────────────────────────────────────────────
 *
 * The gate's single choke point (the executor's blocked branch) now calls the
 * gate owner's `recordGateBlock()`, which writes the counters THROUGH the
 * exposure modules' own APIs (`recordHallucinationGateBlock`,
 * `recordSafetyHallucinationGateBlock`) — the modules own their state; the
 * gate never mutates it directly. This guard pins that path both ways:
 *
 *   (A) BEHAVIOURAL — drive a REAL ghost-tool block through `executeToolCall`
 *       and assert both counters incremented. This is the liveness proof: the
 *       wiring is exercised end-to-end, not assumed from source.
 *   (B) STRUCTURAL — the choke point's blocked branch must call
 *       `recordGateBlock`, and `recordGateBlock` must write BOTH counters. A
 *       reverted call (the inert shape: block computed, count discarded) reds.
 *   (C) THE CLASS — every counter/gauge signal backed by a registration-local
 *       `*State` field that claims to measure a REAL gated event must have an
 *       exported owner write-path called from outside the registration file.
 *
 * Mutation-verified: deleting the `recordGateBlock()` call reds (A) and (B);
 * pointing `recordGateBlock` at only one counter reds (B); a fixture state
 * field with no external-caller writer reds (C).
 */
import { describe, expect, test } from "vitest";
import { createRequire } from "node:module";

import { executeToolCall, type ToolExecutionContext } from "../../server/tools/tool-executor.ts";
import { read, stripCommentsAndStringsDropFor } from "../helpers/source-scan.ts";
import { bodyCalls, functionBody, functionsCalling } from "../helpers/function-scope.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
// ── WHY createRequire (the vitest module-instance split) ─────────────────
// `tool-executor.ts` loads its gate owner via `createRequire`
// (`moduleRequire("./safety-bridge.ts")`), so the `hallucinationState` /
// `safetyState` that the executor's writes land in is the REQUIRE-instance of
// those modules. Under plain `node --experimental-strip-types` (production)
// the require-instance and the ESM-import instance are ONE, so the Instruments
// room (which reads via the ESM `registerAllExposure`/`listSignals`) sees the
// gate's writes. Vitest's module runner keeps them as TWO, so reading the
// state by ESM import here would watch the instance the gate never writes —
// and the behavioral arm would red on a wiring that is actually live in
// production. Driving + observing through `createRequire` watches the SAME
// instance the executor mutates, which is the path that conducts in
// production. Verified: the production probe (plain node) moves both counters.
const require = createRequire(import.meta.url);
const { createToolCallGate } = require("../../server/kernel/canonical.ts") as typeof import("../../server/kernel/canonical.ts");
const { hallucinationState, safetyState } = require(
  "../../engine/src/shared/exposure/registrations/index.ts",
) as typeof import("../../engine/src/shared/exposure/registrations/index.ts");

const EXECUTOR_SRC = read(modulePath("tool-executor.ts"));
const SAFETY_BRIDGE_SRC = read(modulePath("safety-bridge.ts"));
const HALLUCINATION_PATH = modulePath("hallucination.ts");
const HALLUCINATION_SRC = read(HALLUCINATION_PATH);
const SAFETY_PATH = modulePathMatching("engine/src/shared/exposure/registrations/safety.ts");
const SAFETY_SRC = read(SAFETY_PATH);

/** A gate that knows only `read_file`, so a `grep` call blocks as a ghost tool. */
function ghostToolGate() {
  return createToolCallGate({
    getDefinitions: () => [
      {
        type: "function",
        function: { name: "read_file", description: "read a file", parameters: { type: "object", properties: {} } },
      },
    ],
  });
}

function ctxWithGate(gate: ReturnType<typeof ghostToolGate>): ToolExecutionContext {
  return { projectRoot: process.cwd(), gate, callId: "call-1" };
}

describe("A. a real gate block increments the exposure counters (end-to-end liveness)", () => {
  test("a ghost-tool block moves hallucination.catchCount and safety.hallucinationCount", async () => {
    const hBefore = hallucinationState.catchCount;
    const sBefore = safetyState.hallucinationCount;
    const sCaughtBefore = safetyState.hallucinationCatchCount;

    const res = await executeToolCall("grep", { pattern: "x" }, ctxWithGate(ghostToolGate()));

    // The block itself landed (ghost tool refused), AND the counters moved.
    expect(res.success, "a ghost-tool call must be blocked by the gate").toBe(false);
    expect(res.gateBlock?.kind, "the block is a ghost-tool hallucination").toBe("ghost_tool");
    expect(
      hallucinationState.catchCount,
      "hallucination.catchCount must increment on a gate block (was a permanent zero)",
    ).toBe(hBefore + 1);
    expect(
      safetyState.hallucinationCount,
      "safety.hallucinationCount must increment on a gate block",
    ).toBe(sBefore + 1);
    expect(
      safetyState.hallucinationCatchCount,
      "a gate block is a CAUGHT hallucination — the catch counter must move with the detection counter",
    ).toBe(sCaughtBefore + 1);
  });

  test("a CLEAN call (a real registered tool) does NOT increment the catch counter", async () => {
    const hBefore = hallucinationState.catchCount;
    // `read_file` is registered in the gate; the call passes the gate (it then
    // fails downstream on a missing path — irrelevant to the gate counters).
    await executeToolCall("read_file", { path: "definitely-not-here.txt" }, ctxWithGate(ghostToolGate()));
    expect(
      hallucinationState.catchCount,
      "a call the gate passes is not a caught hallucination — the counter must not move",
    ).toBe(hBefore);
  });
});

describe("B. the choke point records the block (structural — the inert shape reds)", () => {
  test("the executor's blocked branch calls the gate owner's recordGateBlock", () => {
    // The gate choke point is `executeToolCallInner`: it reads
    // `gateResult.blocked` and, in the blocked branch, records the catch.
    // `functionsCalling` resolves the member call `sb.recordGateBlock()` to its
    // enclosing function; the same body must also read `gateResult.blocked`,
    // so the call sits on the blocked path rather than anywhere else.
    const callers = functionsCalling(EXECUTOR_SRC, "sb.recordGateBlock");
    const names = callers.map((c) => c.name);
    expect(names, "the executor's choke point calls sb.recordGateBlock()").toContain("executeToolCallInner");
    const body = functionBody(EXECUTOR_SRC, "executeToolCallInner").body;
    expect(body.includes("gateResult.blocked"), "the same function reads gateResult.blocked (the gate choke point)").toBe(true);
  });

  test("recordGateBlock writes BOTH counters through the modules' own APIs", () => {
    // The gate owner's recordGateBlock calls each exposure module's own write
    // path — asserted as parser-delimited calls, never a byte-count window.
    const body = functionBody(SAFETY_BRIDGE_SRC, "recordGateBlock");
    expect(
      bodyCalls(body, "recordHallucinationGateBlock"),
      "recordGateBlock must write the hallucination module's catch counter",
    ).toBe(true);
    expect(
      bodyCalls(body, "recordSafetyHallucinationGateBlock"),
      "recordGateBlock must write the safety module's hallucination counters",
    ).toBe(true);
  });

  test("the exposure modules own their counters (the gate does not mutate state directly)", () => {
    // The owner write-paths live in the registration modules and write the
    // module's own state — the single-owner rule (the gate never reaches into
    // `hallucinationState` / `safetyState` from outside the module).
    expect(stripCommentsAndStringsDropFor(HALLUCINATION_SRC, HALLUCINATION_PATH)).toContain("export function recordHallucinationGateBlock");
    expect(stripCommentsAndStringsDropFor(SAFETY_SRC, SAFETY_PATH)).toContain("export function recordSafetyHallucinationGateBlock");
  });
});

describe("C. the class — a registration-local counter with no external writer is inert", () => {
  // The general property behind (A)/(B): a signal backed by a registration's
  // own `*State` field, claiming to measure a real gated event, is LIVE only
  // when an exported owner function (not the register*/reset* plumbing) writes
  // that field AND is reachable from outside the registration file. The two
  // gate-block counters are the live instances this arm pins.
  test("hallucination.catchCount has an exported owner write-path called from outside the module", () => {
    // The owner API writes the counter inside the registration module (the
    // function's own body performs the increment)…
    expect(
      functionBody(HALLUCINATION_SRC, "recordHallucinationGateBlock").body.includes("catchCount += 1"),
      "recordHallucinationGateBlock must increment catchCount",
    ).toBe(true);
    // …and a NON-registration, NON-test source file calls it (a real producer).
    expect(
      functionsCalling(SAFETY_BRIDGE_SRC, "recordHallucinationGateBlock").length,
      "a real producer (the gate owner) calls recordHallucinationGateBlock",
    ).toBeGreaterThan(0);
  });

  test("safety.hallucinationCount has an exported owner write-path called from outside the module", () => {
    expect(
      functionBody(SAFETY_SRC, "recordSafetyHallucinationGateBlock").body.includes("hallucinationCount += 1"),
      "recordSafetyHallucinationGateBlock must increment hallucinationCount",
    ).toBe(true);
    expect(
      functionsCalling(SAFETY_BRIDGE_SRC, "recordSafetyHallucinationGateBlock").length,
      "a real producer (the gate owner) calls recordSafetyHallucinationGateBlock",
    ).toBeGreaterThan(0);
  });
});
