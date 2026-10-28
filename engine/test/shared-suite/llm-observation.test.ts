import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SharedLLMClient, fetchProviderModels, extractResponseHeaders } from "../../src/shared/llm/client.ts";
import { ALL_ERROR_TYPES, LLMError } from "../../src/shared/llm/errors.ts";
import { heldValues } from "../../src/privacy/held-set.ts";
import type { LLMConfig } from "../../src/shared/llm/config.ts";
import { knownSecretLabels, forgetKnownSecret, registerKnownSecret, knownSecretSpans, knownSecretRegistryGeneration } from "../../src/privacy/secret-intelligence.ts";
import { observeResponseProtocol, observeResponseEnvelope } from "../../src/privacy/responses-observation.ts";
import { RequestQueue } from "../../src/shared/llm/queue.ts";
import { LLMStatsCollector } from "../../src/shared/llm/stats.ts";
import { classifyProviderFailure } from "../../src/shared/llm/provider-failure.ts";
import { configureDebugSystem, createCollectingSink, resetDebugSystem } from "../../src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../src/shared/debug/debug-config.ts";
import { responseJsonResponse, responseSseResponse, responseResource, responseEvents, TEST_FAILURE_OPTIONS, TEST_TRANSPORT } from "../support/mock-provider.ts";
import { address, mockDoorClock, serve, type UpstreamHandler } from "../support/loopback-upstream.ts";

const credential = "observation-fixture-credential-001";
const request = ({ model: "ordinary-model", input: "witness" });
/**
 * A body whose read FAILS after the status and headers arrived: one byte is
 * sent (so the status line and headers reach the client), then the stream
 * errors and the upstream drops the connection mid-body — the real-transport
 * form of a response body that cannot be read.
 */
function failingBody(message: string): ReadableStream<Uint8Array> {
  let pulls = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (pulls++ === 0) { controller.enqueue(new TextEncoder().encode("{")); return undefined; }
    return new Promise<void>((resolve) => setTimeout(() => { controller.error(new Error(message)); resolve(); }, 20));
  } });
}

/** A client whose provider is answered by `handler` on the real loopback upstream (an override `baseUrl` is used as given). */
function client(handler: UpstreamHandler, overrides: Partial<LLMConfig> = {}) {
  serve(handler);
  return new SharedLLMClient({ baseUrl: address("https://provider.test/v1"), apiKey: credential, allowPrivateAddress: true, providerId: "fixture-provider", model: "ordinary-model",
    maxRetries: Object.fromEntries(ALL_ERROR_TYPES.map(type => [type, 0])), ...overrides });
}

test("A returned model equal to the held credential never crosses: the private resource and every public observation mask it (SECC-V-A3)", async () => {
  for (const streaming of [false, true]) {
    const logs: unknown[] = [], metrics: unknown[] = [];
    const c = client(async () => streaming ? responseSseResponse({ model: credential, content: "safe" }) : responseJsonResponse({ model: credential, content: "safe" }), { logger: { log(event) { logs.push(event); } } });
    if (streaming) {
      let rawModel: string | undefined;
      for await (const event of c.stream(request, { metricsSink: event => { metrics.push(event); } })) if (event.type === "response") rawModel = event.response.model;
      assert.equal(rawModel, "[REDACTED:secret]");
    } else assert.equal((await c.create(request, { metricsSink: event => { metrics.push(event); } })).response.model, "[REDACTED:secret]");
    assert.equal(logs.length, 1); assert.equal(metrics.length, 1);
    for (const observation of [logs, metrics, c.getStats()]) assert.ok(!JSON.stringify(observation).includes(credential), "public label must not echo authentication");
  }
});

test("Intended header credentials register before identity validation and use non-sensitive provenance labels", () => {
  const headerCredential = "admin44xyz";
  for (const headers of [{ "X-Api-Key": headerCredential }, { Authorization: `Bearer ${headerCredential}` }]) {
    assert.throws(() => client(async () => responseJsonResponse({ content: "unreachable" }), { providerId: headerCredential, headers }), { code: "responses_identity_sensitive" });
    assert.ok(!JSON.stringify(knownSecretLabels()).includes(headerCredential));
  }
  // A failed constructor must not leave credential-bearing registry labels behind.
  for (const label of knownSecretLabels()) if (label.includes(headerCredential)) forgetKnownSecret(label);
});

test("Direct discovery observations do not expose a header credential repeated as provider identity", async () => {
  const headerCredential = "lookup88xyz", sink = createCollectingSink();
  configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, enabled: true, level: "debug", categories: ["llm"], sinks: { ...DEBUG_CONFIG_DEFAULTS.sinks, enabledSinks: [sink.kind] } }, [sink]);
  try {
    serve(async () => new Response('{"data":[]}', { headers: { "content-type": "application/json" } }));
    await fetchProviderModels({ baseUrl: address("https://provider.test/v1"), apiKey: credential, headers: { Authorization: `Bearer ${headerCredential}` }, providerId: headerCredential,
      timeoutMs: 1000, maxBytes: 1000, transport: TEST_TRANSPORT, allowPrivateAddress: true });
    assert.ok(sink.events.some(event => event.message === "provider_http_started"));
    assert.ok(!JSON.stringify(sink.events).includes(headerCredential));
    assert.ok(!JSON.stringify(knownSecretLabels()).includes(headerCredential));
  } finally { resetDebugSystem(); }
});

test("Held credential provenance survives rotation of an unrelated named registration", () => {
  const old = "held-before-rotation-fixture", replacement = "held-after-rotation-fixture";
  registerKnownSecret(old, "rotation-fixture"); registerKnownSecret(old);
  registerKnownSecret(replacement, "rotation-fixture");
  assert.ok(knownSecretSpans(old).length > 0, "live unnamed ownership must survive explicit-label rotation");
  assert.ok(knownSecretSpans(replacement).length > 0);
});

test("Public provider targets hide locator paths without altering native endpoint routing", async () => {
  const targetPath = `/v1/${credential}`;
  let called = "";
  const c = client(async url => { called = String(url); return responseJsonResponse({ content: "safe" }); }, { baseUrl: address(`https://provider.test${targetPath}`), responsesPath: `/${credential}/responses` });
  await c.create(request);
  assert.equal(called, `https://provider.test${targetPath}/${credential}/responses`);
  assert.ok(!JSON.stringify(c.getCurrentTarget()).includes(credential));
  for (const baseUrl of [`https://user:${credential}@provider.test/v1`, `https://provider.test/v1?token=${credential}`, `https://provider.test/v1#${credential}`,
    ...["?", "#", "?#", "#?"].map(suffix => `https://provider.test/v1${suffix}`)]) {
    assert.throws(() => client(async () => responseJsonResponse({ content: "unreachable" }), { baseUrl }), { code: "llm_config_invalid" });
    let requests = 0;
    serve(async () => { requests++; return Response.json({ data: [] }); });
    await assert.rejects(fetchProviderModels({ baseUrl, apiKey: credential, headers: {}, providerId: "fixture", timeoutMs: 1000, maxBytes: 1000, transport: TEST_TRANSPORT,
      allowPrivateAddress: true }), { code: "provider_address_invalid" });
    assert.equal(requests, 0, "discovery must reject ambiguous addresses before sending credentials");
  }
});

test("Every configured credential protects current target origins and HTTP diagnostics", async () => {
  // The credential rides the remote's host name (the loopback address carries
  // it in its path; the upstream answers as that host).
  const secondary = "other77xyz", remote = `https://${secondary}.provider.test/v1`;
  const observed: unknown[] = [];
  for (const failure of ["status", "body"] as const) {
    const c = client(async url => {
      assert.equal(String(url), `${remote}/responses`, "safe observations cannot alter exact routing");
      return failure === "status" ? Response.json({ error: { message: secondary } }, { status: 401 })
        : new Response(failingBody(secondary), { status: 400 });
    }, { baseUrl: address(remote), providers: [{ id: "secondary", baseUrl: address("https://second.test/v1"), apiKey: secondary }] });
    observed.push(c.getCurrentTarget());
    await assert.rejects(c.create(request), error => {
      assert.ok(error instanceof LLMError); assert.equal(error.code, failure === "status" ? "llm_auth_error" : "llm_invalid_response");
      observed.push(error.message); return true;
    });
  }
  for (const value of observed) assert.ok(!JSON.stringify(value).includes(secondary), "the client-held set spans every configured provider");
});

test("Stats legal inherited-property labels remain independent own entries without prototype mutation", () => {
  const module = new URL("../../src/shared/llm/stats.ts", import.meta.url).href;
  const script = `import { LLMStatsCollector } from ${JSON.stringify(module)};
    const before = Reflect.ownKeys(Object.prototype); const stats = new LLMStatsCollector();
    const labels = ['__proto__','constructor','toString','hasOwnProperty'];
    for (const label of labels) { stats.recordRequest(label,label); stats.recordTokens({promptTokens:2,completionTokens:3,totalTokens:5},label,label); }
    const snapshot=stats.snapshot(false);
    process.stdout.write(JSON.stringify({ polluted: Reflect.ownKeys(Object.prototype).length !== before.length,
      rows: labels.map(label=>({own:Object.hasOwn(snapshot.byModel,label), requests:snapshot.byModel[label]?.requests, total:snapshot.byModel[label]?.totalTokens})), total:snapshot.totalTokens.total }));`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { polluted: false, rows: Array.from({ length: 4 }, () => ({ own: true, requests: 1, total: 5 })), total: 20 });
});

test("Complete resource declarations govern returned model labels in JSON and SSE without global learning", async () => {
  const declared = "phrase77xyz";
  for (const streaming of [false, true]) {
    const observations: unknown[] = [];
    const c = client(async () => (streaming ? responseSseResponse : responseJsonResponse)({ model: declared, content: `my password may be ${declared}` }),
      { logger: { log: event => { observations.push(event); } } });
    const generation = knownSecretRegistryGeneration();
    if (streaming) for await (const _chunk of c.stream(request, { metricsSink: value => { observations.push(value); } })) { /* private stream */ }
    else assert.equal((await c.create(request, { metricsSink: value => { observations.push(value); } })).response.model, declared);
    assert.equal(knownSecretRegistryGeneration(), generation);
    assert.ok(!JSON.stringify([observations, c.getStats()]).includes(declared));
  }
});

test("Whole native observations share structured declarations across keys, model, arguments and tool credentials", () => {
  const declared = "native88xyz";
  for (const declaration of [
    { metadata: { password: declared } },
    { tools: [{ type: "mcp", server_label: "remote", authorization: declared }] },
    { instructions: `my password may be ${declared}` },
  ]) {
    const raw = { ...responseResource({ model: declared, content: `copied ${declared}` }), ...declaration,
      extra: { [declared]: declared, witness: "preserved" },
      arguments: JSON.stringify({ [declared]: declared, value: declared }) };
    const original = JSON.stringify(raw), generation = knownSecretRegistryGeneration();
    const observed = observeResponseProtocol(raw, { limits: TEST_TRANSPORT }) as Record<string, any>;
    assert.ok(!JSON.stringify(observed).includes(declared)); assert.equal(observed.extra.witness, "preserved");
    assert.equal(JSON.stringify(raw), original); assert.equal(knownSecretRegistryGeneration(), generation);
    assert.ok(Object.isFrozen(observed) && Object.isFrozen(observed.extra));
  }
  const benign = observeResponseProtocol({ object: "response", model: "true", output: [], metadata: { password: "true" }, value: "true" }, { limits: TEST_TRANSPORT }) as any;
  assert.equal(benign.model, "true"); assert.equal(benign.value, "true"); assert.notEqual(benign.metadata.password, "true");
});

test("Failure diagnostics reuse complete resource context at configured structural and exact byte bounds", async () => {
  const declared = "failure88xyz";
  let extension: unknown = "ordinary deep extension";
  for (let depth = 0; depth < 52; depth++) extension = { nested: extension };
  const raw = { ...responseResource({ status: "failed", content: `my password may be ${declared}` }), extension,
    error: { code: "credit_balance_exhausted", type: "insufficient_quota", message: `Unable to finish: ${declared}`, param: null } };
  const body = JSON.stringify(raw), limits = { maximumDepth: 64, maximumResponseBytes: Buffer.byteLength(body) };
  assert.throws(() => observeResponseProtocol(raw, { limits: TEST_TRANSPORT }), { code: "responses_observation_structure_invalid" });
  const observation = observeResponseProtocol(raw, { limits }) as Record<string, unknown>;
  const failure = classifyProviderFailure(raw.error, { ...TEST_FAILURE_OPTIONS, diagnostic: observation.error });
  assert.equal(failure.code, "llm_quota_exhausted"); assert.equal(failure.retryable, false);
  assert.ok(failure.message.includes("Unable to finish")); assert.ok(!failure.message.includes(declared));
  const c = client(async () => new Response(body, { headers: { "content-type": "application/json" } }), { responses: limits });
  assert.deepEqual((await c.create(request)).response, raw, "private failed resource remains exact");
  for (const status of ["failed", "completed"] as const) {
    // A prior error remains the classification authority even when the terminal
    // resource's diagnostic code is redacted or contradicts the prior failure.
    const resource = { ...raw, status, metadata: { password: "credit_balance_exhausted" } };
    const progress = responseEvents({ status, content: `my password may be ${declared}` }).slice(0, -1);
    const events = [...progress, { type: "error", sequence_number: progress.length, error: raw.error },
      { type: `response.${status}`, sequence_number: progress.length + 1, response: resource }];
    const sseBody = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
    const stream = client(async () => new Response(sseBody, { headers: { "content-type": "text/event-stream" } }),
      { responses: { maximumDepth: 64, maximumResponseBytes: Buffer.byteLength(sseBody) } });
    const publicErrors: LLMError[] = [];
    await assert.rejects(async () => {
      for await (const event of stream.stream(request)) if (event.type === "error") publicErrors.push(event.error);
    }, error => error instanceof LLMError && error.code === "llm_quota_exhausted" && !error.retryable && !error.message.includes(declared));
    assert.equal(publicErrors.length, 1); assert.ok(publicErrors[0]!.message.includes("Unable to finish"));
    assert.ok(!JSON.stringify(publicErrors).includes(declared));
    assert.ok(!JSON.stringify(publicErrors[0]!.safeDetails).includes("credit_balance_exhausted"));
  }
});

test("Native observation masks opaque subtrees and progress payloads until complete resource context", () => {
  const hidden = "ordinary opaque bytes";
  for (const wrapper of [
    (items: unknown[]) => ({ object: "response", id: "resp", model: "m", output: items }),
    (items: unknown[]) => ({ object: "list", data: items, first_id: null, last_id: null, has_more: false }),
  ]) {
    const raw = wrapper([{ type: "reasoning", id: "rs", encrypted_content: { piece: hidden } },
      { type: "program", id: "prog", fingerprint: hidden },
      { type: "function_call_output", call_id: "call", output: [{ type: "input_file", file_data: [hidden] }, { type: "input_image", image_url: { hidden } }] }]);
    assert.ok(!JSON.stringify(observeResponseProtocol(raw, { limits: TEST_TRANSPORT })).includes(hidden));
  }
  const declared = "later88xyz", events = [
    { type: "response.output_text.delta", sequence_number: 1, delta: credential.slice(0, 8) },
    { type: "response.output_text.delta", sequence_number: 2, delta: credential.slice(8) },
    { type: "response.output_item.done", sequence_number: 3, item: { type: "message", content: [{ type: "output_text", text: declared }] } },
    { type: "response.output_text.done", sequence_number: 4, text: `my password may be ${declared}` },
    { type: `response.${declared}`, sequence_number: 5, item_id: declared, response_id: declared, stream_id: declared, status: declared, [declared]: "safe" },
    { type: declared, sequence_number: 6, [declared]: declared },
    { type: "response.output_text.delta", sequence_number: declared, output_index: { value: declared } },
  ];
  const observed = events.map(event => observeResponseProtocol(event, { limits: TEST_TRANSPORT }));
  const rendered = JSON.stringify(observed);
  for (const value of [credential.slice(0, 8), credential.slice(8), declared]) assert.ok(!rendered.includes(value));
  assert.deepEqual(observed.slice(0, 6), [1, 2, 3, 4, 5, 6].map(sequence_number => ({ sequence_number })));
});

test("Observation preserves canonical native usage fields and masks arbitrary numeric credentials", () => {
  const usage = { input_tokens: 10, output_tokens: 4, total_tokens: 14,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 3 }, output_tokens_details: { reasoning_tokens: 0 } };
  const observed = observeResponseProtocol({ ...responseResource({ usage }), metadata: { api_key: 123456789, authorization: false } }, { limits: TEST_TRANSPORT }) as any;
  assert.deepEqual(observed.usage, usage);
  // A numeric or boolean value under a credential key is masked like a string.
  assert.equal(observed.metadata.api_key, "[REDACTED:token]"); assert.equal(observed.metadata.authorization, "[REDACTED:token]");
  assert.equal((observeResponseProtocol({ object: "response.input_tokens", input_tokens: 12 }, { limits: TEST_TRANSPORT }) as any).input_tokens, 12);
});

test("Observation key aliases remain finite, collision-free and credential-free", () => {
  // A KNOWN secret used as a key (the harness's own: registered explicitly —
  // a client no longer registers its user's key process-wide, CRED-F2).
  registerKnownSecret(credential, "observation-fixture");
  const raw = { object: "response", model: "m", output: [], metadata: { password: "field:0" },
    ["field:0"]: "first", [credential]: "second", "0": "numeric witness", "[REDACTED:token]:field:0": "third" };
  const observed = observeResponseProtocol(raw, { limits: TEST_TRANSPORT }) as any;
  assert.ok(!JSON.stringify(observed).includes("field:0")); assert.ok(!JSON.stringify(observed).includes(credential));
  assert.equal(Object.keys(observed).length, Object.keys(raw).length);
  for (const value of ["first", "numeric witness"]) assert.ok(Object.values(observed).includes(value));
  assert.ok(!Object.values(observed).includes("second") && !Object.values(observed).includes("third"), "sensitive key values are opaque while every distinct entry survives");
});

test("Queue inherited-property labels obey exact private caps and public collision scopes stay distinct", async () => {
  for (const label of Object.getOwnPropertyNames(Object.prototype)) {
    const q = new RequestQueue({ maxConcurrency: 2 }, { perModel: { [label]: 1 }, perProvider: { [label]: 1 } });
    const identity = { model: label, provider: label }; await q.acquire(identity);
    const pending = q.acquire(identity); await Promise.resolve();
    assert.equal(q.perModelActiveCount(label), 1); assert.equal(q.snapshot().pending, 1);
    q.release(identity); await pending; q.release(identity); assert.equal(q.activeCount(), 0);
  }
  const a = "scope-alpha-credential", b = "scope-bravo-credential";
  registerKnownSecret(a); registerKnownSecret(b);
  const q = new RequestQueue({ maxConcurrency: 4 }, { perModel: { [a]: 1, [b]: 2 } });
  await q.acquire({ model: b, provider: "ordinary" });
  const view = q.snapshot(); assert.equal(Object.keys(view.perModelLimits).length, 2);
  const activeLabel = Object.keys(view.perModelActive)[0]!; assert.equal(view.perModelLimits[activeLabel], 2);
  assert.ok(!JSON.stringify(view).includes(a)); assert.ok(!JSON.stringify(view).includes(b));
  q.release({ model: b, provider: "ordinary" });
  const stats = new LLMStatsCollector(); stats.recordRequest(a, a); stats.recordRequest(b, b);
  assert.equal(Object.values(stats.snapshot(false).byModel).reduce((sum, row) => sum + row.requests, 0), 2);
});

test("Public target reads and repeated held registration leave registry generation unchanged", () => {
  const c = client(async () => responseJsonResponse({ content: "safe" }));
  // Held once (a client no longer registers its user's key process-wide,
  // CRED-F2); the REPEATS below are the subject.
  registerKnownSecret(credential);
  const generation = knownSecretRegistryGeneration();
  for (let index = 0; index < 3; index++) { c.getCurrentTarget(); registerKnownSecret(credential); }
  assert.equal(knownSecretRegistryGeneration(), generation);
});

test("Short and registry-overflow credentials protect HTTP, SSE, header keys and simultaneous clients", async () => {
  const added: string[] = [];
  try {
    for (let index = 0; ; index++) {
      const outcome = registerKnownSecret(`capacity-fixture-${index}-credential`, `capacity-fixture:${index}`);
      if (!outcome.registered) { assert.equal(outcome.reason, "registry-full"); break; }
      added.push(outcome.label);
    }
    for (const held of ["lookup88xyz", "second-full-registry-credential"]) {
      const c = client(async () => new Response(JSON.stringify({ error: { message: `echo ${held}` } }), { status: 401 }), { headers: { Authorization: `Bearer ${held}` } });
      await assert.rejects(c.create(request), error => error instanceof LLMError && error.code === "llm_auth_error" && !error.message.includes(held));
      const sse = client(async () => new Response(`data: ${JSON.stringify({ type: "error", sequence_number: 0, error: { code: "credit_balance_exhausted", type: "insufficient_quota", message: `echo ${held}`, param: null } })}\n\n`, { headers: { "content-type": "text/event-stream" } }), { headers: { "X-Api-Key": held } });
      await assert.rejects(async () => { for await (const _event of sse.stream(request)) { /* drain */ } },
        error => error instanceof LLMError && error.code === "llm_quota_exhausted" && !error.message.includes(held));
      const headers = extractResponseHeaders(new Response(null, { headers: { [held]: "safe", "x-request-id": held } }), { ...TEST_TRANSPORT, capturedResponseHeaders: [held, "x-request-id"] }, heldValues("test", [held]));
      assert.ok(!JSON.stringify(headers).includes(held)); assert.equal(Object.keys(headers).length, 2);
    }
    const remote = "server77xyz";
    const headers = extractResponseHeaders(new Response(null, { headers: { "x-password": remote, "x-request-id": remote, [remote]: "safe" } }), { ...TEST_TRANSPORT, capturedResponseHeaders: ["x-password", "x-request-id", remote] });
    assert.ok(!JSON.stringify(headers).includes(remote)); assert.equal(Object.keys(headers).length, 3);
  } finally { for (const label of added) forgetKnownSecret(label); }
});

test("a captured URL-valued header (a signed Location, Link or Referer) is judged by the ONE header rule, never the key-name rule: its token never survives; a credential-free header stays readable", () => {
  const signed = "https://objects.example.net/release-asset/1?X-Amz-Signature=0123abcd&token=t0k3n";
  const headers = extractResponseHeaders(new Response(null, { headers: { location: signed, link: `<${signed}>; rel="next"`, referer: signed, "content-type": "application/json" } }),
    { ...TEST_TRANSPORT, capturedResponseHeaders: ["location", "link", "referer", "content-type"] });
  assert.equal(Object.keys(headers).length, 4);
  assert.ok(!JSON.stringify(headers).includes("0123abcd") && !JSON.stringify(headers).includes("t0k3n"), JSON.stringify(headers));
  assert.equal(headers["content-type"], "application/json");
});

test("Provider diagnostic recording context uses the same held credential projection as event labels", async () => {
  const { withRecordingContext } = await import("../../src/timeline/recording-context.ts");
  const held = "a7", sink = createCollectingSink();
  configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, enabled: true, level: "debug", categories: ["llm"], sinks: { ...DEBUG_CONFIG_DEFAULTS.sinks, enabledSinks: [sink.kind] } }, [sink]);
  try {
    const c = client(async () => responseJsonResponse({ content: "done" }), { apiKey: held });
    await withRecordingContext({ actor: { kind: "fixture", id: held }, runId: held }, () => c.create(request));
    for (const message of ["provider_http_started", "provider_http_finished", "response_succeeded"]) {
      const event = sink.events.find(event => event.message === message); assert.ok(event, message);
      assert.equal(JSON.stringify(event).includes(held), false, `${message} must redact ambient context`);
    }
  } finally { resetDebugSystem(); }
});

test("Optional provider context projection faults cannot block dispatch or retain HTTP deadlines", async t => {
  const { withRecordingContext } = await import("../../src/timeline/recording-context.ts");
  const { getDebugSignals } = await import("../../src/shared/debug/debug-system.ts");
  mockDoorClock(t);
  const sink = createCollectingSink(); let calls = 0;
  configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, enabled: true, level: "debug", categories: ["llm"], sinks: { ...DEBUG_CONFIG_DEFAULTS.sinks, enabledSinks: [sink.kind] } }, [sink]);
  try {
    const c = client(async () => { calls++; return responseJsonResponse({ content: "done" }); }, { timeout: 100 });
    const actor = { kind: "fixture", get id(): string { throw new Error("private-context-fault"); } };
    // Every abort signal the request path listens on (the door's request lifetime among them), through the real transport.
    const watched = new Set<AbortSignal>(), listen = EventTarget.prototype.addEventListener;
    t.mock.method(EventTarget.prototype, "addEventListener", function (this: EventTarget, type: string, ...rest: unknown[]) {
      if (this instanceof AbortSignal && type === "abort") watched.add(this);
      return (listen as (...a: unknown[]) => void).call(this, type, ...rest);
    });
    assert.equal((await withRecordingContext({ actor }, () => c.create(request))).content, "done");
    (EventTarget.prototype.addEventListener as unknown as { mock: { restore(): void } }).mock.restore();
    assert.equal(calls, 1); assert.equal(c.getQueue().active, 0); assert.equal(getDebugSignals().bestEffortFailures, 3);
    assert.ok(watched.size > 0, "the request path listened on its lifetime");
    t.mock.timers.tick(1000); assert.deepEqual([...watched].filter(entry => entry.aborted), []);
    assert.equal(JSON.stringify(sink.events).includes("private-context-fault"), false);
  } finally { resetDebugSystem(); }
});

test("Response body declarations govern public headers in the same HTTP envelope", async () => {
  const secret = "envelope77xyz";
  const c = client(async () => responseJsonResponse({ content: `my password is ${secret}` }, { headers: { "x-request-id": secret } }));
  const result = await c.create(request);
  assert.equal(JSON.stringify(result.headers).includes(secret), false);
  assert.ok(result.response.output.length > 0, "private native evidence remains available");
});

test("Incomplete streams never publish textual headers without terminal declaration context", async () => {
  const secret = "pending77xyz", events = responseEvents({ id: "partial", content: "later" }).slice(0, 2);
  const c = client(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "x-request-id": secret } }));
  const publicHeaders: unknown[] = [];
  await assert.rejects(async () => { for await (const event of c.stream(request)) if (event.type === "headers") publicHeaders.push(event.headers); }, { code: "llm_streaming_error" });
  assert.equal(JSON.stringify(publicHeaders).includes(secret), false);
});

test("Non-success error diagnostics share sensitive header declarations without changing classification", async () => {
  const secret = "refused77xyz";
  const c = client(async () => Response.json({ error: { code: "credit_balance_exhausted", type: "insufficient_quota", message: secret } }, { status: 429, headers: { "x-password": secret } }),
    { responses: { capturedResponseHeaders: ["x-password"] } });
  await assert.rejects(c.create(request), error => {
    assert.ok(error instanceof LLMError); assert.equal(error.code, "llm_quota_exhausted"); assert.equal(error.retryable, false);
    assert.equal(error.message.includes(secret), false); return true;
  });
});


test("Native envelope shares declarations across every header and body field without changing private evidence", () => {
  const secret = "sensitive44word", marker = "[REDACTED:";
  for (const direction of ["header", "body"] as const) {
    const body = responseResource({ model: secret, content: `copy ${secret}`, toolCalls: [{ id: secret, type: "function", function: { name: secret, arguments: JSON.stringify({ [secret]: secret, ordinary: secret }) } }] });
    const headers = { "x-request-id": secret, [secret]: "ordinary", "x-api-key": direction === "header" ? secret : "unrelated", "x-ratelimit-remaining-tokens": "0" };
    if (direction === "body") body.metadata = { password: secret };
    const before = JSON.stringify(body), generation = knownSecretRegistryGeneration();
    const view = observeResponseEnvelope({ headers, response: body }, { limits: TEST_TRANSPORT, selectedHeaders: ["x-request-id", secret, "x-ratelimit-remaining-tokens"] });
    assert.equal(JSON.stringify(view).includes(secret), false);
    assert.equal(JSON.stringify(body), before); assert.equal(knownSecretRegistryGeneration(), generation);
    assert.equal(Object.keys(view.headers).length, 3); assert.equal(view.headers["x-ratelimit-remaining-tokens"], "0");
    assert.equal(Object.hasOwn(view.headers, "x-api-key"), false, "unselected header participates only in the detector context");
    assert.ok(view.display!.content.includes(marker)); assert.ok(view.display!.toolCalls[0]!.function.arguments.includes(marker));
    assert.equal(Object.isFrozen(view), true); assert.equal(Object.isFrozen(view.headers), true); assert.equal(Object.isFrozen(view.display!.toolCalls[0]!.function), true);
  }
});

test("Envelope root keys remain trusted while native child aliases never become execution authority", () => {
  for (const held of ["response", "headers", "model", "output", "type"]) {
    const body = responseResource({ model: "visible-engine", content: `the ${held} value`, toolCalls: [{ id: "ordinary-id", type: "function", function: { name: "ordinary-name", arguments: JSON.stringify({ [held]: "kept", other: held }) } }] });
    const view = observeResponseEnvelope({ headers: { [held]: "header-value", "0": "existing-key" }, response: body }, { limits: TEST_TRANSPORT, heldCredentials: heldValues("test", [held]) });
    assert.ok(Object.hasOwn(view, "headers")); assert.ok(Object.hasOwn(view, "response"));
    // Both keys survive (the alias never erases the existing "0"); an unknown header's VALUE is masked by the one header rule.
    assert.equal(Object.keys(view.headers).length, 2); assert.equal(view.headers["0"], "[REDACTED:token]");
    assert.equal(view.display!.model, "visible-engine"); assert.equal(view.display!.toolCalls[0]!.function.name, "ordinary-name");
    assert.equal((body.output as unknown[]).length, 2, "native output remains exact even if the public output key is aliased");
    assert.equal(JSON.parse(view.display!.toolCalls[0]!.function.arguments).other, "[REDACTED:token]");
  }
});

test("Native semantic normalization gives resource identity precedence over event-looking extensions", () => {
  const opaque = "opaque native value", forged = "ordinary extension evidence";
  const inner = { object: "response", usage: { input_tokens: 123 }, output: [{ type: "reasoning", encrypted_content: forged }] };
  const body = responseResource({ content: "visible", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 4 }, output_tokens_details: { reasoning_tokens: 0 } } });
  body.type = "response.completed"; body.response = inner;
  (body.output as Record<string, unknown>[]).push({ type: "reasoning", encrypted_content: opaque, summary: [] });
  for (const malformed of [opaque, { nested: opaque }]) (body.output as Record<string, unknown>[]).push({ type: "agent_message", author: "main", recipient: "worker", content: [{ type: "encrypted_content", encrypted_content: malformed }] });
  const views = [observeResponseProtocol(body, { limits: TEST_TRANSPORT }), observeResponseProtocol({ type: "response.completed", sequence_number: 7, response: body }, { limits: TEST_TRANSPORT }),
    observeResponseEnvelope({ headers: {}, response: body }, { limits: TEST_TRANSPORT }).response];
  for (const view of views) {
    const value = view as Record<string, any>;
    const resource = value.object === "response" ? value : value.response;
    assert.equal(resource.usage.input_tokens, 1); assert.equal(resource.usage.input_tokens_details.cache_write_tokens, 4);
    assert.equal(resource.response.usage.input_tokens, "[REDACTED:token]", "nested extension cannot claim native numeric telemetry");
    assert.equal(resource.response.output[0].encrypted_content, forged, "extension type cannot claim an opaque slot");
    assert.equal(JSON.stringify(resource).includes(opaque), false, "native opaque parts mask their entire value");
    assert.equal(resource.output[0].content[0].text, "visible");
  }
});

test("Queued or unknown-status native envelopes withhold every public string", async () => {
  for (const status of ["queued", "in_progress", undefined] as const) {
    const body = responseResource({ status: status ?? "completed", model: "withheld-model", content: "withheld-text" });
    if (status === undefined) delete body.status;
    const c = client(async () => new Response(JSON.stringify(body), { headers: { "x-request-id": "withheld-header" } }));
    let receipt = "";
    const result = await c.create(request, { onResponseReceipt(value) { receipt = value.responseId; } });
    assert.equal(receipt, body.id); assert.deepEqual(result.response, body); assert.deepEqual(result.observation, { headers: {} }); assert.deepEqual(result.headers, {});
    assert.equal(result.status, status);
  }
});


test("Envelope budgets count both native subtrees once without charging trusted wrapper depth", () => {
  const body = { nested: { text: "é" } }, headers = { "content-language": "é" }; // a credential-free header: shown as it is
  const maximumResponseBytes = Buffer.byteLength(JSON.stringify(body)), maximumResponseHeaderBytes = Buffer.byteLength(JSON.stringify(headers));
  const limits = { maximumResponseBytes, maximumResponseHeaderBytes, maximumDepth: 2, maximumNodes: 5 };
  assert.deepEqual(observeResponseEnvelope({ headers, response: body }, { limits }), { headers, response: body, diagnostic: {} });
  for (const override of [{ maximumResponseBytes: maximumResponseBytes - 1 }, { maximumResponseHeaderBytes: maximumResponseHeaderBytes - 1 }, { maximumNodes: 4 }, { maximumDepth: 1 }]) {
    assert.throws(() => observeResponseEnvelope({ headers, response: body }, { limits: { ...limits, ...override } }),
      { code: "maximumNodes" in override || "maximumDepth" in override ? "responses_observation_structure_invalid" : "responses_observation_too_large" });
  }
  // Only the outer trusted wrapper is exempt. Retained evidence's array and
  // native event envelopes participate in the aggregate context budget.
  const evidence = [{ nested: { text: "earlier" } }];
  const withEvidence = { ...limits, maximumResponseBytes: maximumResponseBytes + Buffer.byteLength(JSON.stringify(evidence)), maximumNodes: 9 };
  assert.throws(() => observeResponseEnvelope({ headers, response: body, evidence }, { limits: withEvidence }), { code: "responses_observation_structure_invalid" });
  const admitted = observeResponseEnvelope({ headers, response: body, evidence }, { limits: { ...withEvidence, maximumDepth: 3 } });
  assert.deepEqual(admitted.response, body); assert.deepEqual(admitted.headers, headers); assert.equal(Object.hasOwn(admitted, "evidence"), false);
  assert.throws(() => observeResponseEnvelope({ headers, response: body, evidence }, { limits: { ...withEvidence, maximumDepth: 3, maximumNodes: 8 } }), { code: "responses_observation_structure_invalid" });
});

test("Untrusted HTTP error shape cannot spoof native display or change quota classification", async () => {
  const secret = "quota44private", raw = { object: "response", status: "completed", model: secret, output: [null],
    metadata: { password: secret }, error: { code: "credit_balance_exhausted", message: secret } };
  const c = client(async () => new Response(JSON.stringify(raw), { status: 429, headers: { "x-request-id": secret, "x-password": "credit_balance_exhausted" } }));
  await assert.rejects(c.create(request), error => error instanceof LLMError && error.code === "llm_quota_exhausted" && !error.retryable &&
    !JSON.stringify({ message: error.message, details: error.safeDetails }).includes(secret) && !JSON.stringify(error.safeDetails).includes("credit_balance_exhausted"));
  assert.throws(() => observeResponseEnvelope({ headers: {}, response: raw }, { limits: TEST_TRANSPORT }), error => error instanceof LLMError && error.errorType === "invalid-response");
});

test("Whole-envelope header capture has its own configurable byte ceiling", async () => {
  const body = responseResource({ content: "ok" });
  const response = () => new Response(JSON.stringify(body), { headers: { "x-hidden-large": "x".repeat(80) } });
  let calls = 0;
  const c = client(async () => { calls++; return response(); }, { responses: { maximumResponseHeaderBytes: 20 } });
  await assert.rejects(c.create(request), error => error instanceof LLMError && error.message.includes("headers") && error.message.includes("byte bound"));
  assert.equal(calls, 1); assert.equal(c.getQueue().active, 0);
});


test("Failed terminal envelopes retain declarations from omitted partial native progress", async () => {
  const secret = "omitted44value", events = responseEvents({ chunks: ["my password may be ", secret] });
  const partial = events.slice(0, events.findIndex(event => event.type === "response.output_text.done"));
  const resource = responseResource({ status: "failed", output: [] }); resource.error = { code: "server_error", message: "Request failed" };
  const wire = [...partial, { type: "response.failed", sequence_number: partial.length, response: resource }];
  const c = client(async () => new Response(wire.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "x-request-id": secret } }));
  let observed: unknown;
  await assert.rejects(async () => { for await (const chunk of c.stream(request)) if (chunk.type === "response") observed = chunk.observation; }, { code: "llm_response_failed" });
  assert.ok(observed); assert.equal(JSON.stringify(observed).includes(secret), false);
});


test("Native identity display and tree use the same context-specific detector", async () => {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha512").update("response identifier deterministic fixture").digest("hex");
  for (const prefix of ["resp_", "rs_"]) for (const length of [24, 48, 68, 80]) {
    const identity = prefix + hash.slice(0, length);
    const body = responseResource({ model: identity, toolCalls: [{ id: identity, type: "function", function: { name: identity, arguments: "{}" } }] });
    const view = observeResponseEnvelope({ headers: {}, response: body }, { limits: TEST_TRANSPORT });
    const tree = view.response as { model: string; output: { name: string; call_id: string }[] };
    assert.equal(view.display!.model, tree.model); assert.equal(view.display!.model, identity);
    assert.equal(view.display!.toolCalls[0]!.id, tree.output[0]!.call_id); assert.equal(view.display!.toolCalls[0]!.id, identity);
    assert.equal(view.display!.toolCalls[0]!.function.name, tree.output[0]!.name); assert.equal(tree.output[0]!.name, identity);
    // The contrast: unheld, the identity IS in the view; held, it is not.
    assert.ok(JSON.stringify(view).includes(identity));
    assert.equal(JSON.stringify(observeResponseEnvelope({ headers: {}, response: body }, { limits: TEST_TRANSPORT, heldCredentials: heldValues("test", [identity]) })).includes(identity), false);
  }
});

test("Short held credentials mask embedded text under their set's floor, and aliases fail closed within structural budget", () => {
  const envelope = { headers: { "x-request-id": "prefix-a7-suffix", "x-trace": "a7" }, response: responseResource({ content: "prefix a7 suffix" }) };
  // The operator's lowest floor (1): a two-character held value is masked wherever it appears.
  assert.equal(JSON.stringify(observeResponseEnvelope(envelope, { limits: TEST_TRANSPORT, heldCredentials: heldValues("test", ["a7"], 1) })).includes("a7"), false);
  // The default floor (a2b-design H1): replaced where a whole string equals it, never searched for inside text.
  const view = JSON.stringify(observeResponseEnvelope(envelope, { limits: TEST_TRANSPORT, heldCredentials: heldValues("test", ["a7"]) }));
  assert.ok(view.includes("prefix a7 suffix"), "ordinary text is not shredded by a short held value");
  assert.ok(!view.includes('"a7"'), "a whole string equal to it is still replaced");
  // The SET's floor governs the observation too, above the declared population's own (6): a configured 10 leaves an 8-character value unmatched in text.
  const raised = JSON.stringify(observeResponseEnvelope({ headers: {}, response: responseResource({ content: "prefix abcdef12 suffix" }) }, { limits: TEST_TRANSPORT, heldCredentials: heldValues("test", ["abcdef12"], 10) }));
  assert.ok(raised.includes("prefix abcdef12 suffix"), "the observation obeys the held set's floor");
  assert.throws(() => observeResponseEnvelope({ headers: { secret: "value" } }, { heldCredentials: heldValues("test", ["secret", ..."0123456789"], 1), limits: { maximumNodes: 20 } }), { code: "responses_observation_aliases_unavailable" });
});

test("Earlier structured native declarations remain in terminal envelope context", async () => {
  for (const source of ["created", "error"] as const) {
    const secret = "earlier44private", events = [...responseEvents({ content: "safe" })];
    if (source === "created") (events[0] as { response: Record<string, unknown> }).response.metadata = { password: secret };
    else events.splice(2, 0, { type: "error", code: "server_error", param: null, message: `my password may be ${secret}` });
    const wire = events.map((event, sequence_number) => ({ ...event, sequence_number }));
    const c = client(async () => new Response(wire.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "x-request-id": secret } }));
    let view: unknown; const publicErrors: string[] = [];
    try { for await (const chunk of c.stream(request)) { if (chunk.type === "response") view = chunk.observation; if (chunk.type === "error") publicErrors.push(chunk.error.message); } }
    catch (error) { assert.ok(source === "error" && error instanceof LLMError); publicErrors.push(error.message); }
    assert.ok(view); assert.equal(JSON.stringify([view, publicErrors]).includes(secret), false);
  }
});

test("Native failure taxonomy remains primary when its public observation is unavailable", async () => {
  const resource = responseResource({ status: "failed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } });
  resource.error = { code: "credit_balance_exhausted", message: "private failing diagnostic" };
  let deep: unknown = {}; for (let i = 0; i < 12; i++) deep = { nested: deep }; resource.extension = deep;
  const c = client(async () => new Response(JSON.stringify(resource)), { responses: { maximumDepth: 6 } });
  let captured: unknown;
  await assert.rejects(c.create(request, { onResponseEvidence(value) { captured = value.response; throw new Error("secondary callback error"); } }),
    error => error instanceof LLMError && error.code === "llm_quota_exhausted" && !error.retryable && !error.message.includes("private failing"));
  assert.deepEqual(captured, resource); assert.equal(c.getStats().totalTokens.total, 3);
});


test("Error body read failures use the same complete header declaration context", async () => {
  const secret = "read44private";
  const c = client(async () => new Response(failingBody(`copied ${secret}`), { status: 400, headers: { "x-password": secret } }));
  await assert.rejects(c.create(request), error => error instanceof LLMError && error.code === "llm_invalid_response" && error.safeDetails.readFailure === "body_read_failed" && !error.message.includes(secret));
});


test("Header capture counts empty-object syntax before any body is read", async () => {
  const { captureResponseHeaders } = await import("../../src/shared/llm/provider-http.ts");
  assert.throws(() => captureResponseHeaders(new Response(null), 1), error => error instanceof LLMError && error.code === "llm_invalid_response" && error.message.includes("headers"));
  assert.deepEqual(captureResponseHeaders(new Response(null), 2), {});
});
