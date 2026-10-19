// @vitest-environment node
/**
 * PROVIDER CRUD AND THE REFUSAL THAT NAMES THE REMEDY.
 *
 * Three things this file holds down, each of which was a real gap:
 *
 *  1. REMOVE. There was no delete path at all — the merge is add-and-replace,
 *     so a provider saved with a typo stayed in the picker permanently.
 *  2. TEST CONNECTION. There was no way to find out a key was wrong except by
 *     writing a prompt and watching a run fail.
 *  3. ONE REFUSAL. The message a refused run shows and the message the setup
 *     surface shows must be the SAME string, from one owner, or they drift
 *     into describing different remedies.
 *
 * The connection test here runs against a closed port on loopback, on purpose:
 * what is under test is that a REAL request is attempted and its failure
 * reported honestly, not that some particular endpoint is up.
 */
import { vi, describe, test, expect, beforeAll, afterAll } from "vitest";

// The connection probe is bounded by `providerTestTimeoutMs`, and this file
// deliberately drives the TIMEOUT path — so the bound is lowered before the
// config module resolves it. Without this the file spends the product default
// (5 s) proving a point that a quarter-second proves just as well, against a
// suite budget the whole fleet shares.
vi.hoisted(() => {
  process.env["HARNESS_WEB_PROVIDER_TEST_TIMEOUT_MS"] = "300";
});

import { registerModelRoutes } from "../../server/routes/models.ts";
import { createTestUser, seedProvider, TEST_PROVIDER_ID } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import {
  PROVIDER_SETUP_REMEDY,
  parseProviderStore,
  resolveProviderCredential,
  storedContextWindowFor,
} from "../../server/llm/providers.ts";
import { resetProviderClients } from "../../server/llm/llm-bridge.ts";
import { ProviderNotConfiguredError } from "../../server/kernel/errors.ts";
import { responseJsonResponse, responseResource } from "../../engine/test/support/mock-provider.ts";
import { SharedLLMClient } from "../../engine/src/shared/llm/client.ts";
import { PROVIDER_FIXTURE_OWNER } from "../helpers/multi-user.ts";
import { address, serve } from "../../engine/test/support/loopback-upstream.ts";

let srv: HttpTestServer;
let cookie: string;
let userId: string;

type Catalog = {
  providers: { id: string; hasApiKey: boolean; models: { id: string }[] }[];
  defaultProvider: string | null;
  defaultModel: string | null;
  setupRequired: boolean;
  setupRemedy: string;
};

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const { status, body: json } = await jsonRequest(srv.baseUrl, path, { method, body, cookie });
  return { status, json };
}

beforeAll(async () => {
  srv = await startHttpTestServer({
    prefix: "ch-models-route-",
    register: (router, _db, adb) => {
      registerModelRoutes(router, adb);
    },
  });
  const user = createTestUser(srv.db, "models-tester");
  cookie = user.cookie;
  userId = user.userId;
});

afterAll(async () => {
  if (srv) await srv.stop();
});

describe("removing a provider", () => {
  test("a saved provider can be removed, and stops being listed", async () => {
    seedProvider(srv.db, userId, { models: ["throwaway-model"], providerId: "throwaway" });
    const before = (await req("GET", "/api/models")).json as Catalog;
    expect(before.providers.map((provider) => provider.id)).toContain("throwaway");

    const { status, json } = await req("DELETE", "/api/models/providers/throwaway");
    expect(status).toBe(200);
    const after = (json as { ok: boolean; prefs: Catalog }).prefs;
    expect(after.providers.map((provider) => provider.id)).not.toContain("throwaway");

    // And the removal is what the next read sees, not just what the write
    // route claimed: an in-memory success over an unchanged row is exactly the
    // failure this route exists to make impossible.
    const reread = (await req("GET", "/api/models")).json as Catalog;
    expect(reread.providers.map((provider) => provider.id)).not.toContain("throwaway");
  });

  test("removing the provider that held the default moves the default", async () => {
    seedProvider(srv.db, userId, { models: ["defaulted-model"], providerId: "defaulted" });
    // Make it the default explicitly, so the assertion is about the removal
    // rather than about which provider happened to be first.
    await req("PUT", "/api/models/prefs", {
      providers: [],
      defaultProvider: "defaulted",
      defaultModel: "defaulted-model",
    });
    expect(((await req("GET", "/api/models")).json as Catalog).defaultProvider).toBe("defaulted");

    await req("DELETE", "/api/models/providers/defaulted");
    const after = (await req("GET", "/api/models")).json as Catalog;
    // A default pointing at a provider that no longer exists would make every
    // later run refuse with a message about a model "no provider serves" —
    // true, and useless.
    expect(after.defaultProvider).not.toBe("defaulted");
    expect(after.defaultModel).not.toBe("defaulted-model");
    if (after.defaultProvider !== null) {
      expect(after.providers.map((provider) => provider.id)).toContain(after.defaultProvider);
    }
  });

  test("removing something that was never there is REPORTED, not silently accepted", async () => {
    const { status, json } = await req("DELETE", "/api/models/providers/never-existed");
    expect(status).toBe(404);
    expect((json as { error: string }).error).toBe("provider_unknown");
    expect((json as { message: string }).message).toContain("never-existed");
  });
});

describe("testing a provider's connection", () => {
  test("a real request is attempted, and its failure is reported with the provider's own words", async () => {
    // The seeded provider points at a closed port. A test that merely
    // validated the URL's SHAPE would pass here; only one that actually sends a
    // request can fail, which is what makes the result worth anything.
    const { status, json } = await req("POST", `/api/models/providers/${TEST_PROVIDER_ID}/test`);
    expect(status).toBe(200);
    const result = json as { providerId: string; modelId: string; ok: boolean; detail?: string; failureKind?: string; elapsedMs: number };
    expect(result.providerId).toBe(TEST_PROVIDER_ID);
    expect(result.ok).toBe(false);
    expect(typeof result.detail).toBe("string");
    expect(result.detail?.length).toBeGreaterThan(0);
    // An unreachable endpoint is NAMED as such — the class words, never the
    // retry layer's internal phrasing ("retry cancelled by caller" read as
    // the caller's own cancellation to a user who mistyped the address).
    expect(result.failureKind).toBe("no-answer");
    expect(result.detail).not.toContain("retry cancelled");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    // The key must not ride out on the failure text.
    expect(JSON.stringify(result)).not.toContain("test-key-not-a-real-credential");
  });

  test("the probe sends EXACTLY ONE request — the first attempt's own error is the verdict", async () => {
    // The verb's title promises ONE real request, and the honest failure of
    // one request is that attempt's own error. The probe client is built on
    // a zeroed retry table for exactly this reason; a probe on the RUN
    // client (retry with backoff) hit the button's own timeout mid-backoff
    // and reported the retry layer's cancellation phrasing as the verdict.
    // MUTATION: build the probe on the run client and this reds both ways —
    // a once-failing endpoint recovers to ok:true on the retry, and the
    // call count is the retry budget, not 1.
    // A REAL upstream answers (the door owns its transport): the saved
    // provider lives at the loopback address; a throw drops the connection.
    seedProvider(srv.db, userId, { baseUrl: address("https://probe.test/v1") });
    resetProviderClients();
    let llmCalls = 0;
    serve(async (url) => {
      if (url.endsWith("/responses")) {
        llmCalls += 1;
        if (llmCalls === 1) throw new TypeError("fetch failed");
        return responseJsonResponse({ content: "ok" });
      }
      throw new Error(`unexpected request ${url}`);
    });
    try {
      const { status, json } = await req("POST", `/api/models/providers/${TEST_PROVIDER_ID}/test`);
      expect(status).toBe(200);
      const result = json as { ok: boolean; failureKind?: string; detail?: string };
      expect(result.ok).toBe(false);
      expect(result.failureKind).toBe("no-answer");
      expect(
        llmCalls,
        "the probe is single-shot: exactly one request, no backoff ladder",
      ).toBe(1);
    } finally {
      seedProvider(srv.db, userId);
      resetProviderClients();
    }
  });

  test("testing a provider that has no key refuses by name, before any request", async () => {
    srv.db.upsertUserModelPrefs(userId, {
      providers: [{ id: "no-key", baseUrl: "https://provider.invalid/v1", models: [{ id: "m" }] }],
    });
    const { status, json } = await req("POST", "/api/models/providers/no-key/test");
    expect(status).toBe(428);
    expect((json as { error: string }).error).toBe("provider_key_missing");
    expect((json as { message: string }).message).toContain("no-key");
  });

  test.each([
    ["answered", "completed", undefined, "Ready", true, undefined],
    ["budget exhausted", "incomplete", "max_output_tokens", null, false, "output-limit"],
    ["filtered", "incomplete", "content_filter", "Partial", false, "invalid-response"],
    ["steered", "incomplete", "steered", "Partial", false, "invalid-response"],
    ["queued", "queued", undefined, null, false, "invalid-response"],
    ["in progress", "in_progress", undefined, "Partial", false, "invalid-response"],
    ["status omitted", undefined, undefined, "Apparent answer", false, "invalid-response"],
    ["failed", "failed", undefined, "Partial", false, "invalid-response"],
    ["cancelled", "cancelled", undefined, "Partial", false, "invalid-response"],
    ["empty terminal answer", "completed", undefined, null, false, "invalid-response"],
    ["whitespace answer", "completed", undefined, " \n ", false, "invalid-response"],
  ] as const)("a reasoning provider %s preserves the actual verdict and single request", async (_label, status, reason, content, ok, failureKind) => {
    seedProvider(srv.db,userId,{baseUrl:address("https://probe.test/v1")});
    resetProviderClients();
    let calls=0;
    const retirement = vi.spyOn(SharedLLMClient.prototype, "retireResponse");
    serve(async(url,init)=>{
      if(!url.endsWith("/responses"))throw new Error(`unexpected request ${url}`);
      calls++;
      const request=JSON.parse(String(init.body));
      expect(request.max_output_tokens,"bounded allowance must let a reasoning model reach its answer").toBe(256);
      expect(request.stream).toBe(false);
      const answer = responseResource({ ...(content === null ? {} : { content }) }).output as Record<string, unknown>[];
      const resource = responseResource({ ...(status === undefined ? {} : { status }), ...(reason === undefined ? {} : { reason }), output: [
        { type: "reasoning", id: "rs_probe", summary: [{ type: "summary_text", text: "never expose reasoning in probe errors" }] }, ...answer],
        usage: { input_tokens: 17, output_tokens: content ? 211 : 256, total_tokens: content ? 228 : 273 } });
      if (status === undefined) delete resource.status;
      return new Response(JSON.stringify(resource), { headers: { "content-type": "application/json" } });
    });
    try {
      const response=await req("POST",`/api/models/providers/${TEST_PROVIDER_ID}/test`);
      expect(response.status).toBe(200);
      expect(response.json).toMatchObject({ok,...(failureKind===undefined?{}:{failureKind})});
      expect(JSON.stringify(response.json)).not.toContain("never expose reasoning");
      expect(calls).toBe(1);
      expect(retirement).toHaveBeenCalledWith("resp_fixture", TEST_PROVIDER_ID);
    }finally{retirement.mockRestore();seedProvider(srv.db,userId);resetProviderClients();}
  });

  test("testing a provider that is not saved is a 404 naming it", async () => {
    const { status, json } = await req("POST", "/api/models/providers/not-mine/test");
    expect(status).toBe(404);
    expect((json as { error: string }).error).toBe("provider_unknown");
  });
});

describe("the refusal and the setup surface read the SAME sentence", () => {
  test("an empty store refuses with the remedy, as a 428", () => {
    const store = parseProviderStore({ providers: [] });
    let thrown: unknown;
    try {
      resolveProviderCredential(store, null, PROVIDER_FIXTURE_OWNER);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProviderNotConfiguredError);
    const err = thrown as ProviderNotConfiguredError;
    expect(err.code).toBe("provider_not_configured");
    expect(err.statusCode).toBe(428);
    // 428 says "you must do something first". 503 would say "try again
    // later", which is false — retrying cannot make a provider appear.
    expect(err.message).toContain(PROVIDER_SETUP_REMEDY);
  });

  test("the sentence the API hands the setup surface is byte-identical to it", async () => {
    srv.db.upsertUserModelPrefs(userId, { providers: [] });
    const { json } = await req("GET", "/api/models");
    const data = json as Catalog;
    expect(data.setupRequired).toBe(true);
    // Byte equality, not "contains" — two sentences that merely overlap are
    // two sentences, and they drift.
    expect(data.setupRemedy).toBe(PROVIDER_SETUP_REMEDY);
  });

  test("naming a model no saved provider serves refuses with its own code", () => {
    const store = parseProviderStore({
      providers: [{ id: "p", baseUrl: "https://x.invalid", apiKey: "k", models: [{ id: "served" }] }],
    });
    // The served model resolves.
    expect(resolveProviderCredential(store, "served", PROVIDER_FIXTURE_OWNER).providerId).toBe("p");
    // An unserved one does not, and says which model and what to do — four
    // distinguishable refusals rather than one, because the remedies differ.
    let thrown: unknown;
    try {
      resolveProviderCredential(store, "not-served", PROVIDER_FIXTURE_OWNER);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProviderNotConfiguredError);
    expect((thrown as ProviderNotConfiguredError).code).toBe("model_not_configured");
    expect((thrown as Error).message).toContain("not-served");
  });

  test("a stored default answers when nothing else named a model; without one it refuses", () => {
    const withDefault = parseProviderStore({
      providers: [{ id: "p", baseUrl: "https://x.invalid", apiKey: "k", models: [{ id: "m" }] }],
      defaultModel: "m",
    });
    expect(resolveProviderCredential(withDefault, null, PROVIDER_FIXTURE_OWNER).modelId).toBe("m");

    const withoutDefault = parseProviderStore({
      providers: [{ id: "p", baseUrl: "https://x.invalid", apiKey: "k", models: [{ id: "m" }] }],
    });
    // Deliberately NOT "there is only one model, use it": that is a
    // resolution-time guess, and it would move the moment a second model was
    // added — silently, and only for the runs that chose nothing.
    let thrown: unknown;
    try {
      resolveProviderCredential(withoutDefault, null, PROVIDER_FIXTURE_OWNER);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as ProviderNotConfiguredError).code).toBe("model_not_chosen");
  });
});

describe("custom request headers — the shape a user saves is the shape that is stored", () => {
  // The class: a stored provider field that never reaches the engine. The
  // schema used to be a strictObject of id/baseUrl/apiKey/models, so a saved
  // header had nowhere to live — a proxy requiring `X-Org-Id` could not be
  // configured at all. These arms drive the WRITE ROUTE, so the assertion is
  // about what the product stores, not what a schema in isolation accepts.

  test("a provider saved with custom headers stores them and reports only their NAMES", async () => {
    const { status, json } = await req("PUT", "/api/models/prefs", {
      providers: [{
        id: "behind-a-proxy",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "proxy-route-key",
        models: [{ id: "proxy-model" }],
        headers: { "X-Org-Id": "org-42", "X-Route": "blue" },
      }],
    });
    expect(status).toBe(200);
    // The stored document carries the full pair — the engine needs the values.
    const stored = srv.db.getUserModelPrefs(userId) as {
      providers: { id: string; headers?: Record<string, string> }[];
    };
    const saved = stored.providers.find((p) => p.id === "behind-a-proxy");
    expect(saved?.headers).toEqual({ "X-Org-Id": "org-42", "X-Route": "blue" });
    // The WIRE projection carries the names — enough for the settings surface
    // to say what is saved — and never the values, which can be secret-shaped.
    const view = (json as { prefs: { providers: { id: string; headerNames?: string[] }[] } })
      .prefs.providers.find((p) => p.id === "behind-a-proxy");
    expect(view?.headerNames).toEqual(["X-Org-Id", "X-Route"]);
    expect(JSON.stringify(json)).not.toContain("org-42");
    // And the read-back sees the same names — the values stay server-side.
    const reread = (await req("GET", "/api/models")).json as {
      providers: { id: string; headerNames?: string[] }[];
    };
    expect(reread.providers.find((p) => p.id === "behind-a-proxy")?.headerNames)
      .toEqual(["X-Org-Id", "X-Route"]);
  });

  test("a credential-carrying header name is REFUSED, whichever door it enters by", async () => {
    // The rule lives in the schema, so it cannot be bypassed by skipping a
    // route check. Driven on BOTH doors: the real HTTP write, and the schema
    // the route parses — a direct `parseProviderStore` (the seeding helper's
    // door) must refuse identically.
    for (const name of ["Authorization", "authorization", "X-API-Key", "Cookie", "Proxy-Authorization"]) {
      const { status, json } = await req("PUT", "/api/models/prefs", {
        providers: [{
          id: "hdr-refused",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "k",
          models: [{ id: "m" }],
          headers: { [name]: "some-value" },
        }],
      });
      expect(status, `header "${name}" must be refused at the route`).toBe(400);
      expect(JSON.stringify(json), `the refusal names the header`).toContain(name);
      expect(JSON.stringify(json), "the refusal never echoes the value").not.toContain("some-value");

      const direct = parseProviderStore({
        providers: [{
          id: "hdr-refused", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k",
          models: [{ id: "m" }], headers: { [name]: "some-value" },
        }],
      });
      expect(
        direct.providers.find((p) => p.id === "hdr-refused"),
        `a direct parse must refuse "${name}" too (the store reports the unreadable shape as empty)`,
      ).toBeUndefined();
    }
    // BOTH DIRECTIONS — the gate is not an off switch. An ordinary routing
    // header is admitted, so "refuse everything" cannot pass this file.
    const { status } = await req("PUT", "/api/models/prefs", {
      providers: [{
        id: "hdr-ok", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k",
        models: [{ id: "m" }], headers: { "X-Org-Id": "o", "X-Team": "search" },
      }],
    });
    expect(status, "an ordinary header must be admitted").toBe(200);
  });

  test("a header whose value IS this provider's own key is refused — the same secret twice", async () => {
    // EXACTLY the key, not a substring: "the same secret stored twice" is the
    // misconfiguration, and a substring rule would refuse any short key that
    // appears inside an ordinary value ("k" inside "kept-value").
    const { status, json } = await req("PUT", "/api/models/prefs", {
      providers: [{
        id: "hdr-key-dup",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "the-providers-own-key",
        models: [{ id: "m" }],
        headers: { "X-Custom": "the-providers-own-key" },
      }],
    });
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toContain("X-Custom");
    // The refusal names the FIELD, never the key it refused to duplicate.
    expect(JSON.stringify(json)).not.toContain("the-providers-own-key");
  });

  test("editing a provider without resending headers keeps the saved set", async () => {
    await req("PUT", "/api/models/prefs", {
      providers: [{
        id: "hdr-kept", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k",
        models: [{ id: "m" }], headers: { "X-Org-Id": "kept-value" },
      }],
    });
    // Edit the address only — no headers in the body. The saved set must
    // survive, exactly as a blank key field keeps the saved key: correcting
    // one field must not silently unset another.
    await req("PUT", "/api/models/prefs", {
      providers: [{ id: "hdr-kept", baseUrl: "http://127.0.0.1:2/v1", models: [{ id: "m" }] }],
    });
    const stored = srv.db.getUserModelPrefs(userId) as {
      providers: { id: string; headers?: Record<string, string> }[];
    };
    expect(stored.providers.find((p) => p.id === "hdr-kept")?.headers).toEqual({ "X-Org-Id": "kept-value" });
  });
});

describe("per-model settings — the fields a model can declare, stored and served", () => {
  // The class: settings the user can save per model but could not say in the
  // UI — the context window, the reply cap, the temperature. The schema used
  // to carry only {id, maxTokens?, temperature?}, and even those two had no
  // editor. These arms drive the WRITE ROUTE so the assertion is about what
  // the product stores, and the credential mint so it is about what a run
  // actually consumes.

  test("a model saved with its own settings stores them and serves them back on the wire", async () => {
    const { status, json } = await req("PUT", "/api/models/prefs", {
      providers: [{
        id: "per-model",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        models: [{ id: "tuned-model", contextWindow: 8192, maxTokens: 1024, temperature: 0.5 }],
      }],
    });
    expect(status).toBe(200);
    // The stored document carries the full per-model row.
    const stored = srv.db.getUserModelPrefs(userId) as {
      providers: { id: string; models: { id: string; contextWindow?: number; maxTokens?: number; temperature?: number }[] }[];
    };
    const saved = stored.providers.find((p) => p.id === "per-model")?.models[0];
    expect(saved).toEqual({ id: "tuned-model", contextWindow: 8192, maxTokens: 1024, temperature: 0.5 });
    // The WIRE projection carries them too — the settings editor prefills
    // from this answer, so the fields must cross or the UI could never
    // round-trip what it just saved.
    const view = (json as { prefs: { providers: { id: string; models: { id: string; contextWindow?: number }[] }[] } })
      .prefs.providers.find((p) => p.id === "per-model");
    expect(view?.models[0]?.contextWindow).toBe(8192);
    const reread = (await req("GET", "/api/models")).json as {
      providers: { id: string; models: { id: string; contextWindow?: number; maxTokens?: number; temperature?: number }[] }[];
    };
    expect(reread.providers.find((p) => p.id === "per-model")?.models[0])
      .toEqual({ id: "tuned-model", contextWindow: 8192, maxTokens: 1024, temperature: 0.5 });
  });

  test("an invalid context window is REFUSED at the schema, whichever shape it takes", async () => {
    // Zero, negative, fractional, and non-integer-string shapes are all
    // "not a window", and the store must not accept any of them — a stored
    // lie is one the trim would then honour.
    for (const bad of [0, -5, 8192.5]) {
      const { status, json } = await req("PUT", "/api/models/prefs", {
        providers: [{
          id: "bad-window",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "k",
          models: [{ id: "m", contextWindow: bad }],
        }],
      });
      expect(status, `contextWindow ${bad} must be refused at the route`).toBe(400);
      expect(JSON.stringify(json), "the refusal names the field").toContain("contextWindow");
    }
    // BOTH DIRECTIONS — the gate is not an off switch: a whole positive
    // number is admitted.
    const { status } = await req("PUT", "/api/models/prefs", {
      providers: [{
        id: "ok-window", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k",
        models: [{ id: "m", contextWindow: 4096 }],
      }],
    });
    expect(status, "a real window must be admitted").toBe(200);
  });

  test("a temperature outside 0–2 is refused, naming the model row", async () => {
    const { status, json } = await req("PUT", "/api/models/prefs", {
      providers: [{
        id: "hot-model",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        models: [{ id: "m", temperature: 3 }],
      }],
    });
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toContain("temperature");
  });

  test("a stored BARE model id keeps parsing — the rows before settings existed", async () => {
    // Read-compat: the document a user already has (bare id strings) must
    // still load, and saving it back through the merge must not invent
    // fields or drop the model.
    await req("PUT", "/api/models/prefs", {
      providers: [{ id: "legacy", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: [{ id: "legacy-model" }] }],
    });
    const reread = (await req("GET", "/api/models")).json as {
      providers: { id: string; models: { id: string }[] }[];
    };
    const legacy = reread.providers.find((p) => p.id === "legacy");
    expect(legacy?.models).toEqual([{ id: "legacy-model" }]);
  });

  test("the credential carries the model's OWN facts — what a run actually consumes", () => {
    const store = parseProviderStore({
      providers: [{
        id: "p",
        baseUrl: "https://x.invalid",
        apiKey: "k",
        models: [
          { id: "plain" },
          { id: "declared", contextWindow: 8192, maxTokens: 512, temperature: 0.2 },
        ],
      }],
      defaultModel: "declared",
    });
    const credential = resolveProviderCredential(store, null, PROVIDER_FIXTURE_OWNER);
    expect(credential.modelId).toBe("declared");
    expect(credential.model).toEqual({ contextWindow: 8192, maxTokens: 512, temperature: 0.2 });
    // The record is ALWAYS present — a model that declared nothing answers
    // an empty one, so a consumer never re-checks for a field it cannot
    // spell.
    const plain = resolveProviderCredential(store, "plain", PROVIDER_FIXTURE_OWNER);
    expect(plain.model).toEqual({});
    expect("contextWindow" in plain.model).toBe(false);
  });

  test("the context window a stored model declares is readable without minting a credential", () => {
    // The compose preview reads the window while the provider may still owe
    // a key — minting refuses in that state, so the reader must not.
    const store = parseProviderStore({
      providers: [{
        id: "p",
        baseUrl: "https://x.invalid",
        // no apiKey — the provider owes one
        models: [{ id: "windowed", contextWindow: 4096 }, { id: "bare" }],
      }],
      defaultModel: "windowed",
    });
    expect(storedContextWindowFor(store, null)).toBe(4096);
    expect(storedContextWindowFor(store, "bare")).toBeUndefined();
    expect(storedContextWindowFor(store, "not-served")).toBeUndefined();
  });
});

describe("the default model is a stored choice the settings surface can change", () => {
  // The gap: saving the first provider RECORDED `first.models[0]` as the
  // default and there was no way to change it afterward. The write route
  // already accepts `defaultModel` and derives the provider from it; these
  // arms prove that path changes the STORED answer, not only the response.

  test("posting a new defaultModel changes the stored default AND the derived provider", async () => {
    // Two providers, each serving its own model — the default starts on one.
    await req("PUT", "/api/models/prefs", {
      providers: [
        { id: "dp-a", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: [{ id: "model-a" }] },
        { id: "dp-b", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: [{ id: "model-b" }] },
      ],
      defaultModel: "model-a",
    });
    const before = (await req("GET", "/api/models")).json as Catalog;
    expect(before.defaultModel).toBe("model-a");
    expect(before.defaultProvider).toBe("dp-a");

    // THE CHANGE: only the model id is posted — no provider field. A model
    // names exactly one provider, so the provider is derived, not asked twice.
    const { status } = await req("PUT", "/api/models/prefs", {
      providers: [],
      defaultModel: "model-b",
    });
    expect(status).toBe(200);
    const after = (await req("GET", "/api/models")).json as Catalog;
    expect(after.defaultModel, "the stored default moved").toBe("model-b");
    expect(after.defaultProvider, "and the provider followed it").toBe("dp-b");

    // The resolution the RUN path reads answers the new default — this is the
    // fact a run will act on, not the projection the UI shows.
    const store = parseProviderStore(srv.db.getUserModelPrefs(userId));
    expect(resolveProviderCredential(store, null, PROVIDER_FIXTURE_OWNER).modelId).toBe("model-b");
    expect(resolveProviderCredential(store, null, PROVIDER_FIXTURE_OWNER).providerId).toBe("dp-b");
  });

  test("a default the serving provider does not carry is refused by the schema", async () => {
    // The other direction of the same pair: the document cannot name a
    // default model beside a provider that does not serve it. Asserted here
    // because a "change the default" UI that could store a dangling pair
    // would re-open the disagreement the schema exists to prevent.
    const { status } = await req("PUT", "/api/models/prefs", {
      providers: [
        { id: "only-one", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: [{ id: "its-model" }] },
      ],
      defaultProvider: "only-one",
      defaultModel: "a-model-nobody-serves",
    });
    expect(status).toBe(400);
  });
});

describe("the credential cannot be forged", () => {
  test("the only producer is the resolver, and the key is a call rather than a field", () => {
    const store = parseProviderStore({
      providers: [{ id: "p", baseUrl: "https://x.invalid", apiKey: "the-secret", models: [{ id: "m" }] }],
      defaultModel: "m",
    });
    const credential = resolveProviderCredential(store, null, PROVIDER_FIXTURE_OWNER);
    expect(credential.apiKey()).toBe("the-secret");
    // The value is safe to serialise, log and spread: there is no enumerable
    // key on it to leak. This is what makes a credential passable through the
    // run registry, the ledger and every debug print without a rule about it.
    expect(JSON.stringify(credential)).not.toContain("the-secret");
    // Spreading it copies a FUNCTION, never the secret — so a credential put
    // into a ledger row, an SSE frame or a structured log carries nothing.
    expect(Object.values({ ...credential })).not.toContain("the-secret");
    expect(typeof (credential as unknown as { apiKey: unknown }).apiKey).toBe("function");
    // And no OTHER own property holds it either — the check is over every
    // value the object exposes, not over the one field we thought to name.
    expect(Object.values(credential).filter((value) => typeof value === "string"))
      .not.toContain("the-secret");
  });
});

describe("unsaved provider model discovery", () => {
  test("stored and draft endpoints reject even empty query and fragment delimiters", async () => {
    const { credentialForDiscovery } = await import("../../server/llm/providers.ts");
    for (const suffix of ["?", "#", "?#", "#?"]) {
      const baseUrl = `https://draft.example/v1${suffix}`;
      const document = { providers: [{ id: "draft", baseUrl, apiKey: "fixture", models: [{ id: "m" }] }] };
      expect(parseProviderStore(document).providers).toHaveLength(0);
      expect((await req("PUT", "/api/models/prefs", document)).status).toBe(400);
      expect(() => credentialForDiscovery(parseProviderStore({ providers: [] }), { baseUrl, apiKey: "fixture" }, PROVIDER_FIXTURE_OWNER)).toThrowError(
        expect.objectContaining({ name: "ZodError", issues: [expect.objectContaining({ code: "custom", path: ["baseUrl"] })] }),
      );
    }
  });
  test("a malformed discovery body is refused 400 at the route, before any request leaves", async () => {
    let requests = 0;
    serve(async () => { requests++; return Response.json({ object: "list", data: [] }); });
    for (const body of [{ baseUrl: 1 }, { baseUrl: address("https://draft.example/v1"), apiKey: "k", extra: true }, ["not", "an", "object"]]) {
      const result = await req("POST", "/api/models/discover", body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(result.json).toMatchObject({ error: "validation_failed" });
    }
    expect(requests, "a refused body never reaches the provider").toBe(0);
  });

  test("saved secrets are reused only at their own endpoint and no preferences are written", async () => {
    const key="discovery-only-key-17c937efab";
    const saved=address("https://discovery.example/v1");
    await req("PUT","/api/models/prefs",{providers:[{id:"discovery-owned",baseUrl:saved,apiKey:key,headers:{"X-Org":"owned-org"},models:[{id:"kept-model"}]}]});
    const before=await req("GET","/api/models");
    let requests=0;
    serve(async(url,init)=>{
      if(url!=="https://discovery.example/v1/models") throw new Error(`unexpected request ${url}`);
      requests++;expect(init.method).toBe("GET");expect(init.body).toBeUndefined();
      expect(init.headers.get("authorization")).toBe("Bearer "+key);
      expect(init.headers.get("X-Org")).toBe("owned-org");
      return Response.json({object:"list",data:[{id:"paused/model",context_window:262144,max_output_tokens:32768,status:"paused"},{id:"generic"},{id:"invalid-limits",context_window:-1,max_output_tokens:"guess"}]});
    });
    {
      const result=await req("POST","/api/models/discover",{savedProviderId:"discovery-owned",baseUrl:saved});
      expect(result).toEqual({status:200,json:{ok:true,models:[{id:"paused/model",contextWindow:262144,maxTokens:32768},{id:"generic"},{id:"invalid-limits"}]}});
      expect(requests).toBe(1);expect(JSON.stringify(result)).not.toContain(key);
      const changed=await req("POST","/api/models/discover",{savedProviderId:"discovery-owned",baseUrl:address("https://different.example/v1")});
      expect(changed.status).toBe(428);expect(changed.json).toMatchObject({error:"provider_key_missing"});expect(requests).toBe(1);
      expect(await req("GET","/api/models")).toEqual(before);
    }
  });

  test("new draft discovery needs no saved model and scrubs echoed secrets from refusal", async () => {
    const key="draft-discovery-secret-9231abff";
    serve(async(url)=>{
      if(url!=="https://draft-discovery.example/v1/models") throw new Error(`unexpected request ${url}`);
      return new Response("refused key "+key,{status:401});
    });
    {
      const result=await req("POST","/api/models/discover",{baseUrl:address("https://draft-discovery.example/v1"),apiKey:key});
      expect(result.status).toBe(200);expect(result.json).toMatchObject({ok:false,failureKind:"refused-key"});
      expect(JSON.stringify(result)).not.toContain(key);
      expect(((await req("GET","/api/models")).json as Catalog).providers.some(p=>p.id==="provider draft")).toBe(false);
    }
  });

  test("discovery capabilities cannot become inference credentials or be redirected by a spread", async () => {
    const {credentialForDiscovery,admitEndpointCredential,admitMintedCredential}=await import("../../server/llm/providers.ts");
    const {ForgedProviderCredentialError}=await import("../../server/kernel/errors.ts");
    const endpoint=credentialForDiscovery(parseProviderStore({providers:[]}),{baseUrl:"https://draft.example/v1",apiKey:"safe-draft-key"}, PROVIDER_FIXTURE_OWNER);
    expect(admitEndpointCredential(endpoint)).toBe(endpoint);
    expect(()=>admitEndpointCredential({...endpoint,baseUrl:"https://other.example/v1"})).toThrow(ForgedProviderCredentialError);
    expect(()=>admitMintedCredential(endpoint as never)).toThrow(ForgedProviderCredentialError);
    expect(Object.isFrozen(endpoint)).toBe(true);
    expect(JSON.stringify(endpoint)).not.toContain("safe-draft-key");
  });
});
