// @vitest-environment node
/**
 * PROVIDER TEMPLATE TOKENS NEVER REACH THE TRANSCRIPT OR THE CONTEXT.
 *
 * ── THE DEFECT (measured, from the incident ledger) ────────────────────────
 *
 * A model served with its chat template's control tokens preserved can emit
 * them inside its answer text. The incident: gemma-4-31b's documented "ghost
 * thought channel" — assistant message 635064a2 of run-1d39fa59 ended with
 *
 *     ... (A complete, self-contained HTML/CSS/JS game)\n\n<|channel>thought\n<channel|>
 *
 * — persisted to the DB, rendered in the chat, and then re-entered the LLM
 * context on the next turn (chat-history rebuilds assistant content into the
 * provider request), teaching the model its own corruption.
 *
 * ── THE FIX THIS FILE HOLDS ────────────────────────────────────────────────
 *
 * One filter (server/llm/template-tokens.ts) at the single choke point every
 * provider text delta crosses (the llm-bridge stream loop), so display,
 * persist, context and the ledger response document all see the same cleaned
 * stream. The grammar is the pipe-delimited angle-bracket lattice
 * (`<|name>`, `<name|>`, `<|name|>`) plus the empty channel declaration —
 * canonical gemma-4 template syntax (ai.google.dev/gemma/docs/capabilities/
 * thinking), which also carries the oai/llama.cpp control lattice. HTML,
 * markdown, fences and prose never place a pipe against an angle bracket, so
 * they pass through untouched — and USER text never crosses the filter at
 * all: it enters through buildNativeRequest and is user fact, verbatim.
 *
 * ── §41 OWNERSHIP SEARCH ──────────────────────────────────────────────────
 *
 * No existing guard owns this invariant: the provider-seam guards
 * (redaction-reaches-provider, dedup-compression-owner,
 * model-selection-reaches-provider) own secrets, duplication and model
 * identity at the same seam — template-token leakage is a new class with
 * zero prior coverage (searched tests/ for the lattice and for template
 * token: no hits). The seam-drive shape is borrowed from
 * redaction-reaches-provider and the stub seam is the SHARED owner
 * (tests/helpers/stub-llm-client.ts) — nothing here re-implements either.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// ── The provider seam (the shared stub owner) ──────────────────────────────
vi.mock("../../engine/src/shared/llm/client.ts", async () => {
  const { stubLlmClientModule } = await import("../helpers/stub-llm-client.ts");
  return stubLlmClientModule();
});

import { createTempDir } from "../helpers/temp-dir.ts";
import {
  stubLlmProviderScript,
  stubLlmProviderCalls,
  resetStubLlmProvider,
} from "../helpers/stub-llm-client.ts";

// The fixture path returns canned events BEFORE any provider call, which
// would make the measurement point unreachable. Off, explicitly.
delete process.env.HARNESS_WEB_LLM_FIXTURES;

import { stripTemplateTokens, createTemplateTokenFilter } from "../../server/llm/template-tokens.ts";
import { streamChat } from "../../server/llm/llm-bridge.ts";
import { parseProviderStore, resolveProviderCredential } from "../../server/llm/providers.ts";
import { getTimelineQuery } from "../../server/observability/timeline-bridge.ts";
import { withRecordingContext, generateId } from "../../server/kernel/canonical.ts";
import { TIMELINE_LLM_RESPONSE_DOCUMENT } from "../../shared/constants.ts";
import type { ModelEvent } from "../../shared/types";
import { PROVIDER_FIXTURE_OWNER } from "../helpers/multi-user.ts";

// ── The incident's exact bytes (from the ledger evidence) ──────────────────
const INCIDENT_HEAD = "** (A complete, self-contained HTML/CSS/JS game)\n\n";
const INCIDENT_FULL = `${INCIDENT_HEAD}<|channel>thought\n<channel|>`;
const INCIDENT_CLEAN = INCIDENT_HEAD;

/** A minted credential for the stubbed provider — the real providers door,
 *  so the client construction path is the production one. */
function mintCredential() {
  const store = parseProviderStore({
    providers: [{
      id: "template-fixture",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "template-private-fixture-key",
      models: [{ id: "template-model" }],
    }],
  });
  return resolveProviderCredential(store, store.providers[0]!.models[0]!.id, PROVIDER_FIXTURE_OWNER);
}

// ══ 1. The grammar — what strips, and what never does ══════════════════════

describe("the matcher: canonical template grammar strips, everything else passes", () => {
  test("the incident's exact leak — the gemma-4 ghost channel — strips whole", () => {
    const r = stripTemplateTokens(INCIDENT_FULL);
    expect(r.text).toBe(INCIDENT_CLEAN);
    // The whole declaration (open marker + channel name + close marker) is
    // ONE template unit — Google's own table writes it as one.
    expect(r.stripped).toEqual(["<|channel>thought\n<channel|>"]);
  });

  test("the gemma-4 turn lattice strips", () => {
    const r = stripTemplateTokens("<|turn>user\nknock knock<turn|>\n<|turn>model");
    expect(r.text).toBe("user\nknock knock\nmodel");
    expect(r.stripped).toEqual(["<|turn>", "<turn|>", "<|turn>"]);
  });

  test("the full lattice strips: <|think|> and the oai/llama.cpp vocabulary", () => {
    expect(stripTemplateTokens("a<|think|>b").text).toBe("ab");
    expect(stripTemplateTokens("a <|im_start|>assistant b <|im_end|> c").text).toBe("a assistant b  c");
    expect(stripTemplateTokens("x<|endoftext|>").text).toBe("x");
  });

  test("an empty channel declaration (no name, or whitespace only) strips whole", () => {
    expect(stripTemplateTokens("a<|channel><channel|>b").text).toBe("ab");
    expect(stripTemplateTokens("a<|channel> \n<channel|>b").text).toBe("ab");
  });

  test("a channel declaration with PROSE between keeps the prose — deny by default", () => {
    // Two words between the markers is model prose, not a channel name.
    // Deleting prose would be editing the model's answer, not sanitizing
    // transport syntax.
    const r = stripTemplateTokens("<|channel>actual reasoning text<channel|>answer");
    expect(r.text).toBe("actual reasoning textanswer");
    expect(r.stripped).toEqual(["<|channel>", "<channel|>"]);
  });

  test("HTML, markdown, code fences, comparisons and pipes never strip", () => {
    const untouched = [
      '<div class="x">text</div>',
      "<p>hello</p>",
      "```html\n<div>ok</div>\n```",
      "# Heading\n- list item",
      "if (a < b && b > c) { }",
      "cat foo.txt | grep bar | wc -l",
      "|x| = 3",
      "a <| b is not a marker (space after the pipe)",
      "the checksum is 4a7e...",
    ];
    for (const text of untouched) {
      const r = stripTemplateTokens(text);
      expect(r.text, `must not touch: ${text}`).toBe(text);
      expect(r.stripped, `must strip nothing from: ${text}`).toEqual([]);
    }
  });

  test("angle brackets WITHOUT a pipe are never touched — including think tags", () => {
    // Legacy gemma's <start_of_turn> and Qwen's <think> are angle-bracket
    // shapes indistinguishable from HTML/user text. The honest answer for
    // them is NOT to guess — this is the deny-by-default that keeps the
    // matcher from ever becoming a blanket regex.
    const keep = "gemma says <start_of_turn>user and qwen says <think>loudly</think>";
    expect(stripTemplateTokens(keep).text).toBe(keep);
  });

  test("an unterminated candidate is model text, never dropped", () => {
    const keep = "we discussed <|chan and <div and <turn";
    expect(stripTemplateTokens(keep).text).toBe(keep);
  });
});

// ══ 2. The two doors agree — at every chunk split ══════════════════════════

describe("the streaming filter equals the batch stripper at every split point", () => {
  const corpus = [
    INCIDENT_FULL,
    "<|turn>user\nknock knock<turn|>\n<|turn>model",
    "answer <|im_start|> and <|channel>thought\n<channel|>tail",
    "plain text with <div>html</div> and a | pipe",
    "edge: <|channel>thought",
    "edge: <|",
    "edge: <",
  ];

  test("single- and double-cut splits of every corpus line yield identical text and trace", () => {
    for (const text of corpus) {
      const batch = stripTemplateTokens(text);
      for (let i = 0; i <= text.length; i += 1) {
        for (const doubleCut of [false, true]) {
          const f = createTemplateTokenFilter();
          let out = f.push(text.slice(0, i));
          if (doubleCut) {
            const mid = i + Math.floor((text.length - i) / 2);
            out += f.push(text.slice(i, mid));
            out += f.push(text.slice(mid));
          } else {
            out += f.push(text.slice(i));
          }
          out += f.flush();
          expect(out, `stream text must equal batch at split ${i} of ${JSON.stringify(text)}`).toBe(batch.text);
          expect(
            f.stripped,
            `stream trace must equal batch at split ${i} of ${JSON.stringify(text)}`,
          ).toEqual(batch.stripped);
        }
      }
    }
  });

  test("a marker split across THREE chunks strips exactly once", () => {
    const f = createTemplateTokenFilter();
    const out = f.push("answer <|ch") + f.push("annel>thought\n<ch") + f.push("annel|> done") + f.flush();
    expect(out).toBe("answer  done");
    expect(f.stripped).toEqual(["<|channel>thought\n<channel|>"]);
  });
});

// ══ 3. The bridge seam — the real streamChat, the stubbed provider ═════════

describe("the bridge: a streamed leak yields a clean transcript and a recorded strip", () => {
  beforeAll(() => {
    // Open the timeline BEFORE any effect runs (the sink installs lazily).
    getTimelineQuery();
  });

  test("markers split across stream chunks never yield — and the trace lands in the response document", async () => {
    resetStubLlmProvider();
    stubLlmProviderScript.push(
      { type: "content", text: "** (A complete, self-contained HTML/CSS/JS game)\n\n<|cha" },
      { type: "content", text: "nnel>thought\n<ch" },
      { type: "content", text: "annel|>" },
      { type: "finish", reason: "stop", truncated: false },
    );
    const credential = mintCredential();
    const actorId = `tt-seam-${generateId("tt")}`;
    const textDeltas: string[] = [];
    await withRecordingContext({ actor: { id: actorId, kind: "user", role: "owner" } }, async () => {
      for await (const event of streamChat("make me a game", { credential }) as AsyncGenerator<ModelEvent>) {
        expect(event.type === "error" ? event : undefined).toBeUndefined();
        if (event.type === "text_delta") textDeltas.push(event.delta);
      }
    });
    await new Promise((r) => setImmediate(r));

    // WHAT THE HARNESS YIELDED: the joined text is the honest transcript —
    // every consumer downstream (display, persist, context) sees this.
    expect(textDeltas.join("")).toBe(INCIDENT_CLEAN);

    // WHAT THE LEDGER RECORDED: the response document carries the post-strip
    // text (what the harness recorded) PLUS the exact stripped fragments —
    // never a silent edit, and the pre-strip text stays recoverable.
    const events = getTimelineQuery()
      .byEventType("provider", { ascending: false, limit: 50 })
      .events.filter((e) => e.actorId === actorId);
    expect(events.length, "the provider effect must be recorded").toBeGreaterThanOrEqual(1);
    const doc = (events[0]!.documents ?? []).find((d) => d.name === TIMELINE_LLM_RESPONSE_DOCUMENT);
    expect(doc, "the response document must exist").toBeDefined();
    const payload = JSON.parse(doc!.contentJson ?? "{}") as {
      text: string;
      templateTokensStripped?: string[];
    };
    expect(payload.text).toBe(INCIDENT_CLEAN);
    expect(payload.templateTokensStripped).toEqual(["<|channel>thought\n<channel|>"]);
  });

  test("user text crosses the same seam VERBATIM — the strip is for model output only", async () => {
    resetStubLlmProvider();
    stubLlmProviderScript.push(
      { type: "content", text: "ok" },
      { type: "finish", reason: "stop", truncated: false },
    );
    const credential = mintCredential();
    // The USER's prompt deliberately carries lattice-shaped text: they are
    // asking about the very corruption. Their words are user fact.
    const prompt = "why does the model emit <|channel>thought\n<channel|> in its answers?";
    await withRecordingContext({ actor: { id: `tt-user-${generateId("tt")}`, kind: "user", role: "owner" } }, async () => {
      for await (const event of streamChat(prompt, { credential }) as AsyncGenerator<ModelEvent>) {
        void event;
      }
    });
    await new Promise((r) => setImmediate(r));

    expect(stubLlmProviderCalls.length).toBeGreaterThan(0);
    const wire = JSON.stringify(stubLlmProviderCalls.at(-1));
    expect(wire, "the user's lattice-shaped text must reach the provider untouched").toContain(
      "<|channel>thought\\n<channel|>",
    );
    // And the model's own output was still filtered on the way back.
    expect(wire).not.toContain("\"ok<|");
  });
});

// ══ 4. The run chain — persist purity + context purity across turns ════════

describe("the run: a leaked marker never persists, and never re-enters the next turn's context", () => {
  let server: Server;
  let baseUrl = "";
  let tmpRoot = "";
  let seamDb: import("../../server/db/client.ts").DbClient | undefined;
  let seamCookie = "";
  let seamUserId = "";

  const SESSION_COOKIE = "harness_session=template-tokens-seam";

  beforeAll(async () => {
    tmpRoot = createTempDir("ch-template-tokens-");
    const { DbClient } = await import("../../server/db/client.ts");
    const { AsyncDbClient } = await import("../../server/db/async-client.ts");
    const { createRouter } = await import("../../server/router/router.ts");
    const { isPublicPath } = await import("../../server/routes/registry.ts");
    const { registerProjectRoutes } = await import("../../server/routes/projects.ts");
    const { registerChatRoutes } = await import("../../server/routes/chats.ts");
    const { registerRunRoutes } = await import("../../server/routes/run.ts");
    const { registerRunStreamRoutes } = await import("../../server/routes/run-stream.ts");
    const { createTestUser, seedProvider } = await import("../helpers/multi-user.ts");

    const db = new DbClient({ path: join(tmpRoot, "web.db") });
    const user = createTestUser(db, "template-tokens-tester");
    seedProvider(db, user.userId, { baseUrl: "https://provider.invalid/v1" });
    const adb = AsyncDbClient.inline(db);
    const router = createRouter({ db: adb, isPublicPath });
    registerProjectRoutes(router, adb);
    registerChatRoutes(router, adb);
    registerRunRoutes(router, adb);
    registerRunStreamRoutes(router, adb);
    server = createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    seamDb = db;
    seamCookie = `${user.cookie}; ${SESSION_COOKIE}`;
    seamUserId = user.userId;
  });

  afterAll(async () => {
    if (server !== undefined) await new Promise<void>((r) => server.close(() => r()));
    if (seamDb !== undefined) seamDb.close();
  });

  test("turn 1's leak is absent from the DB message and from turn 2's provider request", async () => {
    const b = baseUrl;
    const cookie = seamCookie;
    const db = seamDb!;
    const userId = seamUserId;
    const postJson = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
      const res = await fetch(`${b}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie, "X-Requested-With": "test" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined };
    };

    // A fresh conversation for this arm.
    // The project is a folder of its own: a folder holding the harness's database is never a project.
    const projectPath = join(tmpRoot, "project");
    mkdirSync(projectPath, { recursive: true });
    const p = await postJson("/api/projects", { name: "template-tokens", path: projectPath });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const c = await postJson("/api/chats", {
      projectId: (p.body as { id: string }).id,
      title: "template-tokens",
    });
    expect(c.status).toBe(201);
    const chatId = (c.body as { id: string }).id;
    const projectId = (p.body as { id: string }).id;

    // TURN 1: the model's stream carries the incident's leak, split across
    // chunks exactly as a provider would.
    resetStubLlmProvider();
    stubLlmProviderScript.push(
      { type: "content", text: "** (A complete, self-contained HTML/CSS/JS game)\n\n<|cha" },
      { type: "content", text: "nnel>thought\n<ch" },
      { type: "content", text: "annel|>" },
      { type: "finish", reason: "stop", truncated: false },
    );
    const start1 = await postJson("/api/run/start", { projectId, prompt: "make me a game", chatId });
    expect(start1.status).toBe(201);
    const runId1 = (start1.body as { runId: string }).runId;
    const res1 = await fetch(`${b}/api/run/${runId1}/stream`, { headers: { Cookie: cookie } });
    const streamText = await res1.text();

    // Split the raw stream into frames so the assertion can name WHICH
    // surface it is judging. The DISPLAY surface is the `model` frames (the
    // text the chat renders); the FORENSIC surface is the `timeline` frames
    // (ledger documents, served verbatim to the dig/dashboard — the trace
    // deliberately lives there so no edit is silent).
    const frames = streamText
      .split("\n\n")
      .map((block) => {
        // SSE frames may carry an `id:` sequence line before the event name.
        const m = block.match(/(?:^|\n)event: (\w+)/);
        return m === null ? undefined : { name: m[1]!, block };
      })
      .filter((f): f is { name: string; block: string } => f !== undefined);
    const modelBlocks = frames.filter((f) => f.name === "model").map((f) => f.block).join("\n");
    const timelineBlocks = frames.filter((f) => f.name === "timeline").map((f) => f.block).join("\n");

    // DISPLAY purity: the model frames the chat renders carry no marker, and
    // the streamed text IS the honest transcript.
    expect(modelBlocks, "the live display frames must not render the markers").not.toContain("<|channel");
    expect(modelBlocks).not.toContain("channel|>");
    const deltas = [...modelBlocks.matchAll(/"type":"text_delta","outputIndex":0,"delta":"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => JSON.parse(`"${m[1]}"`) as string);
    expect(deltas.join("")).toBe(INCIDENT_CLEAN);

    // FORENSIC presence: the ledger's response document — served on the
    // timeline frames — records the strip, so the raw bytes stay
    // recoverable and the edit is never silent.
    expect(
      timelineBlocks,
      "the response document must carry the stripped-token trace",
    ).toContain("templateTokensStripped");

    // PERSIST purity: the DB row for the assistant message is the honest
    // transcript, read back through the server's own owner.
    const assistant = db
      .listMessages(chatId, userId)
      .filter((m) => m.role === "assistant")
      .at(-1)!;
    expect(assistant.content).toBe(INCIDENT_CLEAN);

    // TURN 2: a second run in the same chat. Its provider request rebuilds
    // the history from the DB — the exact path that taught the model its own
    // corruption in the incident.
    resetStubLlmProvider();
    stubLlmProviderScript.push(
      { type: "content", text: "second answer" },
      { type: "finish", reason: "stop", truncated: false },
    );
    stubLlmProviderCalls.length = 0;
    const start2 = await postJson("/api/run/start", { projectId, prompt: "now a second one", chatId });
    expect(start2.status).toBe(201);
    const runId2 = (start2.body as { runId: string }).runId;
    const res2 = await fetch(`${b}/api/run/${runId2}/stream`, { headers: { Cookie: cookie } });
    await res2.text();
    expect(stubLlmProviderCalls.length, "turn 2 must have reached the provider").toBeGreaterThan(0);
    const wire2 = JSON.stringify(stubLlmProviderCalls.at(-1));
    expect(wire2, "the healed history must not teach the model its own corruption").not.toContain("<|channel");
    expect(wire2).not.toContain("channel|>");
    expect(wire2, "the clean answer text does survive into context").toContain(INCIDENT_CLEAN.replace(/\n/g, "\\n").slice(0, 20));
  });
});
