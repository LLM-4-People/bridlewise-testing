/**
 * Shared HTTP mock primitives for tests that exercise HTTP handlers (SSE,
 * rate limiter, router dispatch) WITHOUT spinning up a real server.
 *
 * Before this module, `mockReq` + `createMockRes` were re-implemented as
 * near byte-identical copies in `tests/unit/sse.test.ts`,
 * `tests/prevention/sse-connection-limit.test.ts`, and
 * `tests/prevention/rate-limit-security.test.ts` — three copies that had
 * already drifted into two distinct implementation styles (one mutated the
 * mock object's data properties, the other used getters). A fix to either
 * had to be made three times, and the two styles produced subtly different
 * live-state semantics. This module is the single owner: every test that
 * needs a minimal IncomingMessage stand-in or a SSE-aware ServerResponse
 * mock imports from here so a fix to the shared mock fixes every
 * consumer, and a new test gets a tested mock instead of a fresh copy.
 *
 * `mockReq` builds a minimal `IncomingMessage` exposing only the fields
 * the limiter + SSE owner read (headers + socket.remoteAddress), so the
 * mock is a strict subset of the real type. `createMockRes` builds a mock
 * `ServerResponse` that is ALSO an `EventEmitter` (so SSE handlers can
 * attach close/error listeners) and exposes live state via getters (a
 * caller reads `res.headerStatus` after a `writeHead` call and sees the
 * new value — the getter approach avoids the value-copy-at-assign
 * problem of the simpler Object.assign variant that drifted before).
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * A minimal IncomingMessage stand-in exposing only the fields the rate
 * limiter + SSE stream owner read (headers + socket.remoteAddress). Cast
 * through `unknown` since the real IncomingMessage has many fields the
 * handlers never touch. The optional `cookie` + `xff` fields populate the
 * corresponding headers; `remoteAddress` defaults to the IPv4 loopback.
 */
export function mockReq(opts: {
  cookie?: string;
  remoteAddress?: string;
  xff?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers["cookie"] = opts.cookie;
  if (opts.xff !== undefined) headers["x-forwarded-for"] = opts.xff;
  return {
    headers,
    socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1" },
  } as unknown as IncomingMessage;
}

/** The live-state fields a SSE-aware mock ServerResponse exposes. */
export interface MockResExtras {
  /** Captured SSE event-stream chunks (each `write` call pushes one). */
  readonly chunks: string[];
  /** True after `end()` was called. */
  readonly ended: boolean;
  /** The status code passed to the last `writeHead` (0 before any call). */
  readonly headerStatus: number;
  /** The headers object passed to `writeHead` (live — reflects merges). */
  readonly headers: Record<string, string>;
  /** Set-Cookie values accumulated via `appendHeader` (the router's session
   * + auth cookie owners both use `appendHeader`). A test can assert the
   * cookies a dispatch emitted. */
  readonly setCookies: string[];
  /** True once headers have been written (`headerStatus !== 0`). */
  readonly headersSent: boolean;
  /** True once the response has been ended. */
  readonly writableEnded: boolean;
}

/**
 * A mock ServerResponse that is also an EventEmitter so SSE handlers can
 * attach `close` / `error` listeners. Captures `write` chunks + `writeHead`
 * status/headers. Live state is exposed via getters (a caller reads
 * `res.headerStatus` after a `writeHead` call and sees the new value —
 * the getter approach avoids the value-copy-at-assign problem of the
 * simpler Object.assign variant that drifted before).
 */
export function createMockRes(): ServerResponse & MockResExtras {
  const ee = new EventEmitter();
  const chunks: string[] = [];
  let ended = false;
  let headerStatus = 0;
  const headers: Record<string, string> = {};
  // Set-Cookie values accumulate via appendHeader (the router's session +
  // auth cookie owners both use appendHeader). Stored separately so a test
  // can assert the cookie headers a dispatch emitted.
  const setCookies: string[] = [];
  const mock = Object.assign(ee, {
    chunks,
    setCookies,
    writeHead(status: number, h?: Record<string, string>) {
      headerStatus = status;
      Object.assign(headers, h ?? {});
    },
    setHeader(name: string, value: string | readonly string[]) {
      if (name.toLowerCase() === "set-cookie") {
        setCookies.length = 0;
        const arr = Array.isArray(value) ? value : [value];
        setCookies.push(...(arr as string[]));
      } else {
        headers[name] = Array.isArray(value) ? value.join(", ") : (value as string);
      }
    },
    appendHeader(name: string, value: string) {
      if (name.toLowerCase() === "set-cookie") {
        setCookies.push(value);
      } else {
        headers[name] = headers[name] !== undefined ? `${headers[name]}, ${value}` : value;
      }
    },
    flushHeaders() { /* no-op */ },
    write(data: string) { if (!ended) chunks.push(data); return true; },
    end() { ended = true; },
    get headersSent() { return headerStatus !== 0; },
    get writableEnded() { return ended; },
  });
  // Expose the live state as data properties (updated each access via
  // getters on the mock — defineProperty avoids the Object.assign
  // value-copy-at-assign problem).
  Object.defineProperties(mock, {
    headerStatus: { get: () => headerStatus, enumerable: true },
    ended: { get: () => ended, enumerable: true },
    headers: { get: () => headers, enumerable: true },
  });
  return mock as ServerResponse & MockResExtras;
}
