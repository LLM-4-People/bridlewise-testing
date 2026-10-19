import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBandaidConfig } from "../../src/safety/bandaid-config.ts";
import {
  createPauseAskBuilder,
  buildTaskState,
  isPaused,
} from "../../src/safety/pause-ask.ts";
import {
  createInvestigator,
  type InvestigationResult,
  type InvestigationContext,
} from "../../src/safety/investigation.ts";

function cfg() { return resolveBandaidConfig(); }

function mkResult(verdict: InvestigationResult["verdict"], pauseMessage: string, family: "workaround" | "bandaid" | "deviation" | "stepSkip" = "workaround"): InvestigationResult {
  let finding: InvestigationResult["finding"];
  if (family === "workaround") {
    finding = { family: "workaround", turn: 1, severity: "medium", failedTool: "search_code", intent: "x", switchKind: "tool-switch", switchTurn: 2, switchedTo: "grep", evidence: "", recommendation: "" };
  } else if (family === "bandaid") {
    finding = { family: "bandaid", turn: 1, filePath: "a.ts", severity: "low", patternLabel: "x", category: "type-suppression", evidenceLine: "", rootCauseOverlap: 1, recommendation: "" };
  } else if (family === "deviation") {
    finding = { family: "deviation", turn: 1, severity: "medium", similarity: 0.1, persistent: false, evidence: "", recommendation: "" };
  } else {
    finding = { family: "stepSkip", turn: 1, severity: "medium", kind: "edit-before-read", filePath: "a.ts", missingStep: "read", evidence: "", recommendation: "" };
  }
  const action: InvestigationResult["action"] = verdict === "needs-user-action" ? "pause-and-ask" : verdict === "unnecessary" ? "reject" : "allow-and-record";
  return { verdict, action, finding, reason: "", pauseMessage };
}

test("pauseAsk: 10 cases — pause built when needs-user-action (100%)", () => {
  const c = cfg();
  const builder = createPauseAskBuilder({ config: c });
  let built = 0;
  for (let i = 0; i < 10; i += 1) {
    const results: InvestigationResult[] = [
      mkResult("needs-user-action", `Please install tool ${i} before I continue.`, "workaround"),
    ];
    const pause = builder.buildPause(1, results);
    if (pause !== null) built += 1;
    assert.ok(pause !== null, `case ${i}: expected a pause`);
    assert.ok(pause.message.includes(`install tool ${i}`), `case ${i}: message should include the action`);
  }
  assert.equal(built, 10);
});

test("pauseAsk: no pause when no needs-user-action", () => {
  const c = cfg();
  const builder = createPauseAskBuilder({ config: c });
  const results: InvestigationResult[] = [
    mkResult("unnecessary", "", "bandaid"),
    mkResult("necessary", "", "bandaid"),
  ];
  const pause = builder.buildPause(1, results);
  assert.equal(pause, null);
});

test("pauseAsk: dedupes duplicate messages", () => {
  const c = cfg();
  const builder = createPauseAskBuilder({ config: c });
  const results: InvestigationResult[] = [
    mkResult("needs-user-action", "Please install tool X.", "workaround"),
    mkResult("needs-user-action", "Please install tool X.", "workaround"),
    mkResult("needs-user-action", "Please install tool Y.", "workaround"),
  ];
  const pause = builder.buildPause(1, results);
  assert.ok(pause !== null);
  // 2 unique messages (X appears twice, deduped).
  const xCount = (pause.message.match(/install tool X/g) || []).length;
  const yCount = (pause.message.match(/install tool Y/g) || []).length;
  assert.equal(xCount, 1, "duplicate message should appear once");
  assert.equal(yCount, 1);
});

test("pauseAsk: requestedActions deduped by family", () => {
  const c = cfg();
  const builder = createPauseAskBuilder({ config: c });
  const results: InvestigationResult[] = [
    mkResult("needs-user-action", "msg1", "workaround"),
    mkResult("needs-user-action", "msg2", "workaround"),
    mkResult("needs-user-action", "msg3", "bandaid"),
  ];
  const pause = builder.buildPause(1, results);
  assert.ok(pause !== null);
  assert.deepEqual(pause.requestedActions, ["workaround", "bandaid"]);
});

test("pauseAsk: disabled → no pause", () => {
  const c = resolveBandaidConfig({ pauseAskEnabled: false });
  const builder = createPauseAskBuilder({ config: c });
  const results: InvestigationResult[] = [mkResult("needs-user-action", "install X", "workaround")];
  const pause = builder.buildPause(1, results);
  assert.equal(pause, null);
});

test("pauseAsk: message truncated to max length", () => {
  const c = resolveBandaidConfig({ pauseAskMaxMessageLength: 50 });
  const builder = createPauseAskBuilder({ config: c });
  const results: InvestigationResult[] = [
    mkResult("needs-user-action", "A very long user action message that exceeds the configured max length.", "workaround"),
  ];
  const pause = builder.buildPause(1, results);
  assert.ok(pause !== null);
  assert.ok(pause.message.length <= 50, `message length ${pause.message.length} should be <= 50`);
  assert.ok(pause.message.endsWith("..."));
});

test("pauseAsk: buildTaskState running when no pause", () => {
  const c = cfg();
  const builder = createPauseAskBuilder({ config: c });
  const results: InvestigationResult[] = [mkResult("necessary", "", "bandaid")];
  const state = buildTaskState(builder, 1, results);
  assert.equal(isPaused(state), false);
});

test("pauseAsk: buildTaskState paused when needs-user-action", () => {
  const c = cfg();
  const builder = createPauseAskBuilder({ config: c });
  const results: InvestigationResult[] = [mkResult("needs-user-action", "install X", "workaround")];
  const state = buildTaskState(builder, 1, results);
  assert.equal(isPaused(state), true);
  if (isPaused(state)) {
    assert.ok(state.pause.message.includes("install X"));
  }
});

test("pauseAsk: multiple needs-user-action — all messages included", () => {
  const c = cfg();
  const builder = createPauseAskBuilder({ config: c });
  const results: InvestigationResult[] = [
    mkResult("needs-user-action", "install tool A", "workaround"),
    mkResult("needs-user-action", "configure tool B", "workaround"),
    mkResult("needs-user-action", "confirm task C is possible", "deviation"),
  ];
  const pause = builder.buildPause(1, results);
  assert.ok(pause !== null);
  assert.ok(pause.message.includes("tool A"));
  assert.ok(pause.message.includes("tool B"));
  assert.ok(pause.message.includes("task C"));
  assert.equal(pause.triggeringResults.length, 3);
});

test("pauseAsk: integration with investigator", () => {
  const c = cfg();
  const builder = createPauseAskBuilder({ config: c });
  const inv = createInvestigator({ config: c });
  // Simulate a workaround finding where the tool was reported unavailable.
  const finding = {
    family: "workaround" as const,
    turn: 1,
    severity: "medium" as const,
    failedTool: "search_code",
    intent: "find X",
    switchKind: "tool-switch" as const,
    switchTurn: 2,
    switchedTo: "grep",
    evidence: "",
    recommendation: "",
  };
  const context: InvestigationContext = {
    rootCauseKnown: false,
    rootCauseFixableByLLM: false,
    rootCauseNeedsUserInstall: false,
    toolReportedUnavailable: true,
    taskPossible: true,
    deviationIsImprovement: false,
  };
  const result = inv.investigate(finding, context);
  const pause = builder.buildPause(1, [result]);
  assert.ok(pause !== null);
  assert.ok(pause.message.includes("search_code"));
});

test("pauseAsk: a typed unavailability reason flows through the builder into the final user-facing text", () => {
  // The consolidated pause is the surface the user reads: the transient
  // restart must arrive AS transient guidance there, not as the generic
  // "install or configure" demand.
  const c = cfg();
  const builder = createPauseAskBuilder({ config: c });
  const inv = createInvestigator({ config: c });
  const finding = {
    family: "workaround" as const,
    turn: 1,
    severity: "medium" as const,
    failedTool: "mcp__docs__search",
    intent: "find the docs",
    switchKind: "tool-switch" as const,
    switchTurn: 2,
    switchedTo: "grep",
    evidence: "",
    recommendation: "",
  };
  const result = inv.investigate(finding, {
    rootCauseKnown: false,
    rootCauseFixableByLLM: false,
    rootCauseNeedsUserInstall: false,
    toolReportedUnavailable: true,
    toolUnavailableReason: "start-superseded",
    taskPossible: true,
    deviationIsImprovement: false,
  });
  const pause = builder.buildPause(1, [result]);
  assert.ok(pause !== null);
  assert.match(pause.message, /transient/);
  assert.match(pause.message, /mcp__docs__search/);
  assert.doesNotMatch(pause.message, /install|configur/i);
});
