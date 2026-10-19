#!/usr/bin/env node
// An MCP stdio server whose tools PROBE the authority it was started with —
// the deterministic twin of the test-drive's filesystem-server escape. Every
// tool answers with what actually happened, never throws:
//
//   write { path, content? } → "ok" | the error code (EACCES, ENOENT, …)
//   read  { path }           → "ok:<content>" | the error code
//   reach { path }           → "ok" | the error code — opens a file (or lists a
//                               folder) and reports ONLY whether it could, so a
//                               real credential store can be probed without
//                               its bytes ever leaving the server
//   env   {}                 → the sorted names of its environment variables
//   cwd   {}                 → its working directory
//   home  {}                 → its HOME
//
// All of them are declared read-only EXCEPT write (annotations), so a host's
// classifier can be checked against it too. No arguments; pure node: builtins.
import { closeSync, openSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";

const TOOLS = [
  { name: "write", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path"] }, annotations: { readOnlyHint: false } },
  { name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, annotations: { readOnlyHint: true } },
  { name: "reach", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, annotations: { readOnlyHint: true } },
  { name: "env", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "cwd", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "home", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
];

function attempt(fn) {
  try { return fn(); } catch (error) { return String(error?.code ?? error?.message ?? error); }
}

function call(name, args) {
  if (name === "write") return attempt(() => { writeFileSync(args.path, args.content ?? "probe"); return "ok"; });
  if (name === "read") return attempt(() => `ok:${readFileSync(args.path, "utf8")}`);
  if (name === "reach") return attempt(() => { if (statSync(args.path).isDirectory()) readdirSync(args.path); else closeSync(openSync(args.path, "r")); return "ok"; });
  if (name === "env") return JSON.stringify(Object.keys(process.env).sort());
  if (name === "cwd") return process.cwd();
  if (name === "home") return process.env.HOME ?? "";
  return `unknown tool ${name}`;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fs-probe", version: "1.0.0" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    } else if (message.method === "tools/call") {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: call(message.params.name, message.params.arguments ?? {}) }] } });
    } else {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
    }
  }
});
