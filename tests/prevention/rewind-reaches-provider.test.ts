// @vitest-environment node
/**
 * RETRY AND EDIT & RESEND ARE A REWIND, AND THE PROOF IS THE REQUEST ITSELF.
 *
 * This is the provider/context group of the original rewind suite. The file
 * was split by behavior because the single file accumulated one DB, ledger and
 * memory store across 44 tests; each split file now gets a fresh harness.
 */
// @vitest-environment node
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
vi.hoisted(() => {
  // The original file raised the limit because its 70 real runs share one
  // session. Each split file keeps the same setting; the limiter still runs.
  process.env.HARNESS_WEB_RATE_LIMIT = "10000";
  delete process.env.HARNESS_WEB_LLM_FIXTURES;
});
import type { DbClient } from "../../server/db/client.ts";
import { createRewindHarness } from "../helpers/rewind-provider-harness.ts";
import { read } from "../helpers/source-scan.ts";
import { modulePathMatching } from "../helpers/module-resolver.ts";

// The provider stays a real module-level mock at the same measurement point as
// the original file. Each split file gets a fresh harness, DB, ledger and
// memory store, so the late-test accumulation does not cross a file boundary.
vi.mock("../../engine/src/shared/llm/client.ts", async () => {
  const { rewindProvider } = await import("../helpers/rewind-provider-state.ts");
  class SharedLLMClient {
    constructor(_config: unknown) {}
    async *stream(redacted: unknown): AsyncGenerator<Readonly<Record<string, unknown>>, void, unknown> {
      const request = redacted as { input?: Array<{ type?: string; role?: string; content?: string }> };
      rewindProvider.requests.push(
        (request.input ?? []).filter((item) => item.type === "message")
          .map((item) => ({ role: item.role ?? "", content: item.content ?? "" })),
      );
      yield { type: "content", text: rewindProvider.reply };
      yield { type: "finish", reason: "stop", truncated: false };
    }
  }
  return { SharedLLMClient };
});

const harness = createRewindHarness();
const { api, drainRunStream, newConversation, sendTurn, storedMessages, rewind, pairs, systemOf, withdrawn, restore } = harness;
let db: DbClient;
let ownerUserId: string;
let authCookie: string;

beforeAll(async () => {
  ({ db, ownerUserId, authCookie } = await harness.start());
});
afterAll(async () => { await harness.stop(); });

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

describe("the two lane prefixes are disjoint", () => {
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
