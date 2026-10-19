// @vitest-environment node
/**
 * `toolCallDurationMs` in src/state/chat-messages.ts is the SINGLE owner of
 * "how long did this tool call take", and it is the only place allowed to
 * decide what counts as a measurement.
 *
 * Two consumers computed it themselves and both got it wrong in different
 * ways: ToolCallView fell back to `now - startedAt` for FINISHED calls (so a
 * rehydrated transcript reported its own age as the tool's duration), and
 * MetricsDashboard read `endedAt - startedAt` only — ignoring the
 * server-measured `durationMs` that is the sole survivor of a page refresh,
 * so the panel reported 0ms of tool time after a reload.
 *
 * The scan is DYNAMIC: it walks src/ and flags any file that does tool-call
 * duration arithmetic itself, so a new consumer is caught without editing
 * this test.
 */
import { describe, test, expect } from "vitest";
import { sourceFiles, read, relpath, stripCommentsAndStringsFor } from "../helpers/source-scan.ts";

import { modulePath } from "../helpers/module-resolver.ts";
const OWNER = modulePath("chat-messages.ts");

function codeOf(file: string): string {
  return stripCommentsAndStringsFor(read(file), file);
}

describe("tool-call duration has exactly one owner", () => {
  test("no file outside the owner derives a duration from endedAt/startedAt", () => {
    const offenders = sourceFiles("src")
      .map(relpath)
      .filter((f) => f !== OWNER)
      .filter((f) => /endedAt\s*-\s*\w*\.?startedAt/.test(codeOf(f)));

    expect(
      offenders,
      `these must call toolCallDurationMs from ${OWNER} instead of computing a duration`,
    ).toEqual([]);
  });

  test("the owner prefers the server-measured durationMs and returns null when nothing was measured", () => {
    const owner = codeOf(OWNER);
    const fn = owner.slice(owner.indexOf("export function toolCallDurationMs"));
    const body = fn.slice(0, fn.indexOf("\n}") + 2);
    expect(body, "durationMs is the authority (it survives a refresh)").toContain("tc.durationMs");
    expect(body, "no measurement → no value; never a synthesized one").toContain("return null");
    // The live-elapsed branch is legal ONLY behind a status check, and it
    // must CLAMP at zero: the reader's clock tick can sit before the call's
    // own stamp for up to one tick, and the unclamped form renders a
    // negative elapsed (a measurement no call earned). (String literals
    // are stripped by the scanner, so the guard is matched structurally
    // rather than by the word "running".)
    expect(body, "live elapsed must be gated on the call's status and clamped at zero").toMatch(
      /if\s*\(\s*tc\.status\s*===[^)]*\)\s*return\s+Math\.max\(0,\s*now\s*-\s*tc\.startedAt\);/,
    );
  });

  test("no consumer renders a live-elapsed timer off a tool call's startedAt", () => {
    // `now - toolCall.startedAt` outside the owner is the exact fabrication
    // that shipped: for a finished call it measures the transcript's age.
    // (Scoped to tool-call receivers — an unrelated `now - startedAt` for the
    // run timer or TTFT is a different fact with a different owner.)
    const offenders = sourceFiles("src")
      .map(relpath)
      .filter((f) => f !== OWNER)
      .filter((f) => /\bnow\s*-\s*(tc|toolCall)\.startedAt/.test(codeOf(f)));

    expect(offenders, `these must ask ${OWNER} for the duration`).toEqual([]);
  });

  test("the live tool beat asks the owner, never durationMs alone", () => {
    // THE DEFECT: ToolBeat rendered `tool.durationMs`, so a running call
    // (which has none) showed no clock even though the owner already
    // returned live elapsed. MUTATION: restore `{#if tool.durationMs !==
    // undefined}` and this fails.
    const beat = read("src/cockpit/flow/ToolBeat.svelte");
    expect(beat, "the live card must ask the duration owner").toContain("toolCallDurationMs");
    expect(
      beat,
      "the live card must not gate the duration field on the persisted slot",
    ).not.toMatch(/tool\.durationMs\s*!==\s*undefined/);
  });
});

describe("a tool call's own fields are never filled in on its behalf", () => {
  test("finalizeRunningToolCalls does not synthesize tool output", () => {
    // `output` means "what the tool returned". The safety net used to write
    // `Tool did not complete: <reason>` there, so the card displayed the
    // client's inference under an "output" label. The reason now has its own
    // field (`incompleteReason`) that the renderer labels differently.
    const owner = read(OWNER);
    const fn = owner.slice(owner.indexOf("export function finalizeRunningToolCalls"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
    expect(body, "the reason belongs in its own field").toContain("incompleteReason");
    expect(
      stripCommentsAndStringsFor(body, OWNER),
      "no assignment to output — the tool produced none",
    ).not.toMatch(/\boutput:/);
  });
});
