// @vitest-environment node
/**
 * Hallucination/Safety Gate Owner prevention test.
 *
 * Verifies the Single-Party-Owner principle for the hallucination/safety
 * gate. The safety gate must have ONE owner module
 * (`server/safety-bridge.ts`), and ALL safety checks go through it — no
 * ad-hoc checks scattered in the run route or executor.
 *
 * Dynamic discovery: file lists are NEVER hardcoded. The test
 * walks `server/` via `readdirSync` to find violations — if a new route or
 * bridge is added that does an ad-hoc safety check, the test catches it
 * automatically (deny-by-default: a file NOT checked is a file missed).
 *
 * Assurance classes:
 * A. Single owner — `ghostToolSuggestion` + `GHOST_TOOL_SUGGESTIONS`
 * defined in exactly ONE file (safety-bridge.ts).
 * B. No scattered checks — no ad-hoc ghost/schema/loop checks outside the
 * safety-bridge + the executor's gate call + the route's gateBlock read.
 * C. Gate runs before dispatch — `executeToolCall` calls `gate.check`
 * BEFORE the handler dispatch (source-scan: the gate check precedes
 * the `TOOL_HANDLERS` lookup).
 * D. Route passes the gate — the run route creates the gate via
 * `createRunSafetyGate` + passes it via `ctx.gate` (no bypass).
 * E. Config owner — `getSafetyGateConfig` is the single accessor in
 * harness-config.ts; no inline config reads for the gate.
 * F. Status exposed — the route emits a "hallucination" SSE event when
 * `gateBlock` is present.
 * G. Behavioral — the gate blocks ghost tools, schema mismatches, and
 * loops when wired through the executor.
 */
import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { read as readSrc } from "../helpers/source-scan.ts";
import { executeToolCall, type ToolExecutionContext, type ToolCallResult } from "../../server/tools/tool-executor.ts";
import { createRunSafetyGate, ghostToolSuggestion, gateBlockKind } from "../../server/safety/safety-bridge.ts";
import { GATE_BLOCK_EVENT_KIND, gateBlockEventKind, type GateBlockKind } from "../../shared/event-types.ts";
import { getToolManifest } from "../../server/tools/tools-bridge.ts";
// The run path is FIVE modules since the executor was split out of the GET
// handler that used to be it. This guard asks about the run path, not about
// whichever file happened to hold the answer when it was written.
import { runPathSource } from "../helpers/run-source.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
// ── Dynamic file discovery ──

const SERVER_DIR = "server";
const SERVER_TS_FILES: string[] = [];
function walkDir(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, out);
    else if (extname(entry.name) === ".ts") out.push(full);
  }
}
walkDir(SERVER_DIR, SERVER_TS_FILES);

function readServer(path: string): string {
  return readFileSync(path, "utf8");
}

// ── A. Single owner ──

describe("A. Single owner: ghostToolSuggestion + GHOST_TOOL_SUGGESTIONS", () => {
  test("ghostToolSuggestion is defined in exactly ONE server file (safety-bridge.ts)", () => {
    const defSites = SERVER_TS_FILES.filter((f) => {
      if (f === modulePath("safety-bridge.ts")) return false; // the owner — expected
      const src = readServer(f);
      // Look for a FUNCTION DEFINITION (export function ghostToolSuggestion),
      // not just a call or import. `function ghostToolSuggestion` at the top
      // level is a definition.
      return /export\s+function\s+ghostToolSuggestion\s*\(/.test(src);
    });
    expect(defSites, `ghostToolSuggestion defined outside the owner: ${defSites.join(", ")}`).toEqual([]);
  });

  test("GHOST_TOOL_SUGGESTIONS is defined in exactly ONE server file (safety-bridge.ts)", () => {
    const defSites = SERVER_TS_FILES.filter((f) => {
      if (f === modulePath("safety-bridge.ts")) return false;
      const src = readServer(f);
      // Look for a CONST DEFINITION (const GHOST_TOOL_SUGGESTIONS), not
      // just a reference. The `\b` word boundary handles a type annotation
      // between the name and the `=` (e.g. `: Readonly<...> =`).
      return /(?:const|let|var)\s+GHOST_TOOL_SUGGESTIONS\b/.test(src);
    });
    expect(defSites, `GHOST_TOOL_SUGGESTIONS defined outside the owner: ${defSites.join(", ")}`).toEqual([]);
  });

  test("safety-bridge.ts IS the owner (defines both)", () => {
    const src = readServer(modulePath("safety-bridge.ts"));
    expect(src).toMatch(/export\s+function\s+ghostToolSuggestion\s*\(/);
    expect(src).toMatch(/(?:const|let|var)\s+GHOST_TOOL_SUGGESTIONS\b/);
  });
});

// ── B. No scattered checks ──

describe("B. No ad-hoc safety checks outside the owner", () => {
  test("no server file (except safety-bridge + tool-executor) defines a local ghost-tool suggestion map", () => {
    // A "local suggestion map" is a const/let/var with a name like
    // GHOST_TOOL_SUGGESTIONS or ghostSuggestions that maps tool names →
    // real tool hints. Only safety-bridge.ts should have this.
    const violators = SERVER_TS_FILES.filter((f) => {
      if (f === modulePath("safety-bridge.ts")) return false;
      const src = readServer(f);
      // Look for any const/let/var that looks like a ghost-tool suggestion map.
      return /(?:const|let|var)\s+\w*(GHOST|ghost)\w*(SUGGESTION|suggestion|Hint|hint)\w*\s*[:=]/.test(src);
    });
    expect(violators, `ad-hoc ghost suggestion map found in: ${violators.join(", ")}`).toEqual([]);
  });

  test("the run route does NOT call ghostToolSuggestion directly (the gate owns the check)", () => {
    const src = runPathSource();
    // The route should READ toolResult.gateBlock, NOT call ghostToolSuggestion
    // directly (the gate is the single owner of the check — SPO).
    expect(src).not.toMatch(/\bghostToolSuggestion\s*\(/);
    // It SHOULD read gateBlock (the gate's result).
    expect(src).toContain("gateBlock");
  });

  test("the run route does NOT define a local safety gate factory", () => {
    const src = runPathSource();
    // The route creates the gate via `createRunSafetyGate` (from the owner),
    // NOT via a local `createToolCallGate` call.
    expect(src).not.toMatch(/\bcreateToolCallGate\s*\(/);
    expect(src).toContain("createRunSafetyGate");
  });
});

// ── C. Gate runs before dispatch ──

describe("C. Gate runs BEFORE dispatch (choke point)", () => {
  test("executeToolCall checks the gate BEFORE the TOOL_HANDLERS lookup", () => {
    const src = readServer(modulePath("tool-executor.ts"));
    const gateCheckIdx = src.indexOf("ctx.gate");
    const handlersIdx = src.indexOf("TOOL_HANDLERS[toolName]");
    expect(gateCheckIdx, "ctx.gate not found in tool-executor.ts").toBeGreaterThan(0);
    expect(handlersIdx, "TOOL_HANDLERS[toolName] not found in tool-executor.ts").toBeGreaterThan(0);
    expect(gateCheckIdx, "the gate check must come BEFORE the handler dispatch").toBeLessThan(handlersIdx);
  });

  test("executeToolCall passes the gate result's gateBlock through", () => {
    const src = readServer(modulePath("tool-executor.ts"));
    expect(src).toContain("gateBlock");
    expect(src).toContain("gateBlockKind(blocked)");
  });

  test("createRunSafetyGate names the FULL registry — a manifest tool the enabled set omits is refused as switched off, never as a ghost (UIE-030)", () => {
    // Behavioural, through the real factory: the enabled entries omit a
    // tool the FULL manifest registers (exactly the breaker-off state), and
    // the gate must state the standing fact — while a name no manifest entry
    // carries stays an honest ghost.
    const full = getToolManifest();
    expect(full.length, "the install's manifest must name at least one tool").toBeGreaterThan(0);
    const victim = full[0]!.name;
    const enabled = full.filter((e) => e.name !== victim);
    expect(enabled.some((e) => e.name === victim)).toBe(false);
    const gate = createRunSafetyGate(() => enabled);
    const off = gate.check([
      { id: "call-off", type: "function", function: { name: victim, arguments: "{}" } },
    ]);
    expect(off.clean).toHaveLength(0);
    expect(off.blocked[0]!.errorMessage, "a registered tool is never lied about").toContain("is switched off at the breaker");
    expect(off.blocked[0]!.errorMessage).not.toContain("is not registered");
    const ghost = gate.check([
      { id: "call-ghost", type: "function", function: { name: "cat", arguments: "{}" } },
    ]);
    expect(ghost.blocked[0]!.errorMessage).toContain("is not registered");
  });
});

// ── D. Route passes the gate ──

describe("D. Route passes the gate via ctx (no bypass)", () => {
  test("run.ts creates the gate via createRunSafetyGate + passes it via ctx.gate", () => {
    const src = runPathSource();
    expect(src).toContain("createRunSafetyGate");
    expect(src).toContain("active.safetyGate");
    expect(src).toMatch(/gate:\s*active\.safetyGate/);
    expect(src).toMatch(/callId:\s*event\.callId/);
  });

  test("the ActiveRun type carries a safetyGate field", () => {
    const src = runPathSource();
    expect(src).toContain("safetyGate");
  });
});

// ── E. Config owner ──

describe("E. Config owner (getSafetyGateConfig)", () => {
  test("getSafetyGateConfig is defined in harness-config.ts (the config owner)", () => {
    const src = readServer(modulePath("harness-config.ts"));
    expect(src).toMatch(/export\s+function\s+getSafetyGateConfig\s*\(/);
  });

  test("no other server file defines getSafetyGateConfig", () => {
    const defSites = SERVER_TS_FILES.filter((f) => {
      if (f === modulePath("harness-config.ts")) return false;
      const src = readServer(f);
      return /export\s+function\s+getSafetyGateConfig\s*\(/.test(src);
    });
    expect(defSites, `getSafetyGateConfig defined outside the config owner: ${defSites.join(", ")}`).toEqual([]);
  });

  test("the safety bridge reads config through getSafetyGateConfig (not inline)", () => {
    const src = readServer(modulePath("safety-bridge.ts"));
    expect(src).toContain("getSafetyGateConfig");
  });
});

// ── F. Status exposed (SSE) ──

describe("F. Gate status exposed as SSE signal", () => {
  test("run.ts emits a hallucination SSE event when gateBlock is present", () => {
    const src = runPathSource();
    expect(src).toContain("SSE_EVENT_TYPES.hallucination");
    expect(src).toContain("toolResult.gateBlock");
  });

  test("the hallucination event carries kind + toolName + suggestion", () => {
    const src = runPathSource();
    // The event payload includes the gateBlock fields.
    expect(src).toContain("gb.kind");
    expect(src).toContain("gb.toolName");
    expect(src).toContain("gb.suggestion");
  });

  test("a block that TRIPPED the breaker says so on the frame (UIE-036)", () => {
    // The trip flips the breaker row server-side mid-run; the client's only
    // way to know the panel's cached rows went stale is the frame saying so.
    // Without the flag, the trip stays invisible until an unrelated event
    // re-reads the rows. The client's flag→`tools:changed` wire is measured
    // behaviorally in tests/unit/client.test.ts; this pins the wire's OTHER
    // half — the frame carries the fact.
    const src = runPathSource();
    expect(
      src,
      "the hallucination frame must carry autoTripped when the block tripped the tool",
    ).toMatch(/gb\.autoTripped === true \? \{ autoTripped: true \}/);
  });

  test("the inline-event label is DERIVED from the gate-block kind (never a hardcoded \"hallucination\")", () => {
    const src = runPathSource();
    // The route must map the block's kind to its label through the single
    // owner's map — both the live SSE path and the persistence path consume
    // the derived kind, so the two surfaces cannot disagree.
    expect(src, "the route derives the label via gateBlockEventKind(gb.kind)").toContain("gateBlockEventKind(gb.kind)");
    expect(src, "the derived label feeds the persisted inline event").toMatch(/persistInlineEvent\([^)]*eventKind/);
    // Deny-by-default: the route must NOT persist a hardcoded "hallucination"
    // label for every block (the defect — a schema mismatch was labeled a
    // hallucination).
    expect(src, "no hardcoded \"hallucination\" persist label in the route").not.toMatch(
      /persistInlineEvent\([^)]*"hallucination"/,
    );
  });

  test("the client SSE listener labels the event from the block's kind (the inert shape reds)", () => {
    // The client's "hallucination" SSE handler must feed the block's kind
    // through the shared owner's map and pass the DERIVED label to
    // appendEventMessage. The inert shape — the call present but its result
    // discarded in favour of a hardcoded "hallucination" — is the exact
    // defect (a schema mismatch rendered as HALLUCINATION), and it must red.
    const client = readSrc(modulePathMatching("src/client.ts"));
    expect(client, "the client maps the block's kind via gateBlockEventKind").toMatch(
      /appendEventMessage\(\s*gateBlockEventKind\(/,
    );
    expect(client, "the client does NOT hardcode the hallucination label on the gate event").not.toMatch(
      /appendEventMessage\(\s*"hallucination"/,
    );
  });
});

// ── G. Behavioral — the gate blocks through the executor ──

describe("G. Behavioral: gate blocks ghost/schema/loop via executor", () => {
  // Use the real tool manifest so the gate sees the actual registered tools.
  const getEntries = (): readonly ReturnType<typeof getToolManifest>[number][] => getToolManifest();

  test("ghost tool is blocked by the gate through executeToolCall", async () => {
    const gate = createRunSafetyGate(getEntries);
    const ctx: ToolExecutionContext = {
      projectRoot: "/test",
      gate,
      callId: "call_ghost",
    };
    const result: ToolCallResult = await executeToolCall("grep", { pattern: "foo" }, ctx);
    expect(result.success).toBe(false);
    expect(result.gateBlock).toBeDefined();
    expect(result.gateBlock!.kind).toBe("ghost_tool");
    expect(result.gateBlock!.toolName).toBe("grep");
    expect(result.gateBlock!.callId).toBe("call_ghost");
    // The suggestion should point to the real tool.
    expect(result.gateBlock!.suggestion).toBe("search_code");
    // The output should mention the tool is not registered + the hint.
    expect(result.output).toContain("not registered");
    expect(result.output).toContain("search_code");
  });

  test("schema mismatch is blocked by the gate through executeToolCall", async () => {
    const gate = createRunSafetyGate(getEntries);
    const ctx: ToolExecutionContext = {
      projectRoot: "/test",
      gate,
      callId: "call_schema",
    };
    // read_file requires a "path" field; omit it to trigger a schema error.
    const result: ToolCallResult = await executeToolCall("read_file", {}, ctx);
    expect(result.success).toBe(false);
    expect(result.gateBlock).toBeDefined();
    expect(result.gateBlock!.kind).toBe("schema_mismatch");
    expect(result.gateBlock!.toolName).toBe("read_file");
    // Schema mismatches have no suggestion (null).
    expect(result.gateBlock!.suggestion).toBeNull();
    expect(result.output).toContain("schema validation");
  });

  test("create_artifact's manifest enum reaches the gate verbatim through the bridge (out-of-enum value → schema_mismatch with the field, the allowed values, and the kept-fields clause)", async () => {
    // The enum-preservation pin. The manifest entry's `type` property
    // declares `enum: ARTIFACT_TYPES`, and the claim under test is that the
    // schema reaches the gate's vocabulary VERBATIM through the real bridge
    // transformation (manifestEntriesToToolDefinitions →
    // ToolDefinition.parameters → the gate's enum check) — the wiring
    // createRunSafetyGate itself uses. A future "normalizing" refactor that
    // strips enums in the bridge, or a gate that loses the enum check,
    // silently drops the call to the executor's flat refusal (the original
    // incident class) — no gateBlock, no field-level repair — and this arm
    // reds because the block is gone.
    const gate = createRunSafetyGate(getEntries);
    const ctx: ToolExecutionContext = {
      projectRoot: "/test",
      gate,
      callId: "call_enum",
    };
    // `type: "movie"` is a string (the TYPE matches) but outside the
    // declared enum — a VALUE failure only the gate's enum check catches
    // pre-dispatch; title and content are valid so they are the kept fields.
    const result: ToolCallResult = await executeToolCall(
      "create_artifact",
      { type: "movie", title: "t", content: "<p>x</p>" },
      ctx,
    );
    expect(result.gateBlock, "the out-of-enum call must be blocked by the GATE, not passed to the executor's flat refusal").toBeDefined();
    expect(result.gateBlock!.kind).toBe("schema_mismatch");
    expect(result.gateBlock!.failedFields).toEqual(["type"]);
    // The gate's enum vocabulary: the allowed values are listed and the sent
    // value is quoted (checkValueConstraint's enum branch).
    expect(result.output).toMatch(/field 'type' must be one of: html, game, sheet, presentation, got "movie"/);
    // buildRepairGuidance's pure-value-failure branch: only the corrected
    // field is asked for, and the kept fields are named so the model does
    // not re-send the artifact.
    expect(result.output).toMatch(/Send only 'type' with a corrected value/);
    expect(result.output).toMatch(
      /the harness kept the valid fields you already sent \('title', 'content'\) and merges your next attempt in, so do not re-send those/,
    );
  });

  test("loop is blocked by the gate after exceeding the repeat threshold", async () => {
    // Use a gate with a low loop threshold so the test is fast.
    const gate = createRunSafetyGate(getEntries);
    const ctx: ToolExecutionContext = {
      projectRoot: "/test",
      gate,
      callId: "call_loop",
    };
    // Call the SAME tool with the SAME arguments repeatedly. The canonical
    // gate's default maxRepeatCount is 5, so the 6th identical call is blocked.
    // Use a tool that exists + valid args so it passes ghost + schema checks.
    let lastResult: ToolCallResult | undefined;
    for (let i = 0; i < 7; i++) {
      lastResult = await executeToolCall("list_files", { path: "." }, ctx);
      if (lastResult.gateBlock !== undefined) break;
    }
    expect(lastResult, "expected a loop block after repeated calls").toBeDefined();
    expect(lastResult!.gateBlock).toBeDefined();
    expect(lastResult!.gateBlock!.kind).toBe("loop");
    expect(lastResult!.gateBlock!.toolName).toBe("list_files");
    expect(lastResult!.output).toContain("loop");
  });

  test("a valid tool call with valid args passes the gate (no gateBlock)", async () => {
    const gate = createRunSafetyGate(getEntries);
    const ctx: ToolExecutionContext = {
      projectRoot: "/test",
      gate,
      callId: "call_ok",
    };
    // list_files with a path arg — the gate should let it through. The
    // tool itself may fail (directory doesn't exist) but the GATE should not
    // block it (no gateBlock).
    const result: ToolCallResult = await executeToolCall("list_files", { path: "." }, ctx);
    expect(result.gateBlock).toBeUndefined();
  });

  test("without a gate, the executor falls back to the inline ghost check", async () => {
    // No gate in ctx — the executor should still catch ghost tools (the
    // fallback path for non-LLM callers like tests).
    const ctx: ToolExecutionContext = { projectRoot: "/test" };
    const result: ToolCallResult = await executeToolCall("grep", { pattern: "foo" }, ctx);
    expect(result.success).toBe(false);
    expect(result.gateBlock).toBeUndefined(); // no gate → no gateBlock
    expect(result.output).toContain("does not exist");
    expect(result.output).toContain("search_code");
  });

  test("gateBlockKind maps each TYPED block reason — never the message text (prompt-registry F-PR-12)", () => {
    expect(gateBlockKind({ reason: "ghost" })).toBe("ghost_tool");
    expect(gateBlockKind({ reason: "schema" })).toBe("schema_mismatch");
    expect(gateBlockKind({ reason: "payload" })).toBe("schema_mismatch");
    expect(gateBlockKind({ reason: "loop" })).toBe("loop");
    // Both STANDING disabled refusals — the auto-trip and the user's own
    // breaker state — are the same kind: a fact about the tool, not a
    // verdict about this call, and never a "hallucination". A block that
    // just TRIPPED the tool is disabled whatever verdict tripped it.
    expect(gateBlockKind({ reason: "auto-tripped", autoTripped: true })).toBe("tool_disabled");
    expect(gateBlockKind({ reason: "breaker-off" })).toBe("tool_disabled");
    expect(gateBlockKind({ reason: "schema", autoTripped: true })).toBe("tool_disabled");
    expect(gateBlockEventKind("tool_disabled")).toBe("disabled");
  });

  test("the REAL run gate's blocks carry their typed reason, and the kind never reads the wording", () => {
    const full = getToolManifest();
    const off = full[0]!.name;
    const gate = createRunSafetyGate(() => full.filter((entry) => entry.name !== off));
    const call = (name: string) => ({ id: `c-${name}`, type: "function" as const, function: { name, arguments: "{}" } });
    const blocks = [call("cat"), call(off)].map((toolCall) => gate.check([toolCall]).blocked[0]!);
    expect(blocks.map((blocked) => blocked.reason)).toEqual(["ghost", "breaker-off"]);
    expect(blocks.map((blocked) => gateBlockKind(blocked))).toEqual(["ghost_tool", "tool_disabled"]);
    const reworded = blocks.map((blocked) => ({ ...blocked, errorMessage: "any other wording" })).map((blocked) => gateBlockKind(blocked));
    expect(reworded, "rewording a notice cannot move its kind").toEqual(["ghost_tool", "tool_disabled"]);
  });

  test("every gate-block kind maps to an HONEST label (schema→validation, not hallucination)", () => {
    // Derive the kinds from the single owner's map (not a hardcoded list), so
    // a new kind added to the map is automatically asserted here. The one
    // load-bearing claim: a schema-validation failure is NOT a hallucination.
    const kinds = Object.keys(GATE_BLOCK_EVENT_KIND) as readonly GateBlockKind[];
    expect(kinds.length, "the gate-block map covers every kind the gate produces").toBeGreaterThanOrEqual(3);
    // The specific honest labels (the reported defect).
    expect(gateBlockEventKind("schema_mismatch"), "a schema-validation block is a validation, NOT a hallucination").toBe("validation");
    expect(gateBlockEventKind("ghost_tool"), "a ghost-tool block IS a hallucination").toBe("hallucination");
    expect(gateBlockEventKind("loop"), "a loop block is labeled a loop").toBe("loop");
    // No two DISTINCT gate kinds collapse to a wrong shared label: the map is
    // total over the declared kinds (every key maps to a non-empty label).
    for (const k of kinds) {
      expect(typeof GATE_BLOCK_EVENT_KIND[k], `kind "${k}" must map to a label`).toBe("string");
    }
  });

  test("gateBlockEventKind denies an unknown kind (deny-by-default)", () => {
    // A kind the map does not recognise is a wiring bug — it must throw, not
    // silently label the block a "hallucination".
    expect(() => gateBlockEventKind("not_a_real_kind" as GateBlockKind)).toThrow(/unknown gate-block kind/);
  });

  test("a real schema-mismatch block carries the kind that maps to the validation label", async () => {
    // Behavioural end-to-end: drive a REAL schema block through the executor
    // and assert its kind maps to the "validation" label — the exact surface
    // the user saw mislabeled as a hallucination.
    const gate = createRunSafetyGate(getEntries);
    const ctx: ToolExecutionContext = {
      projectRoot: "/test",
      gate,
      callId: "call_label_schema",
    };
    const result: ToolCallResult = await executeToolCall("read_file", {}, ctx);
    expect(result.gateBlock, "the schema block must be present").toBeDefined();
    expect(gateBlockEventKind(result.gateBlock!.kind)).toBe("validation");
  });

  test("ghostToolSuggestion returns the real tool for common CLI hallucinations", () => {
    expect(ghostToolSuggestion("grep")?.realTool).toBe("search_code");
    expect(ghostToolSuggestion("cat")?.realTool).toBe("read_file");
    expect(ghostToolSuggestion("ls")?.realTool).toBe("list_files");
    // A real tool returns null (not a ghost).
    expect(ghostToolSuggestion("read_file")).toBeNull();
    expect(ghostToolSuggestion("list_files")).toBeNull();
  });
});

// ── H. Mutation verification ──

describe("H. Mutation verification (key assertions FAIL on reintroduced violations)", () => {
  test("removing the gate check from executeToolCall makes the ghost-block test fail", () => {
    // Verify the source actually has the gate check. If someone removes
    // `ctx.gate` from executeToolCall, this assertion fails.
    const src = readServer(modulePath("tool-executor.ts"));
    expect(src).toContain("ctx.gate !== undefined");
    expect(src).toContain("gate.check([toolCall])");
  });

  test("re-introducing ghostToolSuggestion in run.ts makes the no-scatter test fail", () => {
    // If someone re-adds a direct ghostToolSuggestion call in the route,
    // test B above catches it. This test pins the assertion.
    const src = runPathSource();
    expect(src).not.toMatch(/\bghostToolSuggestion\s*\(/);
  });
});
