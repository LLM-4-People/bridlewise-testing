// @vitest-environment node
/**
 * THE NEXT TURN'S CHANNELS, MEASURED THROUGH THE REAL DOOR (UIE-054's
 * behavioral half).
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 *
 * The context desk's read claimed "channel strips of the NEXT turn's
 * model input", but the request carries a channel no strip counted: the
 * OpenAI `tools` array — the JSON schema of every enabled tool, sent
 * beside the messages on EVERY call. Measured on the live install
 * (drive 8, chat d7c0a29f): the desk's four channels summed to 5,314
 * tokens against the same call's ledger prompt of 12,122 — the schemas
 * alone are ~6.8k, a per-call constant, so the "next turn" total
 * understated the real per-call cost by more than every message channel
 * combined, and the fill percentage with it (16% shown, 38% real).
 *
 * ── WHY THIS FILE, AND NOT AN EDIT OF AN EXISTING OWNER ────────────────────
 *
 * The assembly's ONE-ASSEMBLY/two-projections property is owned
 * structurally by tests/unit/cockpit-spine-blocks.test.ts §F, and the
 * context SSE event's total by tests/unit/context-trimming-e2e.test.ts.
 * No existing guard owns the channel CENSUS of the served read — the
 * defect was filed as new because the census was the hole. This file is
 * that census's behavioral owner: it drives `run.compose` and
 * `run.composeItem` through the real block routes over a real DB, and
 * asserts the served channels are the channels the request actually
 * carries, with the vocabulary derived from the wire owner
 * (COMPOSE_CHANNEL_IDS) — never a hand list.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";

// The project root BEFORE config resolves, so any ledger machinery that
// touches disk lands in its own temp world.
await vi.hoisted(async () => {
  const { createTempDir } = await import("../helpers/temp-dir.ts");
  process.env.HARNESS_WEB_PROJECT_ROOT = createTempDir("ch-compose-channels-root-");
});

import { defineComposeBlocks } from "../../server/blocks/compose.ts";
import { clearBlocks, mountBlockRoutes } from "../../server/blocks/define.ts";
import { COMPOSE_CHANNEL_IDS } from "../../shared/wire-types.ts";
import { getEnabledToolManifestForSession, manifestEntriesToToolDefinitions } from "../../server/tools/tools-bridge.ts";
import { estimateToolSchemasTokens } from "../../server/context/context-bridge.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { createTestUser, type TestUser } from "../helpers/multi-user.ts";

let srv: HttpTestServer;
let user: TestUser;
let chatId: string;

type WireChannel = { id: string; tokens: number; items: { id: string; label: string; tokens: number }[] };
type WireRead = { channels: WireChannel[]; limit: number };
type WireDetail = {
  channel: string;
  itemId: string;
  label: string;
  tokens: number;
  origin: string;
  parts: { role: string; field: string; text: string }[];
  withheldChars: number;
  absence?: string;
};

/** One real block read, through the mounted route. */
async function readCompose(): Promise<WireRead> {
  const res = await jsonRequest(srv.baseUrl, `/api/b/run.compose?chatId=${encodeURIComponent(chatId)}`, {
    cookie: user.cookie,
  });
  expect(res.status, "the strips read must answer").toBe(200);
  const body = res.body as { data?: unknown; refusal?: { code?: string } };
  expect(body.refusal, "a fresh chat's composition is measurable — a refusal here is a defect").toBeUndefined();
  return body.data as WireRead;
}

/** One real item-body read, through the mounted route. */
async function readItemDetail(channel: string, itemId: string): Promise<WireDetail> {
  const res = await jsonRequest(
    srv.baseUrl,
    `/api/b/run.composeItem?chatId=${encodeURIComponent(chatId)}&channel=${encodeURIComponent(channel)}&itemId=${encodeURIComponent(itemId)}`,
    { cookie: user.cookie },
  );
  expect(res.status, "the item read must answer").toBe(200);
  const body = res.body as { data?: unknown };
  return body.data as WireDetail;
}

beforeAll(async () => {
  srv = await startHttpTestServer({
    prefix: "ch-compose-channels-",
    register: (router, _db, adb) => {
      clearBlocks();
      defineComposeBlocks(adb);
      mountBlockRoutes(router);
    },
  });
  user = createTestUser(srv.db, "compose-channels-tester");
  const project = srv.db.createProject(
    { name: "channels-proof", path: process.env.HARNESS_WEB_PROJECT_ROOT! },
    user.userId,
  );
  const chat = srv.db.createChat({ title: "channels proof", project_id: project.id }, user.userId);
  chatId = chat.id;
  srv.db.createMessage({ chat_id: chatId, role: "user", content: "what is in this project?", run_id: "seed" }, user.userId);
  srv.db.createMessage({ chat_id: chatId, role: "assistant", content: "let me look.", run_id: "seed" }, user.userId);
});

afterAll(async () => {
  if (srv) await srv.stop();
});

describe("run.compose — the channels the next request actually carries", () => {
  test("the served census IS the wire vocabulary, deny-by-default", async () => {
    const read = await readCompose();
    const served = read.channels.map((c) => c.id);
    // DERIVED FROM THE WIRE OWNER, never a hand list: every channel the
    // vocabulary names must be served, and nothing unnamed may appear.
    for (const id of COMPOSE_CHANNEL_IDS) {
      expect(served, `the next turn's composition must serve the "${id}" channel`).toContain(id);
    }
    expect(served).toHaveLength(COMPOSE_CHANNEL_IDS.length);
  });

  test("the tool-schemas channel is a measured, positive per-call cost", async () => {
    const read = await readCompose();
    const schemas = read.channels.find((c) => c.id === "toolSchemas");
    expect(schemas, "the schemas channel must be served").toBeDefined();
    // LIVENESS: this install offers real tools, so the request really
    // carries schemas — the channel's cost is positive, not an empty
    // gesture.
    expect(schemas!.tokens).toBeGreaterThan(0);
    // AND THE CHANNEL IS NOT DECORATIVE: on this fresh chat the schemas
    // cost is comparable to or larger than the whole message set — the
    // measured shape that made the old messages-only total a lie.
    const messageChannels = read.channels
      .filter((c) => c.id !== "toolSchemas")
      .reduce((sum, c) => sum + c.tokens, 0);
    expect(messageChannels).toBeGreaterThan(0);
    expect(schemas!.tokens).toBeGreaterThan(messageChannels / 4);
  });

  test("the schemas channel's cost is the wire mapping's own measure — the same definitions the run sends", async () => {
    // The strip's number and the executor's request derive from ONE
    // mapping (manifestEntriesToToolDefinitions — the sole owner of the
    // manifest→wire shape) and ONE estimator. This asserts the read uses
    // that owner rather than a restated shape: a preview that invented
    // its own definition shape would measure a different number. (Runs
    // BEFORE the toggle arm: with no override rows yet, the user's
    // snapshot and the empty-session manifest are the same set.)
    const read = await readCompose();
    const schemas = read.channels.find((c) => c.id === "toolSchemas")!;
    const expected = estimateToolSchemasTokens(manifestEntriesToToolDefinitions(getEnabledToolManifestForSession(new Map())));
    expect(schemas.tokens).toBe(expected);
  });

  test("the schemas channel tracks the LIVE enabled set — switching a tool off shrinks it", async () => {
    // The manifest's first built-in tool, discovered — never named by
    // hand. Disabling it must shrink the schema cost: the channel
    // measures what the next request will carry, and a tool switched off
    // is a schema the request will no longer include.
    const manifest = getEnabledToolManifestForSession(new Map());
    expect(manifest.length).toBeGreaterThan(1);
    const victim = manifest.find((t) => t.category !== "mcp") ?? manifest[0]!;

    const before = await readCompose();
    const beforeSchemas = before.channels.find((c) => c.id === "toolSchemas")!;
    const beforeDetail = await readItemDetail("toolSchemas", beforeSchemas.items[0]!.id);
    expect(beforeDetail.parts[0]!.field).toBe("schema");
    const beforeDefs = JSON.parse(beforeDetail.parts[0]!.text) as { function?: { name?: string } }[];
    expect(beforeDefs.some((d) => d.function?.name === victim.name),
      "the served schema body must name the tool this arm switches off").toBe(true);

    srv.db.upsertToolSetting({ tool_name: victim.name, enabled: false }, user.userId);

    const after = await readCompose();
    const afterSchemas = after.channels.find((c) => c.id === "toolSchemas")!;
    expect(afterSchemas.tokens).toBeLessThan(beforeSchemas.tokens);
    // …and the measured drop is exactly the disabled tool's own schema —
    // the arithmetic the strip exists to state, verified against the
    // served bodies rather than restated from the implementation.
    const afterDetail = await readItemDetail("toolSchemas", afterSchemas.items[0]!.id);
    const afterDefs = JSON.parse(afterDetail.parts[0]!.text) as { function?: { name?: string } }[];
    expect(afterDefs.some((d) => d.function?.name === victim.name),
      "a tool switched off must leave the served schema body").toBe(false);
    expect(afterDefs.length).toBe(beforeDefs.length - 1);
  });
});

describe("run.compose — the limit denominates the CHAT'S OWN model", () => {
  // The strip's `limit` is the denominator the fill percentage divides by,
  // and the run it mirrors trims against the ACTIVE model's declared
  // context window. A preview that kept the harness-wide limit while the
  // run honoured the model's own would understate the fill on every
  // windowed model — the same measured-dishonesty class the channel
  // census closed.

  test("a model that declares a context window denominates the strip", async () => {
    const before = await readCompose();
    // The chat names no model, so the stored default answers — the same
    // resolution the run start performs. Give THAT model a window.
    srv.db.upsertUserModelPrefs(user.userId, {
      providers: [{
        id: "windowed-provider",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        models: [{ id: "gemma-4-31b", contextWindow: 12_000 }],
      }],
      defaultProvider: "windowed-provider",
      defaultModel: "gemma-4-31b",
    });
    const after = await readCompose();
    expect(after.limit, "the strip denominates the model's own window").toBe(12_000);
    // Restore the seeded shape so later arms in this file see what they
    // seeded (the shared beforeAll user is this describe's subject).
    srv.db.upsertUserModelPrefs(user.userId, {
      providers: [{
        id: "test-provider",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test-key-not-a-real-credential",
        models: [{ id: "gemma-4-31b" }, { id: "qwen3.6-35b-fast" }],
      }],
      defaultProvider: "test-provider",
      defaultModel: "gemma-4-31b",
    });
    const restored = await readCompose();
    expect(restored.limit, "a bare model falls back to the harness-wide limit").toBe(before.limit);
  });
});
