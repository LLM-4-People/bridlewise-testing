/**
 * WIRE CLIENT — the product as a browser reaches it, not as a test imports it.
 *
 * Everything the existing bench suites measure (`bench/db.bench.ts`,
 * `bench/payload.bench.ts`, …) is IN-PROCESS: they construct a `DbClient` and
 * call it. That skips the entire server: the auth gate's `countUsers()` on
 * every request, `resolveAuthUser`'s session lookup, the CSRF check, the
 * rate-limit bucket, the redaction walk at the `sendJson` choke point,
 * `JSON.stringify`, the socket write, and the kernel. This module measures
 * that gap, by speaking HTTP/1.1 over a real TCP socket to a real server.
 *
 * Three decisions that make the numbers mean something:
 *
 *   1. ONE AGENT PER VIRTUAL CLIENT, `maxSockets: 1`. "100 concurrent
 *      connections" must be 100 connections, not 100 requests multiplexed
 *      over a shared pool — a shared pool would silently serialize and the
 *      run would report a concurrency it never achieved.
 *   2. TTFB IS SEPARATED FROM TOTAL. For the 74MB history read the two are
 *      different findings: TTFB is what the server spent blocked producing
 *      the response, total additionally includes pushing it through the
 *      socket. Reporting only total conflates a slow query with a fat payload.
 *   3. SSE IS TIMED PER EVENT. A stream's health is not its duration, it is
 *      the distribution of INTER-EVENT GAPS. One 3-second gap in an
 *      otherwise fast stream is the collapse signal, and a mean hides it.
 *
 * No dependencies — `node:http` and `node:crypto` only.
 */

import { Agent, request as httpRequest, type IncomingHttpHeaders } from "node:http";

import { CSRF_CUSTOM_HEADER } from "../../shared/constants.ts";

const NS_PER_MS = 1_000_000;

/** An authenticated identity on the wire: the cookie header to send. */
export type WireSession = {
  readonly userId: string;
  readonly username: string;
  /** The full `Cookie:` header value (auth cookie, and isolation cookie once seen). */
  readonly cookie: string;
};

export type WireResult = {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** Time from writing the request to the FIRST response byte (headers). */
  readonly ttfbMs: number;
  /** Time from writing the request to the LAST response byte. */
  readonly totalMs: number;
  /** Response body byte count as it crossed the wire. */
  readonly bytes: number;
  /** Body text — only retained when `keepBody` is set (a 74MB body is not
   *  something to hold 30 copies of). */
  readonly body: string | null;
  /** Set when the request failed at the transport level (ECONNRESET, …). */
  readonly error: string | null;
};

export type WireRequestOptions = {
  readonly method?: string;
  readonly path: string;
  readonly session?: WireSession | null;
  readonly json?: unknown;
  /** Retain the response body text. Default false — count bytes, drop bytes. */
  readonly keepBody?: boolean;
  /** Abandon the request after this long. Default 120s. */
  readonly timeoutMs?: number;
  /** Extra headers, e.g. to deliberately OMIT the CSRF header in a probe. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Send no CSRF header at all — for characterising the guard, not for load. */
  readonly omitCsrf?: boolean;
  /**
   * Read the response HEADERS, then STOP READING THE BODY for this long —
   * the slow client, for a plain HTTP response rather than an SSE stream.
   *
   * `server/router.ts::sendJson` builds the whole response with
   * `JSON.stringify` and hands it to `res.end()`. A reader that stalls
   * partway leaves the entire serialized payload resident on the server: in
   * the socket send buffer, and behind it in Node's own write queue. At the
   * 78.7MB history that is 78.7MB per stalled reader that nothing bounds and
   * nothing sheds. This is the lever that makes it observable.
   */
  readonly stallBodyMs?: number;
};

/**
 * One virtual client: one keep-alive connection to one server.
 *
 * `maxSockets: 1` is the load-shape contract. N `WireClient`s driving
 * requests in parallel is N connections; one `WireClient` driving N requests
 * in parallel is ONE connection with N queued requests — a completely
 * different thing, and the harness keeps them distinguishable.
 */
export class WireClient {
  readonly host: string;
  readonly port: number;
  private readonly agent: Agent;

  constructor(port: number, host = "127.0.0.1", maxSockets = 1) {
    this.host = host;
    this.port = port;
    this.agent = new Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets });
  }

  /** Close the underlying socket(s). Every client must be destroyed, or the
   *  server's FD count at teardown is the bench's leak, not the product's. */
  destroy(): void {
    this.agent.destroy();
  }

  request(opts: WireRequestOptions): Promise<WireResult> {
    const method = opts.method ?? "GET";
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const payload = opts.json === undefined ? null : Buffer.from(JSON.stringify(opts.json), "utf8");

    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.session) headers["cookie"] = opts.session.cookie;
    if (payload !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.byteLength);
    }
    // The CSRF guard (server/csrf.ts) accepts EITHER a same-origin
    // Origin/Referer OR this custom header. A non-browser client has no
    // meaningful Origin, so it opts in via the header — the path csrf.ts
    // documents for "curl, tests". Sending it is not a bypass: a cross-site
    // browser request cannot set it without a preflight the CORS policy
    // blocks. GET/HEAD/OPTIONS are exempt anyway.
    if (!opts.omitCsrf) headers[CSRF_CUSTOM_HEADER] = "bench";

    return new Promise<WireResult>((resolve) => {
      const t0 = process.hrtime.bigint();
      let ttfbMs = Number.NaN;
      let bytes = 0;
      const chunks: Buffer[] = [];
      let settled = false;

      const finish = (r: WireResult): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      const req = httpRequest(
        { host: this.host, port: this.port, path: opts.path, method, headers, agent: this.agent },
        (res) => {
          // FIRST BYTE: the response headers have arrived, which means the
          // server has finished deciding and started answering. For a
          // streaming or very large response this is the server-side cost;
          // everything after it is transfer.
          ttfbMs = Number(process.hrtime.bigint() - t0) / NS_PER_MS;
          let stalled = false;
          res.on("data", (c: Buffer) => {
            bytes += c.byteLength;
            if (opts.keepBody) chunks.push(c);
            // Stop draining the kernel receive buffer. The server's send
            // buffer fills behind it and its write queue grows unbounded.
            if (opts.stallBodyMs !== undefined && !stalled) {
              stalled = true;
              res.pause();
              setTimeout(() => res.resume(), opts.stallBodyMs).unref();
            }
          });
          res.on("end", () => {
            finish({
              status: res.statusCode ?? 0,
              headers: res.headers,
              ttfbMs,
              totalMs: Number(process.hrtime.bigint() - t0) / NS_PER_MS,
              bytes,
              body: opts.keepBody ? Buffer.concat(chunks).toString("utf8") : null,
              error: null,
            });
          });
          res.on("error", (err: Error) => {
            finish({
              status: res.statusCode ?? 0,
              headers: res.headers,
              ttfbMs,
              totalMs: Number(process.hrtime.bigint() - t0) / NS_PER_MS,
              bytes,
              body: null,
              error: err.message,
            });
          });
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`timeout after ${timeoutMs}ms`));
      });
      req.on("error", (err: Error) => {
        finish({
          status: 0,
          headers: {},
          ttfbMs,
          totalMs: Number(process.hrtime.bigint() - t0) / NS_PER_MS,
          bytes,
          body: null,
          error: err.message,
        });
      });

      if (payload !== null) req.write(payload);
      req.end();
    });
  }
}

// ── SSE ──────────────────────────────────────────────────────────────────

export type SseEventRecord = {
  readonly name: string;
  /** ms from the request being written to this event's terminating blank line. */
  readonly atMs: number;
  /** ms since the PREVIOUS event (or since first byte, for the first one). */
  readonly gapMs: number;
  readonly bytes: number;
};

export type SseResult = {
  readonly status: number;
  /** ms to the response HEADERS — the server accepted the stream. */
  readonly headerMs: number;
  /** ms to the first byte of stream BODY. Distinct from `headerMs`: the SSE
   *  helper writes headers then flushes, and any work between the two is
   *  invisible unless both are timed. */
  readonly firstBodyByteMs: number;
  readonly events: readonly SseEventRecord[];
  readonly totalMs: number;
  readonly bytes: number;
  /** Why the stream stopped: the caller's cap, the server, or an error. */
  readonly endedBy: "max-events" | "max-duration" | "server-closed" | "error" | "caller-closed";
  readonly error: string | null;
  /** Non-event lines (`: keepalive` comments) — proof of liveness during a
   *  gap, and the only way to tell "server alive but silent" from "stalled". */
  readonly keepalives: number;
};

export type SseOptions = {
  readonly path: string;
  readonly session: WireSession;
  readonly maxEvents?: number;
  readonly maxDurationMs?: number;
  /**
   * Do not read the socket for this long after the first event — the SLOW
   * CLIENT. `server/sse.ts` discards `res.write()`'s return value and never
   * listens for `drain`, so a client that stops reading fills the kernel
   * send buffer and then the Node stream's internal buffer, unbounded. This
   * is the lever that makes that bug observable from the wire.
   */
  readonly stallAfterFirstEventMs?: number;
};

/**
 * Open an SSE stream and time it event by event.
 *
 * Parsing is deliberately minimal — `event:` / `data:` / `:comment`, split on
 * the blank-line terminator — because the subject is TIMING, not protocol
 * conformance. An event's timestamp is taken when its terminating blank line
 * arrives, which is the moment a browser would dispatch it.
 */
export function openSse(client: WireClient, opts: SseOptions): {
  readonly done: Promise<SseResult>;
  readonly close: () => void;
  /** Whether this stream has already finished. A probe that needs N streams
   *  held CONCURRENTLY must be able to check that they still are — otherwise
   *  it measures N sequential streams and reports it as N simultaneous ones. */
  readonly isDone: () => boolean;
} {
  const maxEvents = opts.maxEvents ?? 200;
  const maxDurationMs = opts.maxDurationMs ?? 30_000;

  let closeFn: () => void = () => {};
  let finished = false;

  const done = new Promise<SseResult>((resolve) => {
    const t0 = process.hrtime.bigint();
    const now = (): number => Number(process.hrtime.bigint() - t0) / NS_PER_MS;

    const events: SseEventRecord[] = [];
    let headerMs = Number.NaN;
    let firstBodyByteMs = Number.NaN;
    let lastEventAt = Number.NaN;
    let bytes = 0;
    let keepalives = 0;
    let buffer = "";
    let status = 0;
    let settled = false;
    let endedBy: SseResult["endedBy"] = "server-closed";
    let error: string | null = null;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      finished = true;
      clearTimeout(durationTimer);
      resolve({
        status,
        headerMs,
        firstBodyByteMs,
        events,
        totalMs: now(),
        bytes,
        endedBy,
        error,
        keepalives,
      });
    };

    const req = httpRequest(
      {
        host: client.host,
        port: client.port,
        path: opts.path,
        method: "GET",
        headers: { cookie: opts.session.cookie, accept: "text/event-stream" },
        // A stream must not share a socket with anything else, or its gaps
        // become another request's queueing delay.
        agent: new Agent({ keepAlive: false, maxSockets: 1 }),
      },
      (res) => {
        headerMs = now();
        status = res.statusCode ?? 0;

        // A 429 here is the SSE connection cap (server/sse.ts
        // `acquireSseConnection`, default 8 per identity), not a stream. It
        // arrives as a normal JSON body — read it and report the refusal
        // rather than waiting forever for events that will never come.
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (Number.isNaN(firstBodyByteMs)) firstBodyByteMs = now();
          bytes += Buffer.byteLength(chunk, "utf8");
          buffer += chunk;

          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const at = now();
            let name = "message";
            let sawData = false;
            for (const line of frame.split("\n")) {
              if (line.startsWith("event: ")) name = line.slice(7).trim();
              else if (line.startsWith("data: ")) sawData = true;
            }
            if (!sawData && frame.trim().startsWith(":")) {
              keepalives++;
              continue;
            }
            events.push({
              name,
              atMs: at,
              gapMs: Number.isNaN(lastEventAt) ? at - (firstBodyByteMs || at) : at - lastEventAt,
              bytes: Buffer.byteLength(frame, "utf8"),
            });
            lastEventAt = at;

            // The slow-client lever: stop reading the socket. Node stops
            // draining the kernel receive buffer, the server's send buffer
            // fills, and `res.write()` starts returning false — which
            // server/sse.ts ignores.
            if (opts.stallAfterFirstEventMs !== undefined && events.length === 1) {
              res.pause();
              setTimeout(() => res.resume(), opts.stallAfterFirstEventMs).unref();
            }

            if (events.length >= maxEvents) {
              endedBy = "max-events";
              req.destroy();
              finish();
              return;
            }
          }
          // Keepalive comments are newline-terminated, not blank-line
          // terminated, so they never form a frame. Count them out of the
          // residual buffer so a long silent stretch can still be proven live.
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1 && buffer.slice(0, nl).startsWith(":")) {
            keepalives++;
            buffer = buffer.slice(nl + 1);
          }
        });
        res.on("end", finish);
        res.on("error", (err: Error) => {
          error = err.message;
          endedBy = "error";
          finish();
        });
      },
    );

    const durationTimer = setTimeout(() => {
      endedBy = "max-duration";
      req.destroy();
      finish();
    }, maxDurationMs);
    durationTimer.unref();

    req.on("error", (err: Error) => {
      if (settled) return;
      error = err.message;
      if (endedBy === "server-closed") endedBy = "error";
      finish();
    });
    req.end();

    closeFn = (): void => {
      if (settled) return;
      endedBy = "caller-closed";
      req.destroy();
      finish();
    };
  });

  return { done, close: () => closeFn(), isDone: () => finished };
}

/** Fetch the in-process probe (bench/wire/preload-lag.ts) from outside. */
export async function readProbe(
  probePort: number,
  sinceMs?: number,
): Promise<import("./preload-lag.ts").ProbeReading | null> {
  const client = new WireClient(probePort);
  try {
    const path = sinceMs === undefined ? "/" : `/?since=${sinceMs}`;
    const r = await client.request({ path, keepBody: true, timeoutMs: 30_000 });
    if (r.status !== 200 || r.body === null) return null;
    return JSON.parse(r.body) as import("./preload-lag.ts").ProbeReading;
  } catch {
    return null;
  } finally {
    client.destroy();
  }
}
