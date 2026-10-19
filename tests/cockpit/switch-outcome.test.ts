// @vitest-environment node
/**
 * THE SWITCH — outcome line mapping + the honesty guard (spec §5.2, §1.1).
 *
 * The reel's one measured line is a deterministic plain-language mapping of
 * `synthesis.conversationPulse`'s REAL fields; absence is honest ("no runs
 * yet"); and `assertOutcomeHonest` is MUTATION-TESTED here: a tampered
 * line, a fabricated measurement, or a rewritten absence reason must throw
 * (the task law: a reel without a supported outcome state → fail).
 */
import { describe, expect, test } from "vitest";

import {
  SwitchHonestyViolation,
  assertOutcomeHonest,
  outcomeFromPulse,
  outcomeGaps,
} from "../../src/cockpit/rooms/switch-outcome.ts";

const measured = <T>(value: T): unknown => ({ status: "measured", value, derivation: "test" });
const unavailable = (reason: string): unknown => ({ status: "unavailable", reason });

const FULL_PULSE = {
  runs: { known: 3, withEvents: 3, derivation: "test" },
  filesTouched: measured({ distinctPaths: 6, records: 9, paths: [], pathListTruncated: false }),
  toolsUsed: measured({ events: 12, byRecordedDescription: {} }),
  errors: measured({ eventsWithErrorDetail: 0, failedOutcomes: 0 }),
  tokens: measured({ totalTokens: 999 }),
  wallTimeSpan: measured({
    firstEventAt: "2026-07-25T14:02:00.000Z",
    lastEventAt: "2026-07-25T15:00:00.000Z",
    events: 240,
  }),
  checksFlipped: measured({ flips: 0 }),
};

describe("outcomeFromPulse — plain language over real fields", () => {
  test("a full pulse maps to runs · files · errors, with the measured start", () => {
    const o = outcomeFromPulse(FULL_PULSE);
    expect(o).toEqual({
      kind: "measured",
      line: "3 runs · 6 files · no errors",
      startMs: Date.parse("2026-07-25T14:02:00.000Z"),
      events: 240,
    });
  });

  test("real errors surface as a count, never softened", () => {
    const o = outcomeFromPulse({
      ...FULL_PULSE,
      errors: measured({ eventsWithErrorDetail: 1, failedOutcomes: 1 }),
    });
    expect(o.kind).toBe("measured");
    expect((o as { line: string }).line).toBe("3 runs · 6 files · 2 errors");
  });

  test("singulars read as singulars", () => {
    const o = outcomeFromPulse({
      runs: { known: 1 },
      filesTouched: measured({ distinctPaths: 1 }),
      errors: measured({ eventsWithErrorDetail: 1, failedOutcomes: 0 }),
    });
    expect((o as { line: string }).line).toBe("1 run · 1 file · 1 error");
  });

  test("no runs → the honest absence, not a zero-studded line", () => {
    expect(outcomeFromPulse({ ...FULL_PULSE, runs: { known: 0, withEvents: 0 } })).toEqual({
      kind: "absent",
      reason: "no runs yet",
      empty: true,
    });
  });

  test("an unavailable fact is SKIPPED, never guessed at", () => {
    const o = outcomeFromPulse({
      runs: { known: 2 },
      filesTouched: unavailable("no effect records"),
      errors: unavailable("no outcome records"),
    });
    expect(o).toEqual({ kind: "measured", line: "2 runs", startMs: null, events: null });
  });

  test("a malformed payload is absence with a reason, never a crash or a guess", () => {
    expect(outcomeFromPulse(null)).toEqual({ kind: "absent", reason: "outcome not readable" });
    expect(outcomeFromPulse("nope")).toEqual({ kind: "absent", reason: "outcome not readable" });
    expect(outcomeFromPulse({ runs: { known: "3" } })).toEqual({
      kind: "absent",
      reason: "outcome not readable",
    });
  });

  test("outcomeGaps cites the block's own unavailability reasons", () => {
    const gaps = outcomeGaps({
      runs: { known: 2 },
      filesTouched: unavailable("no effect records"),
      errors: measured({ eventsWithErrorDetail: 0, failedOutcomes: 0 }),
    });
    expect(gaps).toEqual(["files: no effect records"]);
  });
});

describe("assertOutcomeHonest — MUTATION-TESTED fabrication guard", () => {
  test("the true mapping passes", () => {
    const o = outcomeFromPulse(FULL_PULSE);
    expect(() => assertOutcomeHonest(o, FULL_PULSE)).not.toThrow();
  });

  test("mutation: a tampered line throws", () => {
    const o = outcomeFromPulse(FULL_PULSE);
    const tampered = { ...o, line: "300 runs · 60 files · no errors" } as never;
    expect(() => assertOutcomeHonest(tampered, FULL_PULSE)).toThrow(SwitchHonestyViolation);
  });

  test("mutation: a fabricated measurement over a runless pulse throws", () => {
    const fake = { kind: "measured", line: "5 runs", startMs: null, events: null } as const;
    expect(() =>
      assertOutcomeHonest(fake, { ...FULL_PULSE, runs: { known: 0 } }),
    ).toThrow(SwitchHonestyViolation);
  });

  test("mutation: an absence hiding real runs throws", () => {
    expect(() =>
      assertOutcomeHonest({ kind: "absent", reason: "no runs yet" }, FULL_PULSE),
    ).toThrow(SwitchHonestyViolation);
  });

  test("mutation: a rewritten absence reason throws (the reason is the pulse's own)", () => {
    expect(() =>
      assertOutcomeHonest(
        { kind: "absent", reason: "everything is fine" },
        { ...FULL_PULSE, runs: { known: 0 } },
      ),
    ).toThrow(SwitchHonestyViolation);
  });

  test("mutation: tampered span facts throw", () => {
    const o = outcomeFromPulse(FULL_PULSE);
    const tampered = { ...o, startMs: 1 } as never;
    expect(() => assertOutcomeHonest(tampered, FULL_PULSE)).toThrow(SwitchHonestyViolation);
  });
  test("quiet empty presentation requires the pulse's measured zero, not an unreadable reason", () => {
    const missing = outcomeFromPulse(null);
    expect(missing.kind === "absent" && missing.empty === true).toBe(false);
    expect(() => assertOutcomeHonest({kind:"absent",reason:"outcome not readable",empty:true}, null)).toThrowError("empty conversation state not supported by the pulse");
  });
});
