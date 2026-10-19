import assert from "node:assert/strict";
import test from "node:test";
import { messagesToResponseInput, responseTranscriptGroups, serializeResponseTranscript, type ResponseTranscriptMessage } from "../../src/shared/llm/response-transcript.ts";
import type { ResponseItem } from "../../src/shared/llm/responses.ts";
import { isLLMError } from "../../src/shared/llm/errors.ts";

test("native transcript preserves complete output and original caller identity over display mirrors", () => {
  const items: ResponseItem[] = [
    { type: "reasoning", id: "reason", summary: [], encrypted_content: "encrypted" },
    { type: "function_call", call_id: "original", name: "read", arguments: "{}", caller: { type: "program", caller_id: "program" } },
  ];
  assert.deepEqual(messagesToResponseInput([
    { role: "user", content: "Read" },
    { role: "assistant", content: "display only", responseItems: items,
      tool_calls: [{ id: "wrong", function: { name: "wrong", arguments: "{}" } }] },
    { role: "tool", content: "result", tool_call_id: "original" },
  ]), [{ type: "message", role: "user", content: "Read" }, ...items,
    { type: "function_call_output", call_id: "original", output: "result", caller: { type: "program", caller_id: "program" } }]);
});

test("native empty output suppresses display mirrors and estimates the identical projection", () => {
  for (const items of [[], [{ type: "reasoning", id: "rs", summary: [], encrypted_content: "opaque", future: { value: "kept" } }]]) {
    const history = [{ role: "assistant", content: "display must not be counted or sent", responseItems: items,
      tool_calls: [{ id: "wrong", function: { name: "wrong", arguments: "large".repeat(200) } }] }];
    assert.deepEqual(messagesToResponseInput(history), items);
    assert.equal(serializeResponseTranscript(history), JSON.stringify(items));
  }
});

test("native transcript preserves partial evidence for estimates but refuses its replay", () => {
  const history = [{ role: "assistant", content: "", responseItems: [], responseReplayBlocked: true }];
  assert.equal(serializeResponseTranscript(history), "[]");
  assert.throws(() => messagesToResponseInput(history), error => isLLMError(error) && error.code === "llm_invalid_response" &&
    error.safeDetails.protocolCode === "responses_history_unready");
});

const call = (id: string): ResponseTranscriptMessage => ({ role: "assistant", content: "", responseItems: [
  { type: "function_call", call_id: id, name: "read", arguments: "{}" },
] });
const result = (id: string): ResponseTranscriptMessage => ({ role: "tool", content: "", tool_call_id: id });
const user = (content: string): ResponseTranscriptMessage => ({ role: "user", content });

test("native dependency spans keep intervening chronology and overlapping pairs while separating adjacent groups", () => {
  const history = [user("before"), call("a"), user("steering"), call("b"), result("a"), user("more"), result("b"),
    call("c"), result("c"), user("after")];
  assert.deepEqual(responseTranscriptGroups(history), [[0], [1, 2, 3, 4, 5, 6], [7, 8], [9]]);
  assert.deepEqual(responseTranscriptGroups([call("a"), result("a"), call("b"), result("b")]), [[0, 1], [2, 3]]);
});

test("program caller and local shell output use protocol call identities across turns", () => {
  const history = [
    { role: "assistant", content: "", responseItems: [{ type: "program", call_id: "program", id: "display", fingerprint: "opaque" }] },
    user("steering"),
    { role: "assistant", content: "", responseItems: [{ type: "function_call", call_id: "call", name: "read", arguments: "{}", caller: { type: "program", caller_id: "program" } }] },
    result("call"),
    { role: "assistant", content: "", responseItems: [{ type: "local_shell_call", call_id: "shell", id: "different" }] },
    { role: "tool", content: "", responseItems: [{ type: "local_shell_call_output", id: "shell", output: "" }] },
  ];
  assert.deepEqual(responseTranscriptGroups(history), [[0, 1, 2, 3], [4, 5]]);
});

test("approval workflows and local item references connect only their documented identity roles", () => {
  const native = (item: ResponseItem): ResponseTranscriptMessage => ({ role: "assistant", content: "", responseItems: [item] });
  const history = [
    native({ type: "mcp_approval_request", id: "approval", name: "read", server_label: "server", arguments: "{}" }),
    user("I approve"),
    native({ type: "mcp_approval_response", id: "response-own-id", approval_request_id: "approval", approve: true }),
    native({ type: "mcp_call", id: "mcp", approval_request_id: "approval", name: "read", server_label: "server", arguments: "{}" }),
    native({ type: "reasoning", id: "local", summary: [] }), user("later"), native({ type: "item_reference", id: "local" }),
    native({ type: "item_reference", id: "provider-held" }),
    call("approval"), result("approval"),
    native({ type: "extension", call_id: "approval" }),
  ];
  assert.deepEqual(responseTranscriptGroups(history), [[0, 1, 2, 3], [4, 5, 6], [7], [8, 9], [10]]);
  assert.deepEqual(messagesToResponseInput([history[7]!]), [{ type: "item_reference", id: "provider-held" }]);
});
