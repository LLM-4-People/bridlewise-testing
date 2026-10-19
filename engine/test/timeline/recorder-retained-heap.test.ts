import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { sha256 } from "../../src/kernel/integrity.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import type { EventLedgerStoragePort, TimelineEventRecord } from "../../src/timeline/timeline-types.ts";
import { mkTempDir } from "../support/temp-dir.ts";

/**
 * THE PERSISTED RECORDER RETAINS NOTHING PER EFFECT (SCALE-CR1 C6).
 *
 * The recorder used to wrap a process-wide in-memory `ExecutionClosure` that
 * kept every intent, terminal and observation it ever recorded: about 1.6 KB
 * of heap per paired effect, linear, for the life of the server — roughly
 * 0.5 GB/h at 200 concurrent conversations, an out-of-memory no handler can
 * catch. The ledger is the record; what is pending is asked of it. Ten
 * thousand paired effects must leave the heap where it was (< 0.1 MB).
 */

setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;

function settledHeap(): number {
  for (let i = 0; i < 4; i += 1) collect();
  return process.memoryUsage().heapUsed;
}

/**
 * The recorder is measured over a store that keeps nothing in JavaScript
 * (each append is acknowledged and dropped), so the reading is the
 * recorder's own retention — the closure lived there — and a run of tens of
 * thousands of effects takes a second instead of a minute of SQLite writes.
 * The real store's pairing is covered by query-plans.test.ts and the
 * recorder suite; its rows live in SQLite, not on this heap.
 */
function acknowledgingStore(): EventLedgerStoragePort {
  const dir = mkTempDir("tl-retained-heap-");
  const real = createTimelineStore({ path: join(dir, "timeline.db"), ledgerId: "heap" });
  let sequence = 0n;
  const acknowledge = (input: Readonly<{ eventId: string }>) => {
    sequence += 1n;
    return { eventId: input.eventId, sequence: sequence.toString(10), chainHash: "0".repeat(64) } as unknown as TimelineEventRecord;
  };
  return { ...real, appendIntent: acknowledge, appendTerminal: acknowledge, appendObservation: acknowledge, appendEvent: acknowledge };
}

test("recorder: ten thousand paired effects retain under 0.1 MB of heap", () => {
  const store = acknowledgingStore();
  const recorder = createTimelineRecorder({ store });
  const pair = (label: string, count: number) => {
    for (let i = 0; i < count; i += 1) {
      const effectId = `${label}-${String(i)}`;
      recorder.beginEffect({ effectId, kind: "provider", actor: { kind: "harness", id: "heap" }, description: "pair", intentHash: sha256(effectId) });
      recorder.endEffect(effectId, { outcome: "succeeded", resultHash: sha256(`${effectId}:result`) });
    }
  };
  try {
    // Warm every lazy path first (JIT code, inline caches, string tables);
    // measured, the heap settles within the first ~20,000 effects.
    pair("warm", 30_000);
    const before = settledHeap();
    pair("measured", 10_000);
    const retained = settledHeap() - before;
    assert.ok(retained < 100 * 1024, `10,000 paired effects retained ${String(Math.round(retained / 1024))} KiB of heap`);
  } finally { recorder.close(); }
});
