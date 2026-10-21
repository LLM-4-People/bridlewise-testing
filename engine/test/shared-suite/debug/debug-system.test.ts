import assert from "node:assert/strict";
import test from "node:test";

import {
  configureDebugSystem,
  resetDebugSystem,
  getDebugSignals,
  getAuditEvents,
  debugLog,
  auditEvent,
  handleError,
  wouldEmit,
  createCollectingSink,
  createConsoleSink,
  redactDiagnosticText,
  reportAlwaysOn,
} from "../../../src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS, DEBUG_CONFIG_SCHEMA, type DebugConfig } from "../../../src/shared/debug/debug-config.ts";
import { InputError, SecurityError } from "../../../src/kernel/errors.ts";

/**
 * Build a test config with the given overrides.
 *
 * `enabledSinks` names BOTH implemented kinds because these tests attach a
 * collecting sink and the door refuses any kind the config does not name. That
 * is the allow-list working, not a nuisance: the shipped
 * `bridlewise.config.json` enables `console` only, so nothing in production
 * can attach the collecting sink. The refusals themselves are driven in
 * "the sink door" section below, both directions.
 */
function testConfig(overrides: Partial<DebugConfig> = {}): DebugConfig {
  return {
    ...DEBUG_CONFIG_DEFAULTS,
    sinks: { ...DEBUG_CONFIG_DEFAULTS.sinks, enabledSinks: ["console", "collecting"] },
    ...overrides,
  } as DebugConfig;
}

function setup(overrides: Partial<DebugConfig> = {}): ReturnType<typeof createCollectingSink> {
  const sink = createCollectingSink();
  configureDebugSystem(testConfig({ enabled: true, level: "trace", categories: ["test"], ...overrides }), [sink]);
  return sink;
}

test("debug-system: debugLog is a no-op when not configured (before configureDebugSystem)", () => {
  resetDebugSystem();
  const before = getDebugSignals();
  debugLog("test", "debug", "should be a no-op", () => ({ expensive: sideEffect() }));
  const after = getDebugSignals();
  assert.equal(after.debugCount, before.debugCount, "no event emitted when unconfigured");
  assert.equal(sideEffectCallCount, 0, "context thunk must NOT be evaluated when unconfigured");
});

test("debug-system: debugLog is zero-overhead when disabled (context thunk not evaluated)", () => {
  configureDebugSystem(testConfig({ enabled: false }), [createCollectingSink()]);
  sideEffectCallCount = 0;
  debugLog("test", "debug", "should be skipped", () => ({ expensive: sideEffect() }));
  assert.equal(sideEffectCallCount, 0, "context thunk must NOT be evaluated when debug is disabled");
  assert.equal(getDebugSignals().debugCount, 0, "no event counted when disabled");
  resetDebugSystem();
});

test("debug-system: debugLog is zero-overhead when level is below floor (context thunk not evaluated)", () => {
  configureDebugSystem(testConfig({ enabled: true, level: "error", categories: ["test"] }), [createCollectingSink()]);
  sideEffectCallCount = 0;
  debugLog("test", "debug", "should be skipped (level below error)", () => ({ expensive: sideEffect() }));
  assert.equal(sideEffectCallCount, 0, "context thunk must NOT be evaluated when level is below the floor");
  assert.equal(getDebugSignals().suppressedByLevel, 1, "suppressedByLevel incremented");
  resetDebugSystem();
});

test("debug-system: debugLog is zero-overhead when category not in allow-list (context thunk not evaluated)", () => {
  configureDebugSystem(testConfig({ enabled: true, level: "trace", categories: ["other"] }), [createCollectingSink()]);
  sideEffectCallCount = 0;
  debugLog("test", "debug", "should be skipped (category not allowed)", () => ({ expensive: sideEffect() }));
  assert.equal(sideEffectCallCount, 0, "context thunk must NOT be evaluated when category is not allowed");
  assert.equal(getDebugSignals().suppressedByCategory, 1, "suppressedByCategory incremented");
  resetDebugSystem();
});

test("debug-system: debugLog emits when enabled + level + category match", () => {
  const sink = setup();
  debugLog("test", "info", "hello", () => ({ key: "value" }));
  assert.equal(sink.events.length, 1, "one event emitted");
  assert.equal(sink.events[0]!.kind, "debug");
  assert.equal(sink.events[0]!.level, "info");
  assert.equal(sink.events[0]!.message, "hello");
  assert.deepEqual(sink.events[0]!.context, { key: "value" });
  resetDebugSystem();
});

test("debug-system: debugLog without context thunk works", () => {
  const sink = setup();
  debugLog("test", "warn", "no context");
  assert.equal(sink.events.length, 1);
  assert.deepEqual(sink.events[0]!.context, {});
  assert.equal(getDebugSignals().warnCount, 1);
  resetDebugSystem();
});

test("debug-system: debugLog counts warn and debug separately", () => {
  const sink = setup();
  debugLog("test", "warn", "warning");
  debugLog("test", "error", "error");
  debugLog("test", "debug", "debug msg");
  debugLog("test", "info", "info msg");
  assert.equal(sink.events.length, 4, "all four events collected");
  const sig = getDebugSignals();
  assert.equal(sig.warnCount, 1);
  assert.equal(sig.debugCount, 4, "debugCount counts all emitted messages");
  resetDebugSystem();
});

test("debug-system: auditEvent is recorded independent of master enabled switch (safety floor)", () => {
  configureDebugSystem(
    testConfig({ enabled: false, audit: { enabled: true, maxRetainedEvents: 100, categories: [] } }),
    [createCollectingSink()],
  );
  auditEvent("test.action", { detail: "data" });
  assert.equal(getDebugSignals().auditCount, 1, "audit recorded even when master debug is off");
  assert.equal(getAuditEvents().length, 1, "audit in ring buffer");
  assert.equal(getAuditEvents()[0]!.category, "test.action");
  resetDebugSystem();
});

test("debug-system: auditEvent respects audit.enabled=false", () => {
  configureDebugSystem(
    testConfig({ enabled: true, audit: { enabled: false, maxRetainedEvents: 100, categories: [] } }),
    [createCollectingSink()],
  );
  auditEvent("test.action", { detail: "data" });
  assert.equal(getDebugSignals().auditCount, 0, "audit NOT recorded when audit.enabled is false");
  assert.equal(getAuditEvents().length, 0);
  resetDebugSystem();
});

test("debug-system: auditEvent respects audit.categories allow-list when non-empty", () => {
  configureDebugSystem(
    testConfig({ enabled: true, audit: { enabled: true, maxRetainedEvents: 100, categories: ["allowed"] } }),
    [createCollectingSink()],
  );
  auditEvent("allowed", { x: 1 });
  auditEvent("blocked", { x: 2 });
  assert.equal(getDebugSignals().auditCount, 1, "only allow-listed category recorded");
  assert.equal(getAuditEvents()[0]!.category, "allowed");
  resetDebugSystem();
});

test("debug-system: audit ring buffer evicts oldest entries at maxRetainedEvents", () => {
  configureDebugSystem(
    testConfig({ enabled: true, audit: { enabled: true, maxRetainedEvents: 3, categories: [] } }),
    [createCollectingSink()],
  );
  for (let i = 0; i < 5; i++) auditEvent("evt", { i });
  const events = getAuditEvents();
  assert.equal(events.length, 3, "ring buffer capped at maxRetainedEvents");
  // newest-first ordering
  assert.equal(events[0]!.context.i, 4);
  assert.equal(events[2]!.context.i, 2);
  resetDebugSystem();
});

test("debug-system: handleError classifies typed HarnessError", () => {
  const sink = setup();
  const err = new InputError("bad input", "input_bad");
  handleError(err, { module: "test-mod", operation: "parse" });
  assert.equal(sink.events.length, 1);
  const evt = sink.events[0]!;
  assert.equal(evt.kind, "error");
  assert.equal(evt.code, "input_bad");
  assert.equal(evt.level, "error");
  assert.equal(evt.context.retryable, false);
  assert.equal(evt.context.module, "test-mod");
  assert.equal(getDebugSignals().errorCount, 1);
  resetDebugSystem();
});

test("debug-system: handleError classifies unknown error as internal_error", () => {
  const sink = setup();
  handleError(new Error("boom"), { module: "mod", operation: "op" });
  assert.equal(sink.events[0]!.code, "internal_error");
  assert.equal(sink.events[0]!.message, "boom");
  resetDebugSystem();
});

test("debug-system: handleError classifies non-Error as internal_error", () => {
  const sink = setup();
  handleError("string error", { module: "mod", operation: "op" });
  assert.equal(sink.events[0]!.code, "internal_error");
  assert.equal(sink.events[0]!.message, "string error");
  resetDebugSystem();
});

test("debug-system: handleError classifies abort errors as info level (not error)", () => {
  const sink = setup();
  const abortErr = new DOMException("aborted", "AbortError");
  handleError(abortErr, { module: "mod", operation: "cancel" });
  assert.equal(sink.events[0]!.level, "info", "abort errors are info, not error");
  assert.equal(sink.events[0]!.code, "internal_error");
  resetDebugSystem();
});

test("debug-system: handleError includes safeDetails from HarnessError", () => {
  const sink = setup();
  const err = new SecurityError("denied", "sec_denied");
  err.safeDetails;
  handleError(err, { module: "mod", operation: "op" });
  assert.ok("safeDetails" in sink.events[0]!.context, "safeDetails propagated");
  resetDebugSystem();
});

test("debug-system: handleError deduplication suppresses same code within window", () => {
  const sink = setup({ errorHandling: { ...DEBUG_CONFIG_DEFAULTS.errorHandling, reportingPolicy: "deduplicated", dedupWindowMs: 1000 } });
  const err = new InputError("bad", "dup_code");
  handleError(err, { module: "mod", operation: "op" });
  handleError(err, { module: "mod", operation: "op" });
  handleError(err, { module: "mod", operation: "op" });
  assert.equal(sink.events.length, 1, "dedup suppresses repeats within window");
  assert.equal(getDebugSignals().errorCount, 3, "all errors counted even if not emitted");
  resetDebugSystem();
});

test("debug-system: handleError does not swallow — caller decides to rethrow", () => {
  const sink = setup();
  const err = new InputError("bad", "test_rethrow");
  try {
    try {
      throw err;
    } catch (e) {
      handleError(e, { module: "mod", operation: "op" });
      throw e; // rethrow — handleError does NOT swallow
    }
  } catch (caught) {
    assert.equal(caught, err, "error propagated (not swallowed)");
  }
  assert.equal(sink.events.length, 1, "handleError emitted before rethrow");
  resetDebugSystem();
});

test("debug-system: redaction redacts values matching forbiddenPatterns", () => {
  const sink = setup();
  debugLog("test", "info", "msg", () => ({ apiKey: "sk-abc123", safe: "ok" }));
  const evt = sink.events[0]!;
  assert.equal(evt.context.safe, "ok", "safe value preserved");
  assert.ok(String(evt.context.apiKey).includes("[REDACTED]"), "api key redacted");
  assert.ok(getDebugSignals().redactedValues >= 1, "redaction counted");
  resetDebugSystem();
});

test("debug-system: redaction truncates long values", () => {
  const sink = setup({ redaction: { ...DEBUG_CONFIG_DEFAULTS.redaction, maxContextValueLength: 10 } });
  debugLog("test", "info", "msg", () => ({ long: "a".repeat(100) }));
  const val = String(sink.events[0]!.context.long);
  assert.ok(val.includes("[truncated]"), "long value truncated");
  assert.ok(val.length < 100, "truncated value shorter than original");
  resetDebugSystem();
});

test("debug-system: redaction disabled preserves raw values", () => {
  const sink = setup({ redaction: { ...DEBUG_CONFIG_DEFAULTS.redaction, enabled: false } });
  debugLog("test", "info", "msg", () => ({ apiKey: "sk-abc123" }));
  assert.equal(sink.events[0]!.context.apiKey, "sk-abc123", "raw value preserved when redaction disabled");
  resetDebugSystem();
});

/**
 * ── THE FATAL, PINNED IN BOTH DIRECTIONS ──────────────────────────────────
 *
 * A redaction that did not remove the value must not be able to REPORT SUCCESS.
 * These tests are the transcript in `debug-system.ts`'s redaction header, made
 * executable, and they are deliberately blunt about what is still leaking: in
 * shapes 1-3 the key is STILL IN THE TEXT. What is fixed is that the run no
 * longer claims it removed it.
 *
 * Every absence assertion here carries a §36 WITNESS — something asserted
 * PRESENT in the same string as the canary — so an assertion pointed at the
 * wrong field fails instead of passing.
 *
 * The INERT control is the one that must never be deleted: the honest property
 * of the OLD code was that a string matching nothing left every counter at zero.
 * The defect was a partial change reported as a whole one, never success
 * invented from nothing, and a fix that broke the inert case would trade one
 * false signal for another.
 */
const LIVE_KEY = "sk-LIVEKEY-8f31c05a9e27b46d1a08f3c65b92d740";
const SHAPELESS_KEY = "Zq7Kd2Mn8Rt4Wv6Yb1Xc3Fg5Hj9Ll0Pp";

test("debug-system: shape 1 — the key BODY is gone now, and it is STILL not a redaction claim", () => {
  // ⚠ THIS TEST'S CENTRAL ASSERTION IS INVERTED FROM WHAT IT USED TO BE, AND
  // THAT INVERSION IS THE FIX.
  //
  // It used to assert `out.includes("LIVEKEY-8f31c05…")` — "the key body is
  // STILL PRESENT — the stated limit" — because the content channel ran
  // KEY-NAME patterns against string CONTENT, so the only thing that fired on
  // a live credential was `[Ss]k[-_]` against its own three-character prefix
  // and 40 of 43 characters walked out.
  //
  // The content channel now runs `SECRET_TEXT_SIGNAL_CATALOG`, which matches
  // credential FORMATS. `token-prefix` covers `sk-<20+ chars>`, so the whole
  // credential is what gets replaced. The limit is closed, so the test that
  // recorded it asserts the closure — with the same §36 witness discipline, so
  // an assertion pointed at the wrong field still fails instead of passing.
  //
  // WHAT DOES NOT CHANGE: `redactedValues` stays 0. A format catalogue is a
  // recogniser, not a proof of absence, so this is still not a removal claim —
  // see shape 3, where a credential of no recognisable shape survives whole.
  const sink = setup();
  const before = getDebugSignals();
  debugLog("test", "error", "msg", () => ({ detail: `WITNESS-S1 Incorrect API key provided: ${LIVE_KEY}.` }));
  const out = String(sink.events[0]!.context.detail);
  const after = getDebugSignals();

  assert.ok(out.includes("WITNESS-S1"), "witness: the assertion is reading the string the canary was in");
  assert.ok(out.includes("[REDACTED]"), "witness: a pattern really did fire on this string");
  assert.ok(!out.includes("LIVEKEY-8f31c05a9e27b46d1a08f3c65b92d740"), "the key BODY is gone — the 40-of-43 leak is closed");
  assert.ok(!out.includes(LIVE_KEY), "and no copy of the whole key survives either");
  assert.equal(after.redactedValues - before.redactedValues, 0, "and it is STILL NOT reported as a redaction");
  assert.equal(after.maskedWithoutRemoval - before.maskedWithoutRemoval, 1, "the honest counter takes it instead");
  resetDebugSystem();
});

test("debug-system: shape 2 — EVERY occurrence is masked, not only the first", () => {
  const sink = setup();
  const before = getDebugSignals();
  debugLog("test", "error", "msg", () => ({ detail: `WITNESS-S2 retrying ${LIVE_KEY} then ${LIVE_KEY}` }));
  const out = String(sink.events[0]!.context.detail);
  const after = getDebugSignals();

  assert.ok(out.includes("WITNESS-S2"), "witness: reading the right string");
  assert.equal(out.split("[REDACTED]").length - 1, 2, "witness: BOTH occurrences were touched — the non-global regex bug is gone");
  assert.equal(out.split(LIVE_KEY).length - 1, 0, "no copy of the key survives with its prefix intact");
  assert.equal(after.redactedValues - before.redactedValues, 0, "still not a success claim: the key body remains");
  assert.equal(after.maskedWithoutRemoval - before.maskedWithoutRemoval, 1, "counted honestly");
  resetDebugSystem();
});

test("debug-system: shape 3 — masking the NOUN of a shapeless key is not a redaction", () => {
  const sink = setup();
  const before = getDebugSignals();
  debugLog("test", "error", "msg", () => ({ detail: `WITNESS-S3 credential rejected: ${SHAPELESS_KEY}` }));
  const out = String(sink.events[0]!.context.detail);
  const after = getDebugSignals();

  assert.ok(out.includes("WITNESS-S3"), "witness: reading the right string");
  assert.ok(out.includes("[REDACTED]"), "witness: the word 'credential' really was masked");
  assert.ok(out.includes(SHAPELESS_KEY), "the entire shapeless key survives — the stated limit");
  assert.equal(after.redactedValues - before.redactedValues, 0, "masking the noun is NOT reported as removing the value");
  assert.equal(after.maskedWithoutRemoval - before.maskedWithoutRemoval, 1, "counted as what it is");
  resetDebugSystem();
});

test("debug-system: INERT control — a string matching nothing leaves BOTH counters at zero", () => {
  const sink = setup();
  const before = getDebugSignals();
  const inert = "WITNESS-S4 nothing here matches anything at all 12345";
  debugLog("test", "error", "msg", () => ({ detail: inert }));
  const out = String(sink.events[0]!.context.detail);
  const after = getDebugSignals();

  assert.equal(out, inert, "witness: the value came through byte-identical, so the redactor really ran on it");
  assert.equal(after.redactedValues - before.redactedValues, 0, "no success invented out of nothing");
  assert.equal(after.maskedWithoutRemoval - before.maskedWithoutRemoval, 0, "and nothing claimed as masked either");
  assert.equal(after.debugCount - before.debugCount, 1, "witness: an event WAS emitted — the zeros are not from a no-op");
  resetDebugSystem();
});

test("debug-system: a WHOLE VALUE dropped for a sensitive KEY NAME is the one real success claim", () => {
  // The only removal this layer can point at: the value string is discarded and
  // a constant written in its place, so nothing of it can survive by
  // construction. This is what `redactedValues` is allowed to mean.
  const sink = setup();
  const before = getDebugSignals();
  debugLog("test", "error", "msg", () => ({ apiKey: LIVE_KEY, note: "WITNESS-S5 kept" }));
  const ctx = sink.events[0]!.context;
  const after = getDebugSignals();

  assert.equal(ctx.note, "WITNESS-S5 kept", "witness: a non-sensitive sibling key is untouched");
  assert.equal(ctx.apiKey, "[REDACTED]", "the whole value is gone, not part of it");
  assert.ok(!JSON.stringify(ctx).includes("LIVEKEY"), "no fragment of the key is anywhere in the context");
  assert.equal(after.redactedValues - before.redactedValues, 1, "and THIS is reported as a redaction");
  resetDebugSystem();
});

test("debug-system: the length cap is a volume bound and reports NO redaction", () => {
  // It used to set `redacted: true`, so a long innocuous string counted as a
  // successful redaction of a secret that was never there.
  const sink = setup({ redaction: { ...DEBUG_CONFIG_DEFAULTS.redaction, maxContextValueLength: 20 } });
  const before = getDebugSignals();
  debugLog("test", "error", "msg", () => ({ detail: `WITNESS-S6 ${"z".repeat(200)}` }));
  const out = String(sink.events[0]!.context.detail);
  const after = getDebugSignals();

  assert.ok(out.includes("WITNESS-S6"), "witness: reading the right string");
  assert.ok(out.includes("[truncated]"), "witness: the cap really fired");
  assert.equal(after.redactedValues - before.redactedValues, 0, "truncation is not a redaction");
  assert.equal(after.maskedWithoutRemoval - before.maskedWithoutRemoval, 0, "and it is not a mask either");
  resetDebugSystem();
});

test("debug-system: handleError's MESSAGE channel is accounted the same way as its context", () => {
  const sink = setup();
  const before = getDebugSignals();
  handleError(new Error(`WITNESS-S7 retrying ${LIVE_KEY} then ${LIVE_KEY}`), { module: "test", operation: "probe" });
  const msg = sink.events[0]!.message;
  const after = getDebugSignals();

  assert.ok(msg.includes("WITNESS-S7"), "witness: reading the emitted message, not the context");
  assert.equal(msg.split("[REDACTED]").length - 1, 2, "witness: both occurrences masked at the 80-call-site door");
  assert.equal(after.redactedValues - before.redactedValues, 0, "no false success on the message channel either");
  assert.equal(after.maskedWithoutRemoval - before.maskedWithoutRemoval, 1, "counted honestly");
  resetDebugSystem();
});

test("debug-system: debugLog's MESSAGE channel is redacted like its context and counted", () => {
  // `handleError` and `reportAlwaysOn` redacted their message; `debugLog`
  // passed it through verbatim, so a credential interpolated into the
  // message reached the sink raw while the same value in the context was
  // masked. One redactor, three channels.
  const sink = setup();
  const before = getDebugSignals();
  debugLog("test", "error", `WITNESS-S8 retrying ${LIVE_KEY} then ${LIVE_KEY}`);
  const msg = sink.events[0]!.message;
  const after = getDebugSignals();

  assert.ok(msg.includes("WITNESS-S8"), "witness: reading the emitted message, not a context value");
  assert.equal(msg.split("[REDACTED]").length - 1, 2, "both occurrences masked in the message");
  assert.equal(msg.split(LIVE_KEY).length - 1, 0, "no copy of the key survives");
  assert.equal(after.redactedValues - before.redactedValues, 0, "a format catalogue is not a removal claim");
  assert.equal(after.maskedWithoutRemoval - before.maskedWithoutRemoval, 1, "the redaction is counted");
  resetDebugSystem();
});

/**
 * ── THE REMOVAL IS NO LONGER GATED ON THE VALUE'S SHAPE ───────────────────
 *
 * The comment on the key-name branch promised the value was discarded
 * "whatever it looks like (defence in depth)", and the branch was gated on
 * `typeof v === "string"`. Every row below was DRIVEN against the parent commit
 * with the secret arriving at the sink intact.
 *
 * These are Node's own header shapes: `IncomingHttpHeaders` types a repeated
 * header as `string[]`, and `set-cookie` is ALWAYS `string[]`.
 *
 * Each absence assertion carries a §36 witness in the SAME emitted context, so
 * an assertion pointed at the wrong field fails rather than passes.
 */
const HEADER_SECRET = "Zq7Kd2Mn8Rt4Wv6Yb1Xc3Fg5Hj9Ll0Pp";

test("debug-system: an ARRAY under a sensitive key name is dropped WHOLE (was: content-masked, secret intact)", () => {
  const sink = setup();
  const before = getDebugSignals();
  debugLog("test", "error", "msg", () => ({
    headers: { authorization: [`Bearer ${HEADER_SECRET}`], accept: "WITNESS-A1-application/json" },
  }));
  const ctx = sink.events[0]!.context;
  const headers = ctx.headers as Record<string, unknown>;
  const after = getDebugSignals();

  assert.equal(headers.accept, "WITNESS-A1-application/json", "witness: the sibling header proves this is the object under test");
  assert.equal(headers.authorization, "[REDACTED]", "the whole array is replaced by a constant, not recursed into");
  assert.ok(!JSON.stringify(ctx).includes(HEADER_SECRET), "no fragment of the secret is anywhere in the context");
  assert.equal(after.redactedValues - before.redactedValues, 1, "one VALUE dropped, counted once");
  assert.equal(after.maskedWithoutRemoval - before.maskedWithoutRemoval, 0, "and not reported as a mere mask");
  resetDebugSystem();
});

test("debug-system: a NESTED OBJECT under a sensitive key name is dropped WHOLE", () => {
  const sink = setup();
  const before = getDebugSignals();
  debugLog("test", "error", "msg", () => ({ apiKey: { v: HEADER_SECRET }, note: "WITNESS-A2 kept" }));
  const ctx = sink.events[0]!.context;
  const after = getDebugSignals();

  assert.equal(ctx.note, "WITNESS-A2 kept", "witness: a non-sensitive sibling is untouched");
  assert.equal(ctx.apiKey, "[REDACTED]", "the object is discarded, not walked into");
  assert.ok(!JSON.stringify(ctx).includes(HEADER_SECRET), "no fragment of the secret survives");
  assert.equal(after.redactedValues - before.redactedValues, 1, "counted once");
  resetDebugSystem();
});

test("debug-system: a NON-STRING SCALAR under a sensitive key name is dropped WHOLE", () => {
  const sink = setup();
  const before = getDebugSignals();
  debugLog("test", "error", "msg", () => ({ password: 12345678901234, note: "WITNESS-A3 kept" }));
  const ctx = sink.events[0]!.context;
  const after = getDebugSignals();

  assert.equal(ctx.note, "WITNESS-A3 kept", "witness: reading the emitted context");
  assert.equal(ctx.password, "[REDACTED]", "a number under a sensitive key is discarded too — 'whatever it looks like'");
  assert.ok(!JSON.stringify(ctx).includes("12345678901234"), "the digits are gone");
  assert.equal(after.redactedValues - before.redactedValues, 1, "counted once");
  resetDebugSystem();
});

test("debug-system: THE FORMER STATED LIMIT — `set-cookie` IS a sensitive key name now, in every casing", () => {
  // ⚠ THIS TEST RECORDED A LEAK. IT NOW RECORDS ITS CLOSURE, AND THE REASON IS
  // STRUCTURAL RATHER THAN A LONGER LIST.
  //
  // It used to assert that `set-cookie` survived byte-identical, because it
  // matched none of the eight configured `forbiddenPatterns` — and the note
  // said the limit was "the LIST, and the list lives in
  // `bridlewise.config.json`". That diagnosis was right and the remedy was
  // too small. Adding `[Ss]et-[Cc]ookie` to the list would have closed this one
  // name and left the mechanism — a hand-maintained list of hand-case-folded
  // regexes — intact, which is §31b exactly.
  //
  // The gate now asks `isSensitiveKeyName` in `src/secret-signals.ts`, the
  // declared single owner of that question for both repositories. It
  // normalises before comparing, so `set-cookie` → `setcookie`, which contains
  // `cookie`, which is in `SENSITIVE_KEY_PARTS`. The config file no longer
  // carries patterns at all.
  //
  // THE CASING ROW IS THE FATAL, PINNED. `Set-Cookie` and `SET_COOKIE` must
  // behave IDENTICALLY to `set-cookie`. Under the old mechanism a
  // first-letter-only fold like `[Ss]et-[Cc]ookie` would have passed the first
  // two and let `SET_COOKIE` through — so these rows are not redundant, they
  // are the regression test for the defect that mattered most.
  for (const name of ["set-cookie", "Set-Cookie", "SET_COOKIE", "setCookie"]) {
    const sink = setup();
    const before = getDebugSignals();
    debugLog("test", "error", "msg", () => ({
      headers: { [name]: [`session=${HEADER_SECRET}`], accept: "WITNESS-A4-text/html" },
    }));
    const headers = sink.events[0]!.context.headers as Record<string, unknown>;
    const after = getDebugSignals();

    assert.equal(headers.accept, "WITNESS-A4-text/html", `witness: the redactor really ran over this object (${name})`);
    assert.equal(headers[name], "[REDACTED]", `${name} is dropped whole — the former stated limit, closed`);
    assert.ok(!JSON.stringify(headers).includes(HEADER_SECRET), `no fragment of the cookie survives (${name})`);
    assert.equal(after.redactedValues - before.redactedValues, 1, `counted once (${name})`);
    resetDebugSystem();
  }

  // THE PAIRING, KEPT: same shape, same value, a name that was ALWAYS covered.
  // It is what distinguishes "the policy widened" from "the instrument broke
  // and now reports everything as redacted".
  const sink2 = setup();
  debugLog("test", "error", "msg", () => ({
    headers: { authorization: [`session=${HEADER_SECRET}`], accept: "WITNESS-A4b" },
  }));
  const headers2 = sink2.events[0]!.context.headers as Record<string, unknown>;
  assert.equal(headers2.accept, "WITNESS-A4b", "witness: reading the paired object");
  assert.equal(headers2.authorization, "[REDACTED]", "the SAME array under an always-covered name is still dropped");
  resetDebugSystem();

  // THE INERT CONTROL, and it is the one that makes the four rows above mean
  // something: a header name that is NOT a credential must still come through
  // untouched. Without it, a redactor that replaced every value with
  // "[REDACTED]" would pass every assertion in this test.
  const sink3 = setup();
  const beforeInert = getDebugSignals();
  debugLog("test", "error", "msg", () => ({
    headers: { accept: "WITNESS-A4c-text/html", "content-length": "1234" },
  }));
  const headers3 = sink3.events[0]!.context.headers as Record<string, unknown>;
  const afterInert = getDebugSignals();
  assert.equal(headers3.accept, "WITNESS-A4c-text/html", "an innocuous header survives verbatim");
  assert.equal(headers3["content-length"], "1234", "and so does a second one");
  assert.equal(afterInert.redactedValues - beforeInert.redactedValues, 0, "an inert payload moves no counter");
  resetDebugSystem();
});

/**
 * ── THE COUNTER'S UNIT ────────────────────────────────────────────────────
 *
 * `redactedValues` was incremented once per EVENT in which anything was
 * removed, while describing itself as a success claim. Per event that claim was
 * false — driven with `{ apiKey: "drop-me", creds: <SECRET> }` scoring +1 with
 * the secret intact. It now counts VALUES, which is what its name says and the
 * only thing this code can know.
 */
test("debug-system: redactedValues counts VALUES, not EVENTS — two sensitive keys in one event count TWO", () => {
  const sink = setup();
  const before = getDebugSignals();
  debugLog("test", "error", "msg", () => ({ apiKey: LIVE_KEY, token: LIVE_KEY, note: "WITNESS-U1 kept" }));
  const ctx = sink.events[0]!.context;
  const after = getDebugSignals();

  assert.equal(ctx.note, "WITNESS-U1 kept", "witness: reading the emitted context");
  assert.equal(ctx.apiKey, "[REDACTED]");
  assert.equal(ctx.token, "[REDACTED]");
  assert.equal(after.debugCount - before.debugCount, 1, "witness: this really is ONE event");
  assert.equal(
    after.redactedValues - before.redactedValues, 2,
    "TWO values were dropped in ONE event, so the counter reads 2 — a per-event counter would read 1",
  );
  resetDebugSystem();
});

test("debug-system: maskedWithoutRemoval counts PATTERN HITS, not events", () => {
  const sink = setup();
  const before = getDebugSignals();
  debugLog("test", "error", "msg", () => ({ detail: "WITNESS-U2 credential rejected and password refused" }));
  const out = String(sink.events[0]!.context.detail);
  const after = getDebugSignals();

  assert.ok(out.includes("WITNESS-U2"), "witness: reading the right string");
  assert.equal(out.split("[REDACTED]").length - 1, 2, "witness: two distinct patterns really fired");
  assert.equal(after.debugCount - before.debugCount, 1, "witness: one event");
  assert.equal(after.maskedWithoutRemoval - before.maskedWithoutRemoval, 2, "two hits, so the counter reads 2");
  resetDebugSystem();
});

test("debug-system: a positive redactedValues is NOT a verdict on the event — a sibling secret still survives", () => {
  // The four shapes that scored a per-EVENT success while leaking. They are kept
  // as an explicit statement of what the counter does and does not mean: it is
  // a count of what this code dropped, never a claim about what remains.
  const sink = setup();
  const before = getDebugSignals();
  debugLog("test", "error", "msg", () => ({ apiKey: "drop-me", creds: HEADER_SECRET, note: "WITNESS-U3" }));
  const ctx = sink.events[0]!.context;
  const after = getDebugSignals();

  assert.equal(ctx.note, "WITNESS-U3", "witness: reading the emitted context");
  assert.equal(ctx.apiKey, "[REDACTED]", "the value under the sensitive name was dropped");
  assert.equal(ctx.creds, HEADER_SECRET, "and `creds` is not a name the list contains, so the secret survives");
  assert.equal(after.redactedValues - before.redactedValues, 1, "the count is 1 — exactly one value was dropped, which is true");
  resetDebugSystem();
});

test("debug-system: INERT control for the unit change — nothing matched still leaves BOTH counters at zero", () => {
  // `+= n` must not become `+= 1`, and a payload with no sensitive key must not
  // acquire a signal from the arithmetic. Inert BY CONSTRUCTION: no key and no
  // content in this payload matches any configured pattern.
  const sink = setup();
  const before = getDebugSignals();
  debugLog("test", "error", "msg", () => ({ alpha: "WITNESS-U4 plain", beta: [1, 2, 3], gamma: { delta: "ok" } }));
  const ctx = sink.events[0]!.context;
  const after = getDebugSignals();

  assert.deepEqual(ctx, { alpha: "WITNESS-U4 plain", beta: [1, 2, 3], gamma: { delta: "ok" } }, "witness: byte-identical through the redactor");
  assert.equal(after.debugCount - before.debugCount, 1, "witness: an event WAS emitted");
  assert.equal(after.redactedValues - before.redactedValues, 0, "no success invented out of nothing");
  assert.equal(after.maskedWithoutRemoval - before.maskedWithoutRemoval, 0, "and nothing claimed as masked");
  resetDebugSystem();
});

test("debug-system: redaction redacts nested objects and arrays", () => {
  const sink = setup();
  debugLog("test", "info", "msg", () => ({
    nested: { password: "secret123", safe: "ok" },
    arr: [{ token: "tok", x: 1 }],
  }));
  const ctx = sink.events[0]!.context;
  const nested = ctx.nested as Record<string, unknown>;
  const arr = ctx.arr as Array<Record<string, unknown>>;
  assert.ok(String(nested.password).includes("[REDACTED]"));
  assert.equal(nested.safe, "ok");
  assert.ok(String(arr[0]!.token).includes("[REDACTED]"));
  assert.equal(arr[0]!.x, 1);
  resetDebugSystem();
});

test("debug-system: wouldEmit returns false when disabled", () => {
  configureDebugSystem(testConfig({ enabled: false }), [createCollectingSink()]);
  assert.equal(wouldEmit("test", "debug"), false);
  resetDebugSystem();
});

test("debug-system: wouldEmit returns true when enabled + level + category match", () => {
  configureDebugSystem(testConfig({ enabled: true, level: "debug", categories: ["cat"] }), [createCollectingSink()]);
  assert.equal(wouldEmit("cat", "debug"), true);
  assert.equal(wouldEmit("cat", "trace"), false, "trace above debug floor");
  assert.equal(wouldEmit("other", "debug"), false, "wrong category");
  resetDebugSystem();
});

test("debug-system: console sink writes to stderr without throwing", () => {
  configureDebugSystem(testConfig({ enabled: true, level: "info", categories: ["test"] }), [createConsoleSink()]);
  // Capture would require intercepting stderr; just verify no throw.
  assert.doesNotThrow(() => debugLog("test", "info", "console test", () => ({ x: 1 })));
  resetDebugSystem();
});

test("debug-system: sink failure does not crash the caller (anti-recursion guard)", () => {
  // The failure is driven through a REAL sink whose real destination fails —
  // the shape this actually takes in production (a closed stderr, EPIPE) —
  // because a hand-written `{ kind: "broken", write() { throw } }` is no longer
  // constructible: the door refuses any sink this module did not build. The
  // property under test is unchanged; only the way the failure is produced is.
  configureDebugSystem(testConfig({ enabled: true, level: "info", categories: ["test"] }), [createConsoleSink()]);
  const realWrite = process.stderr.write.bind(process.stderr);
  let attempted = 0;
  (process.stderr as unknown as { write: unknown }).write = (): boolean => {
    attempted++;
    throw new Error("EPIPE: the destination went away");
  };
  try {
    assert.doesNotThrow(() => debugLog("test", "info", "msg"), "a failing sink must not crash the caller");
  } finally {
    (process.stderr as unknown as { write: unknown }).write = realWrite;
  }
  // Measured 2, not 1: the sink's own write, plus the terminal fallback reporting the
  // failure through `console.warn`, which is also stderr — and Node's global
  // console swallows a stream write error, which is why that second throw does
  // not reach the caller either. The floor is the assertion; the count is the
  // observation.
  assert.ok(attempted >= 1, "witness: the sink really was invoked and really did throw");
  assert.equal(getDebugSignals().sinkWriteAttempts, 1);
  assert.equal(getDebugSignals().sinkWriteFailures, 1);
  assert.equal(getDebugSignals().fallbackAttempts, 1);
  assert.equal(getDebugSignals().fallbackFailures, 0, "Node console swallowed the synchronous stream failure; this is not delivery success");
  resetDebugSystem();
});

test("debug-system: redactDiagnosticText masks a credential in free text even with no sink configured", () => {
  resetDebugSystem();
  const bearer = ["Bearer", "abcdefghijklmnopqrstuvwxyz0123456789ABCD"].join(" ");
  const redacted = redactDiagnosticText(`request failed: Authorization: ${bearer}`);
  assert.equal(redacted.includes("abcdefghijklmnopqrstuvwxyz0123456789ABCD"), false, redacted);
  assert.equal(redactDiagnosticText("plain words stay"), "plain words stay");
});

test("debug-system: reportAlwaysOn is ONE record — one event through the sinks when configured (even with debug off), one redacted stderr line otherwise (SCALE-CR1-FIX M1)", () => {
  const bearer = ["Bearer", "abcdefghijklmnopqrstuvwxyz0123456789ABCD"].join(" ");
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => { lines.push(String(chunk)); return true; };
  try {
    const sink = setup({ enabled: false });
    reportAlwaysOn("process", `callback fault in probe: ${bearer}`, { role: "cli" });
    assert.equal(sink.events.length, 1, "configured: one event through the sinks, though debug is off");
    assert.equal(sink.events[0]!.category, "process");
    assert.equal(sink.events[0]!.message.includes("abcdefghijklmnopqrstuvwxyz0123456789ABCD"), false);
    assert.equal(lines.length, 0, "configured with a sink: nothing printed beside it");
    resetDebugSystem();
    reportAlwaysOn("process", `callback fault in probe: ${bearer}`, { role: "cli" });
    assert.equal(lines.length, 1, "unconfigured: exactly one line");
    assert.match(lines[0]!, /^\[bridlewise process\] callback fault in probe: .* \{"role":"cli"\}\n$/u);
    assert.equal(lines[0]!.includes("abcdefghijklmnopqrstuvwxyz0123456789ABCD"), false, "the line is redacted");
  } finally {
    (process.stderr as { write: unknown }).write = write;
    resetDebugSystem();
  }
});

test("debug-system: hostile — deeply nested context with mixed types redacts recursively", () => {
  const sink = setup();
  debugLog("test", "info", "hostile", () => ({
    level1: { level2: { level3: { secret: "my-secret-value", arr: [{ credential: "sk-x" }] } } },
    nums: [1, 2, { password: "pw" }],
    bool: true,
    nullable: null,
  }));
  const ctx = sink.events[0]!.context;
  const l1 = ctx.level1 as Record<string, unknown>;
  const l2 = l1.level2 as Record<string, unknown>;
  const l3 = l2.level3 as Record<string, unknown>;
  assert.ok(String(l3.secret).includes("[REDACTED]"), "deep secret redacted");
  const l3arr = l3.arr as Array<Record<string, unknown>>;
  assert.ok(String(l3arr[0]!.credential).includes("[REDACTED]"), "deep array credential redacted");
  const nums = ctx.nums as unknown[];
  const numsObj = nums[2] as Record<string, unknown>;
  assert.ok(String(numsObj.password).includes("[REDACTED]"), "array object password redacted");
  assert.equal(ctx.bool, true, "boolean preserved");
  assert.equal(ctx.nullable, null, "null preserved");
  resetDebugSystem();
});

test("debug-system: hostile — concurrent debugLog calls do not corrupt signals (atomic increments)", () => {
  const sink = setup();
  const N = 100;
  for (let i = 0; i < N; i++) {
    debugLog("test", "info", `msg-${i}`, () => ({ i }));
  }
  assert.equal(sink.events.length, N, "all N events collected");
  assert.equal(getDebugSignals().debugCount, N, "all N counted");
  resetDebugSystem();
});

/**
 * ── THE SINK DOOR ────────────────────────────────────────────────────────
 *
 * `configureDebugSystem(config, sinks)` used to accept an arbitrary
 * `ReadonlyArray<DebugSink>` — a bare structural interface with a `write()`
 * method — with no check of any kind. Any importer, in either repository, could
 * install a disk-writing destination for every debug, error and audit event in
 * the process. The allow-list that should have closed it
 * (`config.sinks.enabledSinks`) was declared in the contract, SET in the shipped
 * config, and read by nothing.
 *
 * Each test below closes one way in. The casts are deliberate: TypeScript
 * already refuses these at compile time (a caller cannot name the brand
 * symbol), and the point of the runtime door is that it holds when the compiler
 * is bypassed — which is what a cast IS.
 */
type Sink = import("../../../src/shared/debug/debug-system.ts").DebugSink;

test("sink door: a hand-written object with a write() method is REFUSED", () => {
  const written: string[] = [];
  const forged = { kind: "console", write(e: { message: string }): void { written.push(e.message); } };
  assert.throws(
    () => configureDebugSystem(testConfig({ enabled: true, level: "info", categories: ["test"] }), [forged as unknown as Sink]),
    (err: unknown) => err instanceof Error && /not constructed by the debug system/u.test(err.message),
    "a sink this module did not build must not be installable",
  );
  debugLog("test", "info", "after the refusal");
  assert.equal(written.length, 0, "witness: the forged sink received nothing — the refusal was not cosmetic");
  resetDebugSystem();
});

test("sink door: a SPREAD COPY of a real sink is REFUSED (the documented escape from a brand)", () => {
  // A `unique symbol` brand is copied by an object spread with no cast — driven
  // in this tree before. So the brand alone would have certified this forgery.
  const real = createCollectingSink();
  const written: string[] = [];
  const copy = { ...real, write(e: { message: string }): void { written.push(e.message); } };
  assert.throws(
    () => configureDebugSystem(testConfig({ enabled: true, level: "info", categories: ["test"] }), [copy as unknown as Sink]),
    (err: unknown) => err instanceof Error && /not constructed by the debug system/u.test(err.message),
    "a spread copy is a different object and is not in the sanctioned set",
  );
  debugLog("test", "info", "after the refusal");
  assert.equal(written.length, 0, "witness: the copy received nothing");
  resetDebugSystem();
});

test("sink door: a REAL sink whose kind the config does not enable is REFUSED", () => {
  assert.throws(
    () => configureDebugSystem(
      testConfig({
        enabled: true, level: "info", categories: ["test"],
        sinks: { ...DEBUG_CONFIG_DEFAULTS.sinks, enabledSinks: ["console"] },
      }),
      [createCollectingSink()],
    ),
    (err: unknown) => err instanceof Error && /not in config\.sinks\.enabledSinks/u.test(err.message),
    "the declared allow-list is READ, and it is the thing that decides",
  );
  resetDebugSystem();
});

test("sink door: an EMPTY allow-list installs nothing at all (deny by default)", () => {
  assert.throws(
    () => configureDebugSystem(
      testConfig({
        enabled: true, level: "info", categories: ["test"],
        sinks: { ...DEBUG_CONFIG_DEFAULTS.sinks, enabledSinks: [] },
      }),
      [createConsoleSink()],
    ),
    (err: unknown) => err instanceof Error && /empty/u.test(err.message),
    "an operator who enables no sink gets no sink, and is told so",
  );
  resetDebugSystem();
});

test("sink door: the POSITIVE control — a real sink of an enabled kind IS admitted and DOES receive", () => {
  // Without this, every assertion above would still pass with a door that
  // refuses everything, which is a different bug wearing the same green.
  const sink = createCollectingSink();
  configureDebugSystem(
    testConfig({
      enabled: true, level: "info", categories: ["test"],
      sinks: { ...DEBUG_CONFIG_DEFAULTS.sinks, enabledSinks: ["collecting"] },
    }),
    [sink],
  );
  debugLog("test", "info", "WITNESS-D5 admitted");
  assert.equal(sink.events.length, 1, "the admitted sink received the event");
  assert.equal(sink.events[0]!.message, "WITNESS-D5 admitted");
  resetDebugSystem();
});

test("sink door: a REFUSED sink leaves the previous system exactly as it was", () => {
  const good = createCollectingSink();
  configureDebugSystem(
    testConfig({
      enabled: true, level: "info", categories: ["test"],
      sinks: { ...DEBUG_CONFIG_DEFAULTS.sinks, enabledSinks: ["collecting"] },
    }),
    [good],
  );
  const forged = { kind: "collecting", write(): void {} };
  assert.throws(() => configureDebugSystem(
    testConfig({
      enabled: true, level: "info", categories: ["test"],
      sinks: { ...DEBUG_CONFIG_DEFAULTS.sinks, enabledSinks: ["collecting"] },
    }),
    [good, forged as unknown as Sink],
  ));
  debugLog("test", "info", "WITNESS-D6 still wired");
  assert.equal(good.events.length, 1, "the working sink is still installed — a refusal is not a half-configure");
  assert.equal(good.events[0]!.message, "WITNESS-D6 still wired");
  resetDebugSystem();
});

test("sink door: a sanctioned sink's kind CANNOT be reassigned to smuggle it past the allow-list", () => {
  // `readonly` is a compiler fact; `WeakSet` membership travels with the object.
  // Without the freeze, a holder of a real console sink could rename it and
  // carry its sanction onto a kind it was never admitted under.
  const real = createConsoleSink();
  assert.throws(
    () => { (real as unknown as { kind: string }).kind = "file"; },
    TypeError,
    "the engine refuses the assignment — this is not enforced by convention",
  );
  assert.equal(real.kind, "console", "witness: the kind is unchanged");
  // The `debug_sink_unimplemented` refusal in `admitSinks` is therefore
  // UNREACHABLE while the compiler and this freeze both hold. That is the
  // correct outcome, not a coverage gap: the total `SINK_IMPLEMENTATIONS`
  // record is doing the work, and the runtime branch is a backstop for a tree
  // that no longer type-checks.
  resetDebugSystem();
});

// ── Test helper: a side-effect counter to prove the thunk is NOT evaluated ─
let sideEffectCallCount = 0;
function sideEffect(): number {
  sideEffectCallCount++;
  return 42;
}

// ═════════════════════════════════════════════════════════════════════════
// ★ THE FATAL: THE PATTERNS WERE CASE-SENSITIVE PAST THE FIRST LETTER
// ═════════════════════════════════════════════════════════════════════════

/**
 * ⚠ THE CANARY IS INERT BY CONSTRUCTION, AND THAT IS NOT A DETAIL.
 *
 * The obvious canary for this layer is a realistic key like
 * `sk-LIVEKEY-8f31c05a…`. IT IS THE WRONG ONE, and using it produced a
 * completely false reading during this work: `sk-…` matches the content
 * channel ITSELF, so the string is PARTIALLY masked, and a scan for the whole
 * canary then reports "absent" while 40 of its 43 characters are sitting in
 * the payload. Every survivor looked dropped and the FATAL looked fixed.
 *
 * This value matches no key-name part and no value-format signal, so any
 * change to it is attributable to the KEY it was filed under and nothing else.
 * `assertCanaryInert` below proves that in the same run rather than asserting
 * it in a comment.
 */
const CASE_CANARY = "Z9QF4T7X2M8B6N1V5C3K0LJHGDWERUY";
const CASE_WITNESS = "WITNESS-CASE-INNOCUOUS-7712";

/**
 * Drive one key name and report what reached the sink.
 *
 * §36: the witness is asserted PRESENT on every call, so a probe pointed at
 * the wrong field fails loudly instead of reporting a comfortable absence.
 */
function driveKeyName(key: string, overrides: Partial<DebugConfig> = {}): {
  survives: boolean; removed: number; masked: number;
} {
  const sink = setup(overrides);
  const before = getDebugSignals();
  debugLog("test", "error", "msg", () => ({ [key]: CASE_CANARY, note: CASE_WITNESS }));
  const ctx = sink.events[0]!.context;
  const after = getDebugSignals();
  assert.equal(ctx.note, CASE_WITNESS, `witness: the emitted context really was read (key ${key})`);
  const survives = JSON.stringify(ctx).includes(CASE_CANARY);
  resetDebugSystem();
  return {
    survives,
    removed: after.redactedValues - before.redactedValues,
    masked: after.maskedWithoutRemoval - before.maskedWithoutRemoval,
  };
}

test("debug-system: the canary used by the casing tests is INERT — the instrument is proved before it is trusted", () => {
  const r = driveKeyName("plainNothingSensitive");
  assert.ok(r.survives, "the canary must survive verbatim under a NON-sensitive key, or every 'dropped' below is unattributable");
  assert.equal(r.masked, 0, "and no content pattern may fire on it — a partial mask reads as absence to a whole-string scan");
  assert.equal(r.removed, 0, "and it moves no counter");
});

test("★ THE FATAL: every SCREAMING_SNAKE credential key name is dropped, driven one per key", () => {
  // DRIVEN AT THE PARENT COMMIT, all fourteen reached the sink VERBATIM with
  // redactedValues=+0 AND maskedWithoutRemoval=+0 — a payload carrying a live
  // credential and reading exactly like an empty one. `[Ss]ecret` cannot match
  // `SECRET`: the shipped patterns hand-folded the FIRST LETTER ONLY, and a
  // `process.env` snapshot is the commonest debug payload there is.
  //
  // These fourteen are the names driven in that measurement. `SK_` joined the
  // covered set when the owner's `SENSITIVE_KEY_PATTERNS` gained the
  // separator-bounded `sk-`/`sk_` prefix; `DATABASE_URL` is NOT expected to
  // be caught and is asserted as a survivor below rather than omitted — see
  // the residual test.
  const covered = [
    "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "API_KEY", "STRIPE_SECRET_KEY",
    "OPENAI_API_KEY", "APIKEY", "TOKEN", "PASSWORD", "SECRET",
    "AUTHORIZATION", "CREDENTIAL", "BEARER", "SK_",
  ];
  const leaked: string[] = [];
  for (const key of covered) {
    const r = driveKeyName(key);
    if (r.survives) leaked.push(key);
    else assert.equal(r.removed, 1, `${key}: dropped whole, counted once`);
  }
  assert.deepEqual(leaked, [], "no SCREAMING_SNAKE credential key name reaches the sink");
});

test("★ THE FATAL, at the mechanism: a key's CASING cannot change the verdict — shape-invariance", () => {
  // ⚠ THIS IS THE TEST THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT, and the
  // one that keeps catching it. A longer list of patterns passes the test
  // above and FAILS this one the moment any entry is written `[Ss]ecret`
  // instead of being matched case-insensitively.
  //
  // It also correctly reports the RESIDUAL name: `DATABASE_URL` survives in
  // BOTH casings, which is what proves the residual is a VOCABULARY gap and
  // not the casing defect coming back. A casing regression makes a pair
  // DISAGREE — including the `SK_`/`sk_` pair, which must now agree on
  // "dropped" rather than on "survives".
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["API_KEY", "api_key"], ["SECRET", "secret"], ["TOKEN", "token"],
    ["PASSWORD", "password"], ["AUTHORIZATION", "authorization"],
    ["SET_COOKIE", "set_cookie"], ["PRIVATE_KEY", "private_key"],
    ["DATABASE_URL", "database_url"], ["SK_", "sk_"],
  ];
  for (const [upper, lower] of pairs) {
    const u = driveKeyName(upper);
    const l = driveKeyName(lower);
    assert.equal(
      u.survives, l.survives,
      `${upper} and ${lower} must reach the same verdict — a disagreement IS the case-sensitivity defect`,
    );
    assert.equal(u.removed, l.removed, `${upper}/${lower}: and the counters must agree too`);
  }
});

test("debug-system: THE RESIDUAL, measured and named — the vocabulary's gap, not the matcher's", () => {
  // ⚠ FILED, NOT FAKED, and deliberately NOT papered over from this repo's
  // config. `DATABASE_URL` normalises to `databaseurl`, which contains no
  // member of `SENSITIVE_KEY_PARTS`. (`SK_` used to sit beside it here; it is
  // covered now that the owner's `SENSITIVE_KEY_PATTERNS` carries the
  // separator-bounded `sk-`/`sk_` prefix — asserted in the FATAL test above.)
  //
  // The fix belongs in `src/secret-signals.ts`, which is the SINGLE OWNER of
  // this question for the harness classifier, the web server's redactor AND
  // the web server's config-write gate. Adding the name to
  // `bridlewise.config.json` instead would close this sink and leave the
  // other three open — which is precisely the two-owners-of-one-fact drift
  // that `secret-signals.ts` was created to end, and which once left
  // `authorization` writable through the web API while the harness classified
  // it a secret. One addition there serves four consumers; one addition here
  // serves one and hides the gap from the other three. `databaseurl` is left
  // OPEN rather than added, because the same name is a legitimate, writable
  // configurable (a `databaseUrl` config field), and classifying the NAME
  // sensitive would make the web write gate refuse it — that trade belongs to
  // the write gate's owner, not to this test.
  //
  // Pinned so the residual is a recorded fact with a measurement, and so that
  // widening the owner's vocabulary REDS this test and forces the note to be
  // rewritten in the same commit rather than silently drifting.
  for (const key of ["DATABASE_URL"]) {
    const r = driveKeyName(key);
    assert.ok(r.survives, `${key} still survives — the residual, stated`);
    assert.equal(r.removed, 0, `${key}: and the counter honestly reads 0 rather than claiming a drop`);
  }
});

test("debug-system: emptying `additionalSensitiveKeyNames` CANNOT disable the control", () => {
  // The cross-repo attack that landed at the parent commit was a caller
  // passing `forbiddenPatterns: []`, which removed the entire policy because
  // the config WAS the policy. The vocabulary is now code-owned and this field
  // only ADDS to it, so the attack has no target left.
  const shipped = driveKeyName("API_KEY");
  const emptied = driveKeyName("API_KEY", {
    redaction: { ...DEBUG_CONFIG_DEFAULTS.redaction, additionalSensitiveKeyNames: [] },
  });
  assert.ok(!shipped.survives, "witness: the shipped policy drops it");
  assert.ok(!emptied.survives, "and an emptied config list drops it too — the config cannot switch the control off");
  assert.equal(emptied.removed, 1, "counted identically");
});

test("debug-system: `additionalSensitiveKeyNames` extends the gate, and the CODE owns the casing", () => {
  const without = driveKeyName("DATABASE_URL");
  assert.ok(without.survives, "witness: uncovered without the extension, or the rows below prove nothing");

  const extended = driveKeyName("DATABASE_URL", {
    redaction: { ...DEBUG_CONFIG_DEFAULTS.redaction, additionalSensitiveKeyNames: ["database_url"] },
  });
  assert.ok(!extended.survives, "the extension point works");

  // The name is supplied in a DIFFERENT casing and with a different separator
  // from the key it must match. Under the old mechanism the operator had to
  // hand-fold the case into a regex and got `[Dd]atabase_url`, which misses
  // `DATABASE_URL`. Here the code normalises both sides, so neither the
  // operator's casing nor the key's can matter.
  const oddlyCased = driveKeyName("DATABASE_URL", {
    redaction: { ...DEBUG_CONFIG_DEFAULTS.redaction, additionalSensitiveKeyNames: ["DaTaBaSe Url"] },
  });
  assert.ok(!oddlyCased.survives, "an oddly-cased, oddly-separated NAME still matches — casing is normalised away");
});

// ═════════════════════════════════════════════════════════════════════════
// ★ TOTALITY: A SECURITY CONTROL THAT THROWS IS AN AVAILABILITY DEFECT
// ═════════════════════════════════════════════════════════════════════════

/**
 * `handleError` is installed as the `uncaughtException` handler, so a throw
 * raised inside the redactor is PROCESS-FATAL. DRIVEN at the parent commit,
 * every one of these escaped `debugLog` and `handleError`:
 *
 *   circular         → RangeError: Maximum call stack size exceeded
 *   throwing getter  → Error: getter exploded (verbatim)
 *   60,000-deep nest → RangeError: Maximum call stack size exceeded
 */
test("★ TOTALITY: a CIRCULAR context does not throw, and the cycle is marked rather than dropped", () => {
  const sink = setup();
  debugLog("test", "error", "msg", () => {
    const o: Record<string, unknown> = { note: "WITNESS-T1", child: {} };
    (o.child as Record<string, unknown>).parent = o;
    return o;
  });
  const ctx = sink.events[0]!.context;
  assert.equal(ctx.note, "WITNESS-T1", "witness: the event was emitted and read");
  assert.equal((ctx.child as Record<string, unknown>).parent, "[CIRCULAR]", "the cycle is VISIBLE, not silently blanked");
  resetDebugSystem();
});

test("★ TOTALITY: a REPEATED (non-circular) reference is NOT mistaken for a cycle", () => {
  // The obvious cycle guard is a single global `seen` set, and it is WRONG: a
  // DAG that mentions the same object twice is not a cycle, and a global set
  // silently replaces the second, legitimate reference with `[CIRCULAR]`. The
  // guard is an ANCESTOR set, so only a true back-edge is marked.
  const sink = setup();
  debugLog("test", "error", "msg", () => {
    const shared = { value: "WITNESS-T2-shared" };
    return { note: "WITNESS-T2", a: shared, b: shared };
  });
  const ctx = sink.events[0]!.context;
  assert.equal(ctx.note, "WITNESS-T2", "witness: reading the emitted context");
  assert.deepEqual(ctx.a, { value: "WITNESS-T2-shared" }, "the first reference survives");
  assert.deepEqual(ctx.b, { value: "WITNESS-T2-shared" }, "and so does the SECOND — it is a DAG, not a cycle");
  resetDebugSystem();
});

test("★ TOTALITY: a THROWING GETTER costs one property, not the event", () => {
  const sink = setup();
  debugLog("test", "error", "msg", () => ({
    note: "WITNESS-T3",
    get boom(): string { throw new Error("getter exploded"); },
    after: "WITNESS-T3-after",
  }));
  const ctx = sink.events[0]!.context;
  assert.equal(ctx.note, "WITNESS-T3", "witness: the event survived the hostile getter");
  assert.equal(ctx.boom, "[UNREADABLE]", "the hostile property is marked");
  assert.equal(ctx.after, "WITNESS-T3-after", "and the property AFTER it is still walked — the blast radius is one field");
  resetDebugSystem();
});

test("★ TOTALITY: a getter under a SENSITIVE key is not even read", () => {
  // The key gate decides on the NAME alone, so a hostile accessor under a
  // sensitive name cannot run at all. This is the value-shape independence
  // property, extended to side effects.
  let reads = 0;
  const sink = setup();
  debugLog("test", "error", "msg", () => ({
    note: "WITNESS-T4",
    get password(): string { reads++; throw new Error("must never run"); },
  }));
  const ctx = sink.events[0]!.context;
  assert.equal(ctx.note, "WITNESS-T4", "witness: reading the emitted context");
  assert.equal(ctx.password, "[REDACTED]", "dropped by name");
  assert.equal(reads, 0, "and the getter was NEVER INVOKED — the decision never needed the value");
  resetDebugSystem();
});

test("★ TOTALITY: a very deep nest is bounded rather than fatal", () => {
  const sink = setup();
  debugLog("test", "error", "msg", () => {
    let o: Record<string, unknown> = { bottom: "WITNESS-T5-bottom" };
    for (let i = 0; i < 60_000; i++) o = { n: o };
    return { note: "WITNESS-T5", deep: o };
  });
  const ctx = sink.events[0]!.context;
  assert.equal(ctx.note, "WITNESS-T5", "witness: the event was emitted at all");
  // Walk to the marker and prove the bound is the CONFIGURED one, not luck.
  let cursor: unknown = ctx.deep;
  let depth = 0;
  while (cursor !== null && typeof cursor === "object" && "n" in (cursor as object)) {
    cursor = (cursor as Record<string, unknown>).n;
    depth++;
  }
  assert.equal(cursor, "[DEPTH-LIMIT]", "the walk stops with a VISIBLE marker rather than a silent truncation");
  assert.ok(depth < 60_000, `witness: the walk really was cut short (stopped after ${depth} levels)`);
  resetDebugSystem();
});

test("★ TOTALITY: `handleError` — the uncaughtException path — survives all three shapes", () => {
  // This is the one that was PROCESS-FATAL: a throw from the redactor inside
  // the handler installed for uncaught exceptions takes the process down while
  // it is trying to report a failure.
  const sink = setup();
  const circular: Record<string, unknown> = { module: "m", operation: "o" };
  circular.self = circular;
  handleError(new InputError("boom"), circular as unknown as { module: string; operation: string });
  handleError(new InputError("boom"), {
    module: "m", operation: "o",
    get hostile(): string { throw new Error("getter exploded"); },
  });
  assert.equal(sink.events.length, 2, "both calls emitted instead of throwing");
  resetDebugSystem();
});

// ═════════════════════════════════════════════════════════════════════════
// ★ PRESERVED-BUT-REDACTED: THE SILENT TOTAL DATA LOSS
// ═════════════════════════════════════════════════════════════════════════

test("★ Map/Set/Date/Error/Symbol reach the sink REDACTED instead of as `{}`", () => {
  // DRIVEN at the parent commit: every one of these serialised to `{}`. An
  // `Error` in a debug payload became an empty object — safe, and the least
  // useful thing a debugger can be handed.
  const sink = setup();
  debugLog("test", "error", "msg", () => ({
    note: "WITNESS-P1",
    map: new Map<string, unknown>([["visible", "WITNESS-P1-map"], ["password", HEADER_SECRET]]),
    set: new Set(["WITNESS-P1-set"]),
    date: new Date(0),
    err: new Error("WITNESS-P1-errmessage"),
  }));
  const ctx = sink.events[0]!.context;
  assert.equal(ctx.note, "WITNESS-P1", "witness: reading the emitted context");

  const map = ctx.map as Record<string, unknown>;
  assert.equal(map.visible, "WITNESS-P1-map", "a Map's payload survives");
  assert.equal(map.password, "[REDACTED]", "and the KEY GATE applies inside a Map, exactly as in an object");
  assert.ok(!JSON.stringify(ctx).includes(HEADER_SECRET), "no fragment of the secret survives the Map");

  assert.deepEqual(ctx.set, ["WITNESS-P1-set"], "a Set's members survive as an array");
  assert.equal(ctx.date, "1970-01-01T00:00:00.000Z", "a Date survives as an ISO string");
  const err = ctx.err as Record<string, unknown>;
  assert.equal(err.name, "Error", "an Error keeps its name");
  assert.equal(err.message, "WITNESS-P1-errmessage", "and its message — the likeliest credential carrier in the payload");
  resetDebugSystem();
});

test("★ a Symbol value no longer reaches the sink with its description intact", () => {
  // Driven at the parent commit: a Symbol fell through the redactor untouched
  // and its description was readable at `$.context.sym`. Narrow, but a channel.
  const sink = setup();
  debugLog("test", "error", "msg", () => ({ note: "WITNESS-P2", sym: Symbol("password: leaked-in-a-symbol") }));
  const ctx = sink.events[0]!.context;
  assert.equal(ctx.note, "WITNESS-P2", "witness: reading the emitted context");
  assert.equal(typeof ctx.sym, "string", "the symbol is stringified rather than passed through by reference");
  assert.ok(String(ctx.sym).includes("[REDACTED]"), "and its description goes through the same content channel as any string");
  resetDebugSystem();
});

test("★ a FUNCTION value is replaced rather than passed through by reference", () => {
  // A closure can hold a credential in a scope no walk can enter, so there is
  // nothing honest to redact — and the reference used to reach non-serialising
  // sinks intact.
  const sink = setup();
  const secret = HEADER_SECRET;
  debugLog("test", "error", "msg", () => ({ note: "WITNESS-P3", fn: () => secret }));
  const ctx = sink.events[0]!.context;
  assert.equal(ctx.note, "WITNESS-P3", "witness: reading the emitted context");
  assert.equal(ctx.fn, "[FUNCTION]", "the reference does not reach the sink");
  resetDebugSystem();
});

test("★ INERT CONTROL for the totality work — an ordinary payload is untouched", () => {
  // Every mechanism added above writes a marker into the output. This is the
  // control that proves none of them fires on a normal payload: a redactor
  // that stamped `[CIRCULAR]`, `[DEPTH-LIMIT]` or `[UNREADABLE]` anywhere it
  // pleased would pass every assertion in this section.
  const sink = setup();
  const before = getDebugSignals();
  const payload = { note: "WITNESS-P4", nested: { a: [1, 2, { b: "plain" }], c: true, d: null } };
  debugLog("test", "error", "msg", () => payload);
  const ctx = sink.events[0]!.context;
  const after = getDebugSignals();
  assert.deepEqual(ctx, payload, "an ordinary payload comes through byte-identical");
  const serialised = JSON.stringify(ctx);
  for (const marker of ["[CIRCULAR]", "[DEPTH-LIMIT]", "[UNREADABLE]", "[REDACTED]", "[FUNCTION]"]) {
    assert.ok(!serialised.includes(marker), `no ${marker} marker appears in an inert payload`);
  }
  assert.equal(after.redactedValues - before.redactedValues, 0, "and no counter moves");
  assert.equal(after.maskedWithoutRemoval - before.maskedWithoutRemoval, 0, "neither of them");
  resetDebugSystem();
});

// ═════════════════════════════════════════════════════════════════════════
// ★ THE §0 RUNG: A SINGLE-CASING PATTERN IS NOT REPRESENTABLE
// ═════════════════════════════════════════════════════════════════════════

/**
 * ⚠ THIS IS THE TEST THAT MAKES THE FIX STRUCTURAL RATHER THAN CURRENT.
 *
 * Every other test in this file drives BEHAVIOUR: it shows that `SECRET` is
 * dropped today. None of them stops a future operator from reintroducing the
 * defect, because under the old design the config field was typed "regex
 * source" and `[Ss]ecret` was a PERFECTLY VALID VALUE. The behaviour was
 * fixed; the defect stayed representable.
 *
 * The ladder verdict was therefore taken at the CONFIG SCHEMA, not at the
 * matcher: the field carries NAMES, and the schema refuses anything with regex
 * syntax in it. A pattern that matches only one casing cannot be written down,
 * so it cannot be shipped, so it cannot come back.
 */
function parseWithExtras(names: readonly string[]): unknown {
  return DEBUG_CONFIG_SCHEMA.parse({
    ...DEBUG_CONFIG_DEFAULTS,
    redaction: { ...DEBUG_CONFIG_DEFAULTS.redaction, additionalSensitiveKeyNames: names },
  });
}

test("★ THE RUNG: the shipped `forbiddenPatterns` values are now REFUSED by the schema", () => {
  // These are the eight patterns that were live at the parent commit. Every
  // one of them is a hand-rolled first-letter case fold, and every one is now
  // a config-load failure rather than a silent half-blind matcher.
  const theOldList = [
    "[Aa]uthorization", "[Bb]earer", "[Aa]pi[-_]?[Kk]ey", "[Ss]ecret",
    "[Pp]assword", "[Tt]oken", "[Cc]redential", "[Ss]k[-_]",
  ];
  for (const pattern of theOldList) {
    assert.throws(
      () => parseWithExtras([pattern]),
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        return message.includes("must be a NAME");
      },
      `${pattern} must be refused — it is a regex, and a regex can encode a casing`,
    );
  }
});

test("★ THE RUNG, both directions: a real NAME is accepted", () => {
  // ⚠ THE INERT CONTROL. Without it, a schema that refused EVERYTHING would
  // pass the test above — and a config field nobody can set is not a fix, it
  // is a different outage.
  for (const name of ["database_url", "DATABASE_URL", "DaTaBaSe Url", "x-internal.token", "sessionKey"]) {
    const parsed = parseWithExtras([name]) as { redaction: { additionalSensitiveKeyNames: readonly string[] } };
    assert.deepEqual(
      parsed.redaction.additionalSensitiveKeyNames, [name],
      `${name} is a name and must be accepted, in whatever casing it is written`,
    );
  }
  const empty = parseWithExtras([]) as { redaction: { additionalSensitiveKeyNames: readonly string[] } };
  assert.deepEqual(empty.redaction.additionalSensitiveKeyNames, [], "and the shipped empty list parses");
});

test("★ THE RUNG: `forbiddenPatterns` cannot be smuggled back in under its old name", () => {
  // `DEBUG_CONFIG_SCHEMA` is a `strictObject`, so a config still carrying the
  // old field is a LOUD failure at load rather than a field silently ignored
  // while the operator believes a policy is in force.
  assert.throws(
    () => DEBUG_CONFIG_SCHEMA.parse({
      ...DEBUG_CONFIG_DEFAULTS,
      redaction: { ...DEBUG_CONFIG_DEFAULTS.redaction, forbiddenPatterns: ["[Ss]ecret"] },
    }),
    "an unrecognised redaction key is refused, so a stale config cannot look configured",
  );
});

test("★ THE FATAL, content channel: a credential noun is masked in EVERY casing", () => {
  // ⚠ ADDED BECAUSE A MUTATION SURVIVED. Dropping the `i` flag from the
  // content patterns left the whole suite GREEN — every casing assertion in
  // this file was about the KEY GATE, and the CONTENT channel had the identical
  // defect with nothing watching it. The original FATAL was one list feeding
  // two mechanisms; fixing one and testing one would have left the other
  // half-blind in exactly the same way.
  //
  // `String.prototype.replace` is not case-folding anything here: the `i` comes
  // from `CONTENT_SIGNAL_PATTERNS`, which the code compiles with `giu`
  // unconditionally. Remove it and these rows red.
  for (const noun of ["password", "PASSWORD", "PassWord", "SECRET", "secret", "TOKEN", "AUTHORIZATION"]) {
    const sink = setup();
    const before = getDebugSignals();
    debugLog("test", "error", "msg", () => ({ detail: `WITNESS-CC ${noun} refused` }));
    const out = String(sink.events[0]!.context.detail);
    const after = getDebugSignals();
    assert.ok(out.includes("WITNESS-CC"), `witness: reading the right string (${noun})`);
    assert.ok(out.includes("[REDACTED]"), `${noun}: masked whatever its casing`);
    assert.ok(!out.includes(noun), `${noun}: the noun itself is gone from the text`);
    assert.equal(after.maskedWithoutRemoval - before.maskedWithoutRemoval, 1, `${noun}: counted as a mask, never a removal`);
    assert.equal(after.redactedValues - before.redactedValues, 0, `${noun}: and never as a removal`);
    resetDebugSystem();
  }
});

test("★ content channel INERT control — an innocuous word of the same shape is untouched", () => {
  // Without this, a content channel that masked every word would pass above.
  const sink = setup();
  const before = getDebugSignals();
  const inert = "WITNESS-CC2 the operation completed and the record was written";
  debugLog("test", "error", "msg", () => ({ detail: inert }));
  const after = getDebugSignals();
  assert.equal(String(sink.events[0]!.context.detail), inert, "byte-identical — the redactor ran and changed nothing");
  assert.equal(after.maskedWithoutRemoval - before.maskedWithoutRemoval, 0, "no counter moves");
  resetDebugSystem();
});

test("debug-system: failing real sink keeps healthy sink alive without publishing private exception text", async () => {
  const { channel } = await import("node:diagnostics_channel");
  const notices: unknown[] = [], observed = channel("console.warn");
  const subscriber = (event: unknown) => { notices.push(event); };
  observed.subscribe(subscriber);
  const collector = createCollectingSink();
  configureDebugSystem(testConfig({ enabled: true, level: "info", categories: ["test"] }), [createConsoleSink(), collector]);
  const write = process.stderr.write;
  process.stderr.write = (() => { throw new Error("fixture-secret"); }) as typeof write;
  try { assert.doesNotThrow(() => debugLog("test", "info", "safe event")); }
  finally { process.stderr.write = write; observed.unsubscribe(subscriber); resetDebugSystem(); }
  assert.equal(collector.events.length, 1);
  assert.equal(JSON.stringify(notices).includes("fixture-secret"), false);
});

for (const first of ["console", "collecting"] as const) {
  test(`debug-system: sink failures preserve every healthy destination with ${first} first`, () => {
    const healthy = createCollectingSink(), bad = createCollectingSink();
    bad.events.push = () => { throw "fixture-secret"; };
    const sinks = first === "console" ? [createConsoleSink(), healthy, bad] : [bad, healthy, createConsoleSink()];
    configureDebugSystem(testConfig({ enabled: true, level: "info", categories: ["test"] }), sinks);
    const write = process.stderr.write, warn = console.warn;
    let writes = 0, fallbacks = 0;
    process.stderr.write = (() => { writes++; throw "fixture-secret"; }) as typeof write;
    console.warn = (...args: unknown[]) => { fallbacks++; assert.deepEqual(args, ["[debug] diagnostic unavailable"]); throw "fixture-secret"; };
    try {
      debugLog("test", "info", "first");
      debugLog("test", "info", "second");
      assert.deepEqual(healthy.events.map((event) => event.message), ["first", "second"]);
      assert.equal(writes, 2);
      assert.equal(fallbacks, 2);
      assert.equal(getDebugSignals().sinkWriteAttempts, 6);
      assert.equal(getDebugSignals().sinkWriteFailures, 4);
      assert.equal(getDebugSignals().fallbackAttempts, 2);
      assert.equal(getDebugSignals().fallbackFailures, 2);
    } finally { process.stderr.write = write; console.warn = warn; resetDebugSystem(); }
  });
}

test("debug-system: reporting from a real sink destination is bounded and keeps healthy sinks alive", async () => {
  const { bestEffort } = await import("../../../src/shared/best-effort.ts");
  const healthy = createCollectingSink();
  configureDebugSystem(testConfig({ enabled: true, level: "info", categories: ["test"], errorHandling: { ...DEBUG_CONFIG_DEFAULTS.errorHandling, reportingPolicy: "always" } }), [createConsoleSink(), healthy]);
  const write = process.stderr.write;
  let writes = 0;
  process.stderr.write = (() => {
    writes++;
    if (writes <= 4) bestEffort(() => { throw "fixture-secret"; });
    return true;
  }) as typeof write;
  try {
    debugLog("test", "info", "safe event");
    assert.equal(writes, 2, "one sink write, one terminal fallback");
    assert.deepEqual(healthy.events.map((event) => event.message), ["safe event"]);
    assert.equal(getDebugSignals().emissionReentries, 1);
    assert.equal(getDebugSignals().fallbackAttempts, 1);
    assert.equal(getDebugSignals().fallbackReentries, 1);
  } finally { process.stderr.write = write; resetDebugSystem(); }
});

test("debug-system: zero sampling excludes the zero random endpoint for both central failure reporters", async () => {
  const { reportBestEffortFailure } = await import("../../../src/shared/debug/debug-system.ts");
  const sink = setup({ errorHandling: { ...DEBUG_CONFIG_DEFAULTS.errorHandling, reportingPolicy: "sampled", samplingRate: 0 } });
  const random = Math.random;
  Math.random = () => 0;
  try {
    handleError(new InputError("safe", "safe_fixture"), { module: "test", operation: "sample" });
    reportBestEffortFailure();
    assert.equal(getDebugSignals().errorCount, 2);
    assert.equal(sink.events.length, 0);
    assert.equal(getDebugSignals().fallbackAttempts, 0);
  } finally { Math.random = random; resetDebugSystem(); }
});

test("debug-system: failed content pattern compilation uses one safe terminal fallback", async () => {
  const { spawnSync } = await import("node:child_process");
  const source = `
    const d = await import(${JSON.stringify(new URL("../../../src/shared/debug/debug-system.ts", import.meta.url).href)});
    const { DEBUG_CONFIG_DEFAULTS } = await import(${JSON.stringify(new URL("../../../src/shared/debug/debug-config.ts", import.meta.url).href)});
    const sink = d.createCollectingSink();
    d.configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, enabled: true, level: "info", categories: ["test"], sinks: { enabledSinks: ["collecting"] } }, [sink]);
    const Original = globalThis.RegExp;
    let failures = 0;
    globalThis.RegExp = new Proxy(Original, { construct(target, args) {
      if (args[1] === "giu" && failures < 2) { failures++; throw "fixture-secret"; }
      return Reflect.construct(target, args);
    }});
    d.debugLog("test", "info", "safe", () => ({ value: "safe" }));
    globalThis.RegExp = Original;
    process.stdout.write(JSON.stringify({ failures, signals: d.getDebugSignals(), events: sink.events.length }));
  `;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.failures, 2);
  assert.equal(result.signals.patternCompilationFailures, 2);
  assert.equal(result.signals.fallbackAttempts, 1);
  assert.equal(result.events, 1);
  assert.equal(child.stderr, "[debug] diagnostic unavailable\n");
});
