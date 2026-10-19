#!/usr/bin/env node
// EXP448 — Extended MCP server fixture for improper-usage + multi-tool
// scenarios. Speaks the MCP lifecycle (initialize →
// notifications/initialized → tools/list → tools/call) and supports
// several adversarial modes to exercise the registry's error handling.
//
// Usage:
// node exp448-mcp-server.mjs \
// [--mode=normal|garbage|binary|rate-limited|slow] \
// [--tools=a,b,c] [--name=<serverName>] [--delay=<ms>] \
// [--crash-after=<N>]
//
// Modes:
// normal — responds with text content (default).
// garbage — writes a non-JSON line to stdout (simulates a server
// that violates the JSON-RPC framing).
// binary — responds with content items whose text is a binary
// blob (non-serializable-ish); tests registry
// normalization.
// rate-limited — responds to tools/call with an MCP JSON-RPC error
// code -32001 (rate limited).
// slow — delays tools/call by --delay ms (for timeout tests).
// malformed-replies — answers its first tools/calls with replies that are
// not JSON-RPC responses (error null, error a string,
// result AND error, an object id), then normally
// (SCALE-CR1 C1: one such reply ended the host).

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "mode": { type: "string", default: "normal" },
    "tools": { type: "string", default: "ping" },
    "name": { type: "string", default: "exp448-mcp-server" },
    "delay": { type: "string", default: "0" },
    "crash-after": { type: "string", default: "0" },
  },
});
const mode = values.mode ?? "normal";
const toolNames = (values.tools ?? "ping").split(",").map((t) => t.trim()).filter(Boolean);
const serverName = values.name ?? "exp448-mcp-server";
const delayMs = parseInt(values.delay ?? "0", 10);
const crashAfter = parseInt(values["crash-after"] ?? "0", 10);
let callCount = 0;
let buf = "";
const MALFORMED_REPLIES = [
  (id) => ({ jsonrpc: "2.0", id, error: null }),
  (id) => ({ jsonrpc: "2.0", id, error: "x" }),
  (id) => ({ jsonrpc: "2.0", id, result: { content: [], isError: false }, error: { code: 1, message: "both" } }),
  () => ({ jsonrpc: "2.0", id: {}, result: { content: [], isError: false } }),
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

async function handle(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.jsonrpc !== "2.0") return;
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: serverName, version: "1.0.0" },
        capabilities: { tools: {} },
      },
    });
  } else if (msg.method === "notifications/initialized") {
    // no response
  } else if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        tools: toolNames.map((name) => ({
          name,
          description: `EXP448 fake tool ${name} (mode=${mode})`,
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        })),
      },
    });
  } else if (msg.method === "tools/call") {
    callCount += 1;
    if (crashAfter > 0 && callCount >= crashAfter) {
      process.exit(1);
    }
    await sleep(delayMs);
    if (mode === "malformed-replies" && callCount <= MALFORMED_REPLIES.length) {
      send(MALFORMED_REPLIES[callCount - 1](msg.id));
      return;
    }
    if (mode === "garbage") {
      process.stdout.write("this is not json\n");
      return;
    }
    if (mode === "rate-limited") {
      send({
        jsonrpc: "2.0", id: msg.id,
        error: { code: -32001, message: "rate limited (429)" },
      });
      return;
    }
    if (mode === "binary") {
      send({
        jsonrpc: "2.0", id: msg.id,
        result: {
          content: [{ type: "text", text: "\u0000\u0001\u0002binary-blob\u0003\u0004" }],
          isError: false,
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0", id: msg.id,
      result: { content: [{ type: "text", text: `pong:${callCount}:${mode}` }], isError: false },
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
