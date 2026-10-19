// @vitest-environment node
/**
 * EVENT-FEED SAFETY DETECTORS MUST RUN ON THE WEB RUN PATH — AND THEIR
 * VERDICTS MUST REACH THE SURFACE.
 *
 * ── THE DEFECT THIS GUARDS (the "built but unwired" class) ────────────────
 *
 * The engine ships four fully-built, fully-tested deterministic event-stream
 * safety detectors (`engine/src/safety/`): workaround (silent tool switch or
 * hand-rolled reimplementation after a failure), bandaid (root cause not
 * addressed), step-skip (edit-before-read / missing expected steps), and
 * goal-deviation (work drifting off the original task). Only the structural
 * pre-dispatch tool-call gate ran on the web run path; the four event-feed
 * detectors had zero callers outside the engine's tests. This guard pins the
 * whole wiring: the events the run loop feeds, the owner that routes them,
 * the REAL verdicts that come back, and the surfaces (SSE frame, persisted
 * inline events, exposure signals) they reach.
 *
 * Arms (each mutation-verified — see the H arm):
 *   A. SPO — the four detector create functions are called in exactly ONE
 *      server file (`safety-runtime-bridge.ts`); no parallel composition.
 *   B. RUN-LOOP WIRING — the run path feeds tool outcomes, per-turn work,
 *      task completion + original task through the owner, and disposes it.
 *   C. BEHAVIOURAL — driving the owner with the run loop's own facts
 *      produces REAL engine findings: a workaround (tool A fails → tool B
 *      succeeds), a skipped step (edit with no preceding read), a bandaid
 *      (empty catch), and off-task work.
 *   D. EXPOSURE — the findings move the `safety.*` signals through the
 *      installed live source; per-run isolation; dispose removes the run.
 *   E. HONEST ABSENCE — a disabled family and a malformed config report
 *      honestly (armed: false + reason), never a fabricated verdict.
 *   F. SURFACE — the run path publishes the findings frame + persists each
 *      finding as an inline event; the client renders it; the persisted
 *      kind reconstructs from the owner's stable marker.
 *   G. LEFTOVER SEAMS — delegated tool calls feed the same runtime; a
 *      cancelled run still publishes recorded findings (from the finally,
 *      so an early stopped() return cannot drop them); persist of those
 *      findings takes the owner as an argument (looking the live run up
 *      is inert after deleteActiveRun); mid-run instrument reads
 *      invalidate the cached detect() so they cannot freeze; pause
 *      consumption is per-finding; a reject on a stop turn continues the
 *      loop; MCP not-connected / not-registered / disabled is typed
 *      unavailable; an MCP tool that reports isError is a failed call.
 *
 * Dynamic discovery: the server-file walk and the run-path subject come from
 * the filesystem (`readdirSync` + the run-source owner) — never a hardcoded
 * file list. A new server module that starts composing detectors directly is
 * caught automatically.
 */
import { beforeAll, afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  resolveBandaidConfig,
  registerAllExposure,
  resetAllRegistrations,
  readSignal,
  isConfigPathDeclared,
  getConfigDocumentSchema,
} from "../../server/kernel/canonical.ts";
import {
  createRunSafetyRuntime,
  installRunSafetyRuntimeExposureSource,
  liveSafetyRuntimeCount,
  safetyFindingMessage,
  editFilePath,
  editAddedLines,
  readFilePath,
  toolIntent,
  declaresCapability,
  type SafetyRuntime,
} from "../../server/safety/safety-runtime-bridge.ts";
import { runPathSource } from "../helpers/run-source.ts";
import { walkTs } from "../helpers/source-scan.ts";
import { bindingValueOf, bodyCallsWith, enclosingFunctionOf, functionBody } from "../helpers/function-scope.ts";
import { classifyInlineEvent } from "../../src/state/chat-messages.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { waitForRunPauseAnswer, notifyRunPauseAnswer, type ActiveRun } from "../../server/run/run-registry.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
// The typed error the posture floors throw — the runtime's re-throw decision
// is keyed on its code, and the boot arm plants it through the same class.
import { InputError } from "../../engine/src/kernel/errors.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();
// ── Dynamic file discovery (the server universe) ──

const SERVER_TS_FILES: string[] = walkTs("server");

function srcOf(path: string): string {
  return readFileSync(path, "utf8");
}

// ── Factories ──

/** Runtimes created by the current test, disposed in afterEach so the live
 * aggregate the signals read returns to honest zeros between tests. */
const createdRuntimes: SafetyRuntime[] = [];

function track(rt: SafetyRuntime): SafetyRuntime {
  createdRuntimes.push(rt);
  return rt;
}

/** A runtime armed with the engine's default detector config. */
function armedRuntime(): SafetyRuntime {
  return track(createRunSafetyRuntime({ config: resolveBandaidConfig() }));
}

function toolOutcome(
  runtime: SafetyRuntime,
  args: { turn: number; toolName: string; success: boolean; args?: Record<string, unknown>; capabilities?: string[]; error?: string; unavailable?: boolean; unavailableReason?: Parameters<SafetyRuntime["recordToolCall"]>[0]["unavailableReason"] },
): void {
  runtime.recordToolCall({
    turn: args.turn,
    toolName: args.toolName,
    success: args.success,
    ...(args.error !== undefined ? { error: args.error } : {}),
    ...(args.unavailable === true ? { unavailable: true } : {}),
    ...(args.unavailableReason !== undefined ? { unavailableReason: args.unavailableReason } : {}),
    args: args.args,
    capabilities: args.capabilities,
  });
}

beforeAll(() => {
  resetAllRegistrations();
  registerAllExposure();
  installRunSafetyRuntimeExposureSource();
});

afterEach(() => {
  // Every runtime the test created must be disposed so the live aggregate the
  // signals read returns to honest zeros for the next test.
  while (createdRuntimes.length > 0) {
    createdRuntimes.pop()!.dispose();
  }
});

// ── A. Single owner ──

describe("A. the safety-runtime owner is the only composition point", () => {
  test("each detector create function is called in exactly ONE server file (safety-runtime-bridge.ts)", () => {
    const creates = [
      "createWorkaroundDetector",
      "createBandaidDetector",
      "createStepSkipDetector",
      "createDeviationDetector",
      "createInvestigator",
      "createPauseAskBuilder",
    ] as const;
    for (const fn of creates) {
      const callSites = SERVER_TS_FILES.filter((f) => {
        const src = srcOf(f);
        // Call sites, not imports/re-exports: a `createX(...)` invocation.
        return new RegExp(`\\b${fn}\\s*\\(`).test(src);
      });
      expect(
        callSites,
        `${fn} must only be invoked inside the safety-runtime owner`,
      ).toEqual([modulePath("safety-runtime-bridge.ts")]);
    }
  });

  test("no server file besides the owner DEFINES the runtime factory", () => {
    const violators = SERVER_TS_FILES.filter((f) => {
      if (f === modulePath("safety-runtime-bridge.ts")) return false;
      const src = srcOf(f);
      // A second COMPOSITION POINT would be another `export function
      // createRunSafetyRuntime` — the run executor CALLING the owner's
      // factory is the intended consumer, not a violation.
      return /export\s+function\s+createRunSafetyRuntime\s*\(/.test(src);
    });
    expect(violators, `createRunSafetyRuntime must be defined only by the bridge: ${violators.join(", ")}`).toEqual([]);
  });
});

// ── B. Run-loop wiring ──

describe("B. the run loop feeds the owner at every seam", () => {
  test("the run path constructs the runtime, sets the original task, and disposes it", () => {
    const src = runPathSource();
    expect(src).toContain("createRunSafetyRuntime");
    expect(src).toContain("safetyRuntime.setOriginalTask(active.prompt)");
    expect(src).toMatch(/safetyRuntime\??\.dispose\(\)/);
  });

  test("each completed tool call feeds recordToolCall with success/error/args/capabilities", () => {
    // The choke point is executeToolCall — parent and delegated calls both
    // cross it. The run loop used to record only its own completions, which
    // is the hole a sub-agent walked through.
    const src = srcOf(modulePath("tool-executor.ts"));
    expect(src).toContain("ctx.safetyRuntime !== undefined");
    expect(src).toMatch(/ctx\.safetyRuntime\.recordToolCall\(\{/);
    expect(src).toContain("success: result.success");
    expect(src).toContain("error: result.output");
    expect(src).toContain("ctx.parentManifest?.find");
    expect(src).toContain("turn: ctx.safetyTurn ?? 1");
  });

  test("each productive turn feeds recordWork; task end feeds completeTask + detect", () => {
    const src = runPathSource();
    expect(src).toContain("safetyRuntime.recordWork({ turn: summaryTurnNumber + 1, description: turnAssistantText })");
    expect(src).toContain("safetyRuntime.completeTask({ turn: summaryTurnNumber + 1 })");
    expect(src).toContain("safetyRuntime.detect()");
  });

  test("the findings are published as the dedicated SSE frame AND persisted as inline events", () => {
    const src = runPathSource();
    expect(src).toContain("SSE_EVENT_TYPES.safetyFindings");
    expect(src).toContain("persistInlineEvent(db, chatId, runId, \"safety-finding\", findingMessage, active.userId)");
  });

  test("the run threads the runtime onto the tool context so delegated calls inherit it", () => {
    const src = runPathSource();
    expect(src).toMatch(/safetyRuntime,/);
    expect(src).toMatch(/safetyTurn:\s*summaryTurnNumber \+ 1/);
  });

  test("the run loop takes pending pause/reject interventions after each productive turn", () => {
    const src = runPathSource();
    expect(src).toContain("safetyRuntime.takePendingIntervention()");
    expect(src).toContain("SSE_EVENT_TYPES.pauseAsk");
    expect(src).toContain("waitForRunPauseAnswer");
    expect(src).toContain("intervention.rejectMessage");
    expect(src).toContain("rejectedIntoNextTurn");
    expect(srcOf(modulePath("run.ts"))).toContain("notifyRunPauseAnswer(active)");
  });

  test("the bridge's investigation context says UNEVALUATED where no probe runs — never a fabricated boolean", () => {
    // The run path evaluates NONE of these five legs: no root-cause probe
    // (a quality pack says nothing here) and no task-feasibility probe
    // (the project index is not consulted at this seam). The context must
    // READ as unevaluated — a : false here claims a measurement that was
    // never made (the SAFETY-WIRE-1 starvation shape); a : true claims a
    // probe that does not exist. Both are fabrications, and both flip the
    // behavioural arms above the moment they are written.
    const src = srcOf(modulePath("safety-runtime-bridge.ts"));
    for (const field of [
      "rootCauseKnown",
      "rootCauseFixableByLLM",
      "taskPossible",
      "deviationIsImprovement",
    ] as const) {
      expect(src, `${field} must read "unevaluated" where nothing probed it`).toContain(`${field}: "unevaluated"`);
      expect(src, `${field} must never carry a fabricated boolean`).not.toMatch(new RegExp(`${field}:\\s*(?:true|false)`));
    }
  });

  test("completeTask stays gated on a finished run; detect + publish still run after a cancel", () => {
    const src = srcOf(modulePath("run-executor.ts"));
    expect(src).toMatch(/if\s*\(\s*!stopped\(\)\s*\)\s*\{\s*safetyRuntime\.completeTask\(\{ turn: summaryTurnNumber \+ 1 \}\);\s*\}/);
    expect(src).toContain("cancelled: stopped()");
    const finallyAt = src.lastIndexOf("} finally {");
    expect(finallyAt, "the run executor must have a finally").toBeGreaterThan(0);
    const detectAt = src.indexOf("const safetyReport = safetyRuntime.detect()", finallyAt);
    expect(detectAt, "detect() must run in the finally so an early stopped() return cannot drop findings").toBeGreaterThan(finallyAt);
    const disposeAt = src.indexOf("safetyRuntime.dispose()", finallyAt);
    expect(disposeAt, "dispose must follow detect, not precede it").toBeGreaterThan(detectAt);
    expect(src.slice(finallyAt), "the finally must publish the report it computed, not an empty stand-in").toContain("...safetyReport,");
    expect(src).toMatch(/while \(true\) \{\s*if \(stopped\(\)\) return;/);
    const persistStart = src.indexOf("async function persistInlineEvent");
    const persistEnd = src.indexOf("async function persistTimelineEvent");
    expect(persistEnd, "the persist-function slice must be the body, not an empty window").toBeGreaterThan(persistStart);
    const persistFn = src.slice(persistStart, persistEnd);
    expect(persistFn.length, "the persist-function slice must contain the function").toBeGreaterThan(200);
    expect(persistFn, "end-of-run persist must not look up the live run — finally already deleted it").not.toMatch(/\bgetActiveRun\b/);
    expect(persistFn, "end-of-run persist must not re-resolve the owner through the feed either").not.toMatch(/\bresolveRunOwner\b/);
    // Lookup class: a member/computed/optional-chain call, or a camelCase
    // callee (ownerFor, fetchOwner, lookup). PascalCase conversions such as
    // String(runId) stay green by shape (a \w+ pin would false-red on them).
    // Accepted over-breadth, named so "deliberate" and "forgotten" are never
    // confused: lowercase/member conversion callees such as parseInt(runId),
    // JSON.stringify(runId), and encodeURIComponent(runId) would red — the
    // pin errs fail-closed, and this function transforms runId for nothing
    // but a DB owner field. Introducing one here is a review event, not a
    // silent pass.
    expect(persistFn, "a renamed owner lookup is still a lookup — persist must not fetch the owner from runId").not.toMatch(/(?:(?:this|\w+)\s*\??\s*(?:\.\s*\w+\s*(?:\?\.)?|\[\s*["']\w+["']\s*\]\s*(?:\?\.)?)|\b[a-z]\w*(?:\?\.)?)\(\s*runId\b/);
    expect(persistFn, "the captured owner is the argument the DB writes receive — a lookup or a blank is the inert shape").toMatch(/createTimelineRef\(\s*\{(?:[^{}]|\{[^{}]*\})*\}\s*,\s*userId\s*,?\s*\)/);
    expect(persistFn, "the message row must use the same captured owner as the timeline ref").toMatch(/createMessage\(\s*\{(?:[^{}]|\{[^{}]*\})*\}\s*,\s*userId\s*,?\s*\)/);
    expect(persistFn, "a safety finding is a detected problem, not a success").toMatch(/eventKind === ["']safety-finding["']\s*\?\s*["']failed["']/);
    expect(persistFn, "a bias finding is a detected problem, not a success").toMatch(/eventKind === ["']bias["']\s*\?\s*["']failed["']/);
    // THE PARENT LINK: a paired inline account names the ledger row it is
    // about (the tool event of the gate-blocked call) as its parentEventId —
    // the pairing the sweep's incident count folds on, recorded where the
    // two rows are known to each other. Absent for the unpaired kinds, and
    // never defaulted: an invented parent would be a fabricated causal claim
    // inside a chain-hashed ledger.
    expect(persistFn, "the parent id is accepted as an argument").toMatch(/parentEventId\?:\s*string/);
    expect(persistFn, "and reaches the ledger row only when given — never defaulted").toMatch(
      /\.\.\.\(parentEventId !== undefined \? \{ parentEventId \} : \{\}\)/,
    );
    expect(src, "the gate-block branch passes the blocked call's own ledger row").toContain(
      "toolResult.toolEventId,",
    );
    expect(src.slice(finallyAt), "finding persist must pass the captured owner, not re-resolve a deleted run").toContain("persistInlineEvent(db, chatId, runId, \"safety-finding\", findingMessage, active.userId)");
  });
});

// ── C. Behavioural — real engine findings ──

describe("C. the run loop's facts produce REAL detector verdicts", () => {
  test("tool A fails → a different tool succeeds: a real workaround finding", () => {
    const rt = armedRuntime();
    toolOutcome(rt, { turn: 1, toolName: "search_code", success: false, error: "Error: search failed", args: { pattern: "call-site" }, capabilities: ["read"] });
    toolOutcome(rt, { turn: 2, toolName: "list_files", success: true, args: { path: "src" }, capabilities: ["read"] });
    const report = rt.detect();
    expect(report.armed).toBe(true);
    expect(report.workaround.armed).toBe(true);
    expect(report.workaround.detectedCount).toBe(1);
    const f = report.workaround.findings[0]!;
    expect(f.failedTool).toBe("search_code");
    expect(f.switchKind).toBe("tool-switch");
    expect(f.switchedTo).toBe("list_files");
    expect(report.messages.length).toBe(1);
    expect(report.messages[0]).toContain("Safety finding (workaround)");
  });

  test("a workaround of an installed-but-failed tool is investigated as reject (not a pause)", () => {
    const rt = armedRuntime();
    toolOutcome(rt, { turn: 1, toolName: "search_code", success: false, error: "Error: search failed", args: { pattern: "x" }, capabilities: ["read"] });
    toolOutcome(rt, { turn: 2, toolName: "list_files", success: true, args: { path: "." }, capabilities: ["read"] });
    const report = rt.detect();
    expect(report.pause).toBeNull();
    expect(report.investigation.some((r) => r.action === "reject")).toBe(true);
    const pending = rt.takePendingIntervention();
    expect(pending.pause).toBeNull();
    expect(pending.rejectMessage).toContain("search_code");
    expect(rt.takePendingIntervention().rejectMessage).toBeNull();
  });

  test("a workaround of an unconfigured tool pauses and asks the user", () => {
    const rt = armedRuntime();
    toolOutcome(rt, { turn: 1, toolName: "search_web", success: false, error: "adapter_not_configured", unavailable: true, args: { query: "x" }, capabilities: ["read"] });
    toolOutcome(rt, { turn: 2, toolName: "list_files", success: true, args: { path: "." }, capabilities: ["read"] });
    const report = rt.detect();
    expect(report.pause).not.toBeNull();
    expect(report.pause!.message.length).toBeGreaterThan(0);
    expect(report.investigation.some((r) => r.action === "pause-and-ask")).toBe(true);
    const pending = rt.takePendingIntervention();
    expect(pending.pause).not.toBeNull();
    expect(pending.pause!.message).toBe(report.pause!.message);
    expect(rt.takePendingIntervention().pause).toBeNull();
  });

  test("an edit with no preceding read: a real step-skip finding", () => {
    const rt = armedRuntime();
    toolOutcome(rt, { turn: 1, toolName: "edit", success: true, args: { path: "src/app.ts", newContent: "export const x = 1;\n" }, capabilities: ["write"] });
    const report = rt.detect();
    expect(report.stepSkip.armed).toBe(true);
    expect(report.stepSkip.detectedCount).toBe(1);
    expect(report.stepSkip.findings[0]!.kind).toBe("edit-before-read");
    expect(report.stepSkip.findings[0]!.filePath).toBe("src/app.ts");
  });

  test("a read before the edit clears the step-skip suspicion (no fabricated verdict)", () => {
    const rt = armedRuntime();
    toolOutcome(rt, { turn: 1, toolName: "read_file", success: true, args: { path: "src/app.ts" }, capabilities: ["read"] });
    toolOutcome(rt, { turn: 2, toolName: "edit", success: true, args: { path: "src/app.ts", newContent: "export const x = 1;\n" }, capabilities: ["write"] });
    const report = rt.detect();
    expect(report.stepSkip.detectedCount).toBe(0);
  });

  test("a symbol-name view does not clear edit-before-read — name is not a path", () => {
    // SAFETY-WIRE-2: quick_view / slice take `name` as a SYMBOL, not a file.
    // Recording that symbol as a read fabricates an open that never happened
    // and would false-clear an edit of a root file that happens to share the
    // symbol's name. Absence over fabrication: the view records no read, so
    // the subsequent edit of that same string-as-path is still a skip.
    const rt = armedRuntime();
    toolOutcome(rt, { turn: 1, toolName: "quick_view", success: true, args: { name: "src/app.ts" }, capabilities: ["read"] });
    toolOutcome(rt, { turn: 2, toolName: "edit", success: true, args: { path: "src/app.ts", newContent: "export const x = 1;\n" }, capabilities: ["write"] });
    const report = rt.detect();
    expect(report.stepSkip.detectedCount, "a symbol name must not fabricate a read that clears edit-before-read").toBe(1);
    expect(report.stepSkip.findings[0]!.kind).toBe("edit-before-read");
    expect(report.stepSkip.findings[0]!.filePath).toBe("src/app.ts");
  });

  test("an edit adding an empty catch: a real bandaid finding (structural, keyword-free)", () => {
    const rt = armedRuntime();
    toolOutcome(rt, {
      turn: 1,
      toolName: "edit",
      success: true,
      args: { path: "src/app.ts", text: "try {\n  run();\n} catch (e) {\n}" },
      capabilities: ["write"],
    });
    const report = rt.detect();
    expect(report.bandaid.armed).toBe(true);
    expect(report.bandaid.detectedCount).toBeGreaterThanOrEqual(1);
    expect(report.messages.some((m) => m.includes("Safety finding (bandaid fix)"))).toBe(true);
  });

  test("work that never matches the original task: a real deviation finding", () => {
    const rt = armedRuntime();
    rt.setOriginalTask("refactor the auth module to use async await");
    // Five deviating turns: the warmup (3 turns) passes before the first
    // deviation counts, and persistence needs 3 CONSECUTIVE deviations.
    for (let turn = 1; turn <= 5; turn++) {
      rt.recordWork({ turn, description: `unrelated musings about groceries number ${turn}` });
    }
    const report = rt.detect();
    expect(report.deviation.armed).toBe(true);
    expect(report.deviation.detectedCount).toBeGreaterThanOrEqual(3);
    expect(report.deviation.findings.some((f) => f.persistent)).toBe(true);
    // The run path evaluates NEITHER whether the original task is still
    // possible NOR whether the deviation improves on it — the context says
    // so ("unevaluated") instead of carrying a fabricated boolean. So an
    // unevaluated deviation is RECORDED (finding + chat message) and
    // surfaced, but it neither pauses (there is no evidenced impossibility)
    // nor rejects (there is no evidenced judgement) — the verdict reads
    // exactly that, and the verdict it reads is what the project told it.
    const deviationVerdicts = report.investigation.filter((r) => r.finding.family === "deviation");
    expect(deviationVerdicts.length).toBeGreaterThanOrEqual(1);
    for (const r of deviationVerdicts) {
      expect(r.verdict, "an unevaluated deviation is recorded as necessary, never judged").toBe("necessary");
      expect(r.action).toBe("allow-and-record");
      expect(r.reason, "the sentence must own the unknown — claiming the task 'is not possible' is the fabrication this round closes").toContain("allowed and recorded, not judged");
      expect(r.reason).not.toMatch(/not possible/i);
    }
    expect(report.pause, "a deviation with no probe-produced evidence can never pause").toBeNull();
    const pending = rt.takePendingIntervention();
    expect(pending.pause).toBeNull();
    expect(pending.rejectMessage).toBeNull();
    // The finding ITSELF is still surfaced verbatim as a chat message —
    // advisory, exactly as the family intends: the user sees the off-task
    // work, the run never halts on it.
    expect(report.messages.some((m) => m.includes("Safety finding (off-task work)"))).toBe(true);
  });

  test("unevaluated bandaid + step-skip legs are recorded, not judged", () => {
    // A bandaid finding with no root-cause probe: allowed-and-recorded with
    // the honest sentence — the same shape the fabricated false used to
    // win, but the sentence never claims the harness measured anything.
    const rt = armedRuntime();
    toolOutcome(rt, {
      turn: 1,
      toolName: "edit",
      success: true,
      args: { path: "src/app.ts", text: "try {\n  run();\n} catch (e) {\n}" },
      capabilities: ["write"],
    });
    const report = rt.detect();
    const bandaidVerdicts = report.investigation.filter((r) => r.finding.family === "bandaid");
    expect(bandaidVerdicts.length).toBeGreaterThanOrEqual(1);
    for (const r of bandaidVerdicts) {
      expect(r.verdict).toBe("necessary");
      expect(r.action).toBe("allow-and-record");
      expect(r.reason).toContain("No root-cause assessment ran at this site");
    }
    // The step-skip leg is the one family whose "reject" is honest with NO
    // probe: read-before-edit is within the assistant's ability BY
    // CONSTRUCTION, so that verdict is a judgement the detector owns, not a
    // borrowed one — and an empty step expectation list stays dormant (an
    // expectation nobody wrote is no expectation — the shape TC-6 records).
    const rt2 = armedRuntime();
    toolOutcome(rt2, { turn: 1, toolName: "edit", success: true, args: { path: "src/app.ts", newContent: "export const x = 1;\n" }, capabilities: ["write"] });
    const report2 = rt2.detect();
    const skipVerdicts = report2.investigation.filter((r) => r.finding.family === "stepSkip");
    expect(skipVerdicts.length).toBeGreaterThanOrEqual(1);
    for (const r of skipVerdicts) {
      expect(r.verdict, "read-before-edit is within the assistant's ability — the one honest reject").toBe("unnecessary");
      expect(r.action).toBe("reject");
    }
    expect(report2.pause).toBeNull();
    const pending2 = rt2.takePendingIntervention();
    expect(pending2.rejectMessage).toContain("skipped");
    expect(report2.stepSkip.findings.some((f) => f.kind === "expected-step-missing"), "task completion ran with no task type and no expectations — the dormant half of TC-6 stays dormant").toBe(false);
  });
});

// ── D. Exposure signals ──

describe("D. the findings move the exposure signals (real verdicts, not stub counters)", () => {
  test("the live source drives safety.* signal values", () => {
    const rt = armedRuntime();
    toolOutcome(rt, { turn: 1, toolName: "search_code", success: false, error: "Error: boom", args: { pattern: "x" }, capabilities: ["read"] });
    toolOutcome(rt, { turn: 2, toolName: "list_files", success: true, args: { path: "." }, capabilities: ["read"] });
    rt.detect();
    expect(readSignal("safety.eventFeedActive")).toBe(true);
    expect(readSignal("safety.workaroundFindings")).toBe(1);
    expect(readSignal("safety.bandaidFindings")).toBe(0);
    expect(readSignal("safety.stepSkipFindings")).toBe(0);
    expect(readSignal("safety.deviationFindings")).toBe(0);
  });

  test("two runtimes' state does not leak across runs; dispose removes the run from the live aggregate", () => {
    const a = armedRuntime();
    const b = armedRuntime();
    toolOutcome(a, { turn: 1, toolName: "search_code", success: false, error: "Error: a", args: { pattern: "x" }, capabilities: ["read"] });
    toolOutcome(a, { turn: 2, toolName: "list_files", success: true, args: { path: "." }, capabilities: ["read"] });
    a.detect();
    // b has seen nothing — its verdicts are its own.
    expect(b.detect().workaround.detectedCount).toBe(0);
    expect(readSignal("safety.workaroundFindings")).toBe(1);
    a.dispose();
    expect(readSignal("safety.workaroundFindings")).toBe(0);
    // b is still live and armed, so the aggregate honestly reports an active
    // run with zero findings.
    expect(readSignal("safety.eventFeedActive")).toBe(true);
    b.dispose();
    expect(readSignal("safety.eventFeedActive")).toBe(false);
  });

  test("the signal surface declares the five live event-feed signals", () => {
    for (const id of [
      "safety.eventFeedActive",
      "safety.workaroundFindings",
      "safety.bandaidFindings",
      "safety.stepSkipFindings",
      "safety.deviationFindings",
    ]) {
      expect(() => readSignal(id), `signal ${id} must be registered`).not.toThrow();
    }
  });
});

// ── E. Honest absence ──

describe("E. a detector that is not armed reports honestly absent", () => {
  test("a family disabled in config reports armed: false with zero findings", () => {
    const rt = track(createRunSafetyRuntime({
      config: resolveBandaidConfig({ families: { workaround: { enabled: false } } }),
    }));
    toolOutcome(rt, { turn: 1, toolName: "search_code", success: false, error: "Error: x", args: { pattern: "x" }, capabilities: ["read"] });
    toolOutcome(rt, { turn: 2, toolName: "list_files", success: true, args: { path: "." }, capabilities: ["read"] });
    const report = rt.detect();
    expect(report.armed).toBe(true);
    expect(report.workaround.armed).toBe(false);
    expect(report.workaround.detectedCount).toBe(0);
    expect(report.workaround.findings).toEqual([]);
    // The disabled family contributes no chat messages — no fabricated verdict.
    expect(report.messages).toEqual([]);
  });

  test("a malformed config disarms the whole runtime and reports the reason", () => {
    const rt = track(createRunSafetyRuntime({
      resolveConfig: () => {
        throw new Error("bogus eventFeed section");
      },
    }));
    const report = rt.detect();
    expect(report.armed).toBe(false);
    expect(report.disarmedReason).not.toBeNull();
    expect(report.disarmedReason).toContain("bogus eventFeed section");
    expect(report.messages).toEqual([]);
    expect(rt.liveState().active).toBe(false);
  });

  test("a POSTURE violation refuses the runtime instead of disarming it (disarming is not a degraded mode)", () => {
    // The config-door distinction the floors draw: a value-shape problem
    // (the arm above) is a VISIBLE disarmed state — honest degradation for
    // a section the resolver cannot use. A POSTURE violation (a section
    // that would disarm a detector) must never take that path: a runtime
    // "disarmed with a reason" is the very weakening the floors exist to
    // refuse, so the construction REFUSES — the run that would run unarmed
    // detectors does not start, and the typed refusal names the leaf.
    const before = liveSafetyRuntimeCount();
    const postureRefusal = () =>
      createRunSafetyRuntime({
        resolveConfig: () => {
          throw new InputError(
            "safety_event_feed_family_required — safety.eventFeed.families.workaround.enabled may not disarm the workaround detector",
            "safety_event_feed_family_required",
          );
        },
      });
    expect(postureRefusal).toThrowError(
      expect.objectContaining({ code: "safety_event_feed_family_required" }),
    );
    // The refused construction tracked no runtime — the live aggregate never
    // saw it, so nothing can dispose a runtime that was never armed.
    expect(liveSafetyRuntimeCount()).toBe(before);
  });

  test("no events recorded: zero findings (the real answer for nothing observed)", () => {
    const rt = armedRuntime();
    const report = rt.detect();
    expect(report.workaround.detectedCount).toBe(0);
    expect(report.bandaid.detectedCount).toBe(0);
    expect(report.stepSkip.detectedCount).toBe(0);
    expect(report.deviation.detectedCount).toBe(0);
    expect(report.messages).toEqual([]);
  });
});

// ── F. The surface ──

describe("F. findings reach the wire + the client", () => {
  test("the SSE registry owns the safety_findings wire name and the client listens", () => {
    const constants = srcOf("shared/constants.ts");
    expect(constants).toMatch(/safetyFindings:\s*"safety_findings"/);
    expect(constants).toMatch(/pauseAsk:\s*"pause_ask"/);
    const client = srcOf(modulePathMatching("src/client.ts"));
    expect(client).toContain("addEventListener(SSE_EVENT_TYPES.safetyFindings");
    expect(client).toContain("addEventListener(SSE_EVENT_TYPES.pauseAsk");
    // The listener hands the finding's own ledger address to the append —
    // the pass-through is part of this wire's contract, so the pin requires
    // the id argument's exact shape (severing the pass-through reds here,
    // where the append itself is pinned; the reveal the id buys is pinned
    // behaviorally in run-pane.test.ts's LIVE REVEAL arm and end to end by
    // the run-ends-are-announced wire arm).
    expect(client).toMatch(
      /appendEventMessage\(\s*\n\s*"safety-finding",\s*\n\s*finding\.message,\s*\n\s*typeof finding\.eventId === "string" \? finding\.eventId : undefined,/,
    );
  });

  test("the finding message carries the owner's stable marker, and the client reconstructs the kind from it", () => {
    const message = safetyFindingMessage("workaround", "tool x failed", "investigate it");
    expect(message.startsWith("Safety finding (workaround):")).toBe(true);
    expect(classifyInlineEvent("quality", message)).toBe("safety-finding");
  });

  test("a persisted timeline ref for a finding reconstructs as a safety-finding (refresh survival)", () => {
    // The persistence path maps "safety-finding" → timeline "quality"; the
    // reconstruction reads the owner's marker back from the description.
    const desc = safetyFindingMessage("stepSkip", "edit without read", "read first");
    expect(classifyInlineEvent("quality", desc)).toBe("safety-finding");
  });

  test("capability + argument derivation is dynamic (no hardcoded tool-name lists)", () => {
    expect(declaresCapability(["write"], "write")).toBe(true);
    expect(declaresCapability(["read"], "write")).toBe(false);
    expect(editFilePath({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(editFilePath({ file: "b.ts" })).toBe("b.ts");
    expect(editAddedLines({ newContent: "a\nb" })).toEqual(["a", "b"]);
    expect(editAddedLines({ text: "x" })).toEqual(["x"]);
    expect(editAddedLines({ patch: "+added\n-context" })).toEqual(["added"]);
    expect(readFilePath({ path: "p" })).toBe("p");
    expect(readFilePath({ file: "f" })).toBe("f");
    // SAFETY-WIRE-2 closure: a `name` arg is a SYMBOL name on the view tools
    // (quick_view, slice), never a file path — recording it as a read claims
    // the model opened a file it never opened, and can wrongly clear an
    // edit-before-read. Absence over fabrication: the probe must decline it.
    expect(readFilePath({ name: "identifierOfTheView" }), "a symbol name is not a file path — the probe declines it rather than fabricating a read").toBeNull();
    const readProbe = functionBody(srcOf(modulePath("safety-runtime-bridge.ts")), "readFilePath", "readFilePath");
    expect(readProbe.body, "the probe's key list is path+file — adding name back is the defect this arm closed").toMatch(/\["path", "file"\]/);
    expect(readProbe.body, "a symbol-name key must stay absent from the probe").not.toMatch(/"name"/);
    expect(toolIntent("read_file", { path: "src/x.ts" })).toBe("read_file:src/x.ts");
  });

  test("every safety accessor section is declared in the config schema (schema/accessor parity)", () => {
    // Discover the sections the config owner actually reads (`safety?.X`), then
    // require each one to be a declared write-gate path. An accessor that
    // reads a key the schema does not know is the defect: settings writes and
    // resolveAgents reject a hand-edited document that the accessor consumes.
    const src = srcOf(modulePath("harness-config.ts"));
    const sections = [...src.matchAll(/\bsafety\?\.(\w+)/g)].map((match) => match[1]);
    const unique = [...new Set(sections)];
    expect(unique.length, "the config owner must read at least one safety section").toBeGreaterThan(0);
    const undeclared = unique.filter((section) => !isConfigPathDeclared(`safety.${section}`));
    expect(
      undeclared,
      `safety accessor section(s) missing from CONFIG_DOCUMENT_SCHEMA: ${undeclared.join(", ")}`,
    ).toEqual([]);
  });

  test("a document that carries safety.eventFeed + safety.toolCallGate is persistable", () => {
    const document = JSON.parse(srcOf("engine/bridlewise.config.json")) as Record<string, unknown>;
    const result = CONFIG_DOCUMENT_SCHEMA.safeParse(document);
    expect(result.success, result.success ? "" : JSON.stringify(result.error.issues)).toBe(true);
    const safety = (result.success ? result.data : document).safety as Record<string, unknown> | undefined;
    expect(safety?.eventFeed, "the shipped document must carry the event-feed section").toBeDefined();
    expect(safety?.toolCallGate, "the shipped document must carry the tool-call-gate section").toBeDefined();
  });
});

// ── H. Mutation-verification pins ──

describe("H. mutation verification (the revert → red, reapply → green contract)", () => {
  test("removing the executor's recordToolCall feed reds the wiring arm", () => {
    const src = srcOf(modulePath("tool-executor.ts"));
    expect(src).toContain("ctx.safetyRuntime.recordToolCall");
    const run = runPathSource();
    expect(run).toContain("safetyRuntime.recordWork");
    expect(run).toContain("safetyRuntime.completeTask");
    // Recording in the run loop as well would double-count the parent's calls
    // and still miss the sub-agent path — the executor is the one feed.
    expect(run).not.toMatch(/safetyRuntime\.recordToolCall/);
  });

  test("discarding detect()'s report (the inert shape) reds the surface arms", () => {
    // The run path must PUBLISH the report it computed (B/F arms pin the
    // publish + persist lines). A call present but its result discarded —
    // the wired-but-inert class — fails those arms, reproduced by the
    // mutations recorded in this round's report.
    const src = runPathSource();
    expect(src).toMatch(/const safetyReport = safetyRuntime\.detect\(\)/);
    expect(src).toContain("publishRunFrame(runId, SSE_EVENT_TYPES.safetyFindings");
  });

  test("a second composition point reds the SPO arm", () => {
    // A new server module that starts calling the engine detectors directly
    // must fail arm A. This pin restates the owner's filename so a rename is
    // loud here, at the one site that must be updated.
    const owner = srcOf(modulePath("safety-runtime-bridge.ts"));
    expect(owner).toContain("createWorkaroundDetector");
    expect(owner).toContain("createBandaidDetector");
    expect(owner).toContain("createStepSkipDetector");
    expect(owner).toContain("createDeviationDetector");
    expect(owner).toContain("createInvestigator");
    expect(owner).toContain("createPauseAskBuilder");
  });

  test("the live runtime set is disposed per run (the aggregate cannot leak)", () => {
    const before = liveSafetyRuntimeCount();
    const a = armedRuntime();
    const b = armedRuntime();
    expect(liveSafetyRuntimeCount()).toBe(before + 2);
    a.dispose();
    b.dispose();
    expect(liveSafetyRuntimeCount()).toBe(before);
  });

  test("the boot resolves the safety posture before the socket listens (the hand-edit window's second door)", () => {
    // The write gate refuses a weakening section on the way in; what the
    // boot pin catches is bytes that never passed it — a hand-edited file
    // would otherwise arm a weaker gate or runtime for every run until the
    // next restart. The accessors assert the posture on the sections they
    // read (proven end-to-end in the harness-config suite), so the boot
    // wiring is: resolve BOTH accessors beside the privacy policy pin,
    // before the listen call. A boot that skips them reopens the window.
    const bootSource = readFileSync(join(import.meta.dirname, "../../server/index.ts"), "utf8");
    const privacyPin = bootSource.indexOf("getPrivacyPolicy();");
    const gatePin = bootSource.indexOf("getSafetyGateConfig();");
    const feedPin = bootSource.indexOf("getEventFeedSafetyConfig();");
    const listenAt = bootSource.indexOf("server.listen(");
    expect(privacyPin, "the privacy boot pin must stay in the boot path").toBeGreaterThan(0);
    expect(gatePin, "the boot must resolve the safety gate accessor before the socket listens").toBeGreaterThan(privacyPin);
    expect(feedPin, "the boot must resolve the event-feed accessor beside it").toBeGreaterThan(gatePin);
    expect(gatePin, "the safety posture pins must precede the listen call").toBeLessThan(listenAt);
    expect(feedPin, "the event-feed posture pin must precede the listen call").toBeLessThan(listenAt);
  });
});

// ── G. Leftover seams (delegation feed, cancel publish, live cache) ──

describe("G. leftover event-feed seams stay closed", () => {
  test("the executor records onto the threaded runtime (delegation re-enters the same choke point)", () => {
    const exec = srcOf(modulePath("tool-executor.ts"));
    expect(exec).toContain("ctx.safetyRuntime.recordToolCall");
    const bridge = srcOf(modulePath("agent-runtime-bridge.ts"));
    expect(bridge).toContain("async function executeViaWebExecutor");
    expect(bridge).toContain("return executeToolCall(name, args, ctx)");
    // A second record in the wrapper would double-count delegated calls.
    // Optional chaining is still a second record — a dot-only pin misses it.
    // A computed-member access (`safetyRuntime["recordToolCall"]`, chained or
    // not) is the same second record — the access-shape alternation below
    // names them all, so "deliberate" and "forgotten" are never confused
    // (a new access shape extends the pin here, never slips through it).
    // The behavioural arm below additionally witness-checks any leakage as a
    // live double-count.
    // The four deliberate shapes a second record can take — dot, chained
    // dot, bracket into the literal name, and chained bracket — all named
    // here so "deliberate" and "forgotten" are never confused (a new shape
    // extends the pin, never slips through it).
    const recordShape = /safetyRuntime(?:\s*\.\s*|\s*\?\s*\.\s*|\s*\[\s*["']|\s*\?\s*\.\s*\[\s*["'])recordToolCall/u;
    expect(bridge, "the wrapper must not record through any access shape (dot, optional chain, computed or chained-computed member)").not.toMatch(recordShape);
  });

  test("a mid-run liveState() poll sees findings recorded after the first detect (the cache cannot freeze)", () => {
    const rt = armedRuntime();
    toolOutcome(rt, { turn: 1, toolName: "edit", success: true, args: { path: "src/a.ts", newContent: "a\n" }, capabilities: ["write"] });
    expect(rt.liveState().stepSkipFindings).toBe(1);
    toolOutcome(rt, { turn: 2, toolName: "edit", success: true, args: { path: "src/b.ts", newContent: "b\n" }, capabilities: ["write"] });
    expect(rt.liveState().stepSkipFindings).toBe(2);
    // The poll above only drives recordToolCall. Dropping cached = null from
    // recordWork / completeTask / setOriginalTask would stay green without
    // a per-seam source pin.
    const owner = srcOf(modulePath("safety-runtime-bridge.ts"));
    for (const seam of ["function recordToolCall", "function recordWork", "function completeTask"] as const) {
      const start = owner.indexOf(seam);
      expect(start, `${seam} must exist so the cache-invalidation slice is real`).toBeGreaterThan(0);
      const next = owner.indexOf("\n  function ", start + seam.length);
      const slice = owner.slice(start, next > start ? next : start + 400);
      expect(slice, `${seam} must drop the cached detect so a live poll cannot freeze`).toContain("cached = null");
    }
    const setterBody = functionBody(owner, "setOriginalTask", "setter setOriginalTask");
    expect(setterBody.body, "setOriginalTask must drop the cached detect so a live poll cannot freeze").toContain("cached = null");
  });

  test("a delegated tool-switch after a failure produces a real workaround finding on the parent's runtime", async () => {
    const { createDelegationToolRegistry } = await import("../../server/agent/agent-runtime-bridge.ts");
    const { getToolManifest } = await import("../../server/tools/tools-bridge.ts");
    const rt = armedRuntime();
    const projectRoot = createTempDir("ch-safety-delegate-");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "app.ts"), "export const x = 0;\n");
    const parent = getToolManifest().filter((t) => t.category === "built-in");
    const ctx = {
      projectRoot,
      parentManifest: parent,
      safetyRuntime: rt,
      safetyTurn: 1,
    };
    const registry = createDelegationToolRegistry(ctx, parent, ["read"]);
    const failed = await registry.executeAsync(
      { id: "c1", name: "read_file", arguments: JSON.stringify({ path: "src/missing.ts" }) },
      { repositoryRoot: projectRoot },
    );
    expect(failed.content, "the missing-file read must fail so the switch is a real workaround").toMatch(/Error/i);
    const succeeded = await registry.executeAsync(
      { id: "c2", name: "list_files", arguments: JSON.stringify({ path: "." }) },
      { repositoryRoot: projectRoot },
    );
    expect(succeeded.content).toContain("src/");
    const report = rt.detect();
    expect(report.workaround.detectedCount).toBe(1);
    expect(report.workaround.findings[0]!.failedTool).toBe("read_file");
    expect(report.workaround.findings[0]!.switchedTo).toBe("list_files");
  });

  test("an unevaluated needsUserInstall leg is recorded honestly and can never pause", () => {
    // A bandaid's root cause is never install-probed on the run path — the
    // context says "unevaluated" — so the workaround family's leg stays
    // derived from recorded outcomes while every other family honestly says
    // "unevaluated" (the boolean this field carried for every family before
    // was the fabrication).
    const src = srcOf(modulePath("safety-runtime-bridge.ts"));
    expect(src).toMatch(
      /rootCauseNeedsUserInstall:\s*finding\.family\s*===\s*"workaround"\s*\?\s*unavailableTools\.has\(finding\.failedTool\)\s*:\s*"unevaluated"/,
    );
    // A bandaid finding can never surface an install demand on this path —
    // the workable evidence (typed tool unavailability) only exists for the
    // workaround family.
    const rt = armedRuntime();
    toolOutcome(rt, {
      turn: 1,
      toolName: "edit",
      success: true,
      args: { path: "src/app.ts", text: "try {\n  run();\n} catch (e) {\n}" },
      capabilities: ["write"],
    });
    const report = rt.detect();
    expect(report.pause).toBeNull();
    const bandaidVerdicts = report.investigation.filter((r) => r.finding.family === "bandaid");
    expect(bandaidVerdicts.some((r) => r.reason.includes("install")), "a bandaid surface must never demand an install nobody probed").toBe(false);
  });

  test("a later unconfigured-tool workaround still pauses after an earlier pause was consumed", () => {
    const rt = armedRuntime();
    toolOutcome(rt, { turn: 1, toolName: "search_web", success: false, error: "adapter_not_configured", unavailable: true, args: { query: "alpha" }, capabilities: ["read"] });
    toolOutcome(rt, { turn: 2, toolName: "list_files", success: true, args: { path: "." }, capabilities: ["read"] });
    const first = rt.takePendingIntervention();
    expect(first.pause).not.toBeNull();
    expect(rt.takePendingIntervention().pause).toBeNull();
    toolOutcome(rt, { turn: 3, toolName: "fetch_page", success: false, error: "adapter_not_configured", unavailable: true, args: { query: "beta" }, capabilities: ["read"] });
    toolOutcome(rt, { turn: 4, toolName: "search_code", success: true, args: { pattern: "x" }, capabilities: ["read"] });
    const second = rt.takePendingIntervention();
    expect(second.pause, "a new unconfigured-tool workaround must pause even after an earlier pause was consumed").not.toBeNull();
    expect(second.pause!.message).toMatch(/fetch_page/);
  });

  test("a reject on a stop-reason turn continues the loop so the model sees it", () => {
    const src = srcOf(modulePath("run-executor.ts"));
    expect(src).toContain("rejectedIntoNextTurn = true");
    expect(src).toMatch(/if\s*\(\s*rejectedIntoNextTurn\s*\)\s*\{(?:[^{}]|\{[^{}]*\})*turnPrompt = "";(?:[^{}]|\{[^{}]*\})*continue;/);
  });

  test("waitForRunPauseAnswer unblocks on steer and on abort", async () => {
    // The bound here is deliberately far away from the arm's own work so the
    // only resolutions it can observe are the ones it names.
    const farBoundMs = 24 * 60 * 60 * 1000;
    const steered = { steeringQueue: [] as string[] } as ActiveRun;
    let steeredDone: string | false = false;
    const steeredWait = waitForRunPauseAnswer(steered, new AbortController().signal, farBoundMs).then((outcome) => {
      steeredDone = outcome;
    });
    await Promise.resolve();
    expect(steeredDone, "the pause wait must not resolve before the user steers").toBe(false);
    await Promise.resolve();
    expect(steeredDone, "a microtask auto-resolve after the first drain is still a resolve-before-steer").toBe(false);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(steeredDone, "a timer-moment auto-resolve is still a resolve-before-steer").toBe(false);
    notifyRunPauseAnswer(steered);
    await steeredWait;
    expect(steeredDone).toBe("answered");

    const aborted = { steeringQueue: [] as string[] } as ActiveRun;
    const ac = new AbortController();
    const abortedWait = waitForRunPauseAnswer(aborted, ac.signal, farBoundMs);
    ac.abort();
    expect(await abortedWait).toBe("cancelled");

    const alreadyAnswered = { steeringQueue: ["go ahead"] } as ActiveRun;
    expect(await waitForRunPauseAnswer(alreadyAnswered, new AbortController().signal, farBoundMs)).toBe("answered");

    const alreadyCancelled = { steeringQueue: [] as string[] } as ActiveRun;
    const ac2 = new AbortController();
    ac2.abort();
    expect(await waitForRunPauseAnswer(alreadyCancelled, ac2.signal, farBoundMs)).toBe("cancelled");
  });

  test("an unanswered pause resolves as timedOut at the configured bound (never silently hangs)", async () => {
    // The wait's bound is a REQUIRED argument — "wait with no bound" is not
    // a shape the API offers — and the timeout is the bound's owned
    // resolution. Fake timers: no wall-clock sleep, deterministic firing.
    vi.useFakeTimers();
    try {
      const waiting = { steeringQueue: [] as string[] } as ActiveRun;
      const wait = waitForRunPauseAnswer(waiting, new AbortController().signal, 60_000);
      await vi.advanceTimersByTimeAsync(59_999);
      const early = await Promise.race([wait, Promise.resolve("stillWaiting")] as const);
      expect(early, "the bound is a bound: firing one short of it is a false timeout").toBe("stillWaiting");
      // Drive the clock PAST the bound and ask which resolution won. A wait
      // with no timer at all (the ABSENT shape: the bound never reaching a
      // timer) never settles, so the race names it instead of hanging the
      // arm; a timer that fires but resolves the WRONG outcome (the INERT
      // shape) fails the exact-word assertion below.
      const probe = vi.advanceTimersByTimeAsync(2).then(() => "neverResolved" as const);
      const outcome = await Promise.race([wait, probe] as const);
      expect(outcome, "past the bound an unanswered pause must resolve as the owned timeout outcome").toBe("timedOut");

      // A steer before the bound still wins over the pending timer.
      const answered = { steeringQueue: [] as string[] } as ActiveRun;
      const answeredWait = waitForRunPauseAnswer(answered, new AbortController().signal, 60_000);
      notifyRunPauseAnswer(answered);
      expect(await answeredWait).toBe("answered");
      // And the fired answer's timer must not later resolve FOR another wait.
      const cancel = new AbortController();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await Promise.race([waitForRunPauseAnswer({ steeringQueue: [] as string[] } as ActiveRun, cancel.signal, 0).then((o) => o), Promise.resolve("hung")])).toBe("hung");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a timed-out pause end is a NAMED outcome, not a silent completion", () => {
    // The run's terminal vocabulary is enumerated in the executor's finally:
    // an unanswered pause past the bound ends the run as `error` /
    // `pause_answer_timeout` — the iteration-limit shape (a configured bound
    // doing its job), NEVER `done` (the run never finished) and never a
    // hung wait (the defect this round closes). The call must pass the
    // owner-resolved bound, not a local literal (a literal is a second
    // config source besides safety.eventFeed.pauseAskWaitTimeoutMs).
    const src = srcOf(modulePath("run-executor.ts"));
    expect(src).toContain("safetyRuntime.pauseAskWaitTimeoutMs");
    // Scope by the CONSTRUCT, not a byte count. `bindingValueOf` locates the
    // `pauseWait` initializer (throwing on absence or ambiguity, so a vanished
    // or duplicated binding fails rather than reports nothing), and
    // `enclosingFunctionOf` widens from that exact offset to the one function
    // body that owns the wait, the comparison and the frame it builds. Every
    // claim below is asked of that construct — never of a byte window that a
    // neighbouring statement could satisfy.
    const pauseValue = bindingValueOf(src, "pauseWait", "the executor's pauseWait binding");
    const owner = enclosingFunctionOf(src, pauseValue.offset, "the function holding the pause wait");
    expect(owner, "the pause wait must live inside a function body").toBeDefined();
    // The bound is config-owned, checked by NAME at the argument position: the
    // third argument is the owner-resolved bound. A numeric literal there is a
    // second config source beside safety.eventFeed.pauseAskWaitTimeoutMs and
    // fails this same call — a trailing comma is ordinary multiline shape.
    expect(bodyCallsWith(pauseValue, "waitForRunPauseAnswer", ["active", "active.abortController.signal", "safetyRuntime.pauseAskWaitTimeoutMs"])).toBe(true);
    // A timed-out pause end is a NAMED outcome, asked of the owning function's
    // own body text: it checks the wait's outcome by name, and the terminal
    // frame it builds carries the timeout's own vocabulary.
    expect(owner!.body).toContain('pauseWait === "timedOut"');
    expect(owner!.body).toContain('code: "pause_answer_timeout"');
    expect(owner!.body).toContain("terminalFrame = {");
  });

  test("an MCP not-connected error is typed unavailable, not a string match on the output", async () => {
    const { isMcpUnavailableError } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const { McpError } = await import("../../engine/src/mcp/errors.ts");
    expect(isMcpUnavailableError(new McpError("MCP client is not connected", "mcp_not_connected", false, {}, true))).toBe(true);
    expect(isMcpUnavailableError(new McpError("server missing", "mcp_server_not_registered"))).toBe(true);
    expect(isMcpUnavailableError(new McpError("tool is disabled", "mcp_tool_disabled"))).toBe(true);
    expect(isMcpUnavailableError(new McpError("this tool is disabled", "mcp_error")), "a disabled-looking message with a generic code is not unavailable").toBe(false);
    expect(isMcpUnavailableError(new McpError("tool blew up", "mcp_error"))).toBe(false);
    expect(isMcpUnavailableError(new McpError("tool reported an error", "mcp_call_tool_failed")), "a completed MCP error is a failure, not an unavailable server").toBe(false);
    expect(isMcpUnavailableError(new McpError("the start was discarded", "mcp_start_superseded")), "a superseded start is a transient-lifecycle refusal — the current lifecycle owns the runtime, the tool was never broken").toBe(true);
    expect(isMcpUnavailableError(new Error("MCP client is not connected")), "a bare Error with the same text is not unavailable").toBe(false);
    // The decode lives once, in the engine's taxonomy owner: the bridge's
    // helper is the boolean projection of it (no private switch over
    // `err.code` may grow back beside it), and the executor's catch decodes
    // once from the same classifier — the boolean AND the reason key it
    // forwards can never disagree.
    const exec = srcOf(modulePath("tool-executor.ts"));
    expect(exec, "the executor decodes the typed refusal once").toContain("const reason = mcpUnavailableReason(err)");
    expect(exec).toMatch(/\.\.\.\(reason !== null \? \{ unavailable: true, unavailableReason: reason\.key \} : \{\}\)/);
    const mcp = srcOf(modulePath("mcp-runtime-bridge.ts"));
    const helperStart = mcp.indexOf("export function isMcpUnavailableError");
    const helperEnd = mcp.indexOf("export async function callMcpTool");
    expect(helperEnd, "the unavailable helper must precede callMcpTool so the slice is the helper").toBeGreaterThan(helperStart);
    const helper = mcp.slice(helperStart, helperEnd);
    expect(helper, "the helper derives from the single classifier").toContain("mcpUnavailableReason(err) !== null");
    expect(helper, "a second, drifting switch over error codes is prohibited — the classifier owns the decode").not.toMatch(/err\.code ===/);
  });

  test("the unavailability pause names the REAL cause — a recorded reason key reaches the user-facing pause sentence", () => {
    // The full owned path: outcome → runtime store → investigation context →
    // pause text. An INERT forward (the outcome carries the reason but the
    // runtime never forwards it to the investigation) produces the generic
    // install/configure text — exactly the misattribution this arm exists
    // to refuse.
    const rt = armedRuntime();
    toolOutcome(rt, { turn: 1, toolName: "mcp__docs__search", success: false, error: "the MCP runtime start was superseded before it could publish", unavailable: true, unavailableReason: "start-superseded", args: { query: "alpha" }, capabilities: ["read"] });
    toolOutcome(rt, { turn: 2, toolName: "search_code", success: true, args: { pattern: "x" }, capabilities: ["read"] });
    const intervention = rt.takePendingIntervention();
    expect(intervention.pause).not.toBeNull();
    expect(intervention.pause!.message, "a transient restart must read as transient — never as a demand to install or configure anything").toMatch(/transient/);
    expect(intervention.pause!.message).not.toMatch(/install|configur/i);
    expect(intervention.pause!.message).toContain("mcp__docs__search");
    // A deliberate disable is the user's own choice — the sentence owns that.
    const rt2 = armedRuntime();
    toolOutcome(rt2, { turn: 1, toolName: "mcp__docs__search", success: false, error: "tool disabled", unavailable: true, unavailableReason: "disabled", args: { query: "beta" }, capabilities: ["read"] });
    toolOutcome(rt2, { turn: 2, toolName: "search_code", success: true, args: { pattern: "y" }, capabilities: ["read"] });
    const intervention2 = rt2.takePendingIntervention();
    expect(intervention2.pause).not.toBeNull();
    expect(intervention2.pause!.message, "a deliberate disable asks to be re-enabled, not installed").toMatch(/turn it back on/i);
    expect(intervention2.pause!.message).not.toMatch(/missing/i);
    // The reason taxonomy pins its OWN membership: every code the classifier
    // owns produces its own user-facing sentence — a reason sharing another
    // reason's text is a hidden flattening.
    expect(intervention2.pause!.message).not.toBe(intervention.pause!.message);
  });

  test("the unavailable reason set is last-outcome-wins — a stale cause can never borrow a newer outcome's judgment", () => {
    // An UNTYPED unavailability carries no cause: the earlier typed reason
    // must clear, or the pause borrows a cause that is no longer the tool's
    // latest state. The generic text is the only honest sentence left.
    const rt = armedRuntime();
    toolOutcome(rt, { turn: 1, toolName: "search_web", success: false, unavailable: true, unavailableReason: "shut-down", args: { query: "alpha" }, capabilities: ["read"] });
    toolOutcome(rt, { turn: 2, toolName: "search_web", success: false, unavailable: true, args: { query: "alpha" }, capabilities: ["read"] });
    toolOutcome(rt, { turn: 3, toolName: "list_files", success: true, args: { path: "." }, capabilities: ["read"] });
    const intervention = rt.takePendingIntervention();
    expect(intervention.pause, "still unavailable — but without a recorded cause").not.toBeNull();
    expect(intervention.pause!.message, "an untyped unavailability clears the earlier typed reason — the generic text is the honest fallback").not.toMatch(/shutting down/i);
    expect(intervention.pause!.message).toMatch(/miss|unavailable|unreach|not available/i);
    // A NON-unavailable outcome (a plain failure, a success) means the tool
    // answered: it leaves the unavailable set entirely, AND its stored reason
    // is unborrowable — the swap is judged, never paused on stale evidence.
    const rt2 = armedRuntime();
    toolOutcome(rt2, { turn: 1, toolName: "search_web", success: false, unavailable: true, unavailableReason: "shut-down", args: { query: "beta" }, capabilities: ["read"] });
    toolOutcome(rt2, { turn: 2, toolName: "search_web", success: false, args: { query: "beta" }, capabilities: ["read"] });
    toolOutcome(rt2, { turn: 3, toolName: "list_files", success: true, args: { path: "." }, capabilities: ["read"] });
    const intervention2 = rt2.takePendingIntervention();
    expect(intervention2.pause, "the tool answered on its latest outcome — nothing about unavailability survives to a pause").toBeNull();
    const verdicts2 = rt2.detect().investigation.filter((r) => r.finding.family === "workaround");
    expect(verdicts2.length).toBeGreaterThanOrEqual(1);
    for (const v of verdicts2) {
      expect(v.verdict, "a plain-failure swap is judged, it does not pause on cleared evidence").toBe("unnecessary");
      expect(v.action).toBe("reject");
    }
  });

  test("an MCP tool that reports isError is a failed call, not a successful string", () => {
    const mcp = srcOf(modulePath("mcp-runtime-bridge.ts"));
    const start = mcp.indexOf("export async function callMcpTool");
    const end = mcp.indexOf("export async function getLiveMcpServerSignals");
    expect(end, "callMcpTool must precede the status reader so the slice is the dispatch function").toBeGreaterThan(start);
    const fn = mcp.slice(start, end);
    expect(fn.length, "the callMcpTool slice must contain the function").toBeGreaterThan(200);
    expect(fn, "callMcpTool must not return the MCP payload when the tool reported an error").toMatch(/if\s*\(\s*result\.isError\s*\)\s*\{(?:[^{}]|\{[^{}]*\})*throw new McpError\(/);
    expect(fn, "a completed MCP error is a tool failure — unavailable classification stays on the helper").not.toMatch(/\bisMcpUnavailableError\b/);
    const exec = srcOf(modulePath("tool-executor.ts"));
    const dispatchStart = exec.indexOf("if (isMcpToolName(toolName))");
    const dispatchEnd = exec.indexOf("const impl = TOOL_HANDLERS");
    expect(dispatchEnd, "the MCP dispatch slice must be the executor's MCP (mcp__*) fallthrough").toBeGreaterThan(dispatchStart);
    const dispatch = exec.slice(dispatchStart, dispatchEnd);
    expect(dispatch, "a returned MCP string is success — isError must throw before this line").toContain("result = { success: true, output");
    expect(dispatch, "the executor catch is the only success:false door for a thrown MCP result").toMatch(/success:\s*false/);
    expect(dispatch, "the MCP fallthrough must pass the run abort, not drop it").toMatch(/callMcpTool\(\s*toolName,\s*effectiveArgs,\s*ctx\.runSignal\s*\)/);
    expect(dispatch, "the MCP fallthrough hands over the NAME — nothing in the executor parses it").not.toMatch(/\.slice\(|indexOf\(/);
    expect(exec, "execute_command must pass the run abort through spawn, not drop it").toMatch(/spawnAsyncSafe\(\s*command,\s*cmdArgs,\s*cwd,\s*ctx\.projectRoot,\s*ctx\.runSignal\s*\)/);
    const spawnStart = exec.indexOf("function spawnAsyncSafe");
    const spawnEnd = exec.indexOf("Editor tools (governed", spawnStart);
    expect(spawnEnd, "spawnAsyncSafe must precede the editor tools so the slice is the spawn door").toBeGreaterThan(spawnStart);
    const spawnFn = exec.slice(spawnStart, spawnEnd);
    expect(spawnFn.length, "the spawnAsyncSafe slice must contain the function").toBeGreaterThan(200);
    expect(spawnFn, "the confined spawn must receive the run abort, not only a timeout").toContain("spawnPlanned(plan,");
    expect(spawnFn, "the confined spawn must receive the run abort, not only a timeout").toMatch(/signal:\s*runSignal/);
  });
});
