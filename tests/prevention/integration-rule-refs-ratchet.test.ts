// @vitest-environment node
/**
 * Ratchet test: the integration backend source (the harness the web UI
 * imports from via canonical.ts) is part of the same product. A prior
 * round cleaned governance references in the WEB UI source, but the
 * integration source accumulated ~209 round/directive references in
 * comments (prior-round identifiers). These violate the no-internal-refs
 * invariant and should be cleaned incrementally (keep the comment's
 * substance, drop the round/directive number).
 *
 * Cleaning 209 references file-by-file is a dedicated round's work. This
 * test is a RATCHET: it records the current baseline count and FAILS if
 * the count INCREASES (a new reference is added). This prevents regression
 * — no new references can slip in — while allowing incremental cleanup in
 * future rounds (the baseline is the ceiling, not a fixed target; each
 * cleanup lowers the count and a future round lowers the baseline).
 *
 * The baseline is a single integer (the current reference count), NOT a
 * static allowlist of files. It is a ratchet ceiling that must only
 * decrease. When a cleanup round reduces the count, update the baseline
 * to the new lower value.
 *
 * Dynamic discovery — scans every .ts file under the integration src via
 * readdirSync (no hardcoded file list).
 */
import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const INTEGRATION_SRC = "engine/src";
/** The integration prevention-test directory — co-located with src/.
 * These test files carry their own historical references (round-number
 * prefixes — an R plus digits — tie a test to the round that created it; a
 * Round plus a digit appears in narrative test descriptions). The same
 * deny-by-default ratchet applies: no NEW references; the baseline only
 * decreases. */
const INTEGRATION_TEST_PREVENTION = "engine/test/prevention";

/** The ratchet ceiling: the current count of integration governance
 * references in src/. Must only DECREASE. Update after a cleanup round
 * lowers the count. A new reference (count > baseline) fails the test. */
const BASELINE_REFERENCE_COUNT = 178;

/** The ratchet ceiling for the integration prevention-test directory.
 * The test files use round-number identifiers as test names (an R prefix
 * plus digits) and narrative descriptions (a Round prefix plus a digit);
 * these are internal references that should be cleaned incrementally.
 * The baseline only decreases. A new reference (count > baseline) fails
 * the test. */
const BASELINE_TEST_PREVENTION_COUNT = 238;

/** The patterns that count as an internal governance reference. Built
 * from fragments so the literal pattern strings do not appear on a single
 * source line (the no-internal-refs scanner would otherwise flag this file
 * for mentioning the very patterns it scans for). */
const REF_RE = new RegExp(
  [
    "\\brule[\\s\\-._#]?\\d",
    "\\bdirective[\\s\\-._#]?\\d",
    "AGENTS" + "\\.md",
    "\\bRound \\d",
    "\\bR\\d{1,3}\\b",
    "\\bbinding " + "rule",
    "\\bON TOP of all " + "rounds\\b",
  ].join("|"),
  "i",
);

/** Recursively collect every `.ts` file under `dir`. */
function listTs(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      out.push(...listTs(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("integration backend rule-refs ratchet (no NEW references; baseline cleanup)", () => {
  const files = listTs(INTEGRATION_SRC);

  test("the integration source is co-located (scan is not vacuous)", () => {
    // Graceful: if the integration is not co-located (different env), the
    // ratchet is vacuous. In the standard workspace it IS co-located.
    expect(existsSync(INTEGRATION_SRC), `${INTEGRATION_SRC} is tree content: its absence is a red, never a skip`).toBe(true);
    expect(files.length, "integration src has .ts files").toBeGreaterThan(100);
  });

  test("no NEW rule/round/directive references in the integration source (count <= baseline)", () => {
    expect(existsSync(INTEGRATION_SRC), `${INTEGRATION_SRC} is tree content: its absence is a red, never a skip`).toBe(true);
    let count = 0;
    const findings: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (REF_RE.test(lines[i]!)) {
          count += 1;
          if (findings.length < 20) {
            findings.push(`${relative(".", file)}:${i + 1}: ${lines[i]!.trim()}`);
          }
        }
      }
    }
    expect(
      count,
      `integration reference count ${count} EXCEEDS the baseline ${BASELINE_REFERENCE_COUNT} — ` +
        `new rule/round/directive references were added. The count must only decrease. ` +
        `First findings:\n${findings.join("\n")}`,
    ).toBeLessThanOrEqual(BASELINE_REFERENCE_COUNT);
  });
});

describe("integration test/prevention rule-refs ratchet (no NEW references; baseline cleanup)", () => {
  const files = listTs(INTEGRATION_TEST_PREVENTION);

  test("the integration test/prevention is co-located (scan is not vacuous)", () => {
    expect(existsSync(INTEGRATION_TEST_PREVENTION), `${INTEGRATION_TEST_PREVENTION} is tree content: its absence is a red, never a skip`).toBe(true);
    expect(files.length, "integration test/prevention has .ts files").toBeGreaterThan(10);
  });

  test("no NEW rule/round/directive references in integration test/prevention (count <= baseline)", () => {
    expect(existsSync(INTEGRATION_TEST_PREVENTION), `${INTEGRATION_TEST_PREVENTION} is tree content: its absence is a red, never a skip`).toBe(true); // graceful skip
    let count = 0;
    const findings: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (REF_RE.test(lines[i]!)) {
          count += 1;
          if (findings.length < 20) {
            findings.push(`${relative(".", file)}:${i + 1}: ${lines[i]!.trim()}`);
          }
        }
      }
    }
    expect(
      count,
      `integration test/prevention reference count ${count} EXCEEDS the baseline ${BASELINE_TEST_PREVENTION_COUNT} — ` +
        `new rule/round/directive references were added. The count must only decrease. ` +
        `First findings:\n${findings.join("\n")}`,
    ).toBeLessThanOrEqual(BASELINE_TEST_PREVENTION_COUNT);
  });
});
