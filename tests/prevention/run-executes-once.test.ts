// @vitest-environment node
/**
 * A RUN EXECUTES EXACTLY ONCE, AND A SUBSCRIBER CANNOT START ONE.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 *
 * `GET /api/run/:runId/stream` WAS the executor. `POST /api/run/start`
 * validated its input, wrote the user's message and returned an id, and then
 * nothing happened until somebody opened the stream — so the number of
 * executions was the number of connections. Driven at the wire with two
 * connections: two POSTs to `/chat/completions` of 38,429 bytes each,
 * byte-identical and therefore billed identically, the same tool call
 * dispatched twice, and two assistant messages under one run id. RFC 9110
 * §9.2.1 defines GET as safe, so every proxy, SDK retry policy, service worker
 * and speculative browser fetch in existence is entitled to repeat one.
 *
 * ── WHAT THIS FILE ASSERTS, AND WHY EACH ASSERTION IS THE ONE IT IS ────────
 *
 * The verdict is PROJECTION ROW COUNTS — `assistant` message rows and
 * `tool_calls` rows for the run. Those are evidence only the executor can
 * produce.
 *
 *   - NOT frame counts. A subscriber legitimately receives every frame, so two
 *     subscribers legitimately see everything twice. Driven here: both
 *     connections receive the identical id sequence. A frame-count assertion
 *     would fail on correct behaviour and pass on the INERT mutation.
 *   - NOT ordering. The old path reproduces ordering by accident often enough
 *     that agreeing with it proves nothing.
 *
 * Liveness comes first in every cost assertion: a guard that passes at "zero
 * executions" is measuring a refusal, not a fix.
 *
 * The structural half walks the import graph. A source scan for "does a GET
 * handler call streamChat" has a universe, and universes are what this project
 * keeps getting wrong; an import cone does not have one.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { createTempDir } from "../helpers/temp-dir.ts";
import { readRunPathModule, runPathModules } from "../helpers/run-source.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
import { PROVIDER_FIXTURE_OWNER } from "../helpers/multi-user.ts";
import { responseEvents } from "../../engine/test/support/mock-provider.ts";
import type { RunFrame } from "../../server/run/run-feed.ts";
const REPO_ROOT = resolve(import.meta.dirname, "../..");

// ── The instrumented provider: the spend is counted AT THE WIRE ────────────
//
// Not inferred from the code, and not a mock of the bridge — a real HTTP
// server the real client connects to, counting requests and their bytes. The
// acceptance instrument has to be independent of the implementation it
// certifies, and a mock of the bridge would be the implementation certifying
// itself.
let providerRequests: { path: string; bytes: number; body: string }[] = [];

// AT MODULE SCOPE, NOT IN A HOOK. `serverConfig` is resolved from the
// environment once and re-resolved by the shared setup's `beforeAll`, which
// runs AFTER this module is initialized. Setting the path inside `beforeAll`
// is too late: measured, the run then used the machine's real provider config,
// never reached this server, and the spend assertion would have been made
// against a provider that was never called — a guard passing while measuring
// nothing.
/** Mark the live request the disconnect and turn-lifetime probes hold. */
const SLOW_MARKER = "stream-slowly-so-a-disconnect-has-somewhere-to-land";
const TOOL_TURN_MARKER = "use-the-read-file-tool-first-then-answer";
const TOOL_TURN_FILE = "notes.txt";
/** A non-retryable HTTP 401 during an active call, not a partial stream. */
const ERROR_MARKER = "provider-refuses-active-call-authentication";

type NativeInput = { role?: string; type?: string; content?: unknown; output?: unknown };
type ProviderRequest = { prompt: string; followUp: boolean };
type ProviderHold = {
  prompt: string;
  followUp: boolean;
  arrived: ReturnType<typeof Promise.withResolvers<ProviderRequest>>;
  released: ReturnType<typeof Promise.withResolvers<void>>;
  hits: number;
};
const providerHolds = new Set<ProviderHold>();
const providerProblems: string[] = [];

/** A deadline diagnoses a missing event; it never creates the event. */
async function witnessed<T>(promise: Promise<T>, label: string, timeoutMs = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not arrive within ${String(timeoutMs)}ms`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Install before POST. Hold the real response until the owning assertion releases it. */
function holdProvider(prompt: string, followUp = false) {
  const hold: ProviderHold = {
    prompt, followUp, arrived: Promise.withResolvers<ProviderRequest>(),
    released: Promise.withResolvers<void>(), hits: 0,
  };
  providerHolds.add(hold);
  return {
    ready: () => witnessed(hold.arrived.promise, `provider request for ${prompt}`),
    release: () => hold.released.resolve(),
    dispose: () => { hold.released.resolve(); providerHolds.delete(hold); },
    hits: () => hold.hits,
  };
}

const provider: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const bodyText = body.toString("utf8");
    providerRequests.push({ path: req.url ?? "", bytes: body.length, body: bodyText });
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
      return;
    }
    const answer = async (): Promise<void> => {
      const request = JSON.parse(bodyText) as { stream?: unknown; input?: NativeInput[] };
      if (req.method !== "POST" || req.url !== "/v1/responses" || request.stream !== true || !Array.isArray(request.input)) {
        throw new Error("fixture requires POST /v1/responses with stream:true and native input");
      }
      const lastUser = request.input.findLastIndex((item) => item.role === "user");
      if (lastUser < 0) throw new Error("native input has no current user message");
      const content = request.input[lastUser]!.content;
      const prompt = typeof content === "string" ? content
        : Array.isArray(content) ? content.map((part: { type?: string; text?: string }) => part.type === "input_text" ? part.text ?? "" : "").join("") : "";
      if (prompt.length === 0) throw new Error("current user input is empty or not native text");
      // Only this user's turn and its subsequent tool results select a branch.
      // Earlier messages and recalled memories cannot fail a reopened run.
      const currentResults = request.input.slice(lastUser + 1).filter((item) => item.type === "function_call_output");
      const followUp = currentResults.length > 0;
      const refused = prompt.includes(ERROR_MARKER) || currentResults.some((item) => JSON.stringify(item.output).includes(ERROR_MARKER));
      const hold = [...providerHolds].find((entry) => entry.hits === 0 && entry.prompt === prompt && entry.followUp === followUp);
      const waitForRelease = async (): Promise<void> => {
        if (hold === undefined) return;
        hold.hits += 1;
        hold.arrived.resolve({ prompt, followUp });
        await hold.released.promise;
      };
      if (refused) {
        await waitForRelease();
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "the provider refused this run on purpose", code: "provider_refused" } }));
        return;
      }
      const toolTurn = prompt.includes(TOOL_TURN_MARKER) && !followUp;
      const events = responseEvents(toolTurn
        ? { toolCalls: [{ id: "call-registry-lifetime", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: TOOL_TURN_FILE }) } }] }
        : { chunks: followUp ? ["the", " tool", " turn", " answered"] : ["Hello", " from", " the", " provider"] });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // Publish actual native output before announcing the held boundary.
      // Tool/text completion remains withheld, so no next compose can race the steer.
      const split = events.findIndex((event) => event.type === "response.output_text.delta" || event.type === "response.function_call_arguments.delta") + 1;
      const write = (event: Record<string, unknown>): void => { res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`); };
      for (const event of events.slice(0, split)) write(event);
      await waitForRelease();
      for (const event of events.slice(split)) write(event);
      res.end();
    };
    void answer().catch((error: unknown) => {
      providerProblems.push(error instanceof Error ? error.message : String(error));
      if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "native fixture refused malformed request", code: "fixture_protocol" } }));
    });
  });
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
const PROVIDER_PORT = (provider.address() as { port: number }).port;
// NO LLM CONFIG FILE. The provider the run uses comes from the caller's
// saved database record — see the `seedProvider` call below, which points it
// at the provider server this file just stood up.
// The fixture path returns canned events BEFORE any provider call, which
// would make the measurement point unreachable. Off, explicitly.
delete process.env["HARNESS_WEB_LLM_FIXTURES"];

let app: Server;
let baseUrl = "";
let db: import("../../server/db/client.ts").DbClient;
let authHeaders: Record<string, string>;
let projectId = "";
let chatId = "";
let tmpRoot = "";
let ownerUserId = "";

/**
 * Start a run through a REAL mutating request, with the warrant the real
 * router hands the real handler — and spend it inside that request, which is
 * the only place a warrant is now valid.
 *
 * Not `{} as MutationWarrant`: a cast would prove only that a cast compiles,
 * and the claim here is that the value a mutating verb receives is one the
 * executor accepts while a manufactured one is refused.
 *
 * AND NOT A WARRANT CARRIED OUT OF ITS REQUEST EITHER. An earlier version of
 * this helper returned the warrant to the test, which then called
 * `startRunExecution` from outside any dispatch. That is the STASH — the
 * shape a `router.get` handler used to be able to execute a full run with —
 * and it is now refused, so a helper built on it would be testing a defect
 * rather than the product. The work happens inside the handler, exactly where
 * `POST /api/run/start` does it.
 */
let startUnderWarrant: (runId: string) => Promise<{ status: number; code: string | null }>;

/** A real warrant, carried OUT of its request. Only used to prove it no
 *  longer works — see the stash test. */
let stashWarrant: () => Promise<import("../../server/router/router.ts").MutationWarrant>;

/** Honour one warrant twice inside a single request; the two outcomes, in
 *  order (`null` = accepted, otherwise the refusal's code). */
let spendTwice: () => Promise<(string | null)[]>;

/** Every route the run modules register, discovered from the registration
 *  calls themselves rather than written down here. */
const registeredRoutes: { method: string; path: string }[] = [];

beforeAll(async () => {
  tmpRoot = createTempDir("ch-run-once-");
  // The file the TOOL_TURN_MARKER's call reads — a real path inside the
  // real project root this suite registers, so the tool call executes
  // against something that exists.
  writeFileSync(join(tmpRoot, TOOL_TURN_FILE), "the registry-lifetime probe file\n");

  const { createRouter } = await import("../../server/router/router.ts");
  const { isPublicPath } = await import("../../server/routes/registry.ts");
  const { DbClient } = await import("../../server/db/client.ts");
  const { AsyncDbClient } = await import("../../server/db/async-client.ts");
  const { registerRunRoutes } = await import("../../server/routes/run.ts");
  const { registerRunStreamRoutes } = await import("../../server/routes/run-stream.ts");
  const { registerProjectRoutes } = await import("../../server/routes/projects.ts");
  const { registerChatRoutes } = await import("../../server/routes/chats.ts");
  const { createTestUser, seedProvider } = await import("../helpers/multi-user.ts");

  db = new DbClient({ path: join(tmpRoot, "web.db") });
  const user = createTestUser(db, "run-once-tester");
  // The run path resolves its provider from the caller's saved record and
  // REFUSES when there is none, so a run test's subject must be a configured
  // account. Pointed at this file's own provider server, so the run reaches a
  // real endpoint under this test's control rather than a stub of the client.
  seedProvider(db, user.userId, { baseUrl: `http://127.0.0.1:${String(PROVIDER_PORT)}/v1` });
  const adb = AsyncDbClient.inline(db);
  const router = createRouter({ db: adb, isPublicPath });

  // POPULATION DISCOVERY. The run modules are asked what they register, and
  // the answer is recorded from the registration call — never a literal path
  // written in this file, which would go stale the moment a route moved.
  const recorder = {
    get: (path: string, h: never) => {
      registeredRoutes.push({ method: "GET", path });
      router.get(path, h);
    },
    post: (path: string, h: never) => {
      registeredRoutes.push({ method: "POST", path });
      router.post(path, h);
    },
    put: router.put,
    patch: router.patch,
    delete: router.delete,
    dispatch: router.dispatch,
  } as unknown as import("../../server/router/router.ts").Router;

  registerProjectRoutes(router, adb);
  registerChatRoutes(router, adb);
  registerRunRoutes(recorder, adb);
  registerRunStreamRoutes(recorder, adb);

  app = createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  authHeaders = {
    Cookie: `${user.cookie}; harness_session=run-once`,
    "Content-Type": "application/json",
    "X-Requested-With": "test",
  };
  const project = db.createProject({ name: "run-once", path: tmpRoot }, user.userId);
  const chat = db.createChat({ project_id: project.id, title: "run-once" }, user.userId);
  projectId = project.id;
  chatId = chat.id;
  ownerUserId = user.userId;

  // The executor tap: one POST that does what `POST /api/run/start` does —
  // calls the executor with the warrant its own dispatch handed it. Mounted
  // on THIS router, so it is the same minting path every other mutating route
  // goes through, and the warrant is spent inside the request that minted it.
  const { startRunExecution } = await import("../../server/run/run-executor.ts");
  const tapDb = AsyncDbClient.inline(db);
  router.post("/test-only/start-run/:runId", async (c, warrant) => {
    try {
      await startRunExecution(warrant, c.params["runId"]!, ownerUserId, tapDb);
      c.res.writeHead(200, { "Content-Type": "application/json" });
      c.res.end(JSON.stringify({ started: true }));
    } catch (err) {
      const code = (err as { code?: string }).code ?? null;
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      c.res.writeHead(status, { "Content-Type": "application/json" });
      c.res.end(JSON.stringify({ code }));
    }
  });
  startUnderWarrant = async (runId: string) => {
    const res = await fetch(`${baseUrl}/test-only/start-run/${runId}`, {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    });
    const body = (await res.json()) as { code?: string | null };
    return { status: res.status, code: body.code ?? null };
  };

  // The double-spend tap: honours the SAME warrant twice inside one request
  // and reports both outcomes. The second must be refused — a warrant
  // authorises one operation, not a request's worth of them.
  const { assertMutationWarrant } = await import("../../server/router/router.ts");
  router.post("/test-only/spend-twice", (c, warrant) => {
    const outcomes: (string | null)[] = [];
    for (let i = 0; i < 2; i += 1) {
      try {
        assertMutationWarrant(warrant);
        outcomes.push(null);
      } catch (err) {
        outcomes.push((err as { code?: string }).code ?? "unknown");
      }
    }
    c.res.writeHead(200, { "Content-Type": "application/json" });
    c.res.end(JSON.stringify({ outcomes }));
  });
  spendTwice = async () => {
    const res = await fetch(`${baseUrl}/test-only/spend-twice`, {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    });
    const body = (await res.json()) as { outcomes: (string | null)[] };
    return body.outcomes;
  };

  // The stash tap: hands the warrant back OUT of its request, so a test can
  // try to reuse it. This is the attack, reproduced with the real article.
  const minted: import("../../server/router/router.ts").MutationWarrant[] = [];
  router.post("/test-only/mint-warrant", (c, warrant) => {
    minted.push(warrant);
    c.res.writeHead(200, { "Content-Type": "application/json" });
    c.res.end("{}");
  });
  stashWarrant = async () => {
    const before = minted.length;
    const res = await fetch(`${baseUrl}/test-only/mint-warrant`, {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    });
    if (res.status !== 200) throw new Error(`warrant mint failed: ${String(res.status)}`);
    const warrant = minted[before];
    if (warrant === undefined) throw new Error("the router handed the handler no warrant");
    return warrant;
  };
}, 60_000);

afterEach(() => {
  expect(providerProblems.splice(0), "every provider request uses the actual native protocol").toEqual([]);
  expect(providerHolds.size, "each probe releases and disposes its provider hold").toBe(0);
});

afterAll(async () => {
  if (app) await new Promise<void>((r) => app.close(() => r()));
  if (provider) await new Promise<void>((r) => provider.close(() => r()));
  if (db) db.close();
});

// ── Wire helpers ──

// The frame's `data:` payload too: the arms that judge a steer's delivery
// read the stamp the server published (delivery "drain" | "composed"), which
// lives in the frame's data, not its event name.
type Frame = { id: number | null; event: string; data?: unknown };

async function drainStream(
  path: string,
  extraHeaders: Record<string, string>,
  ms: number,
  origin = baseUrl,
): Promise<{ status: number; frames: Frame[] }> {
  const res = await fetch(`${origin}${path}`, { headers: { ...authHeaders, ...extraHeaders } });
  const frames: Frame[] = [];
  if (res.body === null) return { status: res.status, frames };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + ms;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), remaining),
        ),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value as Uint8Array, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const idMatch = /^id: (\d+)$/m.exec(block);
        const eventMatch = /^event: (\S+)$/m.exec(block);
        if (eventMatch) {
          const dataMatch = /^data: (.*)$/m.exec(block);
          let data: unknown;
          if (dataMatch !== null) {
            // Structured frames ride JSON; a string payload rides raw text.
            // Keep what the server sent either way — a parse failure is a
            // string frame, never a guess.
            try {
              data = JSON.parse(dataMatch[1]!);
            } catch {
              data = dataMatch[1];
            }
          }
          frames.push({ id: idMatch ? Number(idMatch[1]) : null, event: eventMatch[1]!, data });
        }
        split = buffer.indexOf("\n\n");
      }
    }
  } catch {
    // the stream ended under us; whatever was parsed is what arrived
  }
  try {
    await reader.cancel();
  } catch {
    // already gone
  }
  return { status: res.status, frames };
}

async function startRun(prompt: string, target: { chatId: string; projectId: string; headers: Record<string, string>; origin?: string } = { chatId, projectId, headers: authHeaders }): Promise<{ status: number; runId: string }> {
  const res = await fetch(`${target.origin ?? baseUrl}/api/run/start`, {
    method: "POST",
    headers: target.headers,
    body: JSON.stringify({ projectId: target.projectId, prompt, chatId: target.chatId }),
  });
  const body = (await res.json()) as { runId?: string };
  return { status: res.status, runId: body.runId ?? "" };
}

/** Fresh memory scope AND a real first-user/admin owner for the loopback provider. */
async function freshRunSubject(name: string) {
  const { startHttpTestServer } = await import("../helpers/http-server.ts");
  const { registerRunRoutes } = await import("../../server/routes/run.ts");
  const { registerRunStreamRoutes } = await import("../../server/routes/run-stream.ts");
  const { createTestUser, seedProvider } = await import("../helpers/multi-user.ts");
  const server = await startHttpTestServer({
    prefix: "ch-run-once-subject-",
    register(router, _db, adb) {
      registerRunRoutes(router, adb);
      registerRunStreamRoutes(router, adb);
    },
  });
  try {
    const user = createTestUser(server.db, name);
    expect(server.db.getUserById(user.userId)?.is_admin, "the real owner may reach the loopback fixture").toBe(1);
    seedProvider(server.db, user.userId, { baseUrl: `http://127.0.0.1:${String(PROVIDER_PORT)}/v1` });
    return { ...server, user };
  } catch (error) {
    await server.stop();
    throw error;
  }
}

/** The projection rows for a run — the evidence only the executor produces. */
function projectionFor(runId: string): { assistantRows: number; userRows: number; toolCallRows: number; claims: number } {
  const raw = db as unknown as { db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } } };
  const one = (sql: string, ...args: unknown[]): number =>
    Number((raw.db.prepare(sql).get(...args) as { n: number }).n);
  return {
    assistantRows: one("SELECT COUNT(*) n FROM messages WHERE run_id = ? AND role = 'assistant'", runId),
    userRows: one("SELECT COUNT(*) n FROM messages WHERE run_id = ? AND role = 'user'", runId),
    toolCallRows: one(
      "SELECT COUNT(*) n FROM tool_calls tc JOIN messages m ON tc.message_id = m.id WHERE m.run_id = ?",
      runId,
    ),
    claims: one("SELECT COUNT(*) n FROM run_executions WHERE run_id = ?", runId),
  };
}

/** Observe the actual terminal feed, including a run that ended before attachment. */
async function runToCompletion(runId: string, timeoutMs = 8_000): Promise<readonly RunFrame[]> {
  const { subscribeToRunFeed } = await import("../../server/run/run-feed.ts");
  const ended = Promise.withResolvers<void>();
  const frames: RunFrame[] = [];
  const subscription = subscribeToRunFeed(runId, 0, (frame) => frames.push(frame), () => ended.resolve());
  if (subscription === undefined) throw new Error(`run ${runId} has no feed to observe`);
  frames.push(...subscription.replay.frames);
  if (subscription.replay.ended) ended.resolve();
  try {
    await witnessed(ended.promise, `terminal feed for ${runId}`, timeoutMs);
    return frames;
  } finally {
    subscription.unsubscribe();
  }
}

// ── Test 1 — behavioural, driven over the real wire ────────────────────────

describe("a run executes exactly once", () => {
  test("the population under test is discovered and non-empty", () => {
    // A discovery that comes back empty FAILS rather than passing vacuously.
    const streamRoutes = registeredRoutes.filter(
      (r) => r.method === "GET" && r.path.startsWith("/api/run/"),
    );
    expect(registeredRoutes.length).toBeGreaterThan(0);
    expect(streamRoutes.length).toBeGreaterThanOrEqual(1);
    // Stated as a runtime number so a change to the population is visible.
    expect(registeredRoutes.filter((r) => r.method === "POST").length).toBeGreaterThanOrEqual(1);
  });

  test(
    "TWO concurrent subscribers produce ONE execution and ONE provider POST",
    async () => {
      providerRequests = [];
      const { status, runId } = await startRun("two subscribers");
      expect(status).toBe(201);
      expect(runId).not.toBe("");

      const [a, b] = await Promise.all([
        drainStream(`/api/run/${runId}/stream`, {}, 2500),
        drainStream(`/api/run/${runId}/stream`, {}, 2500),
      ]);
      await runToCompletion(runId);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);

      // LIVENESS FIRST. Without this the assertions below pass at zero
      // executions — a guard measuring a refusal, which is the failure this
      // project keeps rediscovering.
      const projection = projectionFor(runId);
      expect(projection.assistantRows).toBeGreaterThanOrEqual(1);
      expect(a.frames.length).toBeGreaterThan(0);
      expect(b.frames.length).toBeGreaterThan(0);

      // THE VERDICT: row counts, which only the executor writes.
      expect(projection.assistantRows).toBe(1);
      expect(projection.userRows).toBe(1);
      expect(projection.claims).toBe(1);

      const responses = providerRequests.filter((r) => r.path === "/v1/responses");
      expect(responses.length).toBe(1);

      // AND THE REASON THE VERDICT IS NOT FRAME COUNTS, asserted rather than
      // asserted-about: both subscribers legitimately received the run's
      // frames, so counting frames would red on correct behaviour.
      const aIds = a.frames.filter((f) => f.id !== null).map((f) => f.id);
      const bIds = b.frames.filter((f) => f.id !== null).map((f) => f.id);
      expect(aIds.length).toBeGreaterThan(0);
      expect(bIds).toEqual(aIds);
      for (const stream of [a, b]) {
        const models = stream.frames.filter((frame) => frame.event === "model").map((frame) => frame.data as { type: string; assistantMessageId?: string });
        expect(models.some((frame) => frame.type === "start")).toBe(true);
        for (const frame of models) {
          expect(frame.assistantMessageId, "every model frame addresses its persisted assistant row").toEqual(expect.any(String));
          expect(db.getMessage(frame.assistantMessageId!, ownerUserId)).toMatchObject({ role: "assistant", run_id: runId });
        }
      }
    },
    30_000,
  );

  test.each(["assistant", "tool"] as const)("%s row persistence gates its published start and preserves a truthful failure", async (role) => {
    const { subscribeToRunFeed, runFeedState } = await import("../../server/run/run-feed.ts");
    const { WebError } = await import("../../server/kernel/errors.ts");
    for (const fail of [false, true]) {
      const subject = await freshRunSubject(`persistence-${role}-${String(fail)}`);
      const { db, adb: runDb, baseUrl: origin, user: witnessUser } = subject;
      const witnessProject = db.createProject({ name: "persistence boundary", path: tmpRoot }, witnessUser.userId);
      const witnessChat = db.createChat({ project_id: witnessProject.id, title: `${role} persistence ${String(fail)}` }, witnessUser.userId);
      const target = { projectId: witnessProject.id, chatId: witnessChat.id, origin, headers: { ...authHeaders, Cookie: witnessUser.cookie } };
      const entered = Promise.withResolvers<void>();
      const parked = Promise.withResolvers<void>();
      const release = () => parked.resolve();
      const original = runDb.createMessage.bind(runDb);
      const spy = vi.spyOn(runDb, "createMessage").mockImplementation(async (...args) => {
        if (args[0].role === role) {
          entered.resolve();
          await parked.promise;
          if (fail) throw new WebError("row persistence refused by the witness", "witness_persistence_refused");
        }
        return original(...args);
      });
      let runId = "";
      let liveDelivery: ReturnType<typeof drainStream> | undefined;
      try {
        const started = await startRun(role === "tool" ? `read the notes ${TOOL_TURN_MARKER}` : "persist this response", target);
        runId = started.runId;
        expect(started.status).toBe(201);
        await witnessed(entered.promise, "the actual row persistence boundary");
        const before = subscribeToRunFeed(runId, 0, () => {}, () => {})!;
        before.unsubscribe();
        const startType = role === "assistant" ? "start" : "tool_call_start";
        expect(before.replay.frames.filter((frame) => frame.event === "model" && (frame.data as { type: string }).type === startType), "no unpersisted start is published").toEqual([]);
        const beforeModels = before.replay.frames.filter((frame) => frame.event === "model").map((frame) => frame.data as { type: string });
        expect(beforeModels.filter((frame) => role === "assistant" || frame.type !== "start"), "neither subsequent model output nor tool arguments can overtake the held start").toEqual([]);
        // Attach while publication is parked. The route may first replay an
        // earlier assistant start; only IDs beyond this boundary are fresh.
        liveDelivery = drainStream(`/api/run/${runId}/stream`, target.headers, 2500, origin);
        await vi.waitFor(() => expect(runFeedState(runId)?.subscribers,
          "the actual HTTP route subscribes before publication is released").toBe(1), { timeout: 8000, interval: 10 });
        release();
        await runToCompletion(runId);
        const live = await liveDelivery;
        expect(live.status).toBe(200);
        const liveModels = live.frames.filter((frame) => frame.event === "model");
        for (const frame of liveModels) {
          expect(frame.id, "every delivered model frame has its native sequence").toEqual(expect.any(Number));
          if (frame.id! <= before.replay.highestSequence) {
            expect(frame.data, "the first attachment still identifies its retained prefix").toMatchObject({ replayed: true });
          } else {
            expect((frame.data as { replayed?: boolean }).replayed,
              "fresh subscribed output remains eligible for the producing clock").not.toBe(true);
          }
        }
        const delivered = await drainStream(`/api/run/${runId}/stream`, target.headers, 2500, origin);
        expect(delivered.status).toBe(200);
        const replayedModels = delivered.frames.filter((frame) => frame.event === "model");
        for (const frame of replayedModels) expect(frame.data,
          "the actual replay route identifies retained output without altering its model identity").toMatchObject({ replayed: true });
        const modelPayloads = (frames: Frame[]) => frames.map((frame) => {
          const { replayed: _replayed, ...data } = frame.data as Record<string, unknown>;
          return { ...frame, data };
        });
        expect(modelPayloads(liveModels), "fresh and retained deliveries keep identical output and native identities")
          .toEqual(modelPayloads(replayedModels));
        const starts = delivered.frames.filter((frame) => frame.event === "model" && (frame.data as { type: string }).type === startType);
        if (fail) {
          expect(starts, "failed persistence never fabricates a transcript row").toEqual([]);
          expect(delivered.frames.at(-1)).toMatchObject({ event: "error", data: { code: "witness_persistence_refused", message: "row persistence refused by the witness" } });
        } else {
          const freshTypes = liveModels.filter((frame) => frame.id! > before.replay.highestSequence)
            .map((frame) => (frame.data as { type: string }).type);
          expect(freshTypes, "the subscribed route really delivers the released start, output and completion")
            .toEqual(expect.arrayContaining([startType, role === "assistant" ? "text_delta" : "tool_call_delta", "finish"]));
          expect(replayedModels.length, "the ended feed really supplies retained model output").toBeGreaterThan(0);
          expect(starts.length, "the released persistence produces a real start").toBeGreaterThan(0);
          const modelTypes = delivered.frames.filter((frame) => frame.event === "model").map((frame) => (frame.data as { type: string }).type);
          const laterOutput = role === "assistant" ? "text_delta" : "tool_call_delta";
          expect(modelTypes.indexOf(laterOutput), "the released start precedes actual subsequent output").toBeGreaterThan(modelTypes.indexOf(startType));
          for (const frame of starts) {
            const data = frame.data as { assistantMessageId?: string; messageId?: string; callId?: string };
            const id = role === "assistant" ? data.assistantMessageId : data.messageId;
            expect(id, "the published identity comes from the actual persisted row").toEqual(expect.any(String));
            expect(db.getMessage(id!, witnessUser.userId)).toMatchObject({ role, run_id: runId });
            if (role === "tool") expect(db.getChatHistory(witnessChat.id, witnessUser.userId)!.tool_calls.some((call) => call.message_id === id && call.call_id === data.callId)).toBe(true);
          }
        }
      } finally {
        release();
        try {
          if (runId !== "") await runToCompletion(runId);
        } finally {
          try {
            await liveDelivery;
          } finally {
            spy.mockRestore();
            await subject.stop();
          }
        }
      }
    }
  }, 30_000);

  test(
    "a second execution of one run is refused by the database, not by a check",
    async () => {
      // THE PLANT ENTERS WHERE A REAL CALLER ENTERS.
      //
      // An earlier version of this test called `db.claimRunExecution` twice
      // and asserted the second throw. That tests the DB METHOD, not the
      // executor's use of it — and it was DEFEATED by exactly the mutation
      // this project keeps rediscovering: leave the claim in place, discard
      // its refusal, execute anyway. The claim row still appeared, the throw
      // still happened, and the run ran twice. Measured under that mutant:
      // 2 assistant rows and 2 provider POSTs, with `claimRows` still 1.
      //
      // So the plant drives `startRunExecution` — the door — twice on ONE run,
      // and the verdict is what the executor writes.
      providerRequests = [];
      const { setActiveRun } = await import("../../server/run/run-registry.ts");
      const { createRunContextManager } = await import("../../server/context/context-bridge.ts");
      const { loadProviderStore, resolveProviderCredential } =
        await import("../../server/llm/providers.ts");
      // THE CREDENTIAL CANNOT BE WRITTEN HERE, and that is the point. Its
      // brand is a module-private symbol in `server/providers.ts`, so an
      // object literal does not satisfy the type — this test has to go and
      // get one the way the run route does, from the caller's saved record.
      const { AsyncDbClient: Facade } = await import("../../server/db/async-client.ts");
      const credential = resolveProviderCredential(
        await loadProviderStore(Facade.inline(db), ownerUserId),
        null, PROVIDER_FIXTURE_OWNER
      );

      const runId = `run-claim-race-${String(Date.now())}`;
      const contextManager = createRunContextManager();
      contextManager.addTurn({ role: "user", content: "claim race" });
      setActiveRun(runId, {
        chatId,
        prompt: "claim race",
        credential,
        userId: ownerUserId,
        projectId,
        projectPath: tmpRoot,
        projectName: "run-once",
        accumulatedText: "",
        assistantMessageId: null,
        abortController: new AbortController(),
        runEventId: null,
        turnId: null,
        steeringQueue: [],
        toolCallRows: new Map(),
        toolAttemptCounts: new Map(),
        accumulatedReasoning: "",
        accumulatedTokenMetrics: undefined,
        accumulatedResponseHeaders: undefined,
        accumulatedResponseModel: undefined,
        accumulatedContext: undefined,
        accumulatedDedupSummary: undefined,
        accumulatedRedactionNotice: undefined,
        turnStartedAt: null,
        turnFirstTokenAt: null,
        turnFirstOutputAt: null,
        turnFinishedAt: null,
        contextManager,
        retrievedMemories: [],
        safetyGate: undefined,
        toolSettingsSnapshot: new Map(),
      } as never);
      // The feed is NOT opened here. The executor opens it, after the claim,
      // and ends it in its own `finally` — so a start refused at the claim
      // leaves none behind. Opening one here would hand the loser a feed the
      // product would never have created.

      // Two real mutating requests, each spending the warrant its own
      // dispatch minted — the same path `POST /api/run/start` takes.
      const outcomes = await Promise.all([startUnderWarrant(runId), startUnderWarrant(runId)]);
      await runToCompletion(runId);

      // LIVENESS FIRST: one of them must actually have run.
      const projection = projectionFor(runId);
      expect(projection.assistantRows).toBeGreaterThanOrEqual(1);

      // THE VERDICT — evidence only the executor produces.
      expect(projection.assistantRows).toBe(1);
      expect(projection.claims).toBe(1);
      expect(providerRequests.filter((r) => r.path === "/v1/responses").length).toBe(1);

      // …and the loser was told why, with the taxonomy's own code. This is
      // asserted AFTER the row counts, because the refusal is the mechanism
      // and the row counts are the outcome — a mutation that keeps the throw
      // and discards it satisfies the first and fails the second.
      const refused = outcomes.filter((o) => o.status !== 200);
      expect(refused.length).toBe(1);
      expect(refused[0]!.status).toBe(409);
      expect(refused[0]!.code).toBe("run_already_executing");
      expect(outcomes.filter((o) => o.status === 200).length).toBe(1);
    },
    30_000,
  );

  test("a warrant authorises ONE operation — honouring it twice is refused the second time", async () => {
    // THE OTHER HALF OF REVOCATION, and it needs its own guard because the
    // two halves cover different attacks and each hides the other's absence.
    // End-of-request revocation kills a warrant CARRIED OUT of its dispatch;
    // spending it on check kills a warrant REUSED inside one. Driven: with
    // the on-check revocation removed and the end-of-dispatch one left in
    // place, the stash test still passes and this one is the only thing that
    // notices — which is exactly why it exists.
    const outcomes = await spendTwice();
    expect(outcomes.length, "the tap must have attempted both").toBe(2);
    expect(outcomes[0], "the first, legitimate use must be accepted").toBeNull();
    expect(
      outcomes[1],
      "a warrant re-honoured inside its own request is a second state change on one " +
        "authorisation — the value a handler squirrels away is already spent",
    ).toBe("mutation_warrant_required");
  });

  test(
    "a REAL warrant carried out of its request is refused, and executes nothing",
    async () => {
      // THE HOLE THIS CLOSES WAS NOT A FORGERY. Every forged shape was
      // already refused — `{}`, a frozen object, a `Proxy` of one,
      // `Object.create(null)` — because none of them was ever minted. A
      // GENUINE warrant kept from an earlier request was a different matter:
      // the registry was a `WeakSet`, which revokes nothing, so the value
      // stayed valid indefinitely. Driven before the fix: a warrant held
      // across three later requests and a forced GC was ACCEPTED, and a
      // `router.get` handler holding one executed a complete run — the whole
      // point of the warrant, defeated by a variable.
      //
      // The verdict is rows, not the throw: a refusal that still executed
      // would satisfy an assertion about the error and be the defect.
      providerRequests = [];
      const { startRunExecution } = await import("../../server/run/run-executor.ts");
      const { AsyncDbClient } = await import("../../server/db/async-client.ts");
      const { ForbiddenError } = await import("../../server/kernel/errors.ts");
      const adb = AsyncDbClient.inline(db);

      const stashed = await stashWarrant();
      // LIVENESS: it really is the article the router mints — same brand,
      // same shape — so the refusal below is about its LIFETIME and not
      // about it being the wrong kind of thing.
      expect(typeof stashed).toBe("object");
      expect(stashed).not.toBeNull();

      // Three later mutating requests pass through the router, as in the
      // original attack, so the refusal cannot be an artefact of immediacy.
      // They are dispatches, not runs: the claim is about the WARRANT
      // outliving its request, and paying for three provider round trips to
      // advance a request counter would be time the suite's wall-clock budget
      // spends on nothing the assertion reads.
      for (let i = 0; i < 3; i += 1) await stashWarrant();

      const runId = `run-stashed-warrant-${String(Date.now())}`;
      let refusal: unknown = null;
      try {
        await startRunExecution(stashed, runId, ownerUserId, adb);
      } catch (err) {
        refusal = err;
      }
      expect(refusal).toBeInstanceOf(ForbiddenError);
      expect((refusal as { code: string }).code).toBe("mutation_warrant_required");

      // …and nothing happened: no claim row, no feed, no registry entry, no
      // provider call. The refusal is before the first effect.
      const { runFeedState } = await import("../../server/run/run-feed.ts");
      const { getActiveRun } = await import("../../server/run/run-registry.ts");
      expect(projectionFor(runId).claims).toBe(0);
      expect(runFeedState(runId)).toBeUndefined();
      expect(getActiveRun(runId)).toBeUndefined();
    },
    30_000,
  );

  test(
    "a subscriber leaving does NOT stop the run",
    async () => {
      // The prompt is already paid for by the time a socket drops. Throwing
      // the answer away does not refund it — it only loses it. Worse, the run
      // being killed was another party's run: the abort controller was shared.
      // The provider is explicitly held for this prompt, so the socket closes
      // while the turn is genuinely in flight. Without that window the run is
      // already over when the subscriber leaves, and the test would pass
      // whether or not leaving aborts anything.
      const held = holdProvider(`survive the disconnect ${SLOW_MARKER}`);
      let runId = "";
      try {
        ({ runId } = await startRun(`survive the disconnect ${SLOW_MARKER}`));
        await held.ready();
        const res = await fetch(`${baseUrl}/api/run/${runId}/stream`, { headers: authHeaders });
        const reader = res.body!.getReader();
        await reader.read();
        await reader.cancel();

        held.release();
        await runToCompletion(runId);
        // The run finished on its own AFTER its only subscriber walked away.
        //
        // COUNTING THE ASSISTANT ROW IS NOT ENOUGH, and an earlier version of
        // this test did exactly that and was DEFEATED. The row is created when
        // the model stream STARTS, so an aborted run leaves one behind too —
        // empty. Restoring the disconnect-aborts-the-run coupling produced an
        // identical row count and the guard stayed green while the defect was
        // back in the tree.
        //
        // So the verdict is what only a run that RAN to the end can produce:
        // the assistant's text is present, and no error row was written.
        const projection = projectionFor(runId);
        expect(projection.assistantRows).toBe(1);
        expect(projection.claims).toBe(1);

        const raw = db as unknown as {
          db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } };
        };
        const errorRows = Number(
          (
            raw.db
              .prepare("SELECT COUNT(*) n FROM messages WHERE run_id = ? AND role = 'error'")
              .get(runId) as { n: number }
          ).n,
        );
        expect(errorRows, "an aborted run writes an error row; a finished one does not").toBe(0);

        const finished = db.listMessages(chatId, ownerUserId).filter(
          (m) => m.run_id === runId && m.role === "assistant",
        );
        expect(finished.length).toBe(1);
        expect(
          finished[0]!.content.length,
          "the assistant answer is empty, which means the run was cut short rather than completed",
        ).toBeGreaterThan(0);
        // The provider's turn ran to a finish, so the feed reached its terminal
        // state rather than being torn down mid-stream.
        const { runFeedState } = await import("../../server/run/run-feed.ts");
        expect(runFeedState(runId)?.ended).toBe(true);
      } finally {
        held.dispose();
        if (runId !== "") await runToCompletion(runId);
      }
    },
    30_000,
  );

  test(
    "the feed's state is REPORTABLE, and it is what the replay is served from",
    async () => {
      // A guard about a bounded buffer has to be able to STATE the bound's
      // subject at runtime. These are the numbers the feed answers with, and
      // asserting them here is also what keeps the reporting accessors from
      // becoming the thing this codebase keeps rediscovering: a capability
      // that exists, is correct, and has no caller.
      const { runFeedState, runFeedCount } = await import("../../server/run/run-feed.ts");
      const { activeRunCount } = await import("../../server/run/run-registry.ts");

      const { runId } = await startRun("report your state");
      const during = runFeedState(runId);
      expect(during, "a started run must have a feed").toBeDefined();
      expect(runFeedCount()).toBeGreaterThanOrEqual(1);
      expect(activeRunCount()).toBeGreaterThanOrEqual(1);

      await runToCompletion(runId);
      const after = runFeedState(runId);
      expect(after).toBeDefined();
      expect(after!.ended, "the run finished, so its feed is terminal").toBe(true);
      // Sequences count from 1 and every published frame took one, so the
      // next sequence is one past however many were published.
      expect(after!.nextSequence).toBe(after!.frames + after!.droppedBefore + 1);
      expect(after!.droppedBefore).toBe(0);
      expect(after!.frames).toBeGreaterThan(0);
      // The run is gone from the registry but its feed is retained, which is
      // precisely the state a reconnect depends on.
      expect(after!.subscribers).toBe(0);
    },
    30_000,
  );

  test(
    "a reconnect replays from Last-Event-ID instead of meeting a 404",
    async () => {
      const { runId } = await startRun("resume me");
      const first = await drainStream(`/api/run/${runId}/stream`, {}, 400);
      expect(first.status).toBe(200);
      await runToCompletion(runId);

      const fresh = await drainStream(`/api/run/${runId}/stream`, {}, 900);
      // The run has FINISHED and the connection that watched it has gone.
      // Before this, that was a 404 and the run was unreachable for good.
      expect(fresh.status).toBe(200);
      const freshIds = fresh.frames.filter((f) => f.id !== null).map((f) => f.id as number);
      expect(freshIds.length).toBeGreaterThan(0);
      expect(freshIds[0]).toBe(1);

      const resumed = await drainStream(`/api/run/${runId}/stream`, { "Last-Event-ID": "3" }, 900);
      const resumedIds = resumed.frames.filter((f) => f.id !== null).map((f) => f.id as number);
      expect(resumedIds.length).toBeGreaterThan(0);
      // Resumption means resumption: every id is strictly past the one the
      // client said it had, and nothing before it is re-sent.
      expect(Math.min(...resumedIds)).toBe(4);
      expect(resumedIds.every((id) => id > 3)).toBe(true);
      // …and it is a SUFFIX of the full stream, not a different stream.
      expect(resumedIds).toEqual(freshIds.filter((id) => id > 3));
    },
    30_000,
  );

  test("the 404 and 403 gates still hold on the subscriber", async () => {
    const missing = await fetch(`${baseUrl}/api/run/run-does-not-exist/stream`, {
      headers: authHeaders,
    });
    expect(missing.status).toBe(404);

    const { createTestUser } = await import("../helpers/multi-user.ts");
    const other = createTestUser(db, "someone-else");
    const { runId } = await startRun("ownership");
    const foreign = await fetch(`${baseUrl}/api/run/${runId}/stream`, {
      headers: { Cookie: `${other.cookie}; harness_session=other` },
    });
    expect(foreign.status).toBe(403);
    // Wait for the run this test started to actually finish, rather than
    // sleeping a constant long enough for it. The constant was paid in full
    // on every run of the suite, and the suite is judged on wall clock.
    await runToCompletion(runId);
  }, 30_000);

  test(
    "ONE live run per conversation — a second start on the same chat is refused with its remedy",
    async () => {
      // The concurrent-run defect's server-side backstop. The cockpit's
      // composer routes a plain send under a live run to STEERING, but every
      // other door still reaches this route: a second window on the same
      // chat, a hand-rolled API call, and the race where the client's run
      // view retired a moment before the POST. Two executors writing one
      // transcript race each other, so the second start is refused as a
      // principled refusal of the guided 428 family — the client renders its
      // typed code and the server's own sentence, never as a broken send.
      //
      // The refusal travels in the PRINCIPLED-REFUSAL ENVELOPE: a 200 body
      // carrying `{ refusal: { code, message, status } }`, not a bare 428 —
      // the browser logs every non-2xx status itself before any page code
      // runs, and a DESIGNED refusal must not print a standing console
      // error (the measured UIE-014 defect). The client's fetch door
      // reconstructs the typed error from the envelope, so nothing changes
      // for any consumer except the console line, which goes away.
      const { activeRunForChat } = await import("../../server/run/run-registry.ts");
      const held = holdProvider("the first run holds the conversation");
      let first = { status: 0, runId: "" };
      try {
        first = await startRun("the first run holds the conversation");
        expect(first.status).toBe(201);
        await held.ready();
        expect(activeRunForChat(chatId, ownerUserId)).toBe(first.runId);

        const second = await fetch(`${baseUrl}/api/run/start`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ projectId, chatId, prompt: "a second run would race it" }),
        });
        expect(second.status).toBe(200);
        const body = (await second.json()) as {
          runId?: string;
          refusal?: { code?: string; message?: string; status?: number; liveRunId?: string };
        };
        expect(body.refusal?.code).toBe("chat_run_live");
        expect(body.refusal?.status).toBe(428);
        expect(body.refusal?.message).toContain("a run is already live in this conversation");
        expect(body.refusal?.message).toContain("steer it");
        expect(body.runId, "a refused start started nothing — the body carries no run id").toBeUndefined();
        // The refusal NAMES ITS OWN SUBJECT: the run that is already live,
        // looked up by the gate that refused. That id is what lets the client
        // ADOPT the run (open its stream so its beats render live, plant its
        // view so the sentence's steer remedy routes) — without it, a run the
        // client did not start is invisible in the flow and unreachable by
        // the very remedy the sentence promises.
        expect(body.refusal?.liveRunId).toBe(first.runId);
        expect(activeRunForChat(chatId, ownerUserId)).toBe(first.runId);

        // The refusal is about the CHAT, not the project: a DIFFERENT
        // conversation of the same project starts fine while the first runs.
        const otherChat = db.createChat({ project_id: projectId, title: "a different conversation" }, ownerUserId);
        const otherStart = await fetch(`${baseUrl}/api/run/start`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ projectId, chatId: otherChat.id, prompt: "free to run" }),
        });
        expect(otherStart.status).toBe(201);
        const otherBody = (await otherStart.json()) as { runId: string };
        await runToCompletion(otherBody.runId);

        // And once the first run settles, its conversation opens again — the
        // gate is live-run-only, never a permanent lock.
        held.release();
        await runToCompletion(first.runId);
        const third = await startRun("the conversation is open again");
        expect(third.status).toBe(201);
        await runToCompletion(third.runId);
      } finally {
        held.dispose();
        if (first.runId !== "") await runToCompletion(first.runId);
      }
    },
    30_000,
  );

  test(
    "a race through the start route's own awaits still admits exactly ONE run",
    async () => {
      // The early gate refuses the settled case fast, but between it and
      // the registration the route awaits (history, compose adjustments),
      // and two starts that interleave through that gap both pass the
      // early gate while neither run is in the registry yet — observed at
      // the wire against the live server as two 201s and two executors
      // racing one transcript. Network timing cannot be made to reproduce
      // that on demand, so this arm parks the route INSIDE the gap: a db
      // whose getProject awaits a gate both requests are provably behind.
      // Release, and both handlers resume already past the early gate's
      // moment — the registration's own recheck is the seam-free half
      // (check and insert in one synchronous stretch), so exactly one start
      // wins and the loser reads the winner there and is refused with the
      // same remedy.
      const { createRouter } = await import("../../server/router/router.ts");
      const { registerRunRoutes } = await import("../../server/routes/run.ts");
      const { createServer } = await import("node:http");
      const { AsyncDbClient: Facade } = await import("../../server/db/async-client.ts");
      const inline = Facade.inline(db);
      // The park's release. Declared callable from the start (a no-op until
      // the Promise constructor swaps in the real resolve) so the type is
      // what the arm calls, not a null-narrowing exercise.
      let releasePark: () => void = () => {};
      const parked = new Promise<void>((resolve) => {
        releasePark = resolve;
      });
      let parkedCalls = 0;
      const originalGetProject = inline.getProject.bind(inline);
      const parkingDb = new Proxy(inline, {
        get(target, prop) {
          if (prop === "getProject") {
            return async (...args: Parameters<typeof originalGetProject>) => {
              parkedCalls += 1;
              await parked;
              return originalGetProject(...args);
            };
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as typeof inline;
      const raceRouter = createRouter({ db: parkingDb, isPublicPath: () => false });
      registerRunRoutes(
        { get: raceRouter.get.bind(raceRouter), post: raceRouter.post.bind(raceRouter) } as unknown as import("../../server/router/router.ts").Router,
        parkingDb,
      );
      const raceServer = createServer((req, res) => raceRouter.dispatch(req, res));
      await new Promise<void>((resolve) => {
        raceServer.listen(0, "127.0.0.1", () => resolve());
      });
      const raceUrl = `http://127.0.0.1:${(raceServer.address() as { port: number }).port}`;
      const readOut = (r: Response) => r.json().catch(() => null).then((body) => ({ status: r.status, body }));
      const aP = fetch(`${raceUrl}/api/run/start`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ projectId, chatId, prompt: "racing start one" }),
      }).then(readOut);
      const bP = fetch(`${raceUrl}/api/run/start`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ projectId, chatId, prompt: "racing start two" }),
      }).then(readOut);
      try {
        // RENDEZVOUS: the park only opens once BOTH handlers are provably
        // inside the route — each parked getProject call is one. This is
        // what makes the arm the race itself, never the settled case the
        // early gate already covers, and never a timing-dependent flake.
        const rendezvousDeadline = Date.now() + 5_000;
        while (parkedCalls < 2 && Date.now() < rendezvousDeadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(parkedCalls, "both racing starts must reach the parked await").toBe(2);
        releasePark();
        const [a, b] = await Promise.all([aP, bP]);
        // The refusal travels in the ENVELOPE (a 200 body carrying the typed
        // 428), so exactly one request answers the admission's 201 and the
        // other the refusal's 200 — distinguished by what each BODY carries.
        const statuses = [a.status, b.status].sort();
        expect(
          statuses,
          `two racing starts resolved to [${String(a.status)}, ${String(b.status)}] — exactly one may be admitted`,
        ).toEqual([200, 201]);
        const refused = (a.body as { refusal?: unknown } | null)?.refusal !== undefined ? a : b;
        const admitted = refused === a ? b : a;
        expect((refused.body as { refusal?: { code?: string } } | null)?.refusal?.code).toBe(
          "chat_run_live",
        );
        expect(
          String(
            ((refused.body as { refusal?: { message?: string } } | null)?.refusal?.message ?? ""),
          ),
        ).toContain("a run is already live in this conversation");
        const runId = (admitted.body as { runId?: string } | null)?.runId;
        expect(typeof runId).toBe("string");
        await runToCompletion(runId as string);
        const { activeRunForChat } = await import("../../server/run/run-registry.ts");
        expect(activeRunForChat(chatId, ownerUserId)).toBeUndefined();
      } finally {
        releasePark();
        raceServer.close();
        raceServer.closeAllConnections?.();
      }
    },
    30_000,
  );

  test(
    "the registry entry lives from admission to the TERMINAL SETTLE — the epilogue stays answerable (UIE-034)",
    async () => {
      // WHERE THE DRIVE'S "EMPTY REGISTRY MID-RUN" REALLY WAS. The claim used
      // to be released the moment the turn loop ended, on the reasoning that
      // the epilogue after it could not race a second executor. But the
      // client's run view lives until the terminal `done` frame (the earlier
      // liveness fix kept it alive across per-turn finishes on purpose), and
      // the epilogue
      // — the quality snapshot, the timeline replay — takes SECONDS on a real
      // project. In exactly that window the drive observed: a steer POST
      // answering a RAW 404 "already completed" while the pane read
      // "running", and a mid-run start answering 201 with a SECOND executor
      // overlapping the first (×4, incl. a fresh HEAD server). The reader
      // was not confused about liveness; the two windows disagreed.
      //
      // The new contract: the entry is removed ONLY at the terminal settle
      // (the executor's `finally`, beside the terminal frame), so every door
      // answers for the run's whole VISIBLE life. This arm parks the
      // epilogue's timeline replay at the database — the same rendezvous the
      // old arm used — and demands the opposite of what the old design
      // promised: the entry PRESENT, a start refused with its remedy, a
      // steer refused as "finishing" (never queued-and-lost), a cancel
      // honoured — and all of it before the park opens.
      const { createRouter } = await import("../../server/router/router.ts");
      const { registerRunRoutes } = await import("../../server/routes/run.ts");
      const { registerRunStreamRoutes } = await import("../../server/routes/run-stream.ts");
      const { isPublicPath } = await import("../../server/routes/registry.ts");
      const { createServer } = await import("node:http");
      const { AsyncDbClient: Facade } = await import("../../server/db/async-client.ts");
      const inline = Facade.inline(db);
      let releasePark: () => void = () => {};
      const parked = new Promise<void>((resolve) => {
        releasePark = resolve;
      });
      let parkedCalls = 0;
      const originalCreateTimelineRef = inline.createTimelineRef.bind(inline);
      const parkingDb = new Proxy(inline, {
        get(target, prop) {
          if (prop === "createTimelineRef") {
            return async (...args: Parameters<typeof originalCreateTimelineRef>) => {
              parkedCalls += 1;
              await parked;
              return originalCreateTimelineRef(...args);
            };
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as typeof inline;
      const gateRouter = createRouter({ db: parkingDb, isPublicPath });
      registerRunRoutes(gateRouter, parkingDb);
      registerRunStreamRoutes(gateRouter, parkingDb);
      const gateServer = createServer((req, res) => gateRouter.dispatch(req, res));
      await new Promise<void>((resolve) => {
        gateServer.listen(0, "127.0.0.1", () => resolve());
      });
      const gateUrl = `http://127.0.0.1:${(gateServer.address() as { port: number }).port}`;
      const gateChat = db.createChat({ project_id: projectId, title: "epilogue window" }, ownerUserId);
      try {
        const start = await fetch(`${gateUrl}/api/run/start`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ projectId, chatId: gateChat.id, prompt: "the epilogue window" }),
        });
        expect(start.status).toBe(201);
        const { runId } = (await start.json()) as { runId: string };

        // Wait until the run is PROVABLY inside its parked epilogue (or the
        // run genuinely ended — in which case the park was never the
        // determinant and the assertions below still decide honestly).
        const { runFeedState } = await import("../../server/run/run-feed.ts");
        const { activeRunForChat, getActiveRun } = await import("../../server/run/run-registry.ts");
        const deadline = Date.now() + 8_000;
        while (
          parkedCalls === 0 &&
          runFeedState(runId)?.ended !== true &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 25));
        }
        const feedEndedBeforePark = runFeedState(runId)?.ended === true;
        if (!feedEndedBeforePark) {
          expect(parkedCalls, "the epilogue must have reached its parked timeline replay").toBeGreaterThan(0);
          // THE CONTRACT: the entry is STILL PRESENT while the epilogue is
          // provably stuck. The old design released it here; the drive
          // measured that window as raw 404s and a second admitted executor.
          expect(
            activeRunForChat(gateChat.id, ownerUserId),
            "the registry entry must live to the terminal settle — the epilogue is still the run's visible life",
          ).toBeDefined();
          expect(getActiveRun(runId)).toBeDefined();
          expect(parkedCalls, "…and the epilogue is provably still stuck").toBeGreaterThan(0);
          // A second start is refused with its remedy — in the ENVELOPE, so
          // the raced shape the drive hit answers a 200 carrying the typed
          // 428, never a raw status a browser logs.
          const raced = await fetch(`${gateUrl}/api/run/start`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({ projectId, chatId: gateChat.id, prompt: "racing the epilogue" }),
          });
          expect(raced.status).toBe(200);
          const racedBody = (await raced.json()) as { refusal?: { code?: string; message?: string; status?: number } };
          expect(racedBody.refusal?.code).toBe("chat_run_live");
          expect(racedBody.refusal?.status).toBe(428);
          expect(racedBody.refusal?.message).toContain("a run is already live in this conversation");
          // A steer in the epilogue window is NOT a raw 404 and NOT a
          // queued-and-lost delivery: the run still exists, but its turn
          // loop is done, so the door refuses as the designed "finishing"
          // state in the same envelope.
          const steered = await fetch(`${gateUrl}/api/run/${runId}/steer`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({ prompt: "a steer pressed while the run settles" }),
          });
          expect(steered.status).toBe(200);
          const steerBody = (await steered.json()) as { refusal?: { code?: string; message?: string; status?: number }; queued?: number };
          expect(steerBody.refusal?.code).toBe("run_finishing");
          expect(steerBody.refusal?.status).toBe(428);
          expect(steerBody.refusal?.message).toContain("it can no longer take instructions");
          expect(steerBody.queued, "a finishing run queues nothing it will not deliver").toBeUndefined();
          // The steer refused as a designed state persisted no message row —
          // the words were never a fact of this conversation.
          const rows = db.listMessages(gateChat.id, ownerUserId).filter((m) => m.content.includes("a steer pressed while the run settles"));
          expect(rows).toHaveLength(0);
          // A cancel is HONOURED through the whole visible life: the reader
          // can still stop a run that is settling.
          const cancelled = await fetch(`${gateUrl}/api/run/${runId}/cancel`, {
            method: "POST",
            headers: authHeaders,
          });
          expect(cancelled.status).toBe(200);
          // Let the executor unwind; the claim and the terminal frame
          // settle together, and only then does the conversation open.
          releasePark();
          await runToCompletion(runId);
          expect(
            activeRunForChat(gateChat.id, ownerUserId),
            "the terminal settle is what clears the entry",
          ).toBeUndefined();
          const after = await fetch(`${gateUrl}/api/run/start`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({ projectId, chatId: gateChat.id, prompt: "open again after the settle" }),
          });
          expect(after.status).toBe(201);
          const afterBody = (await after.json()) as { runId: string };
          await runToCompletion(afterBody.runId);
        } else {
          releasePark();
          await runToCompletion(runId);
        }
      } finally {
        releasePark();
        gateServer.close();
        gateServer.closeAllConnections?.();
      }
    },
    30_000,
  );

  test(
    "cancel ABORTS but does not DELETE — the entry lives through the unwind, and a raced start is refused until the settle",
    async () => {
      // THE ROUTE'S OWN COMMENT NAMES THE HAZARD, and no arm pinned it:
      // "A route-side delete here would re-open the exact window this
      // round closed: the entry gone while the executor's bookkeeping
      // still writes, so a racing start would be admitted underneath a run
      // the reader just stopped and whose cancelled frame has not arrived
      // yet" (server/routes/run.ts, the cancel route). The epilogue arm
      // cancels but asserts nothing between the cancel and the park's
      // release, so a restored route-side deleteActiveRun survived the
      // whole suite — this arm is the pin for that one sentence.
      //
      // The rendezvous is the epilogue's own park (createTimelineRef): the
      // executor is provably suspended inside its unwind-only tail when
      // the cancel lands, and the abort does NOT interrupt that await — so
      // the entry's presence below is a window that exists, never a timing
      // lottery, and the finally that owns the removal provably has not
      // run.
      const { createRouter } = await import("../../server/router/router.ts");
      const { registerRunRoutes } = await import("../../server/routes/run.ts");
      const { registerRunStreamRoutes } = await import("../../server/routes/run-stream.ts");
      const { isPublicPath } = await import("../../server/routes/registry.ts");
      const { createServer } = await import("node:http");
      const { AsyncDbClient: Facade } = await import("../../server/db/async-client.ts");
      const inline = Facade.inline(db);
      let releasePark: () => void = () => {};
      const parked = new Promise<void>((resolve) => {
        releasePark = resolve;
      });
      let parkedCalls = 0;
      const originalCreateTimelineRef = inline.createTimelineRef.bind(inline);
      const parkingDb = new Proxy(inline, {
        get(target, prop) {
          if (prop === "createTimelineRef") {
            return async (...args: Parameters<typeof originalCreateTimelineRef>) => {
              parkedCalls += 1;
              await parked;
              return originalCreateTimelineRef(...args);
            };
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as typeof inline;
      const gateRouter = createRouter({ db: parkingDb, isPublicPath });
      registerRunRoutes(gateRouter, parkingDb);
      registerRunStreamRoutes(gateRouter, parkingDb);
      const gateServer = createServer((req, res) => gateRouter.dispatch(req, res));
      await new Promise<void>((resolve) => {
        gateServer.listen(0, "127.0.0.1", () => resolve());
      });
      const gateUrl = `http://127.0.0.1:${(gateServer.address() as { port: number }).port}`;
      const cancelChat = db.createChat({ project_id: projectId, title: "the cancel unwind window" }, ownerUserId);
      try {
        const start = await fetch(`${gateUrl}/api/run/start`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ projectId, chatId: cancelChat.id, prompt: "the cancel unwind window" }),
        });
        expect(start.status).toBe(201);
        const { runId } = (await start.json()) as { runId: string };

        // Wait until the run is PROVABLY parked inside its epilogue (or it
        // genuinely ended — in which case the park was never the
        // determinant and the arm says so rather than measuring nothing).
        const { runFeedState } = await import("../../server/run/run-feed.ts");
        const { activeRunForChat, getActiveRun } = await import("../../server/run/run-registry.ts");
        const deadline = Date.now() + 8_000;
        while (
          parkedCalls === 0 &&
          runFeedState(runId)?.ended !== true &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 25));
        }
        const feedEndedBeforePark = runFeedState(runId)?.ended === true;
        if (!feedEndedBeforePark) {
          expect(parkedCalls, "the run must be parked inside its epilogue before the cancel").toBeGreaterThan(0);
          expect(
            activeRunForChat(cancelChat.id, ownerUserId),
            "the entry is present before the cancel — the arm's ground",
          ).toBeDefined();

          // THE CANCEL: honoured, and the abort is the WHOLE of it.
          const cancelled = await fetch(`${gateUrl}/api/run/${runId}/cancel`, {
            method: "POST",
            headers: authHeaders,
          });
          expect(cancelled.status).toBe(200);

          // THE CONTRACT, asserted INSIDE the unwind window. The executor
          // is provably still parked mid-epilogue, so its `finally` — the
          // ONE removal — has not run; the entry must still be here. A
          // route-side deleteActiveRun reintroduced at the abort line is
          // gone before the response is even written, and this is red.
          expect(parkedCalls, "…and the unwind is provably still parked").toBeGreaterThan(0);
          expect(
            getActiveRun(runId),
            "cancel aborted the run; only the terminal settle may forget it",
          ).toBeDefined();
          expect(
            activeRunForChat(cancelChat.id, ownerUserId),
            "the one-run gate's subject survives the stop verb",
          ).toBeDefined();

          // A start raced THROUGH the unwind window is refused with its
          // remedy — in the envelope, the typed 428 — because the
          // cancelled frame has not arrived and the executor's bookkeeping
          // still writes. Under the route-side delete this is the second
          // executor the drive measured, admitted 201.
          const raced = await fetch(`${gateUrl}/api/run/start`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({ projectId, chatId: cancelChat.id, prompt: "racing the cancel unwind" }),
          });
          expect(raced.status).toBe(200);
          const racedBody = (await raced.json()) as { refusal?: { code?: string; message?: string; status?: number }; runId?: string };
          expect(racedBody.refusal?.code).toBe("chat_run_live");
          expect(racedBody.refusal?.status).toBe(428);
          expect(racedBody.refusal?.message).toContain("a run is already live in this conversation");
          expect(racedBody.runId, "a refused start started nothing").toBeUndefined();

          // Release: the unwind completes, and the SETTLE — the
          // executor's `finally`, beside the terminal frame — is what
          // clears the entry. The conversation opens again after it.
          releasePark();
          await runToCompletion(runId);
          expect(
            activeRunForChat(cancelChat.id, ownerUserId),
            "the terminal settle is what clears the entry",
          ).toBeUndefined();
          expect(runFeedState(runId)?.ended, "the abort reached the terminal frame through the one exit").toBe(true);
          const after = await fetch(`${gateUrl}/api/run/start`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({ projectId, chatId: cancelChat.id, prompt: "open after the cancelled settle" }),
          });
          expect(after.status).toBe(201);
          const afterBody = (await after.json()) as { runId: string };
          await runToCompletion(afterBody.runId);
        } else {
          releasePark();
          await runToCompletion(runId);
        }
      } finally {
        releasePark();
        gateServer.close();
        gateServer.closeAllConnections?.();
      }
    },
    30_000,
  );

  test(
    "mid-run turns never clear the entry — a steer mid-turn 200s and a second start mid-turn is refused",
    async () => {
      // The OTHER half of UIE-034, pinned from the inside: while the turn
      // loop is genuinely executing — an explicitly held first turn, and a
      // tool-call run BETWEEN its two turns — the registry entry must be
      // present and answerable. The drive's mid-run 404s were the epilogue
      // window wearing the pane's "running"; this arm proves the turn-loop
      // window itself was never the defect, so a future regression cannot
      // hide behind "it was probably the epilogue again".
      const { activeRunForChat } = await import("../../server/run/run-registry.ts");
      const { runFeedState } = await import("../../server/run/run-feed.ts");

      // The first tool turn completes; its native continuation is held.
      const toolHeld = holdProvider(`read the notes ${TOOL_TURN_MARKER} ${SLOW_MARKER}`, true);
      let toolRun = { status: 0, runId: "" };
      try {
        toolRun = await startRun(`read the notes ${TOOL_TURN_MARKER} ${SLOW_MARKER}`);
        expect(toolRun.status).toBe(201);
        await toolHeld.ready();
        expect(toolHeld.hits(), "the second native request reached its held response").toBe(1);
        expect(
          activeRunForChat(chatId, ownerUserId),
          "the per-turn finish between two turns must NOT clear the entry",
        ).toBeDefined();
        // A steer mid-run-2 is DELIVERED: the loop is still live, so the
        // queue will be read at the next turn boundary.
        const steered = await fetch(`${baseUrl}/api/run/${toolRun.runId}/steer`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ prompt: `steer the tool run ${TOOL_TURN_MARKER}` }),
        });
        expect(steered.status).toBe(200);
        const steerBody = (await steered.json()) as { queued?: number; steered?: boolean; refusal?: { code?: string } };
        expect(steerBody.steered).toBe(true);
        expect(steerBody.queued).toBe(1);
        expect(steerBody.refusal, "a live turn-loop steer is a delivery, not a refusal").toBeUndefined();
        // A second start mid-run is refused with the remedy envelope.
        const raced = await fetch(`${baseUrl}/api/run/start`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ projectId, chatId, prompt: "a second run would race the tool run" }),
        });
        expect(raced.status).toBe(200);
        const racedBody = (await raced.json()) as { refusal?: { code?: string }; runId?: string };
        expect(racedBody.refusal?.code).toBe("chat_run_live");
        expect(racedBody.runId).toBeUndefined();
        toolHeld.release();
        await runToCompletion(toolRun.runId);
        expect(activeRunForChat(chatId, ownerUserId), "the settle clears the entry").toBeUndefined();
        expect(runFeedState(toolRun.runId)?.ended).toBe(true);

      } finally {
        toolHeld.dispose();
        if (toolRun.runId !== "") await runToCompletion(toolRun.runId);
      }

      // Hold the actual first text response before its completion.
      providerRequests = [];
      const textHeld = holdProvider(`survive the disconnect ${SLOW_MARKER}`);
      let slowRun = { status: 0, runId: "" };
      try {
        slowRun = await startRun(`survive the disconnect ${SLOW_MARKER}`);
        expect(slowRun.status).toBe(201);
        await textHeld.ready();
        expect(
          activeRunForChat(chatId, ownerUserId),
          "a mid-first-turn probe finds the entry",
        ).toBeDefined();
        const midSteer = await fetch(`${baseUrl}/api/run/${slowRun.runId}/steer`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ prompt: "steered mid first turn" }),
        });
        expect(midSteer.status).toBe(200);
        const midBody = (await midSteer.json()) as { steered?: boolean };
        expect(midBody.steered).toBe(true);
        textHeld.release();
        await runToCompletion(slowRun.runId);
        expect(activeRunForChat(chatId, ownerUserId)).toBeUndefined();
      } finally {
        textHeld.dispose();
        if (slowRun.runId !== "") await runToCompletion(slowRun.runId);
      }
    },
    30_000,
  );

  test(
    "a steer queued mid-TOOL-turn is delivered ONCE — the continuation composes it and no drain turn re-answers it (UIE-055)",
    async () => {
      // THE DEFECT, AS THE DRIVE MEASURED IT (drive 8, run-87da21f0): a
      // steer posted while a tool-call turn streams entered the
      // conversation AND stayed queued, so the tool-loop continuation
      // turn composed it and answered it — and then the drain, keyed to
      // "the current turn finished", shifted the still-queued entry and
      // started ANOTHER full-context turn that answered the same
      // instruction again: two identical reply beats, one wasted
      // ~16.7k-token call, a duplicate answer in the saved record.
      //
      // THE FIX IS A CONSUMPTION POINT AT THE COMPOSE: the turn that is
      // starting consumes the queue the same instant its request composes
      // the instruction, so the signal can never outlive its delivery.
      // The verdict is the provider's own request bodies — the delivery
      // IS the compose — plus the request count:
      //
      //   fixed:   2 requests, the steer text in exactly ONE body;
      //   defect:  3 requests, the steer text in TWO bodies (the
      //            continuation's and the drain turn's).
      const steerChat = db.createChat({ project_id: projectId, title: "the mid-tool steer" }, ownerUserId);
      const STEER_TEXT = "steer: when the reads finish, reply with exactly: ONE APPLE";
      providerRequests = [];
      const held = holdProvider(`read the notes ${TOOL_TURN_MARKER} ${SLOW_MARKER}`);
      let runId = "";
      try {
        const start = await fetch(`${baseUrl}/api/run/start`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            projectId,
            chatId: steerChat.id,
            // Hold the native tool response before its completion and next compose.
            prompt: `read the notes ${TOOL_TURN_MARKER} ${SLOW_MARKER}`,
          }),
        });
        expect(start.status).toBe(201);
        ({ runId } = (await start.json()) as { runId: string });

        await held.ready();
        expect(held.hits(), "the intended native response is held").toBe(1);

        const steered = await fetch(`${baseUrl}/api/run/${runId}/steer`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ prompt: STEER_TEXT }),
        });
        expect(steered.status).toBe(200);
        const steerBody = (await steered.json()) as { queued?: number; steered?: boolean; refusal?: { code?: string } };
        expect(steerBody.steered).toBe(true);
        expect(steerBody.queued).toBe(1);
        expect(steerBody.refusal, "a live tool-turn steer is a delivery, not a refusal").toBeUndefined();

        held.release();
        await runToCompletion(runId);

        const responses = providerRequests.filter((r) => r.path === "/v1/responses");
        // LIVENESS FIRST: the run really performed the tool turn and its
        // continuation.
        expect(responses.length).toBeGreaterThanOrEqual(2);
        // THE VERDICT: exactly two calls — the tool turn and the
        // continuation that carries the steer. The defect's third
        // full-context call (the drain re-answering an already-composed
        // instruction) is what this count exists to name.
        expect(responses.length).toBe(2);
        // …and the instruction itself reached the model exactly once: the
        // continuation's request carries it; no second request does. The
        // defect composed it into TWO request bodies.
        const carrying = responses.filter((r) => r.body.includes(STEER_TEXT));
        expect(carrying).toHaveLength(1);
        expect((JSON.parse(carrying[0]!.body) as { input: NativeInput[] }).input.some((item) => item.type === "function_call_output"),
          "the delivery must be the native tool-loop continuation — the request that follows the tool results").toBe(true);
        // THE ANNOUNCEMENT: exactly one steered frame (the compose-point
        // consumption), never a second beat for one instruction.
        const frames = await drainStream(`/api/run/${runId}/stream`, {}, 1_500);
        const steeredFrames = frames.frames.filter((f) => f.event === "steered");
        expect(steeredFrames).toHaveLength(1);
      } finally {
        held.dispose();
        if (runId !== "") await runToCompletion(runId);
      }
    },
    30_000,
  );

  test(
    "a steer arriving MID-STREAM of a TEXT turn is delivered ONCE by the DRAIN — one turn started for it, its request carries the instruction, the frame stamped \"drain\" (UIE-055's other arrival shape)",
    async () => {
      // THE ARRIVAL SHAPE THAT HAD NO BEHAVIORAL ARM. The mid-tool arm
      // above pins the compose-point consumption: a steer landing while
      // a TOOL turn streams is carried by the continuation the loop was
      // starting anyway. This arm drives the OTHER shape — a steer that
      // lands while a plain TEXT turn streams, after the starting
      // turn's compose stretch (the request on the wire IS that
      // stretch done) and before the stop-reason boundary — where the
      // DRAIN is the only consumer: no further turn is coming, so the
      // loop must start exactly ONE for the instruction. Until now that
      // delivery was pinned only by the client's mock copy of the
      // frame (which copy the frame earns), never by the executor's own
      // behavior.
      //
      // THE REORDER THIS ARM EXISTS TO RED: "consume after stream" — the
      // compose-point consumption moved below the stream, beside the
      // drain — delivers this shape into NOTHING. The queue is consumed
      // after the stop-reason turn finishes, the drain below it never
      // fires (the queue was just cleared), and the run ENDS with the
      // instruction composed into no request at all: a lost steer
      // wearing a delivery frame. The mid-tool arm is blind to that
      // reorder — a tool-call turn always starts a continuation, so the
      // instruction still composes into the follow-up and every count
      // there stays 2/1/1 — which is exactly why the text-turn shape
      // needs its own arm: a stop-reason turn starts a further turn
      // ONLY when the drain says so.
      //
      // A FRESH USER, because the arm's condition — "a plain TEXT turn" —
      // must not depend on ambient state the arm did not put there. The
      // recalled-memories channel rides every request's system prompt and
      // is USER-scoped, and this suite's own earlier arms persist their
      // prompts as short-term memories: by the time a late arm runs, the
      // shared user's request bodies carry the TOOL_TURN marker through
      // no act of this arm's prompt (measured: the "text" turn was
      // answered with the canned read_file call, became a tool turn, and
      // the drain shape never happened). A user with no memories is the
      // honest fixture — the body is the prompt, the schemas, and
      // nothing else — so the stub's plain-text answer, and therefore
      // the drain delivery, is guaranteed by construction rather than by
      // test order.
      const subject = await freshRunSubject("mid-stream-drain-user");
      const { db, baseUrl, user: drainUser } = subject;
      const drainHeaders: Record<string, string> = {
        Cookie: `${drainUser.cookie}; harness_session=run-once-drain`,
        "Content-Type": "application/json",
        "X-Requested-With": "test",
      };
      const drainRoot = createTempDir("ch-run-once-drain-");
      const drainProject = db.createProject({ name: "run-once-drain", path: drainRoot }, drainUser.userId);
      const steerChat = db.createChat({ project_id: drainProject.id, title: "the mid-stream drain steer" }, drainUser.userId);
      const STEER_TEXT = "steer: when this reply lands, reply with exactly: SECOND APPLE";
      providerRequests = [];
      const held = holdProvider(`just answer in text ${SLOW_MARKER}`);
      let runId = "";
      try {
        const start = await fetch(`${baseUrl}/api/run/start`, {
          method: "POST",
          headers: drainHeaders,
          body: JSON.stringify({
            projectId: drainProject.id,
            chatId: steerChat.id,
            // Hold plain text before completion: only the drain can deliver the steer.
            prompt: `just answer in text ${SLOW_MARKER}`,
          }),
        });
        expect(start.status).toBe(201);
        ({ runId } = (await start.json()) as { runId: string });

        await held.ready();
        expect(held.hits(), "the intended native response is held").toBe(1);

        const steered = await fetch(`${baseUrl}/api/run/${runId}/steer`, {
          method: "POST",
          headers: drainHeaders,
          body: JSON.stringify({ prompt: STEER_TEXT }),
        });
        expect(steered.status).toBe(200);
        const steerBody = (await steered.json()) as { queued?: number; steered?: boolean; refusal?: { code?: string } };
        expect(steerBody.steered).toBe(true);
        expect(steerBody.queued).toBe(1);
        expect(steerBody.refusal, "a live mid-stream steer is a delivery, not a refusal").toBeUndefined();

        held.release();
        await runToCompletion(runId);

        const responses = providerRequests.filter((r) => r.path === "/v1/responses");
        // LIVENESS FIRST: the starting text turn really ran.
        expect(responses.length).toBeGreaterThanOrEqual(1);
        // THE DRAIN TURN: exactly two calls — the starting turn and the
        // ONE turn the loop started for the steer. Under the "consume
        // after stream" reorder this is ONE call: the queue consumed into
        // no request and the run ended — the lost steer this count names.
        expect(responses.length).toBe(2);
        // …and the instruction reached the model exactly once, in the
        // drain turn's own request — the request AFTER the starting turn.
        // The starting turn's request composed before the steer existed,
        // so it cannot carry it.
        const carrying = responses.filter((r) => r.body.includes(STEER_TEXT));
        expect(carrying).toHaveLength(1);
        expect(carrying[0]).toBe(responses[1]);
        expect(responses[0]!.body.includes(STEER_TEXT)).toBe(false);
        // THE FRAME: exactly one steered frame, stamped delivery "drain" —
        // the loop started a turn FOR the instruction. The compose-point's
        // "composed" stamp is the wrong shape here by construction: the
        // drain's shift is what emptied the queue, so the drain turn's
        // own compose-point consumed nothing. The stream read carries the
        // run's owner cookie — the run belongs to the fresh user above.
        const frames = await drainStream(`/api/run/${runId}/stream`, { Cookie: drainHeaders["Cookie"]! }, 1_500, baseUrl);
        const steeredFrames = frames.frames.filter((f) => f.event === "steered");
        expect(steeredFrames).toHaveLength(1);
        expect(
          (steeredFrames[0]!.data as { delivery?: string } | undefined)?.delivery,
          "the frame must say which delivery happened — a drain started this turn",
        ).toBe("drain");
      } finally {
        held.dispose();
        try {
          if (runId !== "") await runToCompletion(runId);
        } finally {
          await subject.stop();
        }
      }
    },
    30_000,
  );

  test("a fast failure can settle before a late observer reads the accepted run", async () => {
    const { activeRunForChat } = await import("../../server/run/run-registry.ts");
    const { subscribeToRunFeed } = await import("../../server/run/run-feed.ts");
    const lateChat = db.createChat({ project_id: projectId, title: "settled before observation" }, ownerUserId);
    const started = await startRun(`fast failure ${ERROR_MARKER}`, { projectId, chatId: lateChat.id, headers: authHeaders });
    expect(started.status).toBe(201);
    await runToCompletion(started.runId);
    const late = subscribeToRunFeed(started.runId, 0, () => {}, () => {});
    expect(late, "the late observer attaches to the real retained feed").toBeDefined();
    try {
      expect(late!.replay.ended).toBe(true);
      expect(late!.replay.frames.filter((frame) => frame.event === "error")).toHaveLength(1);
      // Admission does not promise the executor is still active when a later
      // observer arrives. The retained terminal feed is the truthful result.
      expect(activeRunForChat(lateChat.id, ownerUserId)).toBeUndefined();
    } finally {
      late?.unsubscribe();
    }
  }, 30_000);

  test(
    "the executor's crash path clears the entry — a provider that fails mid-run still settles the registry",
    async () => {
      // Hold an active HTTP request, then refuse it 401 (non-retryable).
      // This proves active-call failure, truthful settle and successful
      // reopening; it makes no claim about partially streamed error output.
      const { activeRunForChat } = await import("../../server/run/run-registry.ts");
      const { runFeedState, subscribeToRunFeed } = await import("../../server/run/run-feed.ts");
      const crashChat = db.createChat({ project_id: projectId, title: "the crash window" }, ownerUserId);
      const prompt = `fail this run ${ERROR_MARKER}`;
      const held = holdProvider(prompt);
      const reopenedHold = holdProvider("open after the crash");
      let runId = "";
      let reopenedId = "";
      let unsubscribe = () => {};
      providerRequests = [];
      try {
        const crashed = await startRun(prompt, { projectId, chatId: crashChat.id, headers: authHeaders });
        expect(crashed.status).toBe(201);
        runId = crashed.runId;
        expect(await held.ready()).toEqual({ prompt, followUp: false });
        expect(activeRunForChat(crashChat.id, ownerUserId), "the exact claim remains while its provider is held").toBe(runId);
        const raced = await fetch(`${baseUrl}/api/run/start`, {
          method: "POST", headers: authHeaders,
          body: JSON.stringify({ projectId, chatId: crashChat.id, prompt: "race the held failed request" }),
        });
        expect(raced.status).toBe(200);
        const refusal = await raced.json() as { refusal?: { code?: string; liveRunId?: string }; runId?: string };
        expect(refusal.refusal).toMatchObject({ code: "chat_run_live", liveRunId: runId });
        expect(refusal.runId, "the refused concurrent start launches nothing").toBeUndefined();

        const ended = Promise.withResolvers<void>();
        const frames: RunFrame[] = [];
        const subscription = subscribeToRunFeed(runId, 0, (frame) => frames.push(frame), () => ended.resolve());
        expect(subscription, "attach to the real feed before releasing the provider").toBeDefined();
        unsubscribe = subscription!.unsubscribe;
        frames.push(...subscription!.replay.frames);
        expect(subscription!.replay.ended, "the held provider has not settled the run").toBe(false);
        held.release();
        await witnessed(ended.promise, "the failed request's terminal feed");
        expect(frames.filter((frame) => frame.event === "error")).toHaveLength(1);
        expect(frames.at(-1)).toMatchObject({ event: "error", data: {
          // The web bridge currently flattens ordinary native errors; RC-28
          // owns taxonomy repair. This lifecycle arm pins its actual projection.
          runId, code: "llm_stream_error", message: "Provider authentication failed: the provider refused this run on purpose",
        } });
        expect(frames.filter((frame) => frame.event === "done")).toEqual([]);
        expect(activeRunForChat(crashChat.id, ownerUserId), "the failed run's finally releases its claim").toBeUndefined();
        expect(runFeedState(runId)?.ended).toBe(true);
        expect(held.hits()).toBe(1);
        expect(providerRequests.filter((request) => request.path === "/v1/responses"), "one failed request, no retry").toHaveLength(1);

        const reopened = await startRun("open after the crash", { projectId, chatId: crashChat.id, headers: authHeaders });
        expect(reopened.status).toBe(201);
        reopenedId = reopened.runId;
        expect(reopenedId).not.toBe(runId);
        expect(await reopenedHold.ready()).toEqual({ prompt: "open after the crash", followUp: false });
        expect(activeRunForChat(crashChat.id, ownerUserId)).toBe(reopenedId);
        reopenedHold.release();
        const completed = await runToCompletion(reopenedId);
        expect(completed.filter((frame) => frame.event === "done")).toHaveLength(1);
        expect(completed.filter((frame) => frame.event === "error")).toEqual([]);
        expect(completed.at(-1)).toMatchObject({ event: "done", data: { runId: reopenedId } });
        expect(db.listMessages(crashChat.id, ownerUserId).filter((message) => message.run_id === reopenedId && message.role === "assistant")
          .map((message) => message.content)).toEqual(["Hello from the provider"]);
        expect(reopenedHold.hits()).toBe(1);
        expect(providerRequests.filter((request) => request.path === "/v1/responses")).toHaveLength(2);
        expect(activeRunForChat(crashChat.id, ownerUserId)).toBeUndefined();
      } finally {
        held.dispose();
        reopenedHold.dispose();
        unsubscribe();
        if (runId !== "") await runToCompletion(runId);
        if (reopenedId !== "") await runToCompletion(reopenedId);
      }
    },
    30_000,
  );

  test(
    "a call that fails before its first frame stamps NOTHING onto the previous call's message — the failure is its own record",
    async () => {
      // THE RESTAMP, AS THE CODE ALLOWS IT. `assistantMessageId` is set
      // only by a call's own "start" frame and — before the loop-top
      // clear — nothing ever reset it between calls, so a call whose
      // request dies BEFORE its first model frame (no "start" ever
      // arrives, so no message was ever created for it) left the id
      // naming the PREVIOUS call's message. The error flush resolves its
      // target through that id, so the failed call's finishReason
      // "error" (and the context/trace it accumulated) landed on a turn
      // that had already settled with its own facts — a turn that
      // answered fine, restamped as errored.
      //
      // THE ONLY NO-START SHAPE the stream produces is the client-
      // construction refusal: the stream's head catches a `getClient`
      // throw and yields a typed error event at sequence 0 with no
      // "start" ever (every provider-level failure — 401, network, mid-
      // stream — yields "start" BEFORE the request, so those are mid-call
      // failures whose flush target is their own message). A MID-RUN
      // client-construction refusal cannot be produced through the wire
      // on demand: the per-run credential is frozen and the client cache
      // returns the call-1 client unchanged. So this arm manufactures
      // exactly that refusal at the door's own choke point —
      // `admitMintedCredential`, the consult `clientFor` performs on
      // EVERY construction, once per streamed call — and lets everything
      // downstream (the typed error event, the flush, the DB writes) run
      // real. The manufacturing is self-verifying: if the refusal never
      // lands, call 2 reaches the provider, the request count reads two
      // and the arm REDS — a silent vacuous pass is impossible.
      //
      // A FRESH USER, for the same reason the drain arm needs one: the
      // arm's condition (call 1 must NOT be refused) must not depend on
      // ambient memories this suite's earlier arms persisted for the
      // shared user — a recalled prompt carrying the crash arm's refusal
      // marker would refuse call 1 instead, a different shape entirely.
      const subject = await freshRunSubject("pre-start-failure-user");
      const { db, baseUrl, user: refusalUser } = subject;
      const refusalHeaders: Record<string, string> = {
        Cookie: `${refusalUser.cookie}; harness_session=run-once-pre-start`,
        "Content-Type": "application/json",
        "X-Requested-With": "test",
      };
      const refusalRoot = createTempDir("ch-run-once-pre-start-");
      writeFileSync(join(refusalRoot, TOOL_TURN_FILE), "the pre-start refusal probe file\n");
      const refusalProject = db.createProject({ name: "run-once-pre-start", path: refusalRoot }, refusalUser.userId);
      const refusalChat = db.createChat({ project_id: refusalProject.id, title: "the pre-start failure" }, refusalUser.userId);

      // THE MANUFACTURED REFUSAL: the mint's consult passes the first
      // admission (call 1 runs real, against the real provider) and
      // refuses the second (call 2's client construction) with the door's
      // own typed error — the real class the head's catch exists to
      // surface.
      const providers = await import("../../server/llm/providers.ts");
      const { ForgedProviderCredentialError } = await import("../../server/kernel/errors.ts");
      const realAdmit = providers.admitMintedCredential;
      let admissions = 0;
      const admitSpy = vi
        .spyOn(providers, "admitMintedCredential")
        .mockImplementation((credential: Parameters<typeof realAdmit>[0]) => {
          admissions += 1;
          if (admissions >= 2) throw new ForgedProviderCredentialError();
          return realAdmit(credential);
        });
      try {
        providerRequests = [];
        const start = await fetch(`${baseUrl}/api/run/start`, {
          method: "POST",
          headers: refusalHeaders,
          body: JSON.stringify({
            projectId: refusalProject.id,
            chatId: refusalChat.id,
            // The tool-turn shape: call 1 answers with a read_file call,
            // the executor runs it, and the continuation IS call 2 — the
            // multi-call run the restamp lives in.
            prompt: `read the notes ${TOOL_TURN_MARKER}`,
          }),
        });
        expect(start.status).toBe(201);
        const { runId } = (await start.json()) as { runId: string };
        await runToCompletion(runId);

        const messages = db.listMessages(refusalChat.id, refusalUser.userId);
        const assistantRows = messages.filter((m) => m.run_id === runId && m.role === "assistant");
        const errorRows = messages.filter((m) => m.run_id === runId && m.role === "error");

        // LIVENESS FIRST: call 1 really ran — its request reached the
        // provider, its tool executed, its message exists. And the failure
        // is provably PRE-START: exactly ONE provider request (call 2 died
        // at client construction, before any wire), exactly one assistant
        // row (call 2's "start" never arrived to create one).
        const responses = providerRequests.filter((r) => r.path === "/v1/responses");
        expect(responses.length, "call 2 must die before the wire — one request only").toBe(1);
        expect(assistantRows.length, "call 1's message exists; call 2 never became a turn").toBe(1);
        const toolRows = db.listToolCallsByMessage(
          messages.filter((m) => m.run_id === runId && m.role === "tool")[0]?.id ?? "",
          refusalUser.userId,
        );
        expect(toolRows.length, "call 1's tool really executed").toBe(1);

        // THE GUARD: the previous call's message carries its OWN finish
        // reason and nothing from the failed call. Under the restamp the
        // flush flipped this to "error" and wrote the failed call's
        // context/trace over a settled turn.
        const firstCallMeta = (assistantRows[0]!.metadata ?? {}) as Record<string, unknown>;
        expect(
          firstCallMeta["finishReason"],
          "the settled turn keeps its own finish reason — a call that failed before its first frame restamps it never",
        ).toBe("tool_calls");

        // AND THE FAILURE IS RECORDED WHERE THE DESIGN SAYS — its own
        // records, not a sibling's: the error row (the beat the reader
        // sees, carrying the refusal's own words) and the ledger's error
        // event (persisted as the chat's timeline ref by the epilogue's
        // replay). A restamped previous message would be a THIRD record of
        // the same failure, and a wrong one.
        expect(errorRows.length, "the failed call's error row is the primary record").toBe(1);
        expect(errorRows[0]!.content).toContain("was not minted");
        const errorRefs = db
          .listTimelineRefs(refusalChat.id, refusalUser.userId)
          .filter((r) => r.event_type === "error" && String((r.metadata as Record<string, unknown> | null)?.["runId"] ?? "") === runId);
        expect(errorRefs.length, "the ledger holds the failure as its own error event").toBe(1);
      } finally {
        admitSpy.mockRestore();
        await subject.stop();
      }
    },
    30_000,
  );

  test(
    "a mid-call failure still stamps its OWN message — the kept path",
    async () => {
      // THE OTHER HALF OF THE GUARD, and the one that must keep working
      // exactly: when the failed call DID open its own turn — its "start"
      // arrived, its message exists — the error flush must stamp THAT
      // message with the accumulated facts (finishReason "error" and
      // whatever the call accumulated), because "finish" will never arrive
      // to do it. A guard that refuses too broadly would lose the partial
      // chat exposure the flush exists to preserve.
      //
      // FULLY WIRE-REAL, no manufacturing: the refusal marker rides the
      // FILE the tool-call turn reads, so it enters the conversation as
      // the tool RESULT — call 1's request (the prompt alone) carries no
      // marker and answers with the tool call; call 2's request (history
      // now including the tool result) is refused 401 AFTER its "start"
      // frame created its own message. A fresh user keeps the recalled-
      // memories channel from smuggling any earlier arm's marker into
      // call 1's system prompt.
      const subject = await freshRunSubject("mid-call-failure-user");
      const { db, baseUrl, user: keptUser } = subject;
      const keptHeaders: Record<string, string> = {
        Cookie: `${keptUser.cookie}; harness_session=run-once-mid-call`,
        "Content-Type": "application/json",
        "X-Requested-With": "test",
      };
      const keptRoot = createTempDir("ch-run-once-mid-call-");
      // The marker rides the file's content — the tool result is the only
      // channel through which the refusal reaches call 2 and never call 1.
      writeFileSync(join(keptRoot, TOOL_TURN_FILE), `these notes are refused downstream ${ERROR_MARKER}\n`);
      const keptProject = db.createProject({ name: "run-once-mid-call", path: keptRoot }, keptUser.userId);
      const keptChat = db.createChat({ project_id: keptProject.id, title: "the mid-call failure" }, keptUser.userId);

      try {
        providerRequests = [];
        const start = await fetch(`${baseUrl}/api/run/start`, {
          method: "POST",
          headers: keptHeaders,
          body: JSON.stringify({
            projectId: keptProject.id,
            chatId: keptChat.id,
            prompt: `read the notes ${TOOL_TURN_MARKER}`,
          }),
        });
        expect(start.status).toBe(201);
        const { runId } = (await start.json()) as { runId: string };
        await runToCompletion(runId);

        // LIVENESS: the failure is provably MID-CALL — call 2's request
        // reached the wire (two requests), and call 2's "start" created its
        // own message before the refusal (two assistant rows).
        const responses = providerRequests.filter((r) => r.path === "/v1/responses");
        expect(responses.length, "call 2 reached the provider before failing").toBe(2);

        const messages = db.listMessages(keptChat.id, keptUser.userId);
        const assistantRows = messages.filter((m) => m.run_id === runId && m.role === "assistant");
        const errorRows = messages.filter((m) => m.run_id === runId && m.role === "error");
        expect(assistantRows.length, "both calls opened their own turns").toBe(2);
        expect(errorRows.length, "the failed call's error row exists").toBe(1);

        // THE KEPT PATH: the FAILED call's own message carries the error
        // flush — finishReason "error" on the second assistant row, written
        // by the flush because its "finish" never arrived.
        const firstCallMeta = (assistantRows[0]!.metadata ?? {}) as Record<string, unknown>;
        const secondCallMeta = (assistantRows[1]!.metadata ?? {}) as Record<string, unknown>;
        expect(
          secondCallMeta["finishReason"],
          "the mid-call failure's flush lands on its OWN message — the partial exposure the flush exists to preserve",
        ).toBe("error");
        // …and the settled first turn is untouched by its sibling's failure.
        expect(
          firstCallMeta["finishReason"],
          "the first call's settled turn keeps its own finish reason",
        ).toBe("tool_calls");
      } finally {
        await subject.stop();
      }
    },
    30_000,
  );
});

// ── Test 2 — structural, over the import graph ─────────────────────────────

/**
 * Every module transitively reachable from `entry` by a VALUE import.
 *
 * ── WHY VALUE EDGES, STATED, BECAUSE THE CHOICE IS THE MEASUREMENT ────────
 *
 * The question is what this module can EXECUTE, and a type-only edge cannot
 * execute anything: `import type` is erased by the compiler and emits nothing.
 * Following it answers a different question — "what does the type-checker
 * read" — and answers it in the direction that manufactures findings. Driven
 * here: `run-registry.ts` names two types from `context-bridge.ts`, which
 * names one type from `llm-bridge.ts`, so a walk over every specifier reports
 * the subscriber "reaching the LLM bridge" through two erased hops and a
 * `ChatMessage` interface. That is a false positive, and a guard that
 * manufactures its own finding is worse than no guard.
 *
 * The exclusion is self-defending rather than a hole: if anyone later drops
 * the `type` modifier, the edge becomes a value edge, enters the cone, and
 * this guard REDS. There is no way to reach the LLM bridge at runtime that
 * this walk does not see.
 *
 * Specifiers resolve against the IMPORTING file's directory, not the
 * process's working directory — assuming otherwise has already produced a
 * wrong finding in this project.
 */
function importCone(entry: string): { modules: Set<string>; valueEdges: number } {
  const seen = new Set<string>();
  const queue = [resolve(REPO_ROOT, entry)];
  let valueEdges = 0;
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    // Statement-level scan: a statement beginning `import type` / `export
    // type` is erased in full. Within a value import, a `type`-marked
    // specifier is erased individually, but the statement still emits, so the
    // module edge is real unless EVERY name is type-marked — which
    // TypeScript's own `verbatimModuleSyntax` would then flag. Treating the
    // statement as the unit is therefore the conservative reading: it can
    // over-include, never under-include, and over-including is the safe
    // direction for a guard about what may execute.
    const statements = [
      ...src.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm),
    ];
    for (const match of statements) {
      const isTypeOnly = match[1] !== undefined;
      const spec = match[2]!;
      if (isTypeOnly || !spec.startsWith(".")) continue;
      valueEdges += 1;
      queue.push(resolve(dirname(file), spec));
    }
    // Dynamic `import("…")` is a value edge by construction — there is no
    // type-only form of it — so it counts.
    for (const match of src.matchAll(/\bimport\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      valueEdges += 1;
      queue.push(resolve(dirname(file), match[1]!));
    }
  }
  return { modules: seen, valueEdges };
}

describe("the subscriber cannot reach the executor — by shape", () => {
  const SUBSCRIBER = modulePathMatching("server/routes/run-stream.ts");
  const EXECUTOR = modulePath("run-executor.ts");

  test("the import walk is live", () => {
    const originalSplit = String.prototype.split;
    let lineSplits = 0;
    let result: ReturnType<typeof importCone>;
    try {
      String.prototype.split = new Proxy(originalSplit, {
        apply(target, receiver, args) {
          if (args[0] === "\n") lineSplits += 1;
          return Reflect.apply(target, receiver, args);
        },
      });
      result = importCone(SUBSCRIBER);
    } finally { String.prototype.split = originalSplit; }
    const { modules, valueEdges } = result;
    // A walker that finds nothing must RED, not pass — the population is
    // stated as a runtime number rather than assumed to be non-empty.
    expect(modules.size).toBeGreaterThan(1);
    expect(valueEdges).toBeGreaterThan(5);
    const names = [...modules];
    expect(names.some((f) => f.endsWith("/run-feed.ts"))).toBe(true);
    expect(names.some((f) => f.endsWith("/run-registry.ts"))).toBe(true);
    expect(names.some((f) => f.endsWith("/sse.ts"))).toBe(true);
    expect(lineSplits, "the import walk consumes statements without discarded line arrays").toBe(0);
  });

  test("the subscriber's cone contains neither the LLM bridge nor the tool executor", () => {
    const cone = [...importCone(SUBSCRIBER).modules];
    const forbidden = ["llm-bridge.ts", "tool-executor.ts", "run-executor.ts"];
    for (const name of forbidden) {
      const reached = cone.filter((f) => f.endsWith(`/${name}`));
      expect(reached, `${SUBSCRIBER} must not reach ${name}, but reached: ${reached.join(", ")}`).toEqual([]);
    }
  });

  test("the executor's cone DOES contain them — the walk can tell the two apart", () => {
    // THE CONTROL, and it is not optional. Without it a walker that reaches
    // nothing at all passes the test above while proving nothing — the
    // vacuous green this project keeps rediscovering.
    const { modules, valueEdges } = importCone(EXECUTOR);
    expect(valueEdges).toBeGreaterThan(5);
    const cone = [...modules];
    expect(cone.some((f) => f.endsWith("/llm-bridge.ts"))).toBe(true);
    expect(cone.some((f) => f.endsWith("/tool-executor.ts"))).toBe(true);
  });

  test("the run's route modules split by verb — and no GET module reaches an executor", () => {
    // THE UNIVERSE IS THE CENSUS OWNER'S, not a hand list: every module the
    // run path owns under server/routes joins this rule the day it lands
    // (runPathModules() itself throws on a route module the census does not
    // name), so a new run route cannot arrive outside the discipline.
    //
    // THE RULE, stated once for the whole family: a run route module is
    // either CONTROL (POST-only — it MAY reach the executor) or READ
    // (GET-only — its import cone must not). A mixed module is the shape
    // that made "a GET cannot execute a run" a hope rather than a fact: one
    // GET handler in the module that imports startRunExecution is one
    // ordinary edit away from executing a run on a read. This generalized
    // the two per-module assertions the arm used to carry (run.ts no-GET,
    // run-stream GET-only) into the family rule that admits the run's
    // status read.
    const routeModules = runPathModules().filter((rel) => rel.startsWith("server/routes/"));
    expect(routeModules.length, "the family must actually be discovered").toBeGreaterThanOrEqual(2);
    let controlModules = 0;
    let readModules = 0;
    for (const rel of routeModules) {
      const src = readRunPathModule(rel);
      const verbs = [...src.matchAll(/router\.(get|post|put|patch|delete)\(/g)].map((m) => m[1]!);
      expect(verbs.length, `${rel} registers at least one route`).toBeGreaterThan(0);
      const gets = verbs.filter((v) => v === "get");
      if (gets.length === 0) {
        // CONTROL: POST-only. The run's control surface has only ever been
        // POSTs; holding the line keeps the family legible at a glance.
        expect(
          verbs.filter((v) => v !== "post"),
          `${rel} is a control module: POST only`,
        ).toEqual([]);
        controlModules += 1;
      } else {
        // READ: GET-only, and the cone must not reach anything that
        // executes a run or spends money on a provider.
        expect(gets, `${rel} is a read module: GET only`).toEqual(verbs);
        const cone = [...importCone(modulePathMatching(rel)).modules];
        for (const forbidden of ["run-executor.ts", "llm-bridge.ts", "tool-executor.ts"]) {
          const reached = cone.filter((f) => f.endsWith(`/${forbidden}`));
          expect(reached, `${rel} is a GET module and must not reach ${forbidden}`).toEqual([]);
        }
        readModules += 1;
      }
    }
    // BOTH HALVES must exist — a family that is all one kind cannot be
    // "split", and the split is the guarantee.
    expect(controlModules, "at least one control module").toBeGreaterThan(0);
    expect(readModules, "at least one read module").toBeGreaterThan(0);
  });

  test("the executor demands a warrant, and a forged one is refused", async () => {
    const { startRunExecution } = await import("../../server/run/run-executor.ts");
    const { AsyncDbClient } = await import("../../server/db/async-client.ts");
    const { ForbiddenError } = await import("../../server/kernel/errors.ts");
    const adb = AsyncDbClient.inline(db);
    // The type is the primary gate; this is what remains true after a cast.
    let refusal: unknown = null;
    try {
      await startRunExecution({} as never, "run-forged", "nobody", adb);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(ForbiddenError);
    expect((refusal as { code: string }).code).toBe("mutation_warrant_required");
    // …and the refusal happened BEFORE the claim: no row was written.
    const raw = db as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } };
    const claimed = raw.db
      .prepare("SELECT COUNT(*) n FROM run_executions WHERE run_id = ?")
      .get("run-forged") as { n: number };
    expect(claimed.n).toBe(0);
  });

  test("a steer is ONE act — the queue entry and the conversation turn are indivisible (UIE-055's root)", () => {
    // THE PAIRING THAT MADE THE DOUBLE DELIVERY POSSIBLE. The old steer
    // route performed the delivery's two halves itself, separated by an
    // awaited row write: push the queue signal, await, add the manager
    // turn. Between those halves the executor could run — drain the
    // signal while the words were not yet in the conversation (a lost
    // steer), or compose the words while the signal still stood queued
    // (the measured double delivery). The fix moved the pairing into
    // `queueSteer`, whose body performs both mutations in ONE synchronous
    // stretch, manager turn FIRST — so at every instant the executor can
    // observe, a queue entry is already in the conversation, and the
    // executor's compose-point consumption can rely on exactly that.
    //
    // This is the structural half: the behavioral arm above drives the
    // delivery itself; this one pins the shape that makes the delivery's
    // invariant provable, because the interleave it forbids is too rare
    // to reproduce on demand.
    const registry = readRunPathModule("server/run/run-registry.ts");
    const fnAt = registry.indexOf("export function queueSteer(");
    expect(fnAt, "queueSteer is missing — the steer route would be back to two separate mutations").toBeGreaterThan(-1);
    const fnClose = registry.indexOf("\n}\n", fnAt);
    expect(fnClose).toBeGreaterThan(-1);
    const body = registry.slice(fnAt, fnClose);
    const addTurnAt = body.indexOf("contextManager.addTurn(");
    const pushAt = body.indexOf("steeringQueue.push(");
    expect(addTurnAt, "queueSteer must add the conversation turn").toBeGreaterThan(-1);
    expect(pushAt, "queueSteer must take the queue signal").toBeGreaterThan(addTurnAt);
    expect(
      /\bawait\b/.test(body.slice(addTurnAt, pushAt)),
      "an await between the conversation turn and the queue signal reopens the window where the executor observes one half without the other",
    ).toBe(false);
    // …and the route performs NEITHER mutation itself anymore — a route
    // that reaches around the owner reintroduces the two-act delivery the
    // owner exists to make impossible.
    const route = readRunPathModule("server/routes/run.ts");
    expect(route.includes("queueSteer("), "the steer route must deliver through queueSteer").toBe(true);
    const steerAt = route.indexOf('"/api/run/:runId/steer"');
    const steerClose = route.indexOf("\n  }));", steerAt);
    const steerBody = steerAt > -1 && steerClose > steerAt ? route.slice(steerAt, steerClose) : "";
    expect(
      steerBody.includes("contextManager.addTurn(") || steerBody.includes("steeringQueue.push("),
      "the steer route mutates the delivery state directly — both halves belong to queueSteer alone",
    ).toBe(false);
  });
});
