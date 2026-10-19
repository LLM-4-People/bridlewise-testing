import assert from "node:assert/strict";
import test from "node:test";
import { currentRecordingContext, withRecordingContext } from "../../src/timeline/recording-context.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import { sha256, canonicalHash } from "../../src/kernel/integrity.ts";
import { recordProviderStream } from "../../src/timeline/provider-recording.ts";
import { RequiredRecordingError, setEffectSink, type EffectRecord, type EffectSink } from "../../src/timeline/recorded-effect.ts";
import { createTimelineEffectSink } from "../../src/timeline/effect-sink.ts";
import { DEFAULT_MAXIMUM_DOCUMENT_BYTES } from "../../src/timeline/timeline-config.ts";
import { LedgerPersistenceUncertainError } from "../../src/timeline/ledger-primitives.ts";
import { makeTimelineRecorder, installTimelineEffectSink } from "../support/timeline.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { thrownFailure } from "../support/factories.ts";

const contentJson = JSON.stringify({ response: "safe partial evidence" });
const documents = [{ name: "provider-response", contentJson, contentDigest: sha256(contentJson) }];

function sinkFor(recorder: ReturnType<typeof makeTimelineRecorder>): EffectSink {
  return createTimelineEffectSink(() => ({ recorder, documentOptions: { maxDocumentBytes: DEFAULT_MAXIMUM_DOCUMENT_BYTES, resourceDeltasEnabled: false } }));
}
function pairedObserver(base: EffectSink, observe: (record: EffectRecord) => void): EffectSink {
  return Object.assign((record: EffectRecord) => base(record), { begin: (record: Parameters<NonNullable<EffectSink["begin"]>>[0]) => {
    const pair = base.begin!(record);
    return { receipt: pair.receipt, finish(completion: EffectRecord) { observe(completion); return pair.finish(completion); } };
  } });
}
function assertRequired(error: unknown): void {
  assert.ok(error instanceof RequiredRecordingError);
  assert.equal(error.code, "required_recording_unavailable");
  assert.equal(error.message, "Required effect recording is unavailable");
}

async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
  let threw = false;
  let failure: unknown;
  try { await operation; } catch (error) { threw = true; failure = error; }
  assert.equal(threw, true, "operation must reject, including undefined reasons");
  return failure;
}

test("unstarted return does not pull, capture or record", async () => {
  let calls = 0;
  setEffectSink(() => { calls++; });
  const source = (async function* () { calls++; yield 1; })();
  const recorded = recordProviderStream(() => { calls++; return source; }, { name: "unstarted", capture: () => { calls++; return { outcome: "succeeded" }; } });
  try {
    await recorded.stream.return();
    assert.equal(calls, 0);
    assert.equal(recorded.settlement, undefined);
  } finally { setEffectSink(undefined); }
});

for (const close of ["exhaust", "return", "abort"] as const) {
  test(`provider ${close} waits for teardown then stores one linked pair with partial documents`, async () => {
    const recorder = makeTimelineRecorder(createTempDir("provider-recording-"), "stream");
    const restore = installTimelineEffectSink(recorder);
    const closing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const controller = new AbortController();
    const source = (async function* () {
      try { yield "progress"; }
      finally { order.push("closing"); closing.resolve(); await release.promise; order.push("closed"); }
    })();
    const recorded = recordProviderStream(() => source, { name: close, signal: controller.signal, capture: () => {
      order.push("capture"); return { outcome: "failed", documents, args: { operation: "safe" } };
    } });
    try {
      assert.deepEqual(await recorded.stream.next(), { value: "progress", done: false });
      assert.equal(recorded.settlement, undefined);
      if (close === "abort") controller.abort();
      const ending = close === "exhaust" ? recorded.stream.next() : recorded.stream.return();
      const first = await Promise.race([
        closing.promise.then(() => "closing"),
        ending.then(() => "settled", () => "settled"),
      ]);
      assert.equal(first, "closing", "completion must not bypass source cleanup");
      assert.deepEqual(order, ["closing"]);
      assert.equal(recorder.store.query({ ledgerId: recorder.ledgerId }).length, 1);
      assert.equal(recorder.store.query({ ledgerId: recorder.ledgerId })[0]?.recordKind, "intent");
      release.resolve();
      await ending;
      assert.deepEqual(order, ["closing", "closed", "capture"]);
      const result = recorded.settlement!;
      assert.equal(result.recording.status, "recorded");
      assert.ok(Object.isFrozen(result));
      assert.ok(result.recording.receipt);
      const row = recorder.store.getEvent(result.recording.receipt.eventId)!;
      assert.equal(row.outcome, close === "exhaust" ? "failed" : "cancelled", "natural EOF cannot fabricate protocol success");
      assert.equal(row.documents.find((doc) => doc.name === "provider-response")?.contentJson, contentJson);
      assert.equal(recorder.store.query({ ledgerId: recorder.ledgerId }).length, 2);
      assert.equal(result.intent?.status, "recorded");
      if (result.intent?.status !== "recorded") assert.fail("real intent receipt is required");
      const intent = recorder.store.getEvent(result.intent.receipt.eventId)!;
      assert.equal(intent.recordKind, "intent");
      assert.equal(row.recordKind, "terminal");
      assert.equal(row.effectId, intent.effectId);
      assert.deepEqual(recorder.pendingEffects(), [], "the paired terminal closes the intent in the ledger");
    } finally { release.resolve(); await recorded.stream.return(); restore(); recorder.store.close(); }
  });
}

for (const thrown of ["Error", "undefined"] as const) {
  for (const sinkFailure of [false, true]) {
    test(`source ${thrown} stays primary with capture and sink failure=${sinkFailure}`, async () => {
      const sourceFailure = thrownFailure(thrown, "private provider");
      const records: EffectRecord[] = [];
      const recorder = makeTimelineRecorder(createTempDir("provider-failure-"), "failure");
      const base = sinkFor(recorder);
      setEffectSink(pairedObserver(base, (record) => { records.push(record); if (sinkFailure) throw new Error("private sink"); }));
      let captures = 0;
      const source = (async function* () { yield 1; throw sourceFailure; })();
      const recorded = recordProviderStream(() => source, { name: "failure", capture: () => { captures++; throw undefined; } });
      try {
        await recorded.stream.next();
        assert.equal(await rejectionOf(recorded.stream.next()), sourceFailure);
        assert.equal(captures, 1);
        assert.equal(records.length, 1);
        assert.equal(records[0]?.outcome, "failed");
        assert.equal(JSON.stringify(records).includes("private provider"), false);
        assert.equal(recorded.settlement?.work.status, "threw");
        assert.equal(recorded.settlement?.recording.status, "failed");
      } finally { await recorded.stream.return(); setEffectSink(undefined); recorder.store.close(); }
    });
  }
}

for (const thrown of ["Error", "undefined"] as const) {
  test(`source return failure ${thrown} is retained with real failed receipt`, async () => {
    const failure = thrownFailure(thrown, "private teardown");
    const recorder = makeTimelineRecorder(createTempDir("provider-return-"), "return");
    const restore = installTimelineEffectSink(recorder);
    const recorded = recordProviderStream(async function* () { try { yield 1; } finally { throw failure; } }, {
      name: "teardown", capture: () => ({ outcome: "succeeded", documents }),
    });
    try {
      await recorded.stream.next();
      assert.equal(await rejectionOf(recorded.stream.return()), failure);
      assert.equal(recorded.settlement?.work.status, "threw");
      assert.equal(recorded.settlement?.recording.status, "recorded");
      assert.ok(recorded.settlement?.recording.receipt);
      assert.equal(recorder.store.getEvent(recorded.settlement.recording.receipt.eventId)?.outcome, "failed");
    } finally { restore(); recorder.store.close(); }
  });
}

for (const mode of ["absent", "unpaired", "throws", "malformed", "async"] as const) {
  test(`unavailable intent ${mode} refuses before factory, acquisition or capture`, async () => {
    let calls = 0;
    const sink = Object.assign(() => { calls++; }, mode === "unpaired" || mode === "absent" ? {} : {
      begin: mode === "throws" ? () => { throw new Error("private sink"); }
        : mode === "async" ? async () => { calls++; }
        : () => ({ receipt: undefined, finish() { calls++; } }),
    }) as unknown as EffectSink;
    setEffectSink(mode === "absent" ? undefined : sink);
    const recorded = recordProviderStream(() => { calls++; return { [Symbol.asyncIterator]() { calls++; return { async next() { calls++; return { done: true, value: undefined }; } }; } }; }, {
      name: mode, capture: () => { calls++; return { outcome: "succeeded" }; },
    });
    try {
      assertRequired(await rejectionOf(recorded.stream.next()));
      assert.equal(calls, 0);
      assert.equal(recorded.settlement?.work.status, "not-started");
      assert.equal(recorded.settlement?.intent?.status, "failed");
      assert.equal(recorded.settlement?.recording.status, "not-attempted");
    } finally { setEffectSink(undefined); }
  });
}

for (const closeFails of [false, true]) {
  test(`rejected custom next closes before evidence, preserving primary when close fails=${closeFails}`, async () => {
    const sourceFailure = new Error("private next");
    const closing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const recorder = makeTimelineRecorder(createTempDir("provider-custom-"), "custom");
    setEffectSink(pairedObserver(sinkFor(recorder), () => { order.push("sink"); }));
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          async next() { throw sourceFailure; },
          async return() {
            order.push("closing"); closing.resolve(); await release.promise; order.push("closed");
            if (closeFails) throw new Error("private close");
            return { done: true, value: undefined };
          },
        };
      },
    };
    const recorded = recordProviderStream(() => source, { name: "custom", capture: () => {
      order.push("capture"); return { outcome: "succeeded", documents };
    } });
    const pending = rejectionOf(recorded.stream.next());
    try {
      const first = await Promise.race([
        closing.promise.then(() => "closing"),
        pending.then(() => "settled", () => "settled"),
      ]);
      assert.equal(first, "closing", "rejected next must still close before settling");
      assert.deepEqual(order, ["closing"]);
      assert.equal(recorded.settlement, undefined);
      release.resolve();
      assert.equal(await pending, sourceFailure);
      assert.deepEqual(order, ["closing", "closed", "capture", "sink"]);
    } finally { release.resolve(); await pending; setEffectSink(undefined); recorder.store.close(); }
  });
}

test("recording startup rejection is observed immediately and prevents the source factory", async () => {
  const original = process.cpuUsage;
  const sourceFailure = new Error("private recording startup");
  let attempts = 0;
  let sinks = 0;
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", listener);
  setEffectSink(() => { sinks++; });
  process.cpuUsage = (() => { if (++attempts === 1) throw sourceFailure; return original(); }) as typeof process.cpuUsage;
  let sourceCalls = 0;
  const recorded = recordProviderStream(() => { sourceCalls++; return (async function* () { yield 1; })(); }, {
    name: "startup", capture: () => { sourceCalls++; return { outcome: "succeeded", documents }; },
  });
  try {
    const error = await rejectionOf(recorded.stream.next());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.ok(error instanceof RequiredRecordingError);
    assert.equal(error.code, "required_recording_unavailable");
    assert.equal(error.message, "Required effect recording is unavailable");
    assert.equal(String(error).includes("private recording startup"), false);
    assert.equal(sinks, 0);
    assert.equal(sourceCalls, 0);
    assert.equal(recorded.settlement?.work.status, "not-started");
    assert.equal(recorded.settlement?.recording.status, "not-attempted");
  } finally {
    process.cpuUsage = original;
    process.off("unhandledRejection", listener);
    setEffectSink(undefined);
  }
});

test("yielding cleanup is explicitly unready rather than falsely claimed closed", async () => {
  let cleanupDone = false;
  let captures = 0;
  const recorder = makeTimelineRecorder(createTempDir("provider-yield-close-"), "yield-close");
  const restore = installTimelineEffectSink(recorder);
  const source = (async function* () { try { yield 1; } finally { yield 2; cleanupDone = true; } })();
  const recorded = recordProviderStream(() => source, { name: "cleanup", capture: () => {
    captures++; assert.equal(cleanupDone, false); return { outcome: "succeeded", documents };
  } });
  try {
    await recorded.stream.next();
    const error = await rejectionOf(recorded.stream.return());
    assert.ok(error instanceof HarnessError);
    assert.equal(error.code, "provider_stream_teardown_incomplete");
    assert.equal(error.message, "Provider stream teardown is incomplete");
    assert.equal(captures, 1);
    assert.equal(recorded.settlement?.work.status, "threw");
    assert.equal(recorded.settlement?.recording.status, "recorded");
    assert.equal(recorder.store.query({ ledgerId: recorder.ledgerId }).find((row) => row.recordKind === "terminal")?.outcome, "failed");
  } finally { await source.next(); restore(); recorder.store.close(); }
  assert.equal(cleanupDone, true, "test owns final cleanup; wrapper must not imply it performed it");
});

test("provider pulls, close and capture retain one exact recording scope without consumer bleed", async () => {
  const owner = { actor: { kind: "test", id: "provider-owner" }, runId: "run-original", traceId: "trace-original" };
  const consumer = { actor: { kind: "test", id: "consumer" }, runId: "run-other", sessionId: "consumer-only", traceId: "trace-other" };
  const contexts: ReturnType<typeof currentRecordingContext>[] = [];
  const records: EffectRecord[] = [];
  const recorder = makeTimelineRecorder(createTempDir("provider-scope-"), "scope");
  setEffectSink(pairedObserver(sinkFor(recorder), (record) => { records.push(record); }));
  const source = (async function* () {
    try {
      contexts.push(currentRecordingContext());
      yield 1;
      contexts.push(currentRecordingContext());
      await Promise.resolve();
      contexts.push(currentRecordingContext());
      yield 2;
    } finally { contexts.push(currentRecordingContext()); }
  })();
  const iterable: AsyncIterable<number> = { [Symbol.asyncIterator]() { contexts.push(currentRecordingContext()); return source; } };
  const recorded = recordProviderStream(() => { contexts.push(currentRecordingContext()); return iterable; }, { name: "scope", capture: () => {
    contexts.push(currentRecordingContext()); return { outcome: "succeeded", documents };
  } });
  try {
    await withRecordingContext(owner, async () => {
      assert.equal((await recorded.stream.next()).value, 1);
      assert.equal(currentRecordingContext()?.spanId, undefined);
    });
    await withRecordingContext(consumer, async () => {
      assert.equal((await recorded.stream.next()).value, 2);
      assert.equal(currentRecordingContext()?.actor.id, "consumer");
      await recorded.stream.return();
      assert.equal(currentRecordingContext()?.actor.id, "consumer");
    });
    assert.equal(contexts.length, 7);
    for (const context of contexts) {
      assert.equal(context?.spanId, records[0]?.spanId);
      assert.equal(context?.traceId, owner.traceId);
      assert.equal(context?.runId, owner.runId);
      assert.equal(context?.sessionId, undefined);
      assert.deepEqual(context?.actor, owner.actor);
    }
    assert.equal(records.length, 1);
  } finally { await source.return(); setEffectSink(undefined); recorder.store.close(); }
});

for (const thrown of ["Error", "undefined"] as const) {
  test(`return capture failure ${thrown} refuses independently of a healthy sink`, async () => {
    const failure = thrownFailure(thrown, "private cancellation capture");
    const recorder = makeTimelineRecorder(createTempDir("provider-capture-return-"), "capture-return");
    const restore = installTimelineEffectSink(recorder);
    let captures = 0;
    const recorded = recordProviderStream(async function* () { yield 1; }, {
      name: "capture-return", capture: () => { captures++; throw failure; },
    });
    try {
      await recorded.stream.next();
      const error = await rejectionOf(recorded.stream.return());
      assert.ok(error instanceof RequiredRecordingError);
    assert.equal(error.code, "required_recording_unavailable");
    assert.equal(error.message, "Required effect recording is unavailable");
      assert.equal(captures, 1);
      const result = recorded.settlement!;
      assert.equal(result.work.status, "returned");
      assert.equal(result.recording.status, "failed");
      assert.ok(result.recording.receipt);
      assert.equal(recorder.store.getEvent(result.recording.receipt.eventId)?.outcome, "failed");
      assert.equal(recorder.store.query({ ledgerId: recorder.ledgerId }).length, 2);
    } finally { restore(); recorder.store.close(); }
  });
}

test("aborted transport rejection records cancellation while preserving its private reason", async () => {
  const recorder = makeTimelineRecorder(createTempDir("provider-abort-"), "abort-next");
  const restore = installTimelineEffectSink(recorder);
  const controller = new AbortController();
  const reason = new Error("private abort");
  const recorded = recordProviderStream(async function* () { yield 1; controller.abort(reason); throw reason; }, {
    name: "abort-next", signal: controller.signal, capture: () => ({ outcome: "failed", documents }),
  });
  try {
    await recorded.stream.next();
    assert.equal(await rejectionOf(recorded.stream.next()), reason);
    assert.equal(recorded.settlement?.work.status, "threw");
    const terminal = recorded.settlement?.recording;
    assert.equal(terminal?.status, "recorded");
    if (terminal?.status !== "recorded") assert.fail("terminal receipt required");
    assert.equal(recorder.store.getEvent(terminal.receipt.eventId)?.outcome, "cancelled");
  } finally { restore(); recorder.store.close(); }
});


for (const affinity of ["global", "resolver", "wrapper"] as const) {
  test(`intent is stored before factory; ${affinity} mutation cannot redirect terminal`, async () => {
    const a = makeTimelineRecorder(createTempDir("provider-affinity-a-"), "a");
    const b = makeTimelineRecorder(createTempDir("provider-affinity-b-"), "b");
    const originalLimit = DEFAULT_MAXIMUM_DOCUMENT_BYTES;
    const target = { recorder: a, documentOptions: { maxDocumentBytes: originalLimit, resourceDeltasEnabled: false } };
    let resolutions = 0;
    const base = createTimelineEffectSink(() => { resolutions++; return affinity === "resolver" && resolutions > 1 ? { ...target, recorder: b } : target; });
    setEffectSink(base);
    let factories = 0;
    const recorded = recordProviderStream(() => {
      factories++;
      const rows = a.store.query({ ledgerId: a.ledgerId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.recordKind, "intent", "the lazy factory itself must see the acknowledged intent");
      assert.deepEqual(JSON.parse(rows[0]!.documents.find((doc) => doc.name === "effect-args")!.contentJson!), { input: "intent" });
      return (async function* () { yield 1; })();
    }, { name: "affinity", intent: { args: { input: "intent" }, documents }, capture: () => ({ outcome: "succeeded", documents }) });
    try {
      await recorded.stream.next();
      if (affinity === "global") setEffectSink(sinkFor(b));
      if (affinity === "wrapper") { target.recorder = b; target.documentOptions.maxDocumentBytes = 1; }
      await assert.doesNotReject(recorded.stream.next(), "terminal must settle on its acknowledged recorder despite wrapper mutation");
      const result = recorded.settlement!;
      assert.equal(result.intent?.status, "recorded");
      assert.equal(result.recording.status, "recorded");
      if (result.intent?.status !== "recorded" || result.recording.status !== "recorded") assert.fail("both receipts required");
      const intent = a.store.getEvent(result.intent.receipt.eventId)!;
      const terminal = a.store.getEvent(result.recording.receipt.eventId)!;
      assert.equal(intent.recordKind, "intent");
      assert.equal(terminal.recordKind, "terminal");
      assert.equal(terminal.effectId, intent.effectId);
      assert.equal(intent.intentHash, canonicalHash({ kind: "llm", name: "affinity", args: { input: "intent" }, documents }));
      assert.equal(terminal.resultHash, canonicalHash({ kind: "llm", name: "affinity", outcome: "succeeded", documents }));
      assert.equal(a.store.query({ ledgerId: a.ledgerId }).length, 2);
      assert.equal(b.store.query({ ledgerId: b.ledgerId }).length, 0);
      assert.equal(factories, 1);
      assert.equal(resolutions, 1);
    } finally { setEffectSink(undefined); a.store.close(); b.store.close(); }
  });
}

for (const when of ["before", "during-intent"] as const) {
  test(`abort ${when} prevents lazy source side effects and records cancelled terminal`, async () => {
    const recorder = makeTimelineRecorder(createTempDir("provider-preabort-"), "preabort");
    const controller = new AbortController();
    const reason = new Error("private pre-start cancellation");
    const base = sinkFor(recorder);
    const sink: EffectSink = Object.assign((record: EffectRecord) => base(record), { begin(record: Parameters<NonNullable<EffectSink["begin"]>>[0]) {
      const pair = base.begin!(record);
      if (when === "during-intent") controller.abort(reason);
      return pair;
    } });
    if (when === "before") controller.abort(reason);
    let calls = 0;
    const recorded = recordProviderStream(() => { calls++; return (async function* () { calls++; yield 1; })(); }, {
      name: "preabort", sink, signal: controller.signal, capture: () => { calls++; return { outcome: "succeeded" }; },
    });
    try {
      assert.equal(await rejectionOf(recorded.stream.next()), reason);
      assert.equal(calls, 0);
      assert.equal(recorded.settlement?.work.status, "not-started");
      assert.equal(recorded.settlement?.intent?.status, "recorded");
      assert.equal(recorded.settlement?.recording.status, "recorded");
      const rows = recorder.store.query({ ledgerId: recorder.ledgerId });
      assert.deepEqual(rows.map((row) => row.recordKind), ["intent", "terminal"]);
      assert.equal(rows[1]?.outcome, "cancelled");
    } finally { recorder.store.close(); }
  });
}

for (const phase of ["intent", "terminal"] as const) {
  for (const fault of ["uncertain", "promise", "malformed"] as const) {
    test(`${phase} ${fault} refuses authority and retains safe recording taxonomy`, async () => {
      const recorder = makeTimelineRecorder(createTempDir("provider-receipt-"), "receipt");
      const base = sinkFor(recorder);
      let calls = 0;
      const faultResult = () => {
        if (fault === "uncertain") throw new LedgerPersistenceUncertainError();
        if (fault === "promise") return Promise.reject(new Error("private async storage"));
        return { eventId: "fake", sequence: "0", chainHash: "bad" };
      };
      const sink = Object.assign((record: EffectRecord) => base(record), { begin(record: Parameters<NonNullable<EffectSink["begin"]>>[0]) {
        if (phase === "intent") return faultResult();
        const pair = base.begin!(record);
        return { receipt: pair.receipt, finish() { return faultResult(); } };
      } }) as unknown as EffectSink;
      const recorded = recordProviderStream(async function* () { calls++; yield 1; }, { name: "receipt", sink, capture: () => ({ outcome: "succeeded" }) });
      try {
        if (phase === "terminal") await recorded.stream.next();
        const error = await rejectionOf(recorded.stream.next());
        if (fault === "malformed") assertRequired(error);
        else { assert.ok(error instanceof LedgerPersistenceUncertainError); assert.equal(error.code, "ledger_persistence_uncertain"); }
        assert.equal(calls, phase === "intent" ? 0 : 1);
        assert.equal(recorded.settlement?.intent?.status, phase === "intent" ? "failed" : "recorded");
        assert.equal(recorded.settlement?.recording.status, phase === "intent" ? "not-attempted" : "failed");
        await new Promise<void>((resolve) => setImmediate(resolve));
      } finally { recorder.store.close(); }
    });
  }
}

for (const phase of ["intent", "terminal"] as const) {
  test(`paired ${phase} evidence is admitted once before hashing or storing`, async () => {
    const recorder = makeTimelineRecorder(createTempDir("provider-snapshot-"), "snapshot");
    const base = sinkFor(recorder);
    let traps = 0;
    const args = { get value() { traps++; return traps; } };
    const recorded = recordProviderStream(async function* () { yield 1; }, {
      name: "snapshot", sink: base,
      ...(phase === "intent" ? { intent: { args } } : {}),
      capture: () => ({ outcome: "succeeded", ...(phase === "terminal" ? { args } : {}) }),
    });
    try {
      if (phase === "terminal") await recorded.stream.next();
      assertRequired(await rejectionOf(recorded.stream.next()));
      assert.equal(traps, 0);
      assert.equal(recorder.store.query({ ledgerId: recorder.ledgerId }).length, phase === "intent" ? 0 : 1);
    } finally { recorder.store.close(); }
  });
}

// Keyed by the `typeof` each capability reports, so the test name is static.
const UNUSABLE_TERMINAL_CAPABILITIES = { undefined: undefined, function: async () => undefined, string: "not callable" };

for (const kind of Object.keys(UNUSABLE_TERMINAL_CAPABILITIES) as (keyof typeof UNUSABLE_TERMINAL_CAPABILITIES)[]) {
  test(`acknowledged intent survives unusable terminal capability ${kind}`, async () => {
    const invalidFinish = UNUSABLE_TERMINAL_CAPABILITIES[kind];
    assert.equal(typeof invalidFinish, kind);
    const recorder = makeTimelineRecorder(createTempDir("provider-incomplete-pair-"), "incomplete");
    const base = sinkFor(recorder);
    const sink = Object.assign((record: EffectRecord) => base(record), { begin(record: Parameters<NonNullable<EffectSink["begin"]>>[0]) {
      const pair = base.begin!(record);
      return { receipt: pair.receipt, finish: invalidFinish };
    } }) as unknown as EffectSink;
    let calls = 0;
    const recorded = recordProviderStream(() => { calls++; return (async function* () {})(); }, { name: "incomplete", sink, capture: () => { calls++; return { outcome: "succeeded" }; } });
    try {
      assertRequired(await rejectionOf(recorded.stream.next()));
      assert.equal(calls, 0);
      const intent = recorded.settlement?.intent;
      assert.equal(intent?.status, "failed");
      if (intent?.status !== "failed") assert.fail("failed capability admission required");
      assert.ok(intent.receipt);
      assert.equal(recorder.store.getEvent(intent.receipt.eventId)?.recordKind, "intent");
      assert.equal(recorded.settlement?.recording.status, "not-attempted");
      assert.deepEqual(recorder.pendingEffects().map((event) => event.eventId), [intent.receipt.eventId], "the admitted intent stays pending in the ledger");
    } finally { recorder.store.close(); }
  });
}

for (const phase of ["next", "return"] as const) {
  test(`an invalid provider iterator ${phase} result is a typed harness failure`, async () => {
    const recorder = makeTimelineRecorder(createTempDir(`provider-invalid-${phase}-`), `invalid-${phase}`);
    const restore = installTimelineEffectSink(recorder);
    const iterator = {
      next: async () => (phase === "next" ? null : { done: false, value: 1 }),
      return: async () => 42,
    } as unknown as AsyncIterator<number>;
    const recorded = recordProviderStream(() => ({ [Symbol.asyncIterator]: () => iterator }), {
      name: `invalid-${phase}`, capture: () => ({ outcome: "succeeded", documents }),
    });
    try {
      if (phase === "return") assert.deepEqual(await recorded.stream.next(), { done: false, value: 1 });
      const error = await rejectionOf(phase === "next" ? recorded.stream.next() : recorded.stream.return());
      assert.ok(error instanceof HarnessError);
      assert.equal(error.code, phase === "next" ? "provider_iterator_result_invalid" : "provider_iterator_close_result_invalid");
      assert.equal(recorded.settlement?.work.status, "threw");
    } finally { restore(); recorder.store.close(); }
  });
}

test("a throwing capture factory reaches the recorder as unavailable evidence with no private detail", async () => {
  const { getDebugSignals, resetDebugSystem } = await import("../../src/shared/debug/debug-system.ts");
  const records: EffectRecord[] = [];
  const recorder = makeTimelineRecorder(createTempDir("provider-capture-throws-"), "capture-throws");
  setEffectSink(pairedObserver(sinkFor(recorder), (record) => { records.push(record); }));
  resetDebugSystem();
  const recorded = recordProviderStream(async function* () { yield 1; }, {
    name: "capture-throws", capture: () => { throw new Error("private capture detail"); },
  });
  try {
    assert.deepEqual(await recorded.stream.next(), { done: false, value: 1 });
    assertRequired(await rejectionOf(recorded.stream.next()));
    assert.equal(recorded.settlement?.work.status, "returned");
    assert.equal(recorded.settlement?.recording.status, "failed");
  } finally { setEffectSink(undefined); recorder.store.close(); }
  assert.equal(records.length, 1);
  assert.equal(records[0]!.outcome, "failed");
  assert.equal(records[0]!.error?.code, "required_recording_unavailable");
  assert.equal(JSON.stringify(records).includes("private capture detail"), false);
  // ONE capture failure is ONE report (a2-design L3: the outcome and the
  // documents callbacks each rethrew it, reporting it twice).
  assert.equal(getDebugSignals().bestEffortFailures, 1, "the failure reports once, through the central best-effort owner");
  resetDebugSystem();
});
