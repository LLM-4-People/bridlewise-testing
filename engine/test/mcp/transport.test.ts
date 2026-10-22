import assert from "node:assert/strict";
import { startWebSocketServer, type WebSocketPeer } from "../support/websocket-server.ts";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTempDir } from "../support/temp-dir.ts";
import { startStreamableHttpServer } from "./fixtures/streamable-http-server.ts";

import { createMcpClientFromConfig, createStreamableHttpTransport, createStdioTransport, createWebSocketTransport, McpError, type McpSpawn } from "../../src/mcp/index.ts";
import { MCP_MAX_MESSAGE_BYTES } from "../../src/mcp/core.ts";
import { installOutboundPolicySource } from "../../src/shared/outbound-policy.ts";
import { address, resolveAs, serve } from "../support/loopback-upstream.ts";
import { allProcessIds, commandLineOf, isProcessAlive, parentOf } from "../../src/process/process-facts.ts";

const PROTOCOL = "2025-11-25";
const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
const INITIALIZED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
/** The outbound policy knobs every remote transport is built with (the factory supplies the module defaults). */
const POLICY = { sseReconnectMs: 10, sseRetryMaxMs: 1_000, resumeAttempts: 8, closeGraceMs: 1_000 } as const;
/** The stdio bounds every stdio transport is built with (the factory supplies the module defaults). */
const STDIO_BOUNDS = { stderrLinesPerSecond: 100_000, maxMessageBytes: MCP_MAX_MESSAGE_BYTES } as const;
/** The WebSocket bound (the factory supplies the core's message bound). */
const WS_BOUNDS = { maxMessageBytes: MCP_MAX_MESSAGE_BYTES } as const;

// ---------------------------------------------------------------------------
// Streamable HTTP transport — against a spec-faithful loopback server that
// records what the client SENT (the defect this file used to pass on: no test
// ever looked at a request header, and the shipped transport sent an Accept
// every real server refuses).
// ---------------------------------------------------------------------------

test("streamable http: every POST sends the spec's Accept and Content-Type, and operator headers cannot override them", async () => {
  const server = await startStreamableHttpServer({ mode: "json" });
  try {
    const transport = createStreamableHttpTransport({ ...POLICY,
      url: server.url, timeoutMs: 5000, protocolVersion: PROTOCOL,
      headers: { accept: "application/json", "content-type": "text/plain", "X-Custom": "kept" },
    });
    const received: string[] = [];
    transport.onMessage((raw) => { received.push(raw); });
    await transport.connect();
    await transport.send(INITIALIZE);
    assert.equal(server.requests.length, 1);
    const sent = server.requests[0]!;
    assert.equal(sent.method, "POST");
    assert.equal(sent.headers["accept"], "application/json, text/event-stream");
    assert.equal(sent.headers["content-type"], "application/json");
    assert.equal(sent.headers["x-custom"], "kept");
    assert.equal(JSON.parse(received[0]!).result.serverInfo.name, "streamable-fixture");
  } finally {
    await server.close();
  }
});

test("streamable http: MCP-Protocol-Version is absent on initialize and present on every later request", async () => {
  const server = await startStreamableHttpServer({ mode: "json" });
  try {
    const transport = createStreamableHttpTransport({ ...POLICY, url: server.url, timeoutMs: 5000, protocolVersion: PROTOCOL });
    transport.onMessage(() => {});
    await transport.connect();
    await transport.send(INITIALIZE);
    await transport.send(INITIALIZED);
    await transport.send(LIST);
    assert.deepEqual(server.requests.map((r) => r.headers["mcp-protocol-version"]), [undefined, PROTOCOL, PROTOCOL]);
  } finally {
    await server.close();
  }
});

test("streamable http: an event-stream answer (priming event, CRLF framing) delivers exactly the one message", async () => {
  const server = await startStreamableHttpServer({ mode: "sse" });
  try {
    const transport = createStreamableHttpTransport({ ...POLICY, url: server.url, timeoutMs: 5000, protocolVersion: PROTOCOL });
    const received: string[] = [];
    transport.onMessage((raw) => { received.push(raw); });
    await transport.connect();
    await transport.send(INITIALIZE);
    assert.equal(received.length, 1, "the empty priming event is not a message");
    assert.equal(JSON.parse(received[0]!).id, 1);
  } finally {
    await server.close();
  }
});

test("streamable http: a 202 answer to a notification is a no-op, not a message and not an error", async () => {
  const server = await startStreamableHttpServer({ mode: "json" });
  try {
    const transport = createStreamableHttpTransport({ ...POLICY, url: server.url, timeoutMs: 5000, protocolVersion: PROTOCOL });
    const received: string[] = [];
    transport.onMessage((raw) => { received.push(raw); });
    await transport.connect();
    await transport.send(INITIALIZED);
    assert.deepEqual(received, []);
  } finally {
    await server.close();
  }
});

test("streamable http: the session id is echoed on later requests and ended with a DELETE on close", async () => {
  const server = await startStreamableHttpServer({ mode: "sse", session: true });
  try {
    const transport = createStreamableHttpTransport({ ...POLICY, url: server.url, timeoutMs: 5000, protocolVersion: PROTOCOL });
    transport.onMessage(() => {});
    await transport.connect();
    await transport.send(INITIALIZE);
    await transport.send(INITIALIZED);
    await transport.send(LIST);
    await transport.close();
    assert.deepEqual(server.requests.map((r) => [r.method, r.headers["mcp-session-id"]]), [
      ["POST", undefined], ["POST", "session-1"], ["POST", "session-1"], ["DELETE", "session-1"],
    ]);
  } finally {
    await server.close();
  }
});

test("streamable http: a 404 to a request carrying the session is mcp_session_expired — retryable AND transport-level", async () => {
  const server = await startStreamableHttpServer({ mode: "json", session: true });
  try {
    const transport = createStreamableHttpTransport({ ...POLICY, url: server.url, timeoutMs: 5000, protocolVersion: PROTOCOL });
    transport.onMessage(() => {});
    await transport.connect();
    await transport.send(INITIALIZE);
    server.expireSession();
    await assert.rejects(() => transport.send(LIST), (e: unknown) => {
      assert.ok(e instanceof McpError);
      assert.equal(e.code, "mcp_session_expired");
      assert.equal(e.retryable, true);
      assert.equal(e.transportLevel, true, "transport-level, so the registry reconnects (a new client starts a new session)");
      return true;
    });
  } finally {
    await server.close();
  }
});

test("streamable http: a content type it cannot frame is a typed refusal, never a silent drop", async () => {
  const server = await startStreamableHttpServer({ mode: "text" });
  try {
    const transport = createStreamableHttpTransport({ ...POLICY, url: server.url, timeoutMs: 5000, protocolVersion: PROTOCOL });
    transport.onMessage(() => {});
    await transport.connect();
    await assert.rejects(() => transport.send(INITIALIZE), (e: unknown) => e instanceof McpError && e.code === "mcp_http_content_type_invalid");
  } finally {
    await server.close();
  }
});

test("streamable http: a 5xx is mcp_http_error and retryable; a 4xx is not retryable", async () => {
  for (const [status, retryable] of [[503, true], [406, false]] as const) {
    serve(() => Promise.resolve(new Response("nope", { status })));
    const transport = createStreamableHttpTransport({ ...POLICY, url: address("https://example.com/mcp"), timeoutMs: 5000, protocolVersion: PROTOCOL });
    await transport.connect();
    await assert.rejects(() => transport.send(INITIALIZE), (e: unknown) => e instanceof McpError && e.code === "mcp_http_error" && e.retryable === retryable);
  }
});

test("streamable http: the full client lifecycle (initialize, initialized, paginated tools/list, tools/call) over an event stream", async () => {
  const tools = ["a", "b", "c"].map((name) => ({ name, inputSchema: { type: "object" } }));
  const server = await startStreamableHttpServer({ mode: "sse", session: true, pageSize: 2, tools });
  try {
    const client = createMcpClientFromConfig(
      { id: "remote", transport: "http", url: server.url },
      { clientInfo: { name: "t", version: "1" }, defaultProtocolVersion: PROTOCOL, defaultTimeoutMs: 5000 },
    );
    await client.connect();
    const listed = await client.listTools();
    assert.deepEqual(listed.map((t) => t.name), ["a", "b", "c"], "every page of a paginated tools/list is followed");
    const result = await client.callTool("a", { x: 1 });
    assert.equal(result.content[0]!.text, JSON.stringify({ x: 1 }));
    await client.close();
    assert.equal(server.requests.at(-1)!.method, "DELETE");
  } finally {
    await server.close();
  }
});

const CLIENT_OPTIONS = { clientInfo: { name: "t", version: "1" }, defaultProtocolVersion: PROTOCOL, defaultTimeoutMs: 5000 } as const;

test("streamable http: a redirect is refused — the api-key and session never reach the redirect target (SEC-V-1)", async () => {
  const target = await startStreamableHttpServer({ mode: "json" });
  const redirecting = await startStreamableHttpServer({ mode: "json", redirectTo: target.url });
  try {
    const client = createMcpClientFromConfig(
      { id: "remote", transport: "http", url: redirecting.url, auth: { type: "api-key", token: "SECRET-MCP-KEY-1234" } },
      CLIENT_OPTIONS,
    );
    await assert.rejects(() => client.connect(), (e: unknown) => e instanceof Error && (e as { code?: string }).code === "outbound_redirect_refused"
      && e.message.includes(new URL(target.url).origin));
    assert.equal(redirecting.requests.length, 1, "exactly one request, to the configured endpoint");
    assert.equal(redirecting.requests[0]!.headers["x-api-key"], "SECRET-MCP-KEY-1234");
    assert.equal(target.requests.length, 0, "the redirect target received nothing — no credential, no session");
  } finally {
    await redirecting.close();
    await target.close();
  }
});

test("streamable http: a cleartext endpoint on another host is refused before anything is sent; warn sends it", async () => {
  // A real server on another machine, stood in for by a LAN-shaped name the
  // loopback server answers: its cleartext address is refused, then warned.
  const server = await startStreamableHttpServer({ mode: "json" });
  const port = new URL(server.url).port;
  const remote = `http://mcp-lan.invalid:${port}${new URL(server.url).pathname}`;
  try {
    const refusing = createStreamableHttpTransport({ ...POLICY, url: remote, timeoutMs: 5000, protocolVersion: PROTOCOL });
    await refusing.connect();
    await assert.rejects(() => refusing.send(INITIALIZED), (e: unknown) => (e as { code?: string }).code === "outbound_cleartext_refused");
    assert.equal(server.requests.length, 0, "a refused request is never dispatched");
    // The ONE setting, owned by the door (network.cleartextRemote); the name resolves to the fixture.
    await resolveAs((host) => (host === "mcp-lan.invalid" ? [{ address: "127.0.0.1", family: 4 }] : undefined), async () => {
      installOutboundPolicySource(() => ({ cleartextRemote: "warn" }));
      try {
        const warning = createStreamableHttpTransport({ ...POLICY, url: remote, timeoutMs: 5000, protocolVersion: PROTOCOL });
        await warning.connect();
        await warning.send(INITIALIZED);
      } finally {
        installOutboundPolicySource(() => ({}));
      }
    });
    assert.equal(server.requests.length, 1, "warned: sent once");
  } finally {
    await server.close();
  }
});

test("streamable http: a server ping on the answer stream is answered and never resolves the client's request (H-1)", async () => {
  const server = await startStreamableHttpServer({ mode: "sse", pingFirst: true });
  try {
    const client = createMcpClientFromConfig({ id: "remote", transport: "http", url: server.url }, CLIENT_OPTIONS);
    const info = await client.connect();
    assert.equal(info.name, "streamable-fixture", "the client's request 1 resolved with the REAL result, not the server's ping 1");
    // The client answers the ping on its own POST (its own connection): the
    // answer is awaited as the server's event, never a guessed tick (H-1 was
    // red under load when one setImmediate was the wait).
    const isAnswer = (r: { body: string }): boolean => {
      const message = JSON.parse(r.body || "null") as Record<string, unknown> | null;
      return message !== null && message["method"] === undefined;
    };
    const answered = await server.nextRequest(isAnswer, 30_000);
    assert.deepEqual(JSON.parse(answered.body), { jsonrpc: "2.0", id: 1, result: {} }, "the ping was answered with an empty result");
    await client.close();
  } finally {
    await server.close();
  }
});

test("streamable http: a stream closed before the answer is resumed by GET with Last-Event-ID after the server's retry (H-2)", async () => {
  const retryMs = 150;
  const server = await startStreamableHttpServer({ mode: "sse", pollAfterPrime: { retryMs } });
  try {
    const client = createMcpClientFromConfig({ id: "remote", transport: "http", url: server.url }, CLIENT_OPTIONS);
    await client.connect();
    const result = await client.callTool("echo", { polled: true });
    assert.equal(result.content[0]!.text, JSON.stringify({ polled: true }));
    const post = server.requests.find((r) => r.method === "POST" && r.body.includes("tools/call"))!;
    const get = server.requests.find((r) => r.method === "GET")!;
    assert.equal(get.headers["last-event-id"], "poll-1");
    assert.equal(get.headers["accept"], "text/event-stream");
    assert.ok(get.at - post.at >= retryMs - 5, `the retry field was honoured (waited ${get.at - post.at} ms)`);
    await client.close();
  } finally {
    await server.close();
  }
});

test("streamable http: a stream that ends with no event id and no answer is a typed refusal, not a silent timeout", async () => {
  serve(async () => new Response("data: \n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
  const transport = createStreamableHttpTransport({ ...POLICY, url: address("https://mcp.example.com/mcp"), timeoutMs: 5000, protocolVersion: PROTOCOL });
  await transport.connect();
  await assert.rejects(() => transport.send(LIST, { answered: () => false }), (e: unknown) => e instanceof McpError && e.code === "mcp_stream_ended_without_response");
});

test("streamable http: cancelling a call sends notifications/cancelled naming the request (H-3)", async () => {
  const server = await startStreamableHttpServer({ mode: "json", holdCalls: true });
  try {
    const client = createMcpClientFromConfig({ id: "remote", transport: "http", url: server.url }, CLIENT_OPTIONS);
    await client.connect();
    const controller = new AbortController();
    const call = client.callTool("echo", {}, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await assert.rejects(call, (e: unknown) => e instanceof McpError && e.code === "mcp_cancelled");
    const deadline = Date.now() + 2000;
    let cancelled: Record<string, unknown> | undefined;
    while (cancelled === undefined && Date.now() < deadline) {
      cancelled = server.requests.map((r) => JSON.parse(r.body || "null") as Record<string, unknown> | null)
        .find((m) => m !== null && m["method"] === "notifications/cancelled") ?? undefined;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const callId = (server.requests.map((r) => JSON.parse(r.body || "null") as Record<string, unknown> | null)
      .find((m) => m !== null && m["method"] === "tools/call"))!["id"];
    assert.deepEqual((cancelled?.["params"] as Record<string, unknown> | undefined)?.["requestId"], callId);
    await client.close();
  } finally {
    await server.close();
  }
});

test("websocket: the configured headers (auth included) pass the header allowlist and ride the handshake; ws:// to another host is refused", async () => {
  const server = await startWebSocketServer();
  try {
    const transport = createWebSocketTransport({ url: server.url, headers: { "X-API-Key": "k" }, subprotocol: "mcp", timeoutMs: 5000, ...WS_BOUNDS });
    await transport.connect();
    assert.equal(server.handshakes.length, 1);
    assert.equal(server.handshakes[0]!.headers["x-api-key"], "k");
    assert.deepEqual(server.handshakes[0]!.protocols, ["mcp"]);
    await transport.close();
  } finally {
    await server.close();
  }
  const cleartext = createWebSocketTransport({ url: "ws://example.com/mcp", timeoutMs: 50, ...WS_BOUNDS });
  await assert.rejects(() => cleartext.connect(), (e: unknown) => (e as { code?: string }).code === "outbound_cleartext_refused");
  const framing = createWebSocketTransport({ url: "wss://example.com/mcp", headers: { Host: "evil" }, timeoutMs: 50, ...WS_BOUNDS });
  await assert.rejects(() => framing.connect(), (e: unknown) => (e as { code?: string }).code === "outbound_header_refused");
});

// ---------------------------------------------------------------------------
// stdio transport (mock spawn)
// ---------------------------------------------------------------------------

test("stdio: connect spawns process and sends messages via stdin", async () => {
  let writtenInput: string | undefined;
  const mockChild: any = {
    stdin: {
      write: (data: string, cb: (err?: Error | null) => void) => { writtenInput = data; cb(null); },
      // The transport registers one-shot 'error' listeners on stdin (EPIPE
      // is a connect/write failure, not a crash) — the mock must accept the
      // register/remove pair the write helper uses.
      on: () => {},
      removeListener: () => {},
    },
    stdout: { setEncoding: () => {}, on: () => {} },
    stderr: { setEncoding: () => {}, on: () => {} },
    on: () => {},
    killed: false,
    kill: () => { mockChild.killed = true; return true; },
  };
  const mockSpawn = () => mockChild;
  const transport = createStdioTransport({ command: "echo", args: ["hi"], cwd: "/srv/home", env: {}, spawn: mockSpawn, closeGraceMs: 5000, stderrTailBytes: 8192, ...STDIO_BOUNDS });
  await transport.connect();
  assert.equal(transport.isConnected, true);
  await transport.send('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  assert.ok(writtenInput!.includes('"method":"ping"'));
  await transport.close();
  assert.equal(transport.isConnected, false);
});

/** A duck child that accepts the listeners the transport registers. */
function quietChild(): unknown {
  return {
    stdin: { write: (_d: string, cb: (err?: Error | null) => void) => cb(null), on: () => {}, removeListener: () => {} },
    stdout: { setEncoding: () => {}, on: () => {} },
    stderr: { setEncoding: () => {}, on: () => {} },
    on: () => {},
    killed: false,
    kill: () => true,
  };
}

test("stdio: the host's working directory and environment reach the spawn EXACTLY — nothing is inherited from this process", async () => {
  process.env["BRIDLEWISE_TEST_SECRET"] = "sk-must-not-leak";
  try {
    let seen: Parameters<McpSpawn>[2] | undefined;
    const spawnSpy: McpSpawn = (_command, _args, options) => { seen = options; return quietChild(); };
    const client = createMcpClientFromConfig(
      { id: "local", transport: "stdio", command: "server-bin", env: { CONFIGURED: "yes" }, auth: { type: "bearer", token: "tok-123", envName: "SERVER_TOKEN" } },
      {
        clientInfo: { name: "t", version: "1" }, defaultProtocolVersion: PROTOCOL, defaultTimeoutMs: 200,
        stdioHost: { cwd: "/srv/mcp-home/local", environment: { PATH: "/usr/bin", HOME: "/srv/mcp-home/local" }, spawn: spawnSpy },
      },
    );
    await client.connect().catch(() => undefined);
    assert.equal(seen?.cwd, "/srv/mcp-home/local");
    assert.deepEqual(
      { ...seen?.env },
      { PATH: "/usr/bin", HOME: "/srv/mcp-home/local", CONFIGURED: "yes", SERVER_TOKEN: "tok-123" },
      "the base environment is the host's, plus the entry's own configured env and credentials — and nothing else",
    );
    assert.equal(seen?.env["BRIDLEWISE_TEST_SECRET"], undefined, "a secret in this process's environment never reaches an MCP server");
    await client.close();
  } finally {
    delete process.env["BRIDLEWISE_TEST_SECRET"];
  }
});

test("stdio: without the host's placement a stdio entry is refused — the MCP module has no default spawn, directory or environment", () => {
  assert.throws(
    () => createMcpClientFromConfig(
      { id: "local", transport: "stdio", command: "server-bin" },
      { clientInfo: { name: "t", version: "1" }, defaultProtocolVersion: PROTOCOL, defaultTimeoutMs: 200 },
    ),
    (e: unknown) => (e as { code?: string }).code === "mcp_config_invalid",
  );
});

test("stdio: a host that refuses to start the server surfaces as mcp_spawn_refused carrying the host's reason code", async () => {
  const { HarnessError } = await import("../../src/kernel/errors.ts");
  const transport = createStdioTransport({
    command: "server-bin", cwd: "/srv/home", env: {}, closeGraceMs: 50, stderrTailBytes: 8192, ...STDIO_BOUNDS,
    spawn: () => { throw new HarnessError("confinement is unavailable on this computer", "unavailable"); },
  });
  await assert.rejects(() => transport.connect(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "mcp_spawn_refused");
    assert.equal(e.safeDetails["reason"], "unavailable");
    assert.match(e.message, /confinement is unavailable/u);
    return true;
  });
  assert.equal(transport.isConnected, false);
});

// A spawned child runs NO user code until node boots — a SIGTERM delivered
// into that window is handled by the DEFAULT action, which is the correct
// destabilizer of both termination arms (a pre-boot child cannot ignore the
// signal, so nothing is proven about the escalation; it cannot flush, so
// nothing is proven about the polite path). The arms therefore wait for the
// child's OWN boot witness before closing: the ready file is written by the
// child's first statement, so its presence means its SIGTERM handler exists.
/**
 * Until the child announces itself by its file — EVENTS only, never a wall
 * timeout (NO-LOAD-BLOCK): ready when the file exists; refused, naming how it
 * ended, when the child exits first; refused when the test's own signal
 * aborts (the runner's hang backstop, a cancel). It used to give up after 250
 * polls of 20 ms, a 5 s wall judgement a loaded host's slow boot could fail.
 */
function untilChildReady(path: string, child: () => ChildProcess | undefined, signal: AbortSignal, periodMs: number): Promise<true> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve(true); else reject(error);
    };
    const onAbort = (): void => finish(new Error(`the wait for ${path} ended: the test's signal aborted (${String(signal.reason)})`));
    const look = (): void => {
      if (existsSync(path)) return finish();
      const spawned = child();
      if (spawned !== undefined && (spawned.exitCode !== null || spawned.signalCode !== null)) {
        return finish(new Error(`the child exited before it was ready (code ${String(spawned.exitCode)}, signal ${String(spawned.signalCode)}): ${path} never appeared`));
      }
      timer = setTimeout(look, periodMs);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    look();
  });
}

// The count of THIS worker's live script children carrying a unique marker
// in their cmdline, read through the procfs owner (ppid + cmdline) — no extra
// process is spawned, and the ppid scope keeps parallel files and workers
// out of the count. A child that outlives close() is a leak, whatever the
// close's own timers reported.
function liveMarkCount(marker: string): number {
  return allProcessIds().filter((pid) =>
    parentOf(pid) === process.pid && isProcessAlive(pid) && (commandLineOf(pid) ?? []).join(" ").includes(marker)).length;
}

/** A scripted stdio child behind a transport, and the child process itself (for the readiness wait). */
function spawnScriptedChild(options: { ready: string; flushed: string; flushMs: number; ignoreSigterm: boolean; selfExitMs: number; terminationMs: number }) {
  let spawned: ChildProcess | undefined;
  // READY IS ANNOUNCED ONLY ONCE THE SIGTERM HANDLER IS INSTALLED. The child
  // used to write its ready file first: a child preempted between the two (a
  // loaded host) was ready by its file while a SIGTERM still took the default
  // action and killed it, so it never flushed and the polite arm read no
  // flushed file at all.
  const esc =
    (options.ignoreSigterm
      ? "process.on('SIGTERM',()=>{});"
      : "process.on('SIGTERM',()=>{require('node:fs').writeFileSync(process.env.STDIO_FLUSHED_PATH,'received\\n',{flag:'a'});setTimeout(()=>{require('node:fs').writeFileSync(process.env.STDIO_FLUSHED_PATH,'completed\\n',{flag:'a'});process.exit(0)}," + options.flushMs + ")});") +
    "require('node:fs').writeFileSync(process.env.STDIO_READY_PATH,'');" +
    "setTimeout(()=>process.exit(0)," + options.selfExitMs + ")";
  const transport = createStdioTransport(
    {
      command: process.execPath,
      // The extra argv entry carries the unique marker so the /proc witness
      // can attribute the process to exactly this arm.
      args: ["-e", esc, options.flushed],
      cwd: process.cwd(),
      env: { STDIO_READY_PATH: options.ready, STDIO_FLUSHED_PATH: options.flushed },
      spawn: (command, args, spawnOptions) => (spawned = spawn(command, [...args], { ...spawnOptions, stdio: [...spawnOptions.stdio] })),
      closeGraceMs: options.terminationMs, stderrTailBytes: 8192, ...STDIO_BOUNDS,
    },
  );
  return { transport, ready: (signal: AbortSignal): Promise<true> => untilChildReady(options.ready, () => spawned, signal, 20) };
}

test("stdio: close escalates a ready child that ignores SIGTERM within the configured bound", { timeout: 35_000 }, async (t) => {
  // The owner creates AND registers removal in one call (removed even when
  // this arm fails) — no hand-rolled mkdtemp + trailing rmSync that leaks on
  // the failure path it is supposed to diagnose.
  const dir = createTempDir("stdio-terminate-");
  const ready = join(dir, "ready.txt");
  const flushed = join(dir, "flushed.txt");
  const { transport, ready: childReady } = spawnScriptedChild({ ready, flushed, flushMs: 0, ignoreSigterm: true, selfExitMs: 30_000, terminationMs: 50 });
  await transport.connect();
  assert.equal(await childReady(t.signal), true, "the child must boot before its signal behaviour means anything");
  const started = Date.now();
  await transport.close();
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 30_000,
    "close must resolve from the escalation path, not by waiting out the child — elapsed " + elapsed + "ms vs the 30000ms backstop",
  );
  assert.equal(transport.isConnected, false);
  assert.equal(existsSync(flushed), false, "the ignoring child never flushes — close must not be satisfied by luck");
  assert.equal(
    liveMarkCount(flushed),
    0,
    "the escalation must KILL the child — a resolved close with a live SIGTERM-ignoring child is a leak, not a shutdown",
  );
});

test("stdio: a child process error event marks the transport closed through the close handler — never an uncaught throw", async () => {
  // A spawn failure (operator typo in `command`) used to be a thrown McpError
  // inside the child 'error' LISTENER — no caller exists there, so the throw
  // crashed the whole server process. The event must shut the transport down
  // through the close handler instead: the registry learns the failure
  // through its signals, and the process lives.
  const { EventEmitter } = await import("node:events");
  const child = Object.assign(new EventEmitter(), {
    killed: false,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdin: { write: (_data: string, cb: (err?: Error | null) => void) => cb(null), on: () => {}, removeListener: () => {} },
    stdout: { setEncoding: () => {}, on: () => {} },
    stderr: { setEncoding: () => {}, on: () => {} },
  });
  const transport = createStdioTransport(
    { command: "no-such-command", args: [], cwd: "/srv/home", env: {}, spawn: () => child, closeGraceMs: 400, stderrTailBytes: 8192, ...STDIO_BOUNDS },
  );
  await transport.connect();
  assert.equal(transport.isConnected, true, "witness: the transport was connected before the error event");
  let closed = 0;
  transport.onClose(() => { closed += 1; });
  // The OLD shape threw from inside the listener; this emit propagates such
  // a throw synchronously and fails the test — liveness for the refusal.
  child.emit("error", new Error("spawn ENOENT"));
  assert.equal(closed, 1, "the error event reports through the close handler exactly once");
  assert.equal(transport.isConnected, false, "the transport is no longer connected");
});

test("stdio: a polite close cancels the escalation timer — the configured bound never fires a late SIGKILL", async () => {
  // A DuckChild that politely exits on SIGTERM. With the escalation timer left
  // pending after such a close, the bound would STILL fire at t=TerminationMs
  // and send a late SIGKILL at a long-closed child (harmless — a closed
  // handle receives nothing — but dead work the polite path never needed).
  // The close must cancel the timer: the kill log stays a single SIGTERM even
  // after the bound has been outlived.
  const killLog: string[] = [];
  const listeners = new Map<string, (() => void)[]>();
  const duckChild = {
    killed: false,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdin: { write: (_data: string, cb: (err?: Error | null) => void) => cb(null), on: () => {}, removeListener: () => {} },
    stdout: { setEncoding: () => {}, on: () => {} },
    stderr: { setEncoding: () => {}, on: () => {} },
    on: () => {},
    once(event: string, cb: () => void) { listeners.set(event, [...(listeners.get(event) ?? []), cb]); },
    kill(signal?: string): boolean {
      if (this.exitCode !== null) {
        // A kill landing after the exit is the late-escalation shape this
        // arm exists to refuse — record it distinctly so the assertion
        // names it.
        killLog.push(`late:${signal}`);
        return false;
      }
      killLog.push(signal ?? "SIGTERM");
      if (signal === "SIGTERM") {
        setTimeout(() => {
          this.exitCode = 0;
          for (const cb of listeners.get("close") ?? []) cb();
        }, 10);
      }
      return true;
    },
  };
  const transport = createStdioTransport(
    { command: "true", args: [], cwd: "/srv/home", env: {}, spawn: () => duckChild, closeGraceMs: 400, stderrTailBytes: 8192, ...STDIO_BOUNDS },
  );
  await transport.connect();
  const started = Date.now();
  await transport.close();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 300, `a polite close resolves from the close event, not by waiting out the bound — elapsed ${elapsed}ms vs the 400ms bound`);
  // Outlive the bound: the escalation timer must be gone.
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.deepEqual(
    killLog,
    ["SIGTERM"],
    "a polite close cancels the escalation timer — a pending one fires a late SIGKILL at a closed child",
  );
  assert.equal(transport.isConnected, false);
});

test("stdio: a generous termination bound lets a ready child finish its SIGTERM flush — the polite path is taken", { timeout: 35_000 }, async (t) => {
  const dir = createTempDir("stdio-terminate-");
  const ready = join(dir, "ready.txt");
  const flushed = join(dir, "flushed.txt");
  const { transport, ready: childReady } = spawnScriptedChild({ ready, flushed, flushMs: 400, ignoreSigterm: false, selfExitMs: 30_000, terminationMs: 10_000 });
  await transport.connect();
  assert.equal(await childReady(t.signal), true, "the child must boot before its signal behaviour means anything");
  await transport.close();
  assert.equal(transport.isConnected, false);
  assert.equal(
    readFileSync(flushed, "utf8").trim(),
    "received\ncompleted",
      "a generous bound lets the child's SIGTERM flush COMPLETE — a cut-short flush records 'received' but never 'completed'",
  );
});



test("stdio: a server that floods stderr keeps answering — the pipe is drained, each line reaches the host, the tail is bounded (T-2)", { timeout: 30_000 }, async () => {
  // Writes 1 MiB to stderr (a chatty server), THEN answers on stdout. An
  // unread stderr pipe blocks the write after ~64 KiB and the answer never comes.
  const script = [
    "process.stderr.write(('x'.repeat(1023) + '\\n').repeat(1024));",
    "process.stderr.write('last line\\n', () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\\n'));",
    "setInterval(() => {}, 1000);",
  ].join("");
  const lines: string[] = [];
  const transport = createStdioTransport({
    command: process.execPath, args: ["-e", script], cwd: process.cwd(), env: {}, closeGraceMs: 500, stderrTailBytes: 4096, ...STDIO_BOUNDS,
    onStderr: (line) => { lines.push(line); },
    spawn: (command, args, options) => spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: [...options.stdio] }),
  });
  const answered = new Promise<string>((resolve) => transport.onMessage(resolve));
  await transport.connect();
  assert.equal(JSON.parse(await answered).id, 1, "the answer after 1 MiB of stderr arrived");
  assert.equal(lines.length, 1025, "every stderr line reached the host");
  assert.ok(lines.every((line) => line.length <= 4096), "each line is bounded");
  const reason = transport.closeReason?.() ?? "";
  assert.ok(Buffer.byteLength(reason, "utf8") <= 4096 + 1024, `the tail is bounded (${Buffer.byteLength(reason, "utf8")} bytes)`);
  assert.ok(reason.endsWith("last line"), "the tail holds the newest lines");
  await transport.close();
});

test("stdio: a server that dies is reported with its own last stderr, not a bare 'transport closed'", { timeout: 30_000 }, async () => {
  const client = createMcpClientFromConfig(
    { id: "dying", transport: "stdio", command: process.execPath, args: ["-e", "process.stderr.write('Permission denied: /srv/secret\\n', () => process.exit(126))"] },
    {
      clientInfo: { name: "t", version: "1" }, defaultProtocolVersion: PROTOCOL, defaultTimeoutMs: 5000, closeGraceMs: 500,
      stdioHost: { cwd: process.cwd(), environment: {}, spawn: (command, args, options) => spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: [...options.stdio] }) },
    },
  );
  await assert.rejects(() => client.connect(), (e: unknown) => e instanceof McpError && e.code === "mcp_transport_closed" && e.message.includes("Permission denied: /srv/secret"));
});

test("websocket: connects, sends, and delivers incoming frames (a real server)", async () => {
  let peer: WebSocketPeer | undefined;
  const server = await startWebSocketServer((connected) => { peer = connected; });
  try {
    const transport = createWebSocketTransport({ url: server.url, timeoutMs: 5000, ...WS_BOUNDS });
    const received = new Promise<string>((resolve) => transport.onMessage(resolve));
    await transport.connect();
    assert.equal(transport.isConnected, true);
    await transport.send('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    for (let wait = 0; wait < 100 && peer!.received.length === 0; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(peer!.received, ['{"jsonrpc":"2.0","id":1,"method":"ping"}']);
    peer!.sendText('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    assert.deepEqual(JSON.parse(await received), { jsonrpc: "2.0", id: 1, result: { ok: true } });
    const closing = server.nextClose();
    await transport.close();
    assert.equal(transport.isConnected, false);
    await closing;
    assert.equal(server.closeCodes.length, 1, "an explicit close sends the server a close frame");
  } finally {
    await server.close();
  }
});

test("websocket: fires onClose when the connection drops unexpectedly (a real server)", async () => {
  let peer: WebSocketPeer | undefined;
  const server = await startWebSocketServer((connected) => { peer = connected; });
  try {
    const transport = createWebSocketTransport({ url: server.url, timeoutMs: 5000, ...WS_BOUNDS });
    const closed = new Promise<void>((resolve) => transport.onClose(resolve));
    await transport.connect();
    assert.equal(transport.isConnected, true);
    peer!.drop();
    await closed;
    assert.equal(transport.isConnected, false);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Bounds a misbehaving server cannot push past (secb-security SECB-V-2/9/10/11,
// secb-design F-14, H-6).
// ---------------------------------------------------------------------------

/** A stdio transport over a real child running `script`. */
function stdioChild(script: string, overrides: Partial<Parameters<typeof createStdioTransport>[0]> = {}): ReturnType<typeof createStdioTransport> {
  return createStdioTransport({
    command: process.execPath, args: ["-e", script], cwd: process.cwd(), env: {}, closeGraceMs: 500, stderrTailBytes: 4096, ...STDIO_BOUNDS,
    spawn: (command, args, options) => spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: [...options.stdio] }),
    ...overrides,
  });
}

test("stdio: a stdout line past the message bound closes the transport typed — the host never buffers the flood (SECB-V-2)", { timeout: 30_000 }, async () => {
  // 64 KiB chunks with no newline, forever: the pre-fix transport grew without bound.
  const transport = stdioChild("const c = 'x'.repeat(65536); setInterval(() => process.stdout.write(c), 1);", { maxMessageBytes: 256 * 1024 });
  const closed = new Promise<void>((resolve) => transport.onClose(resolve));
  const messages: string[] = [];
  transport.onMessage((raw) => messages.push(raw));
  await transport.connect();
  await closed;
  assert.equal(messages.length, 0, "no partial message is delivered");
  assert.match(transport.closeReason?.() ?? "", /larger than 262144 bytes/u);
  assert.equal(transport.isConnected, false);
  await transport.close();
});

test("stdio: a message split across many chunks (a multibyte character across a boundary) arrives intact", async () => {
  const { EventEmitter } = await import("node:events");
  const stdout = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    killed: false, exitCode: null, signalCode: null, stdout, stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
    stdin: { write: (_d: string, cb: (e?: Error | null) => void) => cb(null), on: () => {}, removeListener: () => {} },
    kill: () => true,
  });
  const transport = createStdioTransport({ command: "x", cwd: "/srv/home", env: {}, closeGraceMs: 50, stderrTailBytes: 64, ...STDIO_BOUNDS, spawn: () => child });
  const messages: string[] = [];
  transport.onMessage((raw) => messages.push(raw));
  await transport.connect();
  const bytes = Buffer.from('{"text":"é€𝄞"}\n{"n":2}\n', "utf8");
  for (let offset = 0; offset < bytes.length; offset += 3) stdout.emit("data", bytes.subarray(offset, offset + 3));
  assert.deepEqual(messages, ['{"text":"é€𝄞"}', '{"n":2}']);
});

test("stdio: stderr beyond the per-second budget is counted and reported once, not logged line by line (SECB-V-11)", { timeout: 30_000 }, async () => {
  const script = [
    "process.stderr.write('line\\n'.repeat(5000));",
    "setTimeout(() => process.stderr.write('after\\n', () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\\n')), 1200);",
    "setInterval(() => {}, 1000);",
  ].join("");
  const lines: string[] = [];
  const transport = stdioChild(script, { stderrLinesPerSecond: 10, onStderr: (line) => { lines.push(line); } });
  const answered = new Promise<string>((resolve) => transport.onMessage(resolve));
  await transport.connect();
  await answered;
  assert.ok(lines.length <= 12, `at most the budget plus the count line reached the host (${lines.length})`);
  assert.ok(lines.some((line) => /^\[4990 more stderr lines in the last second were not logged/u.test(line)), `the drop is counted: ${lines.join(" | ")}`);
  assert.ok(lines.includes("after"), "a line in the next second passes again");
  await transport.close();
});

/** A fake transport that records sends; `hold` keeps each send pending until released. */
function recordingTransport(hold: boolean) {
  let handler: ((raw: string) => void) | undefined;
  const sent: string[] = [];
  const releases: Array<() => void> = [];
  return {
    sent, releases,
    deliver: (message: unknown) => handler?.(JSON.stringify(message)),
    transport: {
      transportType: "stdio" as const,
      isConnected: true,
      async connect() {},
      async send(raw: string) {
        sent.push(raw);
        if (hold) await new Promise<void>((resolve) => releases.push(resolve));
      },
      onMessage(h: (raw: string) => void) { handler = h; },
      onClose() {},
      async close() {},
    },
  };
}

test("core: server requests are answered one at a time and a backlog beyond the bound is dropped (SECB-V-10)", async () => {
  const { createMcpCoreClient } = await import("../../src/mcp/core.ts");
  const fake = recordingTransport(true);
  createMcpCoreClient({ serverId: "s", transport: fake.transport, protocolVersion: PROTOCOL, clientInfo: { name: "t", version: "1" }, timeoutMs: 5000, serverRequestBacklog: 4 });
  for (let id = 1; id <= 2000; id += 1) fake.deliver({ jsonrpc: "2.0", id: `ping-${id}`, method: "ping" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.sent.length, 1, "one answer on the wire at a time, never 2000 at once");
  while (fake.releases.length > 0) {
    fake.releases.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fake.sent.length, 4, "the backlog bound: the rest were dropped");
  assert.deepEqual(JSON.parse(fake.sent[0]!), { jsonrpc: "2.0", id: "ping-1", result: {} });
});

test("core: a reply that is not a JSON-RPC response rejects ITS request typed; the client keeps working (SCALE-CR1 C1)", async () => {
  const { createMcpCoreClient } = await import("../../src/mcp/core.ts");
  const fake = recordingTransport(false);
  const client = createMcpCoreClient({ serverId: "s", transport: fake.transport, protocolVersion: PROTOCOL, clientInfo: { name: "t", version: "1" }, timeoutMs: 200, serverRequestBacklog: 4 });
  const connecting = client.connect();
  await new Promise((resolve) => setImmediate(resolve));
  fake.deliver({ jsonrpc: "2.0", id: 1, result: { protocolVersion: PROTOCOL, serverInfo: { name: "s", version: "1" } } });
  await connecting;
  const lastId = (): number => Number((JSON.parse(fake.sent.at(-1)!) as { id: number }).id);
  for (const [label, reply] of [
    ["error null", (id: number) => ({ jsonrpc: "2.0", id, error: null })],
    ["error a string", (id: number) => ({ jsonrpc: "2.0", id, error: "x" })],
    ["error without a message", (id: number) => ({ jsonrpc: "2.0", id, error: { code: 5 } })],
    ["error with a fractional code", (id: number) => ({ jsonrpc: "2.0", id, error: { code: 1.5, message: "m" } })],
    ["result and error", (id: number) => ({ jsonrpc: "2.0", id, result: { content: [] }, error: { code: 1, message: "m" } })],
    ["neither result nor error", (id: number) => ({ jsonrpc: "2.0", id })],
  ] as const) {
    const call = client.callTool("t", {});
    await new Promise((resolve) => setImmediate(resolve));
    fake.deliver(reply(lastId()));
    await assert.rejects(call, (e: unknown) => e instanceof McpError && e.code === "mcp_protocol_violation", label);
  }
  // An id nothing can correlate answers no request: it is dropped (logged), and
  // the request it might have meant settles by its own timeout, typed.
  const orphaned = client.callTool("t", {});
  await new Promise((resolve) => setImmediate(resolve));
  fake.deliver({ jsonrpc: "2.0", id: {}, result: { content: [], isError: false } });
  await assert.rejects(orphaned, (e: unknown) => e instanceof McpError && e.code === "mcp_timeout");
  // A well-formed error and a well-formed result still work on the same client.
  const failing = client.callTool("t", {});
  await new Promise((resolve) => setImmediate(resolve));
  fake.deliver({ jsonrpc: "2.0", id: lastId(), error: { code: -32001, message: "rate limited" } });
  await assert.rejects(failing, (e: unknown) => e instanceof McpError && e.code === "mcp_rpc_error_-32001");
  const ok = client.callTool("t", {});
  await new Promise((resolve) => setImmediate(resolve));
  fake.deliver({ jsonrpc: "2.0", id: lastId(), result: { content: [{ type: "text", text: "fine" }], isError: false } });
  assert.equal((await ok).content[0]?.text, "fine");
  assert.equal(client.connected, true);
});

test("core: an initialize result without a protocol version and server identity is a typed refusal, never a TypeError", async () => {
  const { createMcpCoreClient } = await import("../../src/mcp/core.ts");
  for (const result of [{}, { protocolVersion: PROTOCOL }, { protocolVersion: PROTOCOL, serverInfo: null }, null]) {
    const fake = recordingTransport(false);
    const client = createMcpCoreClient({ serverId: "s", transport: fake.transport, protocolVersion: PROTOCOL, clientInfo: { name: "t", version: "1" }, timeoutMs: 500, serverRequestBacklog: 4 });
    const connecting = client.connect();
    await new Promise((resolve) => setImmediate(resolve));
    fake.deliver({ jsonrpc: "2.0", id: 1, result });
    await assert.rejects(connecting, (e: unknown) => e instanceof McpError && e.code === "mcp_initialize_failed", JSON.stringify(result));
  }
});

test("stdio: a real server's malformed replies never end the host; each fails its own call and the next call is answered (SCALE-CR1 C1)", { timeout: 30_000 }, async () => {
  const fixture = join(import.meta.dirname, "fixtures", "adversarial-mcp-server.mjs");
  const client = createMcpClientFromConfig(
    { id: "malformed", transport: "stdio", command: process.execPath, args: [fixture, "--mode=malformed-replies", "--tools=echo"], timeoutMs: 1_000 },
    {
      clientInfo: { name: "t", version: "1" }, defaultProtocolVersion: PROTOCOL, defaultTimeoutMs: 1_000, closeGraceMs: 500,
      stdioHost: { cwd: process.cwd(), environment: {}, spawn: (command, args, options) => spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: [...options.stdio] }) },
    },
  );
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => { uncaught.push(error); };
  process.on("uncaughtException", onUncaught);
  try {
    await client.connect();
    for (const label of ["error null", "error a string", "result and error"]) {
      await assert.rejects(() => client.callTool("echo", {}), (e: unknown) => e instanceof McpError && e.code === "mcp_protocol_violation", label);
    }
    await assert.rejects(() => client.callTool("echo", {}), (e: unknown) => e instanceof McpError && e.code === "mcp_timeout", "an object id answers nothing");
    const answered = await client.callTool("echo", {});
    assert.match(answered.content[0]?.text ?? "", /^pong:5:/u);
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    await client.close();
  }
});

test("core: a request that times out TELLS the server (notifications/cancelled), like a cancel (F-14)", async () => {
  const { createMcpCoreClient } = await import("../../src/mcp/core.ts");
  const fake = recordingTransport(false);
  const client = createMcpCoreClient({ serverId: "s", transport: fake.transport, protocolVersion: PROTOCOL, clientInfo: { name: "t", version: "1" }, timeoutMs: 50, serverRequestBacklog: 4 });
  const connecting = client.connect();
  await new Promise((resolve) => setImmediate(resolve));
  fake.deliver({ jsonrpc: "2.0", id: 1, result: { protocolVersion: PROTOCOL, serverInfo: { name: "s", version: "1" } } });
  await connecting;
  await assert.rejects(() => client.callTool("slow", {}), (e: unknown) => e instanceof McpError && e.code === "mcp_timeout");
  await new Promise((resolve) => setImmediate(resolve));
  const call = fake.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>).find((m) => m["method"] === "tools/call")!;
  const cancelled = fake.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>).find((m) => m["method"] === "notifications/cancelled");
  assert.deepEqual((cancelled?.["params"] as Record<string, unknown> | undefined)?.["requestId"], call["id"]);
});

test("streamable http: a server's retry is CLAMPED to [sseReconnectMs, sseRetryMaxMs] (SECB-V-9)", async () => {
  for (const [retryMs, floor] of [[0, 200], [99_999_999_999, 150]] as const) {
    const server = await startStreamableHttpServer({ mode: "sse", pollAfterPrime: { retryMs } });
    try {
      const policy = { ...POLICY, sseReconnectMs: retryMs === 0 ? floor : 1, sseRetryMaxMs: retryMs === 0 ? 10_000 : floor };
      const client = createMcpClientFromConfig({ id: "remote", transport: "http", url: server.url }, { ...CLIENT_OPTIONS, ...policy });
      await client.connect();
      await client.callTool("echo", {});
      const post = server.requests.find((r) => r.method === "POST" && r.body.includes("tools/call"))!;
      const get = server.requests.find((r) => r.method === "GET")!;
      const waited = get.at - post.at;
      assert.ok(waited >= floor - 5, `retry ${retryMs}: waited ${waited} ms, at least ${floor}`);
      assert.ok(waited < 5_000, `retry ${retryMs}: never an absurd or overflowing wait (${waited} ms)`);
      await client.close();
    } finally {
      await server.close();
    }
  }
});

test("streamable http: a stream that never answers is resumed at most resumeAttempts times, then refused typed", async () => {
  const server = await startStreamableHttpServer({ mode: "sse", pollAfterPrime: { retryMs: 0, never: true } });
  try {
    const client = createMcpClientFromConfig({ id: "remote", transport: "http", url: server.url }, { ...CLIENT_OPTIONS, ...POLICY, resumeAttempts: 3 });
    await client.connect();
    await assert.rejects(() => client.callTool("echo", {}), (e: unknown) => e instanceof McpError && e.code === "mcp_resume_exhausted");
    assert.equal(server.requests.filter((r) => r.method === "GET").length, 3);
    await client.close();
  } finally {
    await server.close();
  }
});

test("streamable http: an event id that cannot be sent back is a typed refusal, not a raw TypeError", async () => {
  const server = await startStreamableHttpServer({ mode: "sse", pollAfterPrime: { retryMs: 0, eventId: "€-1" } });
  try {
    const client = createMcpClientFromConfig({ id: "remote", transport: "http", url: server.url }, { ...CLIENT_OPTIONS, ...POLICY });
    await client.connect();
    await assert.rejects(() => client.callTool("echo", {}), (e: unknown) => e instanceof McpError && e.code === "mcp_resume_id_invalid");
    assert.equal(server.requests.filter((r) => r.method === "GET").length, 0, "nothing was sent");
    await client.close();
  } finally {
    await server.close();
  }
});

test("websocket: a message past the bound is refused BEFORE it is assembled (the door's dispatcher), the connection ACTUALLY closes, typed — against a real server (SECC-V-B8)", async () => {
  const server = await startWebSocketServer((peer) => { setTimeout(() => { peer.sendText("x".repeat(2048)); peer.sendText('{"jsonrpc":"2.0","id":9,"result":{}}'); }, 5); });
  try {
    const transport = createWebSocketTransport({ url: server.url, timeoutMs: 5000, maxMessageBytes: 1024 });
    const messages: string[] = [];
    transport.onMessage((raw) => messages.push(raw));
    const dropped = new Promise<void>((resolve) => transport.onClose(resolve));
    const closeFrame = server.nextClose();
    await transport.connect();
    const code = await Promise.race([closeFrame, new Promise<"none">((resolve) => setTimeout(() => resolve("none"), 3000))]);
    // The door's dispatcher bounds the frame (`maxPayloadSize` = the core's
    // message bound) and its protocol layer closes with 1009 itself; the
    // transport's own 4009 stays for a message that is assembled anyway.
    assert.ok(code === 1009 || code === 4009, `the client closed with "message too big" (got ${String(code)})`);
    await dropped;
    assert.deepEqual(messages, [], "neither the oversized message nor anything after it reached the core");
    assert.equal(transport.isConnected, false);
    assert.match(transport.closeReason?.() ?? "", /message bound \(1024 bytes|larger than 1024 bytes/u);
  } finally {
    await server.close();
  }
});

test("retry: the outbound door's policy refusal is never retried — one request to a redirecting host, one attempt (F-1)", async () => {
  const { withRetry } = await import("../../src/mcp/retry.ts");
  const server = await startStreamableHttpServer({ mode: "json", redirectTo: "https://elsewhere.example/steal" });
  try {
    const transport = createStreamableHttpTransport({ ...POLICY, url: server.url, timeoutMs: 5000, protocolVersion: PROTOCOL });
    await transport.connect();
    let attempts = 0;
    await assert.rejects(
      () => withRetry(async () => { attempts += 1; await transport.send(INITIALIZE); }, { retry: { count: 3, backoffMs: 1 } }),
      (e: unknown) => (e as { code?: string }).code === "outbound_redirect_refused" && (e as { retryable?: boolean }).retryable === false,
    );
    assert.equal(attempts, 1, "a policy refusal is not an availability failure");
    assert.equal(server.requests.length, 1, "the redirecting host saw one request, not retry.count");
  } finally {
    await server.close();
  }
});

test("stdio: the readiness wait ends on an EVENT — a child that exits before it is ready is refused, naming its exit; an aborted signal ends it too", async () => {
  const dir = createTempDir("stdio-ready-");
  const never = join(dir, "never.txt");
  const child = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });
  await assert.rejects(untilChildReady(never, () => child, new AbortController().signal, 20), /the child exited before it was ready \(code 3, signal null\)/u);
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    const aborted = new AbortController();
    const waiting = untilChildReady(never, () => sleeper, aborted.signal, 20);
    aborted.abort(new Error("the runner's backstop"));
    await assert.rejects(waiting, /the test's signal aborted \(Error: the runner's backstop\)/u);
  } finally {
    sleeper.kill("SIGKILL");
  }
});
