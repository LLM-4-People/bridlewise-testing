// @vitest-environment node
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { UI_SCHEMA_VERSION } from "../../shared/ui-schema.ts";

import { registerSchemaRoutes } from "../../server/routes/schema.ts";
import {
  installCustomizationConfigStore,
  registerAllExposure,
  listCustomizations,
} from "../../server/kernel/canonical.ts";
import { readConfigRaw } from "../../server/kernel/harness-config.ts";
import { serverConfig } from "../../server/kernel/config.ts";
import { servedSettingsIdsTheRawDetectorWouldCorrupt } from "../helpers/egress-id-corpus.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { makeJsonRequest } from "../helpers/json-request.ts";

/**
 * Integration test: real HTTP server with the schema routes registered.
 * Exercises the full request → route → schema builder → response cycle.
 *
 * the router owns auth + CSRF. The schema routes now require an
 * authenticated user (GETs) + admin (POST action / PUT customization — they
 * mutate GLOBAL harness state). The test registers an admin user (the
 * first registered user is the admin) and sends the session cookie; CSRF
 * is opted into via `X-Requested-With` on mutations.
 */

let srv: HttpTestServer;
let req: (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: unknown }>;

beforeAll(async () => {
  // Config-bound customizations write through the installed config store. The
  // PUT customization route drives `setSchemaCustomization` → the config write
  // gate; install an IN-MEMORY store (seeded from the real config) so the real
  // `bridlewise.config.json` is never written by this suite, while the
  // route's read-back still reflects the write.
  let doc: Record<string, unknown> = readConfigRaw();
  installCustomizationConfigStore({
    configFilePath: serverConfig.harnessConfigPath,
    readDocument: () => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
    writeDocument: (next) => {
      doc = next;
    },
  });
  // The exposure registry the id-fidelity arms assert against. Idempotent;
  // the routes also self-register on first request, but the arms read the
  // registry directly and must not depend on test ordering.
  registerAllExposure();
  // The schema routes do their own requireUserContext + requireAdminContext
  // (independent of the registry's isPublicPath), so the router is created
  // with `isPublicPath: () => true` to bypass the registry's auth gate and
  // rely on the schema routes' own admin gate. The first registered user is
  // the admin (v12); this cookie satisfies requireAdminContext.
  srv = await startHttpTestServer({
    prefix: "ch-routes-schema-",
    isPublicPath: () => true,
    register: (router, db, adb) => {
      registerSchemaRoutes(router, adb);
    },
  });
  const authCookie = createTestUser(srv.db, "schema-admin").cookie;
  req = makeJsonRequest(() => srv.baseUrl, () => authCookie);
});

afterAll(async () => {
  if (srv) await srv.stop();
});

describe("GET /api/schema/ui", () => {
  test("returns the full UI schema with correct version", async () => {
    const { status, body } = await req("/api/schema/ui");
    expect(status).toBe(200);
    const schema = body as { version: string; menus: unknown[]; panels: unknown[]; widgets: unknown[]; signals: unknown[]; settings: unknown[]; actions: unknown[] };
    // Asserted against the CONSTANT, not a literal. A hardcoded version string
    // makes the test fail on every deliberate bump for no reason, which trains
    // people to edit the assertion rather than read it.
    expect(schema.version).toBe(UI_SCHEMA_VERSION);
    expect(Array.isArray(schema.menus)).toBe(true);
    expect(Array.isArray(schema.panels)).toBe(true);
    expect(Array.isArray(schema.widgets)).toBe(true);
    expect(Array.isArray(schema.signals)).toBe(true);
    expect(Array.isArray(schema.settings)).toBe(true);
    expect(Array.isArray(schema.actions)).toBe(true);
  });

  test("schema includes backend exposure signals (110+)", async () => {
    const { body } = await req("/api/schema/ui");
    const schema = body as { signals: { id: string }[] };
    expect(schema.signals.length).toBeGreaterThan(50);
    expect(schema.signals.find((s) => s.id === "search.queryCount")).toBeDefined();
  });

  test("schema excludes the non-functional memory/search badges (prevention)", async () => {
    const { body } = await req("/api/schema/ui");
    const schema = body as { widgets: { id: string; signalId?: string; component?: string }[] };
    // the "memory-entries" and "search-queries" chat-bar badges were
    // removed because they showed static counts that never updated and were
    // not actionable. This test prevents them from being re-added.
    expect(schema.widgets.find((w) => w.id === "memory-entries")).toBeUndefined();
    expect(schema.widgets.find((w) => w.id === "search-queries")).toBeUndefined();
  });
});

describe("GET /api/schema/ui/values", () => {
  test("returns current signal + customization values", async () => {
    const { status, body } = await req("/api/schema/ui/values");
    expect(status).toBe(200);
    const values = body as { signals: unknown[]; customizations: unknown[] };
    expect(values.signals.length).toBeGreaterThan(0);
    expect(values.customizations.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE EGRESS REDACTION CONTRACT FOR THE SETTINGS WIRES — the ids this
// server mints must survive their own wires byte-for-byte.
//
// The measured defect (UIE-079): the value-intrinsic layer read the
// customization id `graph.slowLlmMsThreshold` as "18 unbroken random-looking
// characters", so BOTH wires served it as `[REDACTED:credential]` — the
// row rendered by label, its Save verb posted the masked id back, and the
// server answered a raw 404 against an id it had minted itself. The
// user-display walk now exempts a leaf that byte-equals a registry-minted
// id (the authorship exemption), and these arms hold the wire-level
// contract the masked id broke. Every population is discovered from the
// LIVE registry or the SERVED wire — never a list.
// ─────────────────────────────────────────────────────────────────────────

describe("the settings wires carry the registry's own ids (egress redaction contract)", () => {
  test("the whole schema wire carries no redaction marker, and every registry id arrives verbatim", async () => {
    const { body } = await req("/api/schema/ui");
    const wire = JSON.stringify(body);
    expect(
      wire,
      "the schema wire carries a redaction marker — a served id or label was masked on its own wire",
    ).not.toContain("[REDACTED:");
    expect(wire).not.toContain("[redacted]");
    // Deny-by-default in the coverage direction: every customization the
    // registry holds must be served, byte-identical, on the settings wire —
    // a row the wire lost or mangled fails by name.
    const schema = body as { settings: { id: string; customizationId: string }[] };
    const servedIds = new Set(schema.settings.map((s) => s.id));
    const missing: string[] = [];
    for (const c of listCustomizations()) {
      if (!servedIds.has(c.id)) missing.push(c.id);
      const entry = schema.settings.find((s) => s.id === c.id);
      expect(entry?.customizationId, `${c.id}: customizationId must equal the registry id`).toBe(c.id);
    }
    expect(missing, "registry customizations missing from the served settings wire").toEqual([]);
  });

  test("the values wire carries every registry id verbatim and no redaction marker in any id field", async () => {
    const { body } = await req("/api/schema/ui/values");
    const values = body as { customizations: { id: string; value: unknown }[] };
    const servedIds = new Set(values.customizations.map((c) => c.id));
    const missing: string[] = [];
    for (const c of listCustomizations()) {
      if (!servedIds.has(c.id)) missing.push(c.id);
    }
    expect(missing, "registry customizations missing from the served values wire").toEqual([]);
    for (const row of values.customizations) {
      expect(String(row.id), `${String(row.id)}: a served id is a redaction marker`).not.toContain(
        "[REDACTED:",
      );
    }
  });

  test("a settings id the raw detector would mask still saves through its own door (UIE-079's row)", async () => {
    // Found, not listed: the corpus is every SERVED settings id whose raw
    // detector output differs from its input — the exact rows the egress
    // exemption exists for. Today that is `graph.slowLlmMsThreshold`; a
    // registration whose camelCase name trips the heuristic tomorrow joins
    // this corpus with no edit here, and its row must save through the
    // same door.
    const { body: schemaBody } = await req("/api/schema/ui");
    const { body: valuesBody } = await req("/api/schema/ui/values");
    const currentValues = new Map(
      ((valuesBody as { customizations: { id: string; value: unknown }[] }).customizations)
        .map((c) => [c.id, c.value] as const),
    );
    const affected = servedSettingsIdsTheRawDetectorWouldCorrupt(schemaBody);
    expect(
      affected.length,
      "no served settings id trips the raw detector — the corpus is empty; the oracle or the exemption changed",
    ).toBeGreaterThan(0);
    expect(affected).toContain("graph.slowLlmMsThreshold");

    for (const id of affected) {
      const cust = listCustomizations().find((c) => c.id === id)!;
      // The corpus's members are numeric rows today; the write-path owner
      // already proves the generic per-type round trip in-process, so this
      // arm ratchets rather than re-implementing it: a non-numeric id
      // joining the corpus fails here until the arm is extended.
      expect(cust.type, `${id}: extend the wire round trip when a non-numeric id joins the corpus`).toBe(
        "number",
      );
      const original = currentValues.get(id) as number;
      const min = cust.min ?? original - 1;
      const max = cust.max ?? original + 1;
      const alternative = original === max ? min : max;
      // Save through the door with the SERVED id — the client's whole
      // reality: it can only post back what the wire handed it.
      const saved = await req(`/api/schema/ui/customizations/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: { value: alternative },
      });
      expect(saved.status, `${id}: the save with the served id must be accepted`).toBe(200);
      const after = await req("/api/schema/ui/values");
      const row = ((after.body as { customizations: { id: string; value: unknown }[] }).customizations)
        .find((c) => c.id === id);
      expect(row?.value, `${id}: the saved value must read back through the wire`).toBe(alternative);
      // Restore, and prove the restore landed.
      const restored = await req(`/api/schema/ui/customizations/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: { value: original },
      });
      expect(restored.status).toBe(200);
      const end = await req("/api/schema/ui/values");
      const endRow = ((end.body as { customizations: { id: string; value: unknown }[] }).customizations)
        .find((c) => c.id === id);
      expect(endRow?.value, `${id}: must restore to its original value`).toBe(original);
    }
  });

  test("a credential-shaped settings VALUE is still masked on the values wire (the exemption opens no hole)", async () => {
    // The authorship exemption passes only leaves that byte-equal a
    // registry-minted id, so a value a user types can never inherit it.
    // Plant a credential-shaped value through the write door, read it back
    // through the values wire, and prove the VALUE arrives masked while
    // its id arrives verbatim.
    const planted = "sk-AAAAAAAAAAAAAAAAAAAAAAAA";
    const target = listCustomizations().find((c) => c.type === "string");
    expect(target, "no string customization to plant the value in").toBeDefined();
    const original = target!.current();
    const saved = await req(`/api/schema/ui/customizations/${encodeURIComponent(target!.id)}`, {
      method: "PUT",
      body: { value: planted },
    });
    expect(saved.status).toBe(200);
    try {
      const { body } = await req("/api/schema/ui/values");
      const row = ((body as { customizations: { id: string; value: unknown }[] }).customizations)
        .find((c) => c.id === target!.id);
      expect(row?.id, "the row's id is the registry's own token — verbatim").toBe(target!.id);
      expect(String(row?.value), "the planted secret must NEVER reach the values wire verbatim").not.toBe(
        planted,
      );
      expect(String(row?.value)).toContain("[REDACTED:");
    } finally {
      const restored = await req(`/api/schema/ui/customizations/${encodeURIComponent(target!.id)}`, {
        method: "PUT",
        body: { value: original },
      });
      expect(restored.status).toBe(200);
    }
  });
});

describe("PUT /api/schema/ui/customizations/:id", () => {
  test("sets a known customization value", async () => {
    const { status, body } = await req("/api/schema/ui/customizations/search.threshold", {
      method: "PUT",
      body: { value: 0.66 },
    });
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);

    // Verify the value changed.
    const { body: valuesBody } = await req("/api/schema/ui/values");
    const values = valuesBody as { customizations: { id: string; value: number }[] };
    const th = values.customizations.find((c) => c.id === "search.threshold");
    expect(th?.value).toBe(0.66);
  });

  test("unknown customization returns 404", async () => {
    const { status, body } = await req("/api/schema/ui/customizations/nonexistent.cust", {
      method: "PUT",
      body: { value: 1 },
    });
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe("unknown_customization");
  });

  test("missing value field returns 400", async () => {
    const { status, body } = await req("/api/schema/ui/customizations/search.threshold", {
      method: "PUT",
      body: {},
    });
    expect(status).toBe(400);
    // the body is now validated with a zod schema
    // (assertValidBody) — a missing `value` field produces the
    // `invalid_customization_body` code (previously the manual
    // `missing_value` check; zod validation is more robust as it
    // also validates the value's type, not just its presence).
    expect((body as { error: string }).error).toBe("invalid_customization_body");
  });
});

describe("POST /api/schema/ui/actions/:id", () => {
  test("executes a known action", async () => {
    const { status, body } = await req("/api/schema/ui/actions/search.clearCache", {
      method: "POST",
      body: {},
    });
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
  });

  test("unknown action returns 404 with typed error (NotFound — the action resource does not exist)", async () => {
    const { status, body } = await req("/api/schema/ui/actions/nonexistent.action", {
      method: "POST",
      body: {},
    });
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe("unknown_action");
  });
});
