import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBandaidConfig } from "../../src/safety/bandaid-config.ts";
import {
  createWorkaroundDetector,
  type ToolCallEvent,
  type WorkaroundEditEvent,
} from "../../src/safety/workaround-detector.ts";

/**
 * EXP408/EXP432 workaround detection — 20 tasks where a tool fails and the
 * LLM switches to a manual/lesser approach. 100% detection required.
 * EXP432: the manual-approach patterns DEFAULT is EMPTY (no static keyword
 * list); this test supplies them via CONFIG. The consequential-tools mode
 * is "list" with the consequential tools provided (so the "non-consequential"
 * test can exclude a tool).
 */

function cfg() {
  return resolveBandaidConfig({
    workaroundConsequentialToolsMode: "list",
    workaroundConsequentialTools: ["search_code", "grep", "find_reuse", "get_repository_map", "get_dependency_graph", "fetch_page", "read_docs", "repo_question"],
    workaroundManualApproachPatterns: [
      String.raw`\bfor\s*\([^)]*\)\s*\{[^}]*\.(indexOf|includes)\b`,
      String.raw`\bwhile\s*\([^)]*\)\s*\{`,
      String.raw`\bfunction\s+(search|find|grep|lookup)\w*\s*\(`,
      String.raw`readFileSync|readFile\b`,
    ],
  });
}

function tc(turn: number, toolName: string, intent: string, success: boolean, extra: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return { turn, toolName, intent, success, error: extra.error, unavailable: extra.unavailable };
}

function ed(turn: number, filePath: string, added: string[]): WorkaroundEditEvent {
  return { turn, filePath, addedLines: added };
}

test("workaround: 20 detection cases — tool-switch + manual-reimplementation — 100% required", () => {
  const c = cfg();
  const d = createWorkaroundDetector({ config: c });

  // 1. search_code fails → grep (tool-switch)
  d.recordToolCall(tc(1, "search_code", "find all call sites of makeAssertNode", false));
  d.recordToolCall(tc(2, "grep", "find all call sites of makeAssertNode", true));
  // 2. search_code fails → manual for-loop with indexOf (manual-reimplementation)
  d.recordToolCall(tc(3, "search_code", "find usages of parseConfig", false));
  d.recordEdit(ed(4, "a.ts", ["for (let i = 0; i < files.length; i++) { if (arr.indexOf(token) >= 0) found = true; }"]));
  // 3. find_reuse fails → search_code (tool-switch)
  d.recordToolCall(tc(5, "find_reuse", "find existing normalizer for loop form", false));
  d.recordToolCall(tc(6, "search_code", "find existing normalizer for loop form", true));
  // 4. grep fails → manual while loop
  d.recordToolCall(tc(7, "grep", "find TODO comments", false));
  d.recordEdit(ed(8, "b.ts", ["while (lines.length > 0) {", "  const l = lines.shift();", "}"]));
  // 5. get_repository_map fails → manual readFileSync scan
  d.recordToolCall(tc(9, "get_repository_map", "list all modules", false));
  d.recordEdit(ed(10, "c.ts", ["const fs = require('fs'); const entries = fs.readFileSync(dir).toString();"]));
  // 6. fetch_page fails → search_web (tool-switch)
  d.recordToolCall(tc(11, "fetch_page", "fetch babel parser docs", false));
  d.recordToolCall(tc(12, "search_web", "fetch babel parser docs", true));
  // 7. read_docs fails → repo_question (tool-switch)
  d.recordToolCall(tc(13, "read_docs", "read babel traverse API", false));
  d.recordToolCall(tc(14, "repo_question", "read babel traverse API", true));
  // 8. get_dependency_graph fails → manual function-search
  d.recordToolCall(tc(15, "get_dependency_graph", "map import graph", false));
  d.recordEdit(ed(16, "d.ts", ["function searchImports(path) {", "  const files = readdirSync(path);", "}"]));
  // 9. search_code fails → readFileSync fallback (manual-reimplementation)
  d.recordToolCall(tc(17, "search_code", "find all functions named tokenize", false));
  d.recordEdit(ed(18, "e.ts", ["const data = readFileSync(path, 'utf8');"]));
  // 10. search_code fails → grep (tool-switch) — different intent from case 9
  d.recordToolCall(tc(19, "search_code", "find all error handlers", false));
  d.recordToolCall(tc(20, "grep", "find all error handlers", true));
  // 11. grep fails → manual for-loop with includes
  d.recordToolCall(tc(21, "grep", "find error strings", false));
  d.recordEdit(ed(22, "f.ts", ["for (const f of files) { if (f.includes('Error')) count++; }"]));
  // 12. find_reuse fails → manual find function
  d.recordToolCall(tc(23, "find_reuse", "find existing jaccard impl", false));
  d.recordEdit(ed(24, "g.ts", ["function findSimilar(a, b) { return jaccard(a, b); }"]));
  // 13. search_code fails → grep (tool-switch) — within window
  d.recordToolCall(tc(25, "search_code", "find all references", false));
  d.recordToolCall(tc(27, "grep", "find all references", true));
  // 14. search_code fails → manual for-loop with indexOf
  d.recordToolCall(tc(28, "search_code", "find imports of integrity", false));
  d.recordEdit(ed(30, "h.ts", ["for (let i = 0; i < src.length; i++) {", "  if (src[i].indexOf('integrity') >= 0) hits.push(src[i]);", "}"]));
  // 15. get_repository_map fails → search_code (tool-switch)
  d.recordToolCall(tc(31, "get_repository_map", "list modules", false));
  d.recordToolCall(tc(33, "search_code", "list modules", true));
  // 16. fetch_page fails → manual readFileSync of a URL (manual-reimplementation)
  d.recordToolCall(tc(34, "fetch_page", "fetch docs page", false));
  d.recordEdit(ed(36, "i.ts", ["const body = readFileSync(url, 'utf8');"]));
  // 17. repo_question fails → search_web (tool-switch)
  d.recordToolCall(tc(37, "repo_question", "ask about babel", false));
  d.recordToolCall(tc(38, "search_web", "ask about babel", true));
  // 18. search_code fails → manual function named findLookup
  d.recordToolCall(tc(39, "search_code", "find all exports", false));
  d.recordEdit(ed(40, "j.ts", ["function findExports(dir) {", "  return readdirSync(dir).filter(f => f.endsWith('.ts'));", "}"]));
  // 19. grep fails → manual readFileSync scan
  d.recordToolCall(tc(41, "grep", "find all console.log", false));
  d.recordEdit(ed(42, "k.ts", ["const contents = readFileSync(file, 'utf8');"]));
  // 20. find_reuse fails → search_code (tool-switch)
  d.recordToolCall(tc(43, "find_reuse", "find existing detector", false));
  d.recordToolCall(tc(44, "search_code", "find existing detector", true));

  const report = d.detect();
  // All 20 cases should be flagged (each is a genuine workaround).
  const failedToolsFlagged = new Set(report.findings.map((f) => `${f.failedTool}-${f.intent}`));
  const expected = [
    "search_code-find all call sites of makeAssertNode",
    "search_code-find usages of parseConfig",
    "find_reuse-find existing normalizer for loop form",
    "grep-find TODO comments",
    "get_repository_map-list all modules",
    "fetch_page-fetch babel parser docs",
    "read_docs-read babel traverse API",
    "get_dependency_graph-map import graph",
    "search_code-find all functions named tokenize",
    "search_code-find all error handlers",
    "grep-find error strings",
    "find_reuse-find existing jaccard impl",
    "search_code-find all references",
    "search_code-find imports of integrity",
    "get_repository_map-list modules",
    "fetch_page-fetch docs page",
    "repo_question-ask about babel",
    "search_code-find all exports",
    "grep-find all console.log",
    "find_reuse-find existing detector",
  ];
  for (const key of expected) {
    assert.ok(failedToolsFlagged.has(key), `expected workaround finding for ${key}`);
  }
  assert.equal(report.detectedCount, 20, `expected 20 findings, got ${report.detectedCount}`);
});

test("workaround: negative controls — tool success + same-tool retry are not flagged", () => {
  const c = cfg();
  const d = createWorkaroundDetector({ config: c });
  // All successful tool calls.
  d.recordToolCall(tc(1, "search_code", "find usages of X", true));
  d.recordToolCall(tc(2, "grep", "find usages of X", true));
  // Retry same tool after a failure (legitimate).
  d.recordToolCall(tc(3, "search_code", "find Y", false));
  d.recordToolCall(tc(4, "search_code", "find Y", true));
  const report = d.detect();
  assert.equal(report.detectedCount, 0, `got ${report.detectedCount}`);
});

test("workaround: non-consequential tool failure is not flagged", () => {
  const c = cfg();
  const d = createWorkaroundDetector({ config: c });
  d.recordToolCall(tc(1, "some_other_tool", "do thing", false));
  d.recordToolCall(tc(2, "grep", "do thing", true));
  const report = d.detect();
  assert.equal(report.detectedCount, 0, "non-consequential tool failure should not seed a workaround");
});

test("workaround: switch outside the window is not flagged", () => {
  const c = resolveBandaidConfig({ workaroundSwitchWindow: 2 });
  const d = createWorkaroundDetector({ config: c });
  d.recordToolCall(tc(1, "search_code", "find X", false));
  d.recordToolCall(tc(5, "grep", "find X", true)); // turn 5 > 1 + 2
  const report = d.detect();
  assert.equal(report.detectedCount, 0);
});

test("workaround: disabled family produces no findings", () => {
  const c = resolveBandaidConfig({ families: { workaround: { enabled: false, minEvents: 1 } } });
  const d = createWorkaroundDetector({ config: c });
  d.recordToolCall(tc(1, "search_code", "find X", false));
  d.recordToolCall(tc(2, "grep", "find X", true));
  const report = d.detect();
  assert.equal(report.detectedCount, 0);
});

test("workaround: unavailable flag is preserved for the investigation stage", () => {
  const c = cfg();
  const d = createWorkaroundDetector({ config: c });
  d.recordToolCall(tc(1, "search_code", "find X", false, { unavailable: true }));
  d.recordToolCall(tc(2, "grep", "find X", true));
  const report = d.detect();
  assert.equal(report.detectedCount, 1);
  // The unavailable flag is on the recorded tool call (not the finding); the
  // investigation stage reads the snapshot to decide needs-user-action.
  assert.equal(d.snapshot().toolCalls[0]?.unavailable, true);
});
