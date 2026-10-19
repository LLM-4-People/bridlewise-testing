// @vitest-environment node
/**
 * Prevention test (exp510): tool calls match by callId, not "last message".
 *
 * ROOT CAUSE: `ingestToolCallDone` and `ingestToolResult` previously used
 * `updateLastMessage()` — so when the LLM called N tools in one turn,
 * every result was applied to the Nth tool message. Tools 1..N-1 stayed
 * "running" forever. The user reported: "this tool is stuck at running
 * even tho I am pretty sure it is done: running get_repository_map".
 *
 * This test verifies:
 * 1. `updateToolCallById` updates the SPECIFIC tool by callId (not last).
 * 2. Concurrent tool calls each receive their own arguments + result.
 * 3. `finalizeRunningToolCalls` marks remaining "running" tools as
 * "error" (the "done" safety net).
 * 4. The safety net does NOT touch already-finalized tools.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { bodyCalls, functionArgumentsOf, functionBody } from "../helpers/function-scope.ts";

import {
  messages,
  appendToolCall,
  updateToolCallById,
  finalizeRunningToolCalls,
  healStrandedToolCallsFromLedger,
  settleHydratedRunningToolCalls,
  setMessages,
  type ToolCallView,
} from "../../src/state/chat-messages";

import { modulePathMatching } from "../helpers/module-resolver.ts";
function reset(): void {
  setMessages([]);
}

function tc(id: string, name: string): ToolCallView {
  return {
    id,
    name,
    input: null,
    output: null,
    status: "running",
    startedAt: Date.now(),
  };
}

describe("updateToolCallById — callId matching (exp510 fix)", () => {
  beforeEach(reset);

  it("updates the specific tool by callId, not the last message", () => {
    appendToolCall(tc("call-A", "get_repository_map"));
    appendToolCall(tc("call-B", "search_code"));

    // Update tool A by callId — even though B is the "last" message.
    updateToolCallById("call-A", (t) => ({ ...t, status: "done", output: "result-A" }));

    const list = messages.get();
    const a = list[0]!;
    const b = list[1]!;
    expect(a.toolCall?.status).toBe("done");
    expect(a.toolCall?.output).toBe("result-A");
    expect(b.toolCall?.status).toBe("running");
    expect(b.toolCall?.output).toBeNull();
  });

  it("each concurrent tool receives its own result independently", () => {
    appendToolCall(tc("call-A", "read_file"));
    appendToolCall(tc("call-B", "search_code"));
    appendToolCall(tc("call-C", "get_repository_map"));

    // Results arrive in order — each must update the correct tool.
    updateToolCallById("call-A", (t) => ({ ...t, status: "done", output: "file-content" }));
    updateToolCallById("call-B", (t) => ({ ...t, status: "done", output: "search-hits" }));
    updateToolCallById("call-C", (t) => ({ ...t, status: "error", output: "graph-error" }));

    const list = messages.get();
    expect(list[0]!.toolCall?.status).toBe("done");
    expect(list[0]!.toolCall?.output).toBe("file-content");
    expect(list[1]!.toolCall?.status).toBe("done");
    expect(list[1]!.toolCall?.output).toBe("search-hits");
    expect(list[2]!.toolCall?.status).toBe("error");
    expect(list[2]!.toolCall?.output).toBe("graph-error");
  });

  it("does not update anything when callId does not match", () => {
    appendToolCall(tc("call-X", "read_file"));
    updateToolCallById("call-NONEXISTENT", (t) => ({ ...t, status: "done" }));
    expect(messages.get()[0]!.toolCall?.status).toBe("running");
  });

  it("updates input via callId (ingestToolCallDone simulation)", () => {
    appendToolCall(tc("call-1", "read_file"));
    updateToolCallById("call-1", (t) => ({ ...t, input: { path: modulePathMatching("src/main.ts") } }));
    expect(messages.get()[0]!.toolCall?.input).toEqual({ path: modulePathMatching("src/main.ts") });
    expect(messages.get()[0]!.toolCall?.status).toBe("running");
  });
});

describe("finalizeRunningToolCalls — safety net (exp510 fix)", () => {
  beforeEach(reset);

  it("marks all running tools as error", () => {
    appendToolCall({ ...tc("call-A", "read_file"), status: "done", output: "ok" });
    appendToolCall(tc("call-B", "search_code"));
    appendToolCall(tc("call-C", "get_repository_map"));

    const count = finalizeRunningToolCalls("run completed without a tool result");

    expect(count).toBe(2);
    const list = messages.get();
    expect(list[0]!.toolCall?.status).toBe("done");
    expect(list[1]!.toolCall?.status).toBe("error");
    expect(list[1]!.toolCall?.endedAt).toBeTypeOf("number");
    expect(list[2]!.toolCall?.status).toBe("error");
  });

  it("returns 0 when no tools are running", () => {
    appendToolCall({ ...tc("call-A", "read_file"), status: "done" });
    expect(finalizeRunningToolCalls("test")).toBe(0);
  });

  it("does not touch already-done or already-error tools", () => {
    appendToolCall({ ...tc("call-A", "read_file"), status: "done", output: "result" });
    appendToolCall({ ...tc("call-B", "search_code"), status: "error", output: "err" });
    appendToolCall(tc("call-C", "get_repository_map"));

    finalizeRunningToolCalls("done event");

    const list = messages.get();
    expect(list[0]!.toolCall?.status).toBe("done");
    expect(list[0]!.toolCall?.output).toBe("result");
    expect(list[1]!.toolCall?.status).toBe("error");
    expect(list[1]!.toolCall?.output).toBe("err");
    expect(list[2]!.toolCall?.status).toBe("error");
  });

  it("records WHY the call never finished, without fabricating tool output", () => {
    // The reason is the client's own observation (the run ended while this
    // call was still in flight). It used to be written into `output` — the
    // field the card labels as what the TOOL returned — so the UI presented
    // an inference as the tool's result. It now lives in its own field and
    // `output` stays empty, which is the truth.
    appendToolCall(tc("call-A", "get_repository_map"));
    finalizeRunningToolCalls("run completed");
    const tc0 = messages.get()[0]!.toolCall!;
    expect(tc0.status).toBe("error");
    expect(tc0.incompleteReason).toContain("run completed");
    expect(tc0.output, "the tool returned nothing — do not invent output").toBeNull();
  });

  it("never overwrites output the tool actually produced", () => {
    appendToolCall({ ...tc("call-A", "read_file"), output: "partial contents" });
    finalizeRunningToolCalls("stream dropped");
    const tc0 = messages.get()[0]!.toolCall!;
    expect(tc0.output).toBe("partial contents");
    expect(tc0.incompleteReason).toBe("stream dropped");
  });
});

describe("healStrandedToolCallsFromLedger — the run-end read-back heal", () => {
  beforeEach(reset);

  // The incident's shape, from the ledger evidence: the card was created from
  // its start frame, its result frame never reached the client, the safety
  // net marked it error with an observation — and the DB held the call's real
  // (gate-block) result the whole time.
  function strandedCard(): void {
    appendToolCall({ ...tc("call-gate", "create_artifact"), input: { type: "app" } });
    finalizeRunningToolCalls("the run completed without this tool returning a result");
  }

  it("heals a stranded card from the ledger row, joined by the callId", () => {
    strandedCard();
    const healed = healStrandedToolCallsFromLedger([
      {
        callId: "call-gate",
        status: "error",
        output: "field 'type' must be one of: html, game, sheet, presentation, got \"app\"",
        durationMs: 41,
        attemptCount: 2,
      },
    ]);
    expect(healed).toBe(1);
    const tc0 = messages.get()[0]!.toolCall!;
    expect(tc0.status).toBe("error");
    expect(tc0.output).toContain("must be one of: html, game, sheet, presentation");
    expect(tc0.durationMs).toBe(41);
    expect(tc0.attemptCount).toBe(2);
    // A healed FAILURE with a recorded output is a refusal record — the
    // typed fact the artifact renderer keys "was the document accepted"
    // on. The heal must set it, exactly like the live result frame.
    expect(tc0.refused, "a healed error row is a recorded refusal").toBe(true);
    expect(
      tc0.incompleteReason,
      "the ledger has spoken — the client observation is withdrawn with the key",
    ).toBeUndefined();
  });

  it("heals to 'done' when the ledger says the call actually succeeded", () => {
    // The strand is a claim about the STREAM, not the run: a result frame can
    // be evicted from a SUCCESSFUL call too, and the heal must not assume the
    // stranded call failed.
    strandedCard();
    const healed = healStrandedToolCallsFromLedger([
      { callId: "call-gate", status: "done", output: "wrote 3 lines", durationMs: 7, attemptCount: 1 },
    ]);
    expect(healed).toBe(1);
    const tc0 = messages.get()[0]!.toolCall!;
    expect(tc0.status).toBe("done");
    expect(tc0.output).toBe("wrote 3 lines");
    // A healed SUCCESS is never a refusal — `refused` marks exactly the
    // calls the gate or the tool declined. Marking successes refused
    // would flip the artifact renderer's accept decision for every
    // healed-good call.
    expect(tc0.refused, "a healed success carries no refusal").toBeUndefined();
    expect(tc0.incompleteReason).toBeUndefined();
  });

  it("keeps the honest placeholder when the ledger holds no result either", () => {
    // The placeholder may only ever mean what it says: NO result anywhere.
    // A row with a settled status and NO output is the honest absence —
    // healing it would dress the absence up as a result.
    strandedCard();
    const healed = healStrandedToolCallsFromLedger([
      { callId: "call-gate", status: "error", output: null, durationMs: null, attemptCount: 1 },
    ]);
    expect(healed, "nothing may be healed from an empty ledger row").toBe(0);
    const tc0 = messages.get()[0]!.toolCall!;
    expect(tc0.status).toBe("error");
    expect(tc0.output).toBeNull();
    expect(tc0.incompleteReason).toContain("run completed without this tool");
  });

  it("keeps the placeholder for a row the ledger still holds as running", () => {
    strandedCard();
    const healed = healStrandedToolCallsFromLedger([
      { callId: "call-gate", status: "running", output: null, durationMs: null, attemptCount: 1 },
    ]);
    expect(healed).toBe(0);
    expect(messages.get()[0]!.toolCall!.incompleteReason).toContain("run completed");
  });

  it("keeps the placeholder for rows recorded before the callId was persisted", () => {
    // Pre-v17 rows carry no callId, so they cannot join to a live card. The
    // honest answer is the unhealed observation, never a guessed match.
    strandedCard();
    const healed = healStrandedToolCallsFromLedger([
      { callId: null, status: "error", output: "an old run's result", durationMs: 5, attemptCount: 1 },
    ]);
    expect(healed).toBe(0);
    expect(messages.get()[0]!.toolCall!.incompleteReason).toContain("run completed");
  });

  it("never touches a card that is not stranded", () => {
    appendToolCall({ ...tc("call-done", "read_file"), status: "done", output: "contents" });
    const healed = healStrandedToolCallsFromLedger([
      { callId: "call-done", status: "error", output: "a different fact", durationMs: 1, attemptCount: 9 },
    ]);
    expect(healed).toBe(0);
    const tc0 = messages.get()[0]!.toolCall!;
    expect(tc0.status, "a delivered result is never rewritten by the read-back").toBe("done");
    expect(tc0.output).toBe("contents");
    expect(tc0.attemptCount ?? 1).toBe(1);
  });

  it("heals the card's INPUT from the row's own record of what RAN (UIE-040's class, at the heal door)", () => {
    // A stranded card's input is whatever the model-event ingest set — the
    // delta the model sent. The row's input is the DISPATCHED whole. A heal
    // that adopted the output but not the input would leave the healed
    // card rendering the same unreachable document the frame path fixed.
    strandedCard();
    const healed = healStrandedToolCallsFromLedger([
      {
        callId: "call-gate",
        status: "done",
        output: "wrote the artifact",
        durationMs: 12,
        attemptCount: 1,
        input: { type: "html", title: "t", content: "<p>whole</p>" },
      },
    ]);
    expect(healed).toBe(1);
    const tc0 = messages.get()[0]!.toolCall!;
    expect(tc0.input, "the heal adopts the row's record of the dispatched arguments").toEqual({
      type: "html",
      title: "t",
      content: "<p>whole</p>",
    });
  });

  it("keeps the card's input when the row carries none (an honest absence, never a guessed wipe)", () => {
    strandedCard();
    healStrandedToolCallsFromLedger([
      { callId: "call-gate", status: "error", output: "a recorded refusal", durationMs: 3, attemptCount: 1, input: null },
    ]);
    expect(messages.get()[0]!.toolCall!.input, "the card keeps the input it had").toEqual({ type: "app" });
  });
});

/**
 * THE RELOAD-ORPHAN SETTLE (UIE-042) — the store half.
 *
 * A page reloaded mid-run hydrates its tool beats from rows persisted
 * "running", and never hears the frames that would settle them. The
 * settle takes the ledger read-back and settles each still-working card
 * from its row — the drive measured 8 beats spinning 5+ minutes after
 * the server-side run closed. The join key is BOTH ids the read-back
 * carries: a hydrated card's `toolCall.id` is the DB ROW id, while a card
 * created live carries the provider callId.
 */
describe("settleHydratedRunningToolCalls — the reload-orphan settle (UIE-042)", () => {
  beforeEach(reset);

  /** A hydrated card still showing "working": its toolCall.id is the DB
   * ROW id (the hydrate maps firstTool.id), never the provider callId. */
  function hydratedOrphan(): void {
    appendToolCall({ ...tc("tc-row-1", "create_artifact"), input: { type: "html" } });
  }

  it("settles a terminal row's recorded result onto the beat, joined by the ROW id", () => {
    hydratedOrphan();
    const outcome = settleHydratedRunningToolCalls(
      [
        {
          id: "tc-row-1",
          callId: "call-orphan",
          status: "done",
          output: "the result the stream never delivered",
          durationMs: 41,
          attemptCount: 1,
          input: { type: "html", title: "t", content: "<p>whole</p>" },
        },
      ],
      "the run ended before this tool recorded a result",
    );
    expect(outcome.settled).toBe(1);
    expect(outcome.stillRunning).toBe(0);
    const beat = messages.get()[0]!.toolCall!;
    expect(beat.status).toBe("done");
    expect(beat.output).toBe("the result the stream never delivered");
    expect(beat.input, "the row's record of what RAN settles the input too").toEqual({
      type: "html",
      title: "t",
      content: "<p>whole</p>",
    });
  });

  it("joins by the provider callId as well — a live-created card settles too", () => {
    appendToolCall(tc("call-live-1", "read_file"));
    const outcome = settleHydratedRunningToolCalls(
      [{ callId: "call-live-1", status: "error", output: "a recorded refusal", durationMs: 7, attemptCount: 2 }],
      "the run ended before this tool recorded a result",
    );
    expect(outcome.settled).toBe(1);
    const beat = messages.get()[0]!.toolCall!;
    expect(beat.status).toBe("error");
    expect(beat.refused, "a healed failure with a recorded output is a refusal record").toBe(true);
  });

  it("a terminal row with NO output settles the honest incomplete — never a fabricated tool answer", () => {
    hydratedOrphan();
    const outcome = settleHydratedRunningToolCalls(
      [{ id: "tc-row-1", callId: "call-orphan", status: "error", output: null, durationMs: null, attemptCount: 1 }],
      "the run ended before this tool recorded a result",
    );
    expect(outcome.settled).toBe(1);
    const beat = messages.get()[0]!.toolCall!;
    expect(beat.status).toBe("error");
    expect(beat.output ?? null, "the tool returned nothing — nothing is invented").toBeNull();
    expect(beat.incompleteReason).toContain("run ended before this tool recorded a result");
  });

  it("a row still running settles nothing and is counted — the reconcile keeps reading while the run is live", () => {
    hydratedOrphan();
    const outcome = settleHydratedRunningToolCalls(
      [{ id: "tc-row-1", callId: "call-orphan", status: "running", output: null, durationMs: null, attemptCount: 1 }],
      "the run ended before this tool recorded a result",
    );
    expect(outcome.settled).toBe(0);
    expect(outcome.stillRunning, "a live run's working face is true and the caller must keep reconciling").toBe(1);
    expect(messages.get()[0]!.toolCall!.status).toBe("running");
  });

  it("a card with no row stays working — nothing may be settled from an absence", () => {
    hydratedOrphan();
    const outcome = settleHydratedRunningToolCalls(
      [{ id: "tc-unrelated", callId: "call-unrelated", status: "done", output: "someone else's result", durationMs: 1, attemptCount: 1 }],
      "the run ended before this tool recorded a result",
    );
    expect(outcome.settled).toBe(0);
    expect(outcome.stillRunning).toBe(1);
    expect(messages.get()[0]!.toolCall!.status).toBe("running");
  });

  it("never touches a card that already settled", () => {
    appendToolCall({ ...tc("tc-row-done", "read_file"), status: "done", output: "contents" });
    const outcome = settleHydratedRunningToolCalls(
      [{ id: "tc-row-done", callId: null, status: "error", output: "a different fact", durationMs: 1, attemptCount: 9 }],
      "the run ended before this tool recorded a result",
    );
    expect(outcome.settled).toBe(0);
    expect(outcome.stillRunning).toBe(0);
    const beat = messages.get()[0]!.toolCall!;
    expect(beat.status, "a delivered result is never rewritten by the settle").toBe("done");
    expect(beat.output).toBe("contents");
  });

  it("empty rows settle nothing", () => {
    hydratedOrphan();
    const outcome = settleHydratedRunningToolCalls([], "the run ended before this tool recorded a result");
    expect(outcome.settled).toBe(0);
    expect(outcome.stillRunning).toBe(0);
    expect(messages.get()[0]!.toolCall!.status).toBe("running");
  });
});

/**
 * EVERY WAY A RUN ENDS FINALISES ITS TOOL BEATS — not just the happy one.
 *
 * The safety net above is correct and was, for a long time, effectively
 * unreachable. It had exactly ONE caller in the entire client: the `done`
 * listener. `done` is the terminal frame of a run that finished cleanly, which
 * is precisely the frame a FAILED run never sends. So a provider error, a
 * dropped connection, or a run that ended any way but cleanly left its
 * in-flight tools rendering "running" on screen — forever, across reloads,
 * because the server-side rows said the same thing.
 *
 * This is the shape the codebase keeps rediscovering: a capability that is
 * written, correct, tested in isolation, and wired to the one path that does
 * not need it. A unit test of the function passes either way, which is why the
 * guard has to be about the CALL SITES.
 *
 * It counts them from bytes rather than `grep`, because a source file
 * containing a NUL byte is treated as binary by GNU grep, which then prints
 * nothing and exits cleanly — a silently smaller universe. Eight files in this
 * tree contain a legitimate NUL.
 */
describe("the zombie-beat net is reachable from every run ending", () => {
  it("is called from more than one place, and the error paths are among them", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../../src/client.ts"), "utf8");

    // The single owner every ending goes through. Counted, so a future author
    // who inlines a second copy is told rather than trusted.
    const helperDefinitions = src.split("function finalizeStrandedToolCalls(").length - 1;
    expect(helperDefinitions, "one finaliser, not a copy per exit path").toBe(1);

    const callSites = src.split("finalizeStrandedToolCalls(").length - 1 - helperDefinitions;
    expect(
      callSites,
      "the safety net had ONE caller — the `done` listener — and `done` is the frame a " +
        "failed run never sends. Clean completion, a reported error, and a lost connection " +
        "are three endings and all three must close out their tool beats.",
    ).toBeGreaterThanOrEqual(3);

    // AND THE HELPER MUST ACTUALLY DO THE THING. Counting call sites proves
    // the wiring and says nothing about the wire: a version whose body
    // computed `finalizeRunningToolCalls` and discarded it kept all three call
    // sites, kept the function, and finalised nothing — and it DEFEATED this
    // guard until the assertion below was added. Wired-but-inert is the
    // failure that survives every count.
    //
    // The scope comes from the shared owner. Hand-rolling one here would be a
    // seventeenth copy of a body finder that has already been got wrong twice
    // in this codebase — once taking the next `{` after the name (a default
    // parameter's value) and once the return type's brace, each turning every
    // assertion about a function into an assertion about two bytes.
    const helper = functionBody(src, "finalizeStrandedToolCalls");
    expect(helper, "the helper's body must be located before it is judged").toBeTruthy();
    expect(
      bodyCalls(helper, "finalizeRunningToolCalls"),
      "the helper must reach the real finaliser — a body that computes the call and " +
        "discards it keeps every call site and finalises nothing",
    ).toBe(true);

    // …and it is reachable from the error listener specifically, which is the
    // path the original defect proved was uncovered. The listener is an
    // anonymous arrow, so it is scoped by the registration it belongs to
    // rather than by a name it does not have — never by a byte distance from
    // the registration, which a neighbouring listener would satisfy.
    const [errorListener] = functionArgumentsOf(
      src,
      "es.addEventListener",
      ["SSE_EVENT_TYPES.error"],
      modulePathMatching("src/client.ts"),
    );
    expect(errorListener, "the error listener must exist to be checked").toBeTruthy();
    expect(
      bodyCalls(errorListener!, "finalizeStrandedToolCalls"),
      "a run that ends by reporting an error must not leave its tools spinning",
    ).toBe(true);
  });
});
