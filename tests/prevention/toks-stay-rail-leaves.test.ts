// @vitest-environment node
/**
 * DS-15 — tok/s stays; the rail leaves.
 *
 * CLASS: a finished turn must not keep the arrival rail, and a refresh
 * must still have tokens-per-second. Two prior shapes manufactured the
 * opposite: `showRail` gated on `observed.chars > 0` (rail on a completed
 * turn), and tps stamped only in the finish handler (this provider sends
 * usage AFTER finish, so the blob had tokens and no rate).
 *
 * Every claim is asked with NAMES on structurally bounded subjects — the
 * binding that gates the rail, the function that handles the stream, the
 * object literal that carries the rate — never with a pattern over a
 * window of raw source (the class the proximity-window guard bans).
 *
 * ABSENT: restore `|| observed.chars > 0` inside the showRail binding →
 * the first test reds. INERT: drop the tps merge from either usage
 * updater → the matching arm reds.
 */
import { describe, expect, test } from "vitest";

import { read } from "../helpers/source-scan.ts";
import { modulePathMatching } from "../helpers/module-resolver.ts";
import { bindingValueOf, bodyCalls, callArgumentsOf, functionBody, objectLiteralsWith } from "../helpers/function-scope.ts";

const TURN = modulePathMatching("src/cockpit/flow/TurnBeat.svelte");
const CLIENT = modulePathMatching("src/client.ts");
const EXECUTOR = modulePathMatching("server/run/run-executor.ts");

describe("the rail is streaming-only", () => {
  test("showRail is turn.streaming, not observed.chars", () => {
    // The binding is the subject; its body is read, and asked whether it
    // means what the label says. If the binding is renamed away the door
    // THROWS (a gone subject is a red guard, never a vacuous pass).
    const showRail = bindingValueOf(read(TURN), "showRail");
    expect(showRail.body, "a finished turn with arrivals must not keep the rail").toContain("turn.streaming");
    expect(showRail.body, "the old permanence gate is the defect this round closed").not.toContain("observed.chars");
  });
});

describe("tps is stamped when usage lands after finish", () => {
  test("the client usage handler writes tps onto existing timingMetrics", () => {
    const src = read(CLIENT);
    // The producing window's rate is computed by the one owner of the
    // rate formula.
    const handler = functionBody(src, "ingestModelEvent");
    expect(bodyCalls(handler, "rateTps"), "the rate is computed by the owner's door").toBe(true);
    // The usage merge is the updater that stiches tps ONTO the existing
    // `m.timingMetrics` — the finish updater computes fresh and does not
    // read it, so that read is the discriminating name. Both halves live
    // inside one balanced call argument, so the claim is scoped.
    const updaters = callArgumentsOf(src, "updateLastAssistantMessage").filter((args) =>
      args.includes("m.timingMetrics"),
    );
    expect(
      updaters.length,
      "an updater reads the existing timing block (the usage arm; the finish arm does not)",
    ).toBeGreaterThan(0);
    for (const args of updaters) {
      // The merge literal is the claim: binding `tps` ONTO the existing
      // timing metrics. Computing the rate and never binding it (the inert
      // shape) leaves the names present and this literal gone.
      expect(
        args.replace(/\s+/g, "").includes("...m.timingMetrics,tps}"),
        "the usage updater merges tps onto the existing timing block rather than dropping it",
      ).toBe(true);
    }
  });

  test("the server usage handler rewrites timingMetrics when finish already closed the window", () => {
    const src = read(EXECUTOR);
    const persist = functionBody(src, "persistModelEvent");
    expect(
      bodyCalls(persist, "timingMetricsForTurn"),
      "the closed-window timing is recomputed by the one owner of the timing block",
    ).toBe(true);
    // The metadata update carries a timingMetrics object built by that
    // call — proven by a literal whose `timingMetrics` field is the
    // `timing` value the usage branch computed.
    expect(
      objectLiteralsWith(src, "timingMetrics", "timing").length,
      "the usage-after-finish merge writes timingMetrics onto the message",
    ).toBeGreaterThan(0);
  });
});
