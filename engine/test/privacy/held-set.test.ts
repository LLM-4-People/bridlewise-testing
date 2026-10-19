/**
 * THE TYPED HELD SET (`src/privacy/held-set.ts`, cred-final §2.1) and the
 * guarantee it carries: a value one operation holds reaches NONE of the
 * operation's egress or storage paths — not the display text only, but the
 * tool-call arguments a consumer executes, streams and records, the raw
 * resource and the native events (SECC-V-A3: a shapeless 32-hex key echoed
 * in a tool call used to cross raw).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { EMPTY_HELD_SET, heldSetOf, heldValues } from "../../src/privacy/held-set.ts";
import { redactForLLMContext as redactContent } from "../../src/privacy/redaction-engine.ts";
import { SharedLLMClient } from "../../src/shared/llm/client.ts";
import { ALL_ERROR_TYPES } from "../../src/shared/llm/errors.ts";
import { responseEvents } from "../support/mock-provider.ts";
import { address, serve } from "../support/loopback-upstream.ts";

const MARK = "[REDACTED:secret]";
const shapeless = (): string => randomUUID().replaceAll("-", "");

test("held set: labelled, frozen, merged without losing labels; values deduplicated", () => {
  const a = heldValues("provider:a", ["k1", "k2"]), b = heldSetOf([{ label: "request:credential", value: "k2" }, { label: "request:credential", value: "k3" }]);
  const merged = a.merge(b);
  assert.deepEqual([...merged.values()], ["k1", "k2", "k3"]);
  assert.deepEqual(merged.entries.map((entry) => entry.label), ["provider:a", "provider:a", "request:credential", "request:credential"]);
  assert.ok(Object.isFrozen(merged) && Object.isFrozen(merged.entries) && Object.isFrozen(merged.entries[0]));
  assert.equal(a.merge(undefined), a);
  assert.equal(EMPTY_HELD_SET.merge(a), a);
  assert.equal(heldValues("x", ["", ""]).size, 0, "an empty value holds nothing");
});

test("held set: scrub masks every escape form of a held value; everything else is untouched", () => {
  const key = shapeless();
  assert.ok(redactContent(`x ${key} y`).includes(key), "no detector fires on this shape: only the held set can mask it");
  const held = heldValues("provider:p", [key]);
  for (const form of [key, Buffer.from(key).toString("base64")]) assert.equal(held.scrub(`before ${form} after`, MARK), `before ${MARK} after`, form);
  const quoted = `p@ss"w/rd-${key}`, quotedHeld = heldValues("provider:q", [quoted]);
  for (const form of [JSON.stringify(quoted).slice(1, -1), JSON.stringify(JSON.stringify(quoted).slice(1, -1)).slice(1, -1), encodeURIComponent(quoted)]) {
    assert.equal(quotedHeld.scrub(`before ${form} after`, MARK), `before ${MARK} after`, form);
  }
  const structured = held.scrubStrings({ command: `echo ${key}`, [key]: [key, 7, null], nested: { deep: `${key}${key}` } }, MARK);
  assert.ok(!JSON.stringify(structured).includes(key));
  assert.deepEqual(structured, { command: `echo ${MARK}`, [MARK]: [MARK, 7, null], nested: { deep: `${MARK}${MARK}` } });
});

test("held set: the streaming scrubber masks a value split at EVERY cut point, and releases the rest", () => {
  const key = shapeless();
  const held = heldValues("provider:p", [key]);
  const text = `{"command":"echo ${key} > notes.txt"}`;
  for (let cut = 1; cut < text.length; cut += 1) {
    for (const split of [[text.slice(0, cut), text.slice(cut)], [...text.slice(0, cut)].concat(text.slice(cut))]) {
      const scrubber = held.streamingScrubber(MARK);
      const out = split.map((piece) => scrubber.push(piece)).join("") + scrubber.flush();
      assert.equal(out, `{"command":"echo ${MARK} > notes.txt"}`, `cut at ${cut}`);
    }
  }
  const empty = EMPTY_HELD_SET.streamingScrubber(MARK);
  assert.equal(empty.push("abc"), "abc", "nothing held: every piece is released at once");
});

test("SECC-V-A3: a shapeless provider key echoed in a streamed tool call, split across deltas, never leaves the client raw", async () => {
  const key = shapeless();
  const args = JSON.stringify({ command: `echo ${key} > notes.txt` });
  const cut = args.indexOf(key) + 13;
  const events = responseEvents({ content: `here it is ${key}`, toolCalls: [{ id: "call_1", type: "function", function: { name: "execute_command", arguments: args } }] })
    .flatMap((event) => event["type"] !== "response.function_call_arguments.delta" ? [event]
      : [{ ...event, delta: args.slice(0, cut) }, { ...event, delta: args.slice(cut) }])
    .map((event, index) => ({ ...event, sequence_number: index }));
  serve(() => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
  const client = new SharedLLMClient({ baseUrl: address("https://echo.test/v1"), apiKey: key, allowPrivateAddress: true, providerId: "echo", model: "test-model", timeout: 2_000,
    maxRetries: Object.fromEntries(ALL_ERROR_TYPES.map((type) => [type, 0])), backoff: { baseMs: 1, maxMs: 2, factor: 2, jitter: 0 } });
  const chunks: unknown[] = [];
  for await (const chunk of client.stream({ input: "hello", model: "test-model" })) chunks.push(chunk);
  const serialized = JSON.stringify(chunks);
  assert.ok(!serialized.includes(key), "no chunk (deltas, done arguments, raw resource, native events) carries the held key");
  assert.ok(!serialized.includes(key.slice(0, 13)) || !serialized.includes(key.slice(13)), "not even its two halves");
  const deltas = chunks.filter((chunk): chunk is { type: "tool_call_delta"; arguments: string } => (chunk as { type: string }).type === "tool_call_delta").map((chunk) => chunk.arguments).join("");
  assert.equal(deltas, JSON.stringify({ command: `echo ${MARK} > notes.txt` }), "the assembled deltas are the masked arguments, whole");
  const done = chunks.find((chunk) => (chunk as { type: string }).type === "tool_call_done") as { arguments: string } | undefined;
  assert.equal(done?.arguments, deltas, "the finished call carries the same masked arguments");
});

test("held set: a value split ACROSS text parts (two output items, two content parts) is masked in every part it covers", () => {
  const key = shapeless(), cut = 16;
  const held = heldValues("request:credential", [key]);
  const resource = { id: "resp", output: [
    { type: "message", content: [{ type: "output_text", text: `pre ${key.slice(0, cut)}` }] },
    { type: "message", content: [{ type: "output_text", text: `${key.slice(cut)} post` }, { type: "output_text", text: "unrelated" }] },
  ] };
  const masked = held.scrubAcrossTextParts(resource, MARK);
  const serialized = JSON.stringify(masked);
  assert.ok(!serialized.includes(key.slice(0, cut)) && !serialized.includes(key.slice(cut)), serialized);
  assert.deepEqual(masked.output.map((item) => item.content.map((part) => part.text)), [[`pre ${MARK}`], [`${MARK} post`, "unrelated"]]);
  assert.equal(resource.output[0]!.content[0]!.text, `pre ${key.slice(0, cut)}`, "the input is not mutated");
});

test("SECD-C6: the terminal resource and the completed event never carry either half of a key split across two output items", async () => {
  const key = shapeless(), cut = 16;
  const a = responseEvents({ content: `pre ${key.slice(0, cut)}` }), b = responseEvents({ content: `${key.slice(cut)} post` });
  const itemsA = (a.at(-1)!["response"] as { output: unknown[] }).output, itemsB = (b.at(-1)!["response"] as { output: unknown[] }).output;
  const completed = { ...a.at(-1)!, response: { ...(a.at(-1)!["response"] as object), output: [...itemsA, { ...(itemsB[0] as object), id: "msg_second" }] } };
  const middleA = a.slice(2, -1);
  const middleB = b.slice(2, -1).map((event) => JSON.parse(JSON.stringify(event).replaceAll("msg_fixture", "msg_second").replaceAll('"output_index":0', '"output_index":1')) as Record<string, unknown>);
  const events = [a[0]!, a[1]!, ...middleA, ...middleB, completed].map((event, index) => ({ ...event, sequence_number: index }));
  serve(() => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
  const client = new SharedLLMClient({ baseUrl: address("https://echo.test/v1"), apiKey: key, allowPrivateAddress: true, providerId: "echo", model: "test-model", timeout: 2_000,
    maxRetries: Object.fromEntries(ALL_ERROR_TYPES.map((type) => [type, 0])), backoff: { baseMs: 1, maxMs: 2, factor: 2, jitter: 0 } });
  const terminal: unknown[] = [];
  for await (const chunk of client.stream({ input: "hello", model: "test-model" })) {
    const type = (chunk as { type: string }).type;
    if (type === "response" || (type === "response_event" && (chunk as { event: { type?: string } }).event.type === "response.completed")) terminal.push(chunk);
  }
  assert.ok(terminal.length > 0, "the terminal resource was observed");
  const serialized = JSON.stringify(terminal);
  const at = Math.max(serialized.indexOf(key.slice(0, cut)), serialized.indexOf(key.slice(cut)));
  assert.ok(at < 0, `neither half: ...${serialized.slice(Math.max(0, at - 300), at + 60)}`);
});
