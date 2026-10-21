// @vitest-environment node
/**
 * LOG-NEVER-DISABLED (the guard catalog's LG class).
 *
 * UD-LOG-NEVER-DISABLED is the user's rule that warn and error are reported
 * everywhere, always; debug is the only optional level. The decision named
 * this guard before it existed: `debugLog` returned at `!configured ||
 * !enabled`, so a warn site whose own comment says "never silent" emitted
 * nothing in the default configuration — the shipped document is
 * `debug.enabled: false`, which made silence the normal state.
 *
 * The plant is the default logger itself: reset the singleton (no config, no
 * sinks) and drive a warn and an error through the real entry points. On the
 * old code both calls returned at the guard; here the stderr fallback must
 * carry both records. The laziness half is asserted beside it, so "always
 * report warn/error" cannot be implemented by turning debug back on.
 *
 * GUARD SUBJECT: warn and error records are delivered with no configured debug system, master switch off, a below-floor level, or an excluded category; debug/info/trace remain lazy
 * GUARD OWNS: engine/src/shared/debug/debug-system.ts (debugLog, handleError, emitAlwaysReported)
 * GUARD PLANT: reset the debug system, then drive debugLog("lg","warn"|"error", …) and handleError(…) with no config and with enabled=false/level="error"/categories=["other"]; the old guard produced zero records for all of them
 * GUARD DRIVEN: the exported debugLog/handleError entry points a webWarn or a catch block calls, plus the console sink the configured path installs
 * GUARD LIVENESS: the unconfigured caller asserts the context thunk WAS evaluated (the path ran), the configured arm asserts the collecting sink received two records, and the debug arm asserts its thunk was NOT evaluated (the optional level stayed lazy)
 */
import { afterEach, expect, test } from "vitest";

import {
  configureDebugSystem,
  createCollectingSink,
  debugLog,
  getDebugSignals,
  handleError,
  resetDebugSystem,
  wouldEmit,
} from "../../engine/src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../engine/src/shared/debug/debug-config.ts";

afterEach(() => {
  resetDebugSystem();
});

function captureStderr(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += chunk.toString();
    return true;
  }) as never;
  try {
    fn();
  } finally {
    process.stderr.write = original as never;
  }
  return captured;
}

test("an UNCONFIGURED system still reports a warn and an error record", () => {
  resetDebugSystem();
  let warnContext = false;
  let errorContext = false;
  const captured = captureStderr(() => {
    debugLog("lg", "warn", "LG-WARN unconfigured", () => {
      warnContext = true;
      return { detail: "warn" };
    });
    debugLog("lg", "error", "LG-ERROR unconfigured", () => {
      errorContext = true;
      return { detail: "error" };
    });
  });
  // LIVENESS: the calls reached the emission path (the thunks ran), so the
  // text below is an observation and not a scan of a path that never ran.
  expect(warnContext).toBe(true);
  expect(errorContext).toBe(true);
  expect(captured).toContain("LG-WARN unconfigured");
  expect(captured).toContain("LG-ERROR unconfigured");
  const signals = getDebugSignals();
  expect(signals.warnCount).toBe(1);
  expect(signals.errorCount).toBe(1);
});

test("a CONFIGURED system with the master switch off still delivers warn/error to its sink", () => {
  const sink = createCollectingSink();
  configureDebugSystem(
    {
      ...DEBUG_CONFIG_DEFAULTS,
      enabled: false,
      level: "error",
      categories: ["other"],
      sinks: { enabledSinks: ["collecting"] },
    },
    [sink],
  );
  debugLog("lg", "warn", "LG-WARN master-off");
  debugLog("lg", "error", "LG-ERROR master-off");
  expect(sink.events.map((event) => event.level)).toEqual(["warn", "error"]);
  expect(sink.events.map((event) => event.message)).toEqual(["LG-WARN master-off", "LG-ERROR master-off"]);
});

test("handleError reports an unconfigured system's error instead of returning at the guard", () => {
  resetDebugSystem();
  const before = getDebugSignals();
  const captured = captureStderr(() => {
    handleError(new Error("LG-HANDLE-ERROR unconfigured"), { module: "lg", operation: "drive" });
  });
  expect(captured).toContain("LG-HANDLE-ERROR unconfigured");
  expect(getDebugSignals().errorCount).toBe(before.errorCount + 1);
});

test("debug/info/trace remain lazy when the system is off (the optional level is not turned back on)", () => {
  resetDebugSystem();
  let evaluated = 0;
  const thunk = (): Readonly<Record<string, unknown>> => {
    evaluated += 1;
    return {};
  };
  debugLog("lg", "debug", "not emitted", thunk);
  debugLog("lg", "info", "not emitted", thunk);
  debugLog("lg", "trace", "not emitted", thunk);
  expect(evaluated, "the context thunk is the work the off switch skips").toBe(0);
  expect(getDebugSignals().debugCount).toBe(0);
  // `wouldEmit` is the same rule for callers that gate expensive context.
  expect(wouldEmit("lg", "debug")).toBe(false);
  expect(wouldEmit("lg", "warn")).toBe(true);
  expect(wouldEmit("lg", "error")).toBe(true);
});
