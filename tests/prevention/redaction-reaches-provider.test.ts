// @vitest-environment node
/**
 * THE SECRET NEVER REACHES THE PROVIDER — across the whole seam.
 *
 * The user believed the outbound provider call was unfiltered. It is not: the
 * redaction runs at `buildNativeRequest`, the single point all LLM input passes
 * through, and `streamChat` hands its result straight to `client.stream`. But
 * "it is filtered" is a claim about a seam with a database, an HTTP route, an
 * SSE stream and a bridge in it, and a unit test of any one of those passes
 * while the wiring is broken. So this guard runs the REAL chain and asserts
 * only at its two ends:
 *
 *   the prompt the user types      (POST /api/run/start, the cockpit's exact
 *                                   body, carrying the reported phrasing)
 *        ↓
 *   the run route                  (real route, real DB, real SSE stream)
 *        ↓
 *   the LLM bridge                 (real `streamChat` → real
 *                                   `buildNativeRequest` → real redaction)
 *        ↓  client.stream(messages, options)
 *   THE PROVIDER CALL              ← the only thing stubbed, and only so the
 *                                    MESSAGES it is handed can be inspected
 *
 * Nothing between the prompt and the provider's `messages` argument is mocked.
 * The stub records what it was given; every assertion is about that recording.
 *
 * It also asserts the other half of the honesty requirement: the user is TOLD.
 * A redaction the user cannot find out about is indistinguishable from their
 * content going missing, so the `redaction` SSE event is read off the real
 * stream rather than trusted to exist.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

// ── The provider seam ───────────────────────────────────────────────────────
const provider = vi.hoisted(() => ({
  /** Every message array handed to a provider stream call, in order. */
  calls: [] as { role: string; content: string; tool_calls?: unknown }[][],
}));

vi.mock("../../engine/src/shared/llm/client.ts", async () => {
  const actual = await vi.importActual<typeof import("../../engine/src/shared/llm/client.ts")>("../../engine/src/shared/llm/client.ts");
  const {responseSseResponse} = await import("../../engine/test/support/mock-provider.ts");
  const {address, serve} = await import("../../engine/test/support/loopback-upstream.ts");
  class SharedLLMClient extends actual.SharedLLMClient {
    constructor(config: import("../../engine/src/shared/llm/client.ts").SharedLLMClientOptions) {
      // A real loopback upstream answers (the door owns its transport).
      super({...config, baseUrl: address(config.baseUrl), allowPrivateAddress: true});
      serve(async (_url, init) => {
        provider.calls.push(JSON.parse(String(init.body)).input);
        return responseSseResponse({content:"ok"});
      });
    }
  }
  return {...actual, SharedLLMClient};
});

import { createTempDir } from "../helpers/temp-dir.ts";

/**
 * THE SERVER'S OWN PROVIDER KEY is the one the seeded DB provider stores —
 * there is no other way a key enters this process. The old spelling of this
 * arm wrote an `llm-api-config.json` and set `HARNESS_LLM_CONFIG_PATH` /
 * `HARNESS_WEB_DEFAULT_MODEL`, a seam nothing at HEAD reads (the env scan
 * skips `*_PATH` on purpose, and providers live in the database): the file
 * sat unread while the "own key is masked" assertion stayed green through an
 * unrelated mechanism — the shape detector happened to recognise the fixture
 * key's format. A test that passes through a mechanism other than the one it
 * names is the exact charge this file was rebuilt to answer.
 *
 * The REAL choke point is the mint: `server/providers.ts::mintCredential`
 * calls `rememberOwnCredential` on every key the moment a run first uses its
 * provider, so the redactor cannot fail to know a key that is in use. The
 * own-key test below asserts THAT seam, with the seeded key the DB actually
 * holds.
 */
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
import { createTestUser, TEST_PROVIDER_API_KEY } from "../helpers/multi-user.ts";
import { primeKnownSecrets } from "../../server/llm/redaction.ts";
import { PROVIDER_FIXTURE_OWNER } from "../helpers/multi-user.ts";

/** The reported phrasing, and a value in the format the report named. */
const PASTED_KEY = "sk-proj-Ab3xQ9zLmN2pRt5vWy8uZc1dEf4gHj7kLm0nPq6rSt9uVw2xYz5aBc8dEf1gHi";
/** An opaque value no format regex can recognise — only a declaration can. */
const OPAQUE_KEY = "9f2c7d4e8b1a6350fe2947cd80b3a15e6d7c8f90";
/** A second opaque value that NOTHING in this file ever declares, so the
 * "undeclared values survive" assertion cannot be contaminated by a
 * declaration made in an earlier test. */
const NEVER_DECLARED = "4a7e1c93d0b85ف26".replace("ف", "f") + "e3d2109a8b7c6d5e";

let tmpRoot = "";
let server: Server;
let baseUrl = "";
let db: DbClient;
let authCookie = "";
let testUserId = "";
const SESSION_COOKIE = "harness_session=test-redaction-seam-session";

async function postJson(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
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
 * Drive the run to completion by opening its SSE stream and return the RAW
 * stream text, so the `redaction` event can be read off the wire rather than
 * inferred from a callback.
 */
async function runAndReadStream(runId: string, timeoutMs = 15000): Promise<string> {
  const res = await fetch(`${baseUrl}/api/run/${runId}/stream`, {
    headers: { Cookie: `${authCookie}; ${SESSION_COOKIE}` },
  });
  if (!res.ok || res.body === null) {
    // The STATUS ALONE names nothing. A refusal here has several possible
    // causes that read identically at the call site (the run was never
    // registered, the identity did not resolve, the SSE connection cap was
    // reached), and a bare number sends the next reader hunting. Carry the
    // server's own words.
    const why = await res.text().catch(() => "<body unreadable>");
    throw new Error(`stream refused for run ${runId}: ${String(res.status)} ${why}`);
  }
  const reader = res.body.getReader();
  const timer = setTimeout(() => { void reader.cancel().catch(() => undefined); }, timeoutMs);
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
  return buffer;
}

async function newConversation(name: string): Promise<{ projectId: string; chatId: string }> {
  // Each precondition is asserted WHERE IT IS ESTABLISHED. Reading `.id` off a
  // refusal body yields `undefined`, which then travels to `/api/run/start`
  // and comes back as a 403 about a project that was never created — a failure
  // reported three steps from its cause, against an assertion about something
  // else entirely.
  const p = await postJson("/api/projects", { name, path: `/${name}` });
  expect(p.status, `creating project ${name} failed: ${JSON.stringify(p.body)}`).toBe(201);
  const projectId = (p.body as { id: string }).id;
  const c = await postJson("/api/chats", { projectId, title: name });
  expect(c.status, `creating chat ${name} failed: ${JSON.stringify(c.body)}`).toBe(201);
  const chatId = (c.body as { id: string }).id;
  return { projectId, chatId };
}

/** Send one prompt through the real route and return what the provider got. */
async function sendAndCapture(
  ids: { projectId: string; chatId: string },
  prompt: string,
): Promise<{ messages: { role: string; content: string }[]; stream: string }> {
  provider.calls.length = 0;
  const start = await postJson("/api/run/start", {
    projectId: ids.projectId,
    prompt,
    chatId: ids.chatId,
  });
  expect(start.status, `starting the run failed: ${JSON.stringify(start.body)}`).toBe(201);
  const stream = await runAndReadStream((start.body as { runId: string }).runId);
  expect(provider.calls.length, "the provider was never called").toBeGreaterThan(0);
  return { messages: provider.calls[0] as { role: string; content: string }[], stream };
}

/** Everything the provider was handed, as one string. */
function wire(messages: { role: string; content: string }[]): string {
  return JSON.stringify(messages);
}

beforeAll(async () => {
  tmpRoot = createTempDir("ch-redact-seam-");
  db = new DbClient({ path: join(tmpRoot, "redact-seam.db") });
  const user = createTestUser(db, "redaction-seam-tester");
  authCookie = user.cookie;
  testUserId = user.userId;

  const adb = AsyncDbClient.inline(db);
  const router = createRouter({ db: adb, isPublicPath });
  registerProjectRoutes(router, adb);
  registerChatRoutes(router, adb);
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
  // The startup call, run here because this file boots the server itself.
  primeKnownSecrets();
});

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((r) => server.close(() => r()));
  if (db !== undefined) db.close();
});

describe("outbound provider call — the pasted credential does not leave the machine", () => {
  test("the reported phrasing: a key introduced by 'my api key … is' never reaches the provider", async () => {
    const ids = await newConversation("redact-reported-phrasing");
    const { messages } = await sendAndCapture(
      ids,
      `my api key openaiapi format is '${PASTED_KEY}'`,
    );
    expect(wire(messages), "the pasted key reached the provider").not.toContain(PASTED_KEY);
    expect(wire(messages)).toContain("[REDACTED:");
    // The sentence survives — the user's words are not the secret.
    expect(wire(messages)).toContain("my api key openaiapi format is");
  }, 30000);

  test("a value NO format regex can recognise is still caught, because it was declared", async () => {
    // The case that separates this from "add another regex". Forty hex
    // characters are a SHA in one context and a credential in another; the
    // declaration is what tells them apart, and only the declaration can.
    const ids = await newConversation("redact-opaque-declared");
    const { messages } = await sendAndCapture(ids, `the password for the db is ${OPAQUE_KEY}`);
    expect(wire(messages)).not.toContain(OPAQUE_KEY);
  }, 30000);

  test("the SAME value with nothing declaring it reaches the provider intact", async () => {
    // The honest other half. If this were also masked, the detector would be
    // masking entropy, and every hash and id in every payload would go with
    // it. The asymmetry is the whole design.
    const ids = await newConversation("redact-opaque-undeclared");
    const { messages } = await sendAndCapture(ids, `the checksum of README.md is ${NEVER_DECLARED}`);
    expect(
      wire(messages),
      "an undeclared hash must survive — masking it would destroy legitimate content",
    ).toContain(NEVER_DECLARED);
  }, 30000);

  test("the server's OWN provider key is masked, having registered itself at the mint", async () => {
    // Nobody calls the registrar in this test. The key sits in the seeded DB
    // provider record — the only place a key can live — and the mint
    // (`providers.ts::mintCredential`) registers every key it hands the
    // bridge, so by the time the provider is called the redactor knows it.
    // The value has NO recognisable credential shape (plain words and
    // hyphens), so only the mint's registration can be what masks it: a
    // format regex passing this test would be passing for the wrong reason.
    const ids = await newConversation("redact-own-key");
    const { messages } = await sendAndCapture(
      ids,
      `is this still valid? ${TEST_PROVIDER_API_KEY}`,
    );
    expect(wire(messages), "the server leaked its own provider key").not.toContain(
      TEST_PROVIDER_API_KEY,
    );
    // The sentence around it survives — the mask is the value, not the turn.
    expect(wire(messages)).toContain("is this still valid?");
  }, 30000);

  test("ordinary prose reaches the provider byte for byte", async () => {
    // Redaction that damages normal messages is worse than none: it is a
    // silent content shredder. This is the false-positive assertion at the
    // seam, not in a unit.
    const ids = await newConversation("redact-no-false-positive");
    const prompt = "Explain what the api key rotation policy in this repo is for.";
    const { messages } = await sendAndCapture(ids, prompt);
    expect(wire(messages)).toContain(prompt);
    const user = messages.filter((m) => m.role === "user").at(-1);
    expect(user?.content).toBe(prompt);
  }, 30000);
});

describe("outbound provider call — a credential declared once stays a secret", () => {
  /** The live report, in the user's own words: *"my password may be admin44
   * what is my password"* — and the model answered with it. */
  const DECLARED = "admin44";

  test("the declaring message is masked, shape or no shape", async () => {
    // `admin44` has NO credential shape at all — 7 characters, low entropy,
    // below every length floor. The declaration around it is what carries the
    // judgement, which is the whole point of the scoring model.
    const ids = await newConversation("redact-declared-first-turn");
    const { messages } = await sendAndCapture(ids, `my password may be ${DECLARED}`);
    const user = messages.filter((m) => m.role === "user").at(-1);
    expect(user?.content, "the declaring message leaked").not.toContain(DECLARED);
    expect(user?.content).toContain("my password may be");
  }, 30000);

  test("the model is never handed the value when asked to repeat it", async () => {
    const ids = await newConversation("redact-what-is-my-password");
    await sendAndCapture(ids, `my password may be ${DECLARED}`);
    const { messages } = await sendAndCapture(ids, "what is my password");
    const user = messages.filter((m) => m.role === "user").at(-1);
    expect(user?.content).not.toContain(DECLARED);
  }, 30000);

  test("a PLACEHOLDER declared as a password does not become a permanent shredder", async () => {
    // The expensive failure. Once a value is matched by equality, EVERY
    // occurrence is masked — so a short or common value would destroy
    // legitimate content. "test" must stay the word "test".
    const ids = await newConversation("redact-placeholder-not-remembered");
    await sendAndCapture(ids, "my password is test");
    const { messages } = await sendAndCapture(
      ids,
      "please run the test suite and tell me if the test passed",
    );
    const user = messages.filter((m) => m.role === "user").at(-1);
    expect(
      user?.content,
      "the word 'test' was masked out of an ordinary sentence",
    ).toContain("test suite");
  }, 30000);

  test("STORAGE KEEPS THE USER'S REAL WORDS — redaction is egress-only", async () => {
    // The conversation is the user's own record on their own machine. Masking
    // it into the database would destroy the thing they are keeping, and it is
    // not what protects them: what protects them is that the value does not
    // LEAVE. Enforcement stays at the provider boundary.
    const ids = await newConversation("redact-storage-untouched");
    const prompt = `my password may be ${DECLARED}`;
    const { messages } = await sendAndCapture(ids, prompt);
    const user = messages.filter((m) => m.role === "user").at(-1);
    expect(user?.content, "it must not reach the provider").not.toContain(DECLARED);

    const stored = db.listMessages(ids.chatId, testUserId);
    const userRows = stored.filter((m) => m.role === "user");
    expect(userRows.length, "the turn was not persisted at all").toBeGreaterThan(0);
    expect(
      userRows.map((m) => m.content).join("\n"),
      "the database must keep what the user actually typed",
    ).toContain(DECLARED);
  }, 30000);
});

describe("outbound provider call — the user is told the input was rewritten", () => {
  test("a masked turn emits a redaction event carrying counts split by confidence", async () => {
    const ids = await newConversation("redact-notice-emitted");
    const { stream } = await sendAndCapture(ids, `my api key is ${PASTED_KEY}`);
    expect(stream, "no redaction event reached the client").toContain("event: redaction");

    const line = stream
      .split("\n")
      .find((l) => l.startsWith("data:") && l.includes("maskedCount"));
    expect(line, "the redaction event carried no payload").toBeDefined();
    const payload = JSON.parse((line as string).slice("data:".length).trim()) as {
      maskedCount: number;
      proven: number;
      format: number;
      inferred: number;
      maskedUpstream: number;
      reasons: { confidence: string; explanation: string }[];
    };

    // SOMETHING was hidden, and the user is told so.
    expect(payload.maskedCount + payload.maskedUpstream).toBeGreaterThan(0);

    // ── THE TWO NUMBERS ARE SEPARATE, AND THAT IS THE HONEST PART ──────────
    //
    // `buildTrimmedHistory` redacts the history on its way out of the context
    // manager, so by the time the choke point sees this turn the secret is
    // already `[REDACTED:…]` and the ORIGINAL IS GONE. The choke point can
    // count those markers; it cannot say why any of them is there.
    //
    // The first version of this test asserted `maskedCount > 0` and FAILED
    // for exactly that reason — which is how the double-redaction was found.
    // The tempting fix was to add the two together so the number looked
    // right. That would attach the confidence of the spans this pass
    // explained to spans it never saw, which is the dishonesty the
    // confidence split exists to prevent.
    expect(
      payload.proven + payload.format + payload.inferred,
      "the confidence split must account for exactly the spans that were explained",
    ).toBe(payload.maskedCount);
    expect(
      payload.reasons.length,
      "every explained span must carry a reason, and no unexplained span may invent one",
    ).toBe(Math.min(payload.maskedCount, 20));
    for (const r of payload.reasons) expect(r.explanation.length).toBeGreaterThan(0);

    // And the notice never carries the thing it is about.
    expect(JSON.stringify(payload)).not.toContain(PASTED_KEY);
  }, 30000);

  test("an isolated unchanged request is silent and one actual rewrite emits one notice", async () => {
    const {streamChat}=await import("../../server/llm/llm-bridge.ts");
    const {parseProviderStore,resolveProviderCredential}=await import("../../server/llm/providers.ts");
    const credential=resolveProviderCredential(parseProviderStore({providers:[{id:"notice-fixture",baseUrl:"https://notice.test/v1",apiKey:"notice-private-fixture",models:[{id:"notice-model"}]}]}),"notice-model", PROVIDER_FIXTURE_OWNER);
    const notices: import("../../server/llm/redaction.ts").RedactionNotice[]=[];
    for await(const event of streamChat("ordinary benign anchor",{credential,onRedaction:notice=>notices.push(notice)}))void event;
    expect(notices).toEqual([]);expect(provider.calls.at(-1)).toEqual([{type:"message",role:"user",content:"ordinary benign anchor"}]);
    for await(const event of streamChat("prefix notice-private-fixture suffix",{credential,onRedaction:notice=>notices.push(notice)}))void event;
    expect(notices).toHaveLength(1);expect(notices[0]!.maskedCount).toBe(1);expect(notices[0]!.maskedUpstream).toBe(0);
    const sent=JSON.stringify(provider.calls.at(-1));expect(sent).toContain("prefix [REDACTED:secret] suffix");expect(sent).not.toContain("notice-private-fixture");
  });

});
