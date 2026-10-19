// @vitest-environment node
/**
 * PLAIN-LANGUAGE GUARDS — no internal vocabulary in the rendered-string
 * tables that survive the cutover.
 *
 * The binding product rule: "no knowledge at all must be required to use,
 * understand and configure anything." The failure mode: a `sys.` /
 * `legacy.` id, a dotted internal key (`memory.windowSize`), a snake_case
 * token, or project jargon ("exposure", "preimage", "dedup") lands in text
 * a user reads.
 *
 * WHAT THIS FILE GUARDS NOW (recorded at the cutover): the two authored
 * rendered-string tables that survive — the error-message table
 * (`src/data/error-messages.ts`) and the ui-declared action
 * labels/descriptions (`server/schema/ui-declarations.ts`) — both checked
 * BY IMPORT, which no comment or rename can defeat. The old template/script
 * sweeps over the component directories died with those directories; the
 * cockpit's raw-label law lives with its rooms (settings-data
 * labelViolation/optionWords and the room/sheet suites).
 */
import { describe, test, expect } from "vitest";

import { MESSAGE_FOR_CODE } from "../../src/data/error-messages.ts";
import { ACTIONS } from "../../server/schema/ui-declarations.ts";

// ── The jargon denylist. Every entry is justified by an occurrence that
// was actually found on screen during the sweep and rewritten; the guard
// keeps it from coming back. Word-boundary, case-insensitive.
const JARGON: readonly { word: string; why: string }[] = [
  { word: "exposure", why: "registry vocabulary — was the Metrics section header ('Exposure', 'exposure registry')" },
  { word: "customizations?", why: "schema vocabulary — was 'Backend customizations' / 'No customizations available'" },
  { word: "dedup", why: "internal abbreviation — was the 'Dedup / compression' metrics section" },
  { word: "preimage", why: "edit-engine internal — must never name a user-facing concept" },
  { word: "projection", why: "architecture vocabulary, meaningless on screen" },
  { word: "determinis(?:m|tic)", why: "exposure-contract vocabulary" },
  { word: "harness", why: "project codename — was 'the harness config file' in three panels" },
  { word: "LLM", why: "insider abbreviation — was 'LLM called:', 'LLM API endpoint', the 'LLM' section header" },
  { word: "KLOC", why: "insider abbreviation — was 'issues / KLOC' tiles" },
  { word: "stub", why: "developer status word — was 'Roll back to a message (stub)'" },
  { word: "ledger", why: "storage-internals word — was 'Showing all events from the ledger' / 'No timeline events for this ledger'" },
  { word: "loc", why: "insider abbreviation — was '{n} loc' in the file tree rows and the editor file header" },
] as const;

// Internal-key shapes. `sys.` / `legacy.` prefixes are module namespaces;
// dotted-camel is the customization/signal id shape (memory.windowSize);
// snake_case is code vocabulary. "e.g." style prose survives because the
// dotted check requires a camelCase second segment.
const SYS_PREFIX = /\b(?:sys|legacy)\.[A-Za-z]/;
const DOTTED_CAMEL = /\b[A-Za-z][\w-]*\.[a-z][a-z0-9]*[A-Z]\w*\b/;
const SNAKE_CASE = /\b[a-z0-9]+_[a-z0-9]+(?:_[a-z0-9]+)*\b/;

type Violation = { where: string; text: string; rule: string };

/** Full check for a string that is definitely rendered as-is. */
function checkRenderedString(where: string, text: string, out: Violation[]): void {
  if (SYS_PREFIX.test(text)) out.push({ where, text, rule: "sys./legacy. prefix" });
  if (DOTTED_CAMEL.test(text)) out.push({ where, text, rule: "dotted internal key" });
  if (SNAKE_CASE.test(text)) out.push({ where, text, rule: "snake_case token" });
  for (const { word, why } of JARGON) {
    const re = new RegExp(`(?<![\\w-])${word}(?![\\w-])`, "i");
    if (re.test(text)) out.push({ where, text, rule: `jargon "${word}" (${why})` });
  }
}

describe("A. no internal vocabulary in rendered strings", () => {
  test("error-message table values are plain language (checked by import — comment-proof)", () => {
    const violations: Violation[] = [];
    const codes = Object.keys(MESSAGE_FOR_CODE);
    expect(codes.length, "the message table should not be empty").toBeGreaterThan(10);
    for (const code of codes) {
      checkRenderedString(`error-messages[${code}]`, MESSAGE_FOR_CODE[code]!, violations);
    }
    expect(
      violations,
      `internal vocabulary in error messages:\n${violations.map((v) => `  ${v.where}: "${v.text}" — ${v.rule}`).join("\n")}`,
    ).toEqual([]);
  });

  test("ui-declaration labels/descriptions are plain language (checked by import)", () => {
    // (The MENUS loop is gone with the MENUS array itself — actions are the
    // remaining authored rendered strings in ui-declarations.)
    const violations: Violation[] = [];
    for (const a of ACTIONS) {
      checkRenderedString(`action[${a.id}].label`, a.label, violations);
      checkRenderedString(`action[${a.id}].description`, a.description, violations);
    }
    expect(
      violations,
      `internal vocabulary in ui-declarations:\n${violations.map((v) => `  ${v.where}: "${v.text}" — ${v.rule}`).join("\n")}`,
    ).toEqual([]);
  });

  test("the checker itself is alive (a planted violation is caught)", () => {
    // The two tables above can be green because they are clean OR because
    // the checker went blind — this plant separates the two. Each rule is
    // driven with a shape it must catch.
    const out: Violation[] = [];
    checkRenderedString("plant", "set sys.debug to on", out);
    checkRenderedString("plant", "raise memory.windowSize first", out);
    checkRenderedString("plant", "the run_state token", out);
    checkRenderedString("plant", "open the exposure registry", out);
    expect(out.length, "every planted violation shape must be caught").toBeGreaterThanOrEqual(4);
  });
});
