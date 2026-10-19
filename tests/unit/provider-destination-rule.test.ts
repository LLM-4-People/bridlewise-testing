// @vitest-environment node
/**
 * THE DESTINATION RULE IS THE CREDENTIAL'S (secc-design H2, secc-security
 * SECC-V-B1): a non-admin who saves a provider at a loopback or private
 * address cannot make the server reach it — not through model discovery, not
 * through "Test connection", not through a run — because the rule is stamped
 * on the credential when it is minted and every one of those doors sends
 * through it. An admin's provider may; an admin may allow users' providers
 * (`network.userPrivateAddresses`). Measured with a REAL internal server:
 * nothing reaches it when refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { registerModelRoutes } from "../../server/routes/models.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { parseProviderStore, resolveProviderCredential } from "../../server/llm/providers.ts";
import { resetProviderClients, streamChat } from "../../server/llm/llm-bridge.ts";
import { installOutboundPolicySource, privateAddressesAllowedFor } from "../../engine/src/shared/outbound-policy.ts";
import { address, received, serve } from "../../engine/test/support/loopback-upstream.ts";
import { responseJsonResponse } from "../../engine/test/support/mock-provider.ts";

const INTERNAL = "https://internal.test/v1";
const SECRET_PAGE = "INTERNAL-ONLY-SECRET-PAGE-4711";

let srv: HttpTestServer;
let admin: ReturnType<typeof createTestUser>;
let user: ReturnType<typeof createTestUser>;

beforeAll(async () => {
  srv = await startHttpTestServer({ prefix: "ch-destination-rule-", register: (router, _db, adb) => registerModelRoutes(router, adb) });
  admin = createTestUser(srv.db, "rule-admin"); // the first user is the admin
  user = createTestUser(srv.db, "rule-user");
});

afterAll(async () => {
  installOutboundPolicySource(() => ({}));
  if (srv) await srv.stop();
});

/** The internal server: it answers everything, and counts what reached it. */
function internalServer(): void {
  serve((url) => (url.endsWith("/models")
    ? new Response(JSON.stringify({ data: [{ id: "internal-model" }] }), { headers: { "content-type": "application/json" } })
    : new Response(JSON.stringify({ error: { message: SECRET_PAGE } }), { status: 500, headers: { "content-type": "application/json" } })));
}

async function saveInternalProvider(cookie: string): Promise<void> {
  const saved = await jsonRequest(srv.baseUrl, "/api/models/prefs", { method: "PUT", cookie,
    body: { providers: [{ id: "internal", baseUrl: address(INTERNAL), apiKey: "user-key-bbbb", models: [{ id: "internal-model" }] }], defaultModel: "internal-model" } });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
}

describe("a non-admin's provider at a private address", () => {
  test("discovery, the connection test and a run are all refused, and nothing reaches the internal server", async () => {
    internalServer();
    await saveInternalProvider(user.cookie);
    resetProviderClients();

    const discovered = await jsonRequest(srv.baseUrl, "/api/models/discover", { method: "POST", cookie: user.cookie, body: { baseUrl: address(INTERNAL), apiKey: "user-key-bbbb" } });
    expect(discovered.body).toMatchObject({ ok: false });
    const tested = await jsonRequest(srv.baseUrl, "/api/models/providers/internal/test", { method: "POST", cookie: user.cookie });
    expect(tested.body).toMatchObject({ ok: false });
    expect(JSON.stringify(tested.body)).not.toContain(SECRET_PAGE);

    const credential = resolveProviderCredential(parseProviderStore({ providers: [{ id: "internal", baseUrl: address(INTERNAL), apiKey: "user-key-bbbb", models: [{ id: "internal-model" }] }] }), "internal-model", { isAdmin: false });
    expect(credential.allowPrivateAddress).toBe(false);
    const events: unknown[] = [];
    for await (const event of streamChat("hello", { credential })) events.push(event);
    // The run's error event carries the door's refusal (a run surfaces the sentence, not the code).
    expect(JSON.stringify(events)).toMatch(/is on this machine or a private network, which this request may not reach/u);

    expect(received.length, "no request reached the internal server").toBe(0);
  });

  test("an admin's provider at the same address IS reached (a local model server is a real case)", async () => {
    internalServer();
    await saveInternalProvider(admin.cookie);
    const discovered = await jsonRequest(srv.baseUrl, "/api/models/discover", { method: "POST", cookie: admin.cookie, body: { baseUrl: address(INTERNAL), apiKey: "admin-key-aaaa" } });
    expect(discovered.body).toMatchObject({ ok: true, models: [{ id: "internal-model" }] });
    expect(received.length).toBe(1);
    expect(received[0]!.headers.get("authorization")).toBe("Bearer admin-key-aaaa");
  });

  test("an admin may allow users' providers to reach private addresses; the next credential follows", async () => {
    expect(privateAddressesAllowedFor({ isAdmin: false })).toBe(false);
    installOutboundPolicySource(() => ({ userPrivateAddresses: "allow" }));
    try {
      expect(privateAddressesAllowedFor({ isAdmin: false })).toBe(true);
      serve(() => responseJsonResponse({ content: "answered" }));
      const tested = await jsonRequest(srv.baseUrl, "/api/models/providers/internal/test", { method: "POST", cookie: user.cookie });
      expect(tested.body).toMatchObject({ ok: true });
      expect(received.length).toBe(1);
    } finally {
      installOutboundPolicySource(() => ({}));
    }
  });
});
