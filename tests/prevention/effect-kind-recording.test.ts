// @vitest-environment node
/**
 * Mechanical enforcement: every DECLARED effect kind is PRODUCED at its real
 * choke point, into the REAL ledger, with REAL attribution.
 *
 * THE MEASURED DEFECT
 *
 * The sink's kind table declared six effect kinds; only `tool` had a
 * producing call site. `git`, `llm`, `process` and `filesystem` were lanes
 * that could never hold an event — work happened with no timeline trace.
 * The ratchet in recording-choke-points.test.ts (class F) now stands at ZERO
 * unproduced kinds; this file proves each kind's wrap BEHAVIOURALLY — the
 * effect actually lands in the ledger, attributed to the ambient actor —
 * rather than by source text alone.
 *
 * Choke points under test (each is the single place its work executes, so
 * recording there cannot be bypassed):
 *   git        — server/git-bridge.ts::gitText. The ONLY git spawn site in
 *                `server/`. Mutating invocations record; read-only do NOT
 *                (read-only git is not an effect, and the status poll would
 *                flood the ledger).
 *   llm        — server/llm-bridge.ts::recordProviderStream. ONE effect per
 *                provider call — never per token — with the real streamed
 *                duration. A source guard pins streamChat's consumption of
 *                `client.stream` THROUGH the wrapper, because the
 *                behavioural test drives the wrapper with a controlled
 *                stream (no live provider in CI).
 *   process    — server/tool-executor.ts::spawnSyncSafe (execute_command)
 *                and server/auto-check-runner.ts::spawnCapture (check
 *                subprocesses), both exercised through their PRODUCTION
 *                entry points (executeToolCall / runAutoCheck).
 *   filesystem — the mkdir route in server/routes/filesystem.ts, exercised
 *                over real HTTP so attribution comes from the router's
 *                recording boundary (the authenticated user), not a
 *                test-supplied context.
 *
 * All events are read back through the PUBLIC query of the real timeline
 * singleton — recorder, sink, store and query in one chain. Each test uses a
 * UNIQUE actor id (or unique effect name) so it finds only its own events in
 * the shared ledger.
 *
 * Mutation-verified (unwrap → red → restore), per kind — see the change
 * report accompanying this file.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// THE PROVIDER SEAM IS STUBBED (the only thing stubbed) so the REAL
// streamChat → buildLLMMessages → capture chain can be driven without a live
// provider. The factory and the scripted state live in the shared helper —
// this file only declares the mock where vitest can hoist it.
vi.mock("../../engine/src/shared/llm/client.ts", async () => {
  const { stubLlmClientModule } = await import("../helpers/stub-llm-client.ts");
  return stubLlmClientModule();
});

// Set the project root BEFORE config resolves so the filesystem route's
// allowed-roots gate admits the temp parent directory used by the mkdir test.
await vi.hoisted(async () => {
  const { createTempDir } = await import("../helpers/temp-dir.ts");
  process.env.HARNESS_WEB_PROJECT_ROOT = createTempDir("ch-effect-kinds-root-");
});

import { read, stripCommentsOnly } from "../helpers/source-scan.ts";
import { hubDecoratedPopulation } from "../helpers/hub-population.ts";
import { isEngineSpan, ENGINE_SPAN_EXCLUSIONS } from "../../engine/src/performance/engine-instrumentation.ts";
import * as canonicalHub from "../../server/kernel/canonical.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { stubLlmProviderScript, resetStubLlmProvider, setStubLlmProviderAttempts } from "../helpers/stub-llm-client.ts";
import { getTimelineQuery } from "../../server/observability/timeline-bridge.ts";
import { withRecordingContext, generateId, currentActor, createToolCallGate } from "../../server/kernel/canonical.ts";
import { gitText } from "../../server/intelligence/git-bridge.ts";
import { recordProviderStream, streamChat } from "../../server/llm/llm-bridge.ts";
import { parseProviderStore, resolveProviderCredential } from "../../server/llm/providers.ts";
import { executeToolCall } from "../../server/tools/tool-executor.ts";
import { runAutoCheck } from "../../server/awareness/auto-check-runner.ts";
import { registerFilesystemRoutes } from "../../server/routes/filesystem.ts";
import { sendJson } from "../../server/router/router.ts";
import { resetRateLimiter } from "../../server/router/rate-limiter.ts";
import { BadRequestError } from "../../server/kernel/errors.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { sha256 } from "../../server/kernel/digest.ts";
import { getTimelineConfig } from "../../server/kernel/harness-config.ts";
import {
  TIMELINE_EFFECT_TIMING_DOCUMENT,
  TIMELINE_EFFECT_ARGS_DOCUMENT,
  TIMELINE_LLM_REQUEST_DOCUMENT,
  TIMELINE_LLM_RESPONSE_DOCUMENT,
  TIMELINE_GATE_BLOCK_DOCUMENT,
  TRACE_ID_HEADER,
} from "../../shared/constants.ts";

import { modulePath } from "../helpers/module-resolver.ts";
import { PROVIDER_FIXTURE_OWNER } from "../helpers/multi-user.ts";
// Open the timeline BEFORE any effect runs: the sink is installed lazily on
// first open, and an effect emitted before installation is dropped (the
// production server opens the timeline at startup; a test must do the same).
beforeAll(() => {
  getTimelineQuery();
});

/** Newest-first events of one ledger event type. */
function eventsOf(eventType: "git" | "provider" | "process" | "filesystem" | "tool" | "network" | "db" | "engine") {
  return getTimelineQuery().byEventType(eventType, { ascending: false, limit: 500 }).events;
}

/** The events of `eventType` attributed to `actorId` (the test's unique id). */
function eventsFor(eventType: "git" | "provider" | "process" | "filesystem" | "tool" | "network" | "db" | "engine", actorId: string) {
  return eventsOf(eventType).filter((e) => e.actorId === actorId);
}

/** A unique per-test actor, so the shared ledger yields only this test's rows. */
function testActor(label: string) {
  return { kind: "user", id: `effect-kind-test-${label}-${randomUUID()}` } as const;
}

/** Run `fn` attributed to a fresh unique actor; returns the actor id. */
async function attributed<T>(label: string, fn: () => T | Promise<T>): Promise<string> {
  const actor = testActor(label);
  await withRecordingContext({ actor }, async () => fn());
  // The async effect record is emitted on the microtask after its deferred
  // settles; yield once so the append has happened before the query reads.
  await new Promise((r) => setImmediate(r));
  return actor.id;
}

/** The parsed effect-timing document of an event, or null. */
function timingOf(event: { documents?: readonly { name: string; contentJson: string | null }[] }): { durationMs: number; cpuMs?: number; heapDeltaBytes?: number } | null {
  for (const doc of event.documents ?? []) {
    if (doc.name === TIMELINE_EFFECT_TIMING_DOCUMENT && doc.contentJson !== null) {
      return JSON.parse(doc.contentJson) as { durationMs: number; cpuMs?: number; heapDeltaBytes?: number };
    }
  }
  return null;
}

/** The parsed effect-args document of an event, or null. */
function argsOfEvent(event: { documents?: readonly { name: string; contentJson: string | null }[] }): unknown | null {
  for (const doc of event.documents ?? []) {
    if (doc.name === TIMELINE_EFFECT_ARGS_DOCUMENT && doc.contentJson !== null) {
      return JSON.parse(doc.contentJson) as unknown;
    }
  }
  return null;
}

// ── git — mutating operations record; read-only operations do not ──

describe("git effects — gitText is the choke point", () => {
  let repoDir: string;

  beforeAll(() => {
    repoDir = createTempDir("ch-effect-git-");
  });

  test("a MUTATING git operation lands in the ledger, attributed, succeeded", async () => {
    const actorId = await attributed("git-init", () => {
      const out = gitText(repoDir, ["init"]);
      expect(out, "git init must actually succeed for this test to mean anything").not.toBeNull();
    });
    const events = eventsFor("git", actorId);
    expect(events.length, "a mutating git operation must appear in the git lane").toBe(1);
    expect(events[0]!.description).toBe("git:init");
    expect(events[0]!.outcome).toBe("succeeded");
    expect(timingOf(events[0]!), "the effect must carry its real measured duration").not.toBeNull();
  });

  test("a FAILED mutating git operation records outcome=failed with the real detail", async () => {
    const noRepo = createTempDir("ch-effect-git-norepo-");
    const actorId = await attributed("git-fail", () => {
      // `git commit` outside any repository fails by RETURNING null — a
      // result-signalled failure, which is exactly what `failedWhen` exists
      // to classify.
      expect(gitText(noRepo, ["commit", "-m", "x"])).toBeNull();
    });
    const events = eventsFor("git", actorId);
    expect(events.length).toBe(1);
    expect(events[0]!.outcome).toBe("failed");
    expect(events[0]!.errorCode).toBe("git_failed");
    expect(
      events[0]!.errorMessage ?? "",
      "the recorded failure must carry git's real complaint, not a bare outcome",
    ).toMatch(/exit \d+|not a git repository/i);
  });

  test("a READ-ONLY git operation records NOTHING (reads are not effects)", async () => {
    const actorId = await attributed("git-read", () => {
      expect(gitText(repoDir, ["status", "--porcelain=v1"]), "the read itself must work").not.toBeNull();
      expect(gitText(repoDir, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
      // The branch LISTING form is read-only even though `branch` can mutate.
      expect(gitText(repoDir, ["branch", "-a", "--format=%(refname:short)"])).not.toBeNull();
    });
    expect(
      eventsFor("git", actorId),
      "read-only git must not be recorded — the status poll alone would flood the ledger",
    ).toEqual([]);
  });
});

// ── llm — one effect per provider call, real duration, never per token ──

describe("llm effects — recordProviderStream is the choke point", () => {
  async function* chunks(count: number, delayMs: number, failAfter?: number): AsyncGenerator<string> {
    for (let i = 0; i < count; i += 1) {
      await new Promise((r) => setTimeout(r, delayMs));
      if (failAfter !== undefined && i >= failAfter) throw new Error("provider exploded mid-stream");
      yield `chunk-${i}`;
    }
  }

  test("one provider call = ONE llm event with the real streamed duration", async () => {
    const model = `test-model-${randomUUID()}`;
    const received: string[] = [];
    const actorId = await attributed("llm-ok", async () => {
      for await (const c of recordProviderStream(model, chunks(3, 15))) received.push(c);
    });
    expect(received, "the wrapper must pass every chunk through unchanged").toEqual([
      "chunk-0", "chunk-1", "chunk-2",
    ]);
    const events = eventsFor("provider", actorId);
    expect(events.length, "exactly ONE event per provider call — never per token/chunk").toBe(1);
    expect(events[0]!.description).toBe(`llm:${model}`);
    expect(events[0]!.outcome).toBe("succeeded");
    const timing = timingOf(events[0]!);
    expect(timing).not.toBeNull();
    // 3 chunks x 15ms of real streaming; the recorded duration is measured,
    // not fabricated, so it must reflect that wall time (margin for timer
    // slop).
    expect(timing!.durationMs).toBeGreaterThanOrEqual(30);
  });

  test("a provider error records outcome=failed with the real message, and rethrows", async () => {
    const model = `test-model-${randomUUID()}`;
    const actorId = await attributed("llm-fail", async () => {
      await expect(async () => {
        for await (const c of recordProviderStream(model, chunks(3, 1, 1))) void c;
      }).rejects.toThrow("provider exploded mid-stream");
    });
    const events = eventsFor("provider", actorId);
    expect(events.length).toBe(1);
    expect(events[0]!.outcome).toBe("failed");
    expect(events[0]!.errorMessage).toContain("provider exploded mid-stream");
  });

  test("the timing document carries the measured resource deltas beside the duration", async () => {
    // The wrapper measures what the work COST the process (CPU time + heap
    // growth) across the same window as its duration, and the sink writes
    // the readings into the ONE timing document — never a second document
    // type. Driven through the real wrapper into the real ledger.
    const model = `resource-model-${randomUUID()}`;
    const actorId = await attributed("llm-resource", async () => {
      for await (const c of recordProviderStream(model, chunks(2, 5))) void c;
    });
    const events = eventsFor("provider", actorId);
    expect(events.length).toBe(1);
    const timing = timingOf(events[0]!);
    expect(timing, "the timing document must exist").not.toBeNull();
    expect(typeof timing!.cpuMs, "the CPU delta rides the timing document").toBe("number");
    expect(typeof timing!.heapDeltaBytes, "the heap delta rides the timing document").toBe("number");
    expect(timing!.cpuMs ?? -1, "cpu time is a cost, never a gain").toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(timing!.heapDeltaBytes)).toBe(true);
  });

  test("consumer abandonment settles the record CANCELLED — an abandoned stream is not a success", async () => {
    // THE MEASURED DISHONESTY this arm closes: a consumer that stopped
    // pulling (the run was stopped, the client disconnected) ran the
    // generator's `finally`, which settled the record SUCCEEDED — a stream
    // cut short recorded as a completed provider call. The honest outcome is
    // the registry's own word: cancelled, which the failure-disposition
    // table rightly does NOT count as a failure (nothing faulted — the work
    // stopped), and which a reader can tell apart from both ends.
    const model = `test-model-${randomUUID()}`;
    const actorId = await attributed("llm-abandon", async () => {
      for await (const c of recordProviderStream(model, chunks(10, 1))) {
        void c;
        break; // the run route may stop consuming early; the record must still land
      }
    });
    const events = eventsFor("provider", actorId);
    expect(events.length).toBe(1);
    expect(events[0]!.outcome, "an abandoned stream settles cancelled, never succeeded").toBe("cancelled");
    expect(events[0]!.errorCode).toBe("llm_stream_cancelled");
  });

  test("an ABORTED stream settles CANCELLED even when the provider wraps the abort in its own error shape", async () => {
    // The classification trusts the CALLER'S abort signal over the error's
    // name: a provider that wraps the abort in its own error type still
    // describes a cancelled stream, and recording it `failed` would blame
    // the server for the user's own stop.
    const model = `test-model-${randomUUID()}`;
    async function* exploding(): AsyncGenerator<string> {
      yield "chunk-0";
      throw new Error("provider's own wrapper around an aborted request");
    }
    const actorId = await attributed("llm-abort", async () => {
      await expect(async () => {
        for await (const c of recordProviderStream(model, exploding(), undefined, undefined, () => true)) void c;
      }).rejects.toThrow("provider's own wrapper");
    });
    const events = eventsFor("provider", actorId);
    expect(events.length).toBe(1);
    expect(events[0]!.outcome, "the signal's word wins over the error's shape").toBe("cancelled");
    expect(events[0]!.errorCode).toBe("llm_stream_cancelled");
  });

  test("an abort-SHAPED thrown error settles cancelled without a signal reader", async () => {
    const model = `test-model-${randomUUID()}`;
    async function* aborting(): AsyncGenerator<string> {
      yield "chunk-0";
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    const actorId = await attributed("llm-abort-shape", async () => {
      await expect(async () => {
        for await (const c of recordProviderStream(model, aborting())) void c;
      }).rejects.toThrow("The operation was aborted");
    });
    const events = eventsFor("provider", actorId);
    expect(events.length).toBe(1);
    expect(events[0]!.outcome).toBe("cancelled");
  });

  test("streamChat consumes the provider stream THROUGH the recording wrapper", () => {
    // The behavioural tests above drive the wrapper directly (no live
    // provider in CI), so this guard pins the PRODUCTION wiring: unwrapping
    // `client.stream` in streamChat is a bypass of the choke point.
    const src = stripCommentsOnly(read(modulePath("llm-bridge.ts")));
    expect(
      src,
      "streamChat must iterate recordProviderStream(model, client.stream(…)) — a bare " +
        "`client.stream` consumption is an unrecorded provider call",
    ).toMatch(/recordProviderStream\s*\(\s*model\s*,\s*client\.stream\s*\(/);
    expect(src).not.toMatch(/for await \(const \w+ of client\.stream\s*\(/);
  });

  // ── THE PROVIDER INTERACTION IS CAPTURED ON THE PROVIDER EVENT ──────────
  //
  // A developer investigating a past run must be able to read the exact
  // redacted messages the provider received and the response it assembled.
  // These tests drive the REAL streamChat (only the provider transport is
  // stubbed) and read the documents back out of the REAL ledger.

  /** A minted credential for the stubbed provider — the real providers door, so the client construction path is the production one. */
  function mintCaptureCredential() {
    const store = parseProviderStore({
      providers: [{
        id: `capture-${randomUUID()}`,
        baseUrl: "https://provider.invalid/v1",
        apiKey: `sk-capture-${randomUUID().replaceAll("-", "")}`,
        models: [{ id: `capture-model-${randomUUID().slice(0, 8)}` }],
      }],
    });
    return resolveProviderCredential(store, store.providers[0]!.models[0]!.id, PROVIDER_FIXTURE_OWNER);
  }

  test("a provider call records its redacted request AND assembled response as documents", async () => {
    resetStubLlmProvider();
    stubLlmProviderScript.push(
      { type: "content", text: "partial answer " },
      { type: "content", text: "continued" },
      { type: "tool_call_start", index: 0, id: "call-1", name: "read_file" },
      { type: "tool_call_delta", index: 0, arguments: '{"path":"a.ts"}' },
      { type: "finish", reason: "tool_calls" },
    );
    const credential = mintCaptureCredential();
    const actorId = await attributed("llm-capture", async () => {
      for await (const event of streamChat("hello capture", {
        credential,
        systemPrompt: "You are a capture probe.",
      })) {
        void event;
      }
    });
    const events = eventsFor("provider", actorId);
    expect(events.length, "exactly one provider event per call").toBe(1);
    const docs = events[0]!.documents ?? [];
    const byName = new Map(docs.map((d) => [d.name, d]));
    const request = byName.get(TIMELINE_LLM_REQUEST_DOCUMENT);
    const response = byName.get(TIMELINE_LLM_RESPONSE_DOCUMENT);
    expect(request, "the request document is missing — the provider call is unanswerable").toBeDefined();
    expect(response, "the response document is missing — the provider call is unanswerable").toBeDefined();
    // The timing document rides beside them (the wrapper's own measurement).
    expect(byName.get(TIMELINE_EFFECT_TIMING_DOCUMENT)).toBeDefined();

    // THE REQUEST: the final redacted messages, exactly as built at the
    // choke point — system prompt + the user prompt, roles preserved.
    const requestBody = JSON.parse(request!.contentJson ?? "{}");
    expect(requestBody.model).toBe(credential.modelId); expect(requestBody.stream).toBe(true);
    const requestMessages = requestBody.input as { role: string; content: string }[];
    expect(Array.isArray(requestMessages)).toBe(true);
    expect(requestMessages[0]!.role).toBe("system");
    expect(requestMessages[0]!.content).toContain("capture probe");
    expect(requestMessages.at(-1)).toMatchObject({ role: "user", content: "hello capture" });

    // THE RESPONSE: the accumulated text and the tool-call pair, assembled
    // from the stream — the model's answer and what it asked to call.
    const responsePayload = JSON.parse(response!.contentJson ?? "{}") as {
      text: string;
      toolCalls: { name: string; arguments: string }[];
    };
    expect(responsePayload.text).toBe("partial answer continued");
    expect(responsePayload.toolCalls).toEqual([
      { name: "read_file", arguments: '{"path":"a.ts"}' },
    ]);

    // DIGEST-CONSISTENCY: every stored document's digest hashes its own
    // stored bytes (the invariant the digest-consistency suite enforces for
    // every producer — asserted here for THESE documents specifically).
    for (const doc of [request!, response!]) {
      expect(doc.contentDigest).toBe(sha256(doc.contentJson ?? ""));
    }
    resetStubLlmProvider();
  });

  test("an oversize captured document is stored bounded, with the truncation marker and the FULL payload's digest", async () => {
    // The store refuses an oversize document by throwing — and a throw in
    // the sink would lose the WHOLE event. So the sink bounds documents to
    // the configured per-document cap, and the bound must be HONEST: the
    // stored value says it was cut, and carries the digest of the full
    // payload so a complete copy held elsewhere can be verified against the
    // very bytes that were truncated here.
    resetStubLlmProvider();
    const cap = getTimelineConfig().maxDocumentBytes ?? 1_048_576;
    const oversized = JSON.stringify({ text: "x".repeat(cap + 1024) });
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(cap);
    const fullDigest = sha256(oversized);
    const fullBytes = Buffer.byteLength(oversized, "utf8");
    const actorId = await attributed("llm-oversize", async () => {
      for await (const c of recordProviderStream(`oversize-${randomUUID()}`, (async function* () {
        yield "chunk";
      })(), () => [
        { name: TIMELINE_LLM_RESPONSE_DOCUMENT, contentJson: oversized, contentDigest: fullDigest },
      ])) {
        void c;
      }
    });
    const events = eventsFor("provider", actorId);
    expect(events.length).toBe(1);
    const doc = (events[0]!.documents ?? []).find((d) => d.name === TIMELINE_LLM_RESPONSE_DOCUMENT);
    expect(doc, "the oversize document must still be recorded, bounded").toBeDefined();
    expect(
      Buffer.byteLength(doc!.contentJson ?? "", "utf8"),
      "the stored document must fit the configured per-document cap",
    ).toBeLessThanOrEqual(cap);
    const stored = JSON.parse(doc!.contentJson ?? "{}") as {
      truncated: boolean;
      fullPayloadDigest: string;
      fullPayloadBytes: number;
      preview: string;
    };
    expect(stored.truncated, "the stored value must SAY it was truncated").toBe(true);
    expect(stored.fullPayloadDigest, "the FULL payload's digest must survive the cut").toBe(fullDigest);
    expect(stored.fullPayloadBytes).toBe(fullBytes);
    expect(oversized.startsWith(stored.preview), "the preview must be a prefix of the full payload").toBe(true);
    // The stored digest still hashes the STORED bytes — the chain's
    // digest-consistency invariant holds for the bounded form too.
    expect(doc!.contentDigest).toBe(sha256(doc!.contentJson ?? ""));
    resetStubLlmProvider();
  });

  test("the trace id from the ambient recording context lands on the provider event", async () => {
    // The router mints a trace id into the recording context; ambient
    // provenance must carry it onto every event the request produces —
    // including the effect events written by the sink, which read the
    // context themselves rather than receiving the id as a parameter.
    const traceId = generateId("trace");
    const model = `traced-model-${randomUUID()}`;
    const actorId = await attributed("llm-trace", async () => {
      // A nested boundary (the way the run boundary nests inside the
      // router's) carries the actor forward and adds the trace id — the
      // merge semantics the ambient context exists for.
      await withRecordingContext({ actor: currentActor(), traceId }, async () => {
        for await (const c of recordProviderStream(model, chunks(2, 1))) void c;
      });
    });
    const events = eventsFor("provider", actorId);
    expect(events.length).toBe(1);
    expect(events[0]!.traceId, "the provider event must carry the boundary's trace id").toBe(traceId);
  });

  test("a RETRIED provider call is ONE span carrying the attempt count in its args — never one effect per attempt", async () => {
    // The shared client retries and fails over internally; the honest record
    // of a retried call is the SAME single llm event with `attempts` in its
    // args document (volume: one event per provider call, the attempt facts
    // riding it), never a burst of per-attempt events. The stub reports the
    // attempt sequence through the same per-attempt hook the real client
    // uses, so the counting is the production wiring's.
    resetStubLlmProvider();
    setStubLlmProviderAttempts(3);
    stubLlmProviderScript.push({ type: "content", text: "after retries" }, { type: "finish", reason: "stop" });
    const credential = mintCaptureCredential();
    const actorId = await attributed("llm-attempts", async () => {
      for await (const event of streamChat("hello retry probe", { credential })) void event;
    });
    const events = eventsFor("provider", actorId);
    expect(events.length, "one retried call is still exactly ONE provider event").toBe(1);
    const args = argsOfEvent(events[0]!) as { model?: string; attempts?: number } | null;
    expect(args, "the args document must exist").not.toBeNull();
    expect(args!.attempts, "the attempt count folds into the one span").toBe(3);
  });

  test("the FIXTURE path records through the lane, its args saying HOW it was served", async () => {
    // Fixtures are an explicit opt-in, and a fixture turn is real streamed
    // traffic in every other lane — the llm lane must hold an event for it
    // too, or the run's provider lane has a hole exactly where "what served
    // this turn" is the question. The event never claims a provider was
    // called: the args document says `fixture: true`.
    const prior = process.env.HARNESS_WEB_LLM_FIXTURES;
    process.env.HARNESS_WEB_LLM_FIXTURES = "1";
    try {
      const credential = mintCaptureCredential();
      const actorId = await attributed("llm-fixture", async () => {
        for await (const event of streamChat("hello fixture probe", { credential })) void event;
      });
      const events = eventsFor("provider", actorId);
      expect(events.length, "a fixture turn leaves exactly ONE provider-lane event").toBe(1);
      expect(events[0]!.outcome).toBe("succeeded");
      const args = argsOfEvent(events[0]!) as { model?: string; fixture?: boolean } | null;
      expect(args, "the args document must exist").not.toBeNull();
      expect(args!.fixture, "the args must name the fixture service — the event must not claim a provider call").toBe(true);
      expect(args!.model).toBe(credential.modelId);
    } finally {
      if (prior === undefined) delete process.env.HARNESS_WEB_LLM_FIXTURES;
      else process.env.HARNESS_WEB_LLM_FIXTURES = prior;
    }
  });

  test("a CLIENT-CREATION failure records through the lane with the real error — no hole where the call failed to start", async () => {
    // The credential mint refuses a forged credential at getClient — the
    // typed failure the client-creation catch handles. The event must exist
    // (outcome failed, the real error detail, the model in the args), so a
    // run that could not even build its client is answerable from the lane.
    const credential = {
      modelId: `unminted-model-${randomUUID().slice(0, 8)}`,
      providerId: "unminted",
      baseUrl: "https://provider.invalid/v1",
      apiKey: () => "sk-unminted",
      headers: () => ({}) as Readonly<Record<string, string>>,
    } as unknown as Parameters<typeof streamChat>[1]["credential"];
    const actorId = await attributed("llm-client-fail", async () => {
      for await (const event of streamChat("hello unminted probe", { credential })) void event;
    });
    const events = eventsFor("provider", actorId);
    expect(events.length, "the failed client creation leaves exactly ONE provider-lane event").toBe(1);
    expect(events[0]!.outcome).toBe("failed");
    expect(events[0]!.errorCode).toBe("llm_client_unavailable");
    expect(events[0]!.errorMessage ?? "").toContain("credential");
    const args = argsOfEvent(events[0]!) as { model?: string } | null;
    expect(args!.model).toBe(credential.modelId);
  });
});

// ── process — subprocess spawn→exit with real exit codes ──

describe("process effects — spawnSyncSafe and spawnCapture are the choke points", () => {
  test("execute_command records a process effect nested under the tool effect", async () => {
    const projectRoot = createTempDir("ch-effect-proc-");
    const actorId = await attributed("proc-ok", async () => {
      const res = await executeToolCall("execute_command", { command: "pwd" }, { projectRoot });
      expect(res.success, `pwd must run: ${res.output}`).toBe(true);
    });
    const procEvents = eventsFor("process", actorId);
    expect(procEvents.length, "the spawn must appear in the process lane").toBe(1);
    expect(procEvents[0]!.description).toBe("process:pwd");
    expect(procEvents[0]!.outcome).toBe("succeeded");
    // The span stack makes the subprocess a CHILD of the tool call that
    // spawned it — causality from structure, not from threaded arguments.
    // (`parent_event_id` cannot link here: the inner effect is written
    // before its parent's event exists, and a span id is not an event id —
    // see ambientProvenance in the canonical recorder. The causal chain is
    // the TRACE: both events share the trace opened by the outermost span.)
    const toolEvents = eventsFor("tool", actorId);
    expect(toolEvents.length).toBe(1);
    expect(procEvents[0]!.traceId, "the subprocess must be in the tool call's trace").toBe(toolEvents[0]!.traceId);
    expect(toolEvents[0]!.traceId, "the tool span is the outermost — it opens the trace").toBe(toolEvents[0]!.spanId);
    expect(procEvents[0]!.spanId ?? "").toMatch(/^process:pwd:/);
  });

  test("a non-zero exit records outcome=failed carrying the REAL exit code", async () => {
    const projectRoot = createTempDir("ch-effect-proc-fail-");
    const actorId = await attributed("proc-fail", async () => {
      const res = await executeToolCall(
        "execute_command",
        { command: "cat", args: ["this-file-does-not-exist.txt"] },
        { projectRoot },
      );
      expect(res.success).toBe(false);
    });
    const events = eventsFor("process", actorId);
    expect(events.length).toBe(1);
    expect(events[0]!.outcome).toBe("failed");
    expect(events[0]!.errorCode).toBe("process_failed");
    // The failure detail is the spawn's own output JSON — real exitCode,
    // real stderr — not a summary invented at the call site.
    expect(events[0]!.errorMessage ?? "").toContain('"exitCode":1');
  });

  test("a GATE-BLOCKED call's event names the failed field in its own document — the ledger answers WHICH fields without the client", async () => {
    // The safety gate refuses a schema-mismatched call before dispatch; the
    // refusal message already names the field as prose (the model needs the
    // guidance), but the LEDGER must answer "which fields failed" on its
    // own: the gate-block document carries the gate's structured names on
    // the same tool event. Driven through the REAL executor + REAL gate into
    // the REAL ledger — the gate blocks before dispatch, so the (unregistered)
    // probe tool never runs.
    const toolName = `gated_probe_${randomUUID().slice(0, 8)}`;
    const gate = createToolCallGate({
      getDefinitions: () => [{
        type: "function",
        function: {
          name: toolName,
          description: "probe tool for the gate-block lane",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      }],
    });
    const projectRoot = createTempDir("ch-effect-gate-");
    /** The executor's result, captured out of the attributed closure. */
    let blocked: Awaited<ReturnType<typeof executeToolCall>> | undefined;
    const actorId = await attributed("gate-block", async () => {
      const res = await executeToolCall(toolName, { content: "present" }, {
        projectRoot,
        gate,
        callId: "gate-probe-1",
      });
      expect(res.success).toBe(false);
      expect(res.gateBlock?.kind).toBe("schema_mismatch");
      blocked = res;
    });
    const events = eventsFor("tool", actorId);
    expect(events.length, "the blocked call is still exactly ONE tool event").toBe(1);
    expect(events[0]!.outcome).toBe("failed");
    expect(events[0]!.errorCode).toBe("tool_gate_schema_mismatch");
    // THE PAIRING WIRE: the result carries the ledger id of the tool event
    // the wrapper recorded, so the gate's inline account (persisted by the
    // run loop as an `error` event) can name this row as its parent — the
    // pairing the sweep's incident count folds on. The id is the REAL row's
    // id, read back through the public query, not a parallel correlation.
    expect(
      blocked?.toolEventId,
      "the result must name the ledger row its own wrapper recorded",
    ).toBe(events[0]!.eventId);
    // The refusal prose names the field (the model's guidance), and the
    // event's own error detail carries it.
    expect(events[0]!.errorMessage ?? "").toContain("missing required field 'path'");
    // THE STRUCTURED HALF: the gate-block document holds the gate's computed
    // NAMES — answerable without parsing prose.
    const doc = (events[0]!.documents ?? []).find((d) => d.name === TIMELINE_GATE_BLOCK_DOCUMENT);
    expect(doc, "the gate-block document must ride the blocked call's event").toBeDefined();
    const detail = JSON.parse(doc!.contentJson ?? "{}") as {
      kind?: string; toolName?: string; failedFields?: readonly string[];
    };
    expect(detail.kind).toBe("schema_mismatch");
    expect(detail.toolName).toBe(toolName);
    expect(detail.failedFields, "the document names exactly the fields that failed").toEqual(["path"]);
  });

  test("an ESCALATED gate block's document carries the escalation fact — the ledger answers 'did the harness notice the refusal loop'", async () => {
    // The repeated-refusal incident shape: the same call blocked identically
    // over and over with nothing changing. The gate's block-sequence
    // bookkeeping escalates after `blockEscalationAfter` (default 3)
    // consecutive identical blocks; the LEDGER must carry that fact
    // structurally (the gate-block document's `escalated` field), not just
    // inside the message prose, so `trace run <id> --failed` answers it from
    // the row. Driven through the REAL executor + REAL gate into the REAL
    // ledger — three identical calls, three tool events, one escalation.
    const toolName = `gated_loop_${randomUUID().slice(0, 8)}`;
    const gate = createToolCallGate({
      getDefinitions: () => [{
        type: "function",
        function: {
          name: toolName,
          description: "probe tool for the gate-block escalation lane",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      }],
    });
    const projectRoot = createTempDir("ch-effect-gate-esc-");
    const actorId = await attributed("gate-escalation", async () => {
      const results = [];
      for (let i = 1; i <= 3; i++) {
        results.push(await executeToolCall(toolName, { content: "present" }, {
          projectRoot,
          gate,
          callId: `gate-esc-${i}`,
        }));
      }
      // Blocks 1 and 2 are the normal refusal; block 3 escalates.
      expect(results[0]!.gateBlock?.escalated).toBeUndefined();
      expect(results[1]!.gateBlock?.escalated).toBeUndefined();
      expect(results[2]!.gateBlock?.escalated, "the third identical block escalates").toBe(true);
      expect(results[2]!.output).toContain("third consecutive time");
      expect(results[2]!.output).toContain("repeating the same arguments cannot succeed");
    });
    const events = eventsFor("tool", actorId);
    expect(events.length, "three blocked calls are three tool events").toBe(3);
    // The lane query is newest-first; read the streak chronologically.
    const chronological = [...events].reverse();
    const documents = chronological.map(
      (e) => (e.documents ?? []).find((d) => d.name === TIMELINE_GATE_BLOCK_DOCUMENT),
    );
    const parsed = documents.map((d) => JSON.parse(d?.contentJson ?? "{}") as { escalated?: boolean });
    expect(parsed[0]!.escalated).toBeUndefined();
    expect(parsed[1]!.escalated).toBeUndefined();
    // THE STRUCTURED FACT: the escalation rides the third event's own
    // document — the dig prints documents verbatim, so the fact surfaces
    // without parsing the refusal prose.
    expect(parsed[2]!.escalated, "the escalated block's document carries escalated: true").toBe(true);
  });

  test("a gate AUTO-TRIP's document carries the trip fact — the ledger answers 'was the tool tripped' from the row", async () => {
    // The escalation (the arm above) teaches; a model that ignores it 2×
    // more is burning the user's tokens in a loop. The gate trips the tool
    // at `blockAutoTripAfter` (default 6 = 2× the escalation default) and
    // the LEDGER must carry that structurally: the tripping block's
    // document carries `autoTripped: true` + the count, the escalated flag
    // continues to ride, and every post-trip refusal carries the standing
    // trip. Driven through the REAL executor + a REAL config-overridden
    // gate (threshold 4 to keep the arm's drive short) into the REAL ledger.
    const toolName = `gated_trip_${randomUUID().slice(0, 8)}`;
    const gate = createToolCallGate({
      getDefinitions: () => [{
        type: "function",
        function: {
          name: toolName,
          description: "probe tool for the gate auto-trip lane",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      }],
      config: { blockEscalationAfter: 3, blockAutoTripAfter: 4 },
    });
    const projectRoot = createTempDir("ch-effect-gate-trip-");
    const actorId = await attributed("gate-auto-trip", async () => {
      const results = [];
      for (let i = 1; i <= 5; i++) {
        results.push(await executeToolCall(toolName, { content: "present" }, {
          projectRoot,
          gate,
          callId: `gate-trip-${i}`,
        }));
      }
      // Block 4 trips: the fact is on the RESULT (the run loop routes the
      // breaker row flip from this flag), the message is the terminal form.
      expect(results[3]!.gateBlock?.escalated, "the escalated flag continues to ride the trip").toBe(true);
      expect(results[3]!.gateBlock?.autoTripped, "the tripping block carries the trip fact").toBe(true);
      expect(results[3]!.gateBlock?.autoTrippedAfter, "the structured count rides the result").toBe(4);
      expect(results[3]!.output).toContain("has been disabled for the rest of this run after 4 consecutive identical blocked calls");
      // Block 5 is a post-trip refusal: the tool is off, said plainly, and
      // the refusal classifies as tool_disabled (not a hallucination).
      expect(results[4]!.gateBlock?.kind).toBe("tool_disabled");
      expect(results[4]!.gateBlock?.autoTripped).toBe(true);
      expect(results[4]!.gateBlock?.autoTrippedAfter).toBe(4);
    });
    const events = eventsFor("tool", actorId);
    expect(events.length, "five blocked calls are five tool events").toBe(5);
    const chronological = [...events].reverse();
    const docs = chronological.map(
      (e) => (e.documents ?? []).find((d) => d.name === TIMELINE_GATE_BLOCK_DOCUMENT),
    );
    const parsed = docs.map((d) => JSON.parse(d?.contentJson ?? "{}") as {
      escalated?: boolean; autoTripped?: boolean; autoTrippedAfter?: number;
    });
    // Blocks 1–3: escalated from the third, never tripped.
    expect(parsed[0]!.autoTripped).toBeUndefined();
    expect(parsed[2]!.escalated).toBe(true);
    expect(parsed[2]!.autoTripped).toBeUndefined();
    // THE TRIP FACT: the fourth event's document carries autoTripped + the
    // count, and escalated still rides.
    expect(parsed[3]!.autoTripped, "the tripping block's document carries autoTripped: true").toBe(true);
    expect(parsed[3]!.autoTrippedAfter).toBe(4);
    expect(parsed[3]!.escalated).toBe(true);
    // The post-trip refusal carries the STANDING trip (autoTripped without
    // a fresh count change).
    expect(parsed[4]!.autoTripped).toBe(true);
    expect(parsed[4]!.autoTrippedAfter).toBe(4);
    expect(parsed[4]!.escalated).toBeUndefined();
  });

  test("an auto-check subprocess (typecheck) records spawn→exit", async () => {
    const projectDir = createTempDir("ch-effect-check-");
    writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(projectDir, "clean.ts"), "export const n: number = 1;\n");
    const actorId = await attributed("proc-check", async () => {
      const outcome = await runAutoCheck("typecheck", projectDir);
      expect(outcome.status, JSON.stringify(outcome.output)).toBe("passed");
    });
    const events = eventsFor("process", actorId);
    expect(events.length, "the check subprocess must appear in the process lane").toBe(1);
    expect(events[0]!.description, "named by the real executable").toMatch(/^process:(node|npx)$/);
    expect(events[0]!.outcome).toBe("succeeded");
    const timing = timingOf(events[0]!);
    expect(timing).not.toBeNull();
    expect(timing!.durationMs, "a real tsc run takes real time — a ~0 duration is a fabrication").toBeGreaterThan(50);
  });
});

// ── filesystem — the one non-project mutation, attributed over real HTTP ──

describe("filesystem effects — the mkdir route is the choke point", () => {
  let srv: HttpTestServer;

  beforeAll(async () => {
    srv = await startHttpTestServer({
      prefix: "ch-effect-fs-",
      register: (router, db, adb) => {
        registerFilesystemRoutes(router, adb);
      },
    });
  });

  afterAll(async () => {
    await srv.stop();
  });

  test("a folder created through the picker lands as a filesystem event attributed to the REQUESTING USER", async () => {
    const user = createTestUser(srv.db, `fs-effect-${randomUUID().slice(0, 8)}`);
    const name = `new-folder-${randomUUID().slice(0, 8)}`;
    const { status, body, headers } = await jsonRequest(srv.baseUrl, "/api/filesystem/mkdir", {
      method: "POST",
      cookie: user.cookie,
      body: { parent: process.env.HARNESS_WEB_PROJECT_ROOT, name },
    });
    expect(status, JSON.stringify(body)).toBe(200);
    // No test-supplied recording context here: attribution comes from the
    // ROUTER's recording boundary resolving the authenticated user — the
    // full production chain.
    const events = eventsFor("filesystem", user.userId);
    expect(events.length, "the mkdir must appear in the filesystem lane").toBe(1);
    expect(events[0]!.description).toBe("filesystem:mkdir");
    expect(events[0]!.outcome).toBe("succeeded");
    expect(events[0]!.actorKind).toBe("user");
    // THE TRACE, END TO END: the id the client received on the response is
    // the id under which the request's ledger events are filed. This is the
    // join a developer uses to go from "this request failed" (a header
    // value) to "here is everything it did" (TimelineQuery.byTrace).
    const responseTraceId = headers.get(TRACE_ID_HEADER);
    expect(responseTraceId, "the response must carry the trace id header").toBeTruthy();
    expect(events[0]!.traceId, "the ledger event's trace must be the id the client received").toBe(responseTraceId);
  });
});

// ── http — the router's handler dispatch, over real HTTP ────────────────────

describe("http effects — the router dispatch is the choke point", () => {
  let srv: HttpTestServer;

  beforeAll(async () => {
    srv = await startHttpTestServer({
      prefix: "ch-effect-http-",
      isPublicPath: () => true,
      register: (router) => {
        router.get("/effect-kind-http/ok", (ctx) => {
          sendJson(ctx.res, { fine: true });
        });
        router.get("/effect-kind-http/failing", () => {
          throw new Error("handler exploded on purpose");
        });
        router.get("/effect-kind-http/refusing", (ctx) => {
          // A handler that signals failure by WRITING a 5xx response instead
          // of throwing — the shape `failedWhen` exists to catch.
          ctx.res.writeHead(500, { "Content-Type": "application/json" });
          ctx.res.end(JSON.stringify({ error: "internal_error" }));
        });
        router.get("/effect-kind-http/throwing-client-error", () => {
          // A handler that THROWS a TYPED 4xx — the shape the router maps to
          // a 400 response one frame out (`statusForError`: a `missing_*`
          // code is a client error). The ledger's outcome for this request
          // must agree with a handler that WRITES the same 400. A RAW Error
          // carrying `.code` no longer maps: the router trusts only the typed
          // hierarchy for a status, precisely so an OS `EACCES` cannot pick
          // one.
          throw new BadRequestError("the required query parameter is absent", "missing_query");
        });
        router.get("/effect-kind-http/writing-client-error", (ctx) => {
          // The twin of the route above: the SAME status, signalled by
          // writing instead of throwing.
          ctx.res.writeHead(400, { "Content-Type": "application/json" });
          ctx.res.end(JSON.stringify({ error: "missing_query" }));
        });
      },
    });
  });

  afterAll(async () => {
    await srv.stop();
  });

  test("a served request lands as a network event named by method + route pattern", async () => {
    const { status } = await jsonRequest(srv.baseUrl, "/effect-kind-http/ok?probe=1");
    expect(status).toBe(200);
    await new Promise((r) => setImmediate(r));
    const events = eventsOf("network").filter((e) => e.description === "http:GET /effect-kind-http/ok");
    expect(events.length, "the request must appear in the http lane").toBeGreaterThanOrEqual(1);
    const event = events[0]!;
    expect(event.outcome).toBe("succeeded");
    // THE INVOCATION: method + path + query, as the args document.
    const args = argsOfEvent(event) as { method: string; path: string; query: string } | null;
    expect(args, "the http event must carry its invocation as the args document").not.toBeNull();
    expect(args!.method).toBe("GET");
    expect(args!.path).toBe("/effect-kind-http/ok");
    expect(args!.query).toBe("?probe=1");
    // The timing document rides beside it, with the resource deltas.
    const timing = timingOf(event);
    expect(timing).not.toBeNull();
    expect(typeof timing!.cpuMs).toBe("number");
  });

  test("a THROWING handler records failed with the real error", async () => {
    const { status } = await jsonRequest(srv.baseUrl, "/effect-kind-http/failing");
    expect(status).toBe(500);
    await new Promise((r) => setImmediate(r));
    const events = eventsOf("network").filter((e) => e.description === "http:GET /effect-kind-http/failing");
    expect(events.length).toBeGreaterThanOrEqual(1);
    const event = events[0]!;
    expect(event.outcome).toBe("failed");
    expect(event.errorMessage ?? "").toContain("handler exploded on purpose");
  });

  test("a handler that WRITES a 5xx records failed from the status class", async () => {
    const { status } = await jsonRequest(srv.baseUrl, "/effect-kind-http/refusing");
    expect(status).toBe(500);
    await new Promise((r) => setImmediate(r));
    const events = eventsOf("network").filter((e) => e.description === "http:GET /effect-kind-http/refusing");
    expect(events.length).toBeGreaterThanOrEqual(1);
    const event = events[0]!;
    expect(event.outcome, "a 5xx response is a server fault, whatever the handler returned").toBe("failed");
    expect(event.errorCode).toBe("http_server_error");
  });

  test("a THROWN 4xx and a WRITTEN 4xx record the SAME outcome — the throw is classed by its mapped status", async () => {
    // THE MEASURED DEFECT: a thrown error mapped to 4xx recorded "failed"
    // while a handler writing the same 400 recorded "succeeded" — two
    // identical 400s, opposite outcomes. The fix classes the throw path by
    // its MAPPED status (the router's `statusForError`, the same mapping the
    // client's response comes from), so the two shapes agree. Driven through
    // the real router over real HTTP, both routes in one test so the
    // agreement is observed rather than inferred.
    const thrown = await jsonRequest(srv.baseUrl, "/effect-kind-http/throwing-client-error");
    expect(thrown.status, "the router must map the thrown typed error to its 400").toBe(400);
    const written = await jsonRequest(srv.baseUrl, "/effect-kind-http/writing-client-error");
    expect(written.status).toBe(400);
    await new Promise((r) => setImmediate(r));
    const thrownEvents = eventsOf("network").filter((e) => e.description === "http:GET /effect-kind-http/throwing-client-error");
    const writtenEvents = eventsOf("network").filter((e) => e.description === "http:GET /effect-kind-http/writing-client-error");
    expect(thrownEvents.length).toBeGreaterThanOrEqual(1);
    expect(writtenEvents.length).toBeGreaterThanOrEqual(1);
    const thrownEvent = thrownEvents[0]!;
    const writtenEvent = writtenEvents[0]!;
    expect(thrownEvent.outcome, "a thrown 4xx is a client error, not a server fault").toBe("succeeded");
    expect(writtenEvent.outcome).toBe("succeeded");
    // AGREEMENT IS THE CLAIM, not either value alone.
    expect(thrownEvent.outcome).toBe(writtenEvent.outcome);
    // The classification must not have cost the evidence: the thrown error
    // still travels as the record's detail, so the ledger still says WHY the
    // client got a 400.
    expect(thrownEvent.errorCode).toBe("missing_query");
    expect(thrownEvent.errorMessage ?? "").toContain("the required query parameter is absent");
  });
});

// ── http — the refusal lane: a request turned away before any handler ran ──

describe("http refusal effects — pre-handler rejections land in the lane as denied", () => {
  // The REAL public-path predicate (the registry default): the mounted test
  // paths are not public, so the auth gate is live — which is the point:
  // these arms drive the gates that refuse a request before any handler
  // exists to wrap.
  let srv: HttpTestServer;
  let cookie: string;

  beforeAll(async () => {
    srv = await startHttpTestServer({
      prefix: "ch-effect-refusal-",
      register: (router) => {
        router.post("/effect-refusal/echo", (ctx) => {
          sendJson(ctx.res, { ok: true });
        });
        router.get("/effect-refusal/items/:id", (ctx) => {
          sendJson(ctx.res, { id: ctx.params["id"] });
        });
      },
    });
    cookie = createTestUser(srv.db, "refuser").cookie;
  });

  afterAll(async () => {
    await srv.stop();
  });

  /** The lane event for one refusal description, newest first. */
  const refusalEvent = (description: string) => {
    const events = eventsOf("network").filter((e) => e.description === description);
    return events.length > 0 ? events[0]! : null;
  };

  test("an UNAUTHENTICATED request is refused in the lane: denied, anonymously attributed, with the typed error's detail", async () => {
    const { status } = await jsonRequest(srv.baseUrl, "/effect-refusal/echo", { method: "POST" });
    expect(status).toBe(401);
    await new Promise((r) => setImmediate(r));
    const event = refusalEvent("http:POST /effect-refusal/echo [refused auth]");
    expect(event, "the refusal must land in the http lane").not.toBeNull();
    expect(event!.outcome, "a refusal settles denied — the gate-block word").toBe("denied");
    expect(event!.actorKind, "a request refused before identity resolves is anonymous").toBe("anonymous");
    expect(event!.errorCode).toBe("unauthorized");
    expect(event!.errorMessage ?? "").toContain("Authentication required");
    // The invocation rides as the args document, query redacted.
    const args = argsOfEvent(event!) as { method: string; path: string; query: string } | null;
    expect(args!.method).toBe("POST");
    expect(args!.path).toBe("/effect-refusal/echo");
    // The timing document still rides — the refusal is a measured effect.
    expect(timingOf(event!)).not.toBeNull();
  });

  test("a CSRF-blocked mutation is refused in the lane with the CSRF error's detail", async () => {
    // Authenticated (the cookie is real) but WITHOUT the custom header —
    // the second CSRF defense. The auth gate passes; the CSRF guard refuses.
    const { status } = await jsonRequest(srv.baseUrl, "/effect-refusal/echo", {
      method: "POST",
      cookie,
      noCsrf: true,
    });
    expect(status).toBe(403);
    await new Promise((r) => setImmediate(r));
    const event = refusalEvent("http:POST /effect-refusal/echo [refused auth]");
    expect(event, "the CSRF refusal shares the auth-gate site, so the same lane name").not.toBeNull();
    expect(event!.outcome).toBe("denied");
    expect(event!.errorCode).toBe("csrf_blocked");
  });

  test("a malformed body is refused in the lane with the body error's detail", async () => {
    // jsonRequest stringifies its body, so the malformed payload goes
    // through fetch directly — the raw invalid-JSON bytes on the wire.
    const res = await fetch(`${srv.baseUrl}/effect-refusal/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-requested-with": "1", Cookie: cookie },
      body: "{\"not json",
    });
    expect(res.status).toBe(400);
    await res.text();
    await new Promise((r) => setImmediate(r));
    const event = refusalEvent("http:POST /effect-refusal/echo [refused body]");
    expect(event, "the body refusal must land in the http lane").not.toBeNull();
    expect(event!.outcome).toBe("denied");
    expect(event!.errorCode).toBe("invalid_json");
  });

  test("a rate-limited mutation is refused in the lane with the rate-limit error's detail", async () => {
    resetRateLimiter();
    try {
      // Drain the caller's bucket with real mutating POSTs, then fire one
      // more: the limiter refuses exactly that request.
      let saw429 = false;
      for (let i = 0; i < 80 && !saw429; i++) {
        const { status } = await jsonRequest(srv.baseUrl, "/effect-refusal/echo", {
          method: "POST",
          cookie,
        });
        if (status === 429) saw429 = true;
      }
      expect(saw429, "the flood must reach the limiter's refusal").toBe(true);
      await new Promise((r) => setImmediate(r));
      const event = refusalEvent("http:POST /effect-refusal/echo [refused rate-limit]");
      expect(event, "the rate-limit refusal must land in the http lane").not.toBeNull();
      expect(event!.outcome).toBe("denied");
      expect(event!.errorCode).toBe("rate_limited");
      expect(event!.errorMessage ?? "").toContain("Too many requests");
    } finally {
      resetRateLimiter();
    }
  });

  test("a MALFORMED request (a bad percent-escape, a Host that is not a host) is refused in the lane with its trace id (wf1b2-design S-4)", async () => {
    const raw = (path: string, host: string) => new Promise<Readonly<{ status: number; traceId: string | undefined }>>((resolve, reject) => {
      const port = new URL(srv.baseUrl).port;
      const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host, Cookie: cookie }, timeout: 5_000 }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, traceId: res.headers["x-trace-id"] as string | undefined }));
      });
      req.on("timeout", () => req.destroy(new Error(`${path}: no response`)));
      req.on("error", reject);
      req.end();
    });
    const escape = await raw("/effect-refusal/items/%E0%A4%A", new URL(srv.baseUrl).host);
    expect(escape.status).toBe(400);
    expect(escape.traceId, "the 400 carries the trace id a client can quote").toMatch(/^trace-/u);
    // The unauthenticated shape: an unparsable Host is refused before any gate.
    const host = await raw("/effect-refusal/items/1?token=sk-live-abcdefghijklmnopqrstuv", "127.0.0.1:abc");
    expect(host.status).toBe(400);
    expect(host.traceId).toMatch(/^trace-/u);
    await new Promise((r) => setImmediate(r));
    const decoded = refusalEvent("http:GET /effect-refusal/items/%E0%A4%A [refused path]");
    expect(decoded, "the malformed escape must land in the http lane").not.toBeNull();
    expect(decoded!.outcome).toBe("denied");
    expect(decoded!.errorCode).toBe("request_path_malformed");
    const unparsable = refusalEvent("http:GET /effect-refusal/items/1 [refused request]");
    expect(unparsable, "the bad-Host probe must land in the http lane").not.toBeNull();
    expect(unparsable!.outcome).toBe("denied");
    expect(unparsable!.actorKind).toBe("anonymous");
    expect(unparsable!.errorCode).toBe("request_host_invalid");
    expect(JSON.stringify(unparsable!.documents ?? []), "the query is redacted like every refusal's").not.toContain("sk-live-abcdefghijklmnopqrstuv");
  });

  test("a request for no route at all is refused in the lane — the probe is an observable fact", async () => {
    const { status } = await jsonRequest(srv.baseUrl, "/effect-refusal/absent", { cookie });
    expect(status).toBe(404);
    await new Promise((r) => setImmediate(r));
    const event = refusalEvent("http:GET /effect-refusal/absent [no route]");
    expect(event, "the no-route refusal must land in the http lane").not.toBeNull();
    expect(event!.outcome).toBe("denied");
    expect(event!.errorMessage ?? "").toContain("No route for GET /effect-refusal/absent");
  });
});

// ── db — the data facade's call, with shape-only arguments ──────────────────

describe("db effects — the async client's call is the choke point", () => {
  let srv: HttpTestServer;

  beforeAll(async () => {
    srv = await startHttpTestServer({
      prefix: "ch-effect-db-",
      isPublicPath: () => true,
      register: () => {},
    });
  });

  afterAll(async () => {
    await srv.stop();
  });

  test("a database call lands as a db event named by the method", async () => {
    const marker = `db-probe-${randomUUID()}`;
    // A real call through the facade, with a value planted in an argument so
    // the shape-only contract can be proven by absence.
    const projects = await srv.adb.listProjects(marker);
    expect(Array.isArray(projects)).toBe(true);
    await new Promise((r) => setImmediate(r));
    const events = eventsOf("db").filter((e) => e.description === "db:listProjects");
    expect(events.length, "the call must appear in the db lane").toBeGreaterThanOrEqual(1);
    const event = events[0]!;
    expect(event.outcome).toBe("succeeded");
    const timing = timingOf(event);
    expect(timing, "the db call's real duration is measured").not.toBeNull();

    // THE SHAPE-ONLY CONTRACT. The args document records the argument count
    // and each argument's TYPE + size — never a value. The planted marker
    // (a raw argument) must not appear anywhere in the event's documents,
    // because message content must not reach the ledger through this lane.
    const args = argsOfEvent(event) as { argCount: number; args: { type: string }[] } | null;
    expect(args, "the db event must carry its argument shapes").not.toBeNull();
    expect(args!.argCount).toBe(1);
    expect(args!.args[0]!.type).toBe("string");
    const allDocuments = JSON.stringify(event.documents ?? []);
    expect(allDocuments).not.toContain(marker);
    expect(allDocuments, "the shape must carry the size, which is the interesting fact").toContain("bytes");
  });

  test("a transaction lands as one db event carrying the operation NAMES only", async () => {
    await srv.adb.transaction([
      { method: "getProject", args: ["probe-id-1", "probe-user"] },
      { method: "getChat", args: ["probe-id-2", "probe-user"] },
    ]);
    await new Promise((r) => setImmediate(r));
    const events = eventsOf("db").filter((e) => e.description === "db:transaction");
    expect(events.length, "the transaction must appear in the db lane").toBeGreaterThanOrEqual(1);
    const event = events[0]!;
    const args = argsOfEvent(event) as { opCount: number; ops: string[] } | null;
    expect(args).not.toBeNull();
    expect(args!.opCount).toBe(2);
    expect(args!.ops).toEqual(["getProject", "getChat"]);
    // The raw arguments (ids, user ids) never travel.
    const allDocuments = JSON.stringify(event.documents ?? []);
    expect(allDocuments).not.toContain("probe-id-1");
    expect(allDocuments).not.toContain("probe-user");
  });
});

// ── engine — the hub's auto-decoration is the choke point ──────────────────
//
// Every function-valued re-export of the canonical hub is span-decorated by
// engineSpans (engine/src/performance/engine-instrumentation.ts): a request
// that calls engine code through the hub leaves an engine-lane event saying
// WHICH function ran, how long it took, what it cost, and the SHAPES of its
// arguments — never their values. These arms drive the REAL hub bindings and
// read the REAL ledger, the same chain the other lanes use.

describe("engine effects — the hub decoration is the choke point", () => {
  test("every function-valued hub re-export is decorated or reviewed-excluded — deny by default at runtime", () => {
    // The source-scan guard (recording-choke-points class G) proves no value
    // re-export bypasses the engineSpans table; THIS arm proves the runtime
    // half: the binding the server actually calls is a span wrapper unless
    // the reviewed exclusion table names it. A constant passes through
    // untouched (nothing to measure); a FUNCTION that is neither wrapped nor
    // excluded is the hole.
    const hub = canonicalHub as unknown as Record<string, unknown>;
    const problems: string[] = [];
    for (const { moduleId, name } of hubDecoratedPopulation()) {
      const value = hub[name];
      if (typeof value !== "function") continue;
      const excluded = ENGINE_SPAN_EXCLUSIONS[`${moduleId}:${name}`] !== undefined;
      if (!excluded && !isEngineSpan(value)) {
        problems.push(`${moduleId}:${name} is neither engine-span wrapped nor reviewed-excluded`);
      }
    }
    expect(
      problems,
      `A server-visible engine function that records nothing is the exact hole the\n` +
        `decoration exists to close. Either it must flow through engineSpans (it\n` +
        `then wraps automatically) or join the reviewed exclusion table.\n${problems.join("\n")}`,
    ).toEqual([]);
  });

  test("a decorated hub call inside a recording context lands in the engine lane, attributed, with timing + arg SHAPES", async () => {
    const actorId = await attributed("engine-ok", () => {
      const resolved = canonicalHub.resolveMemoryConfig({});
      expect(resolved.contextTokenLimit).toBeGreaterThan(0);
    });
    const events = eventsFor("engine", actorId);
    expect(events.length, "the hub call must appear in the engine lane").toBe(1);
    expect(events[0]!.description).toBe("engine:resolveMemoryConfig");
    expect(events[0]!.outcome).toBe("succeeded");
    expect(events[0]!.actorKind).toBe("user");
    expect(timingOf(events[0]!), "the real measured duration rides the timing document").not.toBeNull();
    // THE INVOCATION SHAPES: the args document exists and carries the
    // override object's SHAPE — count and key names, never values.
    const args = argsOfEvent(events[0]!) as { count: number; args: { type: string }[] } | null;
    expect(args, "the args document must exist for the engine span").not.toBeNull();
    expect(args!.count).toBe(1);
    expect(args!.args[0]!.type).toBe("object");
  });

  test("argument VALUES never reach the engine span's documents — shapes only, even for values other lanes would keep", async () => {
    // A header value redactHeaders itself would PASS THROUGH untouched (an
    // allowlisted, credential-free name) is the
    // sharpest canary: if that VALUE appears anywhere on the engine event,
    // the shape discipline is broken — not the redaction layer, the capture.
    const CANARY = "canary-header-value-9f8e7d6c";
    const actorId = await attributed("engine-canary", () => {
      const redacted = canonicalHub.redactHeaders({ accept: CANARY });
      expect(redacted["accept"]).toBe(CANARY);
    });
    const events = eventsFor("engine", actorId);
    expect(events.length).toBe(1);
    const allDocuments = JSON.stringify(events[0]!.documents ?? []);
    expect(allDocuments, "no argument value may reach the ledger through the engine span").not.toContain(CANARY);
    const args = argsOfEvent(events[0]!) as { args: { keys?: string[] }[] } | null;
    expect(
      args!.args[0]!.keys,
      "the key NAME is schema and stays while the value never appears",
    ).toContain("accept");
  });

  test("a decorated hub call that throws records failed with the typed error's real code", async () => {
    const actorId = await attributed("engine-error", () => {
      expect(() =>
        canonicalHub.resolveMemoryConfig({ contextTokenLimit: 0 }),
      ).toThrow("contextTokenLimit must be a positive finite number");
    });
    const events = eventsFor("engine", actorId);
    expect(events.length).toBe(1);
    expect(events[0]!.description).toBe("engine:resolveMemoryConfig");
    expect(events[0]!.outcome).toBe("failed");
    expect(events[0]!.errorCode).toBe("memory_config_invalid");
    expect(events[0]!.errorMessage).toContain("contextTokenLimit must be a positive finite number");
  });

  test("the engine span carries the boundary's trace id — a request's engine calls join its causal chain", async () => {
    const traceId = generateId("trace");
    const actorId = await attributed("engine-trace", () => {
      withRecordingContext({ actor: currentActor(), traceId }, () => {
        expect(canonicalHub.resolveMemoryConfig({}).searchResultLimit).toBeGreaterThan(0);
      });
    });
    const events = eventsFor("engine", actorId);
    expect(events.length).toBe(1);
    expect(events[0]!.traceId, "the engine event must be traceable to the request").toBe(traceId);
  });

  test("a decorated hub call OUTSIDE any recording context records nothing — boot and CLI pass through", async () => {
    // `attributed` enters a context; here the call runs bare, like a boot-time
    // or background-tick call. The lane must stay quiet for it: the ambient
    // check is the volume gate that keeps non-request work unrecorded.
    const before = eventsOf("engine").filter((e) => e.description === "engine:canonicalHeaderName").length;
    expect(canonicalHub.canonicalHeaderName("x-boot-probe")).toBe("X-Boot-Probe");
    await new Promise((r) => setImmediate(r));
    const after = eventsOf("engine").filter((e) => e.description === "engine:canonicalHeaderName").length;
    expect(after, "no-context calls are pass-throughs, never ledger events").toBe(before);
  });
});

// Direct foundation adoption: the legacy streamChat wrapper remains a separate
// migration owner. This exercises the actual installed web sink without it.
test("web sink acknowledges exactly one provider intent and terminal through the shared paired helper", async () => {
  const { recordProviderStream: recordPairedProviderStream } = await import("../../engine/src/timeline/provider-recording.ts");
  const actor = testActor("paired-foundation");
  const contentJson = JSON.stringify({ native: "safe captured evidence" });
  const documents = [{ name: TIMELINE_LLM_RESPONSE_DOCUMENT, contentJson, contentDigest: sha256(contentJson) }];
  await withRecordingContext({ actor }, async () => {
    const recorded = recordPairedProviderStream(() => {
      const intentRows = eventsFor("provider", actor.id);
      expect(intentRows.map((row) => row.recordKind)).toEqual(["intent"]);
      return (async function* () { yield "progress"; })();
    }, { name: "paired-foundation", intent: { args: { input: "safe" } }, capture: () => ({ outcome: "succeeded", documents }) });
    expect((await recorded.stream.next()).value).toBe("progress");
    expect(eventsFor("provider", actor.id)).toHaveLength(1);
    await recorded.stream.next();
    const result = recorded.settlement!;
    expect(result.intent?.status).toBe("recorded");
    expect(result.recording.status).toBe("recorded");
    if (result.intent?.status !== "recorded" || result.recording.status !== "recorded") throw new Error("Actual pair receipts are required");
    const intentReceipt = result.intent.receipt;
    const terminalReceipt = result.recording.receipt;
    const intent = getTimelineQuery().getEvent(intentReceipt.eventId)!;
    const terminal = getTimelineQuery().getEvent(terminalReceipt.eventId)!;
    expect(eventsOf("provider").filter((row) => row.effectId === intent.effectId)).toHaveLength(2);
    expect(intent.recordKind).toBe("intent");
    // The store derives a terminal's provenance from its persisted intent
    // (21572220), so the pair is recorded under the originating actor — and
    // nothing else is: an extra standalone completion under this actor is
    // still detected here.
    expect(eventsFor("provider", actor.id).map((row) => row.eventId).sort()).toEqual([intent.eventId, terminal.eventId].sort());
    expect(terminal.actorId).toBe(actor.id);
    expect(JSON.parse(intent.documents.find((doc) => doc.name === TIMELINE_EFFECT_ARGS_DOCUMENT)!.contentJson!)).toEqual({ input: "safe" });
    expect(terminal.recordKind).toBe("terminal");
    expect(terminal.effectId).toBe(intent.effectId);
    expect(terminal.documents.find((doc) => doc.name === TIMELINE_LLM_RESPONSE_DOCUMENT)?.contentJson).toBe(contentJson);
    expect(eventsFor("engine", actor.id)).toHaveLength(0);
  });
});
