/**
 * Prevention test: timeline refresh fires once on "done", not per "finish".
 *
 * root cause: refreshTimeline() was called on every "finish" event.
 * With tool-call loops (multiple turns per run), this caused N timeline
 * queries per run — a request storm. The fix moves the refresh to the
 * "done" event (terminal, fires once after ALL turns).
 *
 * This test verifies the code structure: the `finish` event handler in
 * ingestModelEvent does NOT call refreshTimeline, and the `done` event
 * handler in openRunStream DOES call refreshTimeline. Both claims are made
 * about constructs the parser delimits — the ingester's own body, and the
 * listener registration's own argument list. They used to be asked of a
 * hand-counted brace walk with a five-hundred-byte fallback window, which
 * answered a neighbour's bytes whenever the case block was long and fell to
 * the window whenever the brace count went wrong.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bodyCalls, callArgumentsOf, functionBody } from "../helpers/function-scope.ts";

const clientPath = resolve(__dirname, "../../src/client.ts");
const clientSource = readFileSync(clientPath, "utf8");

describe("timeline-refresh-on-done (prevention)", () => {
  it("finish event handler does NOT call refreshTimeline", () => {
    // The model-event ingester handles "finish" (turn end — one per turn,
    // so N times in a tool-call loop) and must not refresh the timeline from
    // it. The claim is made about the ingester's whole body: NO case in it
    // may call refreshTimeline — a refresh on any model event is the request
    // storm, whichever case label it hides behind. The parser's call set is
    // what answers, so the NOTE comment inside the finish case explaining
    // exactly this is not mistaken for a call.
    const scope = functionBody(clientSource, "ingestModelEvent", "the model-event ingester");
    expect(
      scope.body.includes('case "finish"'),
      "ingestModelEvent must still handle the finish event — the subject this claim is about",
    ).toBe(true);
    expect(
      bodyCalls(scope, "refreshTimeline"),
      "refreshTimeline() is called in the model-event ingester — this causes a request storm with tool calls. " +
        "Move it to the 'done' event handler (fires once per run, not per turn).",
    ).toBe(false);
  });

  it("done event handler calls refreshTimeline", () => {
    // The done event handler should call refreshTimeline. SPO: the
    // listener is registered via the shared SSE_EVENT_TYPES owner. The
    // registration's argument list comes from the parser, so the claim is
    // about the done listener's own handler and not about whatever bytes
    // followed the call.
    const listeners = callArgumentsOf(clientSource, "es.addEventListener", "SSE listener registrations");
    const done = listeners.filter((args) => {
      const first = args.trimStart();
      // The first argument must be exactly SSE_EVENT_TYPES.done — a longer
      // member name sharing the prefix is a different listener.
      return first.startsWith("SSE_EVENT_TYPES.done") && !/\w/.test(first.charAt("SSE_EVENT_TYPES.done".length));
    });
    expect(
      done.length,
      "Could not find exactly one 'done' event listener in openRunStream",
    ).toBe(1);
    // The handler is judged as CODE: the registration's arguments are
    // wrapped back into a function so the call-graph doors can read them.
    // The wrapper contributes no names of its own — every call in the scope
    // is the listener registration's own.
    const handlerScope = functionBody(
      `function __doneListener() {\nreturn es.addEventListener(${done[0]!});\n}`,
      "__doneListener",
      "the done listener's handler",
    );
    expect(
      bodyCalls(handlerScope, "refreshTimeline"),
      "refreshTimeline() is NOT called in the 'done' event handler — " +
        "timeline events won't appear after a run completes without manual refresh.",
    ).toBe(true);
  });
});
