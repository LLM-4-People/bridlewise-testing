/**
 * A spec-faithful MCP Streamable HTTP server (2025-11-25), in process, on a
 * loopback port the kernel chooses. It behaves like the hosted servers the
 * harness talks to (context7, deepwiki): it refuses a POST whose Accept does
 * not list BOTH application/json and text/event-stream (406), answers a
 * notification with 202 and no body, and answers a request as JSON or as an
 * event stream (with a priming event whose `data` is empty, CRLF framed). It
 * records every request's method, headers and body, so a test asserts what
 * the client actually SENT rather than what it meant to send.
 *
 *   const server = await startStreamableHttpServer({ mode: "sse", session: true });
 *   server.url; server.requests; server.expireSession(); await server.close();
 *
 * Spec behaviours a client must survive, each opt-in: a redirect (which must
 * never be followed), a server `ping` sent on the answer stream before the
 * answer, the 2025-11-25 polling pattern (prime, send `retry`, close the
 * connection; the answer arrives on a GET carrying `Last-Event-ID`), and a
 * tool call that is never answered (so a cancelled call's
 * `notifications/cancelled` can be observed).
 */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FixtureTool = Readonly<{ name: string; description?: string; inputSchema: Readonly<Record<string, unknown>>; annotations?: Readonly<Record<string, unknown>> }>;

export type StreamableHttpServerOptions = Readonly<{
  /** How requests are answered; "text" answers text/plain, which a client must refuse. */
  mode?: "json" | "sse" | "text";
  /** Issue an Mcp-Session-Id on initialize and enforce it afterwards. */
  session?: boolean;
  /** Paginate tools/list with nextCursor, this many tools a page. */
  pageSize?: number;
  tools?: readonly FixtureTool[];
  /** The status DELETE answers (405 = the server does not end sessions). */
  deleteStatus?: number;
  /** Answer every POST 307 to this location (a redirect a client must refuse). */
  redirectTo?: string;
  /** sse mode: send a server `ping` request (id 1) on the answer stream before each answer. */
  pingFirst?: boolean;
  /** sse mode: answer `tools/call` by priming with this `retry` and closing; the answer waits for a GET with Last-Event-ID. */
  pollAfterPrime?: Readonly<{
    retryMs: number;
    /** Every resuming GET re-primes and closes again, never answering (a stream that never delivers). */
    never?: boolean;
    /** The priming event's id (default `poll-<n>`). */
    eventId?: string;
  }>;
  /** Never answer `tools/call` (the connection stays open until the client gives up). */
  holdCalls?: boolean;
}>;

export type RecordedRequest = Readonly<{ method: string; headers: IncomingHttpHeaders; body: string; at: number }>;

export type StreamableHttpServer = Readonly<{
  url: string;
  requests: RecordedRequest[];
  /** Forget the live session: its next request is answered 404. */
  expireSession: () => void;
  /**
   * The first recorded request `matches` accepts — at once when one is
   * recorded, else when it arrives: an event, never a guessed tick (a client
   * answers a server request on its own POST, which takes its own connection).
   * Refused after `withinMs`, naming what was recorded.
   */
  nextRequest: (matches: (request: RecordedRequest) => boolean, withinMs: number) => Promise<RecordedRequest>;
  close: () => Promise<void>;
}>;

type RpcMessage = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };

const DEFAULT_TOOLS: readonly FixtureTool[] = [
  { name: "echo", description: "echo the arguments", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, openWorldHint: false } },
];

export async function startStreamableHttpServer(options: StreamableHttpServerOptions = {}): Promise<StreamableHttpServer> {
  const mode = options.mode ?? "json";
  const tools = options.tools ?? DEFAULT_TOOLS;
  const requests: RecordedRequest[] = [];
  const waiting = new Set<() => void>();
  let sessionCounter = 0;
  let currentSession: string | undefined;
  /** The answer a closed poll stream owes, keyed by its priming event id. */
  const owed = new Map<string, unknown>();
  let eventCounter = 0;

  function answer(res: ServerResponse, message: unknown, extraHeaders: Record<string, string>): void {
    if (mode === "text") {
      res.writeHead(200, { "content-type": "text/plain", ...extraHeaders });
      res.end("not a protocol body");
      return;
    }
    if (mode === "sse") {
      res.writeHead(200, { "content-type": "text/event-stream", ...extraHeaders });
      res.write("id: 0\r\ndata: \r\n\r\n");
      if (options.pingFirst === true) res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\r\n\r\n`);
      res.end(`event: message\r\ndata: ${JSON.stringify(message)}\r\n\r\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json", ...extraHeaders });
    res.end(JSON.stringify(message));
  }

  function result(message: RpcMessage): unknown {
    if (message.method === "initialize") {
      return { protocolVersion: message.params?.["protocolVersion"], capabilities: { tools: {} }, serverInfo: { name: "streamable-fixture", version: "1.0.0" } };
    }
    if (message.method === "tools/list") {
      if (options.pageSize === undefined) return { tools };
      const cursor = message.params?.["cursor"];
      const start = typeof cursor === "string" ? Number(cursor) : 0;
      const end = start + options.pageSize;
      return { tools: tools.slice(start, end), ...(end < tools.length ? { nextCursor: String(end) } : {}) };
    }
    if (message.method === "tools/call") {
      return { content: [{ type: "text", text: JSON.stringify(message.params?.["arguments"]) }] };
    }
    return {};
  }

  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method ?? "", headers: { ...req.headers }, body, at: Date.now() });
      for (const wake of [...waiting]) wake();
      if (options.redirectTo !== undefined) {
        res.writeHead(307, { location: options.redirectTo });
        res.end();
        return;
      }
      if (req.method === "GET") {
        const lastEventId = String(req.headers["last-event-id"] ?? "");
        const answer = owed.get(lastEventId);
        if (answer === undefined || !String(req.headers["accept"] ?? "").includes("text/event-stream")) {
          res.writeHead(405);
          res.end();
          return;
        }
        if (options.pollAfterPrime?.never === true) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`id: ${lastEventId}\r\nretry: ${options.pollAfterPrime.retryMs}\r\ndata: \r\n\r\n`);
          return;
        }
        owed.delete(lastEventId);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`id: ${lastEventId}-answer\r\ndata: ${JSON.stringify(answer)}\r\n\r\n`);
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(options.deleteStatus ?? 200);
        res.end();
        return;
      }
      const accept = String(req.headers["accept"] ?? "");
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
        res.writeHead(406, { "content-type": "text/plain" });
        res.end("Not Acceptable: Client must accept both application/json and text/event-stream");
        return;
      }
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        res.writeHead(415);
        res.end();
        return;
      }
      const message = JSON.parse(body) as RpcMessage;
      const initializing = message.method === "initialize";
      if (options.session === true && !initializing) {
        const sent = req.headers["mcp-session-id"];
        if (sent === undefined) { res.writeHead(400); res.end(); return; }
        if (sent !== currentSession) { res.writeHead(404); res.end(); return; }
      }
      // A notification, or a response to a request this server sent (its
      // `ping`): accepted, no body (spec transports, sending §4).
      if (message.id === undefined || message.method === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (message.method === "tools/call" && options.holdCalls === true) return;
      if (message.method === "tools/call" && options.pollAfterPrime !== undefined) {
        eventCounter += 1;
        const id = options.pollAfterPrime.eventId ?? `poll-${eventCounter}`;
        owed.set(id, { jsonrpc: "2.0", id: message.id, result: result(message) });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`id: ${id}\r\nretry: ${options.pollAfterPrime.retryMs}\r\ndata: \r\n\r\n`);
        return;
      }
      const sessionHeader: Record<string, string> = {};
      if (options.session === true && initializing) {
        sessionCounter += 1;
        currentSession = `session-${sessionCounter}`;
        sessionHeader["mcp-session-id"] = currentSession;
      }
      answer(res, { jsonrpc: "2.0", id: message.id, result: result(message) }, sessionHeader);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.freeze({
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    expireSession: () => { currentSession = undefined; },
    nextRequest: (matches, withinMs) => new Promise<RecordedRequest>((resolve, reject) => {
      const check = (): boolean => {
        const found = requests.find(matches);
        if (found === undefined) return false;
        waiting.delete(wake);
        clearTimeout(timer);
        resolve(found);
        return true;
      };
      const wake = (): void => { check(); };
      const timer = setTimeout(() => {
        waiting.delete(wake);
        reject(new Error(`no recorded request matched within ${String(withinMs)} ms; recorded: ${requests.map((r) => `${r.method} ${r.body}`).join(" | ")}`));
      }, withinMs);
      waiting.add(wake);
      check();
    }),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  });
}
