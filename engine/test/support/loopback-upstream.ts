/**
 * A REAL UPSTREAM FOR TESTS — a `node:http` server on 127.0.0.1 that answers
 * the outbound door's requests, so a test drives the door's OWN transport
 * (pinned lookup, agents, redirect refusal, body streaming, aborts) exactly as
 * production does. There is no transport seam to replace (the door owns its
 * client); a test names this server's address instead.
 *
 * One server per test process, started on import. A test installs the
 * handler that answers (`serve`), and names each remote it pretends to be
 * through `address(original)`: `address("https://a.test/v1")` is a loopback
 * URL that carries the original scheme and host in its path, so the handler
 * sees the ORIGINAL url (`https://a.test/v1/responses?…`) and a test can keep
 * routing on host names. The handler is called like `fetch` was: `(url,
 * init)` with `init.method`, `init.headers` (a `Headers`), `init.body` (text),
 * `init.bytes` (the same body's raw bytes, for a binary upload)
 * and `init.signal` (aborted when the client goes away before the answer
 * ends). It returns a `Response` (streamed back as it is read) or throws —
 * a throw drops the connection, which the client sees as a network failure.
 * The server's sockets never keep the process alive.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { ReadableStream as WebReadableStream } from "node:stream/web";
import type { TestContext } from "node:test";

import { closeOutboundConnections } from "../../src/shared/outbound-http.ts";

export type UpstreamRequest = Readonly<{ method: string; headers: Headers; body: string | undefined; bytes: Uint8Array | undefined; signal: AbortSignal }>;
export type UpstreamHandler = (url: string, init: UpstreamRequest) => unknown;

/** The path segment that marks a mapped remote: `/_/<scheme>/<host>/…`. */
const MAPPED = "_";

let handler: UpstreamHandler | undefined;

/** Every request the upstream received, oldest first (reset by {@link serve}). */
export const received: UpstreamRequest[] = [];

function originalUrl(request: IncomingMessage, origin: string): string {
  const raw = request.url ?? "/";
  const segments = raw.split("/");
  if (segments[1] !== MAPPED || segments.length < 4) return `${origin}${raw}`;
  return `${segments[2]}://${segments[3]}/${segments.slice(4).join("/")}`;
}

/** While set, every request body waits unread (the receiver not reading: the sender's socket fills and blocks). */
let held: Promise<void> | undefined;

/** Hold every request body unread until the returned release is called. */
export function holdRequestBodies(): () => void {
  let release: () => void = () => undefined;
  held = new Promise<void>((resolve) => { release = resolve; });
  return () => { held = undefined; release(); };
}

async function answer(request: IncomingMessage, response: ServerResponse, origin: string): Promise<void> {
  if (held !== undefined) await held;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const abort = new AbortController();
  response.on("close", () => { if (!response.writableFinished) abort.abort(new Error("the client went away")); });
  const headers = new Headers();
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
  const init: UpstreamRequest = Object.freeze({
    method: request.method ?? "GET",
    headers,
    body: chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8"),
    // The raw bytes too: a binary upload is read as bytes, never as text.
    bytes: chunks.length === 0 ? undefined : new Uint8Array(Buffer.concat(chunks)),
    signal: abort.signal,
  });
  received.push(init);
  if (handler === undefined) throw new Error("no loopback handler is installed for this test");
  const result = await handler(originalUrl(request, origin), init);
  if (!(result instanceof Response)) throw new Error("the loopback handler did not answer a Response");
  const outgoing: Record<string, string[]> = {};
  result.headers.forEach((value, name) => { (outgoing[name] ??= []).push(value); });
  response.writeHead(result.status, result.statusText, outgoing);
  // The status and headers leave at once, so a body that fails later is a
  // failure DURING the body (as a real server's would be), not a dropped request.
  response.flushHeaders();
  if (result.body === null) { response.end(); return; }
  const reader = result.body.getReader();
  abort.signal.addEventListener("abort", () => { void reader.cancel().catch(() => undefined); }, { once: true });
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!response.write(value)) await new Promise((resolve) => response.once("drain", resolve));
  }
  response.end();
}

/** Requests whose answer is still running, and how many connections the upstream has seen close. */
const answering = new Set<Promise<void>>();
let closedConnections = 0;

const server = createServer((request, response) => {
  const answered = answer(request, response, origin).catch(() => {
    // A handler that throws (or a body that errors) drops the connection:
    // the client sees what a failing network gives it.
    response.destroy();
    request.socket.destroy();
  });
  answering.add(answered);
  void answered.finally(() => answering.delete(answered));
});
server.on("connection", (socket) => { socket.unref(); socket.once("close", () => { closedConnections += 1; }); });

/** How many connections to the upstream have closed so far (a mark for {@link connectionsSettled}). */
export function connectionsClosed(): number {
  return closedConnections;
}

/**
 * WHAT THE SERVER SAW, SETTLED: resolves once a connection has closed since
 * `mark` (a {@link connectionsClosed} reading) and no answer is still
 * running, so every byte that reached the server has been handled (a handler
 * ran, or the read failed). Waits on event-loop turns, not a clock, and
 * rejects after `turns` of them (a connection that never closes is a red).
 */
export async function connectionsSettled(mark: number, turns = 200_000): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (closedConnections > mark && answering.size === 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`the upstream did not settle: ${String(closedConnections - mark)} connection(s) closed since the mark, ${String(answering.size)} answer(s) running`);
}
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();

/** This upstream's own origin (`http://127.0.0.1:<port>`). */
export const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** The loopback address standing in for `original` (a remote's base URL): the handler sees `original`. */
export function address(original: string): string {
  const url = new URL(original);
  return `${origin}/${MAPPED}/${url.protocol.slice(0, -1)}/${url.host}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "")}${url.search}`;
}

/** Install the handler that answers from now on (the previous one is replaced), clearing {@link received}. */
export function serve(next: UpstreamHandler): void {
  handler = next;
  received.length = 0;
}

const require = createRequire(import.meta.url);
export type ResolverAnswer = readonly Readonly<{ address: string; family: number }>[];

/**
 * THE RESOLVER, ANSWERING FOR THE ARM: both the promise lookup (what the door
 * resolves with) and the callback lookup (what a socket resolves with when it
 * is NOT pinned) answer `answers(host, call)` for the names given; every other
 * name goes to the real resolver. Counts the calls; restores in `finally`.
 */
export async function resolveAs(answers: (host: string, call: number) => ResolverAnswer | undefined, body: (calls: () => number) => Promise<void>): Promise<void> {
  const dns = require("node:dns") as { lookup: (...args: unknown[]) => unknown; promises: { lookup: (...args: unknown[]) => Promise<unknown> } };
  const promises = require("node:dns/promises") as { lookup: (...args: unknown[]) => Promise<unknown> };
  const originalCallback = dns.lookup, originalPromise = promises.lookup;
  let calls = 0;
  const answer = (host: string, options: unknown): ResolverAnswer | undefined => {
    const found = answers(host, calls);
    if (found !== undefined) calls += 1;
    return found === undefined ? undefined : (options as { all?: boolean } | undefined)?.all === true ? found : found.slice(0, 1);
  };
  promises.lookup = dns.promises.lookup = async (host: unknown, options?: unknown) => {
    const found = answer(String(host), options);
    if (found === undefined) return originalPromise(host, options);
    return (options as { all?: boolean } | undefined)?.all === true ? found : found[0];
  };
  dns.lookup = (host: unknown, options: unknown, callback?: unknown) => {
    const done = (typeof options === "function" ? options : callback) as (error: null, address: unknown, family?: number) => void;
    const found = answer(String(host), typeof options === "function" ? undefined : options);
    if (found === undefined) return originalCallback(host, options, callback);
    if ((options as { all?: boolean } | undefined)?.all === true) done(null, found);
    else done(null, found[0]!.address, found[0]!.family);
    return undefined;
  };
  syncBuiltinESMExports();
  try { await body(() => calls); } finally {
    dns.lookup = originalCallback;
    promises.lookup = dns.promises.lookup = originalPromise;
    syncBuiltinESMExports();
  }
}

/**
 * THE DOOR'S REAL RESPONSE BODY, OBSERVED (fault injection without replacing
 * the response, its bytes or the transport): the door hands a response's body
 * over as the web stream its client makes from the incoming message
 * (`ReadableStream.from(<node Readable>)`); every reader taken from such a
 * stream is passed to `onReader(reader, stream)`. Other streams (a handler's
 * own `Response` bodies) are untouched. Restored by the returned function, or
 * at the test's end.
 */
export function onDoorBodyReader(t: TestContext, onReader: (reader: ReadableStreamDefaultReader<Uint8Array>, stream: ReadableStream<Uint8Array>) => void): () => void {
  // The platform's `ReadableStream` IS `node:stream/web`'s (one class object).
  const from = WebReadableStream.from.bind(WebReadableStream);
  const mocked = t.mock.method(WebReadableStream, "from", (source: Parameters<typeof WebReadableStream.from>[0]) => {
    const stream = from(source) as unknown as ReadableStream<Uint8Array>;
    if (!(source instanceof Readable)) return stream;
    const getReader = stream.getReader.bind(stream) as () => ReadableStreamDefaultReader<Uint8Array>;
    Object.defineProperty(stream, "getReader", { value() { const reader = getReader(); onReader(reader, stream); return reader; } });
    return stream;
  });
  return () => mocked.mock.restore();
}

/**
 * MOCK THE CLOCK FOR A TEST THAT DRIVES THE DOOR: `setTimeout` is mocked for
 * this test, and the door's pooled connections are closed when it ends
 * (cancelled at its timeout too). A pooled connection's keep-alive timer is
 * armed on the clock of the moment it went idle; left open, it would be
 * cleared later under the NEXT test's mocked clock and remove that test's
 * own timer (measured: a request deadline that then never fired).
 */
export function mockDoorClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => closeOutboundConnections());
}
