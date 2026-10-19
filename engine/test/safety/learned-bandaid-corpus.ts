import { resolveBandaidConfig, type BandaidConfig } from "../../src/safety/bandaid-config.ts";
import { createBandaidDetector, type EditEvent, type BandaidFinding } from "../../src/safety/bandaid-detector.ts";
import { learnBandaidPatterns, type LearnedSource } from "../../src/safety/bandaid-pattern-learner.ts";

/**
 * EXP432 shared test helpers — build a learned config (no static keywords).
 *
 * The flow: build a corpus (the "codebase" the learner mines), run the
 * learner, build a config with the learned pragmas/markers. This is the
 * DYNAMIC replacement for EXP408's static `BANDAID_DEFAULT_PATTERNS` list.
 */

/** A corpus that uses each pragma/marker in >= 2 files (minSupport=2). */
export function buildCorpus(): readonly LearnedSource[] {
  return [
    { path: "src/a.ts", content: "// @ts-ignore\nconst x = y;" },
    { path: "src/b.ts", content: "// @ts-ignore: lib broken\nconst w = z;" },
    { path: "src/c.ts", content: "// @ts-expect-error\nconst q = r;" },
    { path: "src/d.ts", content: "// @ts-expect-error: fix later\nconst m = n;" },
    { path: "src/e.ts", content: "/* eslint-disable-next-line */\nconst a = 1;" },
    { path: "src/f.ts", content: "/* eslint-disable */\nconst b = 2;" },
    { path: "src/g.ts", content: "// TODO: fix this later\nconst c = 3;" },
    { path: "src/h.ts", content: "// TODO: hack to unblock\nconst d = 4;" },
    { path: "src/i.ts", content: "// FIXME: refactor\nconst e = 5;" },
    { path: "src/j.ts", content: "// FIXME: broken\nconst f = 6;" },
  ];
}

/** Build a config with LEARNED pragmas/markers (no static keyword list). */
export function learnedConfig(overrides: Record<string, unknown> = {}): BandaidConfig {
  const corpus = buildCorpus();
  const learned = learnBandaidPatterns(corpus, {
    minSupport: 2,
    maxPragmaLength: 80,
    maxDeferredLength: 200,
    includeLongCommentHeuristic: true,
  });
  return resolveBandaidConfig({
    learnedSuppressionPragmas: [...learned.suppressionPragmas],
    learnedDeferredMarkers: [...learned.deferredMarkers],
    ...overrides,
  });
}

export function edit(
  turn: number,
  filePath: string,
  added: string[],
  opts: Partial<EditEvent> = {},
): EditEvent {
  return {
    turn,
    filePath,
    addedLines: added,
    removedLines: opts.removedLines ?? [],
    rootCauseHint: opts.rootCauseHint,
    knownRootCauseFix: opts.knownRootCauseFix,
  };
}

export function runDetect(
  cfg: BandaidConfig,
  edits: readonly EditEvent[],
): { findings: readonly BandaidFinding[]; detectedCount: number; flaggedTurns: Set<number> } {
  const d = createBandaidDetector({ config: cfg });
  for (const e of edits) d.recordEdit(e);
  const r = d.detect();
  return { findings: r.findings, detectedCount: r.detectedCount, flaggedTurns: new Set(r.findings.map((f) => f.turn)) };
}
