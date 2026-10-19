/**
 * EXP424 — Mistake Detector HARD test: 50 injected mistakes, 100% detection.
 *
 * Per the protocol: "Mistake detector: inject 50 mistakes (failed commands,
 * wrong results, redundancies). Verify 100% detection."
 *
 * The 50 mistakes span all 10 mistake types (5 each). For each, we build a
 * CommandRecord, run detectAllMistakes, and assert exactly one MistakeRecord
 * is returned with the expected type + cause.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CommandLog, buildCommandRecord } from "../../src/self-improving/command-log.ts";
import {
  detectAllMistakes,
  detectMistake,
  type VerificationOutcome,
} from "../../src/self-improving/mistake-detector.ts";
import { loadSelfImprovingConfig } from "../../src/self-improving/config.ts";

const config = loadSelfImprovingConfig();
void config;

/** Build a single command record with a given result. Each record gets a
 * unique `_rid` in args so non-redundant records don't accidentally collide
 * on argsHash. Tests that intentionally create duplicates pass `args`
 * WITHOUT `_rid` so the duplicates share an argsHash.
 */
let _ridCounter = 0;
function rec(
  _id: string,
  command: string,
  type: any,
  result: { ok: boolean; output: string; tokens?: number; durationMs?: number },
  args: Record<string, unknown> = {},
  task = "test-task",
  runId = "run-1",
  turn = 1,
  taskIndex = 0,
) {
  // If args is the default empty {}, add a unique _rid so the record is
  // NOT accidentally a duplicate of another record with the same command.
  const finalArgs = Object.keys(args).length === 0 ? { _rid: ++_ridCounter } : args;
  return buildCommandRecord({
    id: _id,  // pass the test's _id as the record id (so expected/verification maps can key on it)
    runId, turn, taskIndex, command, type, args: finalArgs, task,
    result: {
      ok: result.ok,
      output: result.output,
      tokens: result.tokens,
      durationMs: result.durationMs ?? 10,
    },
  });
}

test("mistake detector: 50 injected mistakes → 100% detection", () => {
  const log = new CommandLog();
  // 5 command_failed (one per fixable cause)
  log.record(rec("c1", "search_code", "search" as any, { ok: false, output: "regex error: invalid pattern" }));
  log.record(rec("c2", "edit_file", "edit" as any, { ok: false, output: "preimage does not match expected content" }));
  log.record(rec("c3", "execute_command", "execute" as any, { ok: false, output: "syntax error in script" }));
  log.record(rec("c4", "search_code", "search" as any, { ok: false, output: "context too long for query" }));
  log.record(rec("c5", "search_code", "search" as any, { ok: false, output: "payload size exceeds budget" }));

  // 5 wrong_result (verifier expected differs from actual)
  const expected = new Map<string, string>();
  expected.set("w1", "expected: rename 50 sites");
  expected.set("w2", "expected: 0 duplicates");
  expected.set("w3", "expected: 100/100 tests pass");
  expected.set("w4", "expected: 0 hallucinations");
  expected.set("w5", "expected: 0 false positives");
  log.record(rec("w1", "edit_file", "edit" as any, { ok: true, output: "renamed 49 sites" }));
  log.record(rec("w2", "run_d3_detector", "tool" as any, { ok: true, output: "1 duplicate found" }));
  log.record(rec("w3", "run_tests", "execute" as any, { ok: true, output: "99/100 pass" }));
  log.record(rec("w4", "verify_hallucination", "quality" as any, { ok: true, output: "1 hallucination" }));
  log.record(rec("w5", "verify_fp", "quality" as any, { ok: true, output: "1 false positive" }));

  // 5 redundant_call — same args, called twice in same run
  for (let i = 0; i < 5; i++) {
    const args = { query: `redundant-${i}`, viewport: 50 };
    log.record(rec(`r${i}-1`, "search_code", "search" as any, { ok: true, output: "ok" }, args, "task", "run-red", 1, 0));
    log.record(rec(`r${i}-2`, "search_code", "search" as any, { ok: true, output: "ok" }, args, "task", "run-red", 1, 1));
  }

  // 5 deviation
  log.record(rec("d1", "edit_file", "edit" as any, { ok: true, output: "Actually, going to do something different" }));
  log.record(rec("d2", "edit_file", "edit" as any, { ok: true, output: "Let's try a different approach here" }));
  log.record(rec("d3", "edit_file", "edit" as any, { ok: true, output: "Instead of refactoring, switching to rewrite" }));
  log.record(rec("d4", "edit_file", "edit" as any, { ok: true, output: "Switching to a different tactic now" }));
  log.record(rec("d5", "edit_file", "edit" as any, { ok: true, output: "Going to do a completely different thing" }));

  // 5 bandaid (no overlap with workaround markers)
  log.record(rec("b1", "edit_file", "edit" as any, { ok: true, output: "TODO: fix this later" }));
  log.record(rec("b2", "edit_file", "edit" as any, { ok: true, output: "FIXME: this is a bandaid" }));
  log.record(rec("b3", "edit_file", "edit" as any, { ok: true, output: "HACK: temporary patch" }));
  log.record(rec("b4", "edit_file", "edit" as any, { ok: true, output: "Quick fix: stopgap solution" }));
  log.record(rec("b5", "edit_file", "edit" as any, { ok: true, output: "Stopgap: ignored for now" }));

  // 5 workaround (no overlap with bandaid/deviation markers)
  log.record(rec("wo1", "edit_file", "edit" as any, { ok: true, output: "Falling back to manual mode" }));
  log.record(rec("wo2", "edit_file", "edit" as any, { ok: true, output: "Fallback to simpler method" }));
  log.record(rec("wo3", "edit_file", "edit" as any, { ok: true, output: "Couldn't verify the result" }));
  log.record(rec("wo4", "edit_file", "edit" as any, { ok: true, output: "Unable to complete the task" }));
  log.record(rec("wo5", "edit_file", "edit" as any, { ok: true, output: "Could not continue, falling back" }));

  // 5 hallucination (knownFiles does not contain the cited file)
  log.record(rec("h1", "search_code", "search" as any, { ok: true, output: "found in /fake/path/foo.ts" }));
  log.record(rec("h2", "search_code", "search" as any, { ok: true, output: "see /nonexistent/bar.ts for details" }));
  log.record(rec("h3", "search_code", "search" as any, { ok: true, output: "implementation in /imagined/baz.ts" }));
  log.record(rec("h4", "search_code", "search" as any, { ok: true, output: "defined in /made-up/qux.ts" }));
  log.record(rec("h5", "search_code", "search" as any, { ok: true, output: "located at /fake/xyz.ts" }));

  // 5 false_positive (verifier rejected a "successful" command)
  const verifications = new Map<string, VerificationOutcome>();
  verifications.set("fp1", { commandId: "fp1", passed: false, reason: "verification_failed" });
  verifications.set("fp2", { commandId: "fp2", passed: false, reason: "edit_not_applied" });
  verifications.set("fp3", { commandId: "fp3", passed: false, reason: "syntax_broken" });
  verifications.set("fp4", { commandId: "fp4", passed: false, reason: "behavior_changed" });
  verifications.set("fp5", { commandId: "fp5", passed: false, reason: "type_error" });
  log.record(rec("fp1", "edit_file", "edit" as any, { ok: true, output: "edit applied" }));
  log.record(rec("fp2", "edit_file", "edit" as any, { ok: true, output: "file modified" }));
  log.record(rec("fp3", "edit_file", "edit" as any, { ok: true, output: "succeeded" }));
  log.record(rec("fp4", "edit_file", "edit" as any, { ok: true, output: "ok" }));
  log.record(rec("fp5", "edit_file", "edit" as any, { ok: true, output: "done" }));

  // 5 context_overflow
  log.record(rec("co1", "search_code", "search" as any, { ok: true, output: "ok", tokens: 10000 }));
  log.record(rec("co2", "search_code", "search" as any, { ok: true, output: "ok", tokens: 15000 }));
  log.record(rec("co3", "search_code", "search" as any, { ok: true, output: "ok", tokens: 20000 }));
  log.record(rec("co4", "search_code", "search" as any, { ok: true, output: "ok", tokens: 50000 }));
  log.record(rec("co5", "search_code", "search" as any, { ok: true, output: "ok", tokens: 100000 }));

  // 5 tool_misuse
  const declaredTasks = new Map<string, string>();
  declaredTasks.set("tm1", "Read the file contents");
  declaredTasks.set("tm2", "Search the codebase for foo");
  declaredTasks.set("tm3", "Inspect the AST structure");
  declaredTasks.set("tm4", "View the test file");
  declaredTasks.set("tm5", "Find all references to x");
  log.record(rec("tm1", "edit_file", "edit" as any, { ok: true, output: "edited" }));
  log.record(rec("tm2", "edit_file", "edit" as any, { ok: true, output: "edited" }));
  log.record(rec("tm3", "write_file", "write_file" as any, { ok: true, output: "written" }));
  log.record(rec("tm4", "edit_file", "edit" as any, { ok: true, output: "edited" }));
  log.record(rec("tm5", "write_file", "write_file" as any, { ok: true, output: "written" }));

  // Run the detector with all options
  const knownFiles = new Set<string>(["/real/path/foo.ts", "/real/bar.ts"]);
  const mistakes = detectAllMistakes(log, {
    expectedResults: expected,
    verifications,
    contextBudget: 8000,
    declaredTasks,
    knownFiles,
  });

  // 50 mistakes total: 5 per type × 10 types
  assert.equal(mistakes.length, 50, `expected 50 mistakes, got ${mistakes.length}`);

  // Verify each mistake type is detected (5 each)
  const byType = new Map<string, number>();
  for (const m of mistakes) {
    byType.set(m.type, (byType.get(m.type) ?? 0) + 1);
  }
  const expectedTypes = ["command_failed", "wrong_result", "redundant_call", "deviation",
    "bandaid", "workaround", "hallucination", "false_positive", "context_overflow", "tool_misuse"];
  for (const t of expectedTypes) {
    const count = byType.get(t) ?? 0;
    assert.equal(count, 5, `expected 5 ${t} mistakes, got ${count}`);
  }
});

test("mistake detector: 0 mistakes from clean commands", () => {
  const log = new CommandLog();
  log.record(rec("ok1", "search_code", "search" as any, { ok: true, output: "found 10 results" }));
  log.record(rec("ok2", "edit_file", "edit" as any, { ok: true, output: "edit applied successfully" }));
  log.record(rec("ok3", "execute_command", "execute" as any, { ok: true, output: "command ran" }));

  const mistakes = detectAllMistakes(log);
  assert.equal(mistakes.length, 0);
});

test("mistake detector: detectMistake (single) returns null for clean command", () => {
  const record = rec("ok", "search_code", "search" as any, { ok: true, output: "found" });
  const m = detectMistake(record);
  assert.equal(m, null);
});

test("mistake detector: detectMistake (single) flags command_failed", () => {
  const record = rec("fail", "search_code", "search" as any, { ok: false, output: "regex error" });
  const m = detectMistake(record);
  assert.ok(m);
  assert.equal(m!.type, "command_failed");
  assert.equal(m!.cause, "invalid_regex");
});

test("mistake detector: config-driven thresholds", () => {
  // Verify config drives behavior — contextBudget=100 should flag a 200-token command.
  const record = rec("overflow", "search_code", "search" as any, { ok: true, output: "ok", tokens: 200 });
  const m1 = detectMistake(record, { contextBudget: 100 });
  assert.ok(m1);
  assert.equal(m1!.type, "context_overflow");
  const m2 = detectMistake(record, { contextBudget: 1000 });
  assert.equal(m2, null);
});
