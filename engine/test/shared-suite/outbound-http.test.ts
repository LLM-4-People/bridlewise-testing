/**
 * The outbound HTTP policy (`src/shared/outbound-http.ts`) — the one door the
 * LLM provider client, the MCP transports and every other sender go through,
 * and which owns its transport. There is no seam: every arm that sends
 * answers through a REAL loopback server (`../support/loopback-upstream.ts`)
 * reached by the door's own client, so the assertions are about what really
 * left the process. A name that must resolve somewhere is answered by the
 * resolver itself, patched for the arm (`resolveAs`).
 */
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  advertisedKeepAliveMs,
  closeConnection,
  closeOutboundConnections,
  connectionFreshForMs,
  isLoopbackHostName,
  isPublicAddress,
  openOutboundWebSocket,
  outboundDeadline,
  outboundFetch,
  pinnedLookup,
  readBody,
  remoteRefusedUnderTest,
  summedDispatcherState,
  type OutboundHttpRequest,
} from "../../src/shared/outbound-http.ts";
import { processUnderTest } from "../../src/filesystem/checkout-write-door.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { installOutboundPolicySource, OUTBOUND_POLICY_SCHEMA, outboundSignals } from "../../src/shared/outbound-policy.ts";
import { configureDebugSystem, createCollectingSink, resetDebugSystem } from "../../src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../src/shared/debug/debug-config.ts";
import { address, origin, received, resolveAs, serve } from "../support/loopback-upstream.ts";
import { requireHost } from "../support/host-requirement.ts";
import { createTempDir } from "../support/temp-dir.ts";

const PORT = new URL(origin).port;

function answering(answer: () => Response): void {
  serve(async () => answer());
}

function request(overrides: Partial<OutboundHttpRequest> = {}): OutboundHttpRequest {
  return {
    url: address("https://api.example.com/v1/x"), method: "POST", signal: AbortSignal.timeout(10_000),
    protocolHeaders: { Authorization: "Bearer k", "Content-Type": "application/json" },
    logCategory: "llm", allowPrivateAddress: true,
    ...overrides,
  };
}

const codeOf = (error: unknown): string | undefined => (error as { code?: string }).code;

/** Run `body` with the door's settings (restored after). */
async function withPolicy(policy: Readonly<{ cleartextRemote?: "refuse" | "warn" }>, body: () => Promise<void>): Promise<void> {
  installOutboundPolicySource(() => policy);
  try { await body(); } finally { installOutboundPolicySource(() => ({})); }
}

/** Run `body` with environment variables set (restored after). */
async function withEnv(values: Readonly<Record<string, string | undefined>>, body: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { await body(); } finally {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

/** Every proxy variable cleared (both spellings), then `values` applied. */
const PROXY_NAMES = ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const;
function proxyEnv(values: Readonly<Record<string, string>>): Record<string, string | undefined> {
  return { ...Object.fromEntries(PROXY_NAMES.map((name) => [name, undefined])), ...values };
}

test("outbound http: a 3xx of any kind is a typed refusal with no second request", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    answering(() => new Response(null, { status, headers: { location: "https://elsewhere.example.net/steal" } }));
    await assert.rejects(outboundFetch(request()), (error) => codeOf(error) === "outbound_redirect_refused"
      && (error as Error).message.includes("https://elsewhere.example.net"), String(status));
    assert.equal(received.length, 1, `${status}: exactly one request`);
  }
  assert.ok((outboundSignals().refusals["outbound_redirect_refused"] ?? 0) >= 5, "the refusal is counted as a signal");
  // 304 Not Modified (a conditional request's answer) points nowhere: it is answered, never refused as a redirect.
  const refusedBefore = outboundSignals().refusals["outbound_redirect_refused"] ?? 0;
  answering(() => new Response(null, { status: 304, headers: { etag: "\"v1\"" } }));
  const notModified = await outboundFetch(request({ method: "GET", protocolHeaders: { "If-None-Match": "\"v1\"" } }));
  assert.equal(notModified.status, 304);
  assert.equal(outboundSignals().refusals["outbound_redirect_refused"] ?? 0, refusedBefore);
});

test("outbound http: cleartext to another host is refused by the ONE door setting (or warned); loopback — exactly — is allowed", async () => {
  answering(() => new Response("ok"));
  await assert.rejects(outboundFetch(request({ url: "http://api.example.com/v1" })), (error) => codeOf(error) === "outbound_cleartext_refused");
  // *.localhost is NOT loopback: the system resolver may send it anywhere (SECB-V-3, measured to a LAN host).
  await assert.rejects(outboundFetch(request({ url: "http://model.localhost/v1" })), (error) => codeOf(error) === "outbound_cleartext_refused");
  assert.equal(received.length, 0, "refused before dispatch");
  for (const url of [`http://127.0.0.1:${PORT}/v1`, `http://localhost:${PORT}/v1`]) {
    await readBody(await outboundFetch(request({ url })), AbortSignal.timeout(5_000), 64, 100, "llm");
  }
  assert.equal(received.length, 2);
  // Warned: a non-loopback NAME (resolved here to the upstream) is sent, and the origin is a signal.
  await resolveAs((host) => (host === "api.example.com" ? [{ address: "127.0.0.1", family: 4 }] : undefined), async () => {
    await withPolicy({ cleartextRemote: "warn" }, async () => {
      await readBody(await outboundFetch(request({ url: `http://api.example.com:${PORT}/v1` })), AbortSignal.timeout(5_000), 64, 100, "llm");
    });
  });
  assert.equal(received.length, 3);
  assert.ok(outboundSignals().cleartextOrigins.includes(`http://api.example.com:${PORT}`), "a warned origin is a signal");
});

test("outbound http: the loopback predicate is exact, and the public-address predicate knows every non-public range", () => {
  for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.9.9.9", "::1", "[::1]", "::ffff:127.0.0.1"]) assert.equal(isLoopbackHostName(host), true, host);
  for (const host of ["evil.localhost", "localhost.evil.com", "127.0.0.1.evil.com", "10.0.0.1", "0.0.0.0", "::", "example.com"]) assert.equal(isLoopbackHostName(host), false, host);
  const nonPublic = [
    "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "127.0.0.1", "0.0.0.0",
    "198.18.0.1", "198.19.255.255", "192.0.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fd00::1", "fe80::1", "fec0::1", "ff02::1", "2001:db8::1", "64:ff9b:1::1", "100::1",
    // IPv4 carried in IPv6 is judged by the IPv4 inside (secc-security SECC-V-B5).
    "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::a00:1", "::10.0.0.1", "64:ff9b::a00:1", "64:ff9b::10.0.0.1", "2002:a00:1::1", "2002:7f00:1::",
    // Teredo: the client address is the last 32 bits inverted (10.0.0.1 → f5ff:fffe).
    "2001:0:4136:e378:8000:63bf:f5ff:fffe",
  ];
  for (const address of nonPublic) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2606:4700::1111", "64:ff9b::808:808", "64:ff9b::8.8.8.8", "2002:808:808::1", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
  assert.ok(nonPublic.length >= 30, `ranges driven: ${nonPublic.length}`);
});

test("outbound http: a request that may not reach private addresses is refused before dispatch — literal, loopback name or resolved name", async () => {
  answering(() => new Response("ok"));
  for (const url of [`http://127.0.0.1:${PORT}/v1`, `http://127.0.0.2:${PORT}/v1`, `http://localhost:${PORT}/v1`, address("https://api.example.com/v1"),
    "https://10.0.0.5/v1", "https://[fd00::1]/v1", "https://169.254.169.254/latest", "https://[64:ff9b::a00:1]/v1"]) {
    await assert.rejects(outboundFetch(request({ url, allowPrivateAddress: false })), (error) => codeOf(error) === "outbound_private_destination_refused", url);
  }
  // A public-looking NAME that resolves privately — any one address private refuses.
  await resolveAs((host) => (host === "mixed.test" ? [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.9", family: 4 }] : undefined), async () => {
    await assert.rejects(outboundFetch(request({ url: "https://mixed.test/v1", allowPrivateAddress: false })), (error) => codeOf(error) === "outbound_private_destination_refused");
  });
  assert.equal(received.length, 0, "nothing reached the loopback upstream");
  // The same loopback destination, allowed: it is reached.
  await readBody(await outboundFetch(request({ url: `http://127.0.0.1:${PORT}/v1` })), AbortSignal.timeout(5_000), 64, 100, "llm");
  assert.equal(received.length, 1);
});

test("outbound http: DNS rebinding is closed — the socket connects to the address the door checked, never a second answer", async () => {
  answering(() => new Response("pinned"));
  // First answer: the loopback upstream. Every later answer: an unroutable private address.
  await resolveAs((host, call) => (host === "rebind.test" ? [{ address: call === 0 ? "127.0.0.1" : "10.255.255.1", family: 4 }] : undefined), async (calls) => {
    const lifetime = outboundDeadline(undefined, 5_000);
    try {
      // Cleartext to a non-loopback NAME is refused by default; warned here so the arm reaches the socket.
      await withPolicy({ cleartextRemote: "warn" }, async () => {
        const response = await outboundFetch(request({ url: `http://rebind.test:${PORT}/v1/models`, method: "GET", signal: lifetime.signal }));
        assert.equal(await readBody(response, lifetime.signal, 64, 100, "llm"), "pinned");
      });
    } finally { lifetime.clear(); }
    assert.equal(received.length, 1, "the checked (first) answer was the one connected to");
    assert.equal(calls(), 1, "the name was resolved exactly once");
  });
});

/**
 * A keep-alive server that ADVERTISES its idle timeout (`Keep-Alive:
 * timeout=2`), counts its connections, and — like every server whose idle
 * timer fired while the client's did not run — RESETS a connection when a
 * request arrives on it after that timeout (a stalled event loop; LAND-OC-FIX R3).
 */
async function keepAliveServer(stallAfterAnswerMs = 0, keepAliveSeconds = 2): Promise<Readonly<{ url: string; connections: () => number; open: () => number; staleBytes: () => number; close: () => Promise<void> }>> {
  let connections = 0;
  // Connections the client still holds open (a socket's close is the client retiring it).
  let open = 0;
  // Bytes that arrived on a connection AFTER the server's idle timeout: a request written on a stale socket (H-N2).
  let staleBytes = 0;
  let stalled = false;
  const server: Server = createServer((socket) => {
    connections += 1;
    open += 1;
    socket.on("close", () => { open -= 1; });
    let answeredAt = 0;
    let buffered = "";
    socket.on("data", (chunk: Buffer) => {
      if (answeredAt > 0 && Date.now() - answeredAt >= keepAliveSeconds * 1_000) { staleBytes += chunk.length; socket.resetAndDestroy(); return; }
      buffered += chunk.toString("latin1");
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/^content-length:\s*(\d+)/imu.exec(buffered.slice(0, end))?.[1] ?? "0");
      if (buffered.length < end + 4 + length) return;
      buffered = buffered.slice(end + 4 + length);
      answeredAt = Date.now();
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\nKeep-Alive: timeout=${String(keepAliveSeconds)}\r\n\r\nok`);
      // THE STALL BETWEEN THE ANSWER AND ITS READING (once): the whole process — the client too — is held right after the server answered.
      if (stallAfterAnswerMs > 0 && !stalled) {
        stalled = true;
        setImmediate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallAfterAnswerMs));
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    connections: () => connections,
    open: () => open,
    staleBytes: () => staleBytes,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.unref(); }),
  };
}

test("outbound http: a FRESH kept-alive connection carries the next request, a POST included — one handshake for many calls (LAND-OC-FIX round 5 §6)", async () => {
  await closeOutboundConnections();
  const server = await keepAliveServer();
  try {
    for (const method of ["POST", "POST", "GET", "POST"] as const) {
      const response = await outboundFetch(request({ url: server.url, method, ...(method === "POST" ? { body: "{}" } : {}) }));
      assert.equal(await readBody(response, AbortSignal.timeout(5_000), 64, 100, "llm"), "ok");
    }
    assert.equal(server.connections(), 1, "every call rode the one fresh connection");
  } finally {
    await closeOutboundConnections();
    await server.close();
  }
});

test("outbound http: a STALE kept-alive connection is CLOSED when it would be reused, never written to — even after a stall in which no timer ran (LAND-OC-FIX R3 at its cause)", async () => {
  await closeOutboundConnections();
  const server = await keepAliveServer();
  try {
    const first = await outboundFetch(request({ url: server.url, method: "POST", body: "{}" }));
    assert.equal(await readBody(first, AbortSignal.timeout(5_000), 64, 100, "llm"), "ok");
    // THE STALL: the event loop is held past the server's advertised keep-alive,
    // so no idle timer of the client can have run when the next POST is sent.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_200);
    const second = await outboundFetch(request({ url: server.url, method: "POST", body: "{}" }));
    assert.equal(await readBody(second, AbortSignal.timeout(5_000), 64, 100, "llm"), "ok", "the POST was not lost to the stale socket");
    assert.equal(server.connections(), 2, "the stale connection was closed and a fresh one carried the POST");
  } finally {
    await closeOutboundConnections();
    await server.close();
  }
});

test("outbound http: a stall BETWEEN the server's answer and the client reading it never starts the client's idle clock late — the next POST takes a new connection (round 7: matrix-executor at its cause)", async () => {
  await closeOutboundConnections();
  const server = await keepAliveServer(2_200);
  try {
    const first = await outboundFetch(request({ url: server.url, method: "POST", body: "{}" }));
    assert.equal(await readBody(first, AbortSignal.timeout(5_000), 64, 100, "llm"), "ok");
    const second = await outboundFetch(request({ url: server.url, method: "POST", body: "{}" }));
    assert.equal(await readBody(second, AbortSignal.timeout(5_000), 64, 100, "llm"), "ok", "the POST was not lost to the socket the server closed during the stall");
    assert.equal(server.connections(), 2, "the connection the server considered idle for the whole stall was closed, not reused");
  } finally {
    await closeOutboundConnections();
    await server.close();
  }
});

test("outbound http: a stall BETWEEN choosing a pooled connection and writing on it is caught at the write — the request, not one byte of it sent, goes on a fresh connection (round 7)", async () => {
  await closeOutboundConnections();
  const server = await keepAliveServer();
  const stallOnce = { armed: false };
  const stall = (): void => {
    if (!stallOnce.armed) return;
    stallOnce.armed = false;
    // The client chose the pooled connection (the request exists) but has not written it yet.
    setImmediate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_200));
  };
  diagnosticsChannel.subscribe("undici:request:create", stall);
  try {
    const first = await outboundFetch(request({ url: server.url, method: "POST", body: "{}" }));
    assert.equal(await readBody(first, AbortSignal.timeout(5_000), 64, 100, "llm"), "ok");
    stallOnce.armed = true;
    const second = await outboundFetch(request({ url: server.url, method: "POST", body: "{}" }));
    assert.equal(await readBody(second, AbortSignal.timeout(5_000), 64, 100, "llm"), "ok", "the POST was not written on the connection the server closed during the stall");
    assert.equal(server.connections(), 2, "the stale connection was retired at the write; a fresh one carried the POST once");
    assert.equal(server.staleBytes(), 0, "NOT ONE BYTE of the POST reached the stale connection before the resend (H-N2)");
  } finally {
    diagnosticsChannel.unsubscribe("undici:request:create", stall);
    await closeOutboundConnections();
    await server.close();
  }
});

test("outbound http: a stale-at-write request whose pool was EVICTED meanwhile (the LRU's graceful close) is still resent and answered — an admitted request finishes, never hangs (the reviewer's H-N1 repro)", async () => {
  await closeOutboundConnections();
  const server = await keepAliveServer();
  const others: Promise<unknown>[] = [];
  const stallOnce = { armed: false };
  const stall = (): void => {
    if (!stallOnce.armed) return;
    stallOnce.armed = false;
    // Between choosing the pooled connection and writing on it: as many other origins as the pool keeps, so this
    // origin's pool is evicted (closed gracefully), then a stall past the keep-alive.
    for (let index = 0; index < ROOT_POLICY.runtime.limits.maximumPinnedDispatchers; index += 1) {
      others.push(outboundFetch(request({ url: `http://127.0.${String(1 + Math.floor((index + 2) / 250))}.${String(((index + 2) % 250) + 1)}:9/x`, method: "GET", signal: AbortSignal.timeout(5_000) })).catch(() => undefined));
    }
    setImmediate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_200));
  };
  diagnosticsChannel.subscribe("undici:request:create", stall);
  try {
    const first = await outboundFetch(request({ url: server.url, method: "POST", body: "{}" }));
    assert.equal(await readBody(first, AbortSignal.timeout(5_000), 64, 100, "llm"), "ok");
    stallOnce.armed = true;
    // Bounded HERE too: the defect was a request that outlived its own deadline, so the test never waits on it alone.
    const answered = await Promise.race([
      outboundFetch(request({ url: server.url, method: "POST", body: "{}", signal: AbortSignal.timeout(8_000) })).then((response) => readBody(response, AbortSignal.timeout(5_000), 64, 100, "llm")),
      new Promise<string>((resolveLate) => setTimeout(() => resolveLate("still pending after 12 s: the request hung past its deadline"), 12_000).unref()),
    ]);
    assert.equal(answered, "ok", "the admitted POST was resent and answered on the evicted pool");
    assert.equal(server.staleBytes(), 0, "nothing was written on the stale connection");
    // A pool closed while its request was on it keeps no connection after it settles (H-L1): the client retires it.
    // Within a moment: well before the client would close an idle kept-alive connection on its own (seconds).
    const retiredBy = Date.now() + 300;
    while (server.open() > 0 && Date.now() < retiredBy) await new Promise((resolveSoon) => setTimeout(resolveSoon, 20));
    assert.equal(server.open(), 0, "the evicted pool retired the resent request's connection when it settled");
  } finally {
    diagnosticsChannel.unsubscribe("undici:request:create", stall);
    await Promise.all(others);
    await closeOutboundConnections();
    await server.close();
  }
});

test("outbound http: a request whose pool is DESTROYED during the stall, before its write, fails typed and at once — destroying errors every unwritten request, so it is never resent and never hangs past its deadline (correctness H-N1)", async () => {
  await closeOutboundConnections();
  const server = await keepAliveServer();
  const stallOnce = { armed: false };
  const stall = (): void => {
    if (!stallOnce.armed) return;
    stallOnce.armed = false;
    // Between choosing the pooled connection and writing on it: a stall past the keep-alive, then the pools are
    // destroyed (a shutdown) before the write is judged stale.
    setImmediate(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_200);
      void closeOutboundConnections();
    });
  };
  diagnosticsChannel.subscribe("undici:request:create", stall);
  try {
    const first = await outboundFetch(request({ url: server.url, method: "POST", body: "{}" }));
    assert.equal(await readBody(first, AbortSignal.timeout(5_000), 64, 100, "llm"), "ok");
    stallOnce.armed = true;
    // FAILED BY ITS PATH, never judged by a wall clock (NO-LOAD-BLOCK): when
    // the request rejects, its deadline has not fired, so the destroyed pool
    // failed it, not the deadline.
    const deadline = AbortSignal.timeout(8_000);
    await assert.rejects(outboundFetch(request({ url: server.url, method: "POST", body: "{}", signal: deadline })),
      (error: unknown) => error instanceof Error && !deadline.aborted, "the request fails, typed, before its deadline fired");
    assert.equal(server.staleBytes(), 0, "and nothing was written on the stale connection");
  } finally {
    diagnosticsChannel.unsubscribe("undici:request:create", stall);
    await closeOutboundConnections();
    await server.close();
  }
});

/** Run `body` with the network category's debug events collected; answers the event names seen. */
async function networkEvents(body: () => Promise<void>): Promise<readonly string[]> {
  const sink = createCollectingSink();
  configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, enabled: true, level: "debug", categories: ["network"], sinks: { enabledSinks: ["collecting"] } }, [sink]);
  try {
    await body();
  } finally {
    resetDebugSystem();
  }
  return sink.events.map((event) => (event as { message?: string }).message ?? "");
}

test("outbound http: an idle connection past its freshness is CLOSED AT DISPATCH, before any request is tied to it — the write-time check is the second line, not the first (correctness H-L1 M3)", async () => {
  await closeOutboundConnections();
  const server = await keepAliveServer();
  try {
    const events = await networkEvents(async () => {
      const first = await outboundFetch(request({ url: server.url, method: "POST", body: "{}" }));
      assert.equal(await readBody(first, AbortSignal.timeout(5_000), 64, 100, "llm"), "ok");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_200);
      const second = await outboundFetch(request({ url: server.url, method: "POST", body: "{}" }));
      assert.equal(await readBody(second, AbortSignal.timeout(5_000), 64, 100, "llm"), "ok");
    });
    assert.ok(events.includes("outbound_connection_stale_closed"), `closed at dispatch: ${events.join(", ")}`);
    assert.ok(!events.includes("outbound_connection_stale_at_write"), "never left for the write to catch");
  } finally {
    await closeOutboundConnections();
    await server.close();
  }
});

test("outbound http: a WebSocket handshake RELEASES its pool connection — an upgraded request never leaves its entry busy forever (correctness H-L1 M7)", async () => {
  const { startWebSocketServer } = await import("../support/websocket-server.ts");
  const server = await startWebSocketServer();
  try {
    const events = await networkEvents(async () => {
      await withPolicy({ cleartextRemote: "warn" }, async () => {
        const socket = await openOutboundWebSocket({ url: server.url, allowPrivateAddress: true, maxMessageBytes: 1024, logCategory: "mcp" });
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve());
          socket.addEventListener("error", () => reject(new Error("the handshake did not open")));
        });
        socket.close();
      });
    });
    assert.ok(events.includes("outbound_connection_released"), `the upgraded connection is released: ${events.join(", ")}`);
  } finally {
    await closeOutboundConnections();
    await server.close();
  }
});

test("outbound http: a cleartext request through a PROXY rides the freshness pool to the proxy too — a stall between the proxy's answer and its reading never lets the next POST ride the connection the proxy already closed (correctness O2; H-L1 M9)", async () => {
  await closeOutboundConnections();
  // A proxy that keeps a connection 6 s (a plain pool would keep it 4 s from the moment it READS the answer), and the
  // whole process stalled 6.3 s right after the proxy answered: only a clock started at dispatch knows it is stale.
  const proxy = await keepAliveServer(6_300, 6);
  try {
    await withPolicy({ cleartextRemote: "warn" }, async () => {
      await withEnv(proxyEnv({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxy.url.replace(/\/v1$/u, "") }), async () => {
        const first = await outboundFetch(request({ url: "http://upstream.example.net/v1", method: "POST", body: "{}" }));
        assert.equal(await readBody(first, AbortSignal.timeout(10_000), 64, 100, "llm"), "ok");
        const second = await outboundFetch(request({ url: "http://upstream.example.net/v1", method: "POST", body: "{}" }));
        assert.equal(await readBody(second, AbortSignal.timeout(5_000), 64, 100, "llm"), "ok", "the POST was not lost to the proxy connection closed during the stall");
      });
    });
    assert.equal(proxy.connections(), 2, "the connection the proxy considered idle for the whole stall was closed, not reused");
    assert.equal(proxy.staleBytes(), 0, "not one byte reached it");
  } finally {
    await closeOutboundConnections();
    await proxy.close();
  }
});

test("outbound http: a cleartext target's connection to its PROXY is the freshness pool's own — its release is the pool's event, so a proxy client built without the factory is seen (correctness H-L1 M9)", async () => {
  // The stall test above cannot tell a plain proxy client from the freshness
  // pool: a close that lands during a stall is read before the next write by
  // either (M9 is equivalent THERE). What tells them apart is whose connection
  // it is: only the freshness pool releases one by its event.
  await closeOutboundConnections();
  const proxy = await keepAliveServer();
  try {
    const events = await networkEvents(async () => {
      await withPolicy({ cleartextRemote: "warn" }, async () => {
        await withEnv(proxyEnv({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxy.url.replace(/\/v1$/u, "") }), async () => {
          const answer = await outboundFetch(request({ url: "http://upstream.example.net/v1", method: "POST", body: "{}" }));
          assert.equal(await readBody(answer, AbortSignal.timeout(5_000), 64, 100, "llm"), "ok");
        });
      });
    });
    assert.ok(events.includes("outbound_connection_released"), `the proxy connection rode the freshness pool: ${events.join(", ")}`);
  } finally {
    await closeOutboundConnections();
    await proxy.close();
  }
});

test("outbound http: the client whose internals the freshness pool reads is pinned EXACTLY — the declared version is a bare version, and it is the one installed (round 12 E24)", () => {
  const engine = new URL("../../", import.meta.url);
  const declared = (JSON.parse(readFileSync(new URL("package.json", engine), "utf8")) as { dependencies: Record<string, string> }).dependencies["undici"];
  assert.match(declared ?? "", /^\d+\.\d+\.\d+$/u, `undici is declared by a range (${String(declared)}): the pool reads its internal symbols, so an upgrade must be a reviewed change`);
  const installed = (JSON.parse(readFileSync(new URL("node_modules/undici/package.json", engine), "utf8")) as { version: string }).version;
  assert.equal(installed, declared, "the installed client is the pinned one");
});

test("outbound http: a threshold at or above the idle maximum is refused by the network section's schema — it would leave no reuse window at all, silently (correctness H-L6)", () => {
  assert.equal(OUTBOUND_POLICY_SCHEMA.safeParse({ idleConnectionMs: 1000, keepAliveThresholdMs: 1000 }).success, false, "equal: a window of zero");
  assert.equal(OUTBOUND_POLICY_SCHEMA.safeParse({ keepAliveThresholdMs: 5000 }).success, false, "against the default idle maximum");
  assert.equal(OUTBOUND_POLICY_SCHEMA.safeParse({ idleConnectionMs: 500 }).success, false, "below the default threshold");
  assert.equal(OUTBOUND_POLICY_SCHEMA.safeParse({ idleConnectionMs: 1001, keepAliveThresholdMs: 1000 }).success, true);
  assert.equal(OUTBOUND_POLICY_SCHEMA.safeParse({}).success, true, "the defaults leave a window");
});

test("outbound http: the freshness rule — the advertised keep-alive capped by the idle setting (else that setting) minus the threshold; the header is read as servers write it", () => {
  assert.equal(advertisedKeepAliveMs({ "keep-alive": "timeout=5, max=100" }), 5_000);
  assert.equal(advertisedKeepAliveMs({ "keep-alive": "max=100" }), undefined);
  assert.equal(advertisedKeepAliveMs({}), undefined);
  assert.equal(connectionFreshForMs(5_000, 4_000, 1_000), 3_000, "a longer advertised keep-alive is capped by the configured idle maximum");
  assert.equal(connectionFreshForMs(2_000, 4_000, 1_000), 1_000, "a shorter advertised keep-alive wins");
  assert.equal(connectionFreshForMs(undefined, 4_000, 1_000), 3_000);
});

test("outbound http: HTTP/2 over TLS — a stream ABOVE a GOAWAY's last-stream-id was never processed and is resent on a new connection; one the server took and then cut is a typed failure (RFC 9113 §6.8)", (t) => {
  requireHost(spawnSync("openssl", ["version"]).status === 0, "openssl, to mint the loopback TLS server's certificate");
  const folder = createTempDir("outbound-h2-");
  const key = join(folder, "key.pem");
  const cert = join(folder, "cert.pem");
  const minted = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { encoding: "utf8" });
  assert.equal(minted.status, 0, minted.stderr);
  const door = new URL("../../src/shared/outbound-http.ts", import.meta.url).href;
  // A child process, so the minted certificate is trusted the way the platform trusts one (read at start).
  const probe = `
    const door = await import(${JSON.stringify(door)});
    const { createSecureServer, constants } = await import("node:http2");
    const { readFileSync } = await import("node:fs");
    let sessions = 0;
    const seen = {};
    const server = createSecureServer({ key: readFileSync(${JSON.stringify(key)}), cert: readFileSync(${JSON.stringify(cert)}) });
    server.on("session", () => { sessions += 1; });
    server.on("stream", (stream, headers) => {
      const path = headers[":path"];
      seen[path] = (seen[path] ?? 0) + 1;
      stream.resume();
      stream.on("error", () => undefined);
      if (seen[path] === 1 && path === "/unprocessed") { stream.session.goaway(constants.NGHTTP2_NO_ERROR, 0); stream.close(constants.NGHTTP2_REFUSED_STREAM); return; }
      if (seen[path] === 1 && path === "/processed") { stream.session.goaway(constants.NGHTTP2_NO_ERROR, stream.id); stream.close(constants.NGHTTP2_INTERNAL_ERROR); return; }
      stream.respond({ ":status": 200 }); stream.end("ok");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = (path) => "https://localhost:" + server.address().port + path;
    const send = (path) => door.outboundFetch({ url: url(path), method: "POST", body: "{}", signal: AbortSignal.timeout(10_000), protocolHeaders: { "Content-Type": "application/json" }, logCategory: "llm", allowPrivateAddress: true })
      .then((response) => door.readBody(response, AbortSignal.timeout(10_000), 64, 100, "llm"), (error) => "failed:" + (error.code ?? error.name));
    const unprocessed = await send("/unprocessed");
    const sessionsAfterResend = sessions;
    const processed = await send("/processed");
    await door.closeOutboundConnections();
    server.close();
    console.log(JSON.stringify({ unprocessed, sessionsAfterResend, seen, processed }));
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", probe], { encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert } });
  t.diagnostic(run.stderr.slice(-2000));
  assert.equal(run.status, 0, run.stderr.slice(-2000));
  const answer = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as { unprocessed: string; sessionsAfterResend: number; seen: Record<string, number>; processed: string };
  assert.equal(answer.unprocessed, "ok", "the unprocessed stream was resent and answered");
  assert.equal(answer.seen["/unprocessed"], 2, "the server saw it twice: once refused by the GOAWAY, once on the new connection");
  assert.equal(answer.sessionsAfterResend, 2, "the resend took a NEW connection");
  assert.match(answer.processed, /^failed:/u, "a stream the server took and then cut is never resent: a typed failure");
  assert.equal(answer.seen["/processed"], 1, "...and it was sent exactly once");
});

test("outbound http: a POOLED keep-alive connection is reused only by a request pinned to the same addresses (secd-security SECD-V-B1)", async () => {
  answering(() => new Response("internal"));
  // A name first answering the loopback upstream, then a PUBLIC address: the
  // second request's own check passes (public), and it must connect THERE —
  // never ride the kept-alive socket to the internal server the first one opened.
  await resolveAs((host, call) => (host === "shared.test" ? [{ address: call === 0 ? "127.0.0.1" : "93.184.216.34", family: 4 }] : undefined), async (calls) => {
    await withPolicy({ cleartextRemote: "warn" }, async () => {
      const first = await outboundFetch(request({ url: `http://shared.test:${PORT}/admin`, method: "GET", allowPrivateAddress: true }));
      assert.equal(await readBody(first, AbortSignal.timeout(5_000), 64, 100, "llm"), "internal");
      const lifetime = outboundDeadline(undefined, 1_500);
      try {
        await outboundFetch(request({ url: `http://shared.test:${PORT}/user`, method: "GET", allowPrivateAddress: false, signal: lifetime.signal })).then(
          (response) => readBody(response, lifetime.signal, 64, 100, "llm"),
          () => "not reached",
        );
      } catch { /* the public address is not reachable from here: that is the point */ } finally { lifetime.clear(); }
    });
    assert.equal(calls(), 2, "each request resolved and was checked on its own");
    assert.equal(received.length, 1, "the internal server saw ONLY the request allowed to reach it");
  });
});

test("outbound http: a WebSocket handshake is held to the destination rule and PINNED like a request (secd-security SECD-V-B4)", async () => {
  const { startWebSocketServer } = await import("../support/websocket-server.ts");
  const server = await startWebSocketServer();
  try {
    const port = new URL(server.url).port;
    // A name resolving to loopback, for a handshake that may not reach private addresses: refused before any connection.
    await resolveAs((host) => (host === "ws-private.test" ? [{ address: "127.0.0.1", family: 4 }] : undefined), async () => {
      await withPolicy({ cleartextRemote: "warn" }, async () => {
        await assert.rejects(
          () => openOutboundWebSocket({ url: `ws://ws-private.test:${port}/`, allowPrivateAddress: false, maxMessageBytes: 1024, logCategory: "mcp" }),
          (error: unknown) => codeOf(error) === "outbound_private_destination_refused",
        );
      });
    });
    // Rebinding: the handshake connects to the FIRST (checked) answer; later answers are never asked.
    await resolveAs((host, call) => (host === "ws-rebind.test" ? [{ address: call === 0 ? "127.0.0.1" : "10.255.255.1", family: 4 }] : undefined), async (calls) => {
      await withPolicy({ cleartextRemote: "warn" }, async () => {
        const socket = await openOutboundWebSocket({ url: `ws://ws-rebind.test:${port}/`, allowPrivateAddress: true, maxMessageBytes: 1024, logCategory: "mcp" });
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve());
          socket.addEventListener("error", () => reject(new Error("the pinned handshake did not open")));
        });
        socket.close();
      });
      assert.equal(calls(), 1, "the name was resolved exactly once");
    });
  } finally {
    await server.close();
  }
});

test("outbound http: URL credentials and non-HTTP schemes are refused; a fetch caller never admits ws:", async () => {
  answering(() => new Response("ok"));
  await assert.rejects(outboundFetch(request({ url: "https://user:pw@api.example.com/v1" })), (error) => codeOf(error) === "outbound_url_credentials_refused");
  await assert.rejects(outboundFetch(request({ url: "file:///etc/passwd" })), (error) => codeOf(error) === "outbound_scheme_refused");
  await assert.rejects(outboundFetch(request({ url: "wss://api.example.com/v1" })), (error) => codeOf(error) === "outbound_scheme_refused");
  await assert.rejects(outboundFetch(request({ url: "not a url" })), (error) => codeOf(error) === "outbound_url_invalid");
  assert.equal(received.length, 0);
});

test("outbound http: TLS verification switched off process-wide refuses every https request", async () => {
  answering(() => new Response("ok"));
  await withEnv({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, async () => {
    await assert.rejects(outboundFetch(request({ url: "https://api.example.com/v1" })), (error) => codeOf(error) === "outbound_tls_verification_disabled");
  });
  assert.equal(received.length, 0);
});

test("outbound http: operator headers pass the allowlist; protocol headers win; connection-level and malformed headers are refused typed", async () => {
  answering(() => new Response("ok"));
  await readBody(await outboundFetch(request({ operatorHeaders: { "X-Org": "o", authorization: "Bearer operator", "content-type": "text/plain" } })), AbortSignal.timeout(5_000), 64, 100, "llm");
  const headers = received[0]!.headers;
  assert.equal(headers.get("x-org"), "o");
  assert.equal(headers.get("authorization"), "Bearer k", "the protocol's credential wins");
  assert.equal(headers.get("content-type"), "application/json");
  for (const [name, value, code] of [
    ["Host", "evil.example", "outbound_header_refused"],
    ["Transfer-Encoding", "chunked", "outbound_header_refused"],
    ["Connection", "close", "outbound_header_refused"],
    ["Proxy-Authorization", "Basic x", "outbound_header_refused"],
    ["bad header", "x", "outbound_header_invalid"],
    ["X-Split", "a\r\nX-Injected: 1", "outbound_header_invalid"],
  ] as const) {
    await assert.rejects(outboundFetch(request({ operatorHeaders: { [name]: value } })), (error) => codeOf(error) === code, name);
  }
  // A PROTOCOL value the platform cannot carry is the same typed refusal, never a raw TypeError.
  await assert.rejects(outboundFetch(request({ protocolHeaders: { Authorization: "Bearer a\r\nb" } })), (error) => codeOf(error) === "outbound_header_invalid");
  await assert.rejects(outboundFetch(request({ protocolHeaders: { Authorization: "Bearer €" } })), (error) => codeOf(error) === "outbound_header_invalid");
  assert.equal(received.length, 1);
});

/** A TCP listener standing in for an environment proxy: counts the connections it gets (and drops them). */
async function fakeProxy(): Promise<Readonly<{ url: string; hits: () => number; close: () => Promise<void> }>> {
  let hits = 0;
  const server: Server = createServer((socket) => { hits += 1; socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Send one GET to the loopback upstream; true when it answered, false when the attempt failed. */
async function reachedUpstream(): Promise<boolean> {
  try {
    const response = await outboundFetch(request({ url: `http://127.0.0.1:${PORT}/v1`, method: "GET", signal: AbortSignal.timeout(5_000) }));
    await readBody(response, AbortSignal.timeout(5_000), 64, 100, "llm");
    return true;
  } catch { return false; }
}

test("outbound http: an environment proxy never relays a cleartext request silently — loopback included (SECB-V-4); https is tunnelled and signalled", async () => {
  answering(() => new Response("ok"));
  const proxy = await fakeProxy();
  try {
    await withEnv(proxyEnv({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url }), async () => {
      await assert.rejects(outboundFetch(request({ url: `http://127.0.0.1:${PORT}/v1` })), (error) => codeOf(error) === "outbound_cleartext_refused"
        && (error as Error).message.includes("proxy"));
      await assert.rejects(outboundFetch(request({ url: "https://api.example.com/v1", signal: AbortSignal.timeout(5_000) })));
      assert.equal(proxy.hits(), 1, "the https request went to the proxy (a tunnel)");
      assert.ok(outboundSignals().proxiedOrigins.includes("https://api.example.com"), "an https request through the proxy is recorded");
      await withEnv({ NO_PROXY: "localhost,127.0.0.1" }, async () => { assert.equal(await reachedUpstream(), true, "NO_PROXY exempts loopback: direct"); });
    });
  } finally { await proxy.close(); }
  assert.equal(received.length, 1, "only the NO_PROXY-exempt request reached the upstream");
});

test("outbound http: a request held to public addresses is never handed to an environment proxy (the proxy would resolve again)", async () => {
  const proxy = await fakeProxy();
  try {
    await withEnv(proxyEnv({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: proxy.url }), async () => {
      await assert.rejects(outboundFetch(request({ url: "https://api.example.com/v1", allowPrivateAddress: false })), (error) => codeOf(error) === "outbound_destination_unpinnable");
    });
  } finally { await proxy.close(); }
  assert.equal(proxy.hits(), 0, "nothing reached the proxy");
});

test("outbound http: the proxy variables are read as the platform reads them — lowercase first, an empty value passed over", async () => {
  answering(() => new Response("ok"));
  const proxy = await fakeProxy(), other = await fakeProxy();
  const cases: readonly Readonly<{ name: string; env: Record<string, string>; via: "proxy" | "other" | "direct" }>[] = [
    { name: "lower empty, UPPER set", env: { http_proxy: "", HTTP_PROXY: proxy.url }, via: "proxy" },
    { name: "UPPER empty, lower set", env: { HTTP_PROXY: "", http_proxy: proxy.url }, via: "proxy" },
    { name: "lower wins over UPPER", env: { http_proxy: proxy.url, HTTP_PROXY: other.url }, via: "proxy" },
    { name: "NO_PROXY covers, no_proxy empty", env: { HTTP_PROXY: proxy.url, NO_PROXY: "127.0.0.1", no_proxy: "" }, via: "direct" },
    { name: "no_proxy covers, NO_PROXY other", env: { HTTP_PROXY: proxy.url, no_proxy: "127.0.0.1", NO_PROXY: "x.invalid" }, via: "direct" },
    { name: "NO_PROXY covers, no_proxy other (lower wins)", env: { HTTP_PROXY: proxy.url, NO_PROXY: "127.0.0.1", no_proxy: "x.invalid" }, via: "proxy" },
  ];
  try {
    await withPolicy({ cleartextRemote: "warn" }, async () => {
      for (const entry of cases) {
        const before = { proxy: proxy.hits(), other: other.hits(), upstream: received.length };
        await withEnv(proxyEnv({ NODE_USE_ENV_PROXY: "1", ...entry.env }), async () => { await reachedUpstream(); });
        const reached = received.length > before.upstream ? "direct" : proxy.hits() > before.proxy ? "proxy" : other.hits() > before.other ? "other" : "nowhere";
        assert.equal(reached, entry.via, entry.name);
      }
    });
  } finally { await proxy.close(); await other.close(); }
});

test("outbound http: IN A TEST PROCESS the door dials nothing but this machine — a public destination, a name resolving to one, a remote proxy: refused, typed, before any socket", async () => {
  // step6-readiness-2 F-14: a test booted the repository's settings document
  // and dialed the remote MCP servers it lists.
  assert.equal(processUnderTest(), true, "this test process is not recognised as under test, so this arm proves nothing");
  answering(() => new Response("ok"));
  await assert.rejects(outboundFetch(request({ url: "https://93.184.216.34/v1", allowPrivateAddress: false })), (error) => codeOf(error) === "outbound_network_under_test");
  await resolveAs((host) => (host === "remote.test" ? [{ address: "127.0.0.1", family: 4 }, { address: "93.184.216.34", family: 4 }] : undefined), async () => {
    await assert.rejects(outboundFetch(request({ url: "https://remote.test/v1" })), (error) => codeOf(error) === "outbound_network_under_test", "one remote address among loopback ones is still a remote host");
  });
  await withEnv(proxyEnv({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy.remote.test:3128" }), async () => {
    await assert.rejects(outboundFetch(request({ url: "https://api.example.com/v1" })), (error) => codeOf(error) === "outbound_network_under_test", "a remote proxy is a remote host");
  });
  assert.equal(received.length, 0, "nothing was sent");
  // This machine is reached, by literal and by a name answered with a loopback address.
  await readBody(await outboundFetch(request({ url: `http://127.0.0.1:${PORT}/v1`, method: "GET" })), AbortSignal.timeout(5_000), 64, 100, "llm");
  await resolveAs((host) => (host === "local.test" ? [{ address: "127.0.0.1", family: 4 }] : undefined), async () => {
    await withPolicy({ cleartextRemote: "warn" }, async () => {
      await readBody(await outboundFetch(request({ url: `http://local.test:${PORT}/v1`, method: "GET" })), AbortSignal.timeout(5_000), 64, 100, "llm");
    });
  });
  assert.equal(received.length, 2);
});

test("outbound http: THE ONE LIVE OPT-IN — under test a remote host is refused unless the run consents (exactly \"1\") and the host is a declared live host", () => {
  // wf-del2-correctness NEW-5: the live interop arms had to be deleted; the
  // door and the socket guard now read one opt-in (src/process/live-network.ts).
  const consent = ROOT_POLICY.verification.networkUnderTest.liveConsentVariable;
  const [liveHost] = ROOT_POLICY.verification.networkUnderTest.liveHosts;
  assert.ok(liveHost !== undefined);
  const before = process.env[consent];
  try {
    delete process.env[consent];
    assert.equal(remoteRefusedUnderTest(["93.184.216.34"], liveHost), true, "a declared live host passed without consent");
    assert.equal(remoteRefusedUnderTest(["127.0.0.1", "::1"], "local.test"), false, "this machine was refused");
    process.env[consent] = "true";
    assert.equal(remoteRefusedUnderTest(["93.184.216.34"], liveHost), true, "a consent other than 1 opened the network");
    process.env[consent] = "1";
    assert.equal(remoteRefusedUnderTest(["93.184.216.34"], liveHost), false, "the consented live host was refused");
    assert.equal(remoteRefusedUnderTest(["93.184.216.34"], liveHost.toUpperCase()), false, "a host name's case is not its identity");
    assert.equal(remoteRefusedUnderTest(["93.184.216.34"], `evil.${liveHost}`), true, "a SUFFIX of a live host passed");
    assert.equal(remoteRefusedUnderTest(["93.184.216.34"], "example.com"), true, "consent opened an undeclared host");
  } finally {
    if (before === undefined) delete process.env[consent];
    else process.env[consent] = before;
  }
});

test("outbound http: the pinned lookup answers ASYNCHRONOUSLY, as the platform resolver does — a synchronous answer left a failed TLS connect's error uncaught", async () => {
  // Reproduced (undici 8.11.2, Node 24): with the answer given synchronously,
  // a connect failing at once (ENETUNREACH) failed inside `tls.connect` —
  // "Cannot read properties of null (reading 'setServername')" — and the
  // socket's own error had no listener: an uncaught exception, which ends a
  // server (step6-readiness-2 F-14's AggregateError).
  const lookup = pinnedLookup([{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }]) as unknown as (host: string, options: object, callback: (...answer: unknown[]) => void) => void;
  const answers: unknown[] = [];
  lookup("pinned.test", { all: true }, (...answer) => answers.push(answer));
  lookup("pinned.test", { family: 6 }, (...answer) => answers.push(answer));
  assert.deepEqual(answers, [], "the pinned lookup answered synchronously");
  await new Promise((resolveTick) => process.nextTick(resolveTick));
  assert.deepEqual(answers, [[null, [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }]], [null, "::1", 6]]);
});

test("outbound http: a body read is bounded and the deadline aborts with the caller's reason", async () => {
  const response = new Response("x".repeat(64));
  await assert.rejects(readBody(response, new AbortController().signal, 16, 100, "llm"), (error) => codeOf(error) === "outbound_body_too_large");
  answering(() => new Response("y".repeat(4096)));
  await assert.rejects(readBody(await outboundFetch(request()), AbortSignal.timeout(5_000), 1024, 100, "llm"), (error) => codeOf(error) === "outbound_body_too_large");
  const reason = new Error("deadline");
  const deadline = outboundDeadline(undefined, 1, () => reason);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deadline.expired(), true);
  assert.equal(deadline.signal.reason, reason);
  deadline.clear();
});

test("a connection the pool lets go whose destroy fails is SAID at warn, never swallowed (round 13, design O-1)", async () => {
  const seen = await networkEvents(async () => {
    closeConnection({ destroy: () => Promise.reject(new Error("socket already torn")) } as never, "http://127.0.0.1:1", "stale");
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.ok(seen.includes("outbound_connection_destroy_failed"), `the failure is logged: ${seen.join(", ")}`);
});

test("the pool's summed state refuses a client state that is not a number (the pinned client's internals changed), never reading it as 0 (round 13, design O-1)", () => {
  const state = Symbol("kRunning");
  assert.equal(summedDispatcherState([{ [state]: 2 }, { [state]: true }, { [state]: 0 }], state), 3);
  assert.throws(() => summedDispatcherState([{ [state]: 1 }, {}], state), (error: unknown) => (error as { code?: string }).code === "outbound_pool_state_unreadable" && /answers its Symbol\(kRunning\) state as undefined, not a number/u.test((error as Error).message));
});
