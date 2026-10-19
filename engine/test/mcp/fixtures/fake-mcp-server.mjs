#!/usr/bin/env node
// Minimal MCP server (stdio JSON-RPC 2.0) for EXP423 real-server integration test.
// Speaks the MCP lifecycle (initialize → notifications/initialized → tools/list → tools/call)
// and CRASHES (exits 1) after `--crash-after` tool calls to test the registry restart.
//
// Usage: node fake-mcp-server.mjs [--crash-after N] [--name <toolname>] [--error]
//   [--silent] [--mark <path>] [--exit-after <ms>]
//   --silent        never respond to any message — holds a connection attempt
//                   genuinely in flight (combined with --exit-after it can never
//                   hang a worker even if every stop path fails).
//   --mark <path>   write a marker file once the tools/list RESPONSE bytes have
//                   been flushed to the pipe — proof the discovery was SENT, not
//                   merely computed internally.
//   --exit-after <ms> exit(0) after this many milliseconds (self-terminating).
//   --say <text>    the server's own words carry <text>: a stderr line at start,
//                   the tool description, every call result — and, with
//                   --fail-initialize, the initialize error (a server echoing
//                   its credential: the harness must mask what it authors).
//   --fail-initialize answer initialize with a JSON-RPC error.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "crash-after": { type: "string", default: "0" },
    "name": { type: "string", default: "ping" },
    "error": { type: "boolean", default: false },
    "silent": { type: "boolean", default: false },
    "mark": { type: "string" },
    "exit-after": { type: "string" },
    "say": { type: "string" },
    "fail-initialize": { type: "boolean", default: false },
  },
});
// A numeric flag must parse as one WHOLE integer: `parseInt("abc")` is NaN,
// and every comparison over NaN is false — a misspelled `--crash-after abc`
// would silently behave as "never crash" and a misspelled `--exit-after xyz`
// as "exit immediately", so the fixture would report a behaviour nobody asked
// for. The refusal names the flag and exits non-zero: a garbage numeric flag
// is a typed failure at the parse choke, never a silent NaN.
function numericFlag(flagName) {
  const raw = values[flagName];
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/u.test(raw)) {
    process.stderr.write(`fake-mcp-server: --${flagName} expects a non-negative integer, got ${JSON.stringify(raw)}\n`);
    process.exit(2);
  }
  return Number.parseInt(raw, 10);
}
const crashAfter = numericFlag("crash-after") ?? 0;
const toolName = values.name ?? "ping";
const silent = values.silent === true;
const markPath = values.mark;
const exitAfterMs = numericFlag("exit-after");
const said = values.say === undefined ? "" : ` ${values.say}`;
let callCount = 0;
let buf = "";
if (said.length > 0) process.stderr.write(`fake-mcp-server starting;${said}\n`);

if (exitAfterMs !== undefined) {
  setTimeout(() => process.exit(0), exitAfterMs);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(raw) {
  if (silent) return;
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.jsonrpc !== "2.0") return;
  if (msg.method === "initialize" && values["fail-initialize"] === true) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: `initialize refused: bad credentials${said}` } });
  } else if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "fake-mcp-server", version: "1.0.0" },
        capabilities: { tools: {} },
      },
    });
  } else if (msg.method === "notifications/initialized") {
    // notification — no response
  } else if (msg.method === "tools/list") {
    const payload = JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: {
        tools: [{
          name: toolName,
          description: `A fake ping tool${said}`,
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        }],
      },
    }) + "\n";
    if (markPath === undefined) {
      process.stdout.write(payload);
    } else {
      // The flush callback fires after the bytes left the process — the
      // marker proves this discovery response was SENT, not merely computed.
      process.stdout.write(payload, () => { writeFileSync(markPath, "listed"); });
    }
  } else if (msg.method === "tools/call") {
    callCount += 1;
    if (crashAfter > 0 && callCount >= crashAfter) {
      // Crash on the Nth call — exit without responding. Simulates a server crash.
      process.exit(1);
    }
    const asError = values.error === true;
    send({
      jsonrpc: "2.0", id: msg.id,
      result: { content: [{ type: "text", text: asError ? `error:${callCount}${said}` : `pong:${callCount}${said}` }], isError: asError },
    });
  } else if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) if (line.length > 0) handle(line);
});
process.stdin.on("end", () => process.exit(0));
