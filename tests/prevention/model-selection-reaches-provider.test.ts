// @vitest-environment node
/**
 * THE MODEL YOU PICK IS THE MODEL THAT ANSWERS — across the whole seam.
 *
 * The user, verbatim: *"the dropdown menu to pick a model does not work,
 * meaning I can pick something else but it does not use it"*.
 *
 * WHAT WAS BROKEN, exactly. The desk's picker
 * (`src/cockpit/desk/DeskPanel.svelte`) calls `client.ts::setChatModel`,
 * which PATCHes `/api/chats/:id { modelId }` — the write landed, persisted,
 * survived a reload and painted back. The run route then read the model from
 * ONE place: the request body. The cockpit's send path
 * (`flow/run-stream.ts::beginCockpitRun` → `client.ts::startRun`) puts no
 * `modelId` in that body, so `input.modelId` was always undefined and
 * `streamChat` fell through to the server's configured default. Captured live
 * against the running dev server: chat record `kimi-k2.6`, request body
 * `{projectId, prompt, chatId}`, turn served by `gemma-4-31b`.
 *
 * WHY THIS TEST IS SHAPED THE WAY IT IS. A unit test of any single function
 * on that path passes while the wiring stays broken — which is precisely how
 * the defect survived: `setChatModel` was correct, `chats.model_id` was
 * correct, `streamChat` was correct, and the run still used the wrong model
 * because no one joined them. So this guard runs the REAL chain and asserts
 * only at its two ends:
 *
 *   the write the picker performs  (`client.ts::setChatModel`, driven here
 *                                   through a `fetch` pointed at a real HTTP
 *                                   server — the same function, the same
 *                                   request, the same route)
 *        ↓  PATCH /api/chats/:id
 *   the chat record                (real SQLite, real chats route)
 *        ↓  POST /api/run/start — the EXACT cockpit body, with no modelId
 *   the run route                  (real `resolveRunModelId`)
 *        ↓
 *   the LLM bridge                 (real `streamChat`, real `getClient`,
 *                                   real `options.modelId ?? default`)
 *        ↓  client.stream(messages, { model })
 *   THE PROVIDER CALL              ← the only thing stubbed, and only so the
 *                                    model it is handed can be recorded
 *
 * Nothing between the picker's write and the provider's `model` argument is
 * mocked. The only stub is the provider itself, which is the thing being
 * measured.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

// ── The provider seam ───────────────────────────────────────────────────────
// `vi.hoisted` so the recorder exists before the mock factory runs.
const provider = vi.hoisted(() => ({
  /** Every `model` handed to a provider stream call, in order. */
  models: [] as string[],
  /**
   * Every config the client was CONSTRUCTED with, in order. The headers a
   * run carries live on the construction config, not the stream call — the
   * engine merges them into the request at send time — so this is where a
   * "the header never reached the engine" defect is visible.
   */
  configs: [] as Readonly<Record<string, unknown>>[],
  clients: [] as import("../../engine/src/shared/llm/client.ts").SharedLLMClient[],
  wires: [] as {url:string;body:Record<string,unknown>;headers:Record<string,string>}[],
}));

vi.mock("../../engine/src/shared/llm/client.ts", async () => {
  const actual=await vi.importActual<typeof import("../../engine/src/shared/llm/client.ts")>("../../engine/src/shared/llm/client.ts");
  const {responseSseResponse,responseJsonResponse}=await import("../../engine/test/support/mock-provider.ts");
  const {address,serve}=await import("../../engine/test/support/loopback-upstream.ts");
  class SharedLLMClient extends actual.SharedLLMClient {
    constructor(config: import("../../engine/src/shared/llm/client.ts").SharedLLMClientOptions) {
      // A real loopback upstream answers (the door owns its transport); it sees the original url.
      super({...config,baseUrl:address(config.baseUrl),allowPrivateAddress:true});
      serve(async(url,init)=>{
        const body=JSON.parse(String(init.body)) as Record<string,unknown>;
        provider.wires.push({url:String(url),body,headers:Object.fromEntries(init.headers)});
        provider.models.push(String(body.model));
        return body.stream===true ? responseSseResponse({id:`native-model-${provider.wires.length}`,content:"ok"}) : responseJsonResponse({id:"cache-owned",status:"queued",usage:null});
      });
      provider.configs.push(config);provider.clients.push(this);
    }
  }
  return {...actual, SharedLLMClient};
});

// ── The provider comes from the DATABASE, so there is no env to set ─────────
// This block used to write an LLM config FILE and set a server-wide default
// model, because that is where the run got its provider and its fallback
// model. Both sources are deleted: the run resolves a provider from the
// caller's saved record, and refuses when there is none. The distinguishable
// "nobody picked this" name is now a model the user SAVED as their default,
// which is the only thing that can answer when a conversation chose nothing.
import { createTempDir } from "../helpers/temp-dir.ts";

// The fixture path returns canned events BEFORE any provider call, which
// would make the measurement point unreachable. Off, explicitly.
delete process.env.HARNESS_WEB_LLM_FIXTURES;

import { createRouter } from "../../server/router/router.ts";
import { isPublicPath } from "../../server/routes/registry.ts";
import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { registerChatRoutes } from "../../server/routes/chats.ts";
import { registerProjectRoutes } from "../../server/routes/projects.ts";
import { registerRunRoutes } from "../../server/routes/run.ts";
// The models write route — the header save and the default change both enter
// through it, which is the whole claim: the shape the UI posts is the shape
// the store holds. Without it mounted, those drives 404.
import { registerModelRoutes } from "../../server/routes/models.ts";
// The subscriber is its own module since the executor was split out of the
// GET handler. Driving a run to the provider needs both halves mounted.
import { registerRunStreamRoutes } from "../../server/routes/run-stream.ts";
import { createTestUser, seedProvider } from "../helpers/multi-user.ts";
import { setChatModel } from "../../src/client.ts";
import { PROVIDER_FIXTURE_OWNER } from "../helpers/multi-user.ts";

/**
 * The model the user SAVED as their default — what answers a conversation
 * that chose nothing. Deliberately a name no test ever picks, so "the run
 * fell through to the saved default" cannot be mistaken for "the run honoured
 * a selection".
 */
const SAVED_DEFAULT_MODEL = "saved-default-nobody-picked";
/** The model the user picks in the dropdown. Nothing else in the tree names it. */
const PICKED_MODEL = "picked-in-the-dropdown";
/** A per-request override, to prove precedence rather than assume it. */
const REQUESTED_MODEL = "named-in-the-request";

let tmpRoot = "";
let server: Server;
let baseUrl = "";
let db: DbClient;
let authCookie = "";

const SESSION_COOKIE = "harness_session=test-model-seam-session";

async function postJson(
  path: string,
  body: unknown,
  method: "POST" | "PUT" = "POST",
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: `${authCookie}; ${SESSION_COOKIE}`,
      "X-Requested-With": "test",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

/**
 * Drive the run to completion by opening its SSE stream (the run does not
 * call the provider until a stream is attached) and reading until the stream
 * closes or the timeout fires. The provider stub finishes immediately, so
 * this returns as soon as the one turn is done.
 */
async function drainRunStream(runId: string, timeoutMs = 10000): Promise<void> {
  const res = await fetch(`${baseUrl}/api/run/${runId}/stream`, {
    headers: { Cookie: `${authCookie}; ${SESSION_COOKIE}` },
  });
  if (!res.ok || res.body === null) throw new Error(`stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const timer = setTimeout(() => { void reader.cancel().catch(() => undefined); }, timeoutMs);
  try {
    let buffer = "";
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // The run route ends the stream after `done`; cancel as soon as it
      // says so rather than waiting for the socket to drop.
      if (buffer.includes("event: done")) {
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Seed a project + a conversation, and return their ids. */
async function newConversation(name: string): Promise<{ projectId: string; chatId: string }> {
  const p = await postJson("/api/projects", { name, path: `/${name}` });
  const projectId = (p.body as { id: string }).id;
  const c = await postJson("/api/chats", { projectId, title: name });
  const chatId = (c.body as { id: string }).id;
  return { projectId, chatId };
}

/**
 * Run one turn the way the cockpit does — `{projectId, prompt, chatId}` and
 * NOTHING else — and return the model the provider was handed.
 *
 * The body is spelled out rather than built from a helper on purpose: it is
 * the exact shape captured off the wire from the running app, and the whole
 * defect lived in what this object does NOT contain.
 */
async function modelReachingProvider(
  ids: { projectId: string; chatId: string },
  extra: Readonly<{ modelId?: string }> = {},
): Promise<string> {
  provider.models.length = 0;
  const start = await postJson("/api/run/start", {
    projectId: ids.projectId,
    prompt: "say something",
    chatId: ids.chatId,
    ...extra,
  });
  expect(start.status).toBe(201);
  await drainRunStream((start.body as { runId: string }).runId);
  expect(provider.models.length).toBeGreaterThan(0);
  return provider.models[0]!;
}

beforeAll(async () => {
  tmpRoot = createTempDir("ch-model-seam-");
  db = new DbClient({ path: join(tmpRoot, "model-seam.db") });
  const user = createTestUser(db, "model-seam-tester");
  authCookie = user.cookie;
  // The subject is a CONFIGURED account: one saved provider serving exactly
  // the three models this file names, with the "nobody picked it" one as the
  // saved default. Written through `seedProvider`, which writes the same
  // encrypted row the settings route writes — nothing else in the server can
  // supply a provider, so a stub would not work even if one were wanted.
  seedProvider(db, user.userId, { models: [SAVED_DEFAULT_MODEL, PICKED_MODEL, REQUESTED_MODEL] });

  const adb = AsyncDbClient.inline(db);
  const router = createRouter({ db: adb, isPublicPath });
  registerProjectRoutes(router, adb);
  registerChatRoutes(router, adb);
  registerModelRoutes(router, adb);
  registerRunRoutes(router, adb);
  registerRunStreamRoutes(router, adb);

  server = createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // THE CLIENT HALF OF THE SEAM. `client.ts` calls `fetch("/api/…")` with a
  // relative path; in node that has no origin. Stubbing the global here lets
  // the REAL `setChatModel` — the function the dropdown's change handler
  // calls — perform its real request against the real route. Rewriting the
  // path is the only thing this wrapper does; method, headers and body are
  // the client's own.
  //
  // ONLY relative paths are touched. This file's own `fetch` calls use
  // absolute URLs and pass through untouched — including the one that must
  // travel as a DIFFERENT user, which an unconditional cookie injection here
  // would have quietly rewritten into the owner's request (it did, and the
  // scoping test went green on the wrong evidence until this was narrowed).
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input !== "string" || !input.startsWith("/")) {
      return realFetch(input as RequestInfo, init);
    }
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    headers["Cookie"] = `${authCookie}; ${SESSION_COOKIE}`;
    return realFetch(`${baseUrl}${input}` as RequestInfo, { ...init, headers });
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (server !== undefined) await new Promise<void>((r) => server.close(() => r()));
  if (db !== undefined) db.close();
});

describe("the picked model reaches the provider — client write to provider call", () => {
  test("a model chosen in the UI is the model the provider is asked for, with no modelId in the run request", async () => {
    const ids = await newConversation("picked-model-proj");

    // THE GESTURE, through the function the dropdown actually calls.
    await setChatModel(ids.chatId, PICKED_MODEL);

    // THE RUN, in the cockpit's exact shape: no modelId on the wire.
    const served = await modelReachingProvider(ids);

    expect(served).toBe(PICKED_MODEL);
    // Spelled out separately so a regression reads as the user's own
    // sentence rather than as a diff between two opaque strings.
    expect(served).not.toBe(SAVED_DEFAULT_MODEL);
  }, 20000);

  test("the selection survives as the run's model on every later turn, not just the first", async () => {
    const ids = await newConversation("picked-model-persists");
    await setChatModel(ids.chatId, PICKED_MODEL);

    const first = await modelReachingProvider(ids);
    const second = await modelReachingProvider(ids);

    expect(first).toBe(PICKED_MODEL);
    expect(second).toBe(PICKED_MODEL);
  }, 20000);

  test("changing the selection changes the model the next run is served by", async () => {
    const ids = await newConversation("picked-model-changes");

    await setChatModel(ids.chatId, PICKED_MODEL);
    expect(await modelReachingProvider(ids)).toBe(PICKED_MODEL);

    // The user changes their mind — the whole point of the control.
    await setChatModel(ids.chatId, REQUESTED_MODEL);
    expect(await modelReachingProvider(ids)).toBe(REQUESTED_MODEL);
  }, 20000);

  test("a conversation that never chose is served by the user's SAVED default", async () => {
    const ids = await newConversation("never-picked-proj");

    // No selection was made. The user's saved default is the truthful answer
    // — and it is the SAME value `/api/models` reports as `defaultModel`,
    // which is what the desk's picker displays in this case. It is emphatically
    // NOT a server-wide default: that source is deleted, so a conversation
    // cannot be served by a model the account never chose.
    expect(await modelReachingProvider(ids)).toBe(SAVED_DEFAULT_MODEL);
  }, 20000);

  test("WITH NO PROVIDER SAVED, the run REFUSES and names the remedy — nothing reaches a provider", async () => {
    // The other half of the same seam, and the one the product was missing:
    // an account that has configured nothing used to be silently served by a
    // file on the server. Now it is told what to do.
    const outsider = createTestUser(db, "model-seam-unconfigured");
    db.upsertUserModelPrefs(outsider.userId, { providers: [] });
    // Created AS the outsider: `postJson` carries the owner's cookie, and a
    // project the outsider does not own is refused (403) before the provider
    // check is ever reached — which would have made this test pass on the
    // wrong evidence.
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${outsider.cookie}; ${SESSION_COOKIE}`,
        "X-Requested-With": "test",
      },
      body: JSON.stringify({ name: "unconfigured", path: "/unconfigured" }),
    });
    const projectId = ((await projectRes.json()) as { id: string }).id;

    provider.models.length = 0;
    const res = await fetch(`${baseUrl}/api/run/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${outsider.cookie}; ${SESSION_COOKIE}`,
        "X-Requested-With": "test",
      },
      body: JSON.stringify({ projectId, prompt: "say something" }),
    });
    // The refusal is DESIGNED (the guided 428 family), so it travels as data
    // in the 200 envelope — the run-start door joined the block envelope
    // contract (the browser logs a raw non-2xx status as a console error
    // before any page code runs). 428, not 503, and in the ENVELOPE, not on
    // the status line: retrying cannot make a provider appear either way.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      refusal?: { code: string; message: string; status: number };
    };
    expect(body.refusal).toMatchObject({ code: "provider_not_configured", status: 428 });
    expect(body.refusal!.message).toContain("Settings");
    // AND NOTHING WAS ATTEMPTED. A refusal that still called the provider
    // would be a refusal in name only — this is the assertion that separates
    // "refused" from "failed after trying".
    expect(provider.models).toEqual([]);
  }, 20000);

  test("an explicit modelId in the request wins over the conversation's recorded model", async () => {
    const ids = await newConversation("explicit-override-proj");
    await setChatModel(ids.chatId, PICKED_MODEL);

    // A caller that NAMES a model means it (the one-off override). Stated as
    // a test so the precedence is a decision on the record, not an accident
    // of which `??` came first.
    expect(await modelReachingProvider(ids, { modelId: REQUESTED_MODEL })).toBe(REQUESTED_MODEL);
  }, 20000);

  test("another user's conversation cannot lend its model to a run", async () => {
    const ids = await newConversation("scoping-proj");
    await setChatModel(ids.chatId, PICKED_MODEL);

    // The resolution reads the chat through the user-scoped accessor. A
    // foreign chat resolves to null (and the run is refused before that
    // anyway) — never to the other user's model.
    const other = createTestUser(db, "model-seam-outsider");
    const res = await fetch(`${baseUrl}/api/run/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${other.cookie}; ${SESSION_COOKIE}`,
        "X-Requested-With": "test",
      },
      body: JSON.stringify({ projectId: ids.projectId, prompt: "hi", chatId: ids.chatId }),
    });
    expect(res.status).toBe(403);
  }, 20000);

  test("a custom header the user saved reaches the engine's client construction", async () => {
    // THE CLASS: a stored provider field that never reaches the engine. The
    // store schema used to have no `headers`, so a saved header had nowhere
    // to live; this drives the REAL chain — PUT through the route, the run
    // path's credential, the bridge's client construction — and asserts on
    // the config the engine's client was built from. The only stub is the
    // provider itself (the SharedLLMClient), and only so what it was handed
    // can be read back.
    //
    // The header is saved through the WRITE ROUTE, not seeded directly, so
    // the assertion covers the store's own parse → store → read-back seam,
    // not only the bridge's half of it.
    const header = { "X-Org-Id": "org-on-the-wire", "X-Route": "blue" };
    const save = await postJson("/api/models/prefs", {
      providers: [{
        id: "wired-headers",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "fixture-header-authentication",
        models: [{ id: "wired-header-model" }],
        headers: header,
      }],
      defaultModel: "wired-header-model",
    }, "PUT");
    expect(save.status).toBe(200);

    provider.configs.length = 0;
    const ids = await newConversation("headers-on-the-wire");
    await setChatModel(ids.chatId, "wired-header-model");
    await modelReachingProvider(ids);

    // The client was constructed at least once, and the config it was built
    // from carries the saved headers. The engine's own merge (over its base
    // set, at sendRequest) is upstream of this and covered by the engine's
    // own suite; what is proven here is that the bridge HANDS the field over.
    expect(provider.configs.length).toBeGreaterThan(0);
    const wire=provider.wires.at(-1)!; expect(new URL(wire.url).pathname).toBe("/v1/responses");
    expect(wire.headers["x-org-id"]).toBe("org-on-the-wire"); expect(wire.headers["x-route"]).toBe("blue");
    expect(wire.headers.authorization).toBe("Bearer fixture-header-authentication");
    const config = provider.configs[provider.configs.length - 1]!;
    expect(
      config["headers"],
      "the saved headers must reach the engine's client config",
    ).toEqual(header);
  }, 20000);

  test("changing the saved default model changes what the next run is served by", async () => {
    // The DEFAULT half of the seam. The picker control posts only a model id;
    // this proves that write changes what a conversation that never chose is
    // served by — the run reads the STORED default, and the stored default
    // moved. Driven through the same write route the UI calls, so a control
    // that posted a shape the route ignored would red here.
    //
    // The subject's saved default is SAVED_DEFAULT_MODEL; the write moves it
    // to PICKED_MODEL. A fresh conversation (one that never chose) must then
    // be served by the NEW default — not the old one, not the first model.
    const change = await postJson("/api/models/prefs", {
      providers: [],
      defaultModel: PICKED_MODEL,
    }, "PUT");
    expect(change.status).toBe(200);

    const ids = await newConversation("default-moved-proj");
    // No setChatModel: this conversation chose nothing, so the stored default
    // is the only answer the run path has.
    expect(await modelReachingProvider(ids)).toBe(PICKED_MODEL);

    // AND BACK — the change is a choice, not a drift: restoring the original
    // default moves the answer back, so "the write moved it" and "the run
    // reads it" are both pinned rather than one direction looking like the
    // other by accident.
    const restore = await postJson("/api/models/prefs", {
      providers: [],
      defaultModel: SAVED_DEFAULT_MODEL,
    }, "PUT");
    expect(restore.status).toBe(200);
    const ids2 = await newConversation("default-restored-proj");
    expect(await modelReachingProvider(ids2)).toBe(SAVED_DEFAULT_MODEL);
  }, 30000);
});

describe("native client cache qualification",()=>{
  test("settings changes preserve earlier client ownership and policy is captured per invocation",async()=>{
    const {streamChat,resetProviderClients}=await import("../../server/llm/llm-bridge.ts");
    const config=await import("../../server/kernel/harness-config.ts");
    const {parseProviderStore,resolveProviderCredential}=await import("../../server/llm/providers.ts");
    const {createPrivacyPolicy}=await import("../../engine/src/privacy/privacy-policy.ts");
    const make=(maxTokens=123)=>resolveProviderCredential(parseProviderStore({providers:[{id:"cache-fixture",baseUrl:"https://cache.test/v1",apiKey:"cache-private-credential",models:[{id:"cache-model",maxTokens,temperature:0}]}]}),"cache-model", PROVIDER_FIXTURE_OWNER);
    const {resolveResponsesTransportConfig}=await import("../../engine/src/shared/llm/config.ts");
    let limits=resolveResponsesTransportConfig({maximumRequestBytes:65536});
    let policy=createPrivacyPolicy({redactionPrefix:"<FIRST:",redactionSuffix:">"});
    const transport=vi.spyOn(config,"getResponsesTransportSettings").mockImplementation(()=>limits);
    const privacy=vi.spyOn(config,"getPrivacyPolicy").mockImplementation(()=>policy);
    resetProviderClients();provider.clients.length=0;
    const invoke=async(credential=make(),prompt="benign anchor")=>{const events=[];for await(const event of streamChat(prompt,{credential}))events.push(event);return events;};
    try {
      await invoke();const original=provider.clients[0]!;
      await original.create({input:"pending",background:true});assertPending();
      await invoke();expect(provider.clients).toHaveLength(1);
      await invoke(make(234));expect(provider.clients).toHaveLength(2);expect(provider.wires.at(-1)!.body.max_output_tokens).toBe(234);
      limits=resolveResponsesTransportConfig({maximumRequestBytes:50});const before=provider.wires.length;
      expect(await invoke()).toContainEqual(expect.objectContaining({type:"error",error:expect.objectContaining({code:"llm_stream_error",message:"Responses request exceeds its byte bound"})}));expect(provider.wires).toHaveLength(before);expect(provider.clients).toHaveLength(3);
      const previousRequests=original.getStats().totalRequests;
      limits=resolveResponsesTransportConfig({maximumRequestBytes:65536});await invoke();expect(provider.clients).toHaveLength(3);assertPending();expect(provider.wires.at(-1)!.body.max_output_tokens).toBe(123);expect(original.getStats().totalRequests).toBe(previousRequests+1);
      await invoke(make(),"prefix cache-private-credential suffix");expect(JSON.stringify(provider.wires.at(-1)!.body.input)).toContain("prefix <FIRST:secret> suffix");
      policy=createPrivacyPolicy({redactionPrefix:"<SECOND:",redactionSuffix:">"});
      await invoke(make(),"prefix cache-private-credential suffix");expect(provider.clients).toHaveLength(3);expect(JSON.stringify(provider.wires.at(-1)!.body.input)).toContain("prefix <SECOND:secret> suffix");assertPending();expect(original.getStats().totalRequests).toBe(previousRequests+3);
      function assertPending(){expect(original.getResponseTracking().pending).toBe(1);}
    } finally {transport.mockRestore();privacy.mockRestore();resetProviderClients();}
  });
});
