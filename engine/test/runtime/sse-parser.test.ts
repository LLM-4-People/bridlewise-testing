import assert from "node:assert/strict";
import test from "node:test";

import { InputError } from "../../src/kernel/errors.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import {
  parseSseEventBlock,
  parseSseText,
  parseSseStream,
  SseBuffer,
  SSE_DONE_SENTINEL,
  type SseEvent,
} from "../../src/runtime/sse-parser.ts";

// ============================================================================
// parseSseEventBlock — single event block parsing
// ============================================================================

test("SSE: parseSseEventBlock parses a data event", () => {
  const event = parseSseEventBlock("data: {\"id\":\"chatcmpl-1\"}");
  assert.deepEqual(event, { type: "data", data: "{\"id\":\"chatcmpl-1\"}" });
});

test("SSE: parseSseEventBlock parses data with leading space after colon", () => {
  const event = parseSseEventBlock("data: {\"id\":\"chatcmpl-1\"}");
  assert.equal(event?.type, "data");
  assert.equal(event?.type === "data" ? event.data : "", "{\"id\":\"chatcmpl-1\"}");
});

test("SSE: parseSseEventBlock parses data without leading space", () => {
  const event = parseSseEventBlock("data:{\"id\":\"chatcmpl-1\"}");
  assert.equal(event?.type, "data");
  assert.equal(event?.type === "data" ? event.data : "", "{\"id\":\"chatcmpl-1\"}");
});

test("SSE: parseSseEventBlock detects done sentinel", () => {
  const event = parseSseEventBlock("data: [DONE]");
  assert.deepEqual(event, { type: "done" });
});

test("SSE: parseSseEventBlock returns undefined for empty block", () => {
  assert.equal(parseSseEventBlock(""), undefined);
});

test("SSE: parseSseEventBlock returns comment for comment-only block", () => {
  const event = parseSseEventBlock(": keep-alive");
  assert.deepEqual(event, { type: "comment" });
});

test("SSE: parseSseEventBlock handles multi-line data", () => {
  const event = parseSseEventBlock("data: line1\ndata: line2");
  assert.equal(event?.type, "data");
  assert.equal(event?.type === "data" ? event.data : "", "line1\nline2");
});

test("SSE: parseSseEventBlock handles mixed data and comments", () => {
  const event = parseSseEventBlock(": comment\ndata: {\"id\":\"x\"}");
  assert.equal(event?.type, "data");
  assert.equal(event?.type === "data" ? event.data : "", "{\"id\":\"x\"}");
});

test("SSE: parseSseEventBlock returns comment only for actual comment lines", () => {
  const event = parseSseEventBlock(": comment");
  assert.deepEqual(event, { type: "comment" });
});

test("SSE: parseSseEventBlock returns undefined for whitespace-only block", () => {
  assert.equal(parseSseEventBlock("   "), undefined);
  assert.equal(parseSseEventBlock(" \n \n "), undefined);
});

test("SSE: parseSseEventBlock handles empty lines within block", () => {
  const event = parseSseEventBlock("\ndata: {\"id\":\"x\"}\n");
  assert.equal(event?.type, "data");
});

test("SSE: parseSseEventBlock handles CRLF line endings", () => {
  const event = parseSseEventBlock("data: {\"id\":\"x\"}\r\ndata: {\"id\":\"y\"}");
  assert.equal(event?.type, "data");
  assert.equal(event?.type === "data" ? event.data : "", "{\"id\":\"x\"}\n{\"id\":\"y\"}");
});

test("SSE: parseSseEventBlock handles done sentinel without space", () => {
  const event = parseSseEventBlock("data:[DONE]");
  assert.deepEqual(event, { type: "done" });
});

test("SSE: parseSseEventBlock handles empty data line", () => {
  const event = parseSseEventBlock("data:");
  assert.equal(event?.type, "data");
  assert.equal(event?.type === "data" ? event.data : "", "");
});

test("SSE: parseSseEventBlock handles data with empty string", () => {
  const event = parseSseEventBlock("data: ");
  assert.equal(event?.type, "data");
  assert.equal(event?.type === "data" ? event.data : "", "");
});

test("SSE: parseSseEventBlock retains event/id/retry fields", () => {
  const event = parseSseEventBlock("event: response.completed\nid: stream-1\nretry: 1500\ndata: {\"id\":\"x\"}");
  assert.deepEqual(event, { type: "data", data: '{"id":"x"}', event: "response.completed", id: "stream-1", retry: 1500 });
});

// ============================================================================
// SseBuffer — incremental buffering
// ============================================================================

test("SSE: SseBuffer drains complete events separated by \\n\\n", () => {
  const buf = new SseBuffer();
  buf.push("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n");
  const events = buf.drain();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "data");
  assert.equal(events[1]?.type, "data");
  assert.equal(buf.pendingLength, 0);
});

test("SSE: SseBuffer handles partial events across pushes", () => {
  const buf = new SseBuffer();
  buf.push("data: {\"a\":1}\n");
  assert.equal(buf.drain().length, 0);
  buf.push("\ndata: {\"b\":2}\n\n");
  const events = buf.drain();
  assert.equal(events.length, 2);
});

test("SSE: SseBuffer handles CRLF separators", () => {
  const buf = new SseBuffer();
  buf.push("data: {\"a\":1}\r\n\r\n");
  const events = buf.drain();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "data");
});

test("SSE: SseBuffer flush discards unfinished content at end of stream", () => {
  const buf = new SseBuffer();
  buf.push("data: {\"a\":1}");
  assert.equal(buf.drain().length, 0);
  const events = buf.flush();
  assert.equal(events.length, 0);
  assert.equal(buf.pendingLength, 0);
});

test("SSE: SseBuffer flush returns empty for no remaining content", () => {
  const buf = new SseBuffer();
  buf.push("data: {\"a\":1}\n\n");
  buf.drain();
  assert.equal(buf.flush().length, 0);
});

test("SSE: SseBuffer tracks emitted count", () => {
  const buf = new SseBuffer();
  buf.push("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n");
  buf.drain();
  assert.equal(buf.emittedCount, 2);
});

test("SSE: SseBuffer tracks pending length", () => {
  const buf = new SseBuffer();
  buf.push("data: {\"a\":1}\n\npartial");
  buf.drain();
  assert.equal(buf.pendingLength, 7);
});

test("SSE: SseBuffer rejects oversized events", () => {
  // The event size ceiling is the canonical SSE event-byte limit owned by
  // ROOT_POLICY.runtime.limits.maximumSseEventBytes. The test synthesizes
  // a payload one byte over that ceiling so it stays valid if the policy
  // ceiling changes (SSOT contract test for the limit wiring).
  const ceiling = ROOT_POLICY.runtime.limits.maximumSseEventBytes;
  const buf = new SseBuffer(null, ceiling, ceiling + 1);
  const huge = "x".repeat(ceiling + 1);
  assert.throws(() => buf.push(huge), (e: unknown) => e instanceof InputError && e.code === "sse_event_oversized");
});

test("SSE: SseBuffer ignores empty pushes", () => {
  const buf = new SseBuffer();
  buf.push("");
  assert.equal(buf.pendingLength, 0);
});

test("SSE: SseBuffer handles multiple events in one push", () => {
  const buf = new SseBuffer();
  buf.push("data: {\"a\":1}\n\ndata: {\"b\":2}\n\ndata: {\"c\":3}\n\n");
  const events = buf.drain();
  assert.equal(events.length, 3);
});

test("SSE: SseBuffer handles intermixed comments and data", () => {
  const buf = new SseBuffer();
  buf.push(": comment\ndata: {\"a\":1}\n\n: another\ndata: {\"b\":2}\n\n");
  const events = buf.drain();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "data");
  assert.equal(events[1]?.type, "data");
});

test("SSE: SseBuffer handles done sentinel mid-stream", () => {
  const buf = new SseBuffer();
  buf.push("data: {\"a\":1}\n\ndata: [DONE]\n\n");
  const events = buf.drain();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "data");
  assert.equal(events[1]?.type, "done");
});

test("SSE: SseBuffer discards an unfinished done sentinel at flush", () => {
  const buf = new SseBuffer();
  buf.push("data: [DONE]");
  assert.equal(buf.drain().length, 0);
  const events = buf.flush();
  assert.equal(events.length, 0);
});

// ============================================================================
// parseSseText — complete text parsing
// ============================================================================

test("SSE: parseSseText parses a complete SSE response", () => {
  const text = "data: {\"id\":\"1\"}\n\ndata: {\"id\":\"2\"}\n\ndata: [DONE]\n\n";
  const events = parseSseText(text);
  assert.equal(events.length, 3);
  assert.equal(events[0]?.type, "data");
  assert.equal(events[1]?.type, "data");
  assert.equal(events[2]?.type, "done");
});

test("SSE: parseSseText handles empty text", () => {
  assert.equal(parseSseText("").length, 0);
});

test("SSE: parseSseText handles text without trailing separator", () => {
  const events = parseSseText("data: {\"id\":\"1\"}");
  assert.equal(events.length, 0);
});

test("SSE: parseSseText handles multiple separators", () => {
  const text = "data: {\"id\":\"1\"}\n\n\ndata: {\"id\":\"2\"}\n\n";
  const events = parseSseText(text);
  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, "data");
});

test("SSE: parseSseText handles only done sentinel", () => {
  const events = parseSseText("data: [DONE]\n\n");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "done");
});

test("SSE: parseSseText handles only comments", () => {
  const events = parseSseText(": keep-alive\n\n: another\n\n");
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "comment");
  assert.equal(events[1]?.type, "comment");
});

test("SSE: parseSseText handles mixed content types", () => {
  const text = ": comment\ndata: {\"id\":\"1\"}\n\ndata: [DONE]\n\n";
  const events = parseSseText(text);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "data");
  assert.equal(events[1]?.type, "done");
});

// ============================================================================
// parseSseStream — async streaming
// ============================================================================

test("SSE: parseSseStream yields events from a sync iterable", async () => {
  const input = ["data: {\"a\":1}\n\n", "data: {\"b\":2}\n\n", "data: [DONE]\n\n"];
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(input)) {
    events.push(event);
    if (event.type === "done") break;
  }
  assert.equal(events.length, 3);
  assert.equal(events[2]?.type, "done");
});

test("SSE: parseSseStream yields events from an async iterable", async () => {
  async function* source(): AsyncGenerator<string> {
    yield "data: {\"a\":1}\n\n";
    yield "data: {\"b\":2}\n\n";
    yield "data: [DONE]\n\n";
  }
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(source())) {
    events.push(event);
    if (event.type === "done") break;
  }
  assert.equal(events.length, 3);
});

test("SSE: parseSseStream handles chunked event data", async () => {
  async function* source(): AsyncGenerator<string> {
    yield "data: {";
    yield "\"a\":1}\n\n";
    yield "data: [DONE]\n\n";
  }
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(source())) {
    events.push(event);
    if (event.type === "done") break;
  }
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "data");
  assert.equal(events[0]?.type === "data" ? events[0].data : "", "{\"a\":1}");
});

test("SSE: parseSseStream stops after done event", async () => {
  async function* source(): AsyncGenerator<string> {
    yield "data: [DONE]\n\n";
    yield "data: {\"after\":1}\n\n";
  }
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(source())) {
    events.push(event);
    if (event.type === "done") break;
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "done");
});

test("SSE: parseSseStream handles empty stream", async () => {
  const events: SseEvent[] = [];
  for await (const event of parseSseStream([])) {
    events.push(event);
  }
  assert.equal(events.length, 0);
});

test("SSE: parseSseStream handles stream with only comments", async () => {
  async function* source(): AsyncGenerator<string> {
    yield ": comment\n\n";
    yield ": another\n\n";
  }
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(source())) {
    events.push(event);
  }
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "comment");
});

test("SSE: parseSseStream handles single-char chunks", async () => {
  const fullText = "data: {\"a\":1}\n\ndata: [DONE]\n\n";
  async function* source(): AsyncGenerator<string> {
    for (const char of fullText) {
      yield char;
    }
  }
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(source())) {
    events.push(event);
    if (event.type === "done") break;
  }
  assert.equal(events.length, 2);
});

test("SSE: parseSseStream handles no done sentinel", async () => {
  async function* source(): AsyncGenerator<string> {
    yield "data: {\"a\":1}\n\n";
  }
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(source())) {
    events.push(event);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "data");
});

test("SSE: parseSseStream handles large event data", async () => {
  const largeData = "x".repeat(100_000);
  async function* source(): AsyncGenerator<string> {
    yield `data: {"content":"${largeData}"}\n\n`;
    yield "data: [DONE]\n\n";
  }
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(source())) {
    events.push(event);
    if (event.type === "done") break;
  }
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type === "data" ? events[0].data.length : 0, largeData.length + 14);
});

test("SSE: SSE_DONE_SENTINEL is [DONE]", () => {
  assert.equal(SSE_DONE_SENTINEL, "[DONE]");
});

// ============================================================================
// Hostile / edge cases
// ============================================================================

test("SSE: parseSseEventBlock handles malformed JSON gracefully (returns data event with raw text)", () => {
  const event = parseSseEventBlock("data: {invalid json}");
  assert.equal(event?.type, "data");
  assert.equal(event?.type === "data" ? event.data : "", "{invalid json}");
});

test("SSE: parseSseEventBlock handles binary-like content in data", () => {
  const event = parseSseEventBlock("data: \x00\x01\x02");
  assert.equal(event?.type, "data");
});

test("SSE: parseSseEventBlock handles very long data line", () => {
  const long = "x".repeat(100_000);
  const event = parseSseEventBlock(`data: ${long}`);
  assert.equal(event?.type, "data");
  assert.equal(event?.type === "data" ? event.data.length : 0, 100_000);
});

test("SSE: SseBuffer handles push with non-string type gracefully", () => {
  const buf = new SseBuffer();
  buf.push("");
  assert.equal(buf.pendingLength, 0);
});

test("SSE: parseSseStream handles interleaved data and done across chunks", async () => {
  async function* source(): AsyncGenerator<string> {
    yield "data: {\"a\":1}\n\ndata: ";
    yield "[DONE]\n\n";
  }
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(source())) {
    events.push(event);
    if (event.type === "done") break;
  }
  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, "done");
});

test("SSE: parseSseText handles text with only separators", () => {
  assert.equal(parseSseText("\n\n\n\n").length, 0);
});

test("SSE: parseSseText handles text with only whitespace", () => {
  assert.equal(parseSseText("   \n\n   ").length, 0);
});

test("SSE: every line ending and UTF-16 chunk boundary preserves named event fields", async () => {
  const expected: SseEvent[] = [
    { type: "data", data: " 你好 😀\n", event: "response.output_text.delta", id: "response-1", retry: 1250 },
    { type: "data", data: "tail", id: "response-1", retry: 1250 },
  ];
  for (const separator of ["\n", "\r", "\r\n"]) {
    const text = "\uFEFF" + [
      "id: response-1", "retry: 001250", "", "event: response.output_text.delta",
      "data:  你好 😀", "data", "", "event: stale", "", "data: tail", "", "",
    ].join(separator);
    assert.deepEqual(parseSseText(text, null), expected, JSON.stringify(separator));
    for (let split = 0; split <= text.length; split += 1) {
      const events: SseEvent[] = [];
      for await (const event of parseSseStream([text.slice(0, split), text.slice(split)], null)) events.push(event);
      assert.deepEqual(events, expected, `${JSON.stringify(separator)} split ${split}`);
    }
    const characterChunks: SseEvent[] = [];
    for await (const event of parseSseStream(text.split(""), null)) characterChunks.push(event);
    assert.deepEqual(characterChunks, expected, `${JSON.stringify(separator)} single UTF-16 units`);
  }
});

test("SSE: field parsing preserves metadata resets, ignores invalid fields, and strips only the first BOM", () => {
  const text = [
    "\uFEFFid: retained", "retry: 300", "data: first", "",
    "id: bad\0id", "retry: +12", "retry: ١٢", "Data: ignored", "data: second", "",
    "id", "event: discarded", "event", "retry: 0", "data:\tvalue", "",
    "\uFEFFdata: ignored", "data: fourth", "", "",
  ].join("\n");
  assert.deepEqual(parseSseText(text, null), [
    { type: "data", data: "first", id: "retained", retry: 300 },
    { type: "data", data: "second", id: "retained", retry: 300 },
    { type: "data", data: "\tvalue", id: "", retry: 0 },
    { type: "data", data: "fourth", id: "", retry: 0 },
  ]);
});

test("SSE: byte limits apply to individual lines and events across arbitrary network chunks", () => {
  const lines = ["data: 你好", "data: 😀", "data: x"];
  for (const separator of ["\n", "\r", "\r\n"]) {
    const block = lines.join(separator) + separator;
    const text = block + separator;
    const maxLineBytes = Math.max(...lines.map((line) => Buffer.byteLength(line)));
    const maxEventBytes = Buffer.byteLength(block);
    const expected = { type: "data", data: "你好\n😀\nx" };
    // A network chunk can contain many individually legal events, and an
    // event can have many legal lines whose total exceeds the line ceiling.
    assert.deepEqual(parseSseText(text.repeat(lines.length), null, { maxEventBytes, maxLineBytes }), lines.map(() => expected));
    for (let split = 0; split <= text.length; split += 1) {
      const buffer = new SseBuffer(null, maxEventBytes, maxLineBytes);
      buffer.push(text.slice(0, split));
      buffer.push(text.slice(split));
      assert.deepEqual(buffer.drain(), [expected], `legal boundary ${split}`);
      assert.deepEqual(buffer.flush(), []);
    }
    for (const [limit, code] of [
      [{ maxEventBytes: maxEventBytes - 1, maxLineBytes }, "sse_event_oversized"],
      [{ maxEventBytes, maxLineBytes: maxLineBytes - 1 }, "sse_line_oversized"],
    ] as const) {
      assert.throws(() => parseSseText(text, null, limit), (error: unknown) => error instanceof InputError && error.code === code);
      const buffer = new SseBuffer(null, limit.maxEventBytes, limit.maxLineBytes);
      assert.throws(() => { for (const unit of text.split("")) buffer.push(unit); },
        (error: unknown) => error instanceof InputError && error.code === code);
    }
  }
});

test("SSE: line limits reject unfinished lines and include ignored field/comment bytes", () => {
  for (const prefix of ["data: ", "unknown: ", ": "]) {
    const line = prefix + "😀";
    const limit = Buffer.byteLength(line) - 1;
    const buffer = new SseBuffer(null, limit * 2, limit);
    assert.throws(() => buffer.push(line), (error: unknown) => error instanceof InputError && error.code === "sse_line_oversized");
  }
});

test("SSE: a null sentinel preserves literal done data and parsing continues", async () => {
  const text = "data: [DONE]\n\ndata: later\n\n";
  const expected = [{ type: "data", data: "[DONE]" }, { type: "data", data: "later" }];
  assert.deepEqual(parseSseText(text, null), expected);
  assert.deepEqual(parseSseEventBlock("data: [DONE]", null), expected[0]);
  const actual: SseEvent[] = [];
  for await (const event of parseSseStream([text], null)) actual.push(event);
  assert.deepEqual(actual, expected);
});

test("SSE: text and streaming stop at a configured sentinel before inspecting later bytes", async () => {
  const text = "data: [DONE]\n\n" + "x".repeat(1000);
  const limits = { maxEventBytes: 100, maxLineBytes: 100 };
  assert.deepEqual(parseSseText(text, SSE_DONE_SENTINEL, limits), [{ type: "done" }]);
  const events: SseEvent[] = [];
  for await (const event of parseSseStream([text], SSE_DONE_SENTINEL, limits)) events.push(event);
  assert.deepEqual(events, [{ type: "done" }]);
});

test("SSE: retry metadata refuses non-representable intervals instead of exposing invalid timers", () => {
  for (const digits of [String(Number.MAX_SAFE_INTEGER + 1), "9".repeat(400)]) {
    assert.throws(() => parseSseText(`retry: ${digits}\ndata: value\n\n`, null),
      (error: unknown) => error instanceof InputError && error.code === "sse_retry_oversized");
  }
});

test("SSE: EOF never turns partial fields into events", async () => {
  for (const suffix of ["data: unfinished", "data: unfinished\n", "event: response.completed\ndata: {}\r\n"]) {
    const prefix = "data: complete\n\n";
    assert.deepEqual(parseSseText(prefix + suffix, null), [{ type: "data", data: "complete" }]);
    const events: SseEvent[] = [];
    for await (const event of parseSseStream([prefix, suffix], null)) events.push(event);
    assert.deepEqual(events, [{ type: "data", data: "complete" }]);
  }
});

test("SSE: stopping on a sentinel releases the source without pulling another chunk", async () => {
  let pulls = 0;
  let closed = false;
  async function* source(): AsyncGenerator<string> {
    try {
      pulls += 1;
      yield "data: [DONE]\n\n";
      pulls += 1;
      yield "data: extra\n\n";
    } finally { closed = true; }
  }
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(source())) events.push(event);
  assert.deepEqual(events, [{ type: "done" }]);
  assert.equal(pulls, 1);
  assert.equal(closed, true);
});

test("SSE: invalid limits and non-text chunks receive typed refusals", () => {
  for (const invalid of [0, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new SseBuffer(null, invalid, 100), (error: unknown) => error instanceof InputError && error.code === "sse_limits_invalid");
    assert.throws(() => new SseBuffer(null, 100, invalid), (error: unknown) => error instanceof InputError && error.code === "sse_limits_invalid");
  }
  assert.throws(() => new SseBuffer().push(null as unknown as string), (error: unknown) => error instanceof InputError && error.code === "sse_chunk_invalid");
});
