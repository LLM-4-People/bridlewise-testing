import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatStreamEvent,
  ProviderAdapter,
  ToolCall,
} from "../../src/runtime/provider-adapter.ts";
import { parseResponseResource, type ResponseResource, type ResponseStatus, type ResponseUsage } from "../../src/shared/llm/responses.ts";
import { observeResponseEnvelope } from "../../src/privacy/responses-observation.ts";
import { resolveResponsesTransportConfig } from "../../src/shared/llm/config.ts";
import { redactAndMintRequest, type RedactedResponsesRequest, type RequestRedactionOptions } from "../../src/privacy/redacted-messages.ts";
import type { ResponseOperation } from "../../src/shared/llm/responses-endpoints.ts";
import { classifyProviderFailure, type ProviderFailureOptions } from "../../src/shared/llm/provider-failure.ts";

/** The resolved default transport a test double stands in for (the real client resolves its configured one). */
export const TEST_TRANSPORT = resolveResponsesTransportConfig({});
/**
 * The request mint under `TEST_TRANSPORT` (the API REQUIRES the configured
 * transport limits: a2-design M5); an explicit `limits` in `options` wins.
 */
export function mintTestRequest<Operation extends ResponseOperation>(operation: Operation, request: unknown, options: Partial<RequestRedactionOptions> = {}): RedactedResponsesRequest<Operation> {
  return redactAndMintRequest(operation, request, { limits: TEST_TRANSPORT, ...options });
}

/** Failure-classification options matching `TEST_TRANSPORT`. */
export const TEST_FAILURE_OPTIONS: ProviderFailureOptions = Object.freeze({ maximumMessageCharacters: TEST_TRANSPORT.maximumErrorMessageCharacters });

/** A terminal resource event as the real stream decoder emits it, including the classified failure of a failed resource. */
export function nativeResponseEvent(response: ResponseResource, status: ResponseStatus): Extract<ChatStreamEvent, { type: "response" }> {
  const observation = observeResponseEnvelope({ headers: {}, response }, { status, limits: TEST_TRANSPORT });
  return { type: "response", response, status, observation,
    ...(status === "failed" ? { failure: classifyProviderFailure(response.error, { ...TEST_FAILURE_OPTIONS, diagnostic: observation.diagnostic ?? null }) } : {}) };
}

/**
 * Shared evaluation mock provider. The single owner of the `ProviderAdapter`
 * test double used by the evaluation suite (`adversarial-fixes`,
 * `adversarial-fixes-2`, `critical-fixes`, `matrix-executor`,
 * `scenario-runner`). Before this module existed, five near-identical
 * `makeMockProvider` implementations were duplicated across those files with
 * two incompatible signatures (a rich options object and a positional
 * `(content, usage?, headers?)` form) and small behavioral drift. This is the
 * canonical rich-signature factory; positional callers pass `{ content, usage,
 * headers }`.
 *
 * The options type is the superset of every previous variant so all former
 * call sites work without losing features (`probeUsage`, `throwOnNthCall`,
 * `bodyModel`, `probeContent`).
 */

export interface MockProviderOptions {
  content?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Usage reported on probe calls; defaults to `usage` when omitted. */
  probeUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  headers?: Record<string, string>;
  toolCalls?: readonly ToolCall[];
  finishReason?: string;
  throwOnCall?: boolean;
  /** Different content for probe vs main calls (probe is the FIRST call). */
  probeContent?: string;
  /** Throw on the Nth chatCompletion call (1-indexed). */
  throwOnNthCall?: number;
  /** The `model` field in the response body (body-level model identity). */
  bodyModel?: string;
}

const PROBE_PROMPT = "Reply with exactly: IDENTITY_PROBE_OK";

/**
 * Shared scripted-event mock adapter. The single owner of the
 * `mockAdapter(events)` test double previously copied across the agents,
 * runtime, and timeline suites (13 near-identical copies, one drifted to
 * ignore `events` in `chatCompletion`). Streams `events` verbatim; the
 * non-streaming `chatCompletion` derives its content by concatenating the
 * `content` events so both paths stay consistent.
 */
export function makeMockAdapter(events: readonly ChatStreamEvent[]): ProviderAdapter {
  return Object.freeze({
    providerId: "mock",
    async *streamChatCompletion(_request: ChatCompletionRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
      for (const event of events) yield event;
    },
    async chatCompletion(_request: ChatCompletionRequest) {
      let content = "";
      for (const event of events) {
        if (event.type === "content") content += event.text;
      }
      return Object.freeze({ content, toolCalls: [], usage: undefined, finishReason: "stop" });
    },
  });
}

/** Explicit native fixture builder for existing domain scripts. No finish means no terminal resource. */
export function nativeResponseAdapter(adapter: ProviderAdapter): ProviderAdapter {
  return Object.freeze({ ...adapter,
    async *streamChatCompletion(request: ChatCompletionRequest, invocation?: import("../../src/runtime/provider-adapter.ts").ProviderInvocationOptions): AsyncGenerator<ChatStreamEvent, void, unknown> {
      let content = "";
      let native = false;
      let usage: ChatCompletionResult["usage"];
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const event of adapter.streamChatCompletion(request, invocation)) {
        if (event.type === "response") native = true;
        if (event.type === "content") content += event.text;
        if (event.type === "usage") usage = event.usage;
        if (event.type === "tool_call_start") calls.set(event.index, { id: event.id, name: event.name, arguments: "" });
        if (event.type === "tool_call_delta") { const call = calls.get(event.index); if (call) call.arguments += event.arguments; }
        if (event.type === "finish" && !native) {
          const status = event.reason === "error" ? "failed" : event.reason === "length" ? "incomplete"
            : event.reason === "cancelled" ? "cancelled" : "completed";
          const response = parseResponseResource(responseResource({ model: request.model, content, status,
            toolCalls: [...calls.values()].map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
            ...(usage ? { usage: { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens, total_tokens: usage.totalTokens } } : {}),
          }));
          yield nativeResponseEvent(response, status);
          if (status === "completed") for (const [index, call] of calls) yield { type: "tool_call_done", index, ...call };
          native = true;
        }
        yield event;
      }
    },
  });
}

export function makeNativeMockAdapter(events: readonly ChatStreamEvent[]): ProviderAdapter {
  return nativeResponseAdapter(makeMockAdapter(events));
}

export function makeMockProvider(opts: MockProviderOptions = {}): ProviderAdapter {
  const content = opts.content ?? "test response";
  const usage = opts.usage ?? { promptTokens: 10, completionTokens: 20, totalTokens: 30 };
  const probeUsage = opts.probeUsage ?? usage;
  const headers = opts.headers;
  const toolCalls = opts.toolCalls ?? [];
  const finishReason = opts.finishReason ?? "stop";
  let callCount = 0;
  return nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      if (opts.throwOnCall === true) throw new Error("provider unavailable");
      const events: ChatStreamEvent[] = [
        { type: "content", text: content },
        { type: "usage", usage },
        { type: "finish", reason: finishReason },
      ];
      for (const e of events) yield e;
    },
    async chatCompletion(request): Promise<ChatCompletionResult> {
      if (opts.throwOnCall === true) throw new Error("provider unavailable");
      if (request.signal?.aborted) throw new Error("aborted");
      callCount++;
      if (opts.throwOnNthCall !== undefined && callCount === opts.throwOnNthCall) {
        throw new Error(`forced throw on call ${callCount}`);
      }
      const isProbe = request.messages[0]?.content === PROBE_PROMPT;
      const c = isProbe ? (opts.probeContent ?? "IDENTITY_PROBE_OK") : content;
      const u = isProbe ? probeUsage : usage;
      const h = headers ?? { "x-model-id": request.model };
      return {
        content: c,
        toolCalls: toolCalls as readonly ToolCall[],
        usage: u,
        finishReason,
        headers: h,
        ...(opts.bodyModel !== undefined ? { model: opts.bodyModel } : {}),
      };
    },
  });
}

/** Genuine Responses wire fixtures, shared by every HTTP/provider owner. */
export type ResponsesFixture = Readonly<{
  id?: string; model?: string; content?: string; chunks?: readonly string[];
  status?: "completed" | "incomplete" | "failed" | "queued" | "in_progress" | "cancelled";
  reason?: string; toolCalls?: readonly ToolCall[];
  usage?: ResponseUsage | null;
  output?: readonly Record<string, unknown>[];
}>;
export function responseResource(options: ResponsesFixture = {}): Record<string, unknown> {
  const content = options.chunks?.join("") ?? options.content;
  const output = options.output ?? [
    ...(content === undefined ? [] : [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: content, annotations: [] }] }]),
    ...(options.toolCalls ?? []).map((call, index) => ({ type: "function_call", id: `fc_fixture_${index}`, call_id: call.id,
      name: call.function.name, arguments: call.function.arguments, status: "completed",
      ...(call.caller === undefined ? {} : { caller: call.caller }),
      ...(call.namespace === undefined ? {} : { namespace: call.namespace }) })),
  ];
  return { id: options.id ?? "resp_fixture", object: "response", model: options.model ?? "test-model", output,
    status: options.status ?? "completed", ...(options.usage === undefined ? {} : { usage: options.usage }),
    ...(options.status === "incomplete" ? { incomplete_details: { reason: options.reason ?? "max_output_tokens" } } : {}) };
}
export function responseEvents(options: ResponsesFixture = {}): readonly Record<string, unknown>[] {
  const response = responseResource(options), events: Record<string, unknown>[] = [];
  const push = (event: Record<string, unknown>): void => { events.push({ ...event, sequence_number: events.length }); };
  push({ type: "response.created", response: { ...response, status: "in_progress", output: [] } });
  push({ type: "response.in_progress", response: { ...response, status: "in_progress", output: [] } });
  for (const [index, item] of (response.output as Record<string, unknown>[]).entries()) {
    const identity = { output_index: index, item_id: item.id };
    if (item.type === "message") {
      push({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", content: [] } });
      const text = String((item.content as { text: string }[])[0]?.text ?? "");
      const part = { type: "output_text", text, annotations: [] };
      push({ type: "response.content_part.added", ...identity, content_index: 0, part: { ...part, text: "" } });
      for (const delta of options.chunks ?? [text]) if (delta) push({ type: "response.output_text.delta", ...identity, content_index: 0, delta });
      push({ type: "response.output_text.done", ...identity, content_index: 0, text });
      push({ type: "response.content_part.done", ...identity, content_index: 0, part });
    } else if (item.type === "function_call") {
      push({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", arguments: "" } });
      if (item.arguments) push({ type: "response.function_call_arguments.delta", ...identity, delta: item.arguments });
      push({ type: "response.function_call_arguments.done", ...identity, arguments: item.arguments });
    } else push({ type: "response.output_item.added", output_index: index, item });
    push({ type: "response.output_item.done", output_index: index, item });
  }
  push({ type: `response.${options.status ?? "completed"}`, response });
  return events;
}
export function responsesSse(options: ResponsesFixture = {}): string {
  return responseEvents(options).map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
export function responseSseResponse(options: ResponsesFixture = {}, init: ResponseInit = {}): Response {
  return new Response(responsesSse(options), { ...init, headers: { "content-type": "text/event-stream", ...Object.fromEntries(new Headers(init.headers)) } });
}
export function responseJsonResponse(options: ResponsesFixture = {}, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(responseResource(options)), { ...init, headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers)) } });
}

/**
 * A loopback upstream for the evaluation's two provider paths at once. The
 * identity probe goes through the provider adapter, which speaks the
 * Responses API (`…/responses`, answered here in the Responses wire shape,
 * streamed when the request asks for a stream, with the requested model so
 * the identity can be established). The reference transport is its own raw
 * HTTP oracle on `…/chat/completions` (answered in that shape). A request
 * carrying the probe prompt is answered with the probe marker.
 */
export function referenceTransportUpstream(options: Readonly<{ content: string; headers?: Readonly<Record<string, string>> }>): (url: string, init: { body: string | undefined }) => Promise<Response> {
  return async (url, init) => {
    const body = JSON.parse(init.body ?? "{}") as { model?: string; stream?: boolean };
    const content = (init.body ?? "").includes("Reply with exactly: IDENTITY_PROBE_OK") ? "IDENTITY_PROBE_OK" : options.content;
    const headers = { ...(options.headers ?? {}) };
    if (new URL(url).pathname.endsWith("/responses")) {
      const fixture = { content, model: body.model ?? "test-model", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } as ResponseUsage };
      return body.stream === true ? responseSseResponse(fixture, { headers }) : responseJsonResponse(fixture, { headers });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { "content-type": "application/json", ...headers } });
  };
}
