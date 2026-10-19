import { describe, it, expect } from "vitest";
import { formatErrorMessage } from "../../src/data/error-messages";

describe("formatErrorMessage", () => {
  it("maps network errors to human-friendly text", () => {
    const result = formatErrorMessage({
      code: "network",
      message: "TypeError: NetworkError when attempting to fetch resource.",
      statusCode: undefined,
    });
    // exp519: "Server offline" (not "Couldn't reach the server") — the user
    // wants a clear server-down message, distinct from a 429 rate limit.
    expect(result).toContain("Server offline");
    expect(result).not.toContain("NetworkError");
    expect(result).not.toContain("[");
  });

  it("maps 'Failed to fetch' to human-friendly text", () => {
    const result = formatErrorMessage({
      code: "network",
      message: "Failed to fetch",
      statusCode: undefined,
    });
    expect(result).toContain("Server offline");
  });

  it("maps 429 to a distinct rate-limit message (not server offline)", () => {
    const result = formatErrorMessage({
      code: "http_429",
      message: "Too many requests. Please slow down.",
      statusCode: 429,
    });
    expect(result).toContain("Too many requests");
    expect(result).not.toContain("Server offline");
  });

  it("maps timeout to human-friendly text", () => {
    const result = formatErrorMessage({
      code: "timeout",
      message: "Request timed out",
      statusCode: undefined,
    });
    expect(result).toContain("took too long");
  });

  it("maps 5xx to server error text", () => {
    const result = formatErrorMessage({
      code: "http_500",
      message: "Internal Server Error",
      statusCode: 500,
    });
    expect(result).toContain("server encountered an error");
  });

  it("maps 404 to not-found text", () => {
    const result = formatErrorMessage({
      code: "http_404",
      message: "Not Found",
      statusCode: 404,
    });
    expect(result).toContain("not found");
  });

  it("maps 413 to too-large text", () => {
    const result = formatErrorMessage({
      code: "http_413",
      message: "Payload Too Large",
      statusCode: 413,
    });
    expect(result).toContain("too large");
  });

  it("maps stream_closed to the closed-stream truth — no reconnection the protocol forbids, and the record's whereabouts", () => {
    // The CLOSED state is the SSE protocol's permanent failure (a non-200
    // answer fails the connection for good; the browser never retries), so
    // the sentence must not promise a reconnection that can never happen —
    // the measured defect was exactly this promise sitting on the
    // past-retention parked-run return, never reconnecting, never replaced.
    const result = formatErrorMessage({
      code: "stream_closed",
      message: "The connection to the run was lost and did not report a reason.",
      statusCode: undefined,
    });
    expect(result).toContain("will not reconnect");
    expect(result).not.toContain("Reconnecting automatically");
    expect(result, "the beat points the reader at the record the conversation holds").toContain(
      "saved in this conversation",
    );
  });

  it("maps stream_error to the reconnecting truth — the CONNECTING state really is auto-reconnecting", () => {
    // The transient branch's code: EventSource is CONNECTING and the
    // browser's own reconnect loop is running, so the promise is true here
    // and only here — the two stream-transport codes must never trade
    // sentences.
    const result = formatErrorMessage({
      code: "stream_error",
      message: "SSE stream error (reconnecting)",
      statusCode: undefined,
    });
    expect(result).toContain("Reconnecting automatically");
  });

  it("maps parse errors to malformed-data text", () => {
    const result = formatErrorMessage({
      code: "parse",
      message: "Unexpected token in JSON",
      statusCode: undefined,
    });
    expect(result).toContain("malformed data");
  });

  it("maps model errors to model-error text", () => {
    const result = formatErrorMessage({
      code: "model",
      message: "Rate limit exceeded",
      statusCode: undefined,
    });
    expect(result).toContain("model returned an error");
  });

  it("does not prepend [code] prefix", () => {
    const result = formatErrorMessage({
      code: "run_start",
      message: "Some error",
      statusCode: undefined,
    });
    expect(result).not.toMatch(/^\[/);
  });

  it("falls back to the raw message for unknown codes", () => {
    const result = formatErrorMessage({
      code: "unknown_code",
      message: "Something unexpected happened",
      statusCode: undefined,
    });
    expect(result).toBe("Something unexpected happened");
  });
});
