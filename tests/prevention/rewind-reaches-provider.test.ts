// @vitest-environment node
/**
 * RETRY AND EDIT & RESEND ARE A REWIND, AND THE PROOF IS THE REQUEST ITSELF.
 *
 * The user, verbatim: *"retry, edit & resend are creating new entries, instead
 * of modifying/rerunning the target one. this also includes context I am
 * pretty sure."*
 *
 * The second sentence is the serious one, and it is not something to reason
 * about. If a retry appends, the conversation holds BOTH the abandoned attempt
 * and its replacement, so the model is handed its own rejected output as
 * accepted history — precisely the input most likely to make it repeat the
 * mistake the user retried to escape. And every later turn re-sends both, so
 * one retry permanently doubles that turn's contribution to context and cost.
 * An edit-and-resend is worse in kind: the ORIGINAL wording stays in context,
 * so the correction the user just made is invisible to the model — and they
 * edited it *because* the original was wrong.
 *
 * So this file does not inspect the store, count rows, or read the ledger to
 * decide whether the context is right. It builds the REAL provider request
 * through the REAL run route and reads the `messages` array handed to
 * `client.stream()`. Shape copied from
 * `tests/prevention/model-selection-reaches-provider.test.ts`: nothing between
 * the gesture and the provider call is mocked, and the only stub is the
 * provider itself, which is the thing being measured.
 *
 *   the verb's action     (`POST /api/b/run.compose/rewind` — the same block
 *                          action `src/cockpit/flow/rewind.ts` calls)
 *        ↓  real ledger append, real fold
 *   the run route         (`POST /api/run/start`, real `buildConversationHistory`
 *                          with the real rewind honoring point)
 *        ↓
 *   the LLM bridge        (real `streamChat`, real `buildTrimmedHistory`)
 *        ↓  client.stream(MESSAGES, …)
 *   THE PROVIDER CALL     ← measured here
 *
 * THE "BEFORE" IS MEASURED, NOT DESCRIBED. The first test performs the append
 * the product used to perform (re-send the same prompt with no rewind) and
 * asserts the doubled, poisoned request in full. It is the defect, exhibited.
 * Every later test performs the rewind and asserts the request that replaces
 * it. A regression in the honoring point makes the second set look like the
 * first, which is a diff a reader can act on.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

// ── The provider seam ───────────────────────────────────────────────────────
// `vi.hoisted` so the recorder exists before the mock factory runs.
const provider = vi.hoisted(() => ({
  /** Every `messages` array handed to a provider stream call, in order. */
  requests: [] as Array<Array<{ role: string; content: string }>>,
  /** What the stubbed model says. Set per-test so a turn is identifiable. */
  reply: "an answer",
}));

vi.mock("../../engine/src/shared/llm/client.ts", () => {
  class SharedLLMClient {
    constructor(_config: unknown) {}
    async *stream(
      redacted: unknown,
      _options: Readonly<{ model?: string }> = {},
    ): AsyncGenerator<Readonly<Record<string, unknown>>, void, unknown> {
      // THE MEASUREMENT POINT. The bridge passes a Responses request whose
      // conversation is in `input`, as a list of typed items. Capture only the
      // message items, whole (role + content) rather than summarised, so a
      // test can assert both what IS there and what is NOT.
      const request = redacted as {
        input?: Array<{ type?: string; role?: string; content?: string }>;
      };
      provider.requests.push(
        (request.input ?? [])
          .filter((item) => item.type === "message")
          .map((item) => ({ role: item.role ?? "", content: item.content ?? "" })),
      );
      yield { type: "content", text: provider.reply };
      yield { type: "finish", reason: "stop", truncated: false };
    }
  }
  return { SharedLLMClient };
});

import { createTempDir } from "../helpers/temp-dir.ts";

// Every case here drives several REAL runs through the REAL router, and the
// default bucket is 60 requests/minute per session — the whole file shares one
// session, so the limiter starts refusing partway through and a test would
// "fail" on a 429 that has nothing to do with rewinding. Raised, not disabled:
// the limiter still runs.
process.env.HARNESS_WEB_RATE_LIMIT = "10000";
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
// The subscriber is its own module since the executor was split out of the
// GET handler. Driving a run to the provider needs both halves mounted.
import { registerRunStreamRoutes } from "../../server/routes/run-stream.ts";
import { clearBlocks, mountBlockRoutes } from "../../server/blocks/define.ts";
import { defineComposeBlocks } from "../../server/blocks/compose.ts";
import { getTimelineQuery } from "../../server/observability/timeline-bridge.ts";
import {
  discardedMessageIdsForChat,
  discardedRunIdsForChat,
  recordRestore,
  withdrawnStretchById,
} from "../../server/run/rewind.ts";
import { serverConfig } from "../../server/kernel/config.ts";
import { APPEND_ONLY_TRIGGERS } from "../../engine/src/timeline/timeline-schema.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { read } from "../helpers/source-scan.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
let tmpRoot = "";
let server: Server;
let baseUrl = "";
let db: DbClient;
let authCookie = "";
let ownerUserId = "";

/** A literal NUL. Declared once, by escape, so no test body carries a
 * control character a text tool could hide. */
const NUL = "\u0000";

const SESSION_COOKIE = "harness_session=test-rewind-session";

type Json = Record<string, unknown>;

async function api(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  cookie = authCookie,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: `${cookie}; ${SESSION_COOKIE}`,
      "X-Requested-With": "test",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

/**
 * Drive the run to completion by opening its SSE stream (the run does not call
 * the provider until a stream is attached) and reading until it closes.
 */
async function drainRunStream(runId: string, timeoutMs = 10000): Promise<string> {
  const res = await fetch(`${baseUrl}/api/run/${runId}/stream`, {
    headers: { Cookie: `${authCookie}; ${SESSION_COOKIE}` },
  });
  if (!res.ok || res.body === null) {
    const detail = res.body === null ? "<no body>" : (await res.text()).slice(0, 400);
    throw new Error(`stream failed: ${res.status} url=/api/run/${runId}/stream body=${detail}`);
  }
  const reader = res.body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, timeoutMs);
  let buffer = "";
  try {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: done")) {
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  expect(timedOut, `run ${runId} stream timed out after ${timeoutMs}ms; received ${buffer}`).toBe(false);
  return buffer;
}

async function newConversation(name: string): Promise<{ projectId: string; chatId: string }> {
  const p = await api("POST", "/api/projects", { name, path: `/${name}` });
  const projectId = (p.body as { id: string }).id;
  const c = await api("POST", "/api/chats", { projectId, title: name });
  const chatId = (c.body as { id: string }).id;
  return { projectId, chatId };
}

/**
 * Send one turn exactly as the cockpit does and return the conversation the
 * provider was shown for it.
 */
async function sendTurn(
  ids: { projectId: string; chatId: string },
  prompt: string,
  reply: string,
): Promise<Array<{ role: string; content: string }>> {
  provider.reply = reply;
  const before = provider.requests.length;
  const start = await api("POST", "/api/run/start", {
    projectId: ids.projectId,
    prompt,
    chatId: ids.chatId,
  });
  expect(start.status).toBe(201);
  const runId = (start.body as { runId: string }).runId;
  const frames = await drainRunStream(runId);
  expect(provider.requests.length, `run ${runId} accepted for ${ids.chatId} without a provider request; stream: ${frames}`).toBeGreaterThan(before);
  return provider.requests[provider.requests.length - 1]!;
}

/** Everything the conversation currently holds, as the API serves it. */
async function storedMessages(
  chatId: string,
): Promise<Array<{ id: string; role: string; content: string; discarded?: boolean }>> {
  const res = await api("GET", `/api/chats/${chatId}/messages`);
  expect(res.status).toBe(200);
  return res.body as Array<{ id: string; role: string; content: string; discarded?: boolean }>;
}

/** Invoke the ONE rewind door — the same block action the cockpit calls. */
async function rewind(
  chatId: string,
  toMessageId: string,
  mode: "at" | "causing-prompt",
  cookie = authCookie,
): Promise<{ status: number; data: Json }> {
  const res = await api("POST", "/api/b/run.compose/rewind", { chatId, toMessageId, mode }, cookie);
  const data = (res.body as { data?: Json } | undefined)?.data ?? {};
  return { status: res.status, data };
}

/**
 * The CONVERSATION the model was shown — the request minus its system message.
 *
 * The system prompt is asserted separately (`systemOf`) rather than folded in
 * here, because it is a different question with a different owner: it carries
 * the project preamble, the tool manifest and the RECALLED MEMORIES, none of
 * which are conversation turns. Mixing them would make every expectation in
 * this file a diff against a several-thousand-character blob, and the thing
 * being measured — which turns reach the model, and how many times — would
 * stop being legible.
 */
const pairs = (req: Array<{ role: string; content: string }>): string[] =>
  req.filter((m) => m.role !== "system").map((m) => `${m.role}: ${m.content}`);

/** The one system message of a request. Exactly one is expected: two would
 * mean the history build duplicated it, which is its own defect. */
function systemOf(req: Array<{ role: string; content: string }>): string {
  const systems = req.filter((m) => m.role === "system");
  expect(systems).toHaveLength(1);
  return systems[0]!.content;
}

beforeAll(async () => {
  tmpRoot = createTempDir("ch-rewind-");
  db = new DbClient({ path: join(tmpRoot, "rewind.db") });
  const user = createTestUser(db, "rewind-tester");
  authCookie = user.cookie;
  ownerUserId = user.userId;

  const adb = AsyncDbClient.inline(db);
  const router = createRouter({ db: adb, isPublicPath });
  registerProjectRoutes(router, adb);
  registerChatRoutes(router, adb);
  registerRunRoutes(router, adb);
  registerRunStreamRoutes(router, adb);
  // The rewind door is a BLOCK ACTION, mounted the way the server mounts it.
  clearBlocks();
  defineComposeBlocks(adb);
  mountBlockRoutes(router);

  server = createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((r) => server.close(() => r()));
  if (db !== undefined) db.close();
});

// ───────────────────────────────────────────────────────────────────────────

describe("the defect, exhibited: re-sending without a rewind", () => {
  test("an append hands the model its own rejected answer AND two copies of the prompt", async () => {
    const ids = await newConversation("append-shows-the-bug");

    const first = await sendTurn(ids, "name three fruits", "cars, boats, planes");
    expect(pairs(first)).toEqual(["user: name three fruits"]);

    // THIS IS WHAT `retry` USED TO DO: start a run with the same prompt and
    // nothing else. No rewind, so the run route rebuilds history from every
    // persisted message and appends the prompt again.
    const second = await sendTurn(ids, "name three fruits", "apples, pears, plums");

    // The measured damage, spelled out rather than summarised:
    expect(pairs(second)).toEqual([
      "user: name three fruits",
      // ── the rejected answer, presented to the model as accepted history ──
      "assistant: cars, boats, planes",
      // ── and the prompt a second time ──
      "user: name three fruits",
    ]);
    // Stated as its own sentence so a regression reads as the user's report.
    expect(second.filter((m) => m.content === "name three fruits")).toHaveLength(2);
    expect(second.some((m) => m.content === "cars, boats, planes")).toBe(true);
  }, 20000);
});

describe("retry: rewind to the causing prompt, then re-run", () => {
  test("the provider sees the prompt ONCE and never the abandoned answer", async () => {
    const ids = await newConversation("retry-is-a-rewind");

    await sendTurn(ids, "name three fruits", "cars, boats, planes");
    const stored = await storedMessages(ids.chatId);
    const modelTurn = stored.find((m) => m.role === "assistant")!;
    expect(modelTurn.content).toBe("cars, boats, planes");

    // THE VERB. `retry` names the MODEL TURN it is standing on; the server
    // walks back to the prompt that caused it.
    const { status, data } = await rewind(ids.chatId, modelTurn.id, "causing-prompt");
    expect(status).toBe(200);
    expect(data.promptForRerun).toBe("name three fruits");
    expect(data.discarded).toBe(2);

    const retried = await sendTurn(ids, data.promptForRerun as string, "apples, pears, plums");

    // EXACTLY ONE instance of that turn, and not the abandoned one.
    expect(pairs(retried)).toEqual(["user: name three fruits"]);
    expect(retried.filter((m) => m.content === "name three fruits")).toHaveLength(1);
    expect(retried.some((m) => m.content === "cars, boats, planes")).toBe(false);
  }, 20000);

  test("the doubling does not survive into later turns — the whole point of the context half", async () => {
    const ids = await newConversation("retry-then-continue");

    await sendTurn(ids, "step one", "WRONG");
    const stored = await storedMessages(ids.chatId);
    const modelTurn = stored.find((m) => m.role === "assistant")!;
    const { data } = await rewind(ids.chatId, modelTurn.id, "causing-prompt");
    await sendTurn(ids, data.promptForRerun as string, "RIGHT");

    // A third, ordinary turn. Every later request re-sends the whole history,
    // so this is where an append's cost compounds forever.
    const third = await sendTurn(ids, "step two", "ok");
    expect(pairs(third)).toEqual([
      "user: step one",
      "assistant: RIGHT",
      "user: step two",
    ]);
    expect(third.some((m) => m.content === "WRONG")).toBe(false);
  }, 30000);

  test("a rewind does not swallow the turns that replace it", async () => {
    // A rewind recorded as a PREDICATE ("everything at or after message M")
    // would fold over the re-run's own messages, since they also sit after M
    // — the rewind would eat its own replacement, and every turn after it.
    // The event records the MEASURED set instead, so this holds.
    const ids = await newConversation("rewind-keeps-its-replacement");

    await sendTurn(ids, "alpha", "bad alpha");
    const modelTurn = (await storedMessages(ids.chatId)).find((m) => m.role === "assistant")!;
    const { data } = await rewind(ids.chatId, modelTurn.id, "causing-prompt");
    await sendTurn(ids, data.promptForRerun as string, "good alpha");
    await sendTurn(ids, "beta", "beta answer");

    const fourth = await sendTurn(ids, "gamma", "gamma answer");
    expect(pairs(fourth)).toEqual([
      "user: alpha",
      "assistant: good alpha",
      "user: beta",
      "assistant: beta answer",
      "user: gamma",
    ]);
  }, 40000);
});

describe("edit & resend: the correction is what the model sees", () => {
  test("the provider gets the edited text and NOT the original wording", async () => {
    const ids = await newConversation("edit-and-resend");

    await sendTurn(ids, "delete the databse", "I could not find `databse`.");
    const stored = await storedMessages(ids.chatId);
    const yourTurn = stored.find((m) => m.role === "user")!;
    expect(yourTurn.content).toBe("delete the databse");

    // THE VERB. `edit & resend` names YOUR OWN message; `at` — the message
    // being replaced is the first thing withdrawn.
    const { status, data } = await rewind(ids.chatId, yourTurn.id, "at");
    expect(status).toBe(200);
    // Both halves of the exchange go, not just the reply.
    expect(data.discarded).toBe(2);

    const resent = await sendTurn(ids, "delete the database", "done");

    expect(pairs(resent)).toEqual(["user: delete the database"]);
    // The typo the user just corrected is the thing that must be gone. It was
    // the reason they edited.
    expect(resent.some((m) => m.content.includes("databse"))).toBe(false);
    expect(resent.some((m) => m.content.includes("I could not find"))).toBe(false);
  }, 20000);
});

describe("rewind here: the same door, without the re-run", () => {
  test("the withdrawn stretch stops reaching the model", async () => {
    const ids = await newConversation("rewind-here");

    await sendTurn(ids, "keep this", "kept");
    await sendTurn(ids, "forget this", "forgotten");
    const stored = await storedMessages(ids.chatId);
    const forgetTurn = stored.find((m) => m.content === "forget this")!;

    const { status, data } = await rewind(ids.chatId, forgetTurn.id, "at");
    expect(status).toBe(200);
    expect(data.discarded).toBe(2);

    const next = await sendTurn(ids, "what did I say", "you said: keep this");
    expect(pairs(next)).toEqual([
      "user: keep this",
      "assistant: kept",
      "user: what did I say",
    ]);
  }, 30000);
});

describe("the withdrawn answer must not come back through the memory channel", () => {
  /**
   * THE SECOND DOOR, found while measuring the first.
   *
   * The conversation history is not the only way a turn reaches the model. A
   * completed run stores `User: …\nAssistant: …` as a short-term memory
   * (`run.ts` → `storeInteraction`), and memories are recalled into the SYSTEM
   * PROMPT of later turns. So filtering the history alone left the abandoned
   * answer arriving anyway — verbatim, on a second path, in the one part of
   * the request nobody was looking at.
   *
   * The words below are deliberately unusual: the memory store is shared
   * across this file, and retrieval scores by token overlap, so a generic
   * phrase would be recalled by unrelated cases and this test would pass or
   * fail for the wrong reason.
   */
  test("a retried turn's rejected answer is not recalled into the system prompt", async () => {
    const ids = await newConversation("memory-channel");
    const PROMPT = "describe the zorblatt manifold";
    const REJECTED = "the zorblatt manifold is a species of flightless waterfowl";

    await sendTurn(ids, PROMPT, REJECTED);

    // Proof the channel is LIVE for this text — without it, a later "not
    // present" assertion could pass simply because retrieval never fires,
    // and the guard would prove nothing. This is the mutation check built
    // into the test.
    const withoutRewind = await sendTurn(ids, PROMPT, "second attempt");
    expect(systemOf(withoutRewind)).toContain(REJECTED);

    // Now do it properly: rewind both attempts away and re-run.
    const stored = await storedMessages(ids.chatId);
    const firstUser = stored[0]!;
    const { data } = await rewind(ids.chatId, firstUser.id, "at");
    expect((data.discardedRunIds as string[]).length).toBe(2);

    const retried = await sendTurn(ids, PROMPT, "a correct answer");
    expect(pairs(retried)).toEqual([`user: ${PROMPT}`]);
    // The rejected answer is gone from the SYSTEM PROMPT too, which is where
    // it was still arriving.
    expect(systemOf(retried)).not.toContain(REJECTED);
  }, 30000);

  test("a memory from a run that still has live turns is NOT withdrawn", async () => {
    // The mirror. Withdrawing every memory that shares a chat would pass the
    // test above and quietly delete the conversation's whole recall.
    const ids = await newConversation("memory-survives");
    const KEEP = "the quiznak protocol runs on tuesdays";

    await sendTurn(ids, "explain the quiznak protocol", KEEP);
    await sendTurn(ids, "and the frobnitz protocol", "the frobnitz protocol is unrelated");

    const stored = await storedMessages(ids.chatId);
    // Withdraw only the SECOND exchange.
    const secondUser = stored.filter((m) => m.role === "user")[1]!;
    await rewind(ids.chatId, secondUser.id, "at");

    const next = await sendTurn(ids, "remind me about the quiznak protocol", "sure");
    // The first run is untouched, so its memory is still true of this
    // conversation and still recalled.
    expect(systemOf(next)).toContain(KEEP);
  }, 30000);
});

describe("a rewind is a recorded event, not an erasure", () => {
  test("the ledger holds the rewind, naming the anchor and every id withdrawn", async () => {
    const ids = await newConversation("rewind-is-recorded");
    await sendTurn(ids, "recorded prompt", "recorded answer");
    const stored = await storedMessages(ids.chatId);
    const modelTurn = stored.find((m) => m.role === "assistant")!;
    const userTurn = stored.find((m) => m.role === "user")!;

    const { data } = await rewind(ids.chatId, modelTurn.id, "causing-prompt");

    // Read back through the REAL query port, from the real ledger the suite
    // points at a per-worker temp file.
    const events = getTimelineQuery().byEventType("rollback", { limit: 500 }).events;
    const mine = events.filter((e) => e.description.includes(ids.chatId));
    expect(mine.length).toBe(1);
    const doc = mine[0]!.documents.find((d) => d.name === "rewind");
    expect(doc).toBeDefined();
    const payload = JSON.parse(doc!.contentJson!) as {
      chatId: string;
      anchorMessageId: string;
      discardedMessageIds: string[];
      mode: string;
    };
    expect(payload.chatId).toBe(ids.chatId);
    // The anchor is the USER turn, not the model turn the verb named — the
    // resolution the server performed is itself part of the record.
    expect(payload.anchorMessageId).toBe(userTurn.id);
    expect(payload.discardedMessageIds).toEqual([userTurn.id, modelTurn.id]);
    expect(payload.mode).toBe("causing-prompt");
    expect(mine[0]!.outcome).toBe("succeeded");
    expect(data.eventId).toBe(mine[0]!.eventId);
  }, 20000);

  test("a withdrawn turn is NOT silently gone from the record", async () => {
    const ids = await newConversation("withdrawn-not-erased");
    await sendTurn(ids, "the withdrawn words", "the withdrawn reply");
    const before = await storedMessages(ids.chatId);
    const modelTurn = before.find((m) => m.role === "assistant")!;

    await rewind(ids.chatId, modelTurn.id, "causing-prompt");

    const after = await storedMessages(ids.chatId);
    // Same rows, same content — plus the withdrawal's own record-fact, the
    // one row a rewind APPENDS (UIE-039). Nothing that existed before was
    // deleted.
    const beforeIds = before.map((m) => m.id);
    for (const id of beforeIds) {
      expect(after.find((m) => m.id === id), `row ${id} was deleted by the rewind`).toBeDefined();
    }
    expect(after.find((m) => m.id === modelTurn.id)!.content).toBe("the withdrawn reply");
    // And every one of them SAYS it was withdrawn — a reader who cannot tell
    // "taken back" from "never happened" has been shown a hole. The one row
    // NOT flagged is the rewind's own event row: a fact about the record,
    // never a turn, so it is not withdrawn by anything.
    for (const row of before) {
      expect(after.find((m) => m.id === row.id)!.discarded).toBe(true);
    }
    const factRow = after.find((m) => m.role === "event");
    expect(factRow, "the rewind appends its own record-fact row").toBeDefined();
    expect(factRow!.discarded).toBeUndefined();
    expect(factRow!.content).toContain("2 messages taken back from here");
  }, 20000);

  test("a live turn is not marked withdrawn — the flag means something", async () => {
    // The mirror of the test above. Without this, a mapper that marked EVERY
    // message discarded would pass the one above and be catastrophically
    // wrong.
    const ids = await newConversation("live-turns-are-not-flagged");
    await sendTurn(ids, "still here", "still here too");
    const rows = await storedMessages(ids.chatId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((m) => m.discarded === true)).toBe(false);
  }, 20000);
});

describe("the rewind point may sit in a page that was never loaded", () => {
  test("retry resolves the causing prompt over the WHOLE conversation, not the loaded page", async () => {
    const ids = await newConversation("rewind-across-pages");
    await sendTurn(ids, "older prompt", "older answer");
    await sendTurn(ids, "newer prompt", "newer answer");

    // The conversation opens at its TAIL with a cursor (commit daf44ee). Ask
    // for the narrowest page there is: one message.
    const tail = await api("GET", `/api/chats/${ids.chatId}/history?limit=1`);
    expect(tail.status).toBe(200);
    const page = tail.body as { messages: Array<{ id: string; content: string }>; page: { hasOlder: boolean } };
    expect(page.page.hasOlder).toBe(true);
    expect(page.messages).toHaveLength(1);
    const loadedTurn = page.messages[0]!;
    expect(loadedTurn.content).toBe("newer answer");
    // THE SETUP THAT MAKES THIS A REAL TEST: the prompt that caused the only
    // loaded turn is NOT in the loaded page. The old client-side lookup
    // (`Flow.svelte::userPromptBefore`, an in-memory beat scan) returned null
    // here and the verb rendered "none is recorded before this turn" — a
    // sentence about the record that was false about the record.
    expect(page.messages.some((m) => m.content === "newer prompt")).toBe(false);

    const { status, data } = await rewind(ids.chatId, loadedTurn.id, "causing-prompt");
    expect(status).toBe(200);
    expect(data.promptForRerun).toBe("newer prompt");

    const retried = await sendTurn(ids, data.promptForRerun as string, "better answer");
    expect(pairs(retried)).toEqual([
      "user: older prompt",
      "assistant: older answer",
      "user: newer prompt",
    ]);
  }, 30000);

  test("an older page carries the same withdrawal marks the tail does", async () => {
    const ids = await newConversation("older-page-marks");
    await sendTurn(ids, "page-a prompt", "page-a answer");
    await sendTurn(ids, "page-b prompt", "page-b answer");
    const stored = await storedMessages(ids.chatId);
    const first = stored[0]!;

    // Withdraw the whole conversation from its first message.
    const { data } = await rewind(ids.chatId, first.id, "at");
    expect(data.discarded).toBe(4);

    const tail = await api("GET", `/api/chats/${ids.chatId}/history?limit=1`);
    const cursor = (tail.body as { page: { olderCursor: string | null } }).page.olderCursor;
    expect(cursor).not.toBeNull();
    const older = await api(
      "GET",
      `/api/chats/${ids.chatId}/history/older?before=${encodeURIComponent(cursor!)}`,
    );
    expect(older.status).toBe(200);
    const olderRows = (older.body as { messages: Array<{ discarded?: boolean }> }).messages;
    expect(olderRows.length).toBeGreaterThan(0);
    // The fold is over the CONVERSATION, not over the page. A reader scrolling
    // back into a rewound stretch must see it as rewound.
    expect(olderRows.every((m) => m.discarded === true)).toBe(true);
  }, 30000);
});

describe("the door refuses what it cannot address", () => {
  test("a message this chat does not hold is refused, not rounded to the nearest one", async () => {
    const ids = await newConversation("unknown-anchor");
    await sendTurn(ids, "only turn", "only answer");
    const res = await rewind(ids.chatId, "msg-that-does-not-exist", "at");
    expect(res.status).toBe(404);
  }, 20000);

  test("the fold is scoped to the acting user, not just the conversation", async () => {
    // THE LEDGER IS ONE FILE shared by every conversation on this server, and
    // the fold is a scan over it. The chat id alone is the outer lock; this
    // asserts the inner one, at the level it lives at, because the block
    // action's ownership check makes it unreachable from the wire — and an
    // untestable lock is one nobody notices being removed. (It was: this case
    // exists because a mutation that dropped the user comparison survived the
    // whole suite.)
    const ids = await newConversation("fold-user-scope");
    await sendTurn(ids, "scoped prompt", "scoped answer");
    const modelTurn = (await storedMessages(ids.chatId)).find((m) => m.role === "assistant")!;
    await rewind(ids.chatId, modelTurn.id, "causing-prompt");

    const owner = ownerUserId;
    const outsider = createTestUser(db, `fold-outsider-${Date.now()}`);
    expect(discardedMessageIdsForChat(ids.chatId, owner).size).toBe(2);
    expect(discardedRunIdsForChat(ids.chatId, owner).size).toBe(1);
    // Same conversation id, different reader: nothing is withdrawn for them.
    expect(discardedMessageIdsForChat(ids.chatId, outsider.userId).size).toBe(0);
    expect(discardedRunIdsForChat(ids.chatId, outsider.userId).size).toBe(0);
  }, 20000);

  test("another user cannot rewind this conversation", async () => {
    const ids = await newConversation("rewind-scoping");
    await sendTurn(ids, "mine", "mine too");
    const modelTurn = (await storedMessages(ids.chatId)).find((m) => m.role === "assistant")!;

    const outsider = createTestUser(db, "rewind-outsider");
    const res = await rewind(ids.chatId, modelTurn.id, "causing-prompt", outsider.cookie);
    expect(res.status).toBe(404);

    // And the conversation is untouched — a refused rewind withdrew nothing.
    const after = await storedMessages(ids.chatId);
    expect(after.some((m) => m.discarded === true)).toBe(false);
  }, 20000);
});

// ───────────────────────────────────────────────────────────────────────────
// HOSTILE USE — the cases nobody types on purpose
//
// Everything above asks whether the verb WORKS. This half asks what it does
// when it is misused, raced, aimed at somebody else's conversation, or handed
// something that is not a message id at all. A door that only behaves for its
// intended input is a door with a second, undescribed behaviour.
// ───────────────────────────────────────────────────────────────────────────

describe("hostile: the extremes of the conversation", () => {
  test("rewinding to the FIRST message withdraws everything and leaves an empty request", async () => {
    const ids = await newConversation("hostile-first");
    await sendTurn(ids, "alpha one", "alpha answer");
    await sendTurn(ids, "beta two", "beta answer");

    const first = (await storedMessages(ids.chatId))[0]!;
    const res = await rewind(ids.chatId, first.id, "at");
    expect(res.status).toBe(200);
    expect((res.data.discardedMessageIds as string[]).length).toBe(4);

    // The next request carries ONLY the new prompt. An off-by-one at the
    // anchor would leave the very first turn in — the one place "the anchor
    // is inclusive" is easiest to get wrong and hardest to notice.
    const next = await sendTurn(ids, "starting over", "fine");
    expect(pairs(next)).toEqual(["user: starting over"]);
  }, 30000);

  test("rewinding to the LAST message withdraws exactly that one", async () => {
    const ids = await newConversation("hostile-last");
    await sendTurn(ids, "gamma one", "gamma answer");
    const rows = await storedMessages(ids.chatId);
    const last = rows[rows.length - 1]!;

    const res = await rewind(ids.chatId, last.id, "at");
    expect(res.status).toBe(200);
    expect(res.data.discardedMessageIds).toEqual([last.id]);
    // The prompt that caused it is still live, because `at` means AT. The
    // one other live row is the withdrawal's OWN record-fact (a role
    // "event" row the rewind appends — UIE-039), which is the record's
    // voice about what just happened, not a turn: it stays live through
    // any rewind and never reaches the model.
    const after = await storedMessages(ids.chatId);
    expect(after.filter((m) => m.discarded !== true && m.role !== "event").map((m) => m.content))
      .toEqual(["gamma one"]);
    expect(
      after.filter((m) => m.discarded !== true && m.role === "event").map((m) => m.content).join(""),
    ).toContain("1 messages taken back from here");
  }, 30000);

  test("a conversation holding nothing is refused, not answered with an empty rewind", async () => {
    // There is no anchor to name, so every id is unknown. The failure mode
    // this rules out is a door that returns `{ discarded: 0 }` and a 200 — a
    // success report for an operation that did not happen.
    const ids = await newConversation("hostile-empty");
    const res = await rewind(ids.chatId, "any-id-at-all", "at");
    expect(res.status).toBe(404);
  }, 20000);
});

describe("hostile: aiming a rewind somewhere it does not belong", () => {
  test("an anchor from ANOTHER conversation is refused, and neither conversation moves", async () => {
    // The cross-conversation leak. Both chats belong to the SAME user, so the
    // ownership check passes and only the chat scoping can refuse this —
    // which is exactly why it needs its own case.
    const victim = await newConversation("hostile-victim");
    const attacker = await newConversation("hostile-attacker");
    await sendTurn(victim, "victim prompt", "victim answer");
    await sendTurn(attacker, "attacker prompt", "attacker answer");

    const victimRows = await storedMessages(victim.chatId);
    const res = await rewind(attacker.chatId, victimRows[0]!.id, "at");
    expect(res.status).toBe(404);

    expect((await storedMessages(victim.chatId)).some((m) => m.discarded === true)).toBe(false);
    expect((await storedMessages(attacker.chatId)).some((m) => m.discarded === true)).toBe(false);
  }, 30000);
});

describe("hostile: the same rewind, twice and at once", () => {
  test("rewinding twice to the same anchor withdraws nothing the second time", async () => {
    // Idempotence is not decoration here: the event records a MEASURED set,
    // and a second event re-listing the same ids would double every count a
    // reader is shown about what was withdrawn.
    const ids = await newConversation("hostile-twice");
    await sendTurn(ids, "delta one", "delta answer");
    const anchor = (await storedMessages(ids.chatId))[0]!;

    const first = await rewind(ids.chatId, anchor.id, "at");
    expect((first.data.discardedMessageIds as string[]).length).toBe(2);
    const second = await rewind(ids.chatId, anchor.id, "at");
    expect(second.status).toBe(200);
    expect(second.data.discardedMessageIds).toEqual([]);
    expect(second.data.discarded).toBe(0);

    // …and the fold is not double-counted.
    expect(discardedMessageIdsForChat(ids.chatId, ownerUserId).size).toBe(2);
  }, 30000);

  test("two rewinds issued at once do not name the same turn between them", async () => {
    const ids = await newConversation("hostile-concurrent");
    await sendTurn(ids, "epsilon one", "epsilon answer");
    await sendTurn(ids, "epsilon two", "epsilon answer two");
    const rows = await storedMessages(ids.chatId);

    const [a, b] = await Promise.all([
      rewind(ids.chatId, rows[0]!.id, "at"),
      rewind(ids.chatId, rows[2]!.id, "at"),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // Whatever order they landed in, the UNION is every row and no row is
    // named twice — a ledger that could say a turn was withdrawn twice is one
    // whose counts do not add up for anybody reading them back.
    const named = [
      ...(a.data.discardedMessageIds as string[]),
      ...(b.data.discardedMessageIds as string[]),
    ];
    expect(new Set(named).size, "a turn was named by both rewinds").toBe(named.length);
    expect(new Set(named)).toEqual(new Set(rows.map((r) => r.id)));
    expect(discardedMessageIdsForChat(ids.chatId, ownerUserId).size).toBe(4);
  }, 30000);
});

describe("hostile: a rewind issued while the run is still streaming", () => {
  test("the rewind lands, and the turn the run is producing is not left half-withdrawn", async () => {
    // The reader can press `rewind here` at any moment, including while the
    // model is mid-answer. The failure this rules out is a torn conversation:
    // a rewind whose measured set is taken before the run appends its
    // assistant row leaves that row OUTSIDE the withdrawal, so the abandoned
    // answer survives as accepted history with nothing marking it.
    const ids = await newConversation("hostile-mid-stream");
    await sendTurn(ids, "zeta first", "zeta first answer");
    const anchor = (await storedMessages(ids.chatId))[0]!;

    provider.reply = "an answer nobody waited for";
    const start = await api("POST", "/api/run/start", {
      projectId: ids.projectId,
      prompt: "zeta second",
      chatId: ids.chatId,
    });
    expect(start.status).toBe(201);

    // Do NOT await the drain: the rewind is issued into a live run.
    const draining = drainRunStream((start.body as { runId: string }).runId);
    const res = await rewind(ids.chatId, anchor.id, "at");
    await draining;

    expect(res.status).toBe(200);

    // Whatever the interleaving was, the invariant is the same: every row the
    // conversation now holds is either withdrawn or live, and the rows the
    // model is next shown are exactly the live ones. Nothing may be BOTH
    // present in the request and marked withdrawn.
    const rows = await storedMessages(ids.chatId);
    const live = rows.filter((m) => m.discarded !== true && m.role !== "event").map((m) => m.content);
    const withdrawn = rows.filter((m) => m.discarded === true).map((m) => m.content);
    expect(withdrawn, "the rewind withdrew nothing at all").not.toHaveLength(0);

    const next = await sendTurn(ids, "zeta third", "zeta third answer");
    const shown = pairs(next);
    for (const gone of withdrawn) {
      expect(shown.join("\n"), `a withdrawn turn reached the model: ${gone}`).not.toContain(gone);
    }
    // The record's own voice never reaches the model either: the rewind's
    // event row is a fact about the conversation, not a turn of it.
    expect(shown.join("\n"), "a record-fact row reached the model").not.toContain("taken back");
    // …and the surviving TURNS are the ones that DID reach it, so this is
    // not passing by sending nothing. (Event rows are excluded on both
    // sides of the count: they are live in the record and absent from the
    // request, which is exactly their contract.)
    expect(shown.length).toBe(live.length + 1);
  }, 30000);
});

describe("hostile: what the door accepts as input", () => {
  test("every malformed shape is REFUSED with a 4xx — never a 500, never a silent 200", async () => {
    const ids = await newConversation("hostile-input");
    await sendTurn(ids, "input prompt", "input answer");
    const anchor = (await storedMessages(ids.chatId))[0]!;

    // Derived from the valid body's OWN fields rather than listed by hand: for
    // each field, drop it and corrupt it. A field added to the action tomorrow
    // is covered without anyone remembering to add a case for it.
    const valid: Record<string, unknown> = {
      chatId: ids.chatId,
      toMessageId: anchor.id,
      mode: "at",
    };
    const corruptions: readonly unknown[] = [null, 42, true, [], {}, ""];
    const cases: Array<{ what: string; body: unknown }> = [
      { what: "null body", body: null },
      { what: "a bare string", body: "rewind please" },
      { what: "an array", body: [] },
      { what: "an empty object", body: {} },
      { what: "an unknown extra field", body: { ...valid, sudo: true } },
      { what: "a mode nobody declared", body: { ...valid, mode: "obliterate" } },
    ];
    for (const field of Object.keys(valid)) {
      const missing = { ...valid };
      delete missing[field];
      cases.push({ what: `missing ${field}`, body: missing });
      for (const bad of corruptions) {
        cases.push({ what: `${field} = ${JSON.stringify(bad)}`, body: { ...valid, [field]: bad } });
      }
    }

    for (const c of cases) {
      const res = await api("POST", "/api/b/run.compose/rewind", c.body);
      expect(
        res.status,
        `${c.what} was not refused (${String(res.status)}: ${JSON.stringify(res.body)})`,
      ).toBeGreaterThanOrEqual(400);
      expect(res.status, `${c.what} became a server error rather than a refusal`).toBeLessThan(500);
    }

    // …and none of them withdrew anything.
    expect((await storedMessages(ids.chatId)).some((m) => m.discarded === true)).toBe(false);
  }, 60000);

  test("an enormous, astral or NUL-bearing id is refused AS AN ID, not truncated into a real one", async () => {
    // NUL bytes have twice hidden content from text tooling in this codebase,
    // so the question is not only "is it refused" but "is it refused for being
    // an unknown id": a truncation at the NUL would make `<real-id>\0junk`
    // address the real message, and the door would obey an id nobody sent.
    const ids = await newConversation("hostile-strings");
    await sendTurn(ids, "strings prompt", "strings answer");
    const anchor = (await storedMessages(ids.chatId))[0]!;

    const hostile: readonly string[] = [
      "x".repeat(100_000),
      "\u{1D518}\u{1D52B}\u{1D526}\u{1D520}\u{1D52C}\u{1D521}\u{1D522}-\u{1F70F}\u{1F70F}",
      " ",
      `${anchor.id}\u0000trailing`,
      `\u0000${anchor.id}`,
      `${anchor.id} `,
      "../../etc/passwd",
      "%00",
      "\r\nGET /admin",
      "' OR '1'='1",
    ];
    for (const id of hostile) {
      const res = await api("POST", "/api/b/run.compose/rewind", {
        chatId: ids.chatId,
        toMessageId: id,
        mode: "at",
      });
      const label = JSON.stringify(id.slice(0, 48));
      expect(res.status, `id ${label} was accepted`).toBeGreaterThanOrEqual(400);
      expect(res.status, `id ${label} crashed the door`).toBeLessThan(500);
    }
    // The real message is still live: no truncated id addressed it.
    expect((await storedMessages(ids.chatId)).some((m) => m.discarded === true)).toBe(false);
  }, 60000);
});

describe("hostile: the rewind lands MID-RUN", () => {
  test("withdrawing a model turn withdraws the memory that carries its words", async () => {
    // `rewind here` anchors on whatever beat the reader is standing on, and
    // that can be the MODEL's turn — which withdraws the answer while the
    // prompt that caused it stays live. The run is then only PARTLY withdrawn.
    //
    // The stored memory for a run is `User: …\nAssistant: …`, so the withdrawn
    // answer is inside it verbatim. A partly-withdrawn run that keeps its
    // memory therefore hands the rejected answer to the SYSTEM PROMPT of every
    // later turn — the second door, reopened for the one mode that reaches it.
    const ids = await newConversation("hostile-mid-run");
    const REJECTED = "the plimbex coefficient is measured in furlongs per candela";
    await sendTurn(ids, "what is the plimbex coefficient", REJECTED);

    const modelTurn = (await storedMessages(ids.chatId)).find((m) => m.role === "assistant")!;
    expect(modelTurn.content).toContain("plimbex");
    const res = await rewind(ids.chatId, modelTurn.id, "at");
    expect(res.status).toBe(200);

    const next = await sendTurn(ids, "what is the plimbex coefficient", "a better answer");
    expect(
      pairs(next).join("\n"),
      "the withdrawn answer came back as conversation",
    ).not.toContain(REJECTED);
    expect(
      systemOf(next),
      "the withdrawn answer came back through the memory channel",
    ).not.toContain(REJECTED);
  }, 30000);
});

describe("hostile: the ledger will not be edited", () => {
  test("a recorded rewind survives every write the storage layer declares forbidden", async () => {
    // The whole design rests on this: a rewind is safe to RECORD rather than
    // perform destructively only because the record cannot be quietly revised
    // afterwards. Asserted against the storage layer itself, on the row a real
    // rewind actually wrote, and driven off the trigger registry so a table
    // protected tomorrow is covered without this test being edited.
    const ids = await newConversation("hostile-append-only");
    await sendTurn(ids, "ledger prompt", "ledger answer");
    const anchor = (await storedMessages(ids.chatId))[0]!;
    await rewind(ids.chatId, anchor.id, "at");

    const recorded = getTimelineQuery()
      .byEventType("rollback", { limit: 500 })
      .events.find((e) => e.description.includes(ids.chatId));
    expect(recorded, "the rewind was not recorded at all").toBeDefined();

    const { DatabaseSync } = await import("node:sqlite");
    const ledger = new DatabaseSync(serverConfig.timelineDbPath);
    try {
      // The rewind's own rows must exist, or every refusal below would be a
      // refusal to touch nothing.
      const eventRows = ledger
        .prepare(`SELECT COUNT(*) AS n FROM event_log WHERE event_id = ?`)
        .get(recorded!.eventId) as { n: number };
      expect(eventRows.n, "the rewind event is not in the ledger file").toBe(1);

      expect(APPEND_ONLY_TRIGGERS.length, "no append-only triggers are declared").toBeGreaterThan(0);

      const installed = new Set(
        (
          ledger
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
            .all() as unknown as ReadonlyArray<{ name: string }>
        ).map((r) => r.name),
      );
      const rowsIn = (table: string): number =>
        (ledger.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

      let exercised = 0;
      for (const trigger of APPEND_ONLY_TRIGGERS) {
        // Declared is not installed. A trigger that never reached the file is
        // the failure this whole design would be silently missing.
        expect(
          installed.has(trigger.name),
          `${trigger.name} is declared but not installed on the ledger`,
        ).toBe(true);

        // A BEFORE trigger on an empty table never fires, so attempting the
        // write there would prove nothing and REPORT a pass. Only tables that
        // actually hold rows count as evidence.
        if (rowsIn(trigger.table) === 0) continue;
        exercised += 1;

        const sql =
          trigger.operation === "DELETE"
            ? `DELETE FROM ${trigger.table}`
            : `UPDATE ${trigger.table} SET rowid = rowid`;
        let caught: unknown = null;
        try {
          ledger.exec(sql);
        } catch (err) {
          caught = err;
        }
        expect(
          caught,
          `${trigger.table} accepted a ${trigger.operation} — the ledger is editable`,
        ).not.toBeNull();
        expect(
          String((caught as Error).message),
          `${trigger.table} refused the ${trigger.operation} for the wrong reason`,
        ).toContain("append-only");
      }
      // The rewind's own event and its document are both in there, so at
      // least those four (log/documents × update/delete) must have been real
      // attempts against real rows.
      expect(rowsIn("event_log"), "the ledger holds no events at all").toBeGreaterThan(0);
      expect(rowsIn("event_documents"), "the ledger holds no documents at all").toBeGreaterThan(0);
      expect(exercised, "no forbidden write was attempted against real rows").toBeGreaterThanOrEqual(4);
    } finally {
      ledger.close();
    }

    // The rewind still stands after every attempt.
    expect(discardedMessageIdsForChat(ids.chatId, ownerUserId).size).toBe(2);
  }, 30000);
});

describe("undoing the undo: a withdrawal can be brought back", () => {
  /** The recorded withdrawals of a chat, as the block serves them. */
  async function withdrawn(chatId: string, cookie = authCookie): Promise<{
    status: number;
    stretches: Array<{ eventId: string; messageIds: string[]; restored: boolean; anchorMessageId: string }>;
  }> {
    // A READ is a GET with query params — the shape `mountBlockRoutes`
    // declares for every block read.
    const res = await api("GET", `/api/b/run.withdrawn?chatId=${encodeURIComponent(chatId)}`, undefined, cookie);
    const data = (res.body as { data?: { stretches?: unknown } } | undefined)?.data;
    return { status: res.status, stretches: (data?.stretches ?? []) as never };
  }

  async function restore(
    chatId: string,
    eventId: string,
    cookie = authCookie,
  ): Promise<{ status: number; body: unknown }> {
    return await api("POST", "/api/b/run.compose/restore", { chatId, eventId }, cookie);
  }

  test("what was taken back is INSPECTABLE — the ledger reaches a surface", async () => {
    // The rows were never deleted and the event named them, and none of that
    // is worth anything while no read can reach it. This is that read.
    const ids = await newConversation("restore-inspectable");
    await sendTurn(ids, "iota one", "iota answer");
    const rows = await storedMessages(ids.chatId);

    expect((await withdrawn(ids.chatId)).stretches, "nothing is withdrawn yet").toEqual([]);

    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");
    const listed = await withdrawn(ids.chatId);
    expect(listed.status).toBe(200);
    expect(listed.stretches).toHaveLength(1);
    const stretch = listed.stretches[0]!;
    expect(stretch.eventId).toBe(data.eventId);
    expect(stretch.anchorMessageId).toBe(rows[0]!.id);
    expect(stretch.messageIds).toEqual(data.discardedMessageIds);
    expect(stretch.restored).toBe(false);
  }, 30000);

  test("restoring puts the turns back into what the model is shown", async () => {
    const ids = await newConversation("restore-reaches-provider");
    await sendTurn(ids, "kappa one", "kappa answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");

    // Withdrawn: the model no longer sees the stretch.
    const during = await sendTurn(ids, "kappa two", "kappa two answer");
    expect(pairs(during).join("\n")).not.toContain("kappa one");

    const res = await restore(ids.chatId, data.eventId as string);
    expect(res.status).toBe(200);
    expect((res.body as { data: { restored: number } }).data.restored).toBe(
      (data.discardedMessageIds as string[]).length,
    );

    // Brought back: the same turns reach the provider again.
    const after = await sendTurn(ids, "kappa three", "kappa three answer");
    expect(pairs(after).join("\n")).toContain("kappa one");
    expect(pairs(after).join("\n")).toContain("kappa answer");
    // …and the transcript stops flagging them.
    const restoredRows = await storedMessages(ids.chatId);
    for (const id of data.discardedMessageIds as string[]) {
      expect(restoredRows.find((m) => m.id === id)?.discarded).toBeUndefined();
    }
  }, 40000);

  test("the withdrawal STAYS in the record after it is undone", async () => {
    // A restore is an append, not an erasure — the same rule the rewind
    // itself obeys. The stretch is still listed; it is listed as restored.
    const ids = await newConversation("restore-keeps-the-record");
    await sendTurn(ids, "lambda one", "lambda answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");
    await restore(ids.chatId, data.eventId as string);

    const listed = await withdrawn(ids.chatId);
    expect(listed.stretches).toHaveLength(1);
    expect(listed.stretches[0]!.restored).toBe(true);
    expect(listed.stretches[0]!.eventId).toBe(data.eventId);
  }, 30000);

  test("the withdrawal and its undo each PERSIST a row in the transcript — the pair survives a reload (UIE-039)", async () => {
    // The record's two halves, as the conversation surface reads them. The
    // rewind's row says the stretch was taken back and names the door; the
    // restore's row says it was brought back. Without them a reloaded
    // reader finds withdrawn turns gone from the flow (they do not replay)
    // with NOTHING saying they were ever there or ever came back — the
    // same hole the withdrawal itself was filed for, one undo later.
    const ids = await newConversation("restore-pair-persists");
    await sendTurn(ids, "omicron one", "omicron answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");

    const takenBack = await storedMessages(ids.chatId);
    type Row = { id: string; role: string; content: string; metadata?: { eventKind?: string; timelineEventId?: string } };
    const rewindRow = (takenBack as Row[]).find(
      (m) => m.role === "event" && m.content.includes("taken back from here"),
    );
    expect(rewindRow, "the withdrawal must persist its own row in the transcript").toBeDefined();
    expect(rewindRow!.content).toContain("2 messages taken back");
    expect(rewindRow!.content).toContain("restore from here brings them back");
    // The row IS the recorded withdrawal: its ledger address is the very
    // eventId the `restore from here` verb passes back through the door.
    expect(rewindRow!.metadata?.eventKind).toBe("rewind");
    expect(rewindRow!.metadata?.timelineEventId).toBe(data.eventId);

    const res = await restore(ids.chatId, data.eventId as string);
    const restoredEventId = (res.body as { data: { eventId: string } }).data.eventId;

    const broughtBack = await storedMessages(ids.chatId);
    const restoreRow = (broughtBack as Row[]).find(
      (m) => m.role === "event" && m.content.includes("brought back"),
    );
    expect(restoreRow, "the undo must persist its own row too — the pair reads honestly").toBeDefined();
    expect(restoreRow!.content).toContain("the withdrawal stays in the record");
    expect(restoreRow!.metadata?.eventKind).toBe("restore");
    expect(restoreRow!.metadata?.timelineEventId).toBe(restoredEventId);
    // Both halves stand: the rewind's row was not edited or erased by the
    // undo — the record keeps BOTH facts, in order.
    expect(broughtBack.find((m) => m.id === rewindRow!.id)?.content).toContain("taken back");
  }, 30000);

  test("a run's MEMORY comes back too — not half an undo", async () => {
    // The rewind withdrew the run so its stored interaction stopped being
    // recalled into the system prompt. A restore that returned the turns and
    // left the run withdrawn would leave the memory permanently unrecallable
    // with nothing saying so.
    const ids = await newConversation("restore-brings-back-memory");
    await sendTurn(ids, "mu one", "mu answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");
    expect(discardedRunIdsForChat(ids.chatId, ownerUserId).size).toBeGreaterThan(0);

    await restore(ids.chatId, data.eventId as string);
    expect(
      discardedRunIdsForChat(ids.chatId, ownerUserId).size,
      "the run is still withdrawn from memory recall after the restore",
    ).toBe(0);
  }, 30000);

  test("withdraw, bring back, withdraw again — the last act is the one that stands", async () => {
    // The sequence a subtract-the-restores fold gets wrong: it ends with the
    // stretch LIVE, quietly undoing the last thing the reader did.
    const ids = await newConversation("restore-then-rewind-again");
    await sendTurn(ids, "nu one", "nu answer");
    const rows = await storedMessages(ids.chatId);

    const first = await rewind(ids.chatId, rows[0]!.id, "at");
    await restore(ids.chatId, first.data.eventId as string);
    const second = await rewind(ids.chatId, rows[0]!.id, "at");
    expect(second.status).toBe(200);
    expect((second.data.discardedMessageIds as string[]).length).toBe(
      (first.data.discardedMessageIds as string[]).length,
    );

    expect(
      discardedMessageIdsForChat(ids.chatId, ownerUserId).size,
      "the second withdrawal did not stand",
    ).toBe((first.data.discardedMessageIds as string[]).length);
    const next = await sendTurn(ids, "nu two", "nu two answer");
    expect(pairs(next).join("\n")).not.toContain("nu one");
  }, 40000);

  test("sequential regions nest — both region rows stand, and restoring the EARLIER leaves the LATER untouched", async () => {
    // THE NESTING CONTRACT (rewind.ts's fold, compose.ts's restore door).
    // Two rewinds in sequence produce two coexisting regions whose SPANS
    // nest: the later one is anchored at-or-before the earlier one, and
    // every rewind runs "from here to the end". The measured ID SETS stay
    // disjoint — planRewind skips ids an earlier rewind already withdrew —
    // so a restore of the earlier region must bring back exactly its own
    // ids and leave the later region exactly as it stood. A fold that
    // treated the spans as one, or a restore that no-oped because "a later
    // withdrawal covers this range", would strand turns the record says
    // are live. No arm pinned any of this: every existing restore arm holds
    // exactly ONE region.
    const ids = await newConversation("restore-nested-regions");
    await sendTurn(ids, "alpha prompt", "alpha answer");
    await sendTurn(ids, "beta prompt", "beta answer");
    const rows = await storedMessages(ids.chatId);
    expect(rows.filter((m) => m.role !== "event")).toHaveLength(4);

    // Region 1 — the EARLIER withdrawal: the second exchange, to the end.
    const first = await rewind(ids.chatId, rows[2]!.id, "at");
    expect(first.status).toBe(200);
    expect(first.data.discardedMessageIds).toEqual([rows[2]!.id, rows[3]!.id]);

    // Region 2 — the LATER withdrawal, anchored EARLIER: its span runs
    // from the first turn to the end and so COVERS region 1's span, while
    // the measured set names only what was still live.
    const second = await rewind(ids.chatId, rows[0]!.id, "at");
    expect(second.status).toBe(200);
    expect(second.data.discardedMessageIds).toEqual([rows[0]!.id, rows[1]!.id]);

    // BOTH region rows are visible in the row set, and both STAND through
    // it — the record's event rows are immune to any rewind's fold, so the
    // second withdrawal did not take the first region's row with it.
    type EventRow = { id: string; role: string; content: string; discarded?: boolean; metadata?: { eventKind?: string; timelineEventId?: string } };
    const afterTwo = (await storedMessages(ids.chatId)) as EventRow[];
    const regionRows = afterTwo.filter((m) => m.role === "event");
    expect(regionRows).toHaveLength(2);
    expect(
      regionRows.every((m) => m.discarded === undefined),
      "a rewind must never withdraw the record's own voice",
    ).toBe(true);
    expect(
      new Set(regionRows.map((m) => m.metadata?.timelineEventId)),
      "each region row must be its own recorded withdrawal",
    ).toEqual(new Set([first.data.eventId as string, second.data.eventId as string]));
    // Both stretches are listed; neither is restored.
    const listedTwo = await withdrawn(ids.chatId);
    expect(listedTwo.stretches).toHaveLength(2);
    expect(listedTwo.stretches.every((s) => !s.restored)).toBe(true);
    expect(discardedMessageIdsForChat(ids.chatId, ownerUserId).size).toBe(4);

    // RESTORE THE EARLIER region while the later stands.
    const res = await restore(ids.chatId, first.data.eventId as string);
    expect(res.status).toBe(200);
    expect((res.body as { data: { restoredMessageIds: string[] } }).data.restoredMessageIds)
      .toEqual([rows[2]!.id, rows[3]!.id]);

    // EXACTLY the earlier region's ids returned; the later's stay
    // withdrawn — decided PER EVENT, never by span.
    expect([...discardedMessageIdsForChat(ids.chatId, ownerUserId)]).toEqual([rows[0]!.id, rows[1]!.id]);
    const listedAfter = await withdrawn(ids.chatId);
    expect(listedAfter.stretches.find((s) => s.eventId === first.data.eventId)?.restored).toBe(true);
    expect(listedAfter.stretches.find((s) => s.eventId === second.data.eventId)?.restored).toBe(false);

    // The model's request is the same statement at the wire: the restored
    // turns reach it, the later region's do not.
    const next = await sendTurn(ids, "gamma prompt", "gamma answer");
    expect(pairs(next).join("\n")).toContain("beta prompt");
    expect(pairs(next).join("\n")).toContain("beta answer");
    expect(pairs(next).join("\n")).not.toContain("alpha prompt");
    expect(pairs(next).join("\n")).not.toContain("alpha answer");

    // THE LATER REGION'S ROW STAYS — and the restore's own pair row joined
    // it: the record holds both withdrawals and the reversal, in order.
    const afterRestore = (await storedMessages(ids.chatId)) as EventRow[];
    const laterRow = afterRestore.find(
      (m) => m.role === "event" && m.metadata?.timelineEventId === second.data.eventId,
    );
    expect(laterRow, "the later region's row must stand through the earlier's restore").toBeDefined();
    expect(laterRow!.discarded).toBeUndefined();
    expect(laterRow!.content).toContain("2 messages taken back");
    const restoreRow = afterRestore.find((m) => m.role === "event" && m.metadata?.eventKind === "restore");
    expect(restoreRow, "the restore appends its own pair row").toBeDefined();
    expect(restoreRow!.content).toContain("2 messages brought back");
  }, 40000);

  test("hostile: restoring the same withdrawal twice is refused, not counted twice", async () => {
    const ids = await newConversation("restore-twice");
    await sendTurn(ids, "xi one", "xi answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");

    expect((await restore(ids.chatId, data.eventId as string)).status).toBe(200);
    const again = await restore(ids.chatId, data.eventId as string);
    expect(again.status).toBe(404);
    expect((again.body as { error: string }).error).toBe("not_found");
    expect((again.body as { message: string }).message).toContain("already been brought back");
    // One reversal in the record, not two.
    expect((await withdrawn(ids.chatId)).stretches.filter((s) => s.restored)).toHaveLength(1);
  }, 30000);

  test("hostile: an event id this chat never recorded is refused", async () => {
    const ids = await newConversation("restore-unknown-event");
    await sendTurn(ids, "omicron one", "omicron answer");
    const res = await restore(ids.chatId, "evt-nobody-recorded");
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe("not_found");
  }, 30000);

  test("hostile: a withdrawal recorded in ANOTHER conversation cannot be restored here", async () => {
    const mine = await newConversation("restore-cross-chat-a");
    const other = await newConversation("restore-cross-chat-b");
    await sendTurn(mine, "pi one", "pi answer");
    await sendTurn(other, "rho one", "rho answer");
    const otherRows = await storedMessages(other.chatId);
    const { data } = await rewind(other.chatId, otherRows[0]!.id, "at");

    // The other conversation's withdrawal, aimed at this one.
    const res = await restore(mine.chatId, data.eventId as string);
    expect(res.status).toBe(404);
    // …and it did NOT leak into this chat's list, nor come undone in its own.
    expect((await withdrawn(mine.chatId)).stretches).toEqual([]);
    expect((await withdrawn(other.chatId)).stretches[0]!.restored).toBe(false);
  }, 40000);

  test("hostile: another user can neither see nor restore this conversation's withdrawals", async () => {
    const ids = await newConversation("restore-cross-user");
    await sendTurn(ids, "sigma one", "sigma answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");

    const stranger = createTestUser(db, `restore-stranger-${Date.now()}`);
    // The read is refused at the chat gate — the stranger does not own it.
    expect((await withdrawn(ids.chatId, stranger.cookie)).status).toBe(404);
    const res = await restore(ids.chatId, data.eventId as string, stranger.cookie);
    expect(res.status).toBe(404);
    // The withdrawal stands, untouched.
    expect((await withdrawn(ids.chatId)).stretches[0]!.restored).toBe(false);
    expect(discardedMessageIdsForChat(ids.chatId, ownerUserId).size).toBe(
      (data.discardedMessageIds as string[]).length,
    );
  }, 40000);

  test("hostile: the restore door refuses malformed input with a 4xx, never a 500", async () => {
    const ids = await newConversation("restore-malformed");
    const bad: unknown[] = [
      {},
      { chatId: ids.chatId },
      { chatId: ids.chatId, eventId: null },
      { chatId: ids.chatId, eventId: 7 },
      { chatId: ids.chatId, eventId: "" },
      { chatId: ids.chatId, eventId: "x".repeat(5000) },
      { chatId: ids.chatId, eventId: `evt-${NUL}-cut-here` },
      { chatId: ids.chatId, eventId: "evt-\u{1F4A9}\u{10FFFF}" },
      { chatId: ids.chatId, eventId: "evt-1", extra: "not in the schema" },
      { chatId: null, eventId: "evt-1" },
    ];
    for (const body of bad) {
      const res = await api("POST", "/api/b/run.compose/restore", body);
      const shown = JSON.stringify(body).slice(0, 60);
      expect(res.status, `${shown} must be refused`).toBeGreaterThanOrEqual(400);
      expect(res.status, `${shown} produced a server error`).toBeLessThan(500);
    }
  }, 30000);

  test("hostile: a NUL-bearing event id is refused AS AN ID, not truncated into a real one", async () => {
    // NUL has twice hidden code from text tools in this project, so the
    // question is not whether it is rejected but whether it is rejected as
    // the WHOLE string it is. A door that cut the value at the NUL would
    // read this as the real event id and bring the stretch back.
    const ids = await newConversation("restore-nul-truncation");
    await sendTurn(ids, "tau one", "tau answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");

    const res = await restore(ids.chatId, `${String(data.eventId)}${NUL}junk`);
    expect(res.status).toBe(404);
    expect((await withdrawn(ids.chatId)).stretches[0]!.restored).toBe(false);
    expect(discardedMessageIdsForChat(ids.chatId, ownerUserId).size).toBe(
      (data.discardedMessageIds as string[]).length,
    );
  }, 30000);

  test("hostile: two restores of the same withdrawal at once produce ONE reversal", async () => {
    const ids = await newConversation("restore-concurrent");
    await sendTurn(ids, "upsilon one", "upsilon answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");

    const [a, b] = await Promise.all([
      restore(ids.chatId, data.eventId as string),
      restore(ids.chatId, data.eventId as string),
    ]);
    const ok = [a, b].filter((r) => r.status === 200);
    // Whichever landed first wins; the other must be refused rather than
    // appending a second reversal for one withdrawal.
    expect(ok.length, "both restores succeeded — the record now double-counts").toBe(1);
    expect((await withdrawn(ids.chatId)).stretches.filter((s) => s.restored)).toHaveLength(1);
    // The served history and the ledger agree afterwards.
    const restoredRows = await storedMessages(ids.chatId);
    expect(restoredRows.filter((m) => m.discarded === true)).toHaveLength(0);
    expect(discardedMessageIdsForChat(ids.chatId, ownerUserId).size).toBe(0);
  }, 40000);

  test("the restore APPEND refuses a second reversal for one withdrawal — deterministically, at the owner", async () => {
    // The HTTP race above is real but TIMING-dependent: it needs the suite's
    // worker pressure to interleave the two requests into the check-then-act
    // window, which is why it flaked rather than failed every run. The
    // property itself is not timing — a second reversal of the same
    // withdrawal must be refused no matter how it arrives — so it is pinned
    // HERE, at the owner's append, with no HTTP and no scheduling between the
    // two calls: the first `recordRestore` commits, the second meets the
    // fold's own re-read and is refused. Removing the refusal inside
    // `recordRestore` turns this arm red on every run (mutation-verified);
    // the HTTP arm above is the same class driven through the real door.
    const ids = await newConversation("restore-owner-atomic");
    await sendTurn(ids, "omicron one", "omicron answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");

    const stretch = withdrawnStretchById(ids.chatId, ownerUserId, data.eventId as string);
    expect(stretch, "the rewind just recorded must be inspectable").not.toBeNull();
    expect(stretch!.restored).toBe(false);

    const firstId = recordRestore(ids.chatId, ownerUserId, stretch!);
    expect(typeof firstId).toBe("string");
    // The second append of the SAME withdrawal is refused by name — never a
    // second reversal row, never a double-counted record.
    let caught: unknown = null;
    try {
      recordRestore(ids.chatId, ownerUserId, stretch!);
    } catch (err) {
      caught = err;
    }
    expect(caught, "the second restore of one withdrawal appended a second reversal").not.toBeNull();
    expect((caught as Error).name).toBe("NotFoundError");
    expect(String((caught as Error).message)).toContain("already been brought back");
    // Exactly one stretch, restored once.
    expect((await withdrawn(ids.chatId)).stretches.filter((s) => s.restored)).toHaveLength(1);
  }, 30000);

  test("the reversal is an APPEND — it lands in the same append-only lane", async () => {
    // The restore is only honest if it obeys the same law as the thing it
    // reverses.
    const ids = await newConversation("restore-is-append-only");
    await sendTurn(ids, "phi one", "phi answer");
    const rows = await storedMessages(ids.chatId);
    const { data } = await rewind(ids.chatId, rows[0]!.id, "at");
    const res = await restore(ids.chatId, data.eventId as string);
    const reversalId = (res.body as { data: { eventId: string } }).data.eventId;

    const events = getTimelineQuery().byEventType("rollback", { limit: 500 }).events;
    const reversal = events.find((e) => e.eventId === reversalId);
    expect(reversal, "the reversal must be in the ledger").toBeDefined();
    expect(reversal!.description).toContain("rewind-restore:");
    // The triggers the schema declares are what refuse an edit to either
    // event; read from the schema owner so a dropped trigger is caught here.
    expect(APPEND_ONLY_TRIGGERS.length).toBeGreaterThan(0);
  }, 30000);
  test("the two lane prefixes are disjoint — a reversal can never read as a withdrawal", () => {
    // A property of the two constants, not of the fold that uses them. If the
    // restore prefix ever began with the rewind prefix, every reversal would
    // be read as a fresh withdrawal of the very ids it was bringing back, and
    // the fold would have no way to tell. Read out of the source because the
    // constants are module-private — deliberately, they are wire-invisible.
    const src = read(modulePathMatching("server/run/rewind.ts"));
    const of = (name: string): string => {
      const m = new RegExp(`const ${name} = "([^"]+)"`, "u").exec(src);
      expect(m, `${name} must be declared in server/rewind.ts`).not.toBeNull();
      return m![1]!;
    };
    const rewindPrefix = of("REWIND_DESCRIPTION_PREFIX");
    const restorePrefix = of("RESTORE_DESCRIPTION_PREFIX");
    expect(restorePrefix).not.toBe(rewindPrefix);
    expect(restorePrefix.startsWith(rewindPrefix), "a reversal would read as a withdrawal").toBe(false);
    expect(rewindPrefix.startsWith(restorePrefix), "a withdrawal would read as a reversal").toBe(false);
  });
});
