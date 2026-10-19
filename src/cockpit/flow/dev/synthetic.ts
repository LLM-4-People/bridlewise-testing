/**
 * SYNTHETIC beats — dev-harness + perf-test fixture ONLY.
 *
 * Clearly labeled synthetic: every sentence says so, so nothing generated
 * here can be mistaken for a recorded fact if it ever leaks onto a screen.
 * Used by the 5k-beat virtualizer perf test (tests/cockpit/perf) and by the
 * dev harness's synthetic mode. Deterministic (seeded LCG) so perf numbers
 * are comparable run to run.
 */

import type { Beat, BeatVerb } from "../types.ts";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const inertVerb: BeatVerb = {
  id: "dev.synthetic",
  label: "synthetic",
  wired: false,
  reason: "synthetic fixture beat — no real record behind it",
};

/** Deterministic mixed-kind beat log of size n. */
export function syntheticBeats(n: number, seed = 42): Beat[] {
  const rnd = lcg(seed);
  const beats: Beat[] = [];
  let turnIndex = -1;
  let lastModelId: string | null = null;
  // Deterministic fixture epoch (2023-11-14T22:13:20Z), no bare literal.
  const t0 = Date.UTC(2023, 10, 14, 22, 13, 20);
  for (let i = 0; i < n; i += 1) {
    const at = t0 + i * 1000;
    const roll = rnd();
    if (turnIndex < 0 || roll < 0.18) {
      turnIndex += 1;
      beats.push({
        id: `syn-u-${i}`,
        kind: "turn",
        parentId: null,
        turnIndex,
        at,
        abnormal: false,
        bleed: false,
        verbs: [inertVerb],
        turn: {
          who: "you",
          text: `synthetic user turn ${turnIndex}: ${"refactor the reader path ".repeat(1 + Math.floor(rnd() * 3))}`,
          streaming: false,
        },
      });
      const modelId = `syn-m-${i}`;
      lastModelId = modelId;
      // A SILENT model turn — the model acted without commenting. It is a
      // real and common shape (its tool calls ARE its content), and the flow
      // deliberately draws NO ROW for it (`rendersInFlow`), so the fixture
      // has to contain some or the virtualizer's zero-height case is never
      // exercised by anything that measures real layout.
      const silent = rnd() < 0.12;
      beats.push({
        id: modelId,
        kind: "turn",
        parentId: `syn-u-${i}`,
        turnIndex,
        at: at + 100,
        abnormal: false,
        bleed: false,
        verbs: [inertVerb],
        turn: {
          who: "model",
          text: silent
            ? ""
            : `synthetic model turn ${turnIndex}. ${"I will read the file and apply the change. ".repeat(1 + Math.floor(rnd() * 6))}`,
          streaming: false,
          inputTokens: 1000 + Math.floor(rnd() * 20000),
          outputTokens: 100 + Math.floor(rnd() * 3000),
          firstWordMs: 200 + Math.floor(rnd() * 1500),
          tokPerSec: Math.round((20 + rnd() * 60) * 10) / 10,
        },
      });
    } else if (roll < 0.55) {
      const failed = rnd() < 0.06;
      beats.push({
        id: `syn-t-${i}`,
        kind: "tool",
        parentId: lastModelId,
        turnIndex,
        at,
        abnormal: failed,
        bleed: true,
        verbs: [inertVerb],
        tool: {
          name: rnd() < 0.4 ? "read_file" : "edit",
          label: rnd() < 0.4 ? "read file" : "edit file",
          status: failed ? "error" : "done",
          input: { path: `src/lib/file-${Math.floor(rnd() * 200)}.ts` },
          output: failed ? undefined : `synthetic output line\n`.repeat(1 + Math.floor(rnd() * 5)),
          startedAt: at,
          durationMs: Math.floor(rnd() * 4000),
        },
      });
    } else if (roll < 0.7) {
      beats.push({
        id: `syn-fx-${i}`,
        kind: "effect",
        parentId: lastModelId,
        turnIndex,
        at,
        abnormal: false,
        bleed: true,
        verbs: [inertVerb],
        effect: {
          path: `src/lib/file-${Math.floor(rnd() * 200)}.ts`,
          producedBy: lastModelId ?? "syn-root",
          added: Math.floor(rnd() * 80),
          removed: Math.floor(rnd() * 30),
          firstHunk: "@@ -1,3 +1,4 @@\n-old synthetic line\n+new synthetic line\n context",
        },
      });
    } else if (roll < 0.78) {
      beats.push({
        id: `syn-cd-${i}`,
        kind: "check-delta",
        parentId: lastModelId,
        turnIndex,
        at,
        abnormal: rnd() < 0.5,
        bleed: true,
        verbs: [inertVerb],
        checkDelta: {
          checkId: `chk-${i}`,
          checkName: rnd() < 0.5 ? "typecheck" : "lint",
          from: rnd() < 0.5 ? "passed" : "failed",
          to: rnd() < 0.5 ? "failed" : "passed",
          errorCount: Math.floor(rnd() * 5),
        },
      });
    } else if (roll < 0.86) {
      beats.push({
        id: `syn-ev-${i}`,
        kind: "event",
        parentId: lastModelId,
        turnIndex,
        at,
        abnormal: rnd() < 0.3,
        bleed: true,
        verbs: [],
        event: {
          eventKind: rnd() < 0.5 ? "steering" : "self-healing",
          text: `synthetic event ${i}`,
        },
      });
    } else {
      beats.push({
        id: `syn-seam-${i}`,
        kind: "seam",
        parentId: null,
        turnIndex,
        at,
        abnormal: false,
        bleed: true,
        verbs: [],
        seam: {
          turnIndex,
          sentence: `turn ${turnIndex + 1} — synthetic rollup, ${Math.floor(rnd() * 5)} files changed`,
          derivation: {
            method: "synthetic fixture — counted the synthetic beats generated for this turn",
            steps: [{ source: "synthetic beats", sourceId: "dev.synthetic", count: 5 }],
            asOf: at,
          },
          queued: 0,
        },
      });
    }
  }
  return beats.slice(0, n);
}
