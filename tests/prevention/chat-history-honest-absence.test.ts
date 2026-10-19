/**
 * Prevention test: A FAILED HISTORY LOAD IS STATED, NEVER RENDERED AS AN
 * EMPTY CONVERSATION. (DESIGN-PERFORMANCE §1 L3 / §6 item 1.)
 *
 * ── The defect ──
 *
 * Opening the 21,405-message conversation in the `heavy` fixture returns
 * 75.1MB and takes 34,665ms against a 30,000ms client timeout. The request
 * therefore aborts — and it was issued TWICE, both aborted. The Flow then
 * rendered "nothing recorded in this conversation yet" and no error at all.
 *
 * That sentence is a MEASURED CLAIM the product never measured. It is the
 * fabricated-absence failure the whole system exists to prevent, arriving
 * through the performance door: a fast surface that reports zero when it
 * means "I could not reach it" is worse than a slow honest one.
 *
 * ── What is verified ──
 *
 * A. The load states its own outcome (`src/state/chat-history-load.ts`):
 *    A1 a failed load records `absent` with plain words AND what it could
 *       not reach (the conversation, by the title the reader knows);
 *    A2 a timeout maps to the timeout sentence, not a generic one — the
 *       reader is told the read ran out of time, not that nothing exists;
 *    A3 a successful load records `measured`, so the state cannot be a
 *       one-way latch that reports absence forever;
 *    A4 an absence is NEVER recorded against a conversation the reader has
 *       already left.
 * B. The surface renders the difference:
 *    B1 with an absence recorded, the Flow says it could not read the
 *       conversation and NEVER says "nothing recorded in this conversation
 *       yet";
 *    B2 with no absence recorded, the ordinary empty conversation still
 *       reads as an ordinary empty conversation (the fix must not turn
 *       every empty Flow into an error);
 *    B3 the absence offers the way forward — a control, not a spinner and
 *       not a wall.
 * C. There is no automatic identical retry:
 *    C1 the Flow's self-heal effect does not re-arm itself on failure —
 *       the byte-identical request that just failed is not sent again on
 *       the next re-render.
 *
 * ── Mutation-verified (see the `mutation:` cases) ──
 * Every scanner here is a pure function fed a synthetic source, so a
 * scanner that has been weakened into always-passing turns its own
 * self-checks red.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import { loadChatHistory } from "../../src/client";
import { selectChat, resetChats, setChats } from "../../src/state/chats";
import { clearMessages } from "../../src/state/chat-messages";
import {
  chatHistoryLoad,
  clearChatHistoryLoad,
} from "../../src/state/chat-history-load";
import { read, stripCommentsOnlyFor } from "../helpers/source-scan.ts";
import { wholeConversationPage } from "../helpers/history-page.ts";

const originalFetch = globalThis.fetch;

/** Fail every request with the given Response-ish outcome. */
function failingFetch(outcome: "timeout" | { status: number }): void {
  globalThis.fetch = vi.fn(() => {
    if (outcome === "timeout") {
      // Exactly what `AbortController.abort()` produces — the Broker maps
      // `DOMException("AbortError")` to `ClientTimeoutError`, and a plain
      // Error would take the "network" arm instead and quietly test the
      // wrong sentence.
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    }
    return Promise.resolve({
      ok: false,
      status: outcome.status,
      json: async () => ({ error: { code: "nope", message: "nope" } }),
    } as Response);
  }) as unknown as typeof fetch;
}

function okFetch(payload: unknown): void {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => payload } as Response),
  ) as unknown as typeof fetch;
}

function historyFor(chatId: string): unknown {
  return {
    chat: {
      id: chatId,
      projectId: "p1",
      title: `title-${chatId}`,
      modelId: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
    messages: [],
    toolCalls: [],
    metricsSnapshots: [],
    timelineRefs: [],
    page: wholeConversationPage(0),
  };
}

beforeEach(() => {
  clearMessages();
  resetChats();
  clearChatHistoryLoad();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("A. the load states its own outcome", () => {
  test("A1 a failed load is ABSENT with plain words and names what it could not reach", async () => {
    setChats([
      {
        id: "A",
        projectId: "p1",
        title: "Refactor the boot path",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        modelId: null,
        pinned: false,
      } as never,
    ]);
    selectChat("A");
    failingFetch({ status: 500 });
    await expect(loadChatHistory("A")).rejects.toBeTruthy();

    const state = chatHistoryLoad.get();
    expect(state?.kind, "a failed load must record absence, not silence").toBe("absent");
    expect(state).toMatchObject({ chatId: "A", title: "Refactor the boot path" });
    expect(
      (state as { reason: string }).reason.length,
      "the absence must carry plain words, not an empty string",
    ).toBeGreaterThan(0);
  });

  test("A2 a TIMEOUT says the read did not answer — not that nothing exists", async () => {
    selectChat("A");
    failingFetch("timeout");
    await expect(loadChatHistory("A")).rejects.toBeTruthy();
    const state = chatHistoryLoad.get();
    expect(state?.kind).toBe("absent");
    // The one sentence `absenceReason` owns for a timeout. A generic
    // "not available right now" would blame the wrong thing, and "no
    // recorded history" (the 404 sentence) would be the fabricated claim.
    expect((state as { reason: string }).reason).toBe("not answering right now");
    expect((state as { reason: string }).reason).not.toBe("no recorded history");
  });

  test("A3 a successful load records MEASURED (absence is not a latch)", async () => {
    selectChat("A");
    okFetch(historyFor("A"));
    await loadChatHistory("A");
    expect(chatHistoryLoad.get()).toMatchObject({ kind: "measured", chatId: "A" });
  });

  test("A4 an absence is never recorded against a conversation the reader left", async () => {
    selectChat("A");
    failingFetch({ status: 500 });
    const load = loadChatHistory("A");
    selectChat("B");
    await expect(load).rejects.toBeTruthy();
    const state = chatHistoryLoad.get();
    expect(
      state === null || state.chatId !== "A",
      "announcing the failure of a conversation the reader already left is a lie " +
        "about the one they are looking at",
    ).toBe(true);
  });
});

// ── Static scans over the surface (B, C) ─────────────────────────────────
//
// The Flow is a 1,300-line virtualizer whose empty branch is three lines;
// mounting it in jsdom to read those three lines would test the
// virtualizer, not the sentence. These scanners read the branch itself and
// are mutation-tested against synthetic sources below.

/** The `{#if win.total === 0}` block: every sentence the Flow can render
 * in place of a transcript. */
export function emptyBranch(src: string): string {
  const start = src.indexOf("{#if win.total === 0}");
  if (start === -1) return "";
  const end = src.indexOf("{:else}", src.indexOf("{/if}", start));
  return src.slice(start, end === -1 ? src.length : end);
}

/** Does the empty branch distinguish an UNREAD conversation from an empty
 * one before it makes the emptiness claim? */
export function statesUnreadFirst(branch: string): boolean {
  const guard = branch.indexOf("unread");
  const claim = branch.indexOf("nothing recorded in this conversation yet");
  return guard !== -1 && claim !== -1 && guard < claim;
}

/** The body of the Flow's self-heal `$effect`, from its `askedFor` arm. */
export function selfHealEffect(src: string): string {
  const start = src.indexOf("let askedFor");
  if (start === -1) return "";
  const end = src.indexOf("\n  });", start);
  return src.slice(start, end === -1 ? src.length : end);
}

/** Does the self-heal effect re-arm itself inside its failure handler? A
 * cleared arm means the next re-render re-issues the request that just
 * failed — the measured double-fire. */
export function reArmsOnFailure(effect: string): boolean {
  const catchAt = effect.indexOf(".catch(");
  if (catchAt === -1) return false;
  return /askedFor\s*=\s*null/.test(effect.slice(catchAt));
}

describe("B/C. the surface renders the difference, and does not retry by itself", () => {
  const FLOW = stripCommentsOnlyFor(read("src/cockpit/flow/Flow.svelte"), "src/cockpit/flow/Flow.svelte");
  const branch = emptyBranch(FLOW);
  const effect = selfHealEffect(FLOW);

  test("the scanners found something to scan", () => {
    expect(branch.length, "the Flow's empty branch must be findable").toBeGreaterThan(0);
    expect(effect.length, "the Flow's self-heal effect must be findable").toBeGreaterThan(0);
  });

  test("B1 an unread conversation is checked BEFORE the emptiness claim", () => {
    expect(
      statesUnreadFirst(branch),
      "the Flow must ask whether the history could be READ before it says nothing " +
        "was recorded — otherwise a failed load renders as a measured zero",
    ).toBe(true);
    expect(branch, "the absence must say, in plain words, that it could not read").toContain(
      "could not read",
    );
  });

  test("B2 an ordinary empty conversation still reads as one", () => {
    expect(
      branch,
      "the fix must not turn every empty Flow into an error — an empty conversation " +
        "is still allowed to say so",
    ).toContain("nothing recorded in this conversation yet");
    expect(branch, "and an evicted log still says it is reloading").toContain("reloading this conversation");
  });

  test("B3 the absence offers the way forward as a control", () => {
    expect(branch).toMatch(/<button[\s\S]*?data-verb-id="chat\.history\.read-again"/);
  });

  test("C1 the self-heal effect does not re-arm itself on failure", () => {
    expect(
      reArmsOnFailure(effect),
      "clearing `askedFor` in the catch re-issues the byte-identical request on the " +
        "next re-render — measured: the 34,665ms read fired twice, both aborted",
    ).toBe(false);
  });

  // ── MUTATION SELF-CHECKS ────────────────────────────────────────────────

  test("mutation: an empty branch that claims emptiness first is flagged", () => {
    const bad = `{#if win.total === 0}<div>nothing recorded in this conversation yet</div>{#if unread}x{/if}{/if}{:else}`;
    expect(statesUnreadFirst(emptyBranch(bad))).toBe(false);
  });

  test("mutation: an empty branch with NO unread arm is flagged", () => {
    const bad = `{#if win.total === 0}<div>nothing recorded in this conversation yet</div>{/if}{:else}`;
    expect(statesUnreadFirst(emptyBranch(bad))).toBe(false);
  });

  test("mutation: the ordered branch is NOT flagged (no false positive)", () => {
    const good = `{#if win.total === 0}{#if unread !== null}<p>could not read</p>{:else}<div>nothing recorded in this conversation yet</div>{/if}{/if}{:else}`;
    expect(statesUnreadFirst(emptyBranch(good))).toBe(true);
  });

  test("mutation: a catch that clears the arm is flagged", () => {
    const bad = `let askedFor = null;\n  $effect(() => {\n    void load(cid).catch(() => {\n      askedFor = null;\n    });\n  });`;
    expect(reArmsOnFailure(selfHealEffect(bad))).toBe(true);
  });

  test("mutation: a catch that leaves the arm set is NOT flagged", () => {
    const good = `let askedFor = null;\n  $effect(() => {\n    void load(cid).catch(() => {\n      hint("could not read");\n    });\n  });`;
    expect(reArmsOnFailure(selfHealEffect(good))).toBe(false);
  });
});
