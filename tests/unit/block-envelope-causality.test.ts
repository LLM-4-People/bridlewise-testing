// @vitest-environment node
/**
 * The envelope carries causality — from the ambient context, and only from it.
 *
 * This is the server half of LENS Layer 1/2. The client half
 * (`readEnvelopeCausality`) has always been ready to read these fields; until
 * now nothing wrote them, so every provenance plate honestly reported "not
 * carried by the envelope". These tests pin the three properties that make
 * writing them trustworthy:
 *
 *   1. AMBIENT ONLY. A caller cannot supply causality, so it cannot supply it
 *      wrongly. This is locked twice — `envelope`'s parameter type excludes
 *      the causal fields, and they are stripped at runtime as well. Ordering
 *      alone was NOT enough: with no ambient context there is nothing to
 *      overwrite a forged value with, so a spread-last would have let a caller
 *      supply causality in exactly the case where the server knows least.
 *      That hole was found by the test in class C, not by review.
 *   2. ABSENCE IS PRESERVED. No context → no fields. Not empty strings, not a
 *      freshly-minted trace id. A synthetic trace would point at nothing in
 *      `event_log` while looking exactly like one that points at something.
 *   3. `eventId` STAYS ABSENT. A block read appends no ledger event, so there
 *      is no event id to carry. This is asserted, not merely documented, so
 *      the gap cannot be quietly filled with a span id wearing a disguise.
 */
import { describe, test, expect } from "vitest";

import { z } from "zod";

import { clearBlocks, defineBlock, envelope, mountBlockRoutes, principledRefusalOf } from "../../server/blocks/define.ts";
import {
  MapNotReadyError,
  ProviderNotConfiguredError,
  ServiceUnavailableError,
  ValidationError,
} from "../../server/kernel/errors.ts";
import type { RouteHandler, Router } from "../../server/router/router.ts";
import { createMockRes, mockReq } from "../helpers/mock-http.ts";
import { withRecordingContext, withSpan } from "../../server/kernel/canonical.ts";
import { readEnvelopeCausality } from "../../shared/provenance.ts";

describe("A. outside any recording boundary, causality is ABSENT", () => {
  test("no context yields no actor and no trace", () => {
    const meta = envelope({ ok: true }).meta;
    expect(meta.actor, "an actor was invented outside any boundary").toBeUndefined();
    expect(meta.traceId, "a trace id was invented outside any boundary").toBeUndefined();
  });

  test("the client reader agrees there is nothing to read", () => {
    // The two sides must not disagree about what "absent" means.
    expect(readEnvelopeCausality(envelope({ ok: true }).meta)).toEqual({});
  });

  test("the ordinary meta is unaffected", () => {
    const meta = envelope({ ok: true }).meta;
    expect(meta.etag).toMatch(/^W\/"/);
    expect(typeof meta.asOf).toBe("number");
  });
});

describe("B. inside a recording boundary, causality is real", () => {
  test("the actor comes from the ambient context", () => {
    const meta = withRecordingContext(
      { actor: { kind: "user", id: "u-42", role: "owner" } },
      () => envelope({ ok: true }).meta,
    );
    expect(meta.actor).toBe("user:u-42");
  });

  test("a trace id appears once a span is open", () => {
    const meta = withRecordingContext({ actor: { kind: "user", id: "u-42" } }, () =>
      withSpan("block:code.graph:abc", () => envelope({ ok: true }).meta),
    );
    expect(meta.traceId).toBe("block:code.graph:abc");
  });

  test("a nested span INHERITS the outer trace — one value, one chain", () => {
    // This is what makes "everything recorded while producing this value" a
    // single query. If the inner span opened a new trace, the chain would
    // fragment at every nesting level.
    const meta = withRecordingContext({ actor: { kind: "user", id: "u-1" } }, () =>
      withSpan("outer", () => withSpan("inner", () => envelope({ ok: true }).meta)),
    );
    expect(meta.traceId).toBe("outer");
  });

  test("an unattributed actor is reported, not hidden", () => {
    // `unattributed:unknown` is the harness's deliberate visible admission
    // that something recorded outside a boundary. Swallowing it would hide a
    // wiring bug behind a plausible blank.
    const meta = withRecordingContext(
      { actor: { kind: "unattributed", id: "unknown" } },
      () => envelope({ ok: true }).meta,
    );
    expect(meta.actor).toBe("unattributed:unknown");
  });

  test("an actor with an EMPTY id yields no actor at all, not a bare `kind:`", () => {
    // `user:` looks like an attribution and identifies nobody. Absence is the
    // only honest rendering of an actor the context could not name, and it is
    // what the client already knows how to display. Found by mutation: the
    // length guard was previously unprotected by any test.
    const meta = withRecordingContext({ actor: { kind: "user", id: "" } }, () =>
      envelope({ ok: true }).meta,
    );
    expect(meta.actor, "an actor with no id was rendered as a bare `kind:`").toBeUndefined();
  });

  test("the client reader picks the fields up unchanged — Layer 2's join key arrives", () => {
    const meta = withRecordingContext({ actor: { kind: "user", id: "u-7" } }, () =>
      withSpan("trace-xyz", () => envelope({ ok: true }).meta),
    );
    expect(readEnvelopeCausality(meta)).toEqual({ actor: "user:u-7", traceId: "trace-xyz" });
  });
});

describe("C. causality cannot be supplied by a caller", () => {
  /**
   * `envelope`'s parameter type EXCLUDES the causal fields, so these calls do
   * not compile without a cast — that is the first lock. The cast here is
   * deliberate: it proves the SECOND lock, the runtime strip, which is what
   * protects against a JavaScript caller or anyone who casts around the type.
   */
  const forge = (extra: Record<string, unknown>) =>
    (envelope as (d: unknown, e?: unknown) => { meta: Record<string, unknown> })({ ok: true }, extra)
      .meta;

  test("an `extra` actor is overruled by the ambient one", () => {
    const meta = withRecordingContext({ actor: { kind: "user", id: "real" } }, () =>
      forge({ actor: "user:forged" }),
    );
    expect(meta.actor, "a caller forged an actor into the envelope").toBe("user:real");
  });

  test("an `extra` trace id is overruled by the ambient one", () => {
    const meta = withRecordingContext({ actor: { kind: "user", id: "u" } }, () =>
      withSpan("real-trace", () => forge({ traceId: "forged-trace" })),
    );
    expect(meta.traceId).toBe("real-trace");
  });

  test("a caller cannot conjure causality where the context has none", () => {
    // Outside a boundary there is genuinely nothing to say, and `extra` must
    // not become a side door for saying it anyway.
    const meta = forge({ actor: "user:forged", traceId: "forged", eventId: "forged-event" });
    expect(meta["actor"]).toBeUndefined();
    expect(meta["traceId"]).toBeUndefined();
    expect(meta["eventId"], "a caller forged an eventId into the envelope").toBeUndefined();
  });

  test("non-causal `extra` fields still work — the ordering breaks nothing", () => {
    const meta = envelope({ ok: true }, { cursor: "c1", partial: true }).meta;
    expect(meta.cursor).toBe("c1");
    expect(meta.partial).toBe(true);
  });
});

describe("D. eventId stays honestly absent", () => {
  test("no ambient context can produce an eventId", () => {
    // A block read appends no ledger event. The ambient context carries a
    // span id, and a span id is a call-structure label, NOT a foreign key
    // into event_log. If this test ever fails, someone has started
    // synthesising an event id — check that it references a REAL row before
    // deleting this guard.
    const meta = withRecordingContext({ actor: { kind: "user", id: "u" } }, () =>
      withSpan("block:code.graph:1", () => envelope({ ok: true }).meta),
    );
    expect(
      meta.eventId,
      "an eventId appeared in the envelope. It must reference a real event_log row; " +
        "a span id is not one.",
    ).toBeUndefined();
  });

  test("the trace id is NOT quietly reused as an event id", () => {
    const meta = withRecordingContext({ actor: { kind: "user", id: "u" } }, () =>
      withSpan("span-1", () => envelope({ ok: true }).meta),
    );
    expect(meta.eventId).not.toBe(meta.traceId);
  });
});

describe("E. the mounted route really carries causality end to end", () => {
  /**
   * The tests above call `envelope()` directly, which proves the populator but
   * not the WIRING. `mountBlockRoutes` is what a real request crosses, and it
   * is where the span that supplies the trace id is opened. A fake Router
   * captures the registered handler so the whole path can be driven without a
   * server, a socket or a port.
   */
  function captureHandler(): { handler: RouteHandler | undefined } {
    const captured: { handler: RouteHandler | undefined } = { handler: undefined };
    const router = {
      get: (_p: string, h: RouteHandler) => { captured.handler = h; },
      post: () => undefined,
      put: () => undefined,
      patch: () => undefined,
      delete: () => undefined,
      dispatch: async () => undefined,
    } as unknown as Router;
    mountBlockRoutes(router);
    return captured;
  }

  async function driveRead(): Promise<Record<string, unknown>> {
    clearBlocks();
    defineBlock({
      id: "probe.read",
      title: "Probe",
      description: "A block that exists only to observe what the mount path produces.",
      read: { input: z.object({}), output: z.unknown(), handler: () => ({ ok: true }) },
    });
    const captured = captureHandler();
    // The shared mock records `write` chunks; `sendJson` passes the body to
    // `end`. Observing `end` here rather than changing the shared mock keeps
    // every other consumer of `createMockRes` untouched.
    const res = createMockRes();
    let body = "";
    const originalEnd = res.end.bind(res);
    res.end = ((data?: unknown) => {
      if (typeof data === "string") body = data;
      return originalEnd();
    }) as unknown as typeof res.end;
    await captured.handler?.({
      params: {}, query: new URLSearchParams(), body: undefined,
      res, req: mockReq({}), sessionId: "s-1",
    } as unknown as Parameters<RouteHandler>[0]);
    clearBlocks();
    const parsed = JSON.parse(body) as { meta: Record<string, unknown> };
    return parsed.meta;
  }

  test("a mounted read carries a trace id — the span is opened by the mount", () => {
    // Removing `withSpan` from mountBlockRoutes leaves the actor intact and
    // silently drops the trace, which is the join key Layer 2 needs. Without
    // this test that regression is invisible.
    return withRecordingContext({ actor: { kind: "user", id: "u-9" } }, async () => {
      const meta = await driveRead();
      expect(meta["traceId"], "the mounted read produced no trace id").toEqual(
        expect.stringContaining("block:probe.read:"),
      );
    });
  });

  test("a mounted read carries the ambient actor", () => {
    return withRecordingContext({ actor: { kind: "user", id: "u-9" } }, async () => {
      const meta = await driveRead();
      expect(meta["actor"]).toBe("user:u-9");
    });
  });

  test("two reads get DISTINCT traces — ids cannot collide into a false chain", () => {
    return withRecordingContext({ actor: { kind: "user", id: "u-9" } }, async () => {
      const a = await driveRead();
      const b = await driveRead();
      expect(a["traceId"]).not.toBe(b["traceId"]);
    });
  });

  test("the client reader gets both fields off a real mounted response", () => {
    return withRecordingContext({ actor: { kind: "user", id: "u-9" } }, async () => {
      const causality = readEnvelopeCausality(await driveRead());
      expect(causality.actor).toBe("user:u-9");
      expect(causality.traceId).toBeDefined();
      // Still absent, still honestly so.
      expect(causality.eventId).toBeUndefined();
    });
  });
});

describe("F. a principled refusal is an ANSWER, not an error status", () => {
  /**
   * THE STANDING CONSOLE ERROR, AND WHERE IT CAME FROM. The Switch's custody
   * badge asks `custody.state` for the self-protected project at every boot;
   * the server answers its DESIGNED `git_not_run` refusal, and the browser —
   * which logs every non-2xx status itself, before any page code runs —
   * printed "Failed to load resource: 503" in every healthy session. No
   * client `console.error` existed to remove; the status was the noise.
   *
   * A principled refusal (a typed 428/503 WebError carrying the server's
   * own sentence) is deterministic data that the response grammar renders as
   * REFUSED — so the block read route now serves it in the 200 envelope, the
   * 202 "indexing" contract's sibling, and the client's Broker reconstructs
   * the typed error at its single read door. Real failures are NOT this
   * family and must keep their error statuses — the arms below drive both
   * directions.
   */

  /** Drive one mounted read whose handler throws `make(). */
  async function driveRefusedRead(
    make: () => unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    clearBlocks();
    defineBlock({
      id: "probe.read",
      title: "Probe",
      description: "A block that exists only to observe what the mount path produces.",
      read: {
        input: z.object({}),
        output: z.unknown(),
        handler: () => {
          throw make();
        },
      },
    });
    const captured: { handler: RouteHandler | undefined } = { handler: undefined };
    const router = {
      get: (_p: string, h: RouteHandler) => { captured.handler = h; },
      post: () => undefined,
      put: () => undefined,
      patch: () => undefined,
      delete: () => undefined,
      dispatch: async () => undefined,
    } as unknown as Router;
    mountBlockRoutes(router);
    const res = createMockRes();
    let body = "";
    const originalEnd = res.end.bind(res);
    res.end = ((data?: unknown) => {
      if (typeof data === "string") body = data;
      return originalEnd();
    }) as unknown as typeof res.end;
    await captured.handler?.({
      params: {}, query: new URLSearchParams(), body: undefined,
      res, req: mockReq({}), sessionId: "s-1",
    } as unknown as Parameters<RouteHandler>[0]);
    clearBlocks();
    return { status: res.headerStatus, body: JSON.parse(body) as Record<string, unknown> };
  }

  const GUARDIAN_SENTENCE =
    "The custody state could not be read because this server would not run git: " +
    "the project folder is the harness's own code. Choose a different project folder.";

  test("a typed 503 refusal travels in the 200 envelope, not as an error status", async () => {
    const { status, body } = await driveRefusedRead(
      () => new ServiceUnavailableError(GUARDIAN_SENTENCE, "git_not_run"),
    );
    expect(status, "the browser logs the status itself — a designed refusal is not an error").toBe(200);
    expect(body["data"], "a refusal measured nothing; data must say so, not imply a zero").toBeNull();
    expect(body["refusal"]).toEqual({
      code: "git_not_run",
      message: GUARDIAN_SENTENCE,
      status: 503,
    });
    // The envelope's own contract still holds — causality, etag, asOf.
    const meta = body["meta"] as Record<string, unknown>;
    expect(typeof meta["etag"]).toBe("string");
    expect(typeof meta["asOf"]).toBe("number");
  });

  test("a typed 428 guided-state refusal is the same family", async () => {
    const { status, body } = await driveRefusedRead(
      () =>
        new ProviderNotConfiguredError(
          "no usable model provider is saved — add one in settings first",
          "provider_not_configured",
        ),
    );
    expect(status).toBe(200);
    expect(body["refusal"]).toEqual({
      code: "provider_not_configured",
      message: "no usable model provider is saved — add one in settings first",
      status: 428,
    });
  });

  test("REAL failures are not this family — they propagate to the router's error mapping", async () => {
    // A typed VALIDATION error (400) is a genuine failure: swallowing it into
    // a 200 envelope would let a caller read a bug as an answer.
    await expect(
      driveRefusedRead(() => new ValidationError("the input was malformed", "invalid_block_input")),
    ).rejects.toMatchObject({ code: "invalid_block_input" });
    // An untyped throw is a 500 the router maps — never a refusal.
    await expect(driveRefusedRead(() => new Error("the worker exploded"))).rejects.toThrow(
      "the worker exploded",
    );
  });

  test("the classifier is DRIVEN — both directions, and the near-miss statuses", () => {
    expect(principledRefusalOf(new ServiceUnavailableError("m", "git_not_run"))).toEqual({
      code: "git_not_run",
      message: "m",
      status: 503,
    });
    expect(principledRefusalOf(new ProviderNotConfiguredError("m"))).toEqual({
      code: "provider_not_configured",
      message: "m",
      status: 428,
    });
    // NOT the family: an untyped throw, a typed 4xx, a typed 202 (the
    // indexing contract has its own shape), a plain object that looks like
    // nothing.
    expect(principledRefusalOf(new Error("plain"))).toBeNull();
    expect(principledRefusalOf(new ValidationError("m"))).toBeNull();
    expect(principledRefusalOf(new MapNotReadyError("m"))).toBeNull();
    expect(principledRefusalOf({ statusCode: 503 })).toBeNull();
    expect(principledRefusalOf(null)).toBeNull();
  });
});
