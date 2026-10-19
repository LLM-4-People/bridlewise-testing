/**
 * Prevention test: tool call results and errors persist to the DB.
 *
 * Root cause: the run stream created a "running" tool_call row on
 * tool_call_start but never updated it with the execution result. The
 * tool_result SSE event was sent live but NOT persisted. Error model
 * events were also not persisted (fell through to the default case). So
 * on page refresh, tool calls and errors vanished from the chat.
 *
 * The claims below are STRUCTURAL, asked of the call graph and the
 * parser's own spans rather than of byte windows: these assertions used
 * to be `slice(anchor, anchor + N)` probes, and a byte window silently
 * captures the wrong region as soon as the run path is reformatted or
 * grows — it false-fails on an unrelated insertion and false-passes on a
 * neighbour that happens to sit inside N characters. Each claim is now
 * scoped to the enclosing function the invariant is actually about.
 *
 * This test verifies:
 * 1. DbClient has an `updateToolCall` method (updates output + status).
 * 2. run.ts persistModelEvent handles "error" (creates error message).
 * 3. run.ts has a persistToolResult function that updates the row.
 * 4. The tool_result frame is persisted by a call that runs AFTER the
 *    frame is published, inside the same function that publishes it.
 * 5. tool_call_start creates a "tool" role message and links the
 *    tool_call row to THAT message (not the assistant message); the row is
 *    INSERTED exactly once in the event lifecycle (on start).
 * 6. tool_call_done writes NOTHING — the row's input has ONE writer
 *    (persistToolResult, which already ran for the call inside the same
 *    turn iteration); a done-case write was the 34ms clobber (UIE-040).
 * 7. The fixture uses a consistent callId across start/delta/done.
 * 8. ActiveRun tracks toolCallRows by callId.
 *
 * Known residue of the door set, stated so it is chosen rather than
 * inherited: the error/tool-role message claims bind the object literal
 * and the createMessage envelope to the same function, not to one
 * another — a bare orphan literal plus an unrelated createMessage call
 * would still satisfy them. Byte windows had exactly the same hole, one
 * approximation wider.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// The run path is FIVE modules since the executor was split out of the GET
// handler that used to be it. This guard asks about the run path, not about
// whichever file happened to hold the answer when it was written.
import { runPathSource } from "../helpers/run-source.ts";
import {
  bodyCalls,
  bodyCallsWith,
  bodySays,
  callArgumentsOf,
  enclosingFunctionOf,
  functionBody,
  objectLiteralsWith,
} from "../helpers/function-scope.ts";

const runSource = runPathSource();

const dbPath = resolve(__dirname, "../../server/db/client.ts");
const dbSource = readFileSync(dbPath, "utf8");

const fixturePath = resolve(__dirname, "../../server/llm/fixtures.ts");
const fixtureSource = readFileSync(fixturePath, "utf8");

/**
 * A function body is not parseable source on its own — its statements may
 * legally `return` and `await` at the top level — so the literal-level
 * doors need it wrapped back into a function to take it as a subject.
 * The skeleton contributes nothing to the claims: every name and literal
 * below is the body's own.
 */
const asModule = (body: string): string => `async function __scopeSubject() {${body}}`;

const persistModelEventBody = (): ReturnType<typeof functionBody> =>
  functionBody(runSource, "persistModelEvent", "the run path's persistModelEvent");

describe("tool-result-persistence (prevention)", () => {
  it("DbClient has an updateToolCall method (UPDATE, not a second INSERT)", () => {
    // Existence through the parser (a missing or renamed method refuses
    // loudly rather than turning into "nothing is wrong with it"), plus the
    // claim the method exists for: it UPDATES a tool_calls row — results
    // are persisted by update, never by a second insert.
    const scope = functionBody(dbSource, "updateToolCall", "DbClient.updateToolCall");
    expect(
      bodySays(scope, "UPDATE tool_calls SET"),
      "updateToolCall must UPDATE the tool_calls row to persist tool results.",
    ).toBe(true);
    expect(
      bodySays(scope, "INSERT INTO tool_calls"),
      "updateToolCall must not INSERT a new tool_calls row (that re-introduces the duplicate-row defect at the DB layer).",
    ).toBe(false);
  });

  it("run.ts has a persistToolResult function", () => {
    expect(
      functionBody(runSource, "persistToolResult", "the run path's persistToolResult").body.length,
      "run.ts must have a persistToolResult function that updates the tool_call row with the result.",
    ).toBeGreaterThan(0);
  });

  it("persistToolResult is called after the tool_result frame is published", () => {
    // The run publishes to its own feed rather than writing into one HTTP
    // response, so the frame goes out through `publishRunFrame(runId, …)`.
    // The ORDER this test is about is unchanged: the durable row is written
    // after the frame that announces it. The claim is made about the
    // FUNCTION the publication lives in — publishing without persisting,
    // or persisting first, is red; how far apart the two lines stand is
    // not consulted.
    const anchor = "publishRunFrame(runId, SSE_EVENT_TYPES.toolResult";
    const publications: number[] = [];
    let searchFrom = 0;
    while (true) {
      const at = runSource.indexOf(anchor, searchFrom);
      if (at < 0) break;
      publications.push(at);
      searchFrom = at + 1;
    }
    expect(
      publications.length,
      "Could not find the tool_result frame publication in the run path",
    ).toBeGreaterThan(0);
    for (const at of publications) {
      const scope = enclosingFunctionOf(runSource, at, "the function publishing the tool_result frame");
      expect(scope !== undefined, "the tool_result publication must happen inside a function").toBe(true);
      if (scope === undefined) continue;
      expect(
        bodyCalls(scope, "persistToolResult"),
        "persistToolResult must be called by the same function that publishes the tool_result frame.",
      ).toBe(true);
      expect(
        bodyCallsWith(scope, "persistToolResult", ["db", "runId", "event.callId"]),
        "the persist call must carry THIS run's db, runId and callId — a same-shaped call persisting something else is not it.",
      ).toBe(true);
      // Order within the publication's own function body. Positions are
      // taken inside the parser's region, so no byte budget is guessed;
      // what is asserted is that a persist call occurs AFTER the frame,
      // which a 600-character window could only approximate.
      const publishAtInBody = at - scope.offset;
      expect(
        scope.body.indexOf("persistToolResult(", publishAtInBody),
        "persistToolResult must be called AFTER the tool_result frame is published (the durable row follows the live one).",
      ).toBeGreaterThan(publishAtInBody);
    }
  });

  it("persistModelEvent handles the 'error' case (creates an error message)", () => {
    // The error case must create a message with role "error" so errors
    // survive a page refresh. The case label and the literal are both
    // asserted INSIDE persistModelEvent's own body — before, a window of
    // 300 bytes after the case label stood in for that containment.
    const scope = persistModelEventBody();
    expect(
      scope.body,
      "persistModelEvent must handle the error event.",
    ).toContain('case "error"');
    const subject = asModule(scope.body);
    expect(
      objectLiteralsWith(subject, "role", "error", "persistModelEvent's error message").length,
      "persistModelEvent must create a role 'error' message so errors survive a page refresh.",
    ).toBeGreaterThan(0);
    expect(
      bodyCalls(scope, "db.createMessage"),
      "persistModelEvent must persist the message via db.createMessage.",
    ).toBe(true);
  });

  it("tool_call_start creates a 'tool' role message and links the row to it (not to the assistant message)", () => {
    const scope = persistModelEventBody();
    expect(
      scope.body,
      "persistModelEvent must handle the tool_call_start event.",
    ).toContain('case "tool_call_start"');
    const subject = asModule(scope.body);
    expect(
      objectLiteralsWith(subject, "role", "tool", "persistModelEvent's tool message").length,
      "tool_call_start must create a 'tool' role message so the tool call renders as its own card on reload.",
    ).toBeGreaterThan(0);
    expect(
      bodyCalls(scope, "db.createToolCall"),
      "tool_call_start must create the running tool_call row.",
    ).toBe(true);
    expect(
      objectLiteralsWith(subject, "message_id", "toolMsg.id", "the tool_call row's message link").length,
      "the tool_call row must link to the tool-role message just created.",
    ).toBeGreaterThan(0);
    expect(
      objectLiteralsWith(subject, "message_id", "active.assistantMessageId", "a row linked to the assistant message").length,
      "the tool_call row must NOT be linked to the assistant message — it renders as its own card.",
    ).toBe(0);
    // The row is INSERTED exactly once in the event lifecycle (on start).
    // A creation count rather than a distance guess — anywhere a second
    // insert is written (the duplicate-row defect), this goes red.
    expect(
      callArgumentsOf(subject, "db.createToolCall", "tool_call row creation inside persistModelEvent").length,
      "the tool_call row must be created exactly once in the event lifecycle (on start) — a second insert was the duplicate-row defect.",
    ).toBe(1);
  });

  it("tool_call_done writes NOTHING — the row's input has ONE writer, and it is persistToolResult", () => {
    // THE 34ms CLOBBER (UIE-040), pinned structurally. Within one turn
    // iteration the done-event persist runs AFTER the executor already
    // persisted the result (persistToolResult settles output, status,
    // duration AND input — the DISPATCHED arguments) — so a done-case row
    // write was a second writer the later write always won: measured live,
    // a 25-byte `{input: <raw delta>}` patch landed 34ms after the
    // 430-byte result patch and clobbered the dispatched whole, and the
    // reloaded view rendered an artifact whose content nobody could reach.
    //
    // MUTATION: reinstate `db.updateToolCall(...{ input: event.arguments })`
    // in the done case → both assertions below fail (the case body regains
    // the row write; the input literal reappears inside it).
    const scope = persistModelEventBody();
    expect(
      scope.body,
      "persistModelEvent must handle the tool_call_done event.",
    ).toContain('case "tool_call_done"');
    expect(
      bodyCalls(scope, "db.updateToolCall"),
      "the done case must NOT rewrite the row — persistToolResult (which already ran for this call) is the row's ONE writer, and a second write here races it (the 34ms clobber).",
    ).toBe(false);
    // The row's input is still persisted exactly once in the event
    // lifecycle — by persistToolResult, resolved to what was DISPATCHED.
    const persistScope = functionBody(runSource, "persistToolResult", "the run path's persistToolResult");
    expect(persistScope.body, "persistToolResult must exist to own the row's input").toBeTruthy();
    expect(
      objectLiteralsWith(asModule(persistScope.body), "input", "input", "persistToolResult's row write").length,
      "persistToolResult must settle the row's input beside the output it belongs to.",
    ).toBeGreaterThan(0);
    expect(
      runSource.includes("toolResult.dispatchedArguments ?? event.arguments"),
      "the persist call must resolve the input to what was DISPATCHED — the merged whole when the gate rewrote the call, else the event's own arguments.",
    ).toBe(true);
  });

  it("the fixture uses a consistent callId across tool_call_start/delta/done", () => {
    // The fixture must define a single callId variable and reuse it.
    expect(
      fixtureSource.includes("toolCallId"),
      "The fixture must use a single consistent callId variable across tool_call_start/delta/done.",
    ).toBe(true);
  });

  it("ActiveRun tracks toolCallRows by callId", () => {
    expect(
      runSource.includes("toolCallRows"),
      "ActiveRun must track toolCallRows (callId → row id) so the result can update the correct row.",
    ).toBe(true);
  });
});
