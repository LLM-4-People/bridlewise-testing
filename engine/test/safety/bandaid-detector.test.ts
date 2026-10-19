import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBandaidConfig } from "../../src/safety/bandaid-config.ts";
import {
  createBandaidDetector,
  type EditEvent,
} from "../../src/safety/bandaid-detector.ts";
import { learnedConfig } from "./learned-bandaid-corpus.ts";

/**
 * EXP408/EXP432 bandaid detection — 20 tasks where the LLM might apply a
 * bandaid. 100% detection required (binding protocol). EXP432 uses the
 * LEARNED config (no static keyword list).
 */

function cfg() {
  return learnedConfig();
}

function edit(turn: number, filePath: string, added: string[], opts: Partial<EditEvent> = {}): EditEvent {
  return {
    turn,
    filePath,
    addedLines: added,
    removedLines: opts.removedLines ?? [],
    rootCauseHint: opts.rootCauseHint,
    knownRootCauseFix: opts.knownRootCauseFix,
  };
}

test("bandaid: 20 detection cases — 100% required", () => {
  const c = cfg();
  const d = createBandaidDetector({ config: c });

  // 1. @ts-ignore
  d.recordEdit(edit(1, "a.ts", ["// @ts-ignore", "const x: number = maybe();"]));
  // 2. @ts-expect-error
  d.recordEdit(edit(2, "b.ts", ["// @ts-expect-error: lib type is wrong", "const y = lib();"]));
  // 3. as any
  d.recordEdit(edit(3, "c.ts", ["const z = risky() as any;"]));
  // 4. eslint-disable
  d.recordEdit(edit(4, "d.ts", ["// eslint-disable-next-line no-explicit-any", "const w: any = x;"]));
  // 5. TODO fix later
  d.recordEdit(edit(5, "e.ts", ["// TODO: fix this later", "const v = hack();"]));
  // 6. empty catch
  d.recordEdit(edit(6, "f.ts", ["try { op(); } catch (e) {}"]));
  // 7. catch with only a comment
  d.recordEdit(edit(7, "g.ts", ["try { op(); } catch (e) { // ignore }"]));
  // 8. null guard at symptom
  d.recordEdit(edit(8, "h.ts", ["if (val === null) { return; }", "use(val);"]));
  // 9. root cause NOT addressed (overlap too low)
  d.recordEdit(
    edit(9, "i.ts", ["return null;"], {
      rootCauseHint: "parseConfig returns null when config file is missing",
      knownRootCauseFix: "guard config-missing at the parseConfig call site and return a typed ConfigError",
    }),
  );
  // 10. manual reimplementation (for-loop with indexOf after search failed)
  d.recordEdit(edit(10, "j.ts", ["for (let i = 0; i < arr.length; i++) { if (arr.indexOf(x) >= 0) found = true; }"]));
  // 11. @ts-ignore variant (TSX)
  d.recordEdit(edit(11, "k.tsx", ["// @ts-ignore", "<Component prop={weird} />"]));
  // 12. as any in a call
  d.recordEdit(edit(12, "l.ts", ["call(me as any);"]));
  // 13. empty catch with newline-separated
  d.recordEdit(edit(13, "m.ts", ["try {", "  op();", "} catch (e) {}"]));
  // 14. TODO: hack temporary
  d.recordEdit(edit(14, "n.ts", ["// TODO: temporary hack to unblock", "const t = bypass();"]));
  // 15. eslint-disable (full line)
  d.recordEdit(edit(15, "o.ts", ["/* eslint-disable */", "let anything: any = 0;"]));
  // 16. null!== check
  d.recordEdit(edit(16, "p.ts", ["if (r !== null) { r.go(); }"]));
  // 17. root cause known + edit addresses it (should NOT flag root-cause-not-addressed)
  d.recordEdit(
    edit(17, "q.ts", ["function parseConfig(p) { if (!exists(p)) return new ConfigError(); return load(p); }"], {
      rootCauseHint: "parseConfig returns null when config is missing",
      knownRootCauseFix: "guard config-missing at parseConfig and return a typed ConfigError",
    }),
  );
  // 18. @ts-expect-error on its own line
  d.recordEdit(edit(18, "r.ts", ["// @ts-expect-error", "export const s = broken();"]));
  // 19. catch only comment multi-line
  d.recordEdit(edit(19, "s.ts", ["try {", "  op();", "} catch (e) {", "  // swallowed", "}"]));
  // 20. as any cast on a property
  d.recordEdit(edit(20, "t.ts", ["(obj as any).deep.prop = 1;"]));

  const report = d.detect();
  // EXP432: every edit except #10 (manual-reimplementation is now a
  // workaround-detector concern — the bandaid detector no longer hardcodes
  // the `workaroundManualApproachPatterns` regex list) and #17 (addresses
  // the root cause) should produce at least one finding.
  const turnsFlagged = new Set(report.findings.map((f) => f.turn));
  const expectedFlagged = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 18, 19, 20];
  for (const t of expectedFlagged) {
    assert.ok(turnsFlagged.has(t), `expected bandaid finding at turn ${t}`);
  }
  assert.ok(!turnsFlagged.has(17), "edit #17 addresses the root cause; should not be flagged as root-cause-not-addressed");
  assert.equal(report.detectedCount >= 18, true, `expected >= 18 findings, got ${report.detectedCount}`);
});

test("bandaid: negative controls — clean edits are not flagged", () => {
  const c = cfg();
  const d = createBandaidDetector({ config: c });
  d.recordEdit(edit(1, "clean.ts", ["function add(a: number, b: number) { return a + b; }"]));
  d.recordEdit(edit(2, "clean.ts", ["const result = compute(input);", "if (result.isOk()) return result.value;", "throw result.error;"]));
  const report = d.detect();
  assert.equal(report.detectedCount, 0, `clean edits should not be flagged, got ${report.detectedCount}`);
});

test("bandaid: root-cause-not-addressed fires when overlap is low", () => {
  const c = cfg();
  const d = createBandaidDetector({ config: c });
  d.recordEdit(
    edit(1, "a.ts", ["return null;"], {
      rootCauseHint: "parseConfig returns null when config is missing",
      knownRootCauseFix: "guard config-missing at the parseConfig call site",
    }),
  );
  const report = d.detect();
  const rootCauseFinding = report.findings.find((f) => f.category === "root-cause-not-addressed");
  assert.ok(rootCauseFinding, "expected root-cause-not-addressed finding");
  assert.ok(rootCauseFinding.rootCauseOverlap < c.bandaidMinRootCauseOverlap);
});

test("bandaid: edit that addresses the root cause is not flagged", () => {
  const c = cfg();
  const d = createBandaidDetector({ config: c });
  d.recordEdit(
    edit(1, "a.ts", [
      "function parseConfig(p) {",
      "  if (!exists(p)) return new ConfigError();",
      "  return load(p);",
      "}",
    ], {
      rootCauseHint: "parseConfig returns null when config is missing",
      knownRootCauseFix: "guard config-missing at parseConfig and return a typed ConfigError",
    }),
  );
  const report = d.detect();
  const rootCauseFinding = report.findings.find((f) => f.category === "root-cause-not-addressed");
  assert.equal(rootCauseFinding, undefined, "edit addressing root cause should not be flagged");
});

test("bandaid: disabled family produces no findings", () => {
  const c = resolveBandaidConfig({ families: { bandaid: { enabled: false, minEvents: 1 } } });
  const d = createBandaidDetector({ config: c });
  d.recordEdit(edit(1, "a.ts", ["// @ts-ignore", "const x = y;"]));
  const report = d.detect();
  assert.equal(report.detectedCount, 0);
});

test("bandaid: config validation rejects bad patterns", () => {
  assert.throws(
    () => resolveBandaidConfig({ bandaidPatterns: [{ regex: "(", severity: "low", category: "type-suppression" }] }),
    /regex is invalid/,
  );
  assert.throws(
    () => resolveBandaidConfig({ bandaidPatterns: [{ regex: "x", severity: ("bogus" as unknown) as never, category: "type-suppression" }] }),
    /severity/,
  );
  assert.throws(
    () => resolveBandaidConfig({ bandaidMinRootCauseOverlap: 1.5 }),
    /bandaidMinRootCauseOverlap/,
  );
});

test("bandaid: custom patterns are honored", () => {
  const c = resolveBandaidConfig({
    bandaidPatterns: [{ label: "console-log", regex: String.raw`\bconsole\.log\b`, severity: "low", category: "lint-suppression" }],
  });
  const d = createBandaidDetector({ config: c });
  d.recordEdit(edit(1, "a.ts", ["console.log('debug', x);"]));
  const report = d.detect();
  assert.equal(report.detectedCount, 1);
  assert.equal(report.findings[0]?.patternLabel, "console-log");
});
