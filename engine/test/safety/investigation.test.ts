import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveBandaidConfig } from "../../src/safety/bandaid-config.ts";
import {
  createInvestigator,
  dominantVerdict,
  anyNeedsUserAction,
  type InvestigationContext,
  type InvestigationResult,
} from "../../src/safety/investigation.ts";
import {
  createBandaidDetector,
  type EditEvent,
} from "../../src/safety/bandaid-detector.ts";
import { createWorkaroundDetector } from "../../src/safety/workaround-detector.ts";
import { createDeviationDetector } from "../../src/safety/deviation-detector.ts";
import { McpError } from "../../src/mcp/errors.ts";
import { MCP_UNAVAILABILITY_CODES, mcpUnavailableReason } from "../../src/mcp/unavailability.ts";
import { learnedConfig } from "./learned-bandaid-corpus.ts";

/**
 * EXP408/EXP432 investigation. EXP432 uses the LEARNED config so the
 * bandaid detector catches `@ts-ignore` etc. via the learned pragmas.
 */
function cfg() { return learnedConfig(); }

function ctx(over: Partial<InvestigationContext> = {}): InvestigationContext {
  return {
    rootCauseKnown: false,
    rootCauseFixableByLLM: false,
    rootCauseNeedsUserInstall: false,
    toolReportedUnavailable: false,
    taskPossible: true,
    deviationIsImprovement: false,
    ...over,
  };
}

// ===== Legitimate deviation: 10 cases where the deviation is legitimate =====

test("investigation: legitimate deviation — 10 cases, no false flag (100% accuracy)", () => {
  const c = cfg();
  const inv = createInvestigator({ config: c });
  // 10 deviation findings where deviationIsImprovement=true → "necessary" (allow).
  let necessary = 0;
  for (let i = 0; i < 10; i += 1) {
    const d = createDeviationDetector({ config: c });
    d.setOriginalTask("refactor function X");
    d.recordWork({ turn: 1 + i, description: "unrelated work to a different module", filesTouched: [`other${i}.ts`], searches: [] });
    d.recordWork({ turn: 2 + i, description: "more unrelated work", filesTouched: [`other${i}.ts`], searches: [] });
    d.recordWork({ turn: 3 + i, description: "continue unrelated", filesTouched: [`other${i}.ts`], searches: [] });
    d.recordWork({ turn: 4 + i, description: "finish unrelated", filesTouched: [`other${i}.ts`], searches: [] });
    const report = d.detect();
    if (report.findings.length === 0) continue;
    const result = inv.investigate(report.findings[0]!, ctx({ deviationIsImprovement: true }));
    if (result.verdict === "necessary" && result.action === "allow-and-record") necessary += 1;
  }
  assert.equal(necessary, 10, `expected 10 legitimate deviations allowed, got ${necessary}`);
});

// ===== Pause-and-ask: 10 cases where a tool/dependency is missing =====

test("investigation: pause-and-ask — 10 cases where a tool/dependency is missing (100%)", () => {
  const c = cfg();
  const inv = createInvestigator({ config: c });
  let paused = 0;
  // 5 workaround findings where the tool was reported unavailable.
  for (let i = 0; i < 5; i += 1) {
    const wd = createWorkaroundDetector({ config: c });
    wd.recordToolCall({ turn: 1, toolName: "search_code", intent: `find X ${i}`, success: false, unavailable: true });
    wd.recordToolCall({ turn: 2, toolName: "grep", intent: `find X ${i}`, success: true });
    const r = wd.detect();
    if (r.findings.length === 0) continue;
    const result = inv.investigate(r.findings[0]!, ctx({ toolReportedUnavailable: true }));
    if (result.verdict === "needs-user-action" && result.action === "pause-and-ask") paused += 1;
  }
  // 5 bandaid findings where the root cause needs a user install.
  for (let i = 0; i < 5; i += 1) {
    const bd = createBandaidDetector({ config: c });
    bd.recordEdit({
      turn: 1,
      filePath: `a${i}.ts`,
      addedLines: ["// @ts-ignore"],
      removedLines: [],
    } as EditEvent);
    const r = bd.detect();
    if (r.findings.length === 0) continue;
    const result = inv.investigate(r.findings[0]!, ctx({ rootCauseNeedsUserInstall: true, rootCauseKnown: true, rootCauseFixableByLLM: false }));
    if (result.verdict === "needs-user-action" && result.action === "pause-and-ask") paused += 1;
  }
  assert.equal(paused, 10, `expected 10 pause-and-ask, got ${paused}`);
});

// ===== Root-cause fix enforcement: 10 cases where the root cause is known =====

test("investigation: root-cause fix enforcement — 10 cases (100%)", () => {
  const c = cfg();
  const inv = createInvestigator({ config: c });
  let rejected = 0;
  for (let i = 0; i < 10; i += 1) {
    const bd = createBandaidDetector({ config: c });
    bd.recordEdit({
      turn: 1,
      filePath: `a${i}.ts`,
      addedLines: ["// @ts-ignore", "const x = y;"],
      removedLines: [],
    } as EditEvent);
    const r = bd.detect();
    if (r.findings.length === 0) continue;
    // Root cause known + fixable by LLM + edit does NOT address it (overlap=1 because no knownRootCauseFix, but the pattern was hit).
    // For a pure pattern-hit bandaid with rootCauseKnown + fixableByLLM, the verdict is "unnecessary".
    const result = inv.investigate(
      r.findings[0]!,
      ctx({ rootCauseKnown: true, rootCauseFixableByLLM: true, rootCauseNeedsUserInstall: false }),
    );
    // The bandaid has rootCauseOverlap=1 (no knownRootCauseFix provided), so the
    // overlap-floor check passes (1 >= floor) → "necessary". To force the
    // root-cause-fix enforcement, use a finding with a real root-cause-not-addressed.
    if (result.verdict === "unnecessary" && result.action === "reject") rejected += 1;
  }
  // Now build 10 findings where the edit does NOT address the root cause
  // (root-cause-not-addressed) and the LLM could fix it → "unnecessary" (reject).
  let rejectedReal = 0;
  for (let i = 0; i < 10; i += 1) {
    const bd = createBandaidDetector({ config: c });
    bd.recordEdit({
      turn: 1,
      filePath: `b${i}.ts`,
      addedLines: ["return null;"],
      removedLines: [],
      rootCauseHint: "parseConfig returns null when config is missing",
      knownRootCauseFix: "guard config-missing at the parseConfig call site",
    } as EditEvent);
    const r = bd.detect();
    const rootCauseFinding = r.findings.find((f) => f.category === "root-cause-not-addressed");
    if (!rootCauseFinding) continue;
    const result = inv.investigate(
      rootCauseFinding,
      ctx({ rootCauseKnown: true, rootCauseFixableByLLM: true, rootCauseNeedsUserInstall: false }),
    );
    if (result.verdict === "unnecessary" && result.action === "reject") rejectedReal += 1;
  }
  assert.equal(rejectedReal, 10, `expected 10 root-cause-fix rejections, got ${rejectedReal}`);
});

// ===== Investigation: 10 cases where the bandaid is necessary (root cause can't be fixed) =====

test("investigation: bandaid necessary — 10 cases where root cause can't be fixed (100%)", () => {
  const c = cfg();
  const inv = createInvestigator({ config: c });
  let necessary = 0;
  for (let i = 0; i < 10; i += 1) {
    const bd = createBandaidDetector({ config: c });
    bd.recordEdit({
      turn: 1,
      filePath: `a${i}.ts`,
      addedLines: ["// @ts-ignore", "const x = y;"],
      removedLines: [],
    } as EditEvent);
    const r = bd.detect();
    if (r.findings.length === 0) continue;
    // Root cause known but NOT fixable by the LLM (e.g. a third-party type
    // definition the LLM can't edit) → the bandaid is "necessary" (allow).
    const result = inv.investigate(
      r.findings[0]!,
      ctx({ rootCauseKnown: true, rootCauseFixableByLLM: false, rootCauseNeedsUserInstall: false }),
    );
    if (result.verdict === "necessary" && result.action === "allow-and-record") necessary += 1;
  }
  assert.equal(necessary, 10, `expected 10 necessary bandaids, got ${necessary}`);
});

// ===== Investigation: root cause NOT known — bandaid allowed =====

test("investigation: root cause unknown — bandaid allowed (necessary)", () => {
  const c = cfg();
  const inv = createInvestigator({ config: c });
  const bd = createBandaidDetector({ config: c });
  bd.recordEdit({ turn: 1, filePath: "a.ts", addedLines: ["// @ts-ignore"], removedLines: [] } as EditEvent);
  const r = bd.detect();
  const result = inv.investigate(r.findings[0]!, ctx({ rootCauseKnown: false }));
  assert.equal(result.verdict, "necessary");
  assert.equal(result.action, "allow-and-record");
});

// ===== Investigation: workaround when tool is broken (not unavailable) → reject =====

test("investigation: workaround tool broken (not unavailable) — reject", () => {
  const c = cfg();
  const inv = createInvestigator({ config: c });
  const wd = createWorkaroundDetector({ config: c });
  wd.recordToolCall({ turn: 1, toolName: "search_code", intent: "find X", success: false });
  wd.recordToolCall({ turn: 2, toolName: "grep", intent: "find X", success: true });
  const r = wd.detect();
  const result = inv.investigate(r.findings[0]!, ctx({ toolReportedUnavailable: false }));
  assert.equal(result.verdict, "unnecessary");
  assert.equal(result.action, "reject");
});

// ===== Unevaluated legs: recorded, never judged =====

test("investigation: unevaluated task legs never pause and never judge — the deviation is recorded", () => {
  const c = cfg();
  const inv = createInvestigator({ config: c });
  const d = createDeviationDetector({ config: c });
  d.setOriginalTask("refactor function X");
  for (let i = 1; i <= 4; i += 1) {
    d.recordWork({ turn: i, description: "unrelated", filesTouched: [`other${i}.ts`], searches: [] });
  }
  const r = d.detect();
  const result = inv.investigate(r.findings[0]!, ctx({ taskPossible: "unevaluated", deviationIsImprovement: "unevaluated" }));
  assert.equal(result.verdict, "necessary");
  assert.equal(result.action, "allow-and-record");
  assert.match(result.reason, /No site assessed whether the original task is still possible/);
  // The unevaluated sentence must never carry the fabricated-impossibility
  // claim that the older hardcoded-false wiring shipped.
  assert.doesNotMatch(result.reason, /appears not to be possible/);
});

test("investigation: unevaluated root-cause legs allow-and-record without judging", () => {
  const c = cfg();
  const inv = createInvestigator({ config: c });
  const bd = createBandaidDetector({ config: c });
  bd.recordEdit({ turn: 1, filePath: "a.ts", addedLines: ["// @ts-ignore"], removedLines: [] } as EditEvent);
  const r = bd.detect();
  // No probe ran at the site: "unevaluated" — allow + record, sentence owns it.
  const result = inv.investigate(r.findings[0]!, ctx({ rootCauseKnown: "unevaluated", rootCauseFixableByLLM: "unevaluated", rootCauseNeedsUserInstall: "unevaluated" }));
  assert.equal(result.verdict, "necessary");
  assert.equal(result.action, "allow-and-record");
  assert.match(result.reason, /No root-cause assessment ran at this site/);
  // Known root cause + unevaluated fixability: recorded, never judged.
  const result2 = inv.investigate(r.findings[0]!, ctx({ rootCauseKnown: true, rootCauseFixableByLLM: "unevaluated" }));
  assert.equal(result2.action, "allow-and-record");
  assert.match(result2.reason, /no site assessed whether the LLM could fix it/);
});

test("investigation: an unevaluated install need never pauses the user", () => {
  const c = cfg();
  const inv = createInvestigator({ config: c });
  const wd = createWorkaroundDetector({ config: c });
  wd.recordToolCall({ turn: 1, toolName: "search_code", intent: "find X", success: false });
  wd.recordToolCall({ turn: 2, toolName: "grep", intent: "find X", success: true });
  const r = wd.detect();
  // The workaround's tool-unavailability leg is "unevaluated" (nobody asked
  // the tool why it failed): the call must NOT pause on an invented install
  // need — a paused run costs the user a question nobody earned.
  const result = inv.investigate(r.findings[0]!, ctx({ rootCauseNeedsUserInstall: "unevaluated", toolReportedUnavailable: false }));
  assert.equal(result.verdict, "unnecessary");
  assert.equal(result.action, "reject");
  assert.doesNotMatch(result.pauseMessage, /install/);
});

// ===== Investigation: deviation task impossible → pause-and-ask =====

test("investigation: deviation task impossible — pause-and-ask", () => {
  const c = cfg();
  const inv = createInvestigator({ config: c });
  const d = createDeviationDetector({ config: c });
  d.setOriginalTask("refactor function X");
  for (let i = 1; i <= 4; i += 1) {
    d.recordWork({ turn: i, description: "unrelated", filesTouched: [`other${i}.ts`], searches: [] });
  }
  const r = d.detect();
  const result = inv.investigate(r.findings[0]!, ctx({ taskPossible: false, deviationIsImprovement: false }));
  assert.equal(result.verdict, "needs-user-action");
  assert.equal(result.action, "pause-and-ask");
});

// ===== Pause text fidelity: every typed unavailability reason owns an honest sentence =====

test("investigation: the pause text names the REAL cause — every typed reason has its own honest sentence", () => {
  const c = cfg();
  const inv = createInvestigator({ config: c });
  const sentences = new Map<string, string>();
  for (const code of MCP_UNAVAILABILITY_CODES) {
    // The reason key derives from the typed code once (the same decode the
    // bridge uses) — a code that forgets its classification turns this loop
    // red: its key is undefined and there is no sentence to record.
    const key = mcpUnavailableReason(new McpError("probe", code))?.key;
    assert.ok(key !== undefined, `${code} must classify to a reason key`);
    const wd = createWorkaroundDetector({ config: c });
    wd.recordToolCall({ turn: 1, toolName: `mcp__samex__${code}`, intent: "find X", success: false, unavailable: true });
    wd.recordToolCall({ turn: 2, toolName: "grep", intent: "find X", success: true });
    const r = wd.detect();
    assert.ok(r.findings.length >= 1, `the workaround finding itself must exist for ${code}`);
    const result = inv.investigate(r.findings[0]!, ctx({ toolReportedUnavailable: true, toolUnavailableReason: key }));
    assert.equal(result.action, "pause-and-ask");
    assert.ok(result.pauseMessage.includes(`Tool "mcp__samex__${code}"`), `${key}: the sentence names the tool`);
    assert.ok(![...sentences.values()].includes(result.pauseMessage), `${key} must own its own sentence — no two reasons may share one text`);
    sentences.set(key, result.pauseMessage);
  }
  // The honest-content contract per reason, in plain words:
  // - the transient restart says so and never demands an install or a
  //   configuration change (there is nothing to install);
  // - the deliberate disable never reads as "missing" — the user chose it;
  // - a disconnected service is a service that needs starting, not a
  //   missing one;
  // - a never-configured server DOES ask to be set up;
  // - a sealed runtime names the shutdown.
  const superseded = sentences.get("start-superseded");
  assert.ok(superseded !== undefined, "start-superseded must produce a sentence");
  assert.match(superseded, /transient/);
  assert.doesNotMatch(superseded, /install|configur|turn(ed)? back/i);
  const disabled = sentences.get("disabled");
  assert.ok(disabled !== undefined, "disabled must produce a sentence");
  assert.match(disabled, /turn it back on/i);
  assert.doesNotMatch(disabled, /missing|not configured|install/i);
  const notConnected = sentences.get("not-connected");
  assert.ok(notConnected !== undefined, "not-connected must produce a sentence");
  assert.match(notConnected, /not connected/);
  assert.doesNotMatch(notConnected, /install|configur/i);
  const notRegistered = sentences.get("not-registered");
  assert.ok(notRegistered !== undefined, "not-registered must produce a sentence");
  assert.match(notRegistered, /not configured|set it up/i);
  const shutDown = sentences.get("shut-down");
  assert.ok(shutDown !== undefined, "shut-down must produce a sentence");
  assert.match(shutDown, /shutting down/i);
  // One sentence per taxonomy code — the expectation is the taxonomy's OWN
  // membership, so a code added to the taxonomy without a sentence moves the
  // expectation with it (no hand-counted tripwire to drift), and two codes
  // collapsing onto one key still red (the census shrinks, the taxonomy does
  // not).
  assert.equal(
    sentences.size,
    MCP_UNAVAILABILITY_CODES.length,
    "every reason key produced its own sentence, one per taxonomy code",
  );
});

test("investigation: unavailability guidance is exact — the object itself is checked, not the freeze call", () => {
  // Type-level close: an extra key is a compile error only when the exactness
  // check is on the object literal. A source pin here is a witness that the
  // keyword was not deleted or moved after freeze(; tsc refusing the extra
  // key is the close. The sentence census above walks taxonomy codes, never
  // orphan keys, so it cannot own this arm.
  const src = readFileSync(new URL("../../src/safety/investigation.ts", import.meta.url), "utf8");
  const start = src.indexOf("const TOOL_UNAVAILABLE_GUIDANCE");
  assert.ok(start >= 0, "the guidance map must exist in the investigation owner");
  const end = src.indexOf("function switchDescription", start);
  assert.ok(end > start, "the guidance map must end before switchDescription");
  const decl = src.slice(start, end);
  assert.match(
    decl,
    /\}\s*satisfies\s+Readonly<Record<McpUnavailabilityKey/,
    "the exactness check must sit on the object literal so an extra key is a type error",
  );
  assert.doesNotMatch(
    decl,
    /\)\s*satisfies/,
    "checking the freeze call (not the object) lets an extra key typecheck",
  );
  assert.doesNotMatch(
    decl,
    /TOOL_UNAVAILABLE_GUIDANCE\s*:\s*Readonly<Record/,
    "annotating the frozen const is the hole: freeze is a call, so extra keys typecheck",
  );
});

test("investigation: an unavailable refusal WITHOUT a typed cause keeps the generic install/configure text", () => {
  // An adapter that was never configured has no refused-code taxonomy — the
  // generic text is the honest one for it (something IS missing there).
  const c = cfg();
  const inv = createInvestigator({ config: c });
  const wd = createWorkaroundDetector({ config: c });
  wd.recordToolCall({ turn: 1, toolName: "search_web", intent: "find X", success: false, unavailable: true });
  wd.recordToolCall({ turn: 2, toolName: "grep", intent: "find X", success: true });
  const r = wd.detect();
  const result = inv.investigate(r.findings[0]!, ctx({ toolReportedUnavailable: true }));
  assert.equal(result.action, "pause-and-ask");
  assert.match(result.pauseMessage, /missing or unconfigured/);
});

// ===== Helpers: dominantVerdict + anyNeedsUserAction =====

test("investigation: dominantVerdict + anyNeedsUserAction helpers", () => {
  const results: InvestigationResult[] = [
    { verdict: "necessary", action: "allow-and-record", finding: { family: "bandaid", turn: 1, filePath: "a.ts", severity: "low", patternLabel: "x", category: "type-suppression", evidenceLine: "", rootCauseOverlap: 1, recommendation: "" }, reason: "", pauseMessage: "" },
    { verdict: "needs-user-action", action: "pause-and-ask", finding: { family: "workaround", turn: 2, severity: "medium", failedTool: "search_code", intent: "x", switchKind: "tool-switch", switchTurn: 3, switchedTo: "grep", evidence: "", recommendation: "" }, reason: "", pauseMessage: "install the tool" },
  ];
  assert.equal(anyNeedsUserAction(results), true);
  assert.equal(dominantVerdict(results), "needs-user-action");
  assert.equal(dominantVerdict([]), "necessary");
});

test("investigation: disabled investigation — config flag", () => {
  // The investigator does not check investigationEnabled (that's the orchestrator's
  // responsibility — the investigator always returns a verdict). Verify the
  // config flag is honored by the orchestrator, not the investigator.
  const c = resolveBandaidConfig({ investigationEnabled: false });
  assert.equal(c.investigationEnabled, false);
});
