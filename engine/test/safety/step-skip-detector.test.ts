import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBandaidConfig } from "../../src/safety/bandaid-config.ts";
import {
  createStepSkipDetector,
  type ReadEvent,
  type StepEditEvent,
  type StepEvent,
  type TaskCompleteEvent,
} from "../../src/safety/step-skip-detector.ts";

/**
 * EXP408/EXP432 step-skip detection. EXP432: the `stepSkipExpectations`
 * map DEFAULT is EMPTY (no static mapping — it's a learnable config
 * value). This test supplies the expectations via CONFIG to demonstrate
 * the mechanism.
 */
function cfg() {
  return resolveBandaidConfig({
    stepSkipExpectations: {
      "rename": ["read", "find-call-sites", "edit"],
      "refactor": ["read", "search", "edit"],
      "fix-bug": ["read", "search", "edit", "check-issues"],
      "add-feature": ["search", "read", "edit", "check-issues"],
    },
  });
}

function rd(turn: number, filePath: string): ReadEvent { return { turn, filePath }; }
function ed(turn: number, filePath: string): StepEditEvent { return { turn, filePath }; }
function st(turn: number, step: string): StepEvent { return { turn, step }; }
function done(turn: number, taskType: string): TaskCompleteEvent { return { turn, taskType }; }

test("stepSkip: edit-before-read — 10 cases flagged", () => {
  const c = cfg();
  const d = createStepSkipDetector({ config: c });
  // 10 edits without a preceding read of the same file.
  d.recordEdit(ed(1, "a.ts"));
  d.recordEdit(ed(2, "b.ts"));
  d.recordEdit(ed(3, "c.ts"));
  d.recordEdit(ed(4, "d.ts"));
  d.recordEdit(ed(5, "e.ts"));
  d.recordEdit(ed(6, "f.ts"));
  d.recordEdit(ed(7, "g.ts"));
  d.recordEdit(ed(8, "h.ts"));
  d.recordEdit(ed(9, "i.ts"));
  d.recordEdit(ed(10, "j.ts"));
  const report = d.detect();
  const editBeforeRead = report.findings.filter((f) => f.kind === "edit-before-read");
  assert.equal(editBeforeRead.length, 10, `expected 10 edit-before-read, got ${editBeforeRead.length}`);
});

test("stepSkip: edit-after-read — not flagged", () => {
  const c = cfg();
  const d = createStepSkipDetector({ config: c });
  d.recordRead(rd(1, "a.ts"));
  d.recordEdit(ed(2, "a.ts"));
  const report = d.detect();
  assert.equal(report.detectedCount, 0);
});

test("stepSkip: expected-step-missing — rename without find-call-sites", () => {
  const c = cfg();
  const d = createStepSkipDetector({ config: c });
  d.recordRead(rd(1, "a.ts"));
  d.recordStep(st(1, "read"));
  d.recordStep(st(2, "edit"));
  d.recordEdit(ed(2, "a.ts"));
  d.completeTask(done(3, "rename")); // missing find-call-sites
  const report = d.detect();
  const missing = report.findings.filter((f) => f.kind === "expected-step-missing");
  assert.ok(missing.some((f) => f.missingStep === "find-call-sites"), "expected missing find-call-sites");
});

test("stepSkip: expected-step-complete — all steps present", () => {
  const c = cfg();
  const d = createStepSkipDetector({ config: c });
  d.recordStep(st(1, "read"));
  d.recordStep(st(2, "find-call-sites"));
  d.recordStep(st(3, "edit"));
  d.completeTask(done(4, "rename"));
  const report = d.detect();
  const missing = report.findings.filter((f) => f.kind === "expected-step-missing");
  assert.equal(missing.length, 0);
});

test("stepSkip: fix-bug missing check-issues", () => {
  const c = cfg();
  const d = createStepSkipDetector({ config: c });
  d.recordStep(st(1, "read"));
  d.recordStep(st(2, "search"));
  d.recordStep(st(3, "edit"));
  d.completeTask(done(4, "fix-bug")); // missing check-issues
  const report = d.detect();
  assert.ok(report.findings.some((f) => f.missingStep === "check-issues"));
});

test("stepSkip: add-feature missing check-issues", () => {
  const c = cfg();
  const d = createStepSkipDetector({ config: c });
  d.recordStep(st(1, "search"));
  d.recordStep(st(2, "read"));
  d.recordStep(st(3, "edit"));
  d.completeTask(done(4, "add-feature")); // missing check-issues
  const report = d.detect();
  assert.ok(report.findings.some((f) => f.missingStep === "check-issues"));
});

test("stepSkip: unknown task type — no expected-step check", () => {
  const c = cfg();
  const d = createStepSkipDetector({ config: c });
  d.recordStep(st(1, "read"));
  d.completeTask(done(2, "unknown-type"));
  const report = d.detect();
  const missing = report.findings.filter((f) => f.kind === "expected-step-missing");
  assert.equal(missing.length, 0);
});

test("stepSkip: disabled family produces no findings", () => {
  const c = resolveBandaidConfig({ families: { stepSkip: { enabled: false, minEvents: 1 } } });
  const d = createStepSkipDetector({ config: c });
  d.recordEdit(ed(1, "a.ts"));
  const report = d.detect();
  assert.equal(report.detectedCount, 0);
});

test("stepSkip: read outside the window does not clear edit-before-read", () => {
  const c = resolveBandaidConfig({ stepSkipEditBeforeReadWindow: 3 });
  const d = createStepSkipDetector({ config: c });
  d.recordRead(rd(1, "a.ts"));
  d.recordEdit(ed(10, "a.ts")); // turn 10, window starts at 7; read at turn 1 is outside
  const report = d.detect();
  assert.ok(report.findings.some((f) => f.kind === "edit-before-read" && f.filePath === "a.ts"));
});
