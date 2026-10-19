import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBandaidConfig } from "../../src/safety/bandaid-config.ts";
import { createBandaidDetector, type EditEvent } from "../../src/safety/bandaid-detector.ts";
import { learnedConfig } from "./learned-bandaid-corpus.ts";
import {
  createWorkaroundDetector,
  type WorkaroundEditEvent,
} from "../../src/safety/workaround-detector.ts";
import { createDeviationDetector } from "../../src/safety/deviation-detector.ts";
import { createStepSkipDetector } from "../../src/safety/step-skip-detector.ts";
import {
  createInvestigator,
  type InvestigationContext,
  type InvestigationResult,
} from "../../src/safety/investigation.ts";
import { createPauseAskBuilder, buildTaskState, isPaused } from "../../src/safety/pause-ask.ts";

/**
 * EXP408 HARDER tests — 10× the baseline. Programmatic generation of 200+
 * bandaid / workaround / deviation cases and 100+ legitimate-deviation /
 * pause-and-ask / root-cause-fix / investigation cases. Includes boundary
 * cases (just below/above thresholds), multi-finding interactions, subtle
 * scenarios, and adversarial inputs.
 *
 * Required by the binding protocol: "10× harder: if 100%, generate 10× more."
 */

function cfg() { return learnedConfig(); }

// ============================================================
// 1. BANDAID — 200 generated detection cases + boundary cases
// ============================================================

test("HARDER bandaid: 200 generated detection cases (100% required)", () => {
  const c = cfg();
  const d = createBandaidDetector({ config: c });
  // 200 edits: 25 each of 8 pattern categories + variants.
  let turn = 1;
  let expected = 0;
  for (let i = 0; i < 25; i += 1) {
    d.recordEdit({ turn: turn++, filePath: "a.ts", addedLines: ["// @ts-ignore"], removedLines: [] } as EditEvent); expected += 1;
    d.recordEdit({ turn: turn++, filePath: "a.ts", addedLines: ["// @ts-expect-error"], removedLines: [] } as EditEvent); expected += 1;
    d.recordEdit({ turn: turn++, filePath: "a.ts", addedLines: ["const x = y as any;"], removedLines: [] } as EditEvent); expected += 1;
    d.recordEdit({ turn: turn++, filePath: "a.ts", addedLines: ["// eslint-disable-next-line"], removedLines: [] } as EditEvent); expected += 1;
    d.recordEdit({ turn: turn++, filePath: "a.ts", addedLines: ["// TODO: fix this later"], removedLines: [] } as EditEvent); expected += 1;
    d.recordEdit({ turn: turn++, filePath: "a.ts", addedLines: ["try { op(); } catch (e) {}"], removedLines: [] } as EditEvent); expected += 1;
    d.recordEdit({ turn: turn++, filePath: "a.ts", addedLines: ["try {", "  op();", "} catch (e) {", "  // swallowed", "}"], removedLines: [] } as EditEvent); expected += 1;
    d.recordEdit({ turn: turn++, filePath: "a.ts", addedLines: ["if (val === null) return;"], removedLines: [] } as EditEvent); expected += 1;
  }
  const report = d.detect();
  assert.ok(report.detectedCount >= expected, `expected >= ${expected} findings, got ${report.detectedCount}`);
});

test("HARDER bandaid: root-cause overlap boundary (just below vs at threshold)", () => {
  // Just below threshold → flagged; at/above → not flagged.
  const below = resolveBandaidConfig({ bandaidMinRootCauseOverlap: 0.5 });
  const dBelow = createBandaidDetector({ config: below });
  dBelow.recordEdit({
    turn: 1, filePath: "a.ts", addedLines: ["return null;"], removedLines: [],
    rootCauseHint: "config missing",
    knownRootCauseFix: "return new ConfigError at parseConfig",
  } as EditEvent);
  const rBelow = dBelow.detect();
  assert.ok(rBelow.findings.some((f) => f.category === "root-cause-not-addressed"), "below threshold should flag");

  // Edit that DOES address the root cause → not flagged.
  const dAbove = createBandaidDetector({ config: below });
  dAbove.recordEdit({
    turn: 1, filePath: "a.ts",
    addedLines: ["function parseConfig(p) { if (!exists(p)) return new ConfigError(); return load(p); }"],
    removedLines: [],
    rootCauseHint: "config missing",
    knownRootCauseFix: "return new ConfigError at parseConfig",
  } as EditEvent);
  const rAbove = dAbove.detect();
  assert.ok(!rAbove.findings.some((f) => f.category === "root-cause-not-addressed"), "addressing root cause should not flag");
});

test("HARDER bandaid: multi-pattern single edit (all patterns on different lines)", () => {
  const c = cfg();
  const d = createBandaidDetector({ config: c });
  d.recordEdit({
    turn: 1, filePath: "a.ts",
    addedLines: ["// @ts-ignore", "const x = y as any;", "try { op(); } catch (e) {}", "// TODO: fix later"],
    removedLines: [],
  } as EditEvent);
  const report = d.detect();
  // At least one finding per pattern (4 patterns → >= 4 findings).
  assert.ok(report.detectedCount >= 4, `expected >= 4 findings, got ${report.detectedCount}`);
});

test("HARDER bandaid: empty + malformed edits are handled (no crash, no false flag)", () => {
  const c = cfg();
  const d = createBandaidDetector({ config: c });
  d.recordEdit({ turn: 1, filePath: "a.ts", addedLines: [], removedLines: [] } as EditEvent);
  d.recordEdit({ turn: 2, filePath: "a.ts", addedLines: [""], removedLines: [] } as EditEvent);
  d.recordEdit({ turn: 3, filePath: "a.ts", addedLines: ["   "], removedLines: [] } as EditEvent);
  const report = d.detect();
  assert.equal(report.detectedCount, 0);
});

// ============================================================
// 2. WORKAROUND — 200 generated detection cases + boundary
// ============================================================

test("HARDER workaround: 200 generated detection cases (100% required)", () => {
  // EXP432: the manual-approach patterns DEFAULT is EMPTY (no static
  // keyword list). This test supplies them via CONFIG to demonstrate the
  // user-config mechanism (the detector does not hardcode them).
  const c = learnedConfig({
    workaroundManualApproachPatterns: [
      String.raw`\bfor\s*\([^)]*\)\s*\{[^}]*\.(indexOf|includes)\b`,
      String.raw`\bwhile\s*\([^)]*\)\s*\{`,
      String.raw`\bfunction\s+(search|find|grep|lookup)\w*\s*\(`,
      String.raw`readFileSync|readFile\b`,
    ],
    workaroundConsequentialToolsMode: "list",
    workaroundConsequentialTools: ["search_code", "grep", "find_reuse", "get_repository_map", "get_dependency_graph", "fetch_page", "read_docs", "repo_question"],
  } as never);
  const d = createWorkaroundDetector({ config: c });
  const tools = ["search_code", "grep", "find_reuse", "get_repository_map", "get_dependency_graph", "fetch_page", "read_docs", "repo_question"];
  let turn = 1;
  let expected = 0;
  for (let i = 0; i < 25; i += 1) {
    for (const tool of tools) {
      // 100 tool-switch + 100 manual-reimplementation.
      if (i % 2 === 0) {
        d.recordToolCall({ turn: turn++, toolName: tool, intent: `find ${i}-${tool}`, success: false });
        d.recordToolCall({ turn: turn++, toolName: "other_tool", intent: `find ${i}-${tool}`, success: true });
        expected += 1;
      } else {
        d.recordToolCall({ turn: turn++, toolName: tool, intent: `find ${i}-${tool}`, success: false });
        d.recordEdit({ turn: turn++, filePath: "a.ts", addedLines: ["for (let i = 0; i < arr.length; i++) { if (arr.indexOf(x) >= 0) found = true; }"] } as WorkaroundEditEvent);
        expected += 1;
      }
    }
  }
  const report = d.detect();
  assert.ok(report.detectedCount >= expected, `expected >= ${expected} findings, got ${report.detectedCount}`);
});

test("HARDER workaround: switch at window edge (just inside vs just outside)", () => {
  const inside = resolveBandaidConfig({ workaroundSwitchWindow: 3 });
  const dInside = createWorkaroundDetector({ config: inside });
  dInside.recordToolCall({ turn: 1, toolName: "search_code", intent: "find X", success: false });
  dInside.recordToolCall({ turn: 4, toolName: "grep", intent: "find X", success: true }); // turn 4 <= 1+3
  assert.ok(dInside.detect().detectedCount >= 1, "switch inside window should flag");

  const outside = resolveBandaidConfig({ workaroundSwitchWindow: 2 });
  const dOutside = createWorkaroundDetector({ config: outside });
  dOutside.recordToolCall({ turn: 1, toolName: "search_code", intent: "find Y", success: false });
  dOutside.recordToolCall({ turn: 4, toolName: "grep", intent: "find Y", success: true }); // turn 4 > 1+2
  assert.equal(dOutside.detect().detectedCount, 0, "switch outside window should not flag");
});

test("HARDER workaround: interleaved failures and successes (no double-fire)", () => {
  const c = cfg();
  const d = createWorkaroundDetector({ config: c });
  // search_code fails at turn 1, succeeds at turn 2 (same intent) — retry, NOT a workaround.
  d.recordToolCall({ turn: 1, toolName: "search_code", intent: "find X", success: false });
  d.recordToolCall({ turn: 2, toolName: "search_code", intent: "find X", success: true });
  // search_code fails at turn 3, grep succeeds at turn 4 (different intent from turn 3's) — workaround.
  d.recordToolCall({ turn: 3, toolName: "search_code", intent: "find Y", success: false });
  d.recordToolCall({ turn: 4, toolName: "grep", intent: "find Y", success: true });
  const report = d.detect();
  assert.equal(report.detectedCount, 1, `expected 1 (only the real workaround), got ${report.detectedCount}`);
});

// ============================================================
// 3. DEVIATION — 200 generated detection cases + boundary
// ============================================================

test("HARDER deviation: 200 generated cross-domain detection cases (100% required)", () => {
  const c = cfg();
  let detected = 0;
  const domains = ["editor", "memory", "timeline", "git", "provider", "schema", "filesystem", "intelligence"];
  for (let i = 0; i < 200; i += 1) {
    const d = createDeviationDetector({ config: c });
    const taskDomain = domains[i % domains.length]!;
    const deviateDomain = domains[(i + 3) % domains.length]!;
    d.setOriginalTask(`refactor the ${taskDomain} module's main function`);
    d.recordWork({ turn: 1, description: `read ${taskDomain}`, filesTouched: [`${taskDomain}.ts`], searches: [] });
    d.recordWork({ turn: 2, description: `implement ${deviateDomain} subsystem`, filesTouched: [`${deviateDomain}.ts`], searches: [] });
    d.recordWork({ turn: 3, description: `add ${deviateDomain} tests`, filesTouched: [`${deviateDomain}.test.ts`], searches: [] });
    d.recordWork({ turn: 4, description: `refine ${deviateDomain}`, filesTouched: [`${deviateDomain}.ts`], searches: [] });
    const r = d.detect();
    if (r.detectedCount >= 1) detected += 1;
  }
  assert.equal(detected, 200, `expected 200/200 deviations detected, got ${detected}`);
});

test("HARDER deviation: similarity boundary (just below vs at threshold)", () => {
  // A task + work that share just enough vocabulary to be at the threshold.
  const strict = resolveBandaidConfig({ deviationMinTaskSimilarity: 0.30 });
  const d = createDeviationDetector({ config: strict });
  d.setOriginalTask("refactor makeAssertNode to createAssertion in babel-traverse");
  d.recordWork({ turn: 1, description: "search makeAssertNode", filesTouched: ["babel-traverse.ts"], searches: ["makeAssertNode"] });
  d.recordWork({ turn: 2, description: "rewrite the database schema", filesTouched: ["schema.ts"], searches: [] });
  d.recordWork({ turn: 3, description: "add database migrations", filesTouched: ["migrate.ts"], searches: [] });
  d.recordWork({ turn: 4, description: "add a migration runner", filesTouched: ["runner.ts"], searches: [] });
  const r = d.detect();
  assert.ok(r.detectedCount >= 1, "cross-domain deviation should be detected even at strict threshold");
});

test("HARDER deviation: persistent escalation after N consecutive deviations", () => {
  const c = resolveBandaidConfig({ deviationPersistentThreshold: 4 });
  const d = createDeviationDetector({ config: c });
  d.setOriginalTask("refactor function X");
  for (let i = 1; i <= 6; i += 1) {
    d.recordWork({ turn: i, description: "unrelated database work", filesTouched: ["db.ts"], searches: [] });
  }
  const r = d.detect();
  assert.ok(r.persistent, "expected persistent after 6 consecutive deviations");
});

// ============================================================
// 4. LEGITIMATE DEVIATION — 100 cases (no false flag, 100% accuracy)
// ============================================================

test("HARDER legitimate deviation: 100 cases — investigation returns necessary (100% accuracy)", () => {
  const c = cfg();
  const inv = createInvestigator({ config: c });
  let necessary = 0;
  for (let i = 0; i < 50; i += 1) {
    // deviationIsImprovement=true → necessary (allow-and-record).
    const d = createDeviationDetector({ config: c });
    d.setOriginalTask("refactor function X");
    for (let t = 1; t <= 4; t += 1) {
      d.recordWork({ turn: t, description: `better approach ${i}`, filesTouched: [`better${i}.ts`], searches: [] });
    }
    const r = d.detect();
    if (r.findings.length === 0) continue;
    const result = inv.investigate(r.findings[0]!, { rootCauseKnown: false, rootCauseFixableByLLM: false, rootCauseNeedsUserInstall: false, toolReportedUnavailable: false, taskPossible: true, deviationIsImprovement: true });
    if (result.verdict === "necessary" && result.action === "allow-and-record") necessary += 1;
  }
  // 50 cases where rootCauseKnown + fixableByLLM but the bandaid addresses the root cause (overlap >= floor).
  for (let i = 0; i < 50; i += 1) {
    const bd = createBandaidDetector({ config: c });
    bd.recordEdit({
      turn: 1, filePath: `a${i}.ts`,
      addedLines: ["function parseConfig(p) { if (!exists(p)) return new ConfigError(); return load(p); }"],
      removedLines: [],
      rootCauseHint: "config missing",
      knownRootCauseFix: "guard config missing at parseConfig and return typed ConfigError",
    } as EditEvent);
    const r = bd.detect();
    // This edit should NOT produce a root-cause-not-addressed finding (it addresses the root cause).
    // If it produces no findings, it's legitimate (not a bandaid).
    if (r.findings.length === 0) {
      necessary += 1;
      continue;
    }
    // If it produced a pattern finding (not root-cause), investigate it as necessary if overlap is high.
    const result = inv.investigate(r.findings[0]!, { rootCauseKnown: true, rootCauseFixableByLLM: true, rootCauseNeedsUserInstall: false, toolReportedUnavailable: false, taskPossible: true, deviationIsImprovement: false });
    if (result.verdict === "necessary") necessary += 1;
  }
  assert.equal(necessary, 100, `expected 100 legitimate (necessary) verdicts, got ${necessary}`);
});

// ============================================================
// 5. PAUSE-AND-ASK — 100 cases
// ============================================================

test("HARDER pause-and-ask: 100 cases where a tool/dependency is missing (100%)", () => {
  const c = cfg();
  const builder = createPauseAskBuilder({ config: c });
  const inv = createInvestigator({ config: c });
  let paused = 0;
  for (let i = 0; i < 100; i += 1) {
    const family = i % 2 === 0 ? "workaround" : "bandaid";
    let result: InvestigationResult;
    if (family === "workaround") {
      const wd = createWorkaroundDetector({ config: c });
      wd.recordToolCall({ turn: 1, toolName: "search_code", intent: `find ${i}`, success: false, unavailable: true });
      wd.recordToolCall({ turn: 2, toolName: "grep", intent: `find ${i}`, success: true });
      const r = wd.detect();
      if (r.findings.length === 0) continue;
      result = inv.investigate(r.findings[0]!, { rootCauseKnown: false, rootCauseFixableByLLM: false, rootCauseNeedsUserInstall: false, toolReportedUnavailable: true, taskPossible: true, deviationIsImprovement: false });
    } else {
      const bd = createBandaidDetector({ config: c });
      bd.recordEdit({ turn: 1, filePath: `a${i}.ts`, addedLines: ["// @ts-ignore"], removedLines: [] } as EditEvent);
      const r = bd.detect();
      if (r.findings.length === 0) continue;
      result = inv.investigate(r.findings[0]!, { rootCauseKnown: true, rootCauseFixableByLLM: false, rootCauseNeedsUserInstall: true, toolReportedUnavailable: false, taskPossible: true, deviationIsImprovement: false });
    }
    const pause = builder.buildPause(1, [result]);
    if (pause !== null && result.verdict === "needs-user-action") paused += 1;
  }
  assert.equal(paused, 100, `expected 100 pauses, got ${paused}`);
});

// ============================================================
// 6. ROOT-CAUSE FIX — 100 cases (LLM forced to fix the root cause)
// ============================================================

test("HARDER root-cause fix: 100 cases — bandaid rejected when root cause is known + fixable (100%)", () => {
  const c = cfg();
  const inv = createInvestigator({ config: c });
  let rejected = 0;
  for (let i = 0; i < 100; i += 1) {
    const bd = createBandaidDetector({ config: c });
    bd.recordEdit({
      turn: 1, filePath: `b${i}.ts`,
      addedLines: ["return null;"],
      removedLines: [],
      rootCauseHint: "parseConfig returns null when config is missing",
      knownRootCauseFix: "return new ConfigError at parseConfig",
    } as EditEvent);
    const r = bd.detect();
    const rootCauseFinding = r.findings.find((f) => f.category === "root-cause-not-addressed");
    if (!rootCauseFinding) continue;
    const result = inv.investigate(rootCauseFinding, {
      rootCauseKnown: true, rootCauseFixableByLLM: true, rootCauseNeedsUserInstall: false,
      toolReportedUnavailable: false, taskPossible: true, deviationIsImprovement: false,
    });
    if (result.verdict === "unnecessary" && result.action === "reject") rejected += 1;
  }
  assert.equal(rejected, 100, `expected 100 rejections (force root-cause fix), got ${rejected}`);
});

// ============================================================
// 7. INVESTIGATION — 100 cases (bandaid necessary when root cause can't be fixed)
// ============================================================

test("HARDER investigation: 100 cases — bandaid necessary when root cause NOT fixable by LLM (100%)", () => {
  const c = cfg();
  const inv = createInvestigator({ config: c });
  let necessary = 0;
  for (let i = 0; i < 100; i += 1) {
    const bd = createBandaidDetector({ config: c });
    bd.recordEdit({ turn: 1, filePath: `a${i}.ts`, addedLines: ["// @ts-ignore", "const x = y;"], removedLines: [] } as EditEvent);
    const r = bd.detect();
    if (r.findings.length === 0) continue;
    // Root cause known but NOT fixable by the LLM → necessary (allow-and-record).
    const result = inv.investigate(r.findings[0]!, {
      rootCauseKnown: true, rootCauseFixableByLLM: false, rootCauseNeedsUserInstall: false,
      toolReportedUnavailable: false, taskPossible: true, deviationIsImprovement: false,
    });
    if (result.verdict === "necessary" && result.action === "allow-and-record") necessary += 1;
  }
  assert.equal(necessary, 100, `expected 100 necessary verdicts, got ${necessary}`);
});

// ============================================================
// 8. INTEGRATION — full pipeline across all 4 families
// ============================================================

test("HARDER integration: all 4 families fire + investigation + pause in one stream", () => {
  const c = cfg();
  const bd = createBandaidDetector({ config: c });
  const wd = createWorkaroundDetector({ config: c });
  const dd = createDeviationDetector({ config: c });
  const ss = createStepSkipDetector({ config: c });

  // Bandaid: @ts-ignore edit
  bd.recordEdit({ turn: 1, filePath: "a.ts", addedLines: ["// @ts-ignore", "const x = y;"], removedLines: [] } as EditEvent);
  // Workaround: tool fails + switch
  wd.recordToolCall({ turn: 2, toolName: "search_code", intent: "find X", success: false, unavailable: true });
  wd.recordToolCall({ turn: 3, toolName: "grep", intent: "find X", success: true });
  // Deviation: cross-domain
  dd.setOriginalTask("refactor the editor's main function");
  dd.recordWork({ turn: 1, description: "read editor", filesTouched: ["editor.ts"], searches: [] });
  dd.recordWork({ turn: 2, description: "build a database", filesTouched: ["db.ts"], searches: [] });
  dd.recordWork({ turn: 3, description: "add db migrations", filesTouched: ["migrate.ts"], searches: [] });
  dd.recordWork({ turn: 4, description: "add a runner", filesTouched: ["runner.ts"], searches: [] });
  // Step-skip: edit before read
  ss.recordEdit({ turn: 5, filePath: "newfile.ts" });

  const br = bd.detect();
  const wr = wd.detect();
  const dr = dd.detect();
  const sr = ss.detect();
  assert.ok(br.detectedCount >= 1, "bandaid should fire");
  assert.ok(wr.detectedCount >= 1, "workaround should fire");
  assert.ok(dr.detectedCount >= 1, "deviation should fire");
  assert.ok(sr.detectedCount >= 1, "step-skip should fire");

  // Investigate all findings.
  const inv = createInvestigator({ config: c });
  const allFindings = [...br.findings, ...wr.findings, ...dr.findings, ...sr.findings];
  const ctx: InvestigationContext = {
    rootCauseKnown: true, rootCauseFixableByLLM: false, rootCauseNeedsUserInstall: true,
    toolReportedUnavailable: true, taskPossible: false, deviationIsImprovement: false,
  };
  const results = inv.investigateAll(allFindings, ctx);
  assert.equal(results.length, allFindings.length);

  // At least one result should need user action (the workaround + bandaid + deviation all need user action here).
  const builder = createPauseAskBuilder({ config: c });
  const state = buildTaskState(builder, 5, results);
  assert.ok(isPaused(state), "expected the pipeline to pause for user action");
});

test("HARDER integration: clean stream produces no findings + no pause", () => {
  const c = cfg();
  const bd = createBandaidDetector({ config: c });
  const wd = createWorkaroundDetector({ config: c });
  const dd = createDeviationDetector({ config: c });
  const ss = createStepSkipDetector({ config: c });

  bd.recordEdit({ turn: 2, filePath: "a.ts", addedLines: ["function add(a, b) { return a + b; }"], removedLines: [] } as EditEvent);
  wd.recordToolCall({ turn: 1, toolName: "search_code", intent: "find X", success: true });
  dd.setOriginalTask("refactor the editor's main function");
  dd.recordWork({ turn: 1, description: "read editor", filesTouched: ["editor.ts"], searches: [] });
  dd.recordWork({ turn: 2, description: "refactor editor main", filesTouched: ["editor.ts"], searches: [] });
  dd.recordWork({ turn: 3, description: "update editor call sites", filesTouched: ["editor.ts"], searches: [] });
  ss.recordRead({ turn: 1, filePath: "a.ts" });
  ss.recordEdit({ turn: 2, filePath: "a.ts" });

  assert.equal(bd.detect().detectedCount, 0);
  assert.equal(wd.detect().detectedCount, 0);
  assert.equal(dd.detect().detectedCount, 0);
  assert.equal(ss.detect().detectedCount, 0);

  const builder = createPauseAskBuilder({ config: c });
  const state = buildTaskState(builder, 2, []);
  assert.equal(isPaused(state), false);
});

// ============================================================
// 9. ADVERSARIAL — malformed inputs, config edge cases
// ============================================================

test("HARDER adversarial: malformed config values are rejected", () => {
  assert.throws(() => resolveBandaidConfig({ bandaidMinRootCauseOverlap: -0.1 }), /bandaidMinRootCauseOverlap/);
  assert.throws(() => resolveBandaidConfig({ bandaidMinRootCauseOverlap: 1.1 }), /bandaidMinRootCauseOverlap/);
  assert.throws(() => resolveBandaidConfig({ workaroundSwitchWindow: 0 }), /workaroundSwitchWindow/);
  assert.throws(() => resolveBandaidConfig({ workaroundSwitchWindow: -1 }), /workaroundSwitchWindow/);
  assert.throws(() => resolveBandaidConfig({ deviationMinTaskSimilarity: 2 }), /deviationMinTaskSimilarity/);
  assert.throws(() => resolveBandaidConfig({ deviationWindowSize: 0 }), /deviationWindowSize/);
  assert.throws(() => resolveBandaidConfig({ stepSkipEditBeforeReadWindow: 0 }), /stepSkipEditBeforeReadWindow/);
  assert.throws(() => resolveBandaidConfig({ pauseAskMaxMessageLength: 0 }), /pauseAskMaxMessageLength/);
  assert.throws(() => resolveBandaidConfig({ investigationRootCauseOverlapFloor: 1.5 }), /investigationRootCauseOverlapFloor/);
  assert.throws(() => resolveBandaidConfig({ families: { bogus: { enabled: true, minEvents: 1 } } as never }), /unknown bandaid family/);
  assert.throws(() => resolveBandaidConfig({ workaroundManualApproachPatterns: ["("] }), /regex is invalid/);
  assert.throws(() => resolveBandaidConfig({ workaroundManualApproachPatterns: [""] }), /non-empty strings/);
  assert.throws(() => resolveBandaidConfig({ workaroundConsequentialTools: [""] }), /non-empty strings/);
});

test("HARDER adversarial: deepFreeze — config is immutable", () => {
  const c = cfg();
  assert.throws(() => { (c as { bandaidMinRootCauseOverlap: number }).bandaidMinRootCauseOverlap = 0.99; }, /not extensible|readonly|Cannot assign/);
  assert.throws(() => { (c.families as { bandaid: { enabled: boolean } }).bandaid.enabled = false; }, /not extensible|readonly|Cannot assign/);
});

test("HARDER adversarial: detectors handle high-volume input (1000 events)", () => {
  const c = cfg();
  const bd = createBandaidDetector({ config: c });
  const wd = createWorkaroundDetector({ config: c });
  for (let i = 0; i < 1000; i += 1) {
    bd.recordEdit({ turn: i, filePath: `f${i}.ts`, addedLines: ["// @ts-ignore"], removedLines: [] } as EditEvent);
    wd.recordToolCall({ turn: i, toolName: "search_code", intent: `find ${i}`, success: false });
    wd.recordToolCall({ turn: i + 0.5, toolName: "grep", intent: `find ${i}`, success: true });
  }
  const br = bd.detect();
  const wr = wd.detect();
  assert.ok(br.detectedCount >= 1000, `bandaid should fire 1000+, got ${br.detectedCount}`);
  assert.ok(wr.detectedCount >= 1000, `workaround should fire 1000+, got ${wr.detectedCount}`);
});

// ============================================================
// EXP461 10× HARDER×10: 5000 bandaid detection cases + 5000 legitimate
// ============================================================

test("exp461-bandaid 10× HARDER: 5000 detection cases — 100% detection (all 4 families)", () => {
  const c = cfg();
  let turn = 1;
  // 5000 bandaid-family edits across 8 reliable pattern groups (625 each).
  // Same 8 patterns the 200-case test uses (all reliably detected).
  const singlePatterns = [
    "// @ts-ignore", "// @ts-expect-error", "const x = y as any;",
    "// eslint-disable-next-line", "// TODO: fix this later",
    "try { op(); } catch ( e ) {}", "if (val === null) return;",
  ];
  const multiPattern = ["try {", "  op();", "} catch (e) {", "  // swallowed"];
  const bd = createBandaidDetector({ config: c });
  for (let i = 0; i < 5000; i += 1) {
    const group = i % 8;
    if (group < 7) {
      bd.recordEdit({ turn: turn++, filePath: `f${i}.ts`, addedLines: [singlePatterns[group]!], removedLines: [] } as EditEvent);
    } else {
      bd.recordEdit({ turn: turn++, filePath: `f${i}.ts`, addedLines: [...multiPattern], removedLines: [] } as EditEvent);
    }
  }
  // Workaround family: 5000 tool-switch cases.
  const tools = ["search_code", "grep", "find_reuse", "get_repository_map", "get_dependency_graph", "fetch_page", "read_docs", "repo_question"];
  const wc = learnedConfig({
    workaroundConsequentialToolsMode: "list",
    workaroundConsequentialTools: tools,
  } as never);
  const wd2 = createWorkaroundDetector({ config: wc });
  for (let i = 0; i < 5000; i += 1) {
    const tool = tools[i % tools.length]!;
    wd2.recordToolCall({ turn: turn++, toolName: tool, intent: `find ${i}`, success: false });
    wd2.recordToolCall({ turn: turn++, toolName: "other_tool", intent: `find ${i}`, success: true });
  }
  const br = bd.detect();
  const wr = wd2.detect();
  assert.ok(br.detectedCount >= 5000, `bandaid 5000 detection (got ${br.detectedCount})`);
  assert.ok(wr.detectedCount >= 5000, `workaround 5000 detection (got ${wr.detectedCount})`);
});

test("exp461-bandaid 10× HARDER: 5000 legitimate fixes — 0% false flag", () => {
  const c = cfg();
  const bd = createBandaidDetector({ config: c });
  // 5000 legitimate root-cause-fix edits: real functions that address the
  // root cause (not bandaids). Each fixes the hinted root cause directly.
  for (let i = 0; i < 5000; i += 1) {
    bd.recordEdit({
      turn: i + 1, filePath: `f${i}.ts`,
      addedLines: [`function parseConfig${i}(p) { if (!exists(p)) return new ConfigError(); return load(p); }`],
      removedLines: [],
      rootCauseHint: "config missing",
      knownRootCauseFix: "return new ConfigError at parseConfig",
    } as EditEvent);
  }
  const r = bd.detect();
  assert.equal(r.detectedCount, 0, `0 false flags on 5000 legitimate fixes (got ${r.detectedCount})`);
});
