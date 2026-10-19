// @vitest-environment node
/**
 * Prevention test: the error TAXONOMY reaches the client over SSE, and the
 * client reports what the server said instead of inventing a cause.
 *
 * ── The defect ──
 *
 * REST responses carry `{ error: <code>, message }` — the shared taxonomy
 * in `shared/errors.ts`. The run stream did not: `stream.send(
 * SSE_EVENT_TYPES.error, { runId, message })` sent no code at all. With
 * nothing to read, the client SYNTHESISED a cause from
 * `EventSource.readyState`: CLOSED became "stream closed by server",
 * anything else became "reconnecting". So a tool-iteration-limit stop, an
 * LLM provider failure, an aborted run and a dropped socket were all
 * indistinguishable, and the reason shown to the user was manufactured by
 * the client rather than reported by the server — fabricated data on the
 * error path, which is the worst place to have it.
 *
 * ── What is verified ──
 *
 * A. Server emission, by DYNAMIC DISCOVERY: every `SSE_EVENT_TYPES.error`
 *    send anywhere under `server/` carries a `code`. No allowlist of
 *    files or call sites — a new emitter is covered the moment it exists.
 *    The scan runs over comment-stripped source (the shared
 *    `stripCommentsOnly` owner) so a `code:` mentioned in a comment
 *    cannot satisfy the guard.
 * B. The codes those emitters use are declared by the taxonomy owner
 *    (`shared/errors.ts`) — a made-up code is not a taxonomy.
 * C. Client behaviour, end to end through `openRunStream`:
 *    C1 a server frame's code is what surfaces (not a readyState guess);
 *    C2 a DIFFERENT code produces a DIFFERENT report — the whole point;
 *    C3 a genuine transport drop with no server frame reports only what
 *       the client can observe and names no cause;
 *    C4 a server frame with no code is reported as malformed, not given
 *       a plausible-looking code (deny-by-default on the contract).
 *
 * ── Mutation-verified ──
 * Removing `code:` from either emitter in server/routes/run.ts makes A
 * FAIL. Renaming a code to one the taxonomy does not declare makes B
 * FAIL. Reverting the client listener to ignore the event payload makes
 * C1 + C2 + C4 FAIL.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import { walk, relpath, read, stripCommentsOnly } from "../helpers/source-scan.ts";
import { isKnownErrorCode } from "../../shared/errors.ts";
import { SSE_EVENT_TYPES } from "../../shared/constants.ts";
import { openRunStream } from "../../src/client";
import { configureClientDebug, resetClientDebug } from "../../src/client-debug.ts";
import { errors, clearErrors } from "../../src/state/errors";
import { messages, clearMessages } from "../../src/state/chat-messages";
// The run path is FIVE modules since the executor was split out of the GET
// handler that used to be it. This guard asks about the run path, not about
// whichever file happened to hold the answer when it was written.
import { runPathSource } from "../helpers/run-source.ts";

// ── A/B: server-side emission (dynamic discovery) ──

type Emission = { file: string; index: number; payload: string };

/**
 * Find every `<something>.send(SSE_EVENT_TYPES.error, <payload>)` under
 * `server/` and return the payload text, brace-matched so a nested object
 * or a template literal does not truncate it.
 */
function discoverErrorEmissions(): Emission[] {
  const found: Emission[] = [];
  for (const file of walk("server", { exts: [".ts"] })) {
    const src = stripCommentsOnly(read(file));
    const marker = "SSE_EVENT_TYPES.error";
    let at = src.indexOf(marker);
    while (at !== -1) {
      // Only a SEND is an emission; the client-style `addEventListener`
      // reference and a bare type reference are not.
      //
      // THERE ARE THREE EMISSION DOORS NOW, and this scan going quiet is how
      // you find out about each new one. The run stopped writing into one
      // HTTP response and started publishing to a per-run feed, so the
      // executor's frames went from `stream.send(…)` to
      // `publishRunFrame(runId, …)` — and this scan matched nothing, its own
      // liveness assertion REDDING rather than certifying zero emitters as
      // compliant. Then a third arrived for the same reason: a run's ENDING
      // is now published once, at the single exit, as a terminal-frame
      // descriptor handed to `endRunFeed(runId, { event, data })` — so the
      // two `error` frames the executor can end with stopped matching, and
      // the liveness assertion redded again.
      //
      // Twice is a pattern, so the third recogniser is written against the
      // POSITION the value is in rather than the name of the call around it:
      // `event:` in a frame descriptor is an emission by construction,
      // because the only thing that consumes one is the feed's publish.
      const before = src.slice(Math.max(0, at - 40), at);
      const isEmission =
        /\.send\s*\(\s*$/.test(before) ||
        /publishRunFrame\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*$/.test(before) ||
        /\bevent\s*:\s*$/.test(before);
      if (isEmission) {
        const comma = src.indexOf(",", at);
        const openBrace = src.indexOf("{", comma);
        if (comma !== -1 && openBrace !== -1) {
          let depth = 0;
          let end = openBrace;
          for (; end < src.length; end += 1) {
            if (src[end] === "{") depth += 1;
            else if (src[end] === "}") {
              depth -= 1;
              if (depth === 0) break;
            }
          }
          found.push({
            file: relpath(file),
            index: at,
            payload: src.slice(openBrace, end + 1),
          });
        }
      }
      at = src.indexOf(marker, at + marker.length);
    }
  }
  return found;
}

describe("A. every SSE error frame the server emits carries a taxonomy code", () => {
  const emissions = discoverErrorEmissions();

  test("the scan finds emitters (a broken scan must not silently certify nothing)", () => {
    expect(
      emissions.length,
      "found no `send(SSE_EVENT_TYPES.error, {...})` call under server/ — the " +
        "discovery scan is broken, so this whole guard would be vacuous",
    ).toBeGreaterThan(0);
  });

  test("no error frame is emitted without a `code` field", () => {
    const missing = emissions.filter((e) => !/(^|[{\s,])code\s*:/.test(e.payload));
    expect(
      missing.map((m) => `${m.file}: ${m.payload.replace(/\s+/g, " ").slice(0, 120)}`),
      "an SSE error frame with no `code` leaves the client nothing to read, so it " +
        "goes back to guessing the cause from EventSource.readyState",
    ).toEqual([]);
  });
});

describe("B. the codes those emitters use belong to the shared taxonomy", () => {
  test("every literal code on an error frame is declared by shared/errors.ts", () => {
    const unknown: string[] = [];
    for (const e of discoverErrorEmissions()) {
      const literal = /(?:^|[{\s,])code\s*:\s*"([^"]+)"/.exec(e.payload);
      if (literal === null) continue; // computed (e.g. codeForError(...)) — B is about literals
      if (!isKnownErrorCode(literal[1]!)) unknown.push(`${e.file}: "${literal[1]!}"`);
    }
    expect(
      unknown,
      "a code the taxonomy has never heard of is an invented vocabulary — declare it " +
        "in shared/errors.ts so both sides share one code set",
    ).toEqual([]);
  });

  test("the untyped-throw fallback resolves the code through the taxonomy's own extractor", () => {
    const runSrc = stripCommentsOnly(runPathSource());
    expect(
      runSrc,
      "run.ts must use the single `codeForError` extractor rather than re-deriving " +
        "`err.code` inline (a second extractor drifts from the REST path)",
    ).toContain("codeForError(err,");
  });
});

// ── C: client behaviour ──

type Listener = (e: unknown) => void;

class MockEventSource {
  static lastInstance: MockEventSource | null = null;
  static readonly CLOSED = 2;
  readonly url: string;
  readyState = 1;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.lastInstance = this;
  }

  addEventListener(name: string, handler: Listener): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(handler);
  }

  removeEventListener(name: string, handler: Listener): void {
    this.listeners.get(name)?.delete(handler);
  }

  /** A SERVER-SENT frame: a MessageEvent-shaped object carrying `data`. */
  emitFrame(name: string, data: unknown): void {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const h of this.listeners.get(name) ?? []) h({ data: payload });
  }

  /** EventSource's NATIVE error: a bare Event, no `data`, transport dead. */
  emitTransportFailure(): void {
    this.readyState = MockEventSource.CLOSED;
    for (const h of this.listeners.get("error") ?? []) h({ type: "error" });
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }
}

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.lastInstance = null;
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  clearErrors();
  clearMessages();
});

afterEach(() => {
  globalThis.EventSource = originalEventSource;
  resetClientDebug();
  vi.restoreAllMocks();
});

/** Open a stream and hand back the mock so the test can drive it. */
function openStream(): { es: MockEventSource; seen: { code: string; message: string }[] } {
  const seen: { code: string; message: string }[] = [];
  openRunStream("run-1", {
    onError: (err) => seen.push({ code: err.code, message: err.message }),
  });
  return { es: MockEventSource.lastInstance!, seen };
}

describe("C. the client reports the server's code, and admits when it has none", () => {
  test("C1 a server error frame surfaces the code the server sent", () => {
    const { es, seen } = openStream();
    // THE STREAM IS OPEN WHEN THE FRAME ARRIVES, and that is the condition
    // this test exists to create: under the old readyState guess an OPEN
    // stream made a genuine failure a transient "reconnecting" non-event, so
    // a report that names the server's code can only have come from the
    // payload.
    expect(es.readyState, "the frame must arrive on an OPEN stream, or C1 proves nothing").toBe(1);
    es.emitFrame(SSE_EVENT_TYPES.error, {
      runId: "run-1",
      code: "tool_iteration_limit",
      message: "Tool call iteration limit (8) exceeded.",
    });

    expect(seen.map((s) => s.code), "the reported code is the server's, not a readyState guess")
      .toEqual(["tool_iteration_limit"]);
    expect(errors.get().map((e) => e.code)).toEqual(["tool_iteration_limit"]);
    // …AND THE STREAM IS CLOSED AFTERWARDS, which is a different claim and a
    // later fix. An error frame is terminal: the server ends the run's feed
    // and closes the socket, and a client that stayed open treated that as an
    // instruction to reconnect — replaying the retained feed and appending
    // this same error again, on the reconnect cadence, for the whole
    // retention window. Reporting the failure and then asking for it again is
    // not a smaller bug than reporting it wrongly.
    expect(es.readyState, "an error frame is terminal; staying open reconnects into a loop").toBe(2);
    const shown = messages.get().filter((m) => m.role === "error").map((m) => m.content);
    expect(shown.length, "the failure is shown in the transcript").toBe(1);
    expect(shown[0], "the shown text must not be the generic reconnect line")
      .not.toContain("Reconnecting");
  });

  test("C2 two different server codes produce two different reports", () => {
    const first = openStream();
    first.es.emitFrame(SSE_EVENT_TYPES.error, {
      runId: "run-1",
      code: "tool_iteration_limit",
      message: "budget exhausted",
    });
    const firstText = messages.get().filter((m) => m.role === "error").map((m) => m.content)[0];

    clearErrors();
    clearMessages();

    const second = openStream();
    second.es.emitFrame(SSE_EVENT_TYPES.error, {
      runId: "run-1",
      code: "run_failed",
      message: "provider exploded",
    });
    const secondText = messages.get().filter((m) => m.role === "error").map((m) => m.content)[0];

    expect(first.seen[0]!.code).not.toBe(second.seen[0]!.code);
    expect(
      firstText,
      "distinct failures must read differently — indistinguishable errors were the defect",
    ).not.toBe(secondText);
  });

  test("C3 a transport drop with no server frame names no cause", () => {
    const { es, seen } = openStream();
    es.emitTransportFailure();

    expect(seen.map((s) => s.code), "the client may only claim what it observed").toEqual([
      "stream_closed",
    ]);
    const raw = errors.get().map((e) => e.message).join(" ");
    // The honest statement is "the connection dropped and said nothing".
    // Asserting a specific cause here would be the invention this fixes.
    expect(raw.toLowerCase()).toContain("did not report a reason");
    for (const invented of ["tool_iteration_limit", "run_failed"]) {
      expect(raw, `must not attribute "${invented}" to a frame that never arrived`)
        .not.toContain(invented);
    }
  });

  test("C4 a server frame with no code is reported as malformed once, not given a plausible one", () => {
    configureClientDebug({ enabled: true, categories: ["sse"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { es, seen } = openStream();
    es.emitFrame(SSE_EVENT_TYPES.error, { runId: "run-1", message: "something broke" });

    expect(
      seen.map((s) => s.code),
      "a frame that violates the code contract must say so, not be quietly assigned a code",
    ).toEqual(["malformed"]);
    expect(seen[0]!.message, "the server's message is still surfaced").toContain("something broke");
    expect(warn).toHaveBeenCalledExactlyOnceWith("[sse]", "error frame carried no code — the SSE error contract was violated", { runId: "run-1", message: "something broke" });
  });
});
