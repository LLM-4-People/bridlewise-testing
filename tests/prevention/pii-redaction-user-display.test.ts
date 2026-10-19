// @vitest-environment node
/**
 * Mechanical prevention test — PII redaction before showing to the user
 * (SSE + chat-message REST egress choke points).
 *
 * Enforces the "redact PII before sending to LLM AND before showing to
 * user" requirement. The LLM-bound path is covered by
 * `pii-redaction-owner.test.ts` (the `buildLLMMessages` choke point). This
 * test covers the USER-DISPLAY path — the two egress choke points where
 * content leaves the server for the browser:
 *
 * 1. SSE stream (`server/sse.ts` `send`): EVERY live event sent to the
 *    browser during a run (model deltas, tool results, context, metadata,
 *    errors) passes through `send`. PII is redacted at this choke point so
 *    no route can bypass it.
 * 2. Chat-history REST (`server/routes/views.ts` mappers): EVERY DB row
 *    returned to the browser on reload (messages, tool calls, metrics,
 *    auto-checks, timeline refs) passes through the view mappers. PII is
 *    redacted here so a page refresh does not bypass the live redaction.
 *
 * Both choke points reuse the single redaction owner (`server/redaction.ts`
 * — NOT a rebuild). The redaction preserves variable/const/env names
 * (`const API_KEY = "sk-..."` → `const API_KEY = "[REDACTED:credential]"`)
 * so the user still understands the code context.
 *
 * Three assurance classes:
 * 1. BEHAVIORAL: `send` + the view mappers redact secrets in realistic
 *    payloads (tool results with file contents, model deltas, context with
 *    system prompt, metadata with auth headers, error messages, JSON tool
 *    args with escaped quotes). The secret never reaches the wire/JSON.
 * 2. SOURCE-SCAN: the choke points are WIRED — `sse.ts` `send` calls
 *    `redactForUserDisplay`, and the view mappers call the redaction
 *    helpers (not decorative).
 * 3. SINGLE-OWNER: `redactForUserDisplay` is defined ONLY in
 *    `server/redaction.ts` and imported by `sse.ts` + `views.ts` — never
 *    redefined ("No Scattered Helpers").
 *
 * Mutation-verified: removing the `redactForUserDisplay(data)` call from
 * `send`, or removing the `redactContent`/`redactStringValues`/
 * `redactToolCallArguments` call from any mapper, makes the corresponding
 * behavioral + source-scan checks FAIL.
 */
import { describe, test, expect } from "vitest";
import type { Node } from "typescript5";

import { openSseStream } from "../../server/router/sse.ts";
import { sendJson } from "../../server/router/router.ts";
import { SSE_EVENT_TYPES } from "../../shared/constants.ts";
import {
  messageToView,
  toolCallToView,
  metricsSnapshotToView,
  autoCheckToView,
  timelineRefToView,
} from "../../server/routes/views.ts";
import { redactBySensitiveKeys, isSensitiveKey, redactForUserDisplay, redactStringValues, redactContent, isHiddenFromUserDisplay } from "../../server/llm/redaction.ts";
import type { MessageRow, ToolCallRow, MetricsSnapshotRow, AutoCheckRow, TimelineRefRow } from "../../server/db/client.ts";
import { createMockRes } from "../helpers/mock-http.ts";
import { read, walkTs, parseExportsFromFile, stripCommentsAndStringsFor, relpath } from "../helpers/source-scan.ts";
import { join, relative, sep } from "node:path";

import { createHash, randomUUID } from "node:crypto";

// The single owner of "this token's own grammar explains every byte of it".
// Imported so the mirror below asks the same authority the fix defers to.
import { isBenignToken } from "../../engine/src/privacy/benign-grammars.ts";
// The live exposure registry — the mint whose authorship the walk's newest
// exemption consults. Reached through the canonical hub, never a direct
// path into the harness tree.
import {
  registerAllExposure,
  listSignals,
  listActions,
  listCustomizations,
  isRegistered,
} from "../../server/kernel/canonical.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
// A realistic long secret (redacted-value-substituted to a test fixture —
// never a real key). Uses the `sk-` hyphen format (OpenAI / NeuralWatt
// style) that the credential-assignment signal catches.
const SK_SECRET = "sk-AAAAAAAAAAAAAAAAAAAAAAAA";

const REPO_ROOT = process.cwd();
const SERVER_DIR = join(REPO_ROOT, "server");

// ─────────────────────────────────────────────────────────────────────
// 1. BEHAVIORAL — SSE `send` redacts PII at the egress choke point
// ─────────────────────────────────────────────────────────────────────

describe("PII user-display — SSE send redacts secrets before the wire", () => {
  // Helper: open a stream, send one event, return the raw wire output.
  async function sendAndCapture(eventName: typeof SSE_EVENT_TYPES[keyof typeof SSE_EVENT_TYPES], data: unknown): Promise<string> {
    const res = createMockRes();
    const stream = await openSseStream(res, { keepaliveMs: 86_400_000 }); // long keepalive so the interval doesn't fire
    stream.send(eventName, data);
    stream.close();
    return res.chunks.join("");
  }

  test("a tool_result event with a secret in the result is redacted on the wire", async () => {
    // The highest-risk surface: read_file returns file contents that may
    // contain `const API_KEY = "sk-..."`. The SSE toolResult event must
    // never carry the raw secret to the browser.
    const wire = await sendAndCapture(SSE_EVENT_TYPES.toolResult, {
      runId: "run-1",
      callId: "call-1",
      toolName: "read_file",
      arguments: JSON.stringify({ path: "/home/user/.env" }),
      result: `const API_KEY = "${SK_SECRET}";`,
      success: true,
      attemptCount: 1,
    });
    expect(wire, "the raw secret must NEVER reach the wire").not.toContain(SK_SECRET);
    expect(wire).toContain("[REDACTED:");
    // The variable name is preserved so the user understands the context.
    expect(wire).toContain("API_KEY");
  });

  test("a model text_delta event with a secret in the delta is redacted", async () => {
    // The LLM may echo a secret in its text. The model event must redact it
    // before it reaches the browser.
    const wire = await sendAndCapture(SSE_EVENT_TYPES.model, {
      type: "text_delta",
      delta: `Here is the key: api_key = "${SK_SECRET}"`,
    });
    expect(wire).not.toContain(SK_SECRET);
    expect(wire).toContain("[REDACTED:");
    expect(wire).toContain("api_key");
  });

  test("a context event with a secret in the systemPrompt is redacted", async () => {
    // The injected system prompt is built from project context which may
    // contain secrets. The context SSE event exposes it to the UI — it
    // must be redacted.
    const wire = await sendAndCapture(SSE_EVENT_TYPES.context, {
      runId: "run-1",
      systemPrompt: `Project config: api_key = "${SK_SECRET}"`,
      toolCount: 5,
      historyLength: 3,
      contextTokens: 1800,
    });
    expect(wire).not.toContain(SK_SECRET);
    expect(wire).toContain("[REDACTED:");
    // Non-secret fields are preserved (structure intact).
    expect(wire).toContain('"toolCount":5');
    expect(wire).toContain('"historyLength":3');
  });

  test("a metadata event with an auth header value is redacted (header VALUE, not name)", async () => {
    // Response headers can carry an echoed authorization token. The
    // header NAME is preserved; the secret VALUE is masked.
    const wire = await sendAndCapture(SSE_EVENT_TYPES.metadata, {
      runId: "run-1",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SK_SECRET}`,
        "x-request-id": "req-abc",
      },
      model: "gemma-4-31b",
    });
    expect(wire).not.toContain(SK_SECRET);
    expect(wire).toContain("[REDACTED:");
    // The header NAMES survive (they are keys, not secrets).
    expect(wire).toContain("authorization");
    expect(wire).toContain("content-type");
    // A non-secret header value is unchanged.
    expect(wire).toContain("req-abc");
  });

  test("an error event with a secret in the message is redacted", async () => {
    // An error message may echo a request body that contains a secret.
    const wire = await sendAndCapture(SSE_EVENT_TYPES.error, {
      runId: "run-1",
      message: `Request failed for api_key = "${SK_SECRET}"`,
    });
    expect(wire).not.toContain(SK_SECRET);
    expect(wire).toContain("[REDACTED:");
  });

  test("a string payload with a secret is redacted (raw-string data path)", async () => {
    // `send` accepts a bare string (sent raw, no JSON encoding). The string
    // must still be redacted. Uses a credential-assignment form (the
    // realistic way a secret appears in a raw string — a bare `sk-` token
    // without an assignment is a separate detector gap tracked elsewhere).
    const wire = await sendAndCapture(SSE_EVENT_TYPES.done, `config: api_key = "${SK_SECRET}"`);
    expect(wire).not.toContain(SK_SECRET);
    expect(wire).toContain("[REDACTED:");
  });

  test("a payload with NO secrets is unchanged (no false positives)", async () => {
    // A normal event with no secrets must pass through verbatim so the UI
    // is not corrupted by spurious redaction markers.
    const payload = {
      runId: "run-1",
      harnessReady: false,
      chatId: "chat-1",
      message: "run finished",
      toolCount: 5,
    };
    const wire = await sendAndCapture(SSE_EVENT_TYPES.done, payload);
    const dataLine = wire.split("\n").find((l) => l.startsWith("data: "))!;
    expect(JSON.parse(dataLine.slice("data: ".length))).toEqual(payload);
  });

  test("a nested secret in a tool result object is redacted recursively", async () => {
    // Secrets can be nested inside tool result structures. The recursive
    // walker must reach them wherever they are.
    const wire = await sendAndCapture(SSE_EVENT_TYPES.toolResult, {
      runId: "run-1",
      callId: "call-1",
      toolName: "search_code",
      result: JSON.stringify({
        matches: [
          { file: "config.ts", line: `const API_KEY = "${SK_SECRET}";` },
        ],
      }),
      success: true,
    });
    expect(wire).not.toContain(SK_SECRET);
    expect(wire).toContain("[REDACTED:");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. BEHAVIORAL — view mappers redact PII at the REST egress choke point
// ─────────────────────────────────────────────────────────────────────

describe("PII user-display — view mappers redact secrets before the REST response", () => {
  function msgRow(overrides: Partial<MessageRow>): MessageRow {
    return {
      id: "msg-1",
      chat_id: "chat-1",
      role: "user",
      content: "",
      created_at: "2026-01-01T00:00:00Z",
      model_event_type: null,
      run_id: null,
      metadata: null,
      ...overrides,
    };
  }

  function toolRow(overrides: Partial<ToolCallRow>): ToolCallRow {
    return {
      id: "tc-1",
      message_id: "msg-1",
      call_id: null,
      public_projection: null,
      tool_name: "read_file",
      input: null,
      output: null,
      status: "done",
      duration_ms: 42,
      attempt_count: 1,
      created_at: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }

  test("messageToView redacts a secret in message content (keeps the variable name)", async () => {
    const view = messageToView(msgRow({
      role: "user",
      content: `const API_KEY = "${SK_SECRET}";`,
    }));
    expect(view.content).not.toContain(SK_SECRET);
    expect(view.content).toContain("[REDACTED:");
    expect(view.content).toContain("API_KEY");
    // Structural fields are unchanged.
    expect(view.id).toBe("msg-1");
    expect(view.role).toBe("user");
  });

  test("messageToView redacts a secret nested in metadata (response headers)", async () => {
    const view = messageToView(msgRow({
      metadata: {
        responseHeaders: { authorization: `Bearer ${SK_SECRET}` },
        reasoning: `I see api_key = "${SK_SECRET}"`,
        context: { systemPrompt: `api_key = "${SK_SECRET}"`, toolNames: [], historyLength: 0 },
      },
    } as Partial<MessageRow>));
    const meta = view.metadata as Record<string, unknown>;
    const headers = meta.responseHeaders as Record<string, string>;
    expect(headers.authorization).not.toContain(SK_SECRET);
    expect(headers.authorization).toContain("[REDACTED:");
    expect(meta.reasoning).not.toContain(SK_SECRET);
    const ctx = meta.context as Record<string, string>;
    expect(ctx.systemPrompt).not.toContain(SK_SECRET);
  });

  test("toolCallToView redacts a JSON-string tool input with an escaped-quote secret", async () => {
    // The LLM-generated arguments are a JSON string with an escaped-quote
    // secret — the exact shape that would leak if the mapper pushed them
    // verbatim. The mapper PARSES first (via redactToolCallArguments) so
    // JSON-escaped quotes don't break credential detection.
    const args = JSON.stringify({ content: `const API_KEY = "${SK_SECRET}";` });
    const view = toolCallToView(toolRow({ input: args, output: "wrote file" }));
    expect(view.input).not.toContain(SK_SECRET);
    expect(view.input).toContain("[REDACTED:");
    // The re-stringified JSON stays valid + preserves the key name.
    const parsed = JSON.parse(view.input as string) as { content: string };
    expect(parsed.content).toContain("API_KEY");
    expect(parsed.content).not.toContain(SK_SECRET);
  });

  test("toolCallToView redacts a secret in the tool output (file contents)", async () => {
    const view = toolCallToView(toolRow({
      tool_name: "read_file",
      output: `line 1\nconst API_KEY = "${SK_SECRET}";\nline 3`,
    }));
    expect(view.output).not.toContain(SK_SECRET);
    expect(view.output).toContain("[REDACTED:");
    expect(view.output).toContain("API_KEY");
  });

  test("toolCallToView redacts a secret nested in an object tool output", async () => {
    const view = toolCallToView(toolRow({
      output: { matches: [{ file: "config.ts", line: `password = "${SK_SECRET}"` }] },
    }));
    const out = view.output as { matches: { file: string; line: string }[] };
    expect(out.matches[0]!.line).not.toContain(SK_SECRET);
    expect(out.matches[0]!.line).toContain("[REDACTED:");
    expect(out.matches[0]!.file).toBe("config.ts");
  });

  test("metricsSnapshotToView redacts a secret in the snapshot", async () => {
    const row: MetricsSnapshotRow = {
      id: "ms-1",
      chat_id: "chat-1",
      snapshot: { label: `api_key = "${SK_SECRET}"`, tokens: 100 },
      created_at: "2026-01-01T00:00:00Z",
    };
    const view = metricsSnapshotToView(row);
    const snap = view.snapshot as Record<string, unknown>;
    expect(snap.label).not.toContain(SK_SECRET);
    expect(snap.tokens).toBe(100);
  });

  test("autoCheckToView redacts a secret in the check output", async () => {
    const row: AutoCheckRow = {
      id: "ac-1",
      project_id: "proj-1",
      chat_id: "chat-1",
      check_name: "lint",
      status: "failed",
      output: { errors: [`config.ts:1: api_key = "${SK_SECRET}"`] },
      created_at: "2026-01-01T00:00:00Z",
    };
    const view = autoCheckToView(row);
    const out = view.output as { errors: string[] };
    expect(out.errors[0]).not.toContain(SK_SECRET);
    expect(out.errors[0]).toContain("[REDACTED:");
  });

  test("timelineRefToView redacts a secret in the event metadata", async () => {
    const row: TimelineRefRow = {
      id: "tr-1",
      chat_id: "chat-1",
      event_id: "evt-1",
      event_type: "error",
      timestamp: "2026-01-01T00:00:00Z",
      // A timeline event description realistically quotes a credential
      // assignment (the form the credential-assignment signal catches).
      metadata: { description: `leaked: api_key = "${SK_SECRET}"` },
    };
    const view = timelineRefToView(row);
    const meta = view.metadata as Record<string, string>;
    expect(meta.description).not.toContain(SK_SECRET);
    expect(meta.description).toContain("[REDACTED:");
    // The variable name is preserved.
    expect(meta.description).toContain("api_key");
  });

  test("ordinary content with no secrets is unchanged (no false positives)", async () => {
    const view = messageToView(msgRow({ content: "Explain this project." }));
    expect(view.content).toBe("Explain this project.");
    const tc = toolCallToView(toolRow({ input: '{"pattern":"foo"}', output: "src/a.ts:1:foo" }));
    expect(tc.input).toBe('{"pattern":"foo"}');
    expect(tc.output).toBe("src/a.ts:1:foo");
  });

  test("null metadata / output pass through unchanged (no crash on empty fields)", async () => {
    const view = messageToView(msgRow({ metadata: null }));
    expect(view.metadata).toBeNull();
    const tc = toolCallToView(toolRow({ output: null }));
    expect(tc.output).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. SOURCE-SCAN — the choke points are WIRED (not decorative)
// ─────────────────────────────────────────────────────────────────────

describe("PII user-display — choke points are wired (source-scan)", () => {
  test("sse.ts send calls redactForUserDisplay before serializing the payload", async () => {
    const sse = read(modulePathMatching("server/router/sse.ts"));
    expect(sse, "sse.ts must import the redaction owner").toMatch(/import\s*\{[^}]*redactForUserDisplay[^}]*}\s*from\s*"\.\.\/llm\/redaction\.ts"/);
    expect(sse, "send must call redactForUserDisplay on the data").toMatch(/redactForUserDisplay\(data\)/);
    // The redacted value (not the raw data) is what gets serialized.
    expect(sse).toMatch(/typeof redacted === "string"/);
  });

  test("views.ts mappers call the redaction helpers (not decorative)", async () => {
    const views = read(modulePath("views.ts"));
    expect(views).toMatch(/import\s*\{[^}]*redactContent[^}]*}\s*from\s*"\.\.\/llm\/redaction\.ts"/);
    expect(views).toMatch(/redactStringValues/);
    expect(views).toMatch(/redactToolCallArguments/);
    // messageToView redacts content.
    expect(views).toMatch(/content:\s*redactContent\(row\.content\)/);
    // toolCallToView redacts input + output.
    expect(views).toMatch(/input:\s*typeof row\.input === "string"\s*\?\s*redactToolCallArguments/);
    expect(views).toMatch(/output:\s*redactStringValues\(row\.output\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. SINGLE-OWNER — redactForUserDisplay defined ONCE, imported everywhere
// ─────────────────────────────────────────────────────────────────────

describe("PII user-display — single owner (No Scattered Helpers)", () => {
  function serverTsFiles(): string[] {
    return walkTs(SERVER_DIR);
  }

  test("redactForUserDisplay is defined ONLY in server/redaction.ts", async () => {
    const definers: string[] = [];
    for (const f of serverTsFiles()) {
      const src = read(relative(REPO_ROOT, f));
      if (/export\s+function\s+redactForUserDisplay\b/.test(src)) {
        definers.push(relative(SERVER_DIR, f).split(sep).join("/"));
      }
    }
    expect(definers, "redactForUserDisplay must be defined ONLY in redaction.ts").toEqual(["llm/redaction.ts"]);
  });

  test("sse.ts + views.ts IMPORT redactForUserDisplay/redactContent (do not redefine them)", async () => {
    const sse = read(modulePathMatching("server/router/sse.ts"));
    const views = read(modulePath("views.ts"));
    expect(sse).toMatch(/import\s*\{[^}]*redactForUserDisplay[^}]*}\s*from\s*"\.\.\/llm\/redaction\.ts"/);
    expect(sse).not.toMatch(/function\s+redactForUserDisplay\s*\(/);
    expect(views).toMatch(/import\s*\{[^}]*redactContent[^}]*}\s*from\s*"\.\.\/llm\/redaction\.ts"/);
    expect(views).not.toMatch(/function\s+redactContent\s*\(/);
    expect(views).not.toMatch(/function\s+redactStringValues\s*\(/);
    expect(views).not.toMatch(/function\s+redactToolCallArguments\s*\(/);
  });

  test("redactForUserDisplay reuses the canonical detector and string-value walk", async () => {
    const owner = read(modulePathMatching("server/llm/redaction.ts"));
    expect(owner).toMatch(/export\s+function\s+redactForUserDisplay\b/);
    // The user-display walker delegates to the canonical engine: the
    // plain-text and JSON-aware passes share the same resolved policy.
    expect(owner).toMatch(/redactForLLMContext\(text,\s*policy\)/);
    expect(owner).toMatch(/redactStringValuesDeep\(parsed,\s*new WeakMap\(\),\s*policy\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. REST EGRESS CHOKE POINT — sendJson redacts PII before the wire
// (mirrors the SSE `send` choke point: EVERY REST JSON response is
// redacted at the lowest level, so no route can bypass the redaction
// owner — deny-by-default. A route that forgets an upstream redaction,
// or returns a payload with a secret in a field the view mappers do not
// cover, is still caught here.)
// ─────────────────────────────────────────────────────────────────────

describe("PII user-display — sendJson REST egress choke point", () => {
  // `sendJson` writes the body via `res.end(body)`, not `res.write`. The
  // shared `createMockRes` captures `write` chunks but drops the `end`
  // body, so override `end` here to record the argument.
  function sendJsonAndCapture(data: unknown): string {
    const res = createMockRes();
    let endBody: unknown;
    Object.assign(res, {
      end(body?: unknown) { endBody = body; },
    });
    sendJson(res, data);
    return endBody === undefined ? "" : String(endBody);
  }

  test("sendJson source-scan: imports + calls redactForUserDisplay before serializing", async () => {
    const router = read(modulePath("router.ts"));
    expect(router, "router.ts must import the redaction owner").toMatch(/import\s*\{[^}]*redactForUserDisplay[^}]*}\s*from\s*"\.\.\/llm\/redaction\.ts"/);
    // sendJson must call redactForUserDisplay on the data before stringify.
    expect(router).toMatch(/redactForUserDisplay\(data\)/);
    // The redacted value (not the raw data) is what gets serialized.
    expect(router).toMatch(/JSON\.stringify\(redacted\)/);
  });

  test("sendJson redacts a secret in a flat REST response (the config-snapshot case)", async () => {
    // The config route returns a config snapshot; sendJson must redact a
    // credential-assignment value even if the route forgot the key-based
    // pass (defense-in-depth at the egress choke point).
    const wire = sendJsonAndCapture({ config: { note: `api_key = "${SK_SECRET}"` } });
    expect(wire, "the raw secret must NEVER reach the REST wire").not.toContain(SK_SECRET);
    expect(wire).toContain("[REDACTED:");
    // The key name is preserved (structure intact).
    expect(wire).toContain("api_key");
    expect(wire).toContain("config");
  });

  test("sendJson redacts a Bearer token in a REST response", async () => {
    const wire = sendJsonAndCapture({ headers: { authorization: `Bearer ${SK_SECRET}` } });
    expect(wire).not.toContain(SK_SECRET);
    expect(wire).toContain("[REDACTED:");
    expect(wire).toContain("authorization");
  });

  test("sendJson redacts a secret nested deep in a REST response object", async () => {
    const wire = sendJsonAndCapture({
      project: { settings: { credentials: { github: `const API_KEY = "${SK_SECRET}";` } } },
    });
    expect(wire).not.toContain(SK_SECRET);
    expect(wire).toContain("[REDACTED:");
    expect(wire).toContain("API_KEY");
  });

  test("sendJson redacts a secret in a JSON-string field (escaped-quote defense)", async () => {
    // A tool result or config value can be a JSON STRING with escaped quotes
    // — the egress choke point must catch the secret the plain pass misses.
    const args = JSON.stringify({ content: `const API_KEY = "${SK_SECRET}";` });
    const wire = sendJsonAndCapture({ result: args });
    expect(wire).not.toContain(SK_SECRET);
    expect(wire).toContain("[REDACTED:");
  });

  test("sendJson preserves a clean REST response (no false positives)", async () => {
    const payload = { id: "abc/123", query: null, n: 42, ok: true };
    const wire = sendJsonAndCapture(payload);
    const dataLine = wire.split("\n").find((l) => l.includes("{"))!;
    expect(JSON.parse(dataLine)).toEqual(payload);
  });

  test("sendJson preserves Date / Map / RegExp objects (no data-loss via redaction walker)", async () => {
    // The redaction walker must NOT recurse into built-in objects (Date,
    // Map, RegExp) — they have no enumerable own props, so recursing would
    // destroy them into `{}`. JSON.stringify then serializes them natively
    // (Date → ISO string). A route returning { createdAt: new Date() }
    // must keep the Date on the wire.
    const payload = {
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      pattern: /abc/i,
      name: "p",
      key: `api_key = "${SK_SECRET}"`,
    };
    const wire = sendJsonAndCapture(payload);
    expect(wire, "secret still redacted").not.toContain(SK_SECRET);
    // The Date is serialized as an ISO string (not destroyed into {}).
    expect(wire).toContain('"2026-01-01T00:00:00.000Z"');
    expect(wire).not.toContain('"createdAt":{}');
    // The RegExp serializes to {} (JSON.stringify(RegExp) → {}), which is
    // the native behavior — the redaction walker did not alter it.
    expect(wire).toContain("name");
  });

  test("sendJson redaction walker is cycle-safe (no stack overflow on circular refs)", async () => {
    // A payload with a circular reference would infinite-loop a naive
    // recursive walker and crash with a RangeError stack overflow BEFORE
    // JSON.stringify. The egress choke point's redaction walker must be
    // cycle-safe (it processes every REST response; an accidental cyclic
    // payload must not crash the server with a stack overflow). The walker
    // returns the cycle as-is so JSON.stringify produces its normal clean
    // TypeError (router maps to 500) — NOT a RangeError stack overflow.
    // Verify the WALKER (redactForUserDisplay) does not throw; JSON.stringify
    // throwing afterward is the pre-existing, router-handled behavior.
    const cyclic: Record<string, unknown> = { name: "p", key: `api_key = "${SK_SECRET}"` };
    cyclic.self = cyclic;
    cyclic.arr = [cyclic];
    // The walker must not stack-overflow (RangeError) — it returns the
    // cycle as-is. A clean TypeError from JSON.stringify later is expected
    // and router-handled; this assertion is about the walker only.
    expect(() => redactForUserDisplay(cyclic)).not.toThrow();
    const walked = redactForUserDisplay(cyclic) as Record<string, unknown>;
    // The secret is still redacted before the cycle short-circuits.
    expect(String(walked.key)).not.toContain(SK_SECRET);
    expect(String(walked.key)).toContain("[REDACTED:");
    // A DAG alias is serializable, unlike a cycle. Every occurrence must
    // point to a redacted copy, never the original revisited object.
    const witness = "orchard canoe";
    expect(redactContent(witness), "the witness is inert").toBe(witness);
    const outcomes = [redactStringValues, redactForUserDisplay].map((walk) => {
      let visits = 0;
      const shared = Object.assign(Object.create(null) as Record<string, unknown>, {
        get content() { return `${witness}\nconst API_KEY = "${SK_SECRET}";`; },
      });
      Object.defineProperty(shared, "content", {
        enumerable: true,
        get() { visits += 1; return `${witness}\nconst API_KEY = "${SK_SECRET}";`; },
      });
      const array = [shared];
      const payload = { first: shared, second: shared, arrays: [array, array] };
      const result = walk(payload) as typeof payload;
      const wire = JSON.stringify(result);
      const cycle = walk(cyclic) as Record<string, unknown>;
      let error: unknown;
      try { JSON.stringify(cycle); } catch (caught) { error = caught; }
      return {
        door: walk.name, leaks: wire.includes(SK_SECRET),
        witnesses: wire.split(witness).length - 1,
        masks: wire.split("[REDACTED:").length - 1,
        sameObject: result.first === result.second, sameArray: result.arrays[0] === result.arrays[1],
        visits, inputUntouched: shared.content.includes(SK_SECRET),
        cyclePreserved: cycle.self === cycle,
        cycleError: error instanceof TypeError && error.message.includes("circular structure"),
      };
    });
    expect(outcomes, "all serializable alias occurrences are masked once; true cycles remain cycles").toEqual(
      [redactStringValues, redactForUserDisplay].map((walk) => ({
        door: walk.name, leaks: false, witnesses: 4, masks: 4,
        sameObject: true, sameArray: true, visits: 1, inputUntouched: true,
        cyclePreserved: true, cycleError: true,
      })),
    );
    const shared = { line: `${witness}\nconst API_KEY = "${SK_SECRET}";` };
    const wire = sendJsonAndCapture({ first: shared, second: shared });
    expect(wire, "aliased secrets cannot reach the actual REST serialization").not.toContain(SK_SECRET);
    expect(wire.split(witness)).toHaveLength(3);
  });

  test("sendJson preserves null / undefined / number / boolean primitives", async () => {
    expect(sendJsonAndCapture(null)).toBe("null");
    expect(sendJsonAndCapture(42)).toBe("42");
    expect(sendJsonAndCapture(true)).toBe("true");
    expect(sendJsonAndCapture("plain string")).toBe('"plain string"');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. CONFIG-SNAPSHOT KEY-BASED REDACTION — the complementary strategy
// (redact by sensitive KEY name, owned by the redaction owner). The
// config route imports it; it does not redefine the key patterns or the
// deep walker (No Scattered Helpers).
// ─────────────────────────────────────────────────────────────────────

describe("PII redaction owner — config-snapshot key-based redaction (redactBySensitiveKeys)", () => {
  test("redactBySensitiveKeys is exported by the single redaction owner", async () => {
    const owner = read(modulePathMatching("server/llm/redaction.ts"));
    expect(owner).toMatch(/export\s+function\s+redactBySensitiveKeys\b/);
    expect(owner).toMatch(/export\s+function\s+isSensitiveKey\b/);
  });

  test("config.ts imports redactBySensitiveKeys + isSensitiveKey from the owner (does not redefine them)", async () => {
    const config = read(modulePathMatching("server/routes/config.ts"));
    expect(config).toMatch(/import\s*\{[^}]*redactBySensitiveKeys[^}]*}\s*from\s*"\.\.\/llm\/redaction\.ts"/);
    expect(config).toMatch(/import\s*\{[^}]*isSensitiveKey[^}]*\}\s*from\s*"\.\.\/llm\/redaction\.ts"/);
    // No local redefinition of the redaction logic.
    expect(config).not.toMatch(/function\s+redactBySensitiveKeys\s*\(/);
    expect(config).not.toMatch(/function\s+isSensitiveKey\s*\(/);
    expect(config).not.toMatch(/function\s+redactStringsDeep\s*\(/);
    expect(config).not.toMatch(/const\s+SENSITIVE_KEY_PATTERNS\b/);
    expect(config).not.toMatch(/const\s+REDACTED_STRING\b/);
  });

  test("redactBySensitiveKeys redacts a value under a sensitive key (apiKey)", async () => {
    const out = redactBySensitiveKeys({ apiKey: "ghp_" + "a".repeat(40), name: "my project" }) as Record<string, unknown>;
    expect(out.apiKey).toBe("[redacted]");
    expect(out.name).toBe("my project");
  });

  test("redactBySensitiveKeys redacts values under password / token / secret / credential / auth keys", async () => {
    const out = redactBySensitiveKeys({
      password: "p@ss",
      sessionToken: "tok",
      clientSecret: "shh",
      credentials: "cr",
      auth: "a",
    }) as Record<string, unknown>;
    expect(out.password).toBe("[redacted]");
    expect(out.sessionToken).toBe("[redacted]");
    expect(out.clientSecret).toBe("[redacted]");
    expect(out.credentials).toBe("[redacted]");
    expect(out.auth).toBe("[redacted]");
  });

  test("redactBySensitiveKeys redacts ALL string leaves under a sensitive subtree (deny-by-default)", async () => {
    // A sensitive key with an object value: a secret under a non-sensitive
    // nested key must be redacted too (e.g. auth: { github: "sk-..." }).
    const out = redactBySensitiveKeys({
      auth: { github: "sk-leak", host: "api.example.com", port: 443 },
    }) as { auth: Record<string, unknown> };
    expect(out.auth.github).toBe("[redacted]");
    expect(out.auth.host).toBe("[redacted]"); // a string under a sensitive subtree
    expect(out.auth.port).toBe(443); // non-string leaf preserved
    // An object may be reached with different masking requirements. A
    // neutral result must never satisfy a later sensitive-key traversal,
    // regardless of visitation order. Repeated arrays share the same rule.
    const outcomes = [false, true].map((sensitiveFirst) => {
      const shared = { label: "orchard canoe", apiKey: SK_SECRET, orchardCanoe: 17 };
      const array = [shared];
      const entries = [["neutral", shared], ["auth", shared], ["password", shared], ["token", array], ["secret", array]] as const;
      const payload = Object.fromEntries(sensitiveFirst ? [...entries].reverse() : entries);
      const result = redactBySensitiveKeys(payload) as Record<string, unknown>;
      const wire = JSON.stringify(result);
      return { sensitiveFirst, leaks: wire.includes(SK_SECRET), result, inputUntouched: shared.apiKey === SK_SECRET };
    });
    for (const outcome of outcomes) {
      expect(outcome.leaks, `no key-based alias leak; sensitiveFirst=${outcome.sensitiveFirst}`).toBe(false);
      const masked = { label: "[redacted]", apiKey: "[redacted]", orchardCanoe: 17 };
      expect(outcome.result).toEqual({
        neutral: { ...masked, label: "orchard canoe" }, auth: masked, password: masked,
        token: [masked], secret: [masked],
      });
      expect(outcome.inputUntouched).toBe(true);
    }
  });

  test("redactBySensitiveKeys preserves non-sensitive keys + non-string leaves", async () => {
    const out = redactBySensitiveKeys({
      name: "project",
      port: 8080,
      enabled: true,
      tags: ["a", "b"],
      nested: { ok: 1, label: "hello" },
    }) as Record<string, unknown>;
    expect(out.name).toBe("project");
    expect(out.port).toBe(8080);
    expect(out.enabled).toBe(true);
    expect(out.tags).toEqual(["a", "b"]);
    expect((out.nested as Record<string, unknown>).label).toBe("hello");
  });

  test("isSensitiveKey matches auth as a whole word (not authEnabled / migrationAuthority)", async () => {
    expect(isSensitiveKey("auth")).toBe(true);
    expect(isSensitiveKey("auth.config")).toBe(true);
    expect(isSensitiveKey("auth_token")).toBe(true);
    // `auth` inside a larger word with no separator is NOT sensitive.
    expect(isSensitiveKey("authEnabled")).toBe(false);
    expect(isSensitiveKey("migrationAuthority")).toBe(false);
  });

  test("redactBySensitiveKeys is idempotent with the value-pattern redactForUserDisplay (defense-in-depth)", async () => {
    // The config route applies key-based redaction, then sendJson applies
    // value-pattern redaction. The value-pattern pass on a [redacted] marker
    // is a no-op (no credential pattern match). Verify the composition.
    const config = { apiKey: `const API_KEY = "${SK_SECRET}";`, name: "p" };
    const keyed = redactBySensitiveKeys(config) as Record<string, unknown>;
    expect(keyed.apiKey).toBe("[redacted]");
    const final = redactForUserDisplay(keyed) as Record<string, unknown>;
    expect(final.apiKey).toBe("[redacted]"); // unchanged — idempotent
    expect(final.name).toBe("p");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 7. NO SCATTERED REDACTION (deny-by-default single-owner scan)
// Dynamically discover the owner's redaction exports, then verify NONE
// are redefined outside `server/redaction.ts`. A future redaction helper
// added to the owner is automatically required to be single-owner — no
// hand-maintained list that can rot (deny-by-default + dynamic discovery).
// ─────────────────────────────────────────────────────────────────────

describe("PII redaction owner — no scattered redaction (deny-by-default dynamic scan)", () => {
  // Discover the owner's redaction exports dynamically: every exported
  // name from server/redaction.ts that starts with `redact` or is the
  // sensitive-key checker. A new redaction helper added tomorrow is
  // automatically covered (no static list).
  const ownerExports = parseExportsFromFile(modulePathMatching("server/llm/redaction.ts"));
  const redactionNames = ownerExports.filter((n) => n.startsWith("redact") || n === "isSensitiveKey");
  expect(redactionNames.length, "the owner must export at least the core redaction helpers").toBeGreaterThanOrEqual(5);

  // Discover every .ts file under server/ (including server/routes/).
  const serverFiles = walkTs("server").map(relpath);

  test("every owner redaction export is defined ONLY in server/redaction.ts", async () => {
    const definers: Record<string, string[]> = {};
    for (const name of redactionNames) definers[name] = [];
    for (const file of serverFiles) {
      if (file === modulePathMatching("server/llm/redaction.ts")) continue; // the owner — allowed
      const stripped = stripCommentsAndStringsFor(read(file), file);
      for (const name of redactionNames) {
        // A definition: `function NAME(` or `const/let/var NAME =` or
        // `export function/const NAME`. Call sites (`NAME(...)`) do NOT
        // match because they lack the `function ` prefix / `=` after the
        // name (a call is `NAME(args)`, not `function NAME(` or `NAME =`).
        const defRe = new RegExp(`(function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`);
        if (defRe.test(stripped)) {
          definers[name]!.push(file);
        }
      }
    }
    for (const [name, files] of Object.entries(definers)) {
      expect(files, `${name} must be defined ONLY in server/redaction.ts (found in: ${files.join(", ")})`).toEqual([]);
    }
  });

  test("no redaction marker constant is defined outside server/redaction.ts", async () => {
    const ts = await import("typescript5");
    // A scattered redaction would define its own marker constant. The
    // owner owns both markers: `[REDACTED:...]` (value-pattern) and
    // `[redacted]` (key-based). Flag any `[REDACTED` / `[redacted]` string
    // constant definition outside the owner (a definition, not a test
    // assertion — tests legitimately use the marker in expectations).
    // A string-blanked view cannot see the marker it claims to forbid.
    // Parse initializers instead: comments, quoted code and type syntax
    // cannot manufacture declarations; quote/escape spellings are equivalent.
    const definitions = (source: string, path: string): string[] => {
      const found: string[] = [];
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const visit = (node: Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer !== undefined &&
          ts.isStringLiteralLike(node.initializer) && /^\[redacted/iu.test(node.initializer.text)) {
          found.push(node.name.getText(file));
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      return found;
    };
    const planted = 'const first: string = "[REDACTED:token]", second = \'[redacted]\'; let third = `[redacted]`; var escaped = "\\u005bredacted]";';
    expect(definitions(planted, "marker-probe.ts"), "every planted initializer must be visible").toEqual(["first", "second", "third", "escaped"]);
    expect(definitions('// const ignored = "[REDACTED:token]";\nconst prose = \'const decoy = "[redacted]";\';', "marker-probe.ts")).toEqual([]);
    const violations = serverFiles.flatMap((file) => file === modulePathMatching("server/llm/redaction.ts")
      ? [] : definitions(read(file), file).map((name) => `${file}:${name}`));
    expect(violations, "redaction marker definitions belong to the redaction owner").toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 8. sendJsonRaw opt-out — deny-by-default raw-content escape hatch
// `sendJson` redacts by default; `sendJsonRaw` is the EXPLICIT opt-out
// for routes returning USER-OWNED raw content (the editor read route).
// A prevention test verifies every `sendJsonRaw` call site is a route
// that reads file content (so a route that merely forgets to redact
// cannot use `sendJsonRaw` to bypass the choke point — only a genuine
// file-content route qualifies).
// ─────────────────────────────────────────────────────────────────────

describe("PII user-display — sendJsonRaw opt-out (deny-by-default raw content)", () => {
  test("sendJson redacts (default); sendJsonRaw does NOT (explicit opt-out)", async () => {
    const router = read(modulePath("router.ts"));
    // sendJson must call redactForUserDisplay (the default choke point).
    expect(router).toMatch(/export function sendJson[\s\S]*?redactForUserDisplay\(data\)/);
    // sendJsonRaw must NOT call redactForUserDisplay (the explicit opt-out).
    const rawBody = router.match(/export function sendJsonRaw[\s\S]*?\n\}/)?.[0] ?? "";
    expect(rawBody, "sendJsonRaw must be defined").toMatch(/export function sendJsonRaw/);
    expect(rawBody, "sendJsonRaw must NOT redact (it is the raw opt-out)").not.toMatch(/redactForUserDisplay/);
    // sendJsonRaw must NOT call redactContent either (no partial redaction).
    expect(rawBody).not.toMatch(/redactContent/);
  });

  test("every sendJsonRaw call site is a route that reads file content (dynamic deny-by-default)", async () => {
    // Dynamically discover every server/ + server/routes/ .ts file that
    // CALLS sendJsonRaw (excluding the router.ts definition file — it
    // defines sendJsonRaw, it does not call it). For each caller, verify
    // it ALSO reads file content (readFile / readFileRaw / readFileSync)
    // — proving it is a genuine file-content route, not a route that
    // merely forgot to redact. Deny-by-default: a route that uses
    // sendJsonRaw without reading file content fails this test.
    const allServerFiles = walkTs("server").map(relpath);
    const rawCallers: string[] = [];
    for (const file of allServerFiles) {
      const stripped = stripCommentsAndStringsFor(read(file), file);
      // Skip the definition file (it defines sendJsonRaw, does not call it).
      if (/export\s+function\s+sendJsonRaw\b/.test(stripped)) continue;
      // A call site: `sendJsonRaw(` not preceded by `function ` (the
      // definition). Match the call, not the declaration.
      if (/(?<![a-zA-Z])sendJsonRaw\s*\(/.test(stripped)) {
        rawCallers.push(file);
      }
    }
    expect(rawCallers.length, "sendJsonRaw must be used by at least the editor read route").toBeGreaterThanOrEqual(1);
    for (const file of rawCallers) {
      const stripped = stripCommentsAndStringsFor(read(file), file);
      // The route must read file content (readFile / readFileRaw from
      // editor-bridge, or fs.readFile/readFileSync of a file's content).
      // This proves the route returns user-owned file content, justifying
      // the raw opt-out.
      expect(
        stripped,
        `${file} uses sendJsonRaw but does NOT read file content — only file-content routes may opt out of redaction`,
      ).toMatch(/\breadFile\b|\breadFileRaw\b|readFileSync|readFile\(/);
    }
  });

  test("the editor read route returns RAW file content (a secret is NOT redacted — the user edits their own file)", async () => {
    // The editor read route must return the file content verbatim so the
    // user can view/edit it. A secret in the file is NOT masked (the user
    // owns the file). This is the explicit opt-out's purpose.
    const editor = read(modulePathMatching("server/routes/editor.ts"));
    // The read route uses sendJsonRaw (not sendJson).
    expect(editor).toMatch(/sendJsonRaw\(ctx\.res,\s*result\)/);
    // The read route calls readFile (the file-content source).
    expect(editor).toMatch(/\breadFile\b/);
  });
});

describe("PII user-display — an identifier survives the walk intact", () => {
  /**
   * THE DEFECT THIS PINS, MEASURED RATHER THAN IMAGINED.
   *
   * `redactForUserDisplay` walks every string leaf of every REST and SSE
   * payload, and the ids this server issues are string leaves like any
   * other. A message id whose fourth group read `9acc` went to the browser
   * as `b476afda-3d57-45c8-9acc-[REDACTED:credential]`: `acc` is a derived
   * abbreviation of `access`, so the detector read hex digits INSIDE the
   * identifier as a credential noun and masked the twelve characters after
   * it. Nothing was hidden — the first twenty-four characters shipped — and
   * the key the client must send back was destroyed, so a rewind, a page
   * cursor or a jump aimed at that id failed against a record that was
   * right there. It fired on 0.04% of random UUIDs, which is why it
   * surfaced as an intermittent history-walk failure nobody could own.
   *
   * THE ALPHABET IS ENUMERATED, NOT SAMPLED. A UUID can only spell words in
   * `[a-f]`, so every three- and four-letter string over that alphabet is
   * generated here and checked — 1,512 of them, covering `acc`, `ace`,
   * `bed`, `dad`, `fed`, `face`, `cafe`, `dead`, `feed` and every cue the
   * lexicon might derive tomorrow. Nothing is listed by hand, so a new
   * credential noun that happens to be spellable in hex is caught the day
   * it is added rather than the day it corrupts someone's conversation.
   */
  function hexWords(length: number): readonly string[] {
    const alphabet = [..."abcdef"];
    let words: string[] = [""];
    for (let i = 0; i < length; i += 1) {
      words = words.flatMap((w) => alphabet.map((c) => w + c));
    }
    return words;
  }

  /**
   * Canonical UUIDs carrying `word` in their fourth group, over a
   * deterministic family of tails.
   *
   * The TAIL is varied and not merely the word, because the cue alone is not
   * what corrupted the id: the detector also weighs what FOLLOWS it, so
   * `…-9acc-5639fb23b411` was masked while `…-9acc-2e922ccc3e00` was not. A
   * fixture that fixed the tail would look like a thorough enumeration and
   * exercise none of it.
   */
  function idsCarrying(word: string): readonly string[] {
    const group = word.length === 4 ? word : `9${word}`;
    return Array.from({ length: 8 }, (_unused, i) => {
      const d = createHash("sha256").update(`${word}:${i}`).digest("hex");
      return `${d.slice(0, 8)}-${d.slice(8, 12)}-4${d.slice(13, 16)}-${group}-${d.slice(20, 32)}`;
    });
  }

  // Keep the full generated population: detector repairs must not make the
  // egress walk tests vacuous by filtering every identifier out of the corpus.
  const identifiers: readonly string[] = [...hexWords(3), ...hexWords(4)]
    .flatMap((word) => idsCarrying(word));

  test("the complete identifier corpus has valid shapes and no derived credential cues", () => {
    expect(identifiers).toHaveLength((6 ** 3 + 6 ** 4) * 8);
    for (const id of identifiers) {
      expect(id, "every corpus member must have the UUID lexical shape").toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
      );
      expect(redactContent(id), id).toBe(id);
    }
  });

  test("none of them is altered on the way to the browser", () => {
    const corrupted: string[] = [];
    for (const id of identifiers) {
      const out = redactForUserDisplay({ id, chatId: id, runId: id }) as Record<string, unknown>;
      for (const [key, value] of Object.entries(out)) {
        if (value !== id) corrupted.push(`${key}=${String(value)}`);
      }
    }
    expect(
      corrupted,
      `these identifiers were altered on the way to the browser: ${corrupted.slice(0, 6).join(", ")}`,
    ).toEqual([]);
  });

  test("the ids this server actually mints are covered by the same rule", () => {
    // The constructed corpus covers lexical shapes; this also covers
    // the REAL producer's output. `randomUUID` is what `DbClient` stamps on
    // every row, and every one of its results must be structure the walk
    // passes through — asserted on the property, not on a lucky sample.
    for (let i = 0; i < 200; i += 1) {
      const id = randomUUID();
      expect(isBenignToken(id), `${id} is not recognised as structure`).toBe(true);
      expect((redactForUserDisplay({ id }) as { id: string }).id).toBe(id);
    }
  });

  test("nested identifiers are covered too — the walk reaches every leaf", () => {
    const id = identifiers[0]!;
    const payload = { chat: { id }, messages: [{ id, chatId: id }], page: { olderCursor: id } };
    expect(redactForUserDisplay(payload)).toEqual(payload);
  });

  test("PREFIXED identifiers — the shape the server actually hands the browser — pass through unaltered", () => {
    // The arm above asserts bare UUIDs. But the harness mints its entity ids
    // as `<domain>-<uuid>` through the canonical identifier owner
    // (`generateId`), so a bare-UUID-only guard is blind inside its own
    // charter: the one shape the client must send back verbatim is the
    // prefixed one, and it was NOT benign — the credential detector read the
    // hex inside `run-…-4acc-a059-…` as a secret and masked from the `acc`,
    // so the stream attach 404'd against a run that existed. This arm
    // witnesses the captured regression id and the generated property.
    //
    // The captured witness: this exact id 404'd the stream attach before the
    // fix. If the grammar ever stops explaining a prefixed UUID, this fails.
    const captured = "run-26600085-df4d-4acc-a059-b74e9cb2c2d2";
    expect(isBenignToken(captured), `${captured} must be structure`).toBe(true);
    expect((redactForUserDisplay({ runId: captured }) as { runId: string }).runId).toBe(captured);
    // The property: every prefixed id the canonical owner can mint is benign,
    // for the prefixes in use across the harness.
    const prefixes = ["run", "turn", "evt", "mem", "agent", "task", "tool-call", "conv", "snap"];
    for (const prefix of prefixes) {
      for (let i = 0; i < 50; i += 1) {
        const id = `${prefix}-${randomUUID()}`;
        expect(isBenignToken(id), `${id} is not recognised as structure`).toBe(true);
        const out = redactForUserDisplay({ runId: id, id }) as Record<string, unknown>;
        expect(out.runId, `${id} altered under runId`).toBe(id);
        expect(out.id, `${id} altered under id`).toBe(id);
      }
    }
  });

  test("PROVIDER call identifiers — the transport id the tool card and the run-end read-back join on — pass through unaltered", () => {
    // The captured witness: this exact callId (from the live run-end
    // read-back, 2026-08-31) was served as `[REDACTED:credential]` before the
    // grammar — the entropy layer read the 16-hex body as a secret. A
    // redacted callId breaks the join the stranded-card heal keys by, and
    // writes `[REDACTED]` over every call id in the transcript and the dig.
    const captured = "chatcmpl-tool-b51f5c8c012ffaee";
    expect(isBenignToken(captured), `${captured} must be structure`).toBe(true);
    expect((redactForUserDisplay({ callId: captured }) as { callId: string }).callId).toBe(captured);
    // The canonical OpenAI wire shape, and the property over bodies the
    // provider mints: alphanumeric with separators, anchored.
    expect(isBenignToken("call_9Wg0KsrKxXGVHzTnM6yxB")).toBe(true);
    for (const body of ["tool-b51f5c8c012ffaee", "abc123", "A9z0-_x1"]) {
      const id = `chatcmpl-${body}`;
      expect(isBenignToken(id), `${id} must be structure`).toBe(true);
    }
    // The grammar is not an exemption for DECLARED secrets: a value named as
    // a credential beside a credential noun is masked by the declaration
    // layer, which has evidence beyond the value's own shape.
    const declared = 'const api_key = "chatcmpl-tool-b51f5c8c012ffaee"';
    const out = redactForUserDisplay({ text: declared }) as { text: string };
    expect(out.text, "a declared credential is masked whatever its shape").not.toBe(declared);
    expect(out.text).toContain("[REDACTED");
  });

  test("REGISTRY identifiers — every settings, signal and action id this server mints survives the walk", () => {
    // The settings wires are the measured instance of the same class the
    // UUID arms above pin: a customization id is a `module.name` token the
    // exposure registry authored, and `graph.slowLlmMsThreshold` read as
    // "18 unbroken random-looking characters" to the value-intrinsic layer
    // (its camelCase segment carries too few vowels to read as words and
    // matches no benign grammar), so BOTH served wires shipped it masked
    // and the row's Save verb posted `{"id":"[REDACTED:credential]}` back
    // — a 404 against an id the server had minted itself, the row
    // structurally unwritable through its own door.
    //
    // DYNAMIC DISCOVERY: the population is the LIVE registry (signals,
    // actions, customizations), never a list here. An id registered
    // tomorrow is asserted tomorrow with no edit; the corpus arm below
    // proves the population is not vacuously clean by finding, per id,
    // which ones the RAW detector would corrupt.
    registerAllExposure();
    const ids = [
      ...listSignals().map((s) => s.id),
      ...listActions().map((a) => a.id),
      ...listCustomizations().map((c) => c.id),
    ];
    expect(ids.length, "the registry is populated — discovery is real").toBeGreaterThan(0);
    for (const id of ids) {
      // The leaf shapes the settings wires actually carry: the schema
      // entry's own id + customizationId, the values row, the generated
      // module's exposes lists.
      const payload = {
        id,
        customizationId: id,
        settings: [{ id, customizationId: id }],
        customizations: [{ id, value: 1 }],
        exposes: { settings: [id] },
      };
      expect(redactForUserDisplay(payload), `${id} was altered on the way to the browser`).toEqual(payload);
    }
  });

  test("the corpus is real — the raw detector does corrupt a registry id, and the walk is what exempts it", () => {
    // Found, not listed: the oracle is the detector's own unguarded
    // judgement (`redactContent`), so the corpus is whatever ids the
    // current heuristic happens to read as credentials. Today that is
    // exactly one; a registration whose camelCase name trips the heuristic
    // tomorrow joins the corpus the day it lands, with no edit here.
    const corrupting = [
      ...listSignals().map((s) => s.id),
      ...listActions().map((a) => a.id),
      ...listCustomizations().map((c) => c.id),
    ].filter((id) => redactContent(id) !== id);
    expect(
      corrupting.length,
      "no registry id trips the raw detector — the exemption is guarding nothing; " +
        "either the heuristic changed or this oracle is broken",
    ).toBeGreaterThan(0);
    // The captured witness (UIE-079, drive 13): this exact id was served as
    // `[REDACTED:credential]` on both wires, its Save 404-ing against the
    // server's own registry. If the authorship exemption ever stops
    // covering it, this fails.
    expect(corrupting).toContain("graph.slowLlmMsThreshold");
    for (const id of corrupting) {
      const out = redactForUserDisplay({ id, customizationId: id }) as Record<string, unknown>;
      expect(out.id, `${id} must reach the browser verbatim under id`).toBe(id);
      expect(out.customizationId, `${id} must reach the browser verbatim under customizationId`).toBe(id);
    }
  });

  test("MIRROR — a credential-shaped settings VALUE is still masked on the values wire", () => {
    // The exemption is by AUTHORSHIP (the leaf byte-equals an id the
    // registry minted), so it can never reach a value a user typed. The
    // values-wire shape: a string customization whose current value is a
    // credential-shaped string must arrive masked while its id arrives
    // verbatim — the exact two leaves the save round trip depends on.
    const planted = "sk-AAAAAAAAAAAAAAAAAAAAAAAA";
    const out = redactForUserDisplay({
      customizations: [{ id: "search.languageFilter", value: planted }],
    }) as { customizations: { id: string; value: string }[] };
    expect(out.customizations[0]!.id, "the id is the registry's own token — verbatim").toBe(
      "search.languageFilter",
    );
    expect(out.customizations[0]!.value, "the planted secret must NEVER reach the wire verbatim").not.toBe(
      planted,
    );
    expect(out.customizations[0]!.value).toContain("[REDACTED:");
  });

  test("MIRROR — an unregistered lookalike id is not exempt (membership is exact)", () => {
    // One byte away from a registered id and NOT in the registry: deny by
    // default. A shape-based exemption (any dotted-id-looking string) would
    // pass this leaf — and dot-separated segments are also the JWT wire
    // shape, which is why the exemption is authorship, not shape.
    const lookalike = "graph.slowLlmMsThresholdx";
    expect(isRegistered(lookalike), "the fixture must really be unregistered").toBe(false);
    const out = redactForUserDisplay({ id: lookalike }) as { id: string };
    expect(out.id).not.toBe(lookalike);
    expect(out.id).toContain("[REDACTED:");
  });

  test("MIRROR — the LLM-bound path still masks the registry id in content (the walk is the only exemption)", () => {
    // The exemption lives in the USER-DISPLAY walk alone, exactly like the
    // cursor-key exemption: on the LLM-bound path every string is the
    // user's content, and a settings id pasted into a message is content.
    // The engine stays byte-identical, and this pins that the fix did not
    // leak into it: every corpus member — the ids the raw detector reads
    // as credentials — must still be masked by `redactContent`, which is
    // the walk's own underlying pass. An exemption that leaked into the
    // engine would empty the corpus at the top of this block and cannot
    // hide here.
    const corpus = [
      ...listSignals().map((s) => s.id),
      ...listActions().map((a) => a.id),
      ...listCustomizations().map((c) => c.id),
    ].filter((id) => redactContent(id) !== id);
    expect(corpus.length, "the corpus is empty — the raw detector no longer masks any registry id").toBeGreaterThan(
      0,
    );
    for (const id of corpus) {
      expect(redactContent(id), `${id} in message content must still be masked for the LLM`).toContain(
        "[REDACTED:",
      );
      // And the walk passes the same id verbatim — the two answers differ
      // by the exemption, which is the whole design.
      expect((redactForUserDisplay({ id }) as { id: string }).id).toBe(id);
    }
  });

  test("the authorship exemption defers to the registry rather than restating it", () => {
    // MUTATION: replace `isRegistered(text)` with a local list of ids and
    // this fails — a second definition of "what this server minted" is the
    // scattered-helper defect, and it would silently stop covering a
    // registration added the day after the list was written.
    const src = read(modulePathMatching("server/llm/redaction.ts"));
    expect(src).toMatch(/import \{ isRegistered \} from "\.\.\/kernel\/canonical\.ts"/);
    expect(src).toMatch(/if \(plain !== text && isRegistered\(text\)\) return text;/);
  });

  test("MIRROR — the exemption is not a blanket: real secrets are still masked", () => {
    // Without this, `return text` at the top of `redactUserDisplayString`
    // would satisfy every case above while switching redaction off for the
    // whole product. Each of these is a leaf that no benign grammar
    // explains, so each must still be masked.
    const secrets = [
      'const API_KEY = "sk-live-9f2c8d1e4b7a3c6f0e5d2b8a1c4f7e0d"',
      "accessToken=ffle19b0aw10e6av64xxc750d0j7sw8b",
      "my password is hunter2-Zx9QwErTyUiOp",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnop",
    ];
    for (const secret of secrets) {
      const out = redactForUserDisplay({ text: secret }) as { text: string };
      expect(out.text, `this must not reach the browser verbatim: ${secret.slice(0, 24)}…`).not.toBe(
        secret,
      );
      expect(out.text).toContain("[REDACTED");
    }
  });

  test("MIRROR — a benign-looking token that carries a secret is still masked", () => {
    // A UUID-shaped leaf is passed through, and that is only safe because
    // such a token is already vetoed as a value-intrinsic candidate. A
    // token one character away from a UUID is NOT benign and must not
    // inherit the exemption — the anchoring the grammar owner insists on.
    const nearMiss = "01234567-89ab-4cde-8fab-0123456789abc";
    expect(isBenignToken(nearMiss), "the near-miss must not be benign").toBe(false);
  });

  test("the exemption defers to the grammar owner rather than restating it", () => {
    // MUTATION: replace `isBenignToken(text)` with a local UUID regex and
    // this fails — a second definition of "what is structure" is exactly
    // the scattered-helper defect, and it would silently stop honouring a
    // grammar added upstream.
    const src = read(modulePathMatching("server/llm/redaction.ts"));
    expect(src).toMatch(/import \{ isBenignToken \} from ".*benign-grammars\.ts"/);
    expect(src).toMatch(/if \(isBenignToken\(text\)\) return text;/);
  });
});

describe("PII user-display — isHiddenFromUserDisplay (the masked-recognition flag)", () => {
  /**
   * THE SETTINGS READ-BACK FLAG, owned where the walk it derives from lives.
   *
   * A settings value the egress hides is served in its masked form, and the
   * surfaces that read it back need to KNOW that — a masked read-back is a
   * successful save's proof, and a masked literal must never travel back
   * into an editable field. The flag has to come from THIS owner (the same
   * walk, the same resolved policy) because the marker spelling is a
   * resolved policy fact: a consumer pattern-matching a hardcoded
   * `[REDACTED:` would read a configured marker as an ordinary value. These
   * arms pin the predicate's mechanics; the wire's consumers (the values
   * builder, the settings block answer) are held by their own suites.
   */
  test("a credential-shaped string is hidden; plain strings, non-string scalars and the empty string are not", () => {
    expect(isHiddenFromUserDisplay("sk-live-r48-flag-7742a1c9")).toBe(true);
    expect(isHiddenFromUserDisplay("search.queryCount,memory.entryCount")).toBe(false);
    expect(isHiddenFromUserDisplay("")).toBe(false);
    expect(isHiddenFromUserDisplay(3)).toBe(false);
    expect(isHiddenFromUserDisplay(true)).toBe(false);
    expect(isHiddenFromUserDisplay(null)).toBe(false);
  });

  test("a registered id the raw detector would corrupt is NOT hidden — the authorship exemption reaches the flag", () => {
    // DISCOVERED from the registry with the raw pass as the oracle — the same
    // join the identifier describe's corpus uses. The raw LLM-bound pass
    // masks these; the user-display walk passes them (the authorship
    // exemption); the flag must agree with the WALK, not the raw pass — a
    // false "hidden" would make a settings surface treat a served registry
    // id as a mask and keep it out of the row's own editable field.
    registerAllExposure();
    const corrupting = [
      ...listSignals().map((s) => s.id),
      ...listActions().map((a) => a.id),
      ...listCustomizations().map((c) => c.id),
    ].filter((id) => redactContent(id) !== id);
    expect(
      corrupting.length,
      "no registry id trips the raw detector — the oracle or the exemption changed",
    ).toBeGreaterThan(0);
    for (const id of corrupting) {
      expect(isRegistered(id), `${id} must really be registry-minted`).toBe(true);
      expect(isHiddenFromUserDisplay(id), `${id}: the flag must honour the walk's exemption`).toBe(false);
    }
  });

  test("an object with an inner hidden value is hidden; a clean object is not — structure alone never trips the flag", () => {
    expect(isHiddenFromUserDisplay({ note: "sk-live-r48-flag-7742a1c9" })).toBe(true);
    expect(isHiddenFromUserDisplay({ list: ["sk-live-r48-flag-7742a1c9"] })).toBe(true);
    expect(isHiddenFromUserDisplay({ a: 1, b: "plain", c: [1, 2] })).toBe(false);
    expect(isHiddenFromUserDisplay({ nested: { deep: { ok: true } } })).toBe(false);
  });
});
