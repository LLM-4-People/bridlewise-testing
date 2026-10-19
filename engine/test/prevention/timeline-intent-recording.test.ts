import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Contract test: provider intent timeline recording.
 *
 * Root cause: `recordIntent` in `src/runtime/interactive-session.ts` called
 * `canonicalHash(payload)` where `payload` was the provider `request`
 * including `signal: AbortSignal`. `AbortSignal` is a non-plain object, so
 * `integrity.ts` threw "Canonical data contains an unsupported object" and
 * every provider intent was dropped from the timeline.
 *
 * Fix: `recordIntent` strips non-serializable fields (specifically `signal`)
 * from the payload before canonicalization.
 *
 * This contract test reads the source and verifies the sanitization step
 * exists. It is deterministic (no runtime, no network, no API keys) and
 * catches a regression where someone re-introduces a direct
 * `canonicalHash(payload)` call without stripping the signal.
 */

const ROOT = process.cwd();
const SESSION_PATH = join(ROOT, "src", "runtime", "interactive-session.ts");

test("recordIntent contract: source contains a non-serializable field stripping step before canonicalHash", () => {
  const source = readFileSync(SESSION_PATH, "utf8");
  // Locate the recordIntent function body.
  const recordIntentStart = source.indexOf("function recordIntent(");
  assert.ok(recordIntentStart !== -1, "recordIntent function must exist in interactive-session.ts");
  // Find the end of the function by scanning for the matching closing brace
  // at the same indentation level as the function declaration.
  const afterStart = source.slice(recordIntentStart);
  // Take a generous slice (2 KiB) to capture the full function body including
  // comments and the helper function that follows it.
  const body = afterStart.slice(0, 2048);
  // The function must NOT call canonicalHash directly on the raw payload.
  // It must go through a sanitization step that strips non-serializable
  // fields (specifically `signal`).
  assert.ok(
    !/canonicalHash\(payload\)/u.test(body),
    "recordIntent must NOT call canonicalHash(payload) directly — the raw payload may contain a non-serializable AbortSignal",
  );
  assert.ok(
    /canonicalHash\(.*[Ss]erializable.*\)/u.test(body) || /canonicalHash\(strip.*\)/u.test(body) || /stripNonSerializable/u.test(body),
    "recordIntent must strip non-serializable fields (e.g. signal) before calling canonicalHash — expected a sanitization step",
  );
});

test("recordIntent contract: a stripNonSerializableFields helper exists and strips `signal`", () => {
  const source = readFileSync(SESSION_PATH, "utf8");
  // The helper (or equivalent inline sanitization) must reference `signal`
  // as the field to strip.
  assert.ok(
    /signal\b/u.test(source),
    "interactive-session.ts must reference `signal` as a non-serializable field to strip",
  );
  // The helper must produce a shallow copy without the signal, not mutate
  // the original (which is frozen).
  assert.ok(
    /const\s*\{[^}]*signal[^}]*\}[^=]*=\s*payload/u.test(source) || /"signal"\s*in\s+record/u.test(source) || /stripNonSerializableFields/u.test(source),
    "interactive-session.ts must destructure or check for `signal` before stripping it from the payload",
  );
});

test("recordIntent contract: canonicalHash is not called on a payload that may carry an AbortSignal (regression guard)", () => {
  // Scan the entire interactive-session.ts for any `canonicalHash(` call
  // that receives a variable which could carry an AbortSignal. The
  // recordIntent function's payload parameter is `unknown` and may include
  // a signal; the recordTerminal function's payload is constructed inline
  // from effectId/outcome (safe). Verify no unsafe call remains.
  const source = readFileSync(SESSION_PATH, "utf8");
  const canonicalHashCalls: string[] = [];
  const callRegex = /canonicalHash\(\s*([^,)]+?)\s*\)/gu;
  let match: RegExpExecArray | null;
  while ((match = callRegex.exec(source)) !== null) {
    canonicalHashCalls.push(match[1]!.trim());
  }
  // Every canonicalHash call argument must NOT be a bare `payload` variable
  // (which could carry an AbortSignal). It must be a sanitized copy, an
  // inline object literal, or a derived variable that excludes the signal.
  for (const arg of canonicalHashCalls) {
    assert.ok(
      arg !== "payload",
      `canonicalHash must not be called with bare \`payload\` (could carry an AbortSignal); found: canonicalHash(${arg})`,
    );
  }
});
