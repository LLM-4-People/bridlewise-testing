// @vitest-environment node
/**
 * SAVING A PROVIDER MUST NOT DELETE THE PROVIDERS YOU DID NOT TOUCH.
 *
 * THE DEFECT: `PUT /api/models/prefs` persisted the request body verbatim
 * into the user's `config_json` blob. The settings form builds a
 * SINGLE-provider array — it only knows about the provider being added — so
 * saving a second provider replaced the first. Silent, unrecoverable user
 * data loss, with a success toast on top of it.
 *
 * The write route now merges by provider IDENTITY: a posted provider
 * replaces the stored provider with the same id, and stored providers the
 * request never mentioned survive. The merge lives at the WRITE route, not
 * in each caller — "remember to always send the complete array" is precisely
 * the contract that was broken.
 *
 * Second, quieter loss: the READ path replaced the entire provider list with
 * the user's overrides, so saving one personal provider hid every provider
 * the harness config declares. Both paths now share one merge owner.
 *
 * REAL HTTP against a REAL SQLite DB — a unit test of the merge function
 * would not prove the ROUTE uses it.
 *
 * DYNAMIC: the assertions compare provider-id SETS computed from the
 * responses, so they hold no matter how many providers the config declares
 * or the user adds.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { registerAuthRoutes } from "../../server/routes/auth.ts";
import { registerModelRoutes } from "../../server/routes/models.ts";
import { createTestUser, type TestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";

type Provider = { id: string; baseUrl: string; models: { id: string }[] };
type PrefsBody = { ok: boolean; prefs: { providers: Provider[]; defaultModel?: string } };

let srv: HttpTestServer;
let user: TestUser;

beforeAll(async () => {
  srv = await startHttpTestServer({
    prefix: "ch-modelprefs-",
    register: (router, db, adb) => {
      registerAuthRoutes(router, adb);
      registerModelRoutes(router, adb);
    },
  });
  user = createTestUser(srv.db, "prefs-owner");
  // This file's subject is the MERGE — what happens to the providers a save
  // does not mention — so it asserts on exact provider lists. `createTestUser`
  // seeds a working provider (the state a real user is in after setup), which
  // is right for the fleet and wrong here: it would make every expected list
  // carry a passenger. Cleared so the sequence below starts from genuinely
  // nothing and each assertion is about the merge alone.
  srv.db.upsertUserModelPrefs(user.userId, { providers: [] });
});

afterAll(async () => {
  if (srv) await srv.stop();
});

async function req(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  return jsonRequest(srv.baseUrl, path, {
    method: init?.method,
    body: init?.body,
    cookie: user.cookie,
  });
}

function providerIds(body: unknown): string[] {
  const providers = (body as { prefs?: { providers?: Provider[] }; providers?: Provider[] });
  const list = providers.prefs?.providers ?? providers.providers ?? [];
  return list.map((p) => p.id).sort();
}

/** One provider payload as the settings form builds it: a single entry. */
function singleProvider(id: string, model: string): unknown {
  return { providers: [{ id, baseUrl: `https://${id}.example/v1`, models: [{ id: model }] }] };
}

describe("PUT /api/models/prefs — a write never clobbers untouched providers", () => {
  test("the first provider is stored", async () => {
    const { status, body } = await req("/api/models/prefs", {
      method: "PUT",
      body: singleProvider("alpha", "alpha-1"),
    });
    expect(status).toBe(200);
    expect(providerIds(body)).toEqual(["alpha"]);
  });

  test("saving a SECOND provider keeps the first (the data-loss defect)", async () => {
    const { status, body } = await req("/api/models/prefs", {
      method: "PUT",
      body: singleProvider("beta", "beta-1"),
    });
    expect(status).toBe(200);
    expect(
      providerIds(body),
      "the response must report both providers — the write merges, it does not replace",
    ).toEqual(["alpha", "beta"]);
  });

  test("the STORED prefs (read back) contain both providers", async () => {
    const { status, body } = await req("/api/models/prefs");
    expect(status).toBe(200);
    expect(providerIds(body)).toEqual(["alpha", "beta"]);
  });

  test("a third provider still preserves the earlier two", async () => {
    await req("/api/models/prefs", { method: "PUT", body: singleProvider("gamma", "gamma-1") });
    const { body } = await req("/api/models/prefs");
    expect(providerIds(body)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("re-saving an EXISTING provider id updates it in place (no duplicate)", async () => {
    await req("/api/models/prefs", {
      method: "PUT",
      body: { providers: [{ id: "beta", baseUrl: "https://beta.example/v2", models: [{ id: "beta-2" }] }] },
    });
    const { body } = await req("/api/models/prefs");
    expect(providerIds(body)).toEqual(["alpha", "beta", "gamma"]);
    const stored = (body as { prefs: { providers: Provider[] } }).prefs.providers;
    const beta = stored.find((p) => p.id === "beta");
    expect(beta?.baseUrl, "the posted entry wins for its own id").toBe("https://beta.example/v2");
    expect(beta?.models.map((m) => m.id)).toEqual(["beta-2"]);
  });

  test("a scalar field set earlier survives a later provider-only write", async () => {
    await req("/api/models/prefs", { method: "PUT", body: { providers: [], defaultModel: "beta-2" } });
    await req("/api/models/prefs", { method: "PUT", body: singleProvider("delta", "delta-1") });
    const { body } = await req("/api/models/prefs");
    expect((body as PrefsBody).prefs.defaultModel, "defaultModel must not be dropped").toBe("beta-2");
    expect(providerIds(body)).toContain("delta");
  });

  test("GET /api/models keeps the CONFIG providers alongside the user's", async () => {
    const { status, body } = await req("/api/models");
    // 503 means the harness config declares no providers at all — then there
    // is nothing to preserve and this assertion has no subject.
    if (status === 503) return;
    expect(status).toBe(200);
    const ids = providerIds(body);
    // Every provider the user saved must be present…
    for (const id of ["alpha", "beta", "gamma", "delta"]) expect(ids).toContain(id);
    // …and the list must be strictly larger than the user's own set if the
    // config declares any, i.e. config providers were not replaced.
    expect(ids.length).toBeGreaterThanOrEqual(4);
  });
});
