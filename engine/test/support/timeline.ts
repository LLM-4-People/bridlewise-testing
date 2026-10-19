import { join } from "node:path";

import { ownedTemporaryName } from "../../src/filesystem/private-state.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import type { TimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { setEffectSink } from "../../src/timeline/recorded-effect.ts";
import { createTimelineEffectSink } from "../../src/timeline/effect-sink.ts";
import { DEFAULT_MAXIMUM_DOCUMENT_BYTES } from "../../src/timeline/timeline-config.ts";
import type { TimelineStandaloneEventInput } from "../../src/timeline/timeline-types.ts";

/**
 * Shared evaluation timeline-recorder factory. The single owner of the
 * `createTimelineStore` + `createTimelineRecorder` test setup previously
 * duplicated as `mkTimeline` across the evaluation suite. Each caller passes a
 * short `label` that seeds both the per-run database filename and the ledger
 * identifier (`ledger-<label>`), preserving the distinct ledger ids the
 * per-file copies used.
 */
export function makeTimelineRecorder(dir: string, label: string): TimelineRecorder {
  const store = createTimelineStore({
    path: join(dir, `${ownedTemporaryName(`${label}-`)}.db`),
    ledgerId: `ledger-${label}`,
  });
  return createTimelineRecorder({ store });
}

/** Explicit opt-in real sink for tests that require storage acknowledgment. */
export function installTimelineEffectSink(recorder: TimelineRecorder): () => void {
  setEffectSink(createTimelineEffectSink(() => ({
    recorder,
    documentOptions: { maxDocumentBytes: DEFAULT_MAXIMUM_DOCUMENT_BYTES, resourceDeltasEnabled: false },
  })));
  return () => setEffectSink(undefined);
}

/** One ordinary standalone event input (a turn of run-1), for fixtures that need events and no particular content. */
export function makeTimelineEventInput(ledgerId: string, eventId: string, eventType: string = "turn"): TimelineStandaloneEventInput {
  return {
    eventId, ledgerId, eventType: eventType as TimelineStandaloneEventInput["eventType"],
    actor: { kind: "harness", id: "runtime" },
    correlation: { runId: "run-1" },
    description: "turn started",
    wallTime: "2026-07-16T00:00:00.000Z",
  };
}
