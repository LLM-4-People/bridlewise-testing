import { parentPort, workerData } from "node:worker_threads";
import { once } from "node:events";
import assert from "node:assert/strict";

import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { SecurityError } from "../../src/kernel/errors.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import type { TimelineStandaloneEventInput } from "../../src/timeline/timeline-types.ts";

type WorkerInput = Readonly<{
  dbPath: string;
  ledgerId: string;
  count: number;
  workerIndex: number;
  operation: "event" | "intent" | "terminal";
}>;

const data = workerData as WorkerInput;
const store = createTimelineStore({ path: data.dbPath, ledgerId: data.ledgerId });
try {
  assert.ok(parentPort);
  const start = once(parentPort, "message");
  parentPort.postMessage({ type: "ready" });
  const [message] = await start;
  assert.equal(message.type, "start");
  let appended = 0;
  const errors: string[] = [];
  for (let i = 0; i < data.count; i++) {
    const eventId = `evt-w${data.workerIndex}-${i}`;
    const input: TimelineStandaloneEventInput = {
      eventId,
      ledgerId: data.ledgerId,
      eventType: "turn",
      actor: { kind: "harness", id: `worker-${data.workerIndex}` },
      correlation: { runId: `run-w${data.workerIndex}-${i}` },
      description: `concurrency append worker ${data.workerIndex} event ${i}`,
      wallTime: "2026-09-24T00:00:00Z",
    };
    try {
      if (data.operation === "intent") {
        store.appendIntent({ ...input, effectKind: "process", effectId: "shared-effect", intentHash: sha256("intent") });
      } else if (data.operation === "terminal") {
        store.appendTerminal({ eventId, ledgerId: data.ledgerId, eventType: "turn", effectId: "shared-effect", outcome: "succeeded", resultHash: sha256("result"), wallTime: input.wallTime });
      } else store.appendEvent(input);
      appended++;
    } catch (error) {
      errors.push(error instanceof SecurityError ? error.code : error instanceof Error ? error.message : String(error));
    }
  }
  parentPort.postMessage({ type: "result", value: { workerIndex: data.workerIndex, appended, errors } });
} finally {
  try { store.close(); }
  finally { parentPort?.close(); }
}
