// @vitest-environment jsdom
/**
 * THE ARTIFACT RUNTIME ERROR CHANNEL — behaviour.
 *
 * `artifact-containment.test.ts` §F proves the channel is ALONE (one listener,
 * one owner, one pinned shape). This file proves what that one listener
 * actually DOES, with hostile inputs, and what the beat says afterwards.
 *
 * ── WHAT IS PROVEN HERE, AND WHAT IS NOT ──────────────────────────────────
 *
 * jsdom does not execute an iframe's `srcdoc`, so nothing here runs a real
 * artifact. Two halves are therefore proven separately and the seam between
 * them is checked by arithmetic:
 *
 *   THE DOCUMENT HALF — `REPORTER_SCRIPT` is EXECUTED, against a fake window,
 *   so its `onerror`/`unhandledrejection` wiring and its refusal to invent a
 *   location are real behaviour and not a reading of the source.
 *
 *   THE HOST HALF — the channel is driven directly with real iframe
 *   `contentWindow` identities (jsdom gives real ones), so attribution,
 *   impersonation, deny-by-default and the flood cap are real behaviour.
 *
 * What is NOT provable here: that Chrome's `window.onerror` line numbers for a
 * srcdoc document are what this file assumes. That was measured in a live
 * frame — see the browser-verified numbers recorded in
 * `src/cockpit/render/artifact-errors.ts`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import ArtifactFrame from "../../src/cockpit/render/ArtifactFrame.svelte";
import ToolBeat from "../../src/cockpit/flow/ToolBeat.svelte";
import { artifactViewOf } from "../../src/cockpit/render/artifact.ts";
import {
  ARTIFACT_LINE_OFFSET,
  ArtifactErrorChannel,
  CHANNEL,
  EMPTY_STATE,
  REPORTER_SCRIPT,
  REPORT_CAP,
  SUPPRESS_NOTIFY_MS,
  artifactErrors,
  parseReport,
  sayError,
  saySuppressed,
  toArtifactLine,
  type ArtifactErrorState,
} from "../../src/cockpit/render/artifact-errors.ts";
import { sandboxedSrcdoc } from "../../src/cockpit/render/html-preview.ts";
import type { Beat, ToolStatus } from "../../src/cockpit/flow/types.ts";
import { read, stripCommentsAndStringsFor } from "../helpers/source-scan.ts";

const FRAME = "src/cockpit/render/ArtifactFrame.svelte";

/**
 * THE CAP'S SANITY IS CHECKED AT COLLECTION TIME, BEFORE ANY TEST RUNS.
 *
 * `REPORT_CAP` is a LOOP BOUND in several tests below (`i < REPORT_CAP + 3`).
 * The obvious mutation — raise the cap so it never bites — would therefore
 * turn those loops into a hang, and the mutation would have defeated the very
 * guards watching for it: "the suite never finished" is a far weaker signal
 * than a named failing assertion, and an agent in a hurry reads it as flake.
 * Throwing here fails the whole file in milliseconds, with the reason.
 */
if (!Number.isSafeInteger(REPORT_CAP) || REPORT_CAP < 1 || REPORT_CAP > 20) {
  throw new Error(
    `REPORT_CAP must be a small positive integer or it is not a cap — got ${String(REPORT_CAP)}`,
  );
}

afterEach(cleanup);

// ── Fixtures ─────────────────────────────────────────────────────────────

/** A well-formed report, as the reporter really posts it. */
function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ch: CHANNEL,
    v: 1,
    kind: "error",
    name: "TypeError",
    message: "Cannot read properties of null (reading 'x')",
    line: ARTIFACT_LINE_OFFSET + 42,
    column: 17,
    ...over,
  };
}

/** A real iframe with a real, browser-assigned contentWindow. */
function mountFrame(): HTMLIFrameElement {
  const el = document.createElement("iframe");
  document.body.appendChild(el);
  return el;
}

function artifactBeat(
  status: ToolStatus,
  input: unknown,
  output: unknown,
  refused = false,
): Beat {
  return {
    id: `art-${status}-${refused ? "refused" : "plain"}`,
    kind: "tool",
    parentId: null,
    turnIndex: 1,
    at: 1,
    abnormal: status === "error",
    bleed: true,
    verbs: [],
    tool: {
      name: "create_artifact",
      label: "create an artifact",
      status,
      input,
      output,
      startedAt: 1,
      ...(status === "running" ? {} : { durationMs: 12 }),
      ...(refused ? { refused: true } : {}),
    },
  } as Beat;
}

const GOOD_DOC = "<!DOCTYPE html><body><p>hello</p></body>";
const GOOD_OUTPUT = JSON.stringify({ ok: true, message: "rendering live" });

// ── A. ARTIFACT-RELATIVE LINES ───────────────────────────────────────────

describe("A. line numbers are the MODEL'S line numbers, not the wrapper's", () => {
  test("the offset is DERIVED from the exact composition the frame sends", () => {
    // The frame sends `sandboxedSrcdoc(REPORTER_SCRIPT + content)`. Split that
    // and the artifact's first line must sit exactly ARTIFACT_LINE_OFFSET
    // lines down. This is the pin that makes the constant self-correcting: if
    // the shared CSP owner or the reporter grows a newline, both sides move
    // together and this still holds.
    const content = "AAA\nBBB\nCCC";
    const lines = sandboxedSrcdoc(REPORTER_SCRIPT + content).split("\n");
    expect(lines[ARTIFACT_LINE_OFFSET]).toContain("AAA");
    expect(lines[ARTIFACT_LINE_OFFSET + 2]).toBe("CCC");
  });

  test("a raw srcdoc line converts to the line of the document the model wrote", () => {
    expect(toArtifactLine(ARTIFACT_LINE_OFFSET + 1)).toBe(1);
    expect(toArtifactLine(ARTIFACT_LINE_OFFSET + 42)).toBe(42);
    expect(toArtifactLine(ARTIFACT_LINE_OFFSET + 1177)).toBe(1177);
  });

  test("the offset is real — the wrapper does put lines above the artifact", () => {
    // If this were 0 the whole conversion would be a no-op and the test above
    // would pass vacuously. It is not: the CSP meta is a line of its own.
    expect(ARTIFACT_LINE_OFFSET).toBeGreaterThan(0);
  });

  test("MUTATION: forgetting to subtract the offset reports the WRONG line", () => {
    const raw = ARTIFACT_LINE_OFFSET + 42;
    const unmutated = toArtifactLine(raw);
    const mutated = (n: number): number => n; // the "just pass it through" bug
    expect(mutated(raw), "the mutation must actually change the answer").not.toBe(unmutated);
    expect(mutated(raw) - unmutated!).toBe(ARTIFACT_LINE_OFFSET);
    expect(unmutated).toBe(42);
  });

  test("a line inside OUR wrapper is not attributed to the artifact at all", () => {
    // Clamping to 1 or reporting 0 would blame the model's document for our
    // code's failure. No location is the honest answer.
    for (let raw = 1; raw <= ARTIFACT_LINE_OFFSET; raw += 1) {
      expect(toArtifactLine(raw), `srcdoc line ${raw} is the wrapper's`).toBeNull();
    }
  });

  test("no line reported means no line invented", () => {
    expect(toArtifactLine(null)).toBeNull();
    expect(sayError({ kind: "error", name: "Error", message: "x", line: null, column: null, at: 0 })).toContain(
      "the browser reported no location",
    );
  });

  test("the sentence is in the same register as the parse refusal", () => {
    // server/artifact-check.ts says "at line 12 of the document". A reader
    // must not have to learn two vocabularies for the same fact.
    const say = sayError({
      kind: "error",
      name: "TypeError",
      message: "boom",
      line: 12,
      column: 4,
      at: 0,
    });
    expect(say).toContain("TypeError: boom");
    expect(say).toContain("line 12");
    expect(say).toContain("of the document");
  });
});

// ── B. THE DOCUMENT HALF — the reporter really runs ──────────────────────

/**
 * Execute `REPORTER_SCRIPT` against a fake window, so the wiring is proven by
 * running it rather than by reading it. The script's first act is
 * `var W=window`, so shadowing `window` as a parameter is enough to capture it
 * whole.
 */
function runReporter(): { win: FakeWindow; posted: unknown[] } {
  const posted: unknown[] = [];
  const win: FakeWindow = {
    parent: { postMessage: (data: unknown) => void posted.push(data) },
    onerror: null,
    handlers: new Map(),
    addEventListener(type: string, fn: (e: unknown) => void) {
      this.handlers.set(type, fn);
    },
  };
  const body = REPORTER_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "");
  expect(body, "the script tag must have been stripped").not.toContain("<script");
  // eslint-disable-next-line no-new-func
  new Function("window", body)(win);
  return { win, posted };
}

type FakeWindow = {
  parent: { postMessage: (data: unknown, origin?: string) => void };
  onerror: null | ((m: unknown, s: unknown, l: unknown, c: unknown, e: unknown) => boolean);
  handlers: Map<string, (e: unknown) => void>;
  addEventListener(type: string, fn: (e: unknown) => void): void;
};

describe("B. the reporter inside the document reports what the browser gave it", () => {
  test("a thrown error is posted with its name, message and RAW line", () => {
    const { win, posted } = runReporter();
    expect(win.onerror, "onerror must be installed").not.toBeNull();
    win.onerror!("Uncaught TypeError: boom", "about:srcdoc", 43, 9, new TypeError("boom"));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      ch: CHANNEL,
      v: 1,
      kind: "error",
      name: "TypeError",
      message: "boom",
      line: 43,
      column: 9,
    });
  });

  test("onerror returns false, so the frame's own console still gets the error", () => {
    const { win } = runReporter();
    expect(win.onerror!("m", "s", 1, 1, null)).toBe(false);
  });

  test("an unhandled rejection is reported, with NO location invented for it", () => {
    const { win, posted } = runReporter();
    const onRejection = win.handlers.get("unhandledrejection");
    expect(onRejection, "the rejection listener must be installed").toBeDefined();
    onRejection!({ reason: new RangeError("late") });
    expect(posted[0]).toMatchObject({
      kind: "unhandledrejection",
      name: "RangeError",
      message: "late",
      line: null,
      column: null,
    });
  });

  test("a rejection with a non-Error reason still reports the reason, not a guess", () => {
    const { win, posted } = runReporter();
    win.handlers.get("unhandledrejection")!({ reason: "just a string" });
    expect(posted[0]).toMatchObject({ message: "just a string", line: null });
  });

  /**
   * FROM A USER'S REPORT AGAINST THE FIRST VERSION OF THIS CHANNEL: a game
   * whose `requestPointerLock()` the sandbox refused showed "the browser
   * reported no location". True of `unhandledrejection`'s own fields — and
   * needlessly so, because Chrome had put the location in the reason's stack.
   * These are the REAL strings Chrome produced, copied from a live frame.
   */
  describe("a rejection's location, when the browser really did report one", () => {
    const POINTER_LOCK =
      "SecurityError: Failed to execute 'requestPointerLock' on 'Element': Blocked pointer lock on an " +
      "element because the element's frame is sandboxed and the 'allow-pointer-lock' permission is not set.\n" +
      "    at about:srcdoc:8:15";

    test("the sandbox-refusal a user hit now carries its line and column", () => {
      const { win, posted } = runReporter();
      win.handlers.get("unhandledrejection")!({
        reason: { name: "SecurityError", message: "Blocked pointer lock…", stack: POINTER_LOCK },
      });
      expect(posted[0]).toMatchObject({ kind: "unhandledrejection", line: 8, column: 15 });
      // …and that raw line resolves to the line the model actually wrote.
      expect(toArtifactLine(8)).toBe(8 - ARTIFACT_LINE_OFFSET);
    });

    test("the TOPMOST frame wins — that is where it was raised", () => {
      const { win, posted } = runReporter();
      win.handlers.get("unhandledrejection")!({
        reason: { name: "TypeError", message: "x", stack: "TypeError: x\n    at about:srcdoc:8:40\n    at about:srcdoc:8:64" },
      });
      expect(posted[0]).toMatchObject({ line: 8, column: 40 });
    });

    test("a frame from a DIFFERENT document yields no location, not a wrong one", () => {
      // Attributing someone else's line to the model's file is the exact
      // fabrication this module refuses. Only `about:srcdoc` is our document.
      const foreign = [
        "TypeError: x\n    at https://evil.example/a.js:12:3",
        "TypeError: x\n    at blob:null/abc:9:1",
        "TypeError: x\n    at chrome-extension://k/c.js:4:2",
        "TypeError: x\n    at not-about:srcdoc:5:5",
        "TypeError: x\n    at about:srcdocX:5:5",
      ];
      for (const stack of foreign) {
        const { win, posted } = runReporter();
        win.handlers.get("unhandledrejection")!({ reason: { name: "TypeError", message: "x", stack } });
        expect(posted[0], stack).toMatchObject({ line: null, column: null });
      }
    });

    test("no stack, an unreadable stack, or a stack with no frame stays null", () => {
      for (const reason of [
        { name: "E", message: "m" },
        { name: "E", message: "m", stack: "E: m" },
        { name: "E", message: "m", get stack(): string { throw new Error("hostile getter"); } },
        "a bare string",
        null,
      ]) {
        const { win, posted } = runReporter();
        win.handlers.get("unhandledrejection")!({ reason });
        expect(posted[0]).toMatchObject({ line: null, column: null });
      }
    });

    test("MUTATION: accepting ANY url's :line:col would import a foreign location", () => {
      const loose = (s: string): number | null => {
        const m = /:(\d+):(\d+)/.exec(s);
        return m ? Number(m[1]) : null;
      };
      const foreign = "TypeError: x\n    at https://evil.example/a.js:12:3";
      expect(loose(foreign), "the mutation happily takes another document's line").toBe(12);
      const { win, posted } = runReporter();
      win.handlers.get("unhandledrejection")!({ reason: { name: "T", message: "x", stack: foreign } });
      expect(posted[0], "the real reporter refuses it").toMatchObject({ line: null });
    });
  });

  test("a missing or nonsensical location becomes null, never 0 and never a guess", () => {
    const { win, posted } = runReporter();
    win.onerror!("m", "s", 0, 0, null);
    win.onerror!("m", "s", undefined, undefined, null);
    win.onerror!("m", "s", Number.NaN, Infinity, null);
    for (const p of posted) expect(p).toMatchObject({ line: null, column: null });
  });

  test("the reporter is silent when there is no parent to talk to", () => {
    const posted: unknown[] = [];
    const win = {
      parent: null,
      onerror: null,
      addEventListener: () => {},
    };
    const body = REPORTER_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "");
    // eslint-disable-next-line no-new-func
    new Function("window", body)(win);
    expect(win.onerror, "nothing is installed when nobody is listening").toBeNull();
    expect(posted).toEqual([]);
  });

  test("the free-text fields are bounded on the way OUT as well as in", () => {
    const { win, posted } = runReporter();
    win.onerror!("x".repeat(50_000), "s", 5, 1, { name: "N".repeat(5_000), message: "y".repeat(50_000) });
    const p = posted[0] as { name: string; message: string };
    expect(p.name.length).toBeLessThanOrEqual(120);
    expect(p.message.length).toBeLessThanOrEqual(2000);
  });

  test("the reporter counts nothing — the HOST is the single capper", () => {
    // If the document capped too, the host's "N further errors" would be an
    // undercount of a number it could not see, which is a silent drop wearing
    // an honest label.
    const { win, posted } = runReporter();
    for (let i = 0; i < 500; i += 1) win.onerror!("m", "s", 5, 1, null);
    expect(posted).toHaveLength(500);
  });
});

// ── C. DENY BY DEFAULT — the schema ──────────────────────────────────────

describe("C. anything that is not a runtime-error report is dropped, not coerced", () => {
  test("the honest shape is accepted", () => {
    expect(parseReport(report())).toMatchObject({ kind: "error", name: "TypeError" });
  });

  const REFUSALS: readonly (readonly [string, unknown])[] = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "hello"],
    ["a number", 7],
    ["an array", [report()]],
    ["an array of the right length", ["ch", 1, "error", "n", "m", 1, 1]],
    ["the wrong channel tag", report({ ch: "artifact-rpc" })],
    ["no channel tag", (() => { const r = report(); delete r["ch"]; return r; })()],
    ["a future version", report({ v: 2 })],
    ["a string version", report({ v: "1" })],
    ["an unknown kind", report({ kind: "navigate" })],
    ["a kind that is not a string", report({ kind: 1 })],
    ["a numeric message", report({ message: 500 })],
    ["a message object", report({ message: { toString: () => "x" } })],
    ["a numeric name", report({ name: 1 })],
    ["a missing field", (() => { const r = report(); delete r["column"]; return r; })()],
    ["ONE extra field", { ...report(), extra: 1 }],
    ["an extra field that looks harmless", { ...report(), artifactId: "abc" }],
    ["a fractional line", report({ line: 12.5 })],
    ["a zero line", report({ line: 0 })],
    ["a negative line", report({ line: -3 })],
    ["a stringified line", report({ line: "42" })],
    ["a NaN line", report({ line: Number.NaN })],
    ["an infinite line", report({ line: Infinity })],
    ["an unsafe-integer line", report({ line: Number.MAX_SAFE_INTEGER + 2 })],
  ];

  for (const [name, data] of REFUSALS) {
    test(`refused: ${name}`, () => {
      expect(parseReport(data)).toBeNull();
    });
  }

  test("REFUSAL, not repair — a numeric message is not stringified", () => {
    // The distinction that matters: a validator that coerced would turn
    // `message: 500` into `"500"` and admit a shape nobody designed.
    expect(parseReport(report({ message: 500 }))).toBeNull();
  });

  test("an id in the payload is refused, because attribution is not the sender's to declare", () => {
    expect(parseReport({ ...report(), id: "other-artifact" })).toBeNull();
  });

  test("a prototype-polluting payload is refused like any other unknown shape", () => {
    const evil = JSON.parse('{"ch":"artifact-runtime-error","v":1,"kind":"error","name":"n","message":"m","line":1,"column":1,"__proto__":{"polluted":true}}');
    // JSON.parse puts __proto__ on the object as an own key in some engines and
    // not others; either way the result must be judged on its own key set.
    const out = parseReport(evil);
    expect(out === null || Object.keys(out).length === 5).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("MUTATION: a validator that only CHECKED for the keys would admit extras", () => {
    const loose = (data: unknown): boolean => {
      if (data === null || typeof data !== "object") return false;
      const o = data as Record<string, unknown>;
      return o["ch"] === CHANNEL && typeof o["message"] === "string";
    };
    const smuggled = { ...report(), navigateTo: "https://evil.example" };
    expect(loose(smuggled), "the mutation really is more permissive").toBe(true);
    expect(parseReport(smuggled), "the real validator refuses it").toBeNull();
  });
});

// ── D. ATTRIBUTION AND IMPERSONATION ─────────────────────────────────────

describe("D. an error belongs to the frame that posted it, and to no other", () => {
  let channel: ArtifactErrorChannel;
  beforeEach(() => {
    channel = new ArtifactErrorChannel(window);
  });
  afterEach(() => channel.uninstall());

  test("two frames keep two records", () => {
    const a = mountFrame();
    const b = mountFrame();
    channel.watch("beat-a", a);
    channel.watch("beat-b", b);

    expect(channel.deliver(a.contentWindow, report({ message: "A broke" }))).toBe("accepted");
    expect(channel.deliver(b.contentWindow, report({ message: "B broke" }))).toBe("accepted");

    expect(channel.stateOf("beat-a").errors.map((e) => e.message)).toEqual(["A broke"]);
    expect(channel.stateOf("beat-b").errors.map((e) => e.message)).toEqual(["B broke"]);
  });

  test("HOSTILE: an artifact cannot report its crash AS another artifact", () => {
    const a = mountFrame();
    const b = mountFrame();
    channel.watch("beat-a", a);
    channel.watch("beat-b", b);

    // A posts, naming B in every way a payload could. The payload has no id
    // field at all — and even a smuggled one is refused by the schema — so the
    // only thing that decides attribution is the window the browser named.
    expect(channel.deliver(a.contentWindow, { ...report(), id: "beat-b" })).toBe("malformed");
    channel.deliver(a.contentWindow, report({ message: "blame B" }));

    expect(channel.stateOf("beat-b").errors, "B reported nothing and must own nothing").toEqual([]);
    expect(channel.stateOf("beat-a").errors).toHaveLength(1);
  });

  test("HOSTILE: an unregistered window is refused before its payload is read", () => {
    const watched = mountFrame();
    const stranger = mountFrame();
    channel.watch("beat-a", watched);
    expect(channel.deliver(stranger.contentWindow, report())).toBe("unknown-source");
    expect(channel.stateOf("beat-a")).toEqual(EMPTY_STATE);
  });

  test("HOSTILE: a forged source value is not a window and is refused", () => {
    const el = mountFrame();
    channel.watch("beat-a", el);
    for (const forged of [null, undefined, {}, "beat-a", 0, window, document]) {
      expect(channel.deliver(forged, report())).toBe("unknown-source");
    }
    expect(channel.stateOf("beat-a").errors).toEqual([]);
  });

  test("a STALE window — the frame the element used to hold — is refused", () => {
    // The owner reads `el.contentWindow` at message time, never at watch time,
    // so a window that has been replaced cannot pass as the live one.
    const el = mountFrame();
    channel.watch("beat-a", el);
    const oldWindow = el.contentWindow;
    el.remove();
    document.body.appendChild(el); // jsdom hands the element a fresh window
    if (el.contentWindow !== oldWindow) {
      expect(channel.deliver(oldWindow, report())).toBe("unknown-source");
      expect(channel.deliver(el.contentWindow, report())).toBe("accepted");
    }
  });

  test("nothing is accepted before a frame is watched — deny by default", () => {
    const el = mountFrame();
    expect(channel.deliver(el.contentWindow, report())).toBe("unknown-source");
    expect(channel.installed, "and nothing is even listening yet").toBe(false);
  });

  test("the ONE listener really routes a real message event", () => {
    const el = mountFrame();
    channel.watch("beat-a", el);
    expect(channel.installed).toBe(true);
    window.dispatchEvent(
      new MessageEvent("message", { data: report({ message: "through the event" }), source: el.contentWindow }),
    );
    expect(channel.stateOf("beat-a").errors.map((e) => e.message)).toEqual(["through the event"]);
  });

  test("MUTATION: routing by a payload id instead of the source lets A impersonate B", () => {
    const a = mountFrame();
    const b = mountFrame();
    channel.watch("beat-a", a);
    channel.watch("beat-b", b);
    // The mutation: trust `data.id`. Model it and show what it admits.
    const byPayload = (data: Record<string, unknown>): string => String(data["id"]);
    expect(byPayload({ ...report(), id: "beat-b" }), "the mutation attributes to B").toBe("beat-b");
    // The real channel, given the same message from A, gives B nothing.
    channel.deliver(a.contentWindow, report());
    expect(channel.stateOf("beat-b").errors).toEqual([]);
  });
});

// ── E. THE FLOOD, BOUNDED AND STATED ─────────────────────────────────────

describe("E. a flooding artifact is capped, and the cap says so", () => {
  let channel: ArtifactErrorChannel;
  beforeEach(() => {
    channel = new ArtifactErrorChannel(window);
  });
  afterEach(() => {
    channel.uninstall();
    vi.useRealTimers();
  });

  /**
   * THE BOUND IS CHECKED BEFORE THE FLOOD IS RUN.
   *
   * Not tidiness — a guard that HANGS is a poor guard. An implementation with
   * no cap grows its state per message, so a 10,000-message flood in a test
   * would allocate until the suite times out, and "the suite never finished"
   * is a much weaker signal than a named failing assertion. This asserts the
   * bound at cap+1 messages, so a missing cap fails in milliseconds and the
   * flood below never runs.
   */
  function assertBoundedOrStop(channel: ArtifactErrorChannel, key: string, el: HTMLIFrameElement): void {
    for (let i = 0; i <= REPORT_CAP; i += 1) channel.deliver(el.contentWindow, report());
    expect(
      channel.stateOf(key).errors.length,
      "the cap is gone: state grows per message, so the flood below would not terminate",
    ).toBe(REPORT_CAP);
    channel.reset(key);
  }

  test("HOSTILE: `while(true) parent.postMessage(...)` keeps a bounded number", () => {
    const el = mountFrame();
    channel.watch("flood", el);
    assertBoundedOrStop(channel, "flood", el);
    for (let i = 0; i < 10_000; i += 1) channel.deliver(el.contentWindow, report({ message: `e${i}` }));
    const s = channel.stateOf("flood");
    expect(s.errors, "state must not grow with the flood").toHaveLength(REPORT_CAP);
    expect(s.suppressed).toBe(10_000 - REPORT_CAP);
  });

  test("…and the ones kept are the FIRST ones, which are the ones that explain the failure", () => {
    const el = mountFrame();
    channel.watch("flood", el);
    for (let i = 0; i < 50; i += 1) channel.deliver(el.contentWindow, report({ message: `e${i}` }));
    expect(channel.stateOf("flood").errors.map((e) => e.message)).toEqual(
      Array.from({ length: REPORT_CAP }, (_, i) => `e${i}`),
    );
  });

  test("the suppressed count is STATED, never silently dropped", () => {
    const el = mountFrame();
    channel.watch("flood", el);
    for (let i = 0; i < REPORT_CAP + 3; i += 1) channel.deliver(el.contentWindow, report());
    expect(saySuppressed(channel.stateOf("flood"))).toBe(
      "3 further errors were reported and are not shown",
    );
  });

  test("one suppressed error is said in the singular, because one is what happened", () => {
    const el = mountFrame();
    channel.watch("flood", el);
    for (let i = 0; i < REPORT_CAP + 1; i += 1) channel.deliver(el.contentWindow, report());
    expect(saySuppressed(channel.stateOf("flood"))).toBe("1 further error was reported and is not shown");
  });

  test("nothing suppressed says nothing", () => {
    expect(saySuppressed(EMPTY_STATE)).toBe("");
  });

  test("the flood costs a BOUNDED number of notifications, and the last one is exact", () => {
    vi.useFakeTimers();
    const el = mountFrame();
    channel.watch("bound", el);
    assertBoundedOrStop(channel, "bound", el);
    const seen: ArtifactErrorState[] = [];
    channel.subscribe("bound", (s) => seen.push(s));
    const initial = seen.length;

    for (let i = 0; i < 5_000; i += 1) channel.deliver(el.contentWindow, report());

    expect(
      seen.length - initial,
      "a notification per message would re-render the flow 5,000 times",
    ).toBeLessThan(REPORT_CAP + 5);

    // THE TRAILING FLUSH. Without it the last number on screen would be
    // whatever the throttle happened to land on — a real count, rounded down,
    // which is the fabrication this module exists to avoid.
    vi.advanceTimersByTime(SUPPRESS_NOTIFY_MS * 2);
    expect(seen[seen.length - 1]!.suppressed).toBe(5_000 - REPORT_CAP);
  });

  test("MUTATION: a cap that dropped silently would lose the count", () => {
    const silent = (n: number): { kept: number; suppressed: number } => ({
      kept: Math.min(n, REPORT_CAP),
      suppressed: 0,
    });
    const el = mountFrame();
    channel.watch("m", el);
    for (let i = 0; i < 20; i += 1) channel.deliver(el.contentWindow, report());
    expect(silent(20).suppressed, "the mutation reports nothing held back").toBe(0);
    expect(channel.stateOf("m").suppressed, "the real cap states it").toBe(15);
    expect(saySuppressed({ errors: [], suppressed: 0 })).toBe("");
  });

  test("HOSTILE: a flood of MALFORMED messages changes no state at all", () => {
    const el = mountFrame();
    channel.watch("junk", el);
    for (let i = 0; i < 1_000; i += 1) {
      expect(channel.deliver(el.contentWindow, { hello: i })).toBe("malformed");
    }
    expect(channel.stateOf("junk")).toEqual(EMPTY_STATE);
  });
});

// ── F. WHAT THE BEAT SAYS ────────────────────────────────────────────────

describe("F. the beat states the third outcome: it rendered, then it threw", () => {
  afterEach(() => {
    artifactErrors.forget("art-done");
    cleanup();
  });

  function mountBeat(key = "art-done") {
    return render(ArtifactFrame, {
      props: {
        frameKey: key,
        view: artifactViewOf(
          artifactBeat("done", { type: "html", title: "Monthly Signups", content: GOOD_DOC }, GOOD_OUTPUT),
        ),
      },
    });
  }

  test("a working artifact says nothing — no fault strip, no empty one", () => {
    const { container } = mountBeat();
    expect(container.querySelector('[data-artifact="runtime-error"]')).toBeNull();
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  test("a thrown error appears on the beat, with its artifact-relative line", async () => {
    const { container } = mountBeat();
    const el = container.querySelector("iframe") as HTMLIFrameElement;
    artifactErrors.deliver(el.contentWindow, report());
    await Promise.resolve();
    const strip = container.querySelector('[data-artifact="runtime-error"]');
    expect(strip, "the failure must be legible on the beat").not.toBeNull();
    const text = strip!.textContent ?? "";
    expect(text).toContain("rendered, then threw");
    expect(text).toContain("Cannot read properties of null");
    expect(text, "the line the MODEL wrote, not the wrapper's").toContain("line 42");
    expect(text).toContain("of the document");
  });

  test("THE FRAME IS NOT BLANKED — a partly-working artifact is still evidence", async () => {
    const { container } = mountBeat();
    const el = container.querySelector("iframe") as HTMLIFrameElement;
    artifactErrors.deliver(el.contentWindow, report());
    await Promise.resolve();
    expect(
      container.querySelector("iframe"),
      "blanking it would destroy the difference between 'ran and broke' and 'never ran'",
    ).not.toBeNull();
    expect(container.querySelector("iframe")!.getAttribute("srcdoc") ?? "").toContain("hello");
  });

  test("'never ran' and 'ran and broke' are TELLABLE APART", () => {
    // Never ran: no frame at all, a sentence saying why.
    const refused = render(ArtifactFrame, {
      props: {
        frameKey: "refused",
        view: artifactViewOf(
          artifactBeat("error", { type: "html", title: "B", content: GOOD_DOC }, "Error: refused", true),
        ),
      },
    });
    expect(refused.container.querySelector("iframe")).toBeNull();
    expect(refused.container.querySelector('[data-artifact="absence"]')).not.toBeNull();
    expect(refused.container.querySelector('[data-artifact="runtime-error"]')).toBeNull();
    cleanup();

    // Ran and broke: a frame AND a fault strip.
    const { container } = mountBeat();
    const el = container.querySelector("iframe") as HTMLIFrameElement;
    artifactErrors.deliver(el.contentWindow, report());
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  test("NO LAYOUT SHIFT — the declared box is identical before and after", async () => {
    const { container } = mountBeat();
    const el = container.querySelector("iframe") as HTMLIFrameElement;
    const before = el.getAttribute("style");
    const stageBefore = container.querySelector('[data-artifact="stage"]')!.getAttribute("style");
    artifactErrors.deliver(el.contentWindow, report());
    await Promise.resolve();
    expect(
      container.querySelector("iframe")!.getAttribute("style"),
      "the flow measured this beat once; a taller box would move every beat below it",
    ).toBe(before);
    expect(container.querySelector('[data-artifact="stage"]')!.getAttribute("style")).toBe(stageBefore);
    // …and the strip is INSIDE the declared box, which is what makes that true.
    const strip = container.querySelector('[data-artifact="runtime-error"]');
    expect(strip!.parentElement!.getAttribute("data-artifact")).toBe("stage");
  });

  test("the strip is positioned out of flow, and the stage is its containing block", () => {
    // The jsdom render above proves the strip is a child of the stage; this
    // proves the stage/strip pair is declared so the child cannot push it.
    const style = read(FRAME);
    expect(style).toMatch(/\.stage\s*\{[^}]*position:\s*relative/);
    expect(style).toMatch(/\.fault\s*\{[^}]*position:\s*absolute/);
  });

  test("NO MOTION, so prefers-reduced-motion is satisfied by construction", () => {
    // The strip is a STATE, not a transition, and §11.8 only licenses motion
    // that traces a recorded event. A reduced-motion override that could be
    // forgotten is strictly worse than having nothing to override.
    // HOW THIS READS THE RULE, AND WHY IT NO LONGER SLICES.
    //
    // This used to take `code.slice(code.indexOf(".fault {"), code.indexOf(".absent {"))`
    // — the NEXT RULE'S NAME as the end delimiter. That makes the assertion a
    // claim about CSS TEXT LAYOUT rather than about `.fault`: delete, rename or
    // merely reorder the neighbouring `.absent` rule and `indexOf` returns -1,
    // `slice(start, -1)` runs to the end of the file, and the check fails
    // reporting `transition` — a word that belongs to some other rule entirely.
    // An instrument whose failure message names the wrong subject is worse than
    // no instrument, because it sends the next reader to the wrong file.
    //
    // The rule's own closing brace is the only honest boundary, and nothing
    // outside `.fault` can move it.
    const code = read(FRAME);
    const rule = /\.fault\s*\{([^}]*)\}/.exec(code);
    expect(rule, ".fault must be declared for this to be a claim about it").not.toBeNull();
    const fault = rule![1]!;
    // THE WITNESS (§36): a body that came back empty would satisfy both
    // absences below while proving nothing was read.
    expect(fault, "the witness: the extracted body is really .fault's").toContain("position");
    expect(fault).not.toContain("transition");
    expect(fault).not.toContain("animation");
  });

  test("the suppressed count reaches the reader — at once, then exactly", async () => {
    vi.useFakeTimers();
    try {
      const { container } = mountBeat();
      const el = container.querySelector("iframe") as HTMLIFrameElement;
      for (let i = 0; i < REPORT_CAP + 4; i += 1) artifactErrors.deliver(el.contentWindow, report());
      await Promise.resolve();
      // Crossing the cap is delivered immediately — the reader learns that
      // errors are being held back in the frame it starts happening.
      const say = () => container.querySelector('[data-artifact="runtime-suppressed"]')?.textContent ?? "";
      expect(say(), "the suppression itself must be visible at once").toContain("further error");

      // The exact count arrives on the trailing flush. It is never rounded
      // down and left there.
      vi.advanceTimersByTime(SUPPRESS_NOTIFY_MS * 2);
      await Promise.resolve();
      expect(say()).toContain("4 further errors");
    } finally {
      vi.useRealTimers();
    }
  });

  test("RESTART clears the record — a fresh document has not thrown yet", async () => {
    const { container } = mountBeat();
    const el = container.querySelector("iframe") as HTMLIFrameElement;
    artifactErrors.deliver(el.contentWindow, report());
    await Promise.resolve();
    expect(container.querySelector('[data-artifact="runtime-error"]')).not.toBeNull();

    const restart = container.querySelector<HTMLButtonElement>('button.restart');
    expect(restart?.textContent).toBe("Restart");
    restart!.click();
    await Promise.resolve();
    expect(
      container.querySelector('[data-artifact="runtime-error"]'),
      "showing the old document's errors over a new one is stale, and stale is fabricated",
    ).toBeNull();
  });

  test("the frame carries the reporter, and it precedes the artifact's own content", () => {
    const { container } = mountBeat();
    const srcdoc = container.querySelector("iframe")!.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("artifact-runtime-error");
    expect(srcdoc.indexOf("artifact-runtime-error")).toBeLessThan(srcdoc.indexOf("hello"));
    expect(
      srcdoc.indexOf("Content-Security-Policy"),
      "the CSP must still be the document's FIRST policy",
    ).toBeLessThan(srcdoc.indexOf("artifact-runtime-error"));
  });

  test("the component still names no sandbox token and composes no CSP of its own", () => {
    const code = stripCommentsAndStringsFor(read(FRAME), FRAME);
    expect(code).toContain("sandboxedSrcdoc");
    expect(code).not.toMatch(/Content-Security-Policy/);
  });
});

// ── G. THE FLOW ATTRIBUTES, END TO END ───────────────────────────────────

describe("G. two artifacts in one conversation are two records", () => {
  afterEach(() => {
    artifactErrors.forget("beat-one");
    artifactErrors.forget("beat-two");
    cleanup();
  });

  function toolBeatWithId(id: string): Beat {
    const beat = artifactBeat("done", { type: "html", title: id, content: GOOD_DOC }, GOOD_OUTPUT);
    return { ...beat, id } as Beat;
  }

  test("the tool beat hands the frame its BEAT id, so one crash cannot land on the other", async () => {
    // Without this the channel is wired to nothing and the whole feature is
    // silently off — the exact failure mode it exists to remove.
    const one = render(ToolBeat, { props: { beat: toolBeatWithId("beat-one"), expanded: false } });
    const two = render(ToolBeat, { props: { beat: toolBeatWithId("beat-two"), expanded: false } });

    const frameOne = one.container.querySelector("iframe") as HTMLIFrameElement;
    const frameTwo = two.container.querySelector("iframe") as HTMLIFrameElement;
    expect(frameOne, "both beats must mount a frame").not.toBeNull();
    expect(frameTwo).not.toBeNull();

    expect(artifactErrors.deliver(frameOne.contentWindow, report({ message: "one broke" }))).toBe(
      "accepted",
    );
    await Promise.resolve();

    expect(one.container.textContent ?? "").toContain("one broke");
    expect(
      two.container.querySelector('[data-artifact="runtime-error"]'),
      "the neighbouring artifact reported nothing and must say nothing",
    ).toBeNull();
    expect(artifactErrors.stateOf("beat-two").errors).toEqual([]);
    expect(artifactErrors.stateOf("beat-one").errors).toHaveLength(1);
  });

  test("MUTATION: a frame with no key is wired to nothing, and that is visible", () => {
    const { container } = render(ArtifactFrame, {
      props: {
        frameKey: "",
        view: artifactViewOf(artifactBeat("done", { type: "html", title: "T", content: GOOD_DOC }, GOOD_OUTPUT)),
      },
    });
    const el = container.querySelector("iframe") as HTMLIFrameElement;
    expect(
      artifactErrors.deliver(el.contentWindow, report()),
      "an unkeyed frame is never watched, so its reports have nowhere to land",
    ).toBe("unknown-source");
  });
});
