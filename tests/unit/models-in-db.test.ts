// @vitest-environment node
/**
 * THE DATABASE IS THE ONLY SOURCE OF MODEL PROVIDERS.
 *
 * This file used to assert the opposite: that `bridlewise.config.json`
 * supplied a provider list which a per-user DB row then merged over. That is
 * a FALLBACK SOURCE — a second place the server goes looking for an answer the
 * user gives in Settings — and it fired precisely when the user had configured
 * nothing, which is the moment nobody is watching. The file reads are deleted,
 * and these tests hold the deletion down.
 *
 * The strongest assertion here is the negative one: a config file IS written
 * to disk, naming a provider, and `GET /api/models` must still return nothing.
 * If a future edit re-adds a file read "just as a default", this file reds.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";

import { registerModelRoutes } from "../../server/routes/models.ts";
import { createTestUser, seedProvider } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

let srv: HttpTestServer;
/** A user who has configured NOTHING — the first-run subject. */
let freshCookie: string;
let freshUserId: string;
/** A user who has completed setup. */
let configuredCookie: string;
let configuredUserId: string;

type Catalog = {
  providers: { id: string; baseUrl: string; models: { id: string }[]; hasApiKey: boolean }[];
  defaultProvider: string | null;
  defaultModel: string | null;
  setupRequired: boolean;
  setupRemedy: string;
};

async function req(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const { status, body: json } = await jsonRequest(srv.baseUrl, path, { method, body, cookie });
  return { status, json };
}

beforeAll(async () => {
  // A config file that DOES declare a provider, written on purpose. Its whole
  // job in this file is to be ignored: if any assertion below ever sees
  // "from-the-config-file", a file read has come back.
  const dir = createTempDir("ch-models-in-db-");
  process.env["HARNESS_CONFIG_PATH"] = `${dir}/harness.config.json`;
  writeFileSync(
    process.env["HARNESS_CONFIG_PATH"],
    JSON.stringify({
      runtime: {
        defaultProvider: "from-the-config-file",
        defaultModel: "model-from-the-config-file",
        providers: [{
          id: "from-the-config-file",
          baseUrl: "https://inference.example.invalid/v1",
          models: [{ id: "model-from-the-config-file", maxTokens: 16384 }],
        }],
      },
    }),
  );

  srv = await startHttpTestServer({
    prefix: "ch-models-in-db-",
    register: (router, _db, adb) => {
      registerModelRoutes(router, adb);
    },
  });
  const configured = createTestUser(srv.db, "models-db-configured");
  configuredCookie = configured.cookie;
  configuredUserId = configured.userId;
  const fresh = createTestUser(srv.db, "models-db-fresh");
  freshCookie = fresh.cookie;
  freshUserId = fresh.userId;
  // `createTestUser` seeds a provider, because a configured account is the
  // normal subject for the rest of the fleet. THIS user is the first-run case,
  // so the seed is taken back out — the state under test is genuinely "nothing
  // saved", not "saved something empty".
  srv.db.upsertUserModelPrefs(freshUserId, { providers: [] });
});

afterAll(async () => {
  if (srv) await srv.stop();
});

describe("providers come from the database and from nowhere else", () => {
  test("a user with nothing saved gets an EMPTY list and a guided state", async () => {
    const { status, json } = await req(freshCookie, "GET", "/api/models");
    // 200, not 503: nothing is broken, the user simply has something to do.
    expect(status).toBe(200);
    const data = json as Catalog;
    expect(data.providers).toEqual([]);
    expect(data.setupRequired).toBe(true);
    expect(data.defaultProvider).toBeNull();
    expect(data.defaultModel).toBeNull();
    // The remedy is a real sentence naming a real action, not a file path.
    expect(data.setupRemedy).toContain("Settings");
    expect(data.setupRemedy.length).toBeGreaterThan(20);
    expect(data.setupRemedy).not.toContain("/tmp");
    expect(data.setupRemedy).not.toContain(".json");
  });

  test("THE FILE IS NOT READ: a config file naming a provider changes nothing", async () => {
    const { json } = await req(freshCookie, "GET", "/api/models");
    const data = json as Catalog;
    // The config file on disk declares `from-the-config-file`. If it ever
    // appears here, a fallback source has been restored.
    expect(data.providers.map((provider) => provider.id)).not.toContain("from-the-config-file");
    expect(data.defaultProvider).not.toBe("from-the-config-file");
    expect(data.defaultModel).not.toBe("model-from-the-config-file");
  });

  test("saving a provider makes it — and only it — appear", async () => {
    const { status, json } = await req(freshCookie, "PUT", "/api/models/prefs", {
      providers: [{
        id: "my-service",
        baseUrl: "http://localhost:8080/v1",
        apiKey: "a-key-the-user-typed",
        models: [{ id: "my-custom-model" }],
      }],
    });
    expect(status).toBe(200);
    const saved = json as { ok: boolean; prefs: Catalog };
    expect(saved.ok).toBe(true);
    expect(saved.prefs.setupRequired).toBe(false);
    expect(saved.prefs.providers.map((provider) => provider.id)).toEqual(["my-service"]);
    // The FIRST provider records the defaults, at write time, so the next run
    // has an answer without anything guessing one at read time.
    expect(saved.prefs.defaultProvider).toBe("my-service");
    expect(saved.prefs.defaultModel).toBe("my-custom-model");
  });

  test("the API key never comes back — only whether one exists", async () => {
    const { json } = await req(freshCookie, "GET", "/api/models");
    const data = json as Catalog;
    const provider = data.providers.find((candidate) => candidate.id === "my-service");
    expect(provider).toBeDefined();
    expect(provider?.hasApiKey).toBe(true);
    // The whole serialised response, not just the field we thought to check:
    // a key smuggled into any corner of the body fails here.
    expect(JSON.stringify(data)).not.toContain("a-key-the-user-typed");
    const prefs = await req(freshCookie, "GET", "/api/models/prefs");
    expect(JSON.stringify(prefs.json)).not.toContain("a-key-the-user-typed");
  });

  test("editing a provider without retyping the key keeps the key", async () => {
    const { status, json } = await req(freshCookie, "PUT", "/api/models/prefs", {
      providers: [{
        id: "my-service",
        baseUrl: "http://localhost:9999/v2",
        models: [{ id: "my-custom-model" }],
      }],
    });
    expect(status).toBe(200);
    const prefs = (json as { prefs: Catalog }).prefs;
    const provider = prefs.providers.find((candidate) => candidate.id === "my-service");
    expect(provider?.baseUrl).toBe("http://localhost:9999/v2");
    // Correcting the address must not silently unset the credential — the
    // symptom would be a refused run much later, with nothing pointing here.
    expect(provider?.hasApiKey).toBe(true);
  });

  test("a provider saved without a key is kept and reported as incomplete", async () => {
    const { status, json } = await req(freshCookie, "PUT", "/api/models/prefs", {
      providers: [{
        id: "keyless",
        baseUrl: "http://localhost:8081/v1",
        models: [{ id: "keyless-model" }],
      }],
    });
    expect(status).toBe(200);
    const prefs = (json as { prefs: Catalog }).prefs;
    const provider = prefs.providers.find((candidate) => candidate.id === "keyless");
    // Not rejected (which would read as "your provider vanished") and not
    // pretended-complete: kept, and honestly flagged.
    expect(provider).toBeDefined();
    expect(provider?.hasApiKey).toBe(false);
  });

  test("PUT rejects a provider with no address", async () => {
    const { status } = await req(freshCookie, "PUT", "/api/models/prefs", {
      providers: [{ id: "bad", models: [] }],
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  test("what one user saves, another does not see", async () => {
    const { json } = await req(configuredCookie, "GET", "/api/models");
    const data = json as Catalog;
    expect(data.providers.map((provider) => provider.id)).not.toContain("my-service");
    // And the configured user's own seeded provider IS there, so this is a
    // statement about isolation rather than about an empty response.
    expect(data.providers.length).toBeGreaterThan(0);
    expect(configuredUserId).not.toBe(freshUserId);
  });

  test("the seeding helper writes through the product's own door", () => {
    // The helper is not a stub: it writes the same encrypted row the route
    // writes, which is why the route can read it back at all.
    seedProvider(srv.db, configuredUserId, { models: ["an-extra-model"], providerId: "an-extra-service" });
    const stored = srv.db.getUserModelPrefs(configuredUserId) as { providers: { id: string }[] };
    expect(stored.providers.map((provider) => provider.id)).toContain("an-extra-service");
  });
});
