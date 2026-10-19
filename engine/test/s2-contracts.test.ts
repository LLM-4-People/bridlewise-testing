import assert from "node:assert/strict";
import { TEST_TRANSPORT } from "./support/mock-provider.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { negotiateCapabilities } from "../src/runtime/capability-negotiation.ts";
import {
  CAPABILITY_OFFER_SCHEMA,
  CAPABILITY_REQUIREMENT_SCHEMA,
  CONTRACT_BUNDLE_HASH,
  GENERATED_CONTRACT_SCHEMAS,
  MODEL_REQUEST_SCHEMA,
  TOOL_CONTRACT_SCHEMA,
  type CapabilityOffer,
  type CapabilityRequirement,
  type ContractSettings,
  type ModelEvent,
  type ToolContract,
} from "../src/kernel/contracts.ts";
import { ChatCompletionEventState, ResponsesEventState } from "../src/runtime/event-state.ts";
import { HarnessError } from "../src/kernel/errors.ts";
import {
  bindHarnessControl,
  importMcpToolResult,
  importMcpToolsList,
  McpJsonRpcError,
  projectMcpTool,
  projectMcpToolResult,
  projectOpenAIChat,
  projectOpenAIResponses,
} from "../src/kernel/protocol-projections.ts";
import { SCHEMA_KEYWORD_MATRIX, validateToolSchemaSubset } from "../src/kernel/schema-subset.ts";
import { buildConfigContract } from "../src/kernel/config-contracts.ts";
import { ROOT_POLICY } from "../src/kernel/root-policy.ts";
import {
  RESPONSES_REQUEST_OPTIONS_SCHEMA, RESPONSES_REQUEST_SCHEMA, parseResponseResource,
  projectResponse, toolsToResponses, type ResponseItem,
} from "../src/shared/llm/responses.ts";
import { ResponseStreamState } from "../src/shared/llm/responses-stream.ts";
import { TEST_FAILURE_OPTIONS } from "./support/mock-provider.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

test("S2 native policy error projection preserves the central stop code", () => {
  const state = new ResponsesEventState(SETTINGS, TEST_TRANSPORT);
  const result = state.consumeEvent({ type: "error", sequence_number: 0, error: { code: "misalignment_policy_violation", message: "PRIVATE-policy-message", param: null } });
  const event = result.events.find(event => event.type === "error"); assert.ok(event?.type === "error");
  assert.equal(event.error.code, "llm_misalignment_policy_violation"); assert.equal(event.error.retryable, false);
  assert.equal(event.error.message.includes("PRIVATE-policy-message"), false);
});
// a2-design M6: the provider's error text is bounded by THE configured
// `runtime.responses.maximumErrorMessageCharacters` (the live client's cap),
// never by the contract's own text limit (1 MiB: a second, 1000x larger owner).
test("S2 provider error text is capped by the configured runtime.responses cap, not the contract text limit", () => {
  const code = "c".repeat(200);
  for (const cap of [16, 64]) {
    const state = new ResponsesEventState(SETTINGS, { maximumErrorMessageCharacters: cap });
    const result = state.consumeEvent({ type: "error", sequence_number: 0, error: { code, message: "m", param: null } });
    const projected = JSON.stringify(result.events.find(event => event.type === "error"));
    assert.ok(projected.includes("c".repeat(cap)), `the provider code survives up to the cap (${cap})`);
    assert.equal(projected.includes("c".repeat(cap + 1)), false, `nothing past the cap (${cap})`);
  }
});
const FIXTURES = join(ROOT, "test", "fixtures", "s2");
// This suite exercises wire contracts, not repository bootstrap containment.
const RUNTIME_SCHEMA = buildConfigContract(ROOT_POLICY).runtimeSchema;
const SETTINGS: ContractSettings = RUNTIME_SCHEMA.parse(
  JSON.parse(readFileSync(join(ROOT, "bridlewise.config.json"), "utf8")),
).contracts;
const FORBIDDEN_MODEL_KEYS = new Set(["approval", "control", "effect", "idempotency", "pathScope", "retry"]);

test("S2-B01 canonical schemas and harness tool controls stay separated", () => {
  const baseUrl = RUNTIME_SCHEMA.shape.runtime.unwrap().shape.providers.element.shape.baseUrl;
  for (const suffix of ["?", "#", "?#", "#?"]) assert.equal(baseUrl.safeParse(`https://provider.test/v1${suffix}`).success, false);
  assert.equal(baseUrl.safeParse("https://provider.test/v1%3Fpart%23part").success, true);
  assert.match(CONTRACT_BUNDLE_HASH, /^[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(GENERATED_CONTRACT_SCHEMAS));
  assert.equal(Object.keys(GENERATED_CONTRACT_SCHEMAS).length, 11);
  for (const schema of Object.values(GENERATED_CONTRACT_SCHEMAS)) {
    assert.equal((schema as Record<string, unknown>).$schema, SETTINGS.schemaDialect);
  }
  assert.deepEqual(
    [...allObjectKeys(GENERATED_CONTRACT_SCHEMAS.tool)].filter((key) => FORBIDDEN_MODEL_KEYS.has(key)),
    [],
  );
  for (const fixture of fixtureDocuments("b01-tool-boundary")) {
    const protocol = stringField(fixture, "protocol");
    const tool = TOOL_CONTRACT_SCHEMA.parse(fixture.tool);
    assert.equal(validateToolSchemaSubset(tool.model.inputSchema, SETTINGS).ok, true);
    if (tool.model.outputSchema !== undefined) {
      assert.equal(validateToolSchemaSubset(tool.model.outputSchema, SETTINGS).ok, true);
    }
    const wireTool = protocol === "mcp-2025-11-25"
      ? projectMcpTool(tool, SETTINGS)
      : projectedOpenAITool(protocol, tool);
    assert.deepEqual(wireTool, fixture.wire);
    assert.deepEqual([...allObjectKeys(wireTool)].filter((key) => FORBIDDEN_MODEL_KEYS.has(key)), []);
  }
  const unsupported = [
    {
      type: "object",
      properties: { value: { $ref: "#/$defs/value" } },
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { value: { type: "string", minLength: 2, maxLength: 1 } },
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { value: { type: "string", pattern: "[" } },
      additionalProperties: false,
    },
  ];
  for (const schema of unsupported) assert.equal(validateToolSchemaSubset(schema, SETTINGS).ok, false);
  const inconsistent = TOOL_CONTRACT_SCHEMA.parse({
    model: {
      name: "unsafe_retry",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    control: {
      effect: "write",
      approval: "always",
      pathScope: ["src"],
      idempotency: "none",
      retry: "idempotent-only",
    },
  });
  assert.throws(
    () => projectMcpTool(inconsistent, SETTINGS),
    (error) => errorCode(error) === "tool_contract_inconsistent",
  );
});

test("S2-B02 capability negotiation reports provider variation and losses", () => {
  for (const fixture of fixtureDocuments("b02-capabilities")) {
    const wire = objectField(fixture, "wire");
    const protocol = stringField(fixture, "protocol");
    const request = MODEL_REQUEST_SCHEMA.parse(fixture.request);
    const projection = protocol === "openai-responses"
      ? projectOpenAIResponses(request, SETTINGS)
      : projectOpenAIChat(request, SETTINGS);
    assert.deepEqual(projection, wire);
    assert.deepEqual([...allObjectKeys(projection.body)].filter((key) => FORBIDDEN_MODEL_KEYS.has(key)), []);
    const requirement = CAPABILITY_REQUIREMENT_SCHEMA.parse(fixture.requirement) as CapabilityRequirement;
    const offers = arrayField(fixture, "offers").map((offer) =>
      CAPABILITY_OFFER_SCHEMA.parse(offer) as CapabilityOffer
    );
    const actual = negotiateCapabilities(requirement, offers, SETTINGS);
    assert.deepEqual(actual, fixture.expected);
  }
});

test("S2-B03 Chat Completions chunks preserve ordering, parallel calls, and usage", () => {
  for (const fixture of fixtureDocuments("b03-chat-stream")) {
    const state = new ChatCompletionEventState(SETTINGS);
    const events: ModelEvent[] = [];
    let metadataCount = 0;
    const error = consumeFrames(state, fixture, events, (count) => metadataCount += count);
    if (fixture.expectedError !== undefined) {
      assert.equal(errorCode(error), fixture.expectedError);
      assertFailClosed(state);
      continue;
    }
    assert.equal(error, undefined);
    assert.deepEqual(events.map((event) => event.type), fixture.expectedTypes);
    assert.deepEqual(events.map((event) => event.sequence), events.map((_event, index) => index));
    if (fixture.expectedMetadata !== undefined) assert.equal(metadataCount, fixture.expectedMetadata);
    if (fixture.expectedCalls !== undefined) {
      assert.deepEqual(events.filter((event) => event.type === "tool_call_done")
        .map((event) => event.callId), fixture.expectedCalls);
    }
  }
});

test("S2-B04 Responses events preserve lifecycle, reasoning, parallel calls, and usage", () => {
  for (const fixture of fixtureDocuments("b04-responses-stream")) {
    const state = new ResponsesEventState(SETTINGS, TEST_TRANSPORT);
    const events: ModelEvent[] = [];
    const error = consumeFrames(state, fixture, events, () => undefined);
    if (fixture.expectedError !== undefined) {
      assert.equal(errorCode(error), fixture.expectedError);
      assertFailClosed(state);
      continue;
    }
    assert.equal(error, undefined);
    assert.deepEqual(events.map((event) => event.type), fixture.expectedTypes);
    assert.deepEqual(events.map((event) => event.sequence), events.map((_event, index) => index));
    if (fixture.expectedCalls !== undefined) {
      assert.deepEqual(events.filter((event) => event.type === "tool_call_done")
        .map((event) => event.callId), fixture.expectedCalls);
    }
  }
});

test("S2-B05 MCP tools and results retain unknown data only in non-forwarded envelopes", () => {
  for (const fixture of fixtureDocuments("b05-mcp")) {
    if (fixture.expectedTools !== undefined) {
      const imported = importMcpToolsList(fixture.wire, SETTINGS, responseIdField(fixture));
      assert.deepEqual(imported.value.map((tool) => tool.name), fixture.expectedTools);
      assert.equal(imported.metadata?.classification, "regulated-restricted");
      assert.equal(imported.metadata?.forwarding, "forbidden");
      for (const model of imported.value) {
        const rebound = bindHarnessControl(model, {
          effect: "read",
          approval: "always",
          pathScope: ["."],
          idempotency: "intrinsic",
          retry: "idempotent-only",
        });
        const projected = projectMcpTool(rebound, SETTINGS);
        assert.deepEqual([...allObjectKeys(projected)].filter((key) => FORBIDDEN_MODEL_KEYS.has(key)), []);
        assert.equal(Object.hasOwn(projected, "annotations"), false);
        assert.equal(Object.hasOwn(projected, "_meta"), false);
      }
      continue;
    }
    if (fixture.expectedImportError !== undefined) {
      assert.throws(
        () => importMcpToolResult(
          fixture.wire,
          stringField(fixture, "callId"),
          SETTINGS,
          responseIdField(fixture),
        ),
        (error) => {
          assert.equal(errorCode(error), fixture.expectedImportError);
          if (fixture.expectedProtocolCode !== undefined) {
            assert.ok(error instanceof McpJsonRpcError);
            assert.equal(error.protocolCode, fixture.expectedProtocolCode);
            assert.equal(error.metadata.forwarding, "forbidden");
          }
          return true;
        },
      );
      continue;
    }
    const imported = importMcpToolResult(
      fixture.wire,
      stringField(fixture, "callId"),
      SETTINGS,
      responseIdField(fixture),
    );
    assert.equal(imported.value.text, fixture.expectedText);
    assert.equal(imported.value.isError, fixture.expectedIsError);
    assert.equal(imported.losses.length, fixture.expectedLosses);
    if (imported.metadata !== undefined) {
      assert.equal(imported.metadata.classification, "regulated-restricted");
      assert.equal(imported.metadata.forwarding, "forbidden");
    }
    const projected = projectMcpToolResult(imported.value);
    assert.equal(Object.hasOwn(projected, "metadata"), false);
    assert.equal(Object.hasOwn(projected, "callId"), false);
  }
});

test("S2-B06 malformed, duplicate, and provider-error streams fail closed without raw forwarding", () => {
  for (const fixture of fixtureDocuments("b06-fail-closed")) {
    const protocol = stringField(fixture, "protocol");
    const state = protocol === "openai-responses"
      ? new ResponsesEventState(SETTINGS, TEST_TRANSPORT)
      : new ChatCompletionEventState(SETTINGS);
    const events: ModelEvent[] = [];
    const error = consumeFrames(state, fixture, events, () => undefined);
    if (fixture.expectedError !== undefined) {
      assert.equal(errorCode(error), fixture.expectedError);
      assertFailClosed(state);
      continue;
    }
    assert.equal(error, undefined);
    assert.deepEqual(events.map((event) => event.type), fixture.expectedTypes);
    const providerError = events.find((event) => event.type === "error");
    assert.ok(providerError?.type === "error");
    assert.equal(providerError.error.code, fixture.expectedErrorCode);
    assert.equal(providerError.error.message, "Provider reported an error");
    assert.equal(providerError.error.metadata?.classification, "regulated-restricted");
    assert.equal(providerError.error.metadata?.forwarding, "forbidden");
    assertFailClosed(state);
  }
});

test("S2-B07 schema keyword matrix rejects recursively misplaced keywords", () => {
  assert.deepEqual(Object.keys(SCHEMA_KEYWORD_MATRIX).toSorted(), [
    "array", "boolean", "combinator", "integer", "null", "number", "object", "root", "string",
  ]);
  for (const fixture of fixtureDocuments("b07-schema-subset")) {
    const groups = arrayField(fixture, "groups");
    assert.ok(groups.length >= 1);
    for (const groupValue of groups) {
      const group = objectValue(groupValue, "schema matrix group");
      assert.equal(typeof group.kind, "string");
      const valid = arrayField(group, "valid");
      const invalid = arrayField(group, "invalid");
      assert.ok(valid.length >= 3, `${String(group.kind)} requires at least three valid cases`);
      assert.ok(invalid.length >= 3, `${String(group.kind)} requires at least three invalid cases`);
      for (const node of valid) {
        assert.equal(validateToolSchemaSubset(wrapSchemaNode(node), SETTINGS).ok, true, String(group.kind));
      }
      for (const node of invalid) {
        assert.equal(validateToolSchemaSubset(wrapSchemaNode(node), SETTINGS).ok, false, String(group.kind));
      }
    }
  }
});

function projectedOpenAITool(protocol: string, tool: ToolContract): unknown {
  const request = {
    requestId: "fixture-request",
    model: "fixture-model",
    messages: [{ role: "user" as const, content: "fixture" }],
    tools: [tool],
    toolChoice: "auto" as const,
    parallelToolCalls: false,
    stream: true,
  };
  const projection = protocol === "openai-responses"
    ? projectOpenAIResponses(request, SETTINGS)
    : projectOpenAIChat(request, SETTINGS);
  const tools = projection.body.tools;
  assert.ok(Array.isArray(tools) && tools.length === 1);
  return tools[0];
}

function fixtureDocuments(directory: string): readonly Record<string, unknown>[] {
  // Only the `.json` fixtures are documents — a `README.md` lands beside them
  // to orient a reader, and parsing it as JSON fails on its first `#`. Filter
  // by extension so a non-fixture file in the directory is ignored, not parsed.
  return readdirSync(join(FIXTURES, directory))
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) =>
      JSON.parse(readFileSync(join(FIXTURES, directory, name), "utf8")) as Record<string, unknown>
    );
}

function consumeFrames(
  state: ChatCompletionEventState | ResponsesEventState,
  fixture: Record<string, unknown>,
  events: ModelEvent[],
  addMetadata: (count: number) => void,
): unknown {
  try {
    for (const frame of arrayField(fixture, "frames")) {
      assert.equal(typeof frame, "string");
      const result = state.consumeSse(frame as string);
      events.push(...result.events);
      addMetadata(result.metadata.length);
    }
    return undefined;
  } catch (error) {
    return error;
  }
}

function assertFailClosed(state: ChatCompletionEventState | ResponsesEventState): void {
  assert.throws(
    () => state.consumeSse(": heartbeat\n\n"),
    (error) => errorCode(error) === "stream_after_done",
  );
}

function allObjectKeys(value: unknown, keys = new Set<string>()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    for (const entry of value) allObjectKeys(entry, keys);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key);
      allObjectKeys(entry, keys);
    }
  }
  return keys;
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const field = value[key];
  assert.ok(Array.isArray(field), `${key} must be an array`);
  return field;
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  assert.ok(field !== null && typeof field === "object" && !Array.isArray(field), `${key} must be an object`);
  return field as Record<string, unknown>;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function wrapSchemaNode(value: unknown): Record<string, unknown> {
  return {
    type: "object",
    properties: { value: objectValue(value, "schema matrix node") },
    additionalProperties: false,
  };
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  assert.equal(typeof field, "string", `${key} must be a string`);
  return field as string;
}

function responseIdField(value: Record<string, unknown>): string | number | undefined {
  const field = value.expectedResponseId;
  assert.ok(field === undefined || typeof field === "string" || Number.isSafeInteger(field));
  return field as string | number | undefined;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof HarnessError ? error.code : undefined;
}

test("S2-B08 native Responses controls preserve extensions and reject legacy or contradictory controls", () => {
  const options = { background: true, store: false, max_output_tokens: 16,
    context_management: [{ type: "compaction", compact_threshold: 1000 }],
    reasoning: { effort: "max", context: "all_turns", summary: "detailed", mode: "pro" },
    tools: [{ type: "programmatic_tool_calling" }, { type: "future_tool", setting: [true] }],
    stream_options: { include_obfuscation: false }, include: ["reasoning.encrypted_content"],
    provider_extension: { value: 7 }, user: "deprecated-pass-through" };
  assert.deepEqual(RESPONSES_REQUEST_OPTIONS_SCHEMA.parse(options), options);
  const full = { ...options, model: "native", stream: true, input: [{ role: "user", content: "hello" }, { id: "retained-item" }] };
  assert.deepEqual(RESPONSES_REQUEST_SCHEMA.parse(full), full);
  for (const invalid of [{ model: "managed" }, { input: "managed" }, { stream: true }, { messages: [] },
    { max_tokens: 100 }, { response_format: {} }, { max_output_tokens: 15 },
    { conversation: "conv", previous_response_id: "resp" }, { stream_options: { include_usage: true } },
    { tools: [{ type: "function", extension: undefined }] }, { temperature: 3 }]) {
    assert.equal(RESPONSES_REQUEST_OPTIONS_SCHEMA.safeParse(invalid).success, false, JSON.stringify(invalid));
  }
});

test("S2-B09 native output is lossless, optional status is not success, and usage preserves absence", () => {
  const output: ResponseItem[] = [
    { type: "reasoning", id: "reason", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "opaque" },
    { type: "future_hosted_tool", id: "hosted", result: { arbitrary: [1, false] } },
    { type: "message", id: "message", role: "assistant", content: [{ type: "refusal", refusal: "Declined" }] },
    { type: "function_call", id: "function", call_id: "call", name: "read", arguments: "{}" },
  ];
  const raw = nativeResource(output, undefined);
  const response = parseResponseResource({ ...raw, usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 2 }, cost: 0.05 } });
  assert.deepEqual(response.output, output);
  const unknown = projectResponse(response);
  assert.equal(unknown.finishReason, "unknown");
  assert.deepEqual(unknown.toolCalls, []);
  assert.equal(unknown.refusal, "Declined");
  assert.equal(unknown.reasoning, "thinking");
  assert.deepEqual(unknown.usage, { promptTokens: 4, completionTokens: 3, totalTokens: 7, cachedInputTokens: 0, cacheWriteTokens: 2 });
  assert.equal(response.usage?.cost, 0.05);
  assert.equal(projectResponse(response, "completed").toolCalls.length, 1);
  for (const status of ["incomplete", "failed", "cancelled", "queued", "in_progress"] as const) {
    assert.deepEqual(projectResponse(response, status).toolCalls, []);
  }
  for (const reason of ["max_output_tokens", "content_filter", "steered", "max_messages", "future", null, undefined]) {
    const incomplete = parseResponseResource({ ...raw, status: "incomplete", incomplete_details: reason === undefined ? {} : { reason } });
    assert.equal(projectResponse(incomplete).truncated, reason === "max_output_tokens");
  }
  assert.throws(() => parseResponseResource({ ...raw, output: [output[3], { ...output[3], id: "different" }] }));
  assert.throws(() => parseResponseResource({ ...raw, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 3 } }));
  assert.throws(() => parseResponseResource({ ...raw, output: [{ type: "function_call", call_id: "bad", name: "read", arguments: {} }] }));
});

test("S2-B10 native tool projection preserves strict function intent", () => {
  assert.deepEqual(toolsToResponses([
    { type: "function", function: { name: "read", parameters: { type: "object" } } },
    { type: "function", name: "strict", strict: true }, { type: "web_search", filters: { allowed_domains: ["example.test"] } },
  ]), [{ type: "function", name: "read", parameters: { type: "object" }, strict: false },
    { type: "function", name: "strict", strict: true }, { type: "web_search", filters: { allowed_domains: ["example.test"] } }]);
});

test("S2-B11 only validated completed terminal grants function execution, including retained-state resume", () => {
  for (const status of ["completed", "incomplete", "failed", "cancelled"] as const) {
    const state = new ResponseStreamState();
    const setup = nativeFunctionEvents("{}");
    const chunks = setup.flatMap((event) => state.consume(event, undefined, TEST_FAILURE_OPTIONS));
    assert.equal(chunks.some((chunk) => chunk.type === "tool_call_done"), false, status);
    assert.equal(state.responseId, "response-test");
    assert.equal(state.sequenceNumber, setup.length - 1);
    assert.throws(() => state.finish(), /without a terminal event/u);
    assert.equal(state.done, false, "transport EOF must leave the retained checkpoint resumable");
    const item = objectValue(setup.at(-1)!.item, "function item");
    let terminalObserved = false;
    const terminal = state.consume({ type: `response.${status}`, sequence_number: setup.length,
      response: nativeResource([item as ResponseItem], status) }, undefined, TEST_FAILURE_OPTIONS, (response, actualStatus) => {
      assert.equal(state.done, true); assert.equal(state.response, response); assert.equal(actualStatus, status);
      terminalObserved = true; return TEST_FAILURE_OPTIONS;
    });
    assert.equal(terminalObserved, true);
    assert.equal(terminal.filter((chunk) => chunk.type === "tool_call_done").length, status === "completed" ? 1 : 0, status);
    assert.equal(terminal[0]?.type, "response_event");
    assert.equal(terminal.some((chunk) => chunk.type === "response"), true);
    assert.equal(terminal.some((chunk) => chunk.type === "error"), status === "failed");
    state.finish();
    assert.throws(() => state.consume({ type: "future", sequence_number: setup.length + 1 }, undefined, TEST_FAILURE_OPTIONS));
  }
  const malformed = nativeFunctionEvents("{");
  const incomplete = new ResponsesEventState(SETTINGS, TEST_TRANSPORT);
  malformed.forEach((event) => incomplete.consumeEvent(event));
  assert.equal(incomplete.consumeEvent({ type: "response.incomplete", sequence_number: malformed.length,
    response: nativeResource([malformed.at(-1)!.item as ResponseItem], "incomplete") }).events.some((event) => event.type === "tool_call_done"), false);
  const completed = new ResponsesEventState(SETTINGS, TEST_TRANSPORT);
  malformed.forEach((event) => completed.consumeEvent(event));
  assert.throws(() => completed.consumeEvent({ type: "response.completed", sequence_number: malformed.length,
    response: nativeResource([malformed.at(-1)!.item as ResponseItem], "completed") }));
});

test("S2-B12 streaming preserves unknown events and parts without duplicated final text", () => {
  const text = { type: "output_text", text: "Hello", annotations: [{ type: "future_annotation", value: 3 }] };
  const opaque = { type: "future_content", payload: { bytes: "opaque" } };
  const item = { type: "message", id: "msg", role: "assistant", content: [text, opaque] };
  const events = [
    { type: "response.created", response: nativeResource([], undefined) },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.future_signal", payload: { arbitrary: true } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: nativeResource([item], undefined) },
  ];
  const state = new ResponseStreamState();
  const chunks = events.flatMap((event, sequence_number) => state.consume({ ...event, sequence_number }, event.type, TEST_FAILURE_OPTIONS));
  assert.equal(chunks.filter((chunk) => chunk.type === "response_event").length, events.length);
  assert.equal(chunks.flatMap((chunk) => chunk.type === "content" ? [chunk.text] : []).join(""), "Hello");
  const final = chunks.find((chunk) => chunk.type === "response");
  assert.equal(final?.status, "completed");
  assert.equal(final?.response.status, undefined, "terminal event supplies meaning without rewriting native envelope");
  assert.deepEqual(final?.response.output, [item]);
  assert.equal(chunks.filter((chunk) => chunk.type === "reasoning").length, 0);
  state.finish();
  const refusal = new ResponsesEventState(SETTINGS, TEST_TRANSPORT);
  refusal.consumeEvent({ type: "response.created", sequence_number: 0, response: nativeResource([], undefined) });
  const step = refusal.consumeEvent({ type: "response.output_item.added", sequence_number: 1, output_index: 0,
    item: { type: "message", id: "refusal", role: "assistant", content: [{ type: "refusal", refusal: "Declined" }] } });
  assert.equal(step.events.find((event) => event.type === "text_delta")?.delta, "Declined");
});

test("S2-B13 streaming rejects sequence, identity, event-name and final-output contradictions", () => {
  for (const mutate of [
    (event: Record<string, unknown>) => ({ ...event, sequence_number: 0 }),
    (event: Record<string, unknown>) => ({ ...event, response_id: "other" }),
    (event: Record<string, unknown>) => ({ ...event, sequence_number: -1 }),
  ]) {
    const state = new ResponseStreamState();
    state.consume({ type: "response.created", sequence_number: 0, response: nativeResource([], undefined) }, undefined, TEST_FAILURE_OPTIONS);
    assert.throws(() => state.consume(mutate({ type: "response.future", sequence_number: 1 }), undefined, TEST_FAILURE_OPTIONS));
  }
  const mismatched = new ResponseStreamState();
  assert.throws(() => mismatched.consume({ type: "response.created", sequence_number: 0,
    response: nativeResource([], undefined) }, "response.completed", TEST_FAILURE_OPTIONS));
  for (const changed of [
    { ...nativeResource([], "completed"), id: "other" },
    nativeResource([], "completed"),
    nativeResource([{ type: "function_call", id: "fc", call_id: "call", name: "other", arguments: "{}" }], "completed"),
  ]) {
    const state = new ResponseStreamState();
    const setup = nativeFunctionEvents("{}");
    setup.forEach((event) => state.consume(event, undefined, TEST_FAILURE_OPTIONS));
    assert.throws(() => state.consume({ type: "response.completed", sequence_number: setup.length, response: changed }, undefined, TEST_FAILURE_OPTIONS));
  }
});

function nativeResource(output: readonly ResponseItem[], status: string | undefined): Record<string, unknown> {
  return { id: "response-test", object: "response", model: "contract-model", output,
    ...(status === undefined ? {} : { status }) };
}
function nativeFunctionEvents(argumentsText: string): Record<string, unknown>[] {
  const initial = { type: "function_call", id: "fc", call_id: "call", name: "read", arguments: "" };
  return [
    { type: "response.created", response: nativeResource([], "in_progress") },
    { type: "response.output_item.added", output_index: 0, item: initial },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc", delta: argumentsText },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc", arguments: argumentsText },
    { type: "response.output_item.done", output_index: 0, item: { ...initial, arguments: argumentsText, status: "completed" } },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
}

test("S2-B14 known part, text, and argument events require matching item identities", async () => {
  const { responseEvents } = await import("./support/mock-provider.ts");
  for (const events of [responseEvents({ content: "witness" }), nativeFunctionEvents("{}")]) {
    for (const [index, original] of events.entries()) {
      if (!("item_id" in original)) continue;
      for (const bad of [undefined, null, 123, "different-item"]) {
        const state = new ResponseStreamState(); events.slice(0, index).forEach(event => state.consume(event, undefined, TEST_FAILURE_OPTIONS));
        const changed: Record<string, unknown> = { ...original, item_id: bad }; if (bad === undefined) delete changed.item_id;
        assert.throws(() => state.consume(changed, undefined, TEST_FAILURE_OPTIONS), `${String(original.type)} must validate item_id`);
      }
    }
  }
  for (const type of ["response.reasoning_summary_part.added", "response.reasoning_summary_part.done", "response.reasoning_text.delta", "response.reasoning_text.done", "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done"]) {
    for (const bad of [undefined, null, 123, "different-item"]) {
      const state = new ResponseStreamState();
      state.consume({ type: "response.created", sequence_number: 0, response: nativeResource([], undefined) }, undefined, TEST_FAILURE_OPTIONS);
      state.consume({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { type: "reasoning", id: "reason", summary: [] } }, undefined, TEST_FAILURE_OPTIONS);
      assert.throws(() => state.consume({ type, sequence_number: 2, output_index: 0, item_id: bad, content_index: 0, summary_index: 0, delta: "a", text: "a", part: { type: "summary_text", text: "" } }, undefined, TEST_FAILURE_OPTIONS));
    }
  }
});

test("S2-B15 SSE error envelopes require the documented nullable fields", () => {
  const good = { type: "error", sequence_number: 0, code: null, message: "provider refused", param: null };
  assert.equal(new ResponseStreamState().consume(good, undefined, TEST_FAILURE_OPTIONS).at(-1)?.type, "error");
  for (const key of ["code", "message", "param", "sequence_number"]) {
    const bad: Record<string, unknown> = { ...good }; delete bad[key];
    assert.throws(() => new ResponseStreamState().consume(bad, undefined, TEST_FAILURE_OPTIONS));
  }
});

test("S2-B16 nested and flat started errors retain failure until real terminal or EOF", () => {
  const providerError = { code: "credit_balance_exhausted", type: "insufficient_quota", message: "No credits", param: null };
  for (const nested of [false, true]) {
    const state = new ResponseStreamState();
    state.consume({ type: "response.created", sequence_number: 0, response: nativeResource([], "in_progress") }, undefined, TEST_FAILURE_OPTIONS);
    const notification = state.consume({ type: "error", sequence_number: 1, ...(nested ? { error: providerError } : { ...providerError, type: "error" }) }, undefined, TEST_FAILURE_OPTIONS);
    assert.equal(state.done, false); assert.equal(notification.some(chunk => chunk.type === "error"), false);
    assert.throws(() => state.finish(), { code: "llm_quota_exhausted", retryable: false });
    assert.equal(state.response, undefined, "EOF cannot invent a native failed resource");
    const failed = { ...nativeResource([], "failed"), error: { code: providerError.code, message: providerError.message } };
    const terminal = state.consume({ type: "response.failed", sequence_number: 2, response: failed }, undefined, TEST_FAILURE_OPTIONS);
    assert.equal(terminal.find(chunk => chunk.type === "response")?.response, state.response);
    assert.equal(terminal.at(-1)?.type, "error");
    assert.equal(terminal.some(chunk => chunk.type === "tool_call_done"), false); state.finish();
  }
  const state = new ResponseStreamState();
  const setup = nativeFunctionEvents("{}"); setup.forEach(event => state.consume(event, undefined, TEST_FAILURE_OPTIONS));
  state.consume({ type: "error", sequence_number: setup.length, error: providerError }, undefined, TEST_FAILURE_OPTIONS);
  const terminal = state.consume({ type: "response.completed", sequence_number: setup.length + 1,
    response: nativeResource([setup.at(-1)!.item as ResponseItem], "completed") }, undefined, TEST_FAILURE_OPTIONS);
  assert.ok(terminal.some(chunk => chunk.type === "response"));
  assert.ok(terminal.some(chunk => chunk.type === "error"));
  assert.equal(terminal.some(chunk => chunk.type === "tool_call_done"), false, "an observed error never grants subsequent execution authority");
});
