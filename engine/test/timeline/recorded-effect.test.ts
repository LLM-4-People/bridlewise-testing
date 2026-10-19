import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { Worker } from "node:worker_threads";
import assert from "node:assert/strict";
import test from "node:test";
import { getDebugSignals, resetDebugSystem } from "../../src/shared/debug/debug-system.ts";

import {
  RequiredRecordingError,
  recordRequiredEffectAsync,
  requireRecordedEffect,
  recordEffect,
  recordEffectAsync,
  recordEffectAuto,
  setEffectSink,
  type EffectRecord,
} from "../../src/timeline/recorded-effect.ts";
import { projectEffectDocuments } from "../../src/timeline/effect-documents.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { makeTimelineRecorder, installTimelineEffectSink } from "../support/timeline.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { thrownFailure } from "../support/factories.ts";
import { bindRecordingContext, currentRecordingContext, amendRecordingContext, UNATTRIBUTED, withRecordingContext } from "../../src/timeline/recording-context.ts";

/**
 * `recordEffect` — the wrapper that makes performing work the same act as
 * recording it.
 *
 * THE DEFECT THIS GUARDS
 *
 * `emit()` wrapped the sink call in a bare `catch {}`. A sink that throws on
 * every call — a full disk, a closed database handle, a serialization fault on
 * one field — therefore produced an EMPTY timeline and not one word about why.
 * That is the precise failure the module exists to prevent: recording that
 * cannot be forgotten, silently forgotten anyway. The sink is now invoked
 * through `bestEffort`, which keeps the observed work running (a broken logger
 * must not break the program) while making the dropped record observable.
 */

type Captured = { records: EffectRecord[]; warnings: string[]; restore: () => void };

function capture(sink?: (record: EffectRecord) => void): Captured {
  resetDebugSystem();
  const records: EffectRecord[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  setEffectSink(sink ?? ((record) => { records.push(record); }));
  return {
    records,
    warnings,
    restore: () => {
      console.warn = originalWarn;
      setEffectSink(undefined);
      resetDebugSystem();
    },
  };
}

test("recordEffect: a returning sync effect is recorded as succeeded, with its result untouched", () => {
  const c = capture();
  try {
    assert.equal(recordEffect("tool", "read", () => 7), 7);
    assert.equal(c.records.length, 1);
    assert.equal(c.records[0]!.outcome, "succeeded");
    assert.equal(c.records[0]!.kind, "tool");
    assert.equal(c.records[0]!.name, "read");
  } finally {
    c.restore();
  }
});

test("recordEffect: a throwing sync effect is recorded as failed and the error still propagates", () => {
  const c = capture();
  try {
    assert.throws(
      () => recordEffect("tool", "write", () => { throw new Error("disk full"); }),
      /disk full/u,
    );
    assert.equal(c.records.length, 1);
    assert.equal(c.records[0]!.outcome, "failed");
    assert.equal(c.records[0]!.error?.message, "disk full");
  } finally {
    c.restore();
  }
});

test("recordEffectAsync: the outcome is settled when the promise settles, not when it is created", async () => {
  const c = capture();
  try {
    const pending = recordEffectAsync("llm", "complete", async () => {
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error("upstream 503");
    });
    // The record must NOT exist yet: recording at return time would mark every
    // awaited effect "succeeded" the instant it started.
    assert.equal(c.records.length, 0, "an in-flight async effect must not be recorded yet");
    await assert.rejects(pending, /upstream 503/u);
    assert.equal(c.records.length, 1);
    assert.equal(c.records[0]!.outcome, "failed");
  } finally {
    c.restore();
  }
});

test("recordEffect: a result-signalled failure is recorded as failed via failedWhen", () => {
  const c = capture();
  try {
    const result = recordEffect(
      "tool",
      "unknownTool",
      () => ({ success: false, output: "no such tool" }),
      { failedWhen: (r) => !r.success },
    );
    assert.equal(result.success, false);
    assert.equal(c.records[0]!.outcome, "failed", "a choke point that returns failure must not read as success");
  } finally {
    c.restore();
  }
});

test("recordEffect: a THROWING sink neither breaks the work nor fails silently", () => {
  const c = capture(() => { throw new Error("ledger unavailable"); });
  try {
    // The observed work must still complete and return normally.
    assert.equal(recordEffect("git", "commit", () => "sha123"), "sha123");
    // ...and the dropped record must be reported, not swallowed.
    assert.deepEqual(c.warnings, ["[debug] diagnostic unavailable"]);
    assert.equal(getDebugSignals().bestEffortFailures, 1);
    assert.equal(c.warnings.join(" ").includes("ledger unavailable"), false);
  } finally {
    c.restore();
  }
});

test("recordEffect: a throwing sink on the async path is reported too", async () => {
  const c = capture(() => { throw new Error("ledger unavailable"); });
  try {
    assert.equal(await recordEffectAsync("file", "write", async () => "ok"), "ok");
    assert.deepEqual(c.warnings, ["[debug] diagnostic unavailable"]);
    assert.equal(getDebugSignals().bestEffortFailures, 1);
    assert.equal(c.warnings.join(" ").includes("ledger unavailable"), false);
  } finally {
    c.restore();
  }
});

test("recordEffect: nested effects share the trace established by the outermost span", () => {
  const c = capture();
  try {
    withRecordingContext({ actor: { kind: "agent", id: "a1" } }, () => {
      recordEffect("tool", "outer", () => {
        recordEffect("tool", "inner", () => 1);
        return 2;
      });
    });
    assert.equal(c.records.length, 2);
    const [inner, outer] = c.records;
    assert.equal(
      inner!.traceId,
      outer!.traceId,
      "causality must come from call structure, not from a caller threading ids",
    );
    assert.notEqual(inner!.spanId, outer!.spanId, "each effect gets its own span");
  } finally {
    c.restore();
  }
});

test("recordEffect: the ambient actor is recorded without any call site passing it", () => {
  const c = capture();
  try {
    withRecordingContext({ actor: { kind: "agent", id: "reviewer-1", role: "quality" } }, () => {
      recordEffect("tool", "grep", () => 0);
    });
    assert.equal(c.records.length, 1);
    // The point of the ambient context: `recordEffect` was called with no
    // actor argument, and the record still says WHO did it. The measured
    // defect was `actor_kind` being the constant "harness" on every event.
    assert.deepEqual(c.records[0]!.actor, { kind: "agent", id: "reviewer-1", role: "quality" });
  } finally {
    c.restore();
  }
});

test("recordEffect: an effect outside any boundary is visibly unattributed, not plausibly defaulted", () => {
  const c = capture();
  try {
    recordEffect("tool", "orphan", () => 0);
    assert.deepEqual(
      c.records[0]!.actor,
      UNATTRIBUTED,
      "an effect recorded outside any boundary must admit it has no owner rather than " +
        "inheriting a plausible-looking default",
    );
  } finally {
    c.restore();
  }
});

test("recordEffect: with no sink installed the work still runs", () => {
  setEffectSink(undefined);
  assert.equal(recordEffect("tool", "noop", () => "fine"), "fine");
});

// ── Resource deltas — the cost of the work, measured at the same choke point ──

test("recordEffect: the record carries the CPU and heap deltas beside the duration", () => {
  const c = capture();
  try {
    recordEffect("tool", "measure", () => {
      // Real work, so the CPU reading has something to be about.
      let acc = 0;
      for (let i = 0; i < 50_000; i++) acc += i;
      return acc;
    });
    assert.equal(c.records.length, 1);
    const record = c.records[0]!;
    assert.equal(typeof record.cpuMs, "number", "cpuMs must be a number");
    assert.equal(typeof record.heapDeltaBytes, "number", "heapDeltaBytes must be a number");
    assert.ok(
      record.cpuMs! >= 0,
      `cpu time is a cost, never a gain: got ${record.cpuMs}`,
    );
    assert.ok(
      Number.isFinite(record.heapDeltaBytes),
      `heap delta must be finite: got ${record.heapDeltaBytes}`,
    );
  } finally {
    c.restore();
  }
});

test("recordEffectAsync: the deltas cover the WHOLE window, not just the start", async () => {
  const c = capture();
  try {
    await recordEffectAsync("llm", "slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      let acc = 0;
      for (let i = 0; i < 50_000; i++) acc += i;
      return acc;
    });
    const record = c.records[0]!;
    assert.equal(typeof record.cpuMs, "number");
    // The probe is stopped at emit time — when the promise settles — so the
    // reading belongs to the same window as durationMs. A probe stopped at
    // creation would read ~0 for a window that demonstrably burned CPU.
    assert.ok(
      record.cpuMs! > 0,
      `a window that ran a loop must show CPU cost, got ${record.cpuMs}`,
    );
  } finally {
    c.restore();
  }
});

// ── argsOf — "what arguments it used", redacted by the call site ──

test("recordEffect: argsOf is read once at emit time and carried on the record", () => {
  const c = capture();
  try {
    let reads = 0;
    recordEffect("tool", "argsful", () => "done", {
      argsOf: () => {
        reads += 1;
        return { path: "a.ts" };
      },
    });
    assert.equal(reads, 1, "the getter is read exactly once, at emit time");
    assert.deepEqual(c.records[0]!.args, { path: "a.ts" });
  } finally {
    c.restore();
  }
});

test("recordEffect: args travel on the FAILED paths too — result-signalled and thrown", () => {
  const c = capture();
  try {
    recordEffect("tool", "sigfail", () => ({ success: false }), {
      failedWhen: (r) => !r.success,
      argsOf: () => ({ attempt: 1 }),
    });
    assert.deepEqual(c.records[0]!.args, { attempt: 1 }, "a result-signalled failure still answers with what arguments it used");
    assert.throws(
      () => recordEffect("tool", "thrown", () => { throw new Error("boom"); }, { argsOf: () => ({ attempt: 2 }) }),
      /boom/u,
    );
    assert.deepEqual(c.records[1]!.args, { attempt: 2 }, "a thrown effect still answers with what arguments it used — the invocation existed");
  } finally {
    c.restore();
  }
});

test("recordEffect: a THROWING argsOf costs the args, never the work", () => {
  const c = capture();
  try {
    const result = recordEffect("tool", "badargs", () => 42, {
      argsOf: () => { throw new Error("redactor exploded"); },
    });
    assert.equal(result, 42, "the work is untouched");
    assert.equal(c.records.length, 1, "the record still lands");
    assert.equal(c.records[0]!.args, undefined, "only the args are lost");
    assert.equal(c.records[0]!.outcome, "succeeded");
  } finally {
    c.restore();
  }
});

test("recordEffect: the span id conforms to the ledger's identifier grammar even for spaced names", () => {
  const c = capture();
  try {
    // The http choke point names effects "METHOD /route" — a space, which is
    // OUTSIDE the ledger's identifier alphabet. Measured defect: the first
    // http effect was refused wholesale ("Timeline identifier is invalid")
    // because its span id embedded the raw name. The mint conforms the name
    // so the event stores, while the description keeps the readable form.
    recordEffect("http", "GET /api/chats/:id", () => "served");
    const record = c.records[0]!;
    assert.match(
      record.spanId,
      /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
      `the span id must be a valid ledger identifier, got: ${record.spanId}`,
    );
    assert.equal(record.name, "GET /api/chats/:id", "the readable name is not mangled for the description");
  } finally {
    c.restore();
  }
});

test("recordEffect: argsOf is not read when there is no sink to receive it", () => {
  setEffectSink(undefined);
  let reads = 0;
  try {
    recordEffect("tool", "nosink", () => 1, {
      argsOf: () => { reads += 1; return {}; },
    });
    assert.equal(reads, 0, "redaction work is not paid for a record nobody will store");
  } finally {
    setEffectSink(undefined);
  }
});

// ── recordEffectAuto — the shape-agnostic entry point the boundary
// decoration needs. A decorator applied to a whole module's exported
// functions cannot know which are sync and which settle promises; this
// variant decides per call, on the result.

test("recordEffectAuto: a sync result settles immediately, succeeded, result untouched", () => {
  const c = capture();
  try {
    assert.equal(recordEffectAuto("engine", "plain", () => 11), 11);
    assert.equal(c.records.length, 1);
    assert.equal(c.records[0]!.outcome, "succeeded");
    assert.equal(c.records[0]!.kind, "engine");
    assert.equal(c.records[0]!.name, "plain");
    assert.ok(typeof c.records[0]!.durationMs === "number");
  } finally {
    c.restore();
  }
});

test("recordEffectAuto: a thrown sync error settles failed and the error still propagates", () => {
  const c = capture();
  try {
    assert.throws(
      () => recordEffectAuto("engine", "explodes", () => { throw new Error("boom-sync"); }),
      (err: unknown) => err instanceof Error && err.message === "boom-sync",
    );
    assert.equal(c.records.length, 1);
    assert.equal(c.records[0]!.outcome, "failed");
    assert.equal(c.records[0]!.error?.message, "boom-sync");
  } finally {
    c.restore();
  }
});

test("recordEffectAuto: a thenable settles the record at settlement, not at creation", async () => {
  const c = capture();
  try {
    const result = recordEffectAuto("engine", "lazy", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "settled-value";
    });
    assert.equal(c.records.length, 0, "the record must not exist before the promise settles");
    const value = await result;
    assert.equal(value, "settled-value", "the caller sees the resolved value");
    assert.equal(c.records.length, 1);
    assert.equal(c.records[0]!.outcome, "succeeded");
    assert.ok(c.records[0]!.durationMs >= 4, "the duration covers the awaited window, not the call");
  } finally {
    c.restore();
  }
});

test("recordEffectAuto: a rejected thenable settles failed, and the rejection still reaches the caller", async () => {
  const c = capture();
  try {
    const result = recordEffectAuto("engine", "rejects", async () => {
      throw new Error("boom-async");
    });
    await assert.rejects(result, (err: unknown) => err instanceof Error && err.message === "boom-async");
    assert.equal(c.records.length, 1);
    assert.equal(c.records[0]!.outcome, "failed");
    assert.equal(c.records[0]!.error?.message, "boom-async");
  } finally {
    c.restore();
  }
});

test("recordEffectAuto: the ORIGINAL promise identity is returned — the record rides along, never interposes", async () => {
  const c = capture();
  try {
    const original = Promise.resolve("identity-value");
    const returned = recordEffectAuto("engine", "identity", () => original);
    assert.equal(returned, original, "the wrapper must hand back the same thenable it was given");
    await original;
    assert.equal(c.records.length, 1);
  } finally {
    c.restore();
  }
});

test("recordEffectAuto: failedWhen classifies a result-signalled failure on the sync path", () => {
  const c = capture();
  try {
    recordEffectAuto("engine", "signalled", () => ({ ok: false }), {
      failedWhen: (result) => !result.ok,
      errorOf: () => ({ message: "the call reported failure by return value" }),
    });
    assert.equal(c.records.length, 1);
    assert.equal(c.records[0]!.outcome, "failed");
    assert.equal(c.records[0]!.error?.message, "the call reported failure by return value");
  } finally {
    c.restore();
  }
});

test("recordEffectAuto: argsOf is consulted on the async settlement path too", async () => {
  const c = capture();
  try {
    await recordEffectAuto("engine", "async-args", async () => "done", {
      argsOf: () => ({ count: 1, args: [{ type: "string", bytes: 5 }] }),
    });
    assert.equal(c.records.length, 1);
    assert.deepEqual(c.records[0]!.args, { count: 1, args: [{ type: "string", bytes: 5 }] });
  } finally {
    c.restore();
  }
});

// Required completion evidence is an explicit contract beside optional telemetry.
test("required recording returns a real receipt and keeps failed work receipts without retrying", async () => {
  const recorder = makeTimelineRecorder(createTempDir("required-effect-"), "required");
  const restore = installTimelineEffectSink(recorder);
  try {
    const result = await recordRequiredEffectAsync("llm", "native", async () => 17);
    const recorded = requireRecordedEffect(result);
    assert.equal(recorded.value, 17);
    assert.equal(recorder.store.getEvent(recorded.receipt.eventId)?.outcome, "succeeded");
    for (const failure of [new Error("private source"), undefined]) {
      const failed = await recordRequiredEffectAsync("llm", "failed", async () => { throw failure; });
      assert.equal(failed.work.status, "threw");
      assert.equal(failed.recording.status, "recorded");
      if (failed.recording.status === "recorded") {
        assert.equal(recorder.store.getEvent(failed.recording.receipt.eventId)?.outcome, "failed");
      }
      let threw = false;
      try { requireRecordedEffect(failed); } catch (error) { threw = true; assert.equal(error, failure); }
      assert.equal(threw, true);
    }
    assert.equal(recorder.store.query({ ledgerId: recorder.ledgerId }).length, 3);
  } finally { restore(); recorder.store.close(); }
});

for (const mode of ["absent", "void", "throw"] as const) {
  test(`required recording: ${mode} sink refuses once while preserving source failures`, async () => {
    let calls = 0;
    let workCalls = 0;
    setEffectSink(mode === "absent" ? undefined : () => { calls++; if (mode === "throw") throw new Error("private sink"); });
    try {
      const result = await recordRequiredEffectAsync("llm", "native", async () => { workCalls++; return 1; });
      assert.throws(() => requireRecordedEffect(result), (error: unknown) => error instanceof RequiredRecordingError && error.code === "required_recording_unavailable" && error.message === "Required effect recording is unavailable");
      assert.equal(workCalls, 1);
      assert.equal(calls, mode === "absent" ? 0 : 1);
      const failed = await recordRequiredEffectAsync("llm", "native", async () => { throw undefined; });
      let threw = false;
      try { requireRecordedEffect(failed); } catch (error) { threw = true; assert.equal(error, undefined); }
      assert.equal(threw, true);
      assert.equal(calls, mode === "absent" ? 0 : 2);
    } finally { setEffectSink(undefined); }
  });
}

for (const field of ["documentsOf", "argsOf", "outcomeOf"] as const) {
  for (const thrown of ["Error", "undefined"] as const) {
    test(`required ${field} capture failure refuses with one actual failed record (${thrown})`, async () => {
      const failure = thrownFailure(thrown, "private capture");
      const recorder = makeTimelineRecorder(createTempDir("required-capture-"), "capture");
      const restore = installTimelineEffectSink(recorder);
      let calls = 0;
      try {
        const result = await recordRequiredEffectAsync("llm", "native", async () => "ok", {
          [field]: () => { calls++; throw failure; },
        });
        assert.throws(() => requireRecordedEffect(result), (error: unknown) => error instanceof RequiredRecordingError && error.code === "required_recording_unavailable" && error.message === "Required effect recording is unavailable");
        assert.equal(calls, 1);
        assert.equal(result.recording.status, "failed");
        assert.ok(result.recording.receipt);
        assert.equal(recorder.store.getEvent(result.recording.receipt.eventId)?.outcome, "failed");
        assert.equal(recorder.store.query({ ledgerId: recorder.ledgerId }).length, 1);
      } finally { restore(); recorder.store.close(); }
    });
  }
}

test("bound absent recording context stays absent across foreign context, await and throw", async () => {
  assert.equal(currentRecordingContext(), undefined);
  const bound = bindRecordingContext();
  const failure = new Error("scope control");
  await withRecordingContext({ actor: { kind: "test", id: "foreign" }, runId: "foreign-run" }, async () => {
    await bound(async () => {
      assert.equal(currentRecordingContext(), undefined);
      assert.equal(amendRecordingContext({ runId: "invented" }), false);
      await Promise.resolve();
      assert.equal(currentRecordingContext(), undefined);
    });
    assert.equal(currentRecordingContext()?.runId, "foreign-run");
    assert.throws(() => bound(() => { assert.equal(currentRecordingContext(), undefined); throw failure; }), (error) => error === failure);
    assert.equal(currentRecordingContext()?.runId, "foreign-run");
  });
  assert.equal(currentRecordingContext(), undefined);
});

for (const [shape, text] of [["bmp", "界"], ["astral", "😀"], ["mixed-escaped", "a界😀\n\""]] as const) {
  test(`bounded effect preview is an exact original prefix for ${shape} text`, () => {
    const contentJson = JSON.stringify({ x: text.repeat(1000) });
    const record: EffectRecord = { kind: "llm", name: "preview", outcome: "succeeded", durationMs: 1, spanId: "span", traceId: "trace", actor: UNATTRIBUTED,
      documents: [{ name: "payload", contentJson, contentDigest: sha256(contentJson) }] };
    const docs = projectEffectDocuments(record, { maxDocumentBytes: 512, resourceDeltasEnabled: false });
    const doc = docs.find((item) => item.name === "payload")!;
    const envelope = JSON.parse(doc.contentJson!);
    assert.equal(envelope.truncated, true);
    assert.equal(contentJson.startsWith(envelope.preview), true);
    assert.equal(envelope.fullPayloadDigest, sha256(contentJson));
    assert.equal(envelope.fullPayloadBytes, Buffer.byteLength(contentJson));
    assert.equal(doc.contentDigest, sha256(doc.contentJson!));
    assert.ok(Buffer.byteLength(doc.contentJson!) <= 512);
    assert.throws(() => projectEffectDocuments(record, { maxDocumentBytes: 1, resourceDeltasEnabled: false }), (error: unknown) => error instanceof InputError && error.code === "effect_document_limit");
  });
}

test("required unwrap never admits a terminal receipt with unavailable paired intent", () => {
  const refusal = new RequiredRecordingError();
  for (const intent of [{ status: "failed" as const, error: refusal }, { status: "not-attempted" as const }]) {
    assert.throws(() => requireRecordedEffect({ work: { status: "returned", value: 1 }, intent,
      recording: { status: "recorded", receipt: { eventId: "irrelevant", sequence: "1", chainHash: "0".repeat(64) } },
    }), (error: unknown) => error instanceof RequiredRecordingError && error.code === "required_recording_unavailable");
  }
});

for (const defect of ["digest", "unicode"] as const) {
  test(`effect documents refuse invalid original ${defect} before fitting`, () => {
    const contentJson = "prefix".repeat(1000) + (defect === "unicode" ? "\ud800" : "suffix");
    const record: EffectRecord = { kind: "llm", name: "original", outcome: "succeeded", durationMs: 1, spanId: "span", traceId: "trace", actor: UNATTRIBUTED,
      documents: [{ name: "payload", contentJson, contentDigest: defect === "digest" ? sha256("wrong") : sha256(contentJson) }] };
    assert.throws(() => projectEffectDocuments(record, { maxDocumentBytes: 512, resourceDeltasEnabled: false }),
      (error: unknown) => error instanceof InputError && error.code === (defect === "digest" ? "timeline_document_digest_mismatch" : "ledger_json_unicode_invalid"));
  });
}

test("effect documents capture the document field, array and values before invoking caller accessors", () => {
  let reads = 0;
  const doc = { name: "proof", contentJson: "proof", contentDigest: sha256("proof") };
  const array = [doc];
  Object.defineProperty(array, "0", { enumerable: true, get() { reads++; return doc; } });
  const proxy = new Proxy([doc], { get() { reads++; throw new Error("proxy trap"); }, ownKeys() { reads++; throw new Error("proxy trap"); } });
  const base = { kind: "llm", name: "capture", outcome: "succeeded", durationMs: 1, spanId: "span", traceId: "trace", actor: UNATTRIBUTED } as const;
  const records = [
    { ...base, get documents() { reads++; return [doc]; } },
    Object.assign(Object.create({ documents: [doc] }) as object, base) as EffectRecord,
    Object.assign(Object.create({ get documents() { reads++; return [doc]; } }) as object, base) as EffectRecord,
    { ...base, documents: array },
    { ...base, documents: proxy },
    { ...base, documents: [{ ...doc, get contentJson() { reads++; return "proof"; } }] },
  ];
  for (const record of records) {
    assert.throws(() => projectEffectDocuments(record, { maxDocumentBytes: 512, resourceDeltasEnabled: false }), (error: unknown) => error instanceof InputError);
    assert.equal(reads, 0, "no supplied document accessor or proxy trap may run");
  }
  const internal = { ...base, documents: undefined, args: undefined, error: undefined } as unknown as EffectRecord;
  assert.equal(projectEffectDocuments(internal, { maxDocumentBytes: 512, resourceDeltasEnabled: false }).length, 1, "owned EffectRecord absent fields keep their internal undefined representation");
});


// Keyed by each original's UTF-8 byte length, so the test name is static.
const ORDERED_ORIGINALS_BY_BYTES = { "0": "", "512": "x".repeat(512), "513": "x".repeat(510) + "界" };

for (const bytes of Object.keys(ORDERED_ORIGINALS_BY_BYTES) as (keyof typeof ORDERED_ORIGINALS_BY_BYTES)[]) {
  test(`effect documents preserve ordered originals or explicitly fit them at ${bytes} bytes`, () => {
    const text = ORDERED_ORIGINALS_BY_BYTES[bytes];
    assert.equal(Buffer.byteLength(text), Number(bytes));
    const record: EffectRecord = { kind: "llm", name: "ordered", outcome: "succeeded", durationMs: 1, spanId: "span", traceId: "trace", actor: UNATTRIBUTED,
      documents: [{ name: "ordered", orderedJson: text, contentDigest: sha256(text) }] };
    const document = projectEffectDocuments(record, { maxDocumentBytes: 512, resourceDeltasEnabled: false }).find((doc) => doc.name === "ordered")!;
    if (Buffer.byteLength(text) <= 512) {
      assert.deepEqual({ ...document }, record.documents![0]);
    } else {
      assert.equal(document.orderedJson, undefined);
      assert.equal(document.contentDigest, sha256(document.contentJson!));
      assert.ok(Buffer.byteLength(document.contentJson!) <= 512);
      const envelope = JSON.parse(document.contentJson!);
      assert.equal(envelope.fullPayloadDigest, sha256(text)); assert.equal(envelope.fullPayloadBytes, Buffer.byteLength(text));
      assert.equal(envelope.truncated, true); assert.equal(text.startsWith(envelope.preview), true);
    }
  });
}


test("effect document invalid caps refuse in a bounded worker instead of entering a nonterminating fitter", async () => {
  const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(`
    import { parentPort, workerData } from "node:worker_threads";
    const { projectEffectDocuments } = await import(workerData.url);
    parentPort.postMessage({ ready: true });
    const codes = [];
    for (const maxDocumentBytes of [NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, workerData.maximumBytes + 1]) {
      try { projectEffectDocuments({ kind: "llm", name: "cap", outcome: "succeeded", durationMs: 1 }, { maxDocumentBytes, resourceDeltasEnabled: false }); codes.push("accepted"); }
      catch (error) { codes.push(error.code); }
    }
    parentPort.postMessage({ codes }); parentPort.close();
  `)), { workerData: { url: new URL("../../src/timeline/effect-documents.ts", import.meta.url).href, maximumBytes: ROOT_POLICY.timeline.limits.maxDocumentBytes } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const codes = await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("cap worker did not become ready")), 5000);
      worker.on("error", reject);
      worker.on("message", (message: { ready?: boolean; codes?: unknown }) => {
        if (message.ready) { clearTimeout(timer); timer = setTimeout(() => reject(new Error("invalid cap did not refuse after worker readiness")), 1000); }
        else resolve(message.codes);
      });
      worker.on("exit", (code) => { if (code !== 0) reject(new Error(`cap worker exit ${code}`)); });
    });
    assert.deepEqual(codes, Array(8).fill("timeline_document_limit_invalid"));
  } finally { clearTimeout(timer); await worker.terminate(); }
});


test("effect document fitter uses the byte limit value it admitted once", () => {
  let reads = 0;
  const contentJson = "x".repeat(1000);
  const record: EffectRecord = { kind: "llm", name: "limit", outcome: "succeeded", durationMs: 1, spanId: "span", traceId: "trace", actor: UNATTRIBUTED, documents: [{ name: "payload", contentJson, contentDigest: sha256(contentJson) }] };
  const documents = projectEffectDocuments(record, { get maxDocumentBytes() { return ++reads === 1 ? 512 : Infinity; }, resourceDeltasEnabled: false });
  assert.equal(reads, 1);
  assert.ok(documents.every((document) => Buffer.byteLength(document.contentJson ?? document.orderedJson ?? "") <= 512));
  assert.equal(JSON.parse(documents.find((document) => document.name === "payload")!.contentJson!).truncated, true);
});
