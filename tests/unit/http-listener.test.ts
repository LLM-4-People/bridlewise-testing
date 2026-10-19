// @vitest-environment node
/**
 * THE ONE HTTP LISTENER (`server/router/http-listener.ts`): the server's
 * clocks come from its config, and a request the HTTP parser itself refuses
 * is answered with the typed JSON body every other refusal carries — driven
 * over a real socket with raw bytes, since no client library sends a request
 * the parser refuses.
 */
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";

import { clientErrorAnswer, clientErrorResponse, createHttpListener } from "../../server/router/http-listener.ts";
import { resolveServerConfig } from "../../server/kernel/config.ts";
import { API_IDENTITY_HEADER, API_IDENTITY_VALUE } from "../../shared/constants.ts";

const CLOCKS = { headersTimeoutMs: 4_000, requestTimeoutMs: 8_000, keepAliveTimeoutMs: 1_500 };

async function withListener<T>(use: (port: number) => Promise<T>): Promise<T> {
  const server = createHttpListener(CLOCKS, (_req, res) => { res.end("ok"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    return await use((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function rawExchange(port: number, bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { answer += chunk; });
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
    socket.setTimeout(5_000, () => socket.destroy(new Error("no answer")));
    socket.write(bytes);
  });
}

function bodyOf(response: string): Record<string, unknown> {
  return JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4)) as Record<string, unknown>;
}

describe("the HTTP listener", () => {
  test("its clocks are the configured ones", async () => {
    const server = createHttpListener(CLOCKS, () => undefined);
    expect([server.headersTimeout, server.requestTimeout, server.keepAliveTimeout]).toEqual([4_000, 8_000, 1_500]);
    server.close();
  });

  test("the config states the clocks, and REFUSES a headers bound past the request bound (never raised in silence)", () => {
    const defaults = resolveServerConfig({});
    expect([defaults.headersTimeoutMs, defaults.requestTimeoutMs, defaults.keepAliveTimeoutMs]).toEqual([60_000, 300_000, 5_000]);
    expect(() => resolveServerConfig({ HARNESS_WEB_HEADERS_TIMEOUT_MS: "90000", HARNESS_WEB_REQUEST_TIMEOUT_MS: "30000" })).toThrow(
      expect.objectContaining({ name: "ConfigError", code: "http_headers_timeout_exceeds_request" }),
    );
    const equal = resolveServerConfig({ HARNESS_WEB_HEADERS_TIMEOUT_MS: "30000", HARNESS_WEB_REQUEST_TIMEOUT_MS: "30000" });
    expect([equal.headersTimeoutMs, equal.requestTimeoutMs]).toEqual([30_000, 30_000]);
  });

  test("every answer is signed: a handled response and a parser refusal both carry the API identity", async () => {
    const answers = await withListener(async (port) => [
      await rawExchange(port, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
      await rawExchange(port, "THIS IS NOT HTTP\r\n\r\n"),
    ]);
    for (const answer of answers) expect(answer.toLowerCase()).toContain(`${API_IDENTITY_HEADER}: ${API_IDENTITY_VALUE}`.toLowerCase());
  });

  test("a malformed request pipelined behind a STREAMING response never writes into that response: the socket is closed instead (WF-1b3b verify M1)", async () => {
    const server = createHttpListener(CLOCKS, (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: first\n\n");
      req.socket.once("close", () => res.end());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      // The bad request arrives once the stream is flowing (the proxy that
      // reuses an upstream connection sends it later, on the same socket).
      const answer = await new Promise<string>((resolve, reject) => {
        const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
        let received = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          const first = received.length === 0;
          received += chunk;
          if (first) socket.write("THIS IS NOT HTTP\r\n\r\n");
        });
        socket.on("close", () => resolve(received));
        socket.on("error", reject);
        socket.setTimeout(5_000, () => socket.destroy(new Error("no close")));
        socket.write("GET /stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      });
      expect(answer.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
      expect(answer).toContain("data: first");
      expect(answer.match(/HTTP\/1\.1 /gu), "a second status line was written into the streaming response").toHaveLength(1);
      expect(answer).not.toContain("request_malformed");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a request line the parser refuses is a typed 400 JSON body, and the connection closes", async () => {
    const response = await withListener((port) => rawExchange(port, "THIS IS NOT HTTP\r\n\r\n"));
    expect(response.startsWith("HTTP/1.1 400 Bad Request\r\n")).toBe(true);
    expect(response).toContain("Content-Type: application/json");
    expect(response).toContain("Connection: close");
    expect(bodyOf(response)).toEqual({ error: "request_malformed", message: "The request could not be parsed as HTTP." });
  });

  test("a header block larger than the parser accepts is a typed 431", async () => {
    const huge = `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Big: ${"a".repeat(64 * 1024)}\r\n\r\n`;
    const response = await withListener((port) => rawExchange(port, huge));
    expect(response.startsWith("HTTP/1.1 431 Request Header Fields Too Large\r\n")).toBe(true);
    expect(bodyOf(response)["error"]).toBe("request_headers_too_large");
  });

  test("the answers, by the parser's code; the raw bytes carry the exact body length", () => {
    expect(clientErrorAnswer("HPE_HEADER_OVERFLOW").status).toBe(431);
    expect(clientErrorAnswer("ERR_HTTP_REQUEST_TIMEOUT").status).toBe(408);
    expect(clientErrorAnswer("HPE_INVALID_METHOD").status).toBe(400);
    expect(clientErrorAnswer(undefined).status).toBe(400);
    const bytes = clientErrorResponse(clientErrorAnswer("ERR_HTTP_REQUEST_TIMEOUT"));
    const body = bytes.slice(bytes.indexOf("\r\n\r\n") + 4);
    expect(bytes).toContain(`Content-Length: ${String(Buffer.byteLength(body))}\r\n`);
  });
});
