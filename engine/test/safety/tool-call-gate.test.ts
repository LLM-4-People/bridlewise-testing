/**
 * Adversarial tests for the pre-dispatch tool-call gate (EXP485, ).
 *
 * Escalated difficulty: ghost tools, schema mismatches, loops, config
 * toggles, improper usage (non-object args, invalid JSON), and a batch
 * mixing clean + blocked calls. These verify the gate blocks BEFORE the
 * registry sees the call and that blocked calls carry a typed error message the model can
 * course-correct from.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolCallGate,
  resolveToolCallGateConfig,
  DEFAULT_TOOL_CALL_GATE_CONFIG,
  type ToolCall,
  type ToolDefinition,
} from "../../src/safety/tool-call-gate.ts";

function mkToolCall(id: string, name: string, args: string): ToolCall {
  return Object.freeze({ id, type: "function" as const, function: Object.freeze({ name, arguments: args }) });
}

function mkToolDef(name: string, parameters: Record<string, unknown>): ToolDefinition {
  return Object.freeze({
    type: "function" as const,
    function: Object.freeze({ name, description: `${name} tool`, parameters }),
  });
}

const READ_FILE_DEF = mkToolDef("read_file", {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
});

const VIEWPORT_DEF = mkToolDef("viewport", {
  type: "object",
  properties: {
    path: { type: "string" },
    startLine: { type: "integer" },
    endLine: { type: "integer" },
  },
  required: ["path", "startLine", "endLine"],
});

const NO_ARG_DEF = mkToolDef("list_files", { type: "object", properties: {}, required: [] });

function gateWith(defs: ToolDefinition[], config?: Parameters<typeof createToolCallGate>[0]["config"]) {
  return createToolCallGate({ getDefinitions: () => defs, ...(config !== undefined ? { config } : {}) });
}

// ── Ghost-tool detection ────────────────────────────────────────────────────

test("GATE: blocks a call to an unregistered (ghost) tool", () => {
  const gate = gateWith([READ_FILE_DEF]);
  const result = gate.check([mkToolCall("c1", "grep", '{"path":"x"}')]);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.clean.length, 0);
  assert.equal(result.blocked[0]!.toolName, "grep");
  assert.match(result.blocked[0]!.errorMessage, /not registered/);
  assert.match(result.blocked[0]!.errorMessage, /read_file/); // suggests a real tool
});

test("GATE: the error message lists available tools so the model can recover", () => {
  const gate = gateWith([READ_FILE_DEF, VIEWPORT_DEF]);
  const result = gate.check([mkToolCall("c1", "nonexistent", "{}")]);
  assert.match(result.blocked[0]!.errorMessage, /read_file/);
  assert.match(result.blocked[0]!.errorMessage, /viewport/);
});

test("GATE: ghost detection can be disabled via config", () => {
  const gate = gateWith([READ_FILE_DEF], { enableGhostToolDetection: false });
  const result = gate.check([mkToolCall("c1", "grep", '{"path":"x"}')]);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.clean.length, 1);
});

// ── Schema validation ────────────────────────────────────────────────────────

test("GATE: blocks a call missing a required field", () => {
  const gate = gateWith([READ_FILE_DEF]);
  const result = gate.check([mkToolCall("c1", "read_file", "{}")]);
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0]!.errorMessage, /missing required field 'path'/);
});

// A small model cannot recover from a bare "missing required field 'type'" — it
// re-sends the same call. The guidance must name every missing field, its shape,
// and the minimal complete call, so the model fixes the gap instead of
// re-guessing everything.
test("GATE: the schema error names every missing required field with its shape, plus the minimal complete call", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  const result = gate.check([mkToolCall("c1", "viewport", "{}")]);
  assert.equal(result.blocked.length, 1);
  const message = result.blocked[0]!.errorMessage;
  // Every required field named (not just the first).
  assert.match(message, /missing required field 'path'/);
  assert.match(message, /missing required field 'startLine'/);
  assert.match(message, /missing required field 'endLine'/);
  // The field's shape is shown so a small model can pattern-match it.
  assert.match(message, /'startLine' \(a (number|integer)/);
  // The repair guidance names the minimal complete call (nothing sent yet).
  assert.match(message, /Send the tool call again with 'path', 'startLine', 'endLine' all present/);
});

test("GATE: a call with SOME required fields present is asked for only the missing delta (the rest is retained)", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  const result = gate.check([mkToolCall("c1", "viewport", '{"path":"x"}')]);
  assert.equal(result.blocked.length, 1);
  const message = result.blocked[0]!.errorMessage;
  // Delta resumption: the model is asked for ONLY the missing fields; the
  // valid field it already sent ('path') is retained and merged, not re-sent.
  assert.match(message, /Send only the missing 'startLine', 'endLine'/);
  assert.match(message, /kept the valid fields you already sent \('path'\)/);
  assert.match(message, /merges your next attempt in/);
  // The present field is NOT listed as missing (the guidance is targeted).
  assert.doesNotMatch(message, /missing required field 'path'/);
  assert.match(message, /missing required field 'startLine'/);
});

test("GATE: a call with NO usable arguments asks for the full call and shows a derived minimal example", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  const result = gate.check([mkToolCall("c1", "viewport", "{}")]);
  assert.equal(result.blocked.length, 1);
  const message = result.blocked[0]!.errorMessage;
  // Nothing valid to retain → the guidance asks for the complete call.
  assert.match(message, /Send the tool call again with 'path', 'startLine', 'endLine' all present/);
  // The minimal example is derived from the schema's required fields (their types).
  assert.match(message, /for example \{"path": <string>, "startLine": <(number|integer)>, "endLine": <(number|integer)>\}/);
});

test("GATE: a wrong-type error names the field, the expected type, the received type, and asks for only that delta", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  const result = gate.check([mkToolCall("c1", "viewport", '{"path":"x","startLine":"1","endLine":3}')]);
  assert.equal(result.blocked.length, 1);
  const message = result.blocked[0]!.errorMessage;
  assert.match(message, /field 'startLine' must be of type (number|integer), got string/);
  // Only the wrong-typed field is the delta; the correctly-typed required
  // fields ('path', 'endLine') are retained and must NOT be re-sent.
  assert.match(message, /Send only 'startLine' with the correct type/);
  assert.match(message, /kept the valid fields you already sent \('path', 'endLine'\)/);
});

test("GATE: blocks a call with the wrong argument type (string expected, number given)", () => {
  const gate = gateWith([READ_FILE_DEF]);
  const result = gate.check([mkToolCall("c1", "read_file", '{"path": 123}')]);
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0]!.errorMessage, /must be of type string/);
});

test("GATE: blocks a call with a non-integer where integer is required", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  const result = gate.check([mkToolCall("c1", "viewport", '{"path":"x","startLine":1.5,"endLine":3}')]);
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0]!.errorMessage, /must be of type integer/);
});

test("GATE: blocks a call with invalid JSON arguments", () => {
  const gate = gateWith([READ_FILE_DEF]);
  const result = gate.check([mkToolCall("c1", "read_file", '{"path":')]);
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0]!.errorMessage, /not valid JSON/);
});

test("GATE: blocks a call whose arguments are a JSON array, not an object", () => {
  const gate = gateWith([READ_FILE_DEF]);
  const result = gate.check([mkToolCall("c1", "read_file", '["path","x"]')]);
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0]!.errorMessage, /must be a JSON object/);
});

test("GATE: passes a valid call with all required fields + correct types", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  const result = gate.check([mkToolCall("c1", "viewport", '{"path":"x","startLine":1,"endLine":3}')]);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.clean.length, 1);
});

test("GATE: passes a call with extra unknown fields (forward-compatible)", () => {
  const gate = gateWith([READ_FILE_DEF]);
  const result = gate.check([mkToolCall("c1", "read_file", '{"path":"x","extra":42}')]);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.clean.length, 1);
});

test("GATE: empty arguments accepted for a tool with no required fields", () => {
  const gate = gateWith([NO_ARG_DEF]);
  assert.equal(gate.check([mkToolCall("c1", "list_files", "")]).clean.length, 1);
  assert.equal(gate.check([mkToolCall("c2", "list_files", "{}")]).clean.length, 1);
});

test("GATE: schema validation can be disabled via config", () => {
  const gate = gateWith([READ_FILE_DEF], { enableSchemaValidation: false });
  const result = gate.check([mkToolCall("c1", "read_file", "{}")]);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.clean.length, 1);
});

test("GATE: a tool with no parameters schema skips schema validation", () => {
  const noSchema = mkToolDef("freeform", { type: "object" });
  const gate = gateWith([noSchema]);
  assert.equal(gate.check([mkToolCall("c1", "freeform", '{"anything":true}')]).clean.length, 1);
});

// ── Loop detection ───────────────────────────────────────────────────────────

test("GATE: allows up to maxRepeatCount identical calls, blocks the next", () => {
  const gate = gateWith([READ_FILE_DEF], { maxRepeatCount: 5, loopWindow: 16 });
  const args = '{"path":"test.txt"}';
  for (let i = 0; i < 5; i++) {
    const r = gate.check([mkToolCall(`c${i}`, "read_file", args)]);
    assert.equal(r.clean.length, 1, `call ${i + 1} should pass (within maxRepeatCount)`);
    assert.equal(r.blocked.length, 0);
  }
  // The 6th identical call is blocked as a loop.
  const blocked = gate.check([mkToolCall("c5", "read_file", args)]);
  assert.equal(blocked.blocked.length, 1);
  assert.match(blocked.blocked[0]!.errorMessage, /loop/);
  assert.equal(blocked.clean.length, 0);
});

test("GATE: identical name but DIFFERENT arguments do NOT count as a loop", () => {
  const gate = gateWith([READ_FILE_DEF], { maxRepeatCount: 2, loopWindow: 16 });
  assert.equal(gate.check([mkToolCall("c1", "read_file", '{"path":"a.ts"}')]).clean.length, 1);
  assert.equal(gate.check([mkToolCall("c2", "read_file", '{"path":"b.ts"}')]).clean.length, 1);
  assert.equal(gate.check([mkToolCall("c3", "read_file", '{"path":"c.ts"}')]).clean.length, 1);
  // Now repeat the FIRST args exactly — within a small window this is 2nd occurrence.
  assert.equal(gate.check([mkToolCall("c4", "read_file", '{"path":"a.ts"}')]).clean.length, 1);
});

test("GATE: loop detection state persists across check calls (per session)", () => {
  const gate = gateWith([READ_FILE_DEF], { maxRepeatCount: 3, loopWindow: 16 });
  const args = '{"path":"loop.txt"}';
  for (let i = 0; i < 3; i++) {
    assert.equal(gate.check([mkToolCall(`c${i}`, "read_file", args)]).clean.length, 1);
  }
  // 4th identical call across separate check calls is blocked.
  const r = gate.check([mkToolCall("c3", "read_file", args)]);
  assert.equal(r.blocked.length, 1);
});

test("GATE: loop detection can be disabled via config", () => {
  const gate = gateWith([READ_FILE_DEF], { enableLoopDetection: false, maxRepeatCount: 1 });
  const args = '{"path":"x"}';
  for (let i = 0; i < 20; i++) {
    assert.equal(gate.check([mkToolCall(`c${i}`, "read_file", args)]).clean.length, 1);
  }
});

test("GATE: the loop window forgets old calls beyond loopWindow", () => {
  // With loopWindow=2, two distinct calls push the first out; a repeat of
  // the first is then seen as count 0 (forgiven), not a loop.
  const gate = gateWith([READ_FILE_DEF], { maxRepeatCount: 1, loopWindow: 2 });
  assert.equal(gate.check([mkToolCall("c1", "read_file", '{"path":"a"}')]).clean.length, 1);
  assert.equal(gate.check([mkToolCall("c2", "read_file", '{"path":"b"}')]).clean.length, 1);
  // window now [a, b]; a repeat of a would be count=1 >= 1 → blocked.
  assert.equal(gate.check([mkToolCall("c3", "read_file", '{"path":"a"}')]).blocked.length, 1);
  // Add a third distinct call so window [b, c] forgets a.
  assert.equal(gate.check([mkToolCall("c4", "read_file", '{"path":"c"}')]).clean.length, 1);
  // Now a is forgotten — repeat of a passes again.
  assert.equal(gate.check([mkToolCall("c5", "read_file", '{"path":"a"}')]).clean.length, 1);
});

// ── Batch + edge cases ───────────────────────────────────────────────────────

test("GATE: a batch mixing clean, ghost, and schema-invalid calls splits correctly", () => {
  const gate = gateWith([READ_FILE_DEF, NO_ARG_DEF]);
  const result = gate.check([
    mkToolCall("ok1", "read_file", '{"path":"a.ts"}'),     // clean
    mkToolCall("ghost", "grep", '{"path":"x"}'),            // ghost → blocked
    mkToolCall("bad", "read_file", "{}"),                   // missing field → blocked
    mkToolCall("ok2", "list_files", "{}"),                  // clean
  ]);
  assert.equal(result.clean.length, 2);
  assert.equal(result.blocked.length, 2);
  const blockedNames = result.blocked.map((b) => b.toolName).sort();
  assert.deepEqual(blockedNames, ["grep", "read_file"]);
});

test("GATE: empty input returns empty result (no false blocks)", () => {
  const gate = gateWith([READ_FILE_DEF]);
  const result = gate.check([]);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.clean.length, 0);
});

test("GATE: getDefinitions is called fresh on every check (live registry)", () => {
  let callCount = 0;
  const defs: ToolDefinition[] = [];
  const gate = createToolCallGate({ getDefinitions: () => { callCount++; return defs; } });
  // First check: registry empty → every call is a ghost.
  let r = gate.check([mkToolCall("c1", "read_file", '{"path":"x"}')]);
  assert.equal(r.blocked.length, 1);
  // Register read_file; next check sees it (no stale cache).
  defs.push(READ_FILE_DEF);
  r = gate.check([mkToolCall("c2", "read_file", '{"path":"x"}')]);
  assert.equal(r.clean.length, 1);
  assert.equal(callCount, 2, "getDefinitions must be called per check()");
});

test("GATE: result objects are frozen (immutable)", () => {
  const gate = gateWith([READ_FILE_DEF]);
  const result = gate.check([mkToolCall("c1", "read_file", '{"path":"x"}')]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.clean));
  assert.ok(Object.isFrozen(result.blocked));
  if (result.blocked.length > 0) assert.ok(Object.isFrozen(result.blocked[0]));
});

test("GATE: resolveToolCallGateConfig merges partial overrides over defaults", () => {
  const merged = resolveToolCallGateConfig({ maxRepeatCount: 99 });
  assert.equal(merged.maxRepeatCount, 99);
  assert.equal(merged.enableGhostToolDetection, DEFAULT_TOOL_CALL_GATE_CONFIG.enableGhostToolDetection);
  assert.equal(merged.loopWindow, DEFAULT_TOOL_CALL_GATE_CONFIG.loopWindow);
});

test("GATE: default config values are the documented safety invariants", () => {
  assert.equal(DEFAULT_TOOL_CALL_GATE_CONFIG.maxRepeatCount, 5);
  assert.equal(DEFAULT_TOOL_CALL_GATE_CONFIG.loopWindow, 16);
  assert.equal(DEFAULT_TOOL_CALL_GATE_CONFIG.enableGhostToolDetection, true);
  assert.equal(DEFAULT_TOOL_CALL_GATE_CONFIG.enableSchemaValidation, true);
  assert.equal(DEFAULT_TOOL_CALL_GATE_CONFIG.enableLoopDetection, true);
  assert.equal(DEFAULT_TOOL_CALL_GATE_CONFIG.enablePartialArgumentMemory, true);
  assert.equal(DEFAULT_TOOL_CALL_GATE_CONFIG.partialArgumentsLimit, 64);
  // The escalation threshold: the third identical block is the pattern a
  // watching human would intervene on (the measured incident ran SIX).
  assert.equal(DEFAULT_TOOL_CALL_GATE_CONFIG.blockEscalationAfter, 3);
  // The auto-trip threshold: 2× the escalation default — the escalation
  // teaches at 3, the trip concludes the model will not course-correct by 6.
  assert.equal(DEFAULT_TOOL_CALL_GATE_CONFIG.blockAutoTripAfter, 6);
});

test("GATE: resolveToolCallGateConfig merges the escalation threshold over the default", () => {
  const merged = resolveToolCallGateConfig({ blockEscalationAfter: 2 });
  assert.equal(merged.blockEscalationAfter, 2);
  assert.equal(resolveToolCallGateConfig({}).blockEscalationAfter, 3);
  // The auto-trip knob rides the same resolver; 0 is the operator's explicit
  // "never trip" and must survive the merge (a positive-only picker would
  // silently re-arm it).
  assert.equal(resolveToolCallGateConfig({ blockAutoTripAfter: 4 }).blockAutoTripAfter, 4);
  assert.equal(resolveToolCallGateConfig({ blockAutoTripAfter: 0 }).blockAutoTripAfter, 0);
  assert.equal(resolveToolCallGateConfig({}).blockAutoTripAfter, 6);
});

// ── Partial-argument memory (delta resumption) ──────────────────────────────
// When a schema-gated call fails, the gate retains the individually-VALID
// fields, asks only for the missing/incorrect delta, and merges the next
// attempt for the same tool onto the retained partial — re-validating the
// merged whole. A completed merge passes with the merged arguments (the
// executor dispatches the complete object, not the delta). The mechanism is
// tool-agnostic (driven by each tool's own schema), per-gate (per-run), and
// bounded.

/** A tool whose schema is CLOSED (additionalProperties: false). */
const CLOSED_DEF = mkToolDef("closed_tool", {
  type: "object",
  properties: { alpha: { type: "string" }, beta: { type: "integer" } },
  required: ["alpha", "beta"],
  additionalProperties: false,
});

/** A second distinct tool, to prove cross-tool isolation. */
const OTHER_DEF = mkToolDef("other_tool", {
  type: "object",
  properties: { gamma: { type: "string" }, delta: { type: "integer" } },
  required: ["gamma", "delta"],
});

test("GATE-DELTA: a schema failure retains the valid subset and the next delta merges to a valid whole", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  // First attempt: only 'path' is valid; startLine/endLine are missing.
  const first = gate.check([mkToolCall("c1", "viewport", '{"path":"x"}')]);
  assert.equal(first.blocked.length, 1);
  assert.equal(first.clean.length, 0);
  // Second attempt: send ONLY the delta (the two missing fields).
  const second = gate.check([mkToolCall("c2", "viewport", '{"startLine":1,"endLine":3}')]);
  // The merge completed the call: it is CLEAN, and carries the merged args.
  assert.equal(second.blocked.length, 0, `expected clean merge, got blocked: ${second.blocked[0]?.errorMessage ?? ""}`);
  assert.equal(second.clean.length, 1);
  assert.deepEqual(JSON.parse(second.clean[0]!.function.arguments), { path: "x", startLine: 1, endLine: 3 });
});

test("GATE-DELTA: the merged arguments are what pass through, not the delta alone", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  gate.check([mkToolCall("c1", "viewport", '{"path":"x","startLine":1}')]);
  const second = gate.check([mkToolCall("c2", "viewport", '{"endLine":9}')]);
  assert.equal(second.clean.length, 1);
  // The retained path + startLine merged with the delta's endLine.
  assert.deepEqual(JSON.parse(second.clean[0]!.function.arguments), { path: "x", startLine: 1, endLine: 9 });
});

test("GATE-DELTA: a still-invalid merged whole retains the new valid subset and asks for the remaining delta", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  gate.check([mkToolCall("c1", "viewport", '{"path":"x"}')]);           // retains {path}
  const second = gate.check([mkToolCall("c2", "viewport", '{"startLine":1}')]); // merges to {path,startLine}, still missing endLine
  assert.equal(second.clean.length, 0);
  assert.equal(second.blocked.length, 1);
  // The retained partial now includes startLine; the guidance asks only for endLine.
  assert.match(second.blocked[0]!.errorMessage, /missing required field 'endLine'/);
  assert.match(second.blocked[0]!.errorMessage, /Send only the missing 'endLine'/);
  // The third attempt's delta completes it.
  const third = gate.check([mkToolCall("c3", "viewport", '{"endLine":2}')]);
  assert.equal(third.clean.length, 1);
  assert.deepEqual(JSON.parse(third.clean[0]!.function.arguments), { path: "x", startLine: 1, endLine: 2 });
});

test("GATE-DELTA: newly-sent fields override retained ones on merge", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  gate.check([mkToolCall("c1", "viewport", '{"path":"old","startLine":1}')]); // retains {path:old,startLine:1}
  // Re-send path with a corrected value plus the missing endLine.
  const second = gate.check([mkToolCall("c2", "viewport", '{"path":"new","endLine":5}')]);
  assert.equal(second.clean.length, 1);
  assert.deepEqual(JSON.parse(second.clean[0]!.function.arguments), { path: "new", startLine: 1, endLine: 5 });
});

test("GATE-DELTA: an incorrect retained field is corrected by the delta", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  // startLine is the wrong type (string) → only 'path' is retained.
  const first = gate.check([mkToolCall("c1", "viewport", '{"path":"x","startLine":"oops"}')]);
  // Both the missing 'endLine' and the wrong-typed 'startLine' are the delta;
  // only the correctly-typed 'path' is retained.
  assert.match(first.blocked[0]!.errorMessage, /Send only the missing\/incorrect 'endLine', 'startLine'/);
  assert.match(first.blocked[0]!.errorMessage, /kept the valid fields you already sent \('path'\)/);
  const second = gate.check([mkToolCall("c2", "viewport", '{"startLine":4,"endLine":8}')]);
  assert.equal(second.clean.length, 1);
  assert.deepEqual(JSON.parse(second.clean[0]!.function.arguments), { path: "x", startLine: 4, endLine: 8 });
});

test("GATE-DELTA: cross-tool isolation — a partial for one tool never merges into another", () => {
  const gate = gateWith([VIEWPORT_DEF, OTHER_DEF]);
  gate.check([mkToolCall("c1", "viewport", '{"path":"x"}')]); // retains viewport partial
  // A DIFFERENT tool's call must not see the viewport partial.
  const other = gate.check([mkToolCall("c2", "other_tool", '{"gamma":"g"}')]);
  assert.equal(other.clean.length, 0, "other_tool has its own missing fields and no partial of its own");
  assert.equal(other.blocked.length, 1);
  assert.match(other.blocked[0]!.errorMessage, /missing required field 'delta'/);
  // The viewport partial is still intact and unrelated to other_tool's fields.
  const finish = gate.check([mkToolCall("c3", "viewport", '{"startLine":1,"endLine":2}')]);
  assert.deepEqual(JSON.parse(finish.clean[0]!.function.arguments), { path: "x", startLine: 1, endLine: 2 });
});

test("GATE-DELTA: per-run scoping — a fresh gate instance has no memory of a prior gate", () => {
  const gateA = gateWith([VIEWPORT_DEF]);
  gateA.check([mkToolCall("c1", "viewport", '{"path":"x"}')]); // retains in gateA only
  // A new gate (a new run/conversation) starts empty: sending only the delta fails.
  const gateB = gateWith([VIEWPORT_DEF]);
  const r = gateB.check([mkToolCall("c2", "viewport", '{"startLine":1,"endLine":3}')]);
  assert.equal(r.clean.length, 0, "a fresh gate has no retained 'path' to merge");
  assert.equal(r.blocked.length, 1);
  assert.match(r.blocked[0]!.errorMessage, /missing required field 'path'/);
});

test("GATE-DELTA: the retained partial is cleared once the call succeeds", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  gate.check([mkToolCall("c1", "viewport", '{"path":"x"}')]);
  const ok = gate.check([mkToolCall("c2", "viewport", '{"startLine":1,"endLine":2}')]);
  assert.equal(ok.clean.length, 1);
  // A subsequent bare call must NOT merge the (now-cleared) partial.
  const after = gate.check([mkToolCall("c3", "viewport", '{"startLine":5,"endLine":6}')]);
  assert.equal(after.clean.length, 0);
  assert.match(after.blocked[0]!.errorMessage, /missing required field 'path'/);
});

test("GATE-DELTA: a JSON-shape error (not an object) retains nothing and never merges", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  const bad = gate.check([mkToolCall("c1", "viewport", '{"path":')]); // invalid JSON
  assert.equal(bad.blocked.length, 1);
  assert.match(bad.blocked[0]!.errorMessage, /not valid JSON/);
  // The next valid-delta call has no retained partial to merge with.
  const next = gate.check([mkToolCall("c2", "viewport", '{"startLine":1,"endLine":2}')]);
  assert.equal(next.clean.length, 0);
  assert.match(next.blocked[0]!.errorMessage, /missing required field 'path'/);
});

test("GATE-DELTA: extra unknown fields are NOT retained on a closed schema, so they cannot be smuggled into the merge", () => {
  const gate = gateWith([CLOSED_DEF]);
  // The extra 'evil' field is not declared; on a closed schema it is not a
  // known-valid value, so it must not be retained.
  gate.check([mkToolCall("c1", "closed_tool", '{"alpha":"a","evil":"x"}')]);
  const second = gate.check([mkToolCall("c2", "closed_tool", '{"beta":2}')]);
  assert.equal(second.clean.length, 1);
  const merged = JSON.parse(second.clean[0]!.function.arguments);
  assert.deepEqual(merged, { alpha: "a", beta: 2 });
  assert.ok(!("evil" in merged), "an undeclared field on a closed schema must not reach the merged arguments");
});

test("GATE-DELTA: extra fields on an OPEN schema are retained and merged (forward-compatible)", () => {
  // The default READ_FILE_DEF has no additionalProperties:false → open.
  const gate = gateWith([mkToolDef("open_tool", {
    type: "object",
    properties: { alpha: { type: "string" }, beta: { type: "integer" } },
    required: ["alpha", "beta"],
  })]);
  gate.check([mkToolCall("c1", "open_tool", '{"alpha":"a","note":"kept"}')]);
  const second = gate.check([mkToolCall("c2", "open_tool", '{"beta":7}')]);
  assert.equal(second.clean.length, 1);
  assert.deepEqual(JSON.parse(second.clean[0]!.function.arguments), { alpha: "a", note: "kept", beta: 7 });
});

test("GATE-DELTA: partial-argument memory can be disabled via config (no retention, no merge)", () => {
  const gate = gateWith([VIEWPORT_DEF], { enablePartialArgumentMemory: false });
  gate.check([mkToolCall("c1", "viewport", '{"path":"x"}')]);
  // With memory off, a delta-only call fails (no retained 'path').
  const second = gate.check([mkToolCall("c2", "viewport", '{"startLine":1,"endLine":3}')]);
  assert.equal(second.clean.length, 0);
  assert.match(second.blocked[0]!.errorMessage, /missing required field 'path'/);
});

test("GATE-DELTA: a valid standalone call passes unchanged even with a stale retained partial present", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  gate.check([mkToolCall("c1", "viewport", '{"path":"x"}')]); // retains {path}
  // A complete, valid call passes; the merge adds nothing new beyond it, and
  // the retained partial is consumed.
  const ok = gate.check([mkToolCall("c2", "viewport", '{"path":"y","startLine":1,"endLine":2}')]);
  assert.equal(ok.clean.length, 1);
  assert.deepEqual(JSON.parse(ok.clean[0]!.function.arguments), { path: "y", startLine: 1, endLine: 2 });
});

test("GATE-DELTA: the retained store is bounded by partialArgumentsLimit", () => {
  // Build many DISTINCT tools dynamically (no hardcoded tool list), each
  // failing with a retained field, and assert the map never exceeds the cap.
  const limit = 4;
  const defs: ToolDefinition[] = [];
  for (let i = 0; i < limit + 3; i++) {
    defs.push(mkToolDef(`tool_${i}`, {
      type: "object",
      properties: { present: { type: "string" }, needed: { type: "integer" } },
      required: ["present", "needed"],
    }));
  }
  const gate = gateWith(defs, { partialArgumentsLimit: limit });
  for (let i = 0; i < defs.length; i++) {
    gate.check([mkToolCall(`c${i}`, `tool_${i}`, '{"present":"x"}')]); // each retains {present}
  }
  // Completing the OLDEST retained tool must now fail (it was evicted), while
  // the MOST RECENT one still merges.
  const oldest = gate.check([mkToolCall("oldest", "tool_0", '{"needed":1}')]);
  assert.equal(oldest.clean.length, 0, "the oldest partial was evicted beyond the limit");
  const newest = gate.check([mkToolCall("newest", `tool_${defs.length - 1}`, '{"needed":1}')]);
  assert.equal(newest.clean.length, 1, "the most recent partial survives within the limit");
});

// ── Schema vocabulary: enum + minLength (declared VALUE constraints) ────────
// A schema-declared constraint the gate ignored fell through to an
// executor-level flat error with no field-level repair — measured as a model
// re-generating an entire 14KB artifact because a wrong `type` VALUE was
// rejected flat instead of being asked for as a one-field delta. The schema
// is the ONE declaration site; the gate enforces what it declares.

/** The create_artifact argument shape: enum `type`, non-empty title/content. */
const ARTIFACT_DEF = mkToolDef("create_artifact", {
  type: "object",
  properties: {
    type: { type: "string", enum: ["html", "game", "sheet", "presentation"] },
    title: { type: "string", minLength: 1 },
    content: { type: "string", minLength: 1 },
  },
  required: ["type", "title", "content"],
  additionalProperties: false,
});

test("GATE-ENUM: a declared enum value that is in the set passes", () => {
  const gate = gateWith([ARTIFACT_DEF]);
  const result = gate.check([mkToolCall("c1", "create_artifact", JSON.stringify({
    type: "game", title: "T", content: "<html></html>",
  }))]);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.clean.length, 1);
});

test("GATE-ENUM: a wrong VALUE blocks with the field, the allowed values, and the kept-fields clause — the delta-repair shape, not a flat error", () => {
  const gate = gateWith([ARTIFACT_DEF]);
  const result = gate.check([mkToolCall("c1", "create_artifact", JSON.stringify({
    type: "app", title: "T", content: "<html></html>",
  }))]);
  assert.equal(result.blocked.length, 1);
  const message = result.blocked[0]!.errorMessage;
  // The field is named, the allowed values are listed, and the sent value is
  // quoted — a small model pattern-matches a concrete shape.
  assert.match(message, /field 'type' must be one of: html, game, sheet, presentation, got "app"/);
  // The repair asks for ONLY the corrected value (the type matched; the
  // value did not) and names the kept fields — the model does not re-send
  // the artifact.
  assert.match(message, /Send only 'type' with a corrected value/);
  assert.match(message, /kept the valid fields you already sent \('title', 'content'\)/);
  // The structured half: the failed field is machine-queryable.
  assert.deepEqual(result.blocked[0]!.failedFields, ["type"]);
});

test("GATE-ENUM: a wrong enum VALUE is not retained — the next delta carries only the corrected field and merges with the kept artifact", () => {
  const gate = gateWith([ARTIFACT_DEF]);
  const first = gate.check([mkToolCall("c1", "create_artifact", JSON.stringify({
    type: "app", title: "T", content: "<html>…14KB…</html>",
  }))]);
  assert.equal(first.blocked.length, 1);
  // The model sends ONLY the corrected field; the harness merges it onto the
  // retained title + content — the whole artifact is never re-sent.
  const second = gate.check([mkToolCall("c2", "create_artifact", JSON.stringify({ type: "html" }))]);
  assert.equal(second.blocked.length, 0, `expected the delta merge to complete the call: ${second.blocked[0]?.errorMessage ?? ""}`);
  assert.equal(second.clean.length, 1);
  assert.deepEqual(JSON.parse(second.clean[0]!.function.arguments), {
    type: "html", title: "T", content: "<html>…14KB…</html>",
  });
});

test("GATE-ENUM: an OPTIONAL declared enum field with an invalid value blocks (present fields are validated, not just required ones)", () => {
  const memoryDef = mkToolDef("fetch_memory", {
    type: "object",
    properties: {
      text: { type: "string" },
      tier: { type: "string", enum: ["present", "short-term", "long-term"] },
    },
    required: [],
  });
  const gate = gateWith([memoryDef]);
  const result = gate.check([mkToolCall("c1", "fetch_memory", '{"tier":"yesterday"}')]);
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0]!.errorMessage, /field 'tier' must be one of: present, short-term, long-term, got "yesterday"/);
  assert.deepEqual(result.blocked[0]!.failedFields, ["tier"]);
});

test("GATE-ENUM: a MISSING enum field's shape hint lists the allowed values", () => {
  const gate = gateWith([ARTIFACT_DEF]);
  const result = gate.check([mkToolCall("c1", "create_artifact", JSON.stringify({ title: "T", content: "c" }))]);
  assert.equal(result.blocked.length, 1);
  const message = result.blocked[0]!.errorMessage;
  // The missing field's shape shows the allowed set so the model sends a
  // valid value FIRST try instead of discovering the enum by failing.
  assert.match(message, /missing required field 'type' \(a string — one of: html, game, sheet, presentation\)/);
});

test("GATE-ENUM: a wrong TYPE against an enum field reports the type, not the value constraint (one failure, one problem)", () => {
  const gate = gateWith([ARTIFACT_DEF]);
  const result = gate.check([mkToolCall("c1", "create_artifact", JSON.stringify({
    type: 42, title: "T", content: "c",
  }))]);
  assert.equal(result.blocked.length, 1);
  // The type check fired first: the message is the type problem, not "must be
  // one of" (42 is not even comparable to the enum as a string).
  assert.match(result.blocked[0]!.errorMessage, /field 'type' must be of type string, got number/);
  assert.doesNotMatch(result.blocked[0]!.errorMessage, /must be one of/);
});

test("GATE-ENUM: a malformed enum declaration is ignored (forward-compatible, same as unknown schema shapes)", () => {
  const badEnumDef = mkToolDef("odd_tool", {
    type: "object",
    properties: { v: { type: "string", enum: "not-an-array" } },
    required: ["v"],
  });
  const gate = gateWith([badEnumDef]);
  const result = gate.check([mkToolCall("c1", "odd_tool", '{"v":"anything"}')]);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.clean.length, 1);
});

test("GATE-MINLENGTH: an empty string against a declared minLength blocks with the length problem and the value-repair phrasing", () => {
  const gate = gateWith([ARTIFACT_DEF]);
  const result = gate.check([mkToolCall("c1", "create_artifact", JSON.stringify({
    type: "html", title: "", content: "<html></html>",
  }))]);
  assert.equal(result.blocked.length, 1);
  const message = result.blocked[0]!.errorMessage;
  assert.match(message, /field 'title' must be at least 1 character long, got 0/);
  assert.match(message, /Send only 'title' with a corrected value/);
  assert.match(message, /kept the valid fields you already sent \('type', 'content'\)/);
  assert.deepEqual(result.blocked[0]!.failedFields, ["title"]);
});

test("GATE-MINLENGTH: a non-empty string against the same declaration passes (the bound is enforced, not the emptiness of the tool)", () => {
  const gate = gateWith([ARTIFACT_DEF]);
  const result = gate.check([mkToolCall("c1", "create_artifact", JSON.stringify({
    type: "html", title: "T", content: "x",
  }))]);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.clean.length, 1);
});

// ── Block-sequence escalation (the loop detection for BLOCKED calls) ────────
// A refused call never reaches the admitted-call loop window (the refusing
// check runs first), so a model repeating a REFUSED call identically was
// invisible to every repetition detector — measured as SIX identical
// gate-blocked write_file calls in one run with nothing escalating. The
// gate's own block-sequence bookkeeping closes that: after
// blockEscalationAfter consecutive identical blocks (same reason + same
// failed fields, derived from the gate's verdict data), the refusal
// escalates to name the pattern honestly.

/** A write_file-shaped fixture: two required strings (the incident's shape). */
const WRITE_FILE_DEF = mkToolDef("mcp__filesystem__write_file", {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    content: { type: "string", minLength: 1 },
  },
  required: ["path", "content"],
  additionalProperties: false,
});

test("GATE-ESCALATION: repeated empty-argument calls to a write_file-shaped tool escalate at 3 and AUTO-TRIP at the default 6 — the six-blocked-calls incident shape, closed", () => {
  // The incident: the model called write_file SIX consecutive times with
  // empty arguments; every call was blocked for the same missing fields and
  // nothing changed. With the default thresholds, the third identical block
  // escalates, and the SIXTH trips the tool for the rest of the run — the
  // incident's own length is now the terminal case.
  const gate = gateWith([WRITE_FILE_DEF]);
  // Blocks 1 and 2: the normal delta-repair refusal (teach, then warn).
  for (const n of [1, 2]) {
    const r = gate.check([mkToolCall(`c${n}`, "mcp__filesystem__write_file", "{}")]);
    assert.equal(r.blocked.length, 1);
    assert.equal(r.blocked[0]!.escalated, undefined, `block ${n} must be the normal refusal`);
    assert.equal(r.blocked[0]!.autoTripped, undefined, `block ${n} must not trip`);
    assert.doesNotMatch(r.blocked[0]!.errorMessage, /consecutive time/);
  }
  // Block 3: the escalation fires — the message names the streak honestly.
  const third = gate.check([mkToolCall("c3", "mcp__filesystem__write_file", "{}")]);
  assert.equal(third.blocked.length, 1);
  assert.equal(third.blocked[0]!.escalated, true, "the third identical block carries the escalation fact");
  assert.equal(third.blocked[0]!.autoTripped, undefined, "the escalation alone does not trip");
  const message = third.blocked[0]!.errorMessage;
  assert.match(message, /third consecutive time this call of 'mcp__filesystem__write_file' was blocked/);
  assert.match(message, /for the same failed fields \('content', 'path'\)/);
  assert.match(message, /the previous 2 calls were blocked identically/);
  assert.match(message, /repeating the same arguments cannot succeed/);
  assert.match(message, /Either send the corrected fields named above or answer in text/);
  // The failed fields stay machine-queryable on the escalated block too.
  assert.deepEqual(third.blocked[0]!.failedFields, ["path", "content"]);
  // Blocks 4 and 5 (the rest of the incident): still escalated, count
  // growing, not yet tripped.
  const fortyFive = gate.check([
    mkToolCall("c4", "mcp__filesystem__write_file", "{}"),
    mkToolCall("c5", "mcp__filesystem__write_file", "{}"),
  ]);
  assert.match(fortyFive.blocked[0]!.errorMessage, /fourth consecutive time/);
  assert.match(fortyFive.blocked[1]!.errorMessage, /fifth consecutive time/);
  for (const b of fortyFive.blocked) {
    assert.equal(b.escalated, true);
    assert.equal(b.autoTripped, undefined, "below the trip threshold the tool stays armed");
  }
  // Block 6: the AUTO-TRIP — the message is the terminal honest form (the
  // base repair guidance + the trip clause), and BOTH facts ride the block.
  const sixth = gate.check([mkToolCall("c6", "mcp__filesystem__write_file", "{}")]);
  assert.equal(sixth.blocked.length, 1);
  const trip = sixth.blocked[0]!;
  assert.equal(trip.escalated, true, "the escalated flag continues to ride the tripping block");
  assert.equal(trip.autoTripped, true, "the trip fact rides the block that tripped");
  assert.equal(trip.autoTrippedAfter, 6, "the structured count answers 'after how many' without parsing prose");
  assert.match(trip.errorMessage, /The 'mcp__filesystem__write_file' tool has been disabled for the rest of this run after 6 consecutive identical blocked calls/);
  assert.match(trip.errorMessage, /the user can re-enable it from the breaker panel/);
  assert.match(trip.errorMessage, /Answer in text or ask the user/);
  // The tripping block keeps the base repair guidance — the model that DID
  // course-correct after reading it still can; only the tool is gone.
  assert.match(trip.errorMessage, /arguments failed schema validation/);
});

test("GATE-ESCALATION: a DIFFERENT failure shape resets the streak — the identity is the verdict, not the tool name alone", () => {
  // Partial-argument memory is OFF here so the streak mechanics are tested in
  // isolation: with it on, the "different shape" call would merge with the
  // retained partial and possibly complete the call (a clean call — a
  // different reset path covered by its own arm below).
  const gate = gateWith([VIEWPORT_DEF], { enablePartialArgumentMemory: false });
  // Two blocks for the same missing fields.
  gate.check([mkToolCall("c1", "viewport", '{"path":"x"}')]);        // missing startLine,endLine
  gate.check([mkToolCall("c2", "viewport", '{"path":"y"}')]);        // same failed fields → streak 2
  // A DIFFERENT shape: the wrong-typed path (failed fields differ) → the
  // streak restarts at 1, so this block and the NEXT two are normal.
  const different = gate.check([mkToolCall("c3", "viewport", '{"path":123,"startLine":1,"endLine":2}')]);
  assert.equal(different.blocked.length, 1);
  assert.equal(different.blocked[0]!.escalated, undefined, "a different failure shape restarts the streak");
  gate.check([mkToolCall("c4", "viewport", '{"path":"x"}')]);        // streak 1 (reset by the different shape)
  gate.check([mkToolCall("c5", "viewport", '{"path":"x"}')]);        // streak 2 — still normal
  const third = gate.check([mkToolCall("c6", "viewport", '{"path":"x"}')]); // streak 3 → escalates
  assert.equal(third.blocked[0]!.escalated, true, "the streak needed three identical blocks AFTER the reset");
  assert.match(third.blocked[0]!.errorMessage, /for the same failed fields \('endLine', 'startLine'\)/);
});

test("GATE-ESCALATION: a successful call resets the streak — course-correction clears the history", () => {
  const gate = gateWith([VIEWPORT_DEF]);
  gate.check([mkToolCall("c1", "viewport", '{"path":"x"}')]);   // streak 1
  gate.check([mkToolCall("c2", "viewport", '{"path":"x"}')]);   // streak 2
  // The model course-corrects: a complete, valid call PASSES.
  const ok = gate.check([mkToolCall("c3", "viewport", '{"path":"x","startLine":1,"endLine":2}')]);
  assert.equal(ok.clean.length, 1);
  // The next failures start a fresh streak: two normal, the third escalates.
  gate.check([mkToolCall("c4", "viewport", '{"path":"x"}')]);   // streak 1
  const second = gate.check([mkToolCall("c5", "viewport", '{"path":"x"}')]);   // streak 2
  assert.equal(second.blocked[0]!.escalated, undefined, "the reset held: this is only the second block of the new streak");
  const third = gate.check([mkToolCall("c6", "viewport", '{"path":"x"}')]);   // streak 3
  assert.equal(third.blocked[0]!.escalated, true);
});

test("GATE-ESCALATION: ghost-tool blocks escalate too (the bookkeeping is kind-generic)", () => {
  const gate = gateWith([READ_FILE_DEF]);
  for (const n of [1, 2]) {
    const r = gate.check([mkToolCall(`c${n}`, "grep", '{"pattern":"x"}')]);
    assert.equal(r.blocked[0]!.escalated, undefined);
  }
  const third = gate.check([mkToolCall("c3", "grep", '{"pattern":"x"}')]);
  assert.equal(third.blocked[0]!.escalated, true);
  assert.match(third.blocked[0]!.errorMessage, /for the same unregistered tool name/);
  assert.match(third.blocked[0]!.errorMessage, /Use a registered tool or answer in text/);
});

test("GATE-ESCALATION: the threshold is configurable through the same resolver as every gate knob", () => {
  const gate = gateWith([WRITE_FILE_DEF], { blockEscalationAfter: 2 });
  gate.check([mkToolCall("c1", "mcp__filesystem__write_file", "{}")]);
  const second = gate.check([mkToolCall("c2", "mcp__filesystem__write_file", "{}")]);
  assert.equal(second.blocked[0]!.escalated, true, "with the threshold at 2, the second identical block escalates");
});

// ── Block-sequence auto-trip (the tool is off for the rest of the run) ──────
// The escalation gives the model an honest out at 3; a model that ignores it
// 2× more is burning the user's tokens in a loop (the measured incident:
// ~2,700 completion tokens per repeated turn). At `blockAutoTripAfter`
// (default 6 = 2× the escalation default) the tool is tripped for the rest
// of the run: the terminal honest message, the trip fact on the block, and
// every further call refused at the TOP of check — before any verdict can
// change the streak's shape.

test("GATE-AUTOTRIP: the N-1 blocks do not trip and the Nth identical block trips with the terminal message", () => {
  // Threshold 4 via the config knob (2 blocks past the escalation at 2):
  // blocks 1–3 escalate (from the 2nd) but leave the tool armed; the 4th
  // trips.
  const gate = gateWith([WRITE_FILE_DEF], { blockEscalationAfter: 2, blockAutoTripAfter: 4 });
  for (const n of [1, 2, 3]) {
    const r = gate.check([mkToolCall(`c${n}`, "mcp__filesystem__write_file", "{}")]);
    assert.equal(r.blocked[0]!.autoTripped, undefined, `block ${n} (below the trip threshold) must not trip`);
  }
  const fourth = gate.check([mkToolCall("c4", "mcp__filesystem__write_file", "{}")]);
  assert.equal(fourth.blocked[0]!.autoTripped, true, "the 4th identical block trips");
  assert.equal(fourth.blocked[0]!.autoTrippedAfter, 4);
  assert.equal(fourth.blocked[0]!.escalated, true, "the escalated flag continues to ride the trip");
  assert.match(fourth.blocked[0]!.errorMessage, /has been disabled for the rest of this run after 4 consecutive identical blocked calls/);
});

test("GATE-AUTOTRIP: a tripped tool refuses honestly — the terminal message is stable, the streak counter is NOT re-armed", () => {
  const gate = gateWith([WRITE_FILE_DEF]);
  for (let n = 1; n <= 6; n++) {
    gate.check([mkToolCall(`c${n}`, "mcp__filesystem__write_file", "{}")]);
  }
  // Post-trip refusals: the tool is off, said plainly, with the standing
  // trip count — identical on every repeat (no verdict is computed, so the
  // count cannot grow and no new shape can occur).
  for (const id of ["c7", "c8", "c9"]) {
    const r = gate.check([mkToolCall(id, "mcp__filesystem__write_file", "{}")]);
    assert.equal(r.blocked.length, 1);
    assert.equal(r.clean.length, 0, "a successful call is impossible while tripped");
    const b = r.blocked[0]!;
    assert.equal(b.autoTripped, true, "the standing trip rides every refusal");
    assert.equal(b.autoTrippedAfter, 6, "the count stays the trip's count — the streak is not re-armed");
    assert.equal(b.escalated, undefined, "a post-trip refusal is not an escalation (no streak was counted)");
    assert.equal(b.failedFields, undefined, "no schema verdict was computed for a tripped tool");
    assert.match(b.errorMessage, /is disabled for the rest of this run \(auto-tripped after 6 consecutive identical blocked calls\)/);
    assert.match(b.errorMessage, /Answer in text or ask the user/);
  }
});

test("GATE-AUTOTRIP: the tripped check runs BEFORE ghost detection — a trip survives the tool vanishing from the manifest", () => {
  // The consumer flips the breaker row when it sees the trip, so the NEXT
  // boundary re-derives the manifest without the tool and the gate's
  // definitions no longer know it. The honest refusal must NOT degrade
  // into a ghost-tool message ("not registered") — the tool is disabled,
  // not unregistered.
  let defs: ToolDefinition[] = [WRITE_FILE_DEF];
  const gate = createToolCallGate({
    getDefinitions: () => defs,
    config: { blockEscalationAfter: 3, blockAutoTripAfter: 6 },
  });
  for (let n = 1; n <= 6; n++) {
    gate.check([mkToolCall(`c${n}`, "mcp__filesystem__write_file", "{}")]);
  }
  defs = []; // the row flipped; the manifest re-derivation dropped the tool
  const after = gate.check([mkToolCall("c7", "mcp__filesystem__write_file", "{}")]);
  assert.equal(after.blocked.length, 1);
  assert.match(after.blocked[0]!.errorMessage, /is disabled for the rest of this run/);
  assert.doesNotMatch(after.blocked[0]!.errorMessage, /not registered/, "a tripped tool is not misreported as unregistered");
});

test("GATE-AUTOTRIP: a DIFFERENT failure shape does not un-trip — no call executes, so no new shape can occur", () => {
  const gate = gateWith([WRITE_FILE_DEF]);
  for (let n = 1; n <= 6; n++) {
    gate.check([mkToolCall(`c${n}`, "mcp__filesystem__write_file", "{}")]);
  }
  // A different failure shape (a wrong-typed field instead of missing
  // fields) would reset the STREAK pre-trip; post-trip it must not matter:
  // the tripped check refuses before the schema verdict is ever computed,
  // so the refusal is the terminal one and the tool stays tripped.
  const different = gate.check([
    mkToolCall("c7", "mcp__filesystem__write_file", '{"path":123,"content":"x"}'),
  ]);
  assert.equal(different.blocked.length, 1);
  assert.match(different.blocked[0]!.errorMessage, /is disabled for the rest of this run/);
  assert.equal(different.blocked[0]!.autoTrippedAfter, 6, "the standing trip is untouched by the different shape");
});

test("GATE-AUTOTRIP: the trip dies with the gate instance — a fresh run starts with the tool armed", () => {
  const first = gateWith([WRITE_FILE_DEF]);
  for (let n = 1; n <= 6; n++) {
    first.check([mkToolCall(`c${n}`, "mcp__filesystem__write_file", "{}")]);
  }
  assert.equal(first.check([mkToolCall("c7", "mcp__filesystem__write_file", "{}")]).blocked[0]!.autoTripped, true);
  // A NEW run is a NEW gate instance: the same call is the FIRST block of a
  // fresh streak — the normal refusal, no trip fact.
  const second = gateWith([WRITE_FILE_DEF]);
  const fresh = second.check([mkToolCall("d1", "mcp__filesystem__write_file", "{}")]);
  assert.equal(fresh.blocked.length, 1);
  assert.equal(fresh.blocked[0]!.autoTripped, undefined, "the previous run's trip does not leak across runs");
  assert.equal(fresh.blocked[0]!.escalated, undefined);
  assert.doesNotMatch(fresh.blocked[0]!.errorMessage, /disabled for the rest of this run/);
});

test("GATE-AUTOTRIP: 0 disables the auto-trip — escalation still fires, the tool is never tripped", () => {
  const gate = gateWith([WRITE_FILE_DEF], { blockAutoTripAfter: 0 });
  for (let n = 1; n <= 8; n++) {
    const r = gate.check([mkToolCall(`c${n}`, "mcp__filesystem__write_file", "{}")]);
    assert.equal(r.blocked[0]!.autoTripped, undefined, `block ${n} must never trip with the knob at 0`);
  }
  // The escalation is untouched by disabling the trip: the 8th block still
  // names its streak honestly.
  const eighth = gate.check([mkToolCall("c9", "mcp__filesystem__write_file", "{}")]);
  assert.equal(eighth.blocked[0]!.escalated, true);
  assert.match(eighth.blocked[0]!.errorMessage, /ninth consecutive time/);
  assert.doesNotMatch(eighth.blocked[0]!.errorMessage, /disabled for the rest of this run/);
});

test("GATE-AUTOTRIP: ghost-tool blocks trip too (kind-generic, like the escalation) — the refusal is the whole remedy for a name that has no row", () => {
  // A hallucinated tool name has no breaker row to flip, but the same loop
  // logic applies: six identical ghost calls trip the name for the rest of
  // the run, so the model is told plainly to stop.
  const gate = gateWith([READ_FILE_DEF]);
  for (let n = 1; n <= 5; n++) {
    const r = gate.check([mkToolCall(`c${n}`, "grep", '{"pattern":"x"}')]);
    assert.equal(r.blocked[0]!.autoTripped, undefined, `block ${n} must not trip`);
  }
  const tripBlock = gate.check([mkToolCall("c6", "grep", '{"pattern":"x"}')]);
  assert.equal(tripBlock.blocked[0]!.autoTripped, true, "the sixth identical ghost block trips the name");
  assert.match(tripBlock.blocked[0]!.errorMessage, /has been disabled for the rest of this run after 6 consecutive identical blocked calls/);
  const after = gate.check([mkToolCall("c7", "grep", '{"pattern":"x"}')]);
  assert.match(after.blocked[0]!.errorMessage, /is disabled for the rest of this run/);
  assert.doesNotMatch(after.blocked[0]!.errorMessage, /not registered/, "the standing trip outranks the ghost verdict");
});

test("GATE-DELTA: repaired calls retain native caller and namespace and enter the loop window", () => {
  const gate = gateWith([READ_FILE_DEF], { maxRepeatCount: 1 });
  const complete = { ...mkToolCall("c1", "read_file", '{"path":"x"}'), caller: { type: "direct" }, namespace: "files" };
  assert.equal(gate.check([complete]).clean.length, 1);
  const paired = gateWith([mkToolDef("pair", { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] })], { maxRepeatCount: 1 });
  paired.check([mkToolCall("p1", "pair", '{"a":1}')]);
  const result = paired.check([{ ...mkToolCall("p2", "pair", '{"b":2}'), caller: { type: "direct" }, namespace: "files" }]);
  assert.equal(result.clean.length, 1);
  assert.deepEqual(result.clean[0]?.caller, { type: "direct" }); assert.equal(result.clean[0]?.namespace, "files");
  paired.check([mkToolCall("p3", "pair", '{"a":1}')]);
  const repeated = paired.check([mkToolCall("p4", "pair", '{"b":2}')]);
  assert.equal(repeated.clean.length, 0); assert.match(repeated.blocked[0]!.errorMessage, /repeat|loop/i);
});
