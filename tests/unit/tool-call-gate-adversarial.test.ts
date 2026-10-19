// @vitest-environment node
/**
 * ADVERSARIAL tests for the pre-dispatch hallucination gate. The gate blocks:
 * 1. GHOST TOOLS — calls to tool names not in the registry.
 * 2. SCHEMA MISMATCHES — arguments that fail JSON-schema validation.
 * 3. LOOPS — identical (name + arguments) calls repeated beyond a threshold.
 *
 * Escalates difficulty 10×: mixed batches, malformed JSON,
 * empty args, disabled features, loop window eviction, type coercion
 * edge cases, adversarial argument shapes that should NOT pass.
 */
import { describe, test, expect } from "vitest";
import {
  createToolCallGate,
  resolveToolCallGateConfig,
  DEFAULT_TOOL_CALL_GATE_CONFIG,
  type ToolCall,
  type ToolDefinition,
} from "../../engine/src/safety/tool-call-gate.ts";

function def(name: string, parameters: Record<string, unknown> = {}): ToolDefinition {
  return { type: "function", function: { name, description: "", parameters } };
}

function call(name: string, args: string = "{}", id: string = `call_${name}`): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

const SEARCH_DEF = def("search_code", {
  type: "object",
  properties: { query: { type: "string" }, limit: { type: "integer" } },
  required: ["query"],
});

describe("tool-call-gate — GHOST TOOL detection", () => {
  test("unknown tool name is blocked", () => {
    const gate = createToolCallGate({ getDefinitions: () => [SEARCH_DEF] });
    const result = gate.check([call("nonexistent_tool")]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.toolName).toBe("nonexistent_tool");
    expect(result.clean).toHaveLength(0);
  });

  test("known tool name passes", () => {
    const gate = createToolCallGate({ getDefinitions: () => [SEARCH_DEF] });
    const result = gate.check([call("search_code", '{"query":"foo"}')]);
    expect(result.blocked).toHaveLength(0);
    expect(result.clean).toHaveLength(1);
  });

  test("ghost tool error message lists available tools", () => {
    const gate = createToolCallGate({ getDefinitions: () => [SEARCH_DEF, def("read_file")] });
    const result = gate.check([call("ghost")]);
    expect(result.blocked[0]!.errorMessage).toContain("search_code");
    expect(result.blocked[0]!.errorMessage).toContain("read_file");
  });

  test("ghost detection can be disabled", () => {
    const gate = createToolCallGate({
      getDefinitions: () => [SEARCH_DEF],
      config: resolveToolCallGateConfig({ enableGhostToolDetection: false }),
    });
    const result = gate.check([call("nonexistent")]);
    expect(result.blocked).toHaveLength(0);
  });
});

// ── BREAKER-OFF vs GHOST — the same absence, two opposite truths ───────────
//
// A tool absent from the served definitions can be a genuine hallucination
// (never existed) OR a real tool the user switched off at the breaker. The
// registry-naming callback lets the gate tell them apart: the second gets
// the standing breaker-off refusal — the same register as the auto-trip
// refusal — never "not registered", which would be a lie about the install
// and would teach the model the wrong repair.

describe("tool-call-gate — BREAKER-OFF vs GHOST (registered-but-switched-off)", () => {
  test("a REGISTERED tool absent from the served set is refused as switched off, never as 'not registered'", () => {
    const gate = createToolCallGate({
      getDefinitions: () => [SEARCH_DEF],
      getRegisteredNames: () => ["search_code", "create_artifact"],
    });
    const result = gate.check([call("create_artifact")]);
    expect(result.blocked).toHaveLength(1);
    expect(result.clean).toHaveLength(0);
    const block = result.blocked[0]!;
    expect(block.toolName).toBe("create_artifact");
    expect(block.errorMessage).toContain("is switched off at the breaker");
    expect(block.errorMessage, "a real tool is never lied about").not.toContain("is not registered");
    expect(block.errorMessage).toContain("breaker panel");
    // A standing fact, not a verdict about this call: no escalation and no
    // trip — the same shape as the auto-tripped branch's plain refusals.
    expect(block.escalated).toBeUndefined();
    expect(block.autoTripped).toBeUndefined();
  });

  test("an UNREGISTERED name still gets the honest ghost message (non-vacuity)", () => {
    const gate = createToolCallGate({
      getDefinitions: () => [SEARCH_DEF],
      getRegisteredNames: () => ["search_code", "create_artifact"],
    });
    const result = gate.check([call("cat")]);
    expect(result.blocked[0]!.errorMessage).toContain("is not registered");
    expect(result.blocked[0]!.errorMessage).not.toContain("switched off");
  });

  test("without the registry callback the gate degrades honestly to ghost (the served set is its whole truth)", () => {
    const gate = createToolCallGate({ getDefinitions: () => [SEARCH_DEF] });
    const result = gate.check([call("create_artifact")]);
    expect(result.blocked[0]!.errorMessage).toContain("is not registered");
  });

  test("the breaker-off refusal does NOT arm the block-sequence streak — no escalation, no auto-trip, however many times asked", () => {
    const gate = createToolCallGate({
      getDefinitions: () => [SEARCH_DEF],
      getRegisteredNames: () => ["search_code", "create_artifact"],
      config: { blockEscalationAfter: 2, blockAutoTripAfter: 3 },
    });
    for (let i = 0; i < 5; i += 1) {
      const result = gate.check([call("create_artifact")]);
      expect(result.blocked[0]!.errorMessage).toContain("is switched off at the breaker");
      expect(result.blocked[0]!.escalated).toBeUndefined();
      expect(result.blocked[0]!.autoTripped).toBeUndefined();
    }
    // And the streak never armed: a later GHOST call still escalates from
    // zero, unaffected by the breaker-off refusals.
    const ghost = createToolCallGate({
      getDefinitions: () => [SEARCH_DEF],
      getRegisteredNames: () => ["search_code"],
      config: { blockEscalationAfter: 2 },
    });
    ghost.check([call("cat")]);
    const second = ghost.check([call("cat")]);
    expect(second.blocked[0]!.escalated).toBe(true);
  });

  test("a breaker flip mid-run is reflected on the next check (the registry is read live, like the definitions)", () => {
    let registered: readonly string[] = [];
    const gate = createToolCallGate({
      getDefinitions: () => [SEARCH_DEF],
      getRegisteredNames: () => registered,
    });
    expect(gate.check([call("create_artifact")]).blocked[0]!.errorMessage).toContain("is not registered");
    registered = ["search_code", "create_artifact"];
    expect(gate.check([call("create_artifact")]).blocked[0]!.errorMessage).toContain("is switched off at the breaker");
  });
});

describe("tool-call-gate — SCHEMA validation", () => {
  test("missing required field is blocked", () => {
    const gate = createToolCallGate({ getDefinitions: () => [SEARCH_DEF] });
    const result = gate.check([call("search_code", '{"limit":5}')]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.errorMessage).toContain("missing required field 'query'");
  });

  test("wrong type is blocked (string vs integer)", () => {
    const gate = createToolCallGate({ getDefinitions: () => [SEARCH_DEF] });
    const result = gate.check([call("search_code", '{"query":"foo","limit":"not-a-number"}')]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.errorMessage).toContain("must be of type");
  });

  test("valid arguments pass", () => {
    const gate = createToolCallGate({ getDefinitions: () => [SEARCH_DEF] });
    const result = gate.check([call("search_code", '{"query":"foo","limit":5}')]);
    expect(result.clean).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
  });

  test("malformed JSON arguments are blocked", () => {
    const gate = createToolCallGate({ getDefinitions: () => [SEARCH_DEF] });
    const result = gate.check([call("search_code", "not json{")]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.errorMessage).toContain("not valid JSON");
  });

  test("empty arguments default to {} (valid when no required fields)", () => {
    const noRequired = def("no_args", { type: "object", properties: {} });
    const gate = createToolCallGate({ getDefinitions: () => [noRequired] });
    const result = gate.check([call("no_args", "")]);
    expect(result.clean).toHaveLength(1);
  });

  test("arguments that are not a JSON object are blocked", () => {
    const gate = createToolCallGate({ getDefinitions: () => [SEARCH_DEF] });
    const result = gate.check([call("search_code", "[1,2,3]")]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.errorMessage).toContain("must be a JSON object");
  });

  test("boolean field rejects a string", () => {
    const flagDef = def("set_flag", { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] });
    const gate = createToolCallGate({ getDefinitions: () => [flagDef] });
    const result = gate.check([call("set_flag", '{"enabled":"yes"}')]);
    expect(result.blocked).toHaveLength(1);
  });

  test("schema validation can be disabled", () => {
    const gate = createToolCallGate({
      getDefinitions: () => [SEARCH_DEF],
      config: resolveToolCallGateConfig({ enableSchemaValidation: false }),
    });
    const result = gate.check([call("search_code", '{"limit":5}')]);
    // Missing required field passes when validation is off.
    expect(result.clean).toHaveLength(1);
  });

  test("tool with no parameters schema skips validation", () => {
    const noSchema = def("freeform");
    const gate = createToolCallGate({ getDefinitions: () => [noSchema] });
    const result = gate.check([call("freeform", '{"anything":true}')]);
    expect(result.clean).toHaveLength(1);
  });
});

describe("tool-call-gate — LOOP detection", () => {
  test("repeated identical calls beyond threshold are blocked", () => {
    const gate = createToolCallGate({
      getDefinitions: () => [SEARCH_DEF],
      config: resolveToolCallGateConfig({ maxRepeatCount: 3, loopWindow: 16 }),
    });
    const args = '{"query":"same"}';
    // First 3 calls pass (priorCount 0,1,2 < 3). The 4th has priorCount 3 >= 3 → blocked.
    for (let i = 0; i < 3; i++) {
      const r = gate.check([call("search_code", args, `c${i}`)]);
      expect(r.clean).toHaveLength(1);
    }
    const r4 = gate.check([call("search_code", args, "c3")]);
    expect(r4.blocked).toHaveLength(1);
    expect(r4.blocked[0]!.errorMessage).toContain("loop");
  });

  test("different arguments do NOT trigger loop detection", () => {
    const gate = createToolCallGate({
      getDefinitions: () => [SEARCH_DEF],
      config: resolveToolCallGateConfig({ maxRepeatCount: 2, loopWindow: 16 }),
    });
    for (let i = 0; i < 10; i++) {
      const r = gate.check([call("search_code", `{"query":"q${i}"}`, `c${i}`)]);
      expect(r.clean).toHaveLength(1);
    }
  });

  test("loop window evicts old entries (bounded memory)", () => {
    const gate = createToolCallGate({
      getDefinitions: () => [SEARCH_DEF],
      config: resolveToolCallGateConfig({ maxRepeatCount: 2, loopWindow: 4 }),
    });
    const args = '{"query":"same"}';
    // Fill the window with the same call (2 pass, then blocked).
    gate.check([call("search_code", args, "a")]);
    gate.check([call("search_code", args, "b")]);
    // Push OTHER calls to evict the loop entries from the window.
    for (let i = 0; i < 4; i++) {
      gate.check([call("search_code", `{"query":"other${i}"}`, `o${i}`)]);
    }
    // Now the same call should pass again (window evicted the old entries).
    const r = gate.check([call("search_code", args, "after")]);
    expect(r.clean).toHaveLength(1);
  });

  test("loop detection can be disabled", () => {
    const gate = createToolCallGate({
      getDefinitions: () => [SEARCH_DEF],
      config: resolveToolCallGateConfig({ enableLoopDetection: false }),
    });
    const args = '{"query":"same"}';
    for (let i = 0; i < 100; i++) {
      const r = gate.check([call("search_code", args, `c${i}`)]);
      expect(r.clean).toHaveLength(1);
    }
  });
});

describe("tool-call-gate — mixed batches + edge cases", () => {
  test("mixed batch: clean + ghost + schema-error → only clean passes", () => {
    const gate = createToolCallGate({ getDefinitions: () => [SEARCH_DEF] });
    const result = gate.check([
      call("search_code", '{"query":"valid"}', "ok1"),
      call("ghost_tool", "{}", "bad1"),
      call("search_code", '{"limit":5}', "bad2"), // missing required
    ]);
    expect(result.clean).toHaveLength(1);
    expect(result.clean[0]!.id).toBe("ok1");
    expect(result.blocked).toHaveLength(2);
  });

  test("empty batch returns empty result", () => {
    const gate = createToolCallGate({ getDefinitions: () => [SEARCH_DEF] });
    const result = gate.check([]);
    expect(result.clean).toHaveLength(0);
    expect(result.blocked).toHaveLength(0);
  });

  test("getDefinitions is called fresh on every check (live registry)", () => {
    let defs: ToolDefinition[] = [SEARCH_DEF];
    const gate = createToolCallGate({ getDefinitions: () => defs });
    // Initially "new_tool" is a ghost.
    expect(gate.check([call("new_tool")]).blocked).toHaveLength(1);
    // Register it → now it passes.
    defs = [...defs, def("new_tool")];
    expect(gate.check([call("new_tool")]).clean).toHaveLength(1);
  });

  test("default config has all three features enabled", () => {
    expect(DEFAULT_TOOL_CALL_GATE_CONFIG.enableGhostToolDetection).toBe(true);
    expect(DEFAULT_TOOL_CALL_GATE_CONFIG.enableSchemaValidation).toBe(true);
    expect(DEFAULT_TOOL_CALL_GATE_CONFIG.enableLoopDetection).toBe(true);
  });
});
