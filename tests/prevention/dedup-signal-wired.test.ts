// @vitest-environment node
/**
 * Prevention test: the dedup/compression SSE signal is wired end-to-end.
 *
 * The wired-but-inert bug class (same family as the 748% bug and the
 * SearchInput one-way binding): a server-emitted SSE event is received +
 * parsed by the client, but the parsed payload is dropped because the
 * handler relied SOLELY on an optional `handlers.onX?.()` callback that
 * no caller ever wires (`openRunStream` is called with `{}`). The signal
 * looks wired (the handler exists, the event type is registered, the
 * callback is invoked) but is actually dead — the data never reaches a
 * shared store or a rendered panel.
 *
 * This test pins the dedup signal's full path so a regression that
 * re-introduces the inert handler is caught mechanically:
 * (A) the `dedup` SSE handler in client.ts calls `setDedupSnapshot`
 *     directly (a shared-store write), not just `handlers.onDedup?.()`.
 * (B) the `dedupSnapshot` store exists in `src/state/dedup.ts` with
 *     `setDedupSnapshot` + `registerReset` (logout-safe, auto-covered).
 * (C) — gone with the MetricsDashboard (the old tree).
 * (D) general class: no SSE event handler in client.ts that surfaces a
 *     UI signal relies SOLELY on an optional `handlers.onX?.()` callback
 *     with no direct store write/ingest in the same handler block.
 *
 * Mutation-verified: removing `setDedupSnapshot(...)` from the dedup
 * handler makes (A) + (D) FAIL; deleting the dedup store makes (B) FAIL.
 */
import { describe, test, expect } from "vitest";
import { read, stripCommentsAndStringsDropFor } from "../helpers/source-scan.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
const CLIENT_PATH = modulePathMatching("src/client.ts");
const CLIENT_SRC = read(CLIENT_PATH);
const DEDUP_STORE_SRC = read(modulePathMatching("src/state/dedup.ts"));

describe("A. dedup SSE handler writes to a shared store directly (not callback-only)", () => {
  test("the dedup event handler calls setDedupSnapshot (direct store write)", () => {
    // Locate the `dedup` event handler block in client.ts and verify it
    // contains a direct `setDedupSnapshot(` call — not just the optional
    // callback. The handler is the addEventListener(SSE_EVENT_TYPES.dedup ...)
    // block; we scan the stripped source so comments don't match.
    const stripped = stripCommentsAndStringsDropFor(CLIENT_SRC, CLIENT_PATH);
    // The handler block starts at the dedup addEventListener and ends at the
    // next addEventListener (or the error handler). Extract a window.
    const start = stripped.indexOf("SSE_EVENT_TYPES.dedup");
    expect(start, "client.ts registers a dedup SSE event listener").toBeGreaterThan(-1);
    // Window: from the dedup listener to the next listener registration.
    const nextListener = stripped.indexOf("addEventListener", start + 1);
    const block = stripped.slice(start, nextListener === -1 ? undefined : nextListener);
    expect(
      block,
      "the dedup handler must call setDedupSnapshot directly (a direct store write, not just handlers.onDedup?.())",
    ).toContain("setDedupSnapshot(");
  });

  test("the dedup handler still forwards to the optional callback (supplementary, not sole path)", () => {
    const stripped = stripCommentsAndStringsDropFor(CLIENT_SRC, CLIENT_PATH);
    const start = stripped.indexOf("SSE_EVENT_TYPES.dedup");
    const nextListener = stripped.indexOf("addEventListener", start + 1);
    const block = stripped.slice(start, nextListener === -1 ? undefined : nextListener);
    // The callback is kept as a supplementary hook; the direct store write
    // is the PRIMARY path so the signal is never dropped.
    expect(block).toContain("handlers.onDedup?.(");
  });
});

describe("B. dedupSnapshot store exists + is logout-safe (auto-registered reset)", () => {
  test("src/state/dedup.ts exports dedupSnapshot + setDedupSnapshot + resetDedup", () => {
    expect(DEDUP_STORE_SRC, "exports the dedupSnapshot atom").toMatch(
      /export const dedupSnapshot\b/,
    );
    expect(DEDUP_STORE_SRC, "exports setDedupSnapshot").toMatch(
      /export function setDedupSnapshot\b/,
    );
    expect(DEDUP_STORE_SRC, "exports resetDedup").toMatch(
      /export function resetDedup\b/,
    );
  });

  test("dedup.ts registers its reset with the store registry (auto-covered on logout)", () => {
    // The dynamic store-registry pattern: a store self-registers at module
    // load via registerReset, so resetAllStores iterates the registry
    // dynamically. A new store is automatically covered — no manual list.
    expect(DEDUP_STORE_SRC, "dedup.ts calls registerReset for logout coverage").toMatch(
      /registerReset\(\s*["']dedup["']\s*,\s*resetDedup\s*\)/,
    );
  });

  test("the DedupSnapshot type carries the dedup summary fields the server emits", () => {
    // Pin the contract so a field rename/drop is caught. The server
    // summarizeDedupReports emits these fields; the store must carry them.
    expect(DEDUP_STORE_SRC).toContain("applied");
    expect(DEDUP_STORE_SRC).toContain("originalChars");
    expect(DEDUP_STORE_SRC).toContain("dedupedChars");
    expect(DEDUP_STORE_SRC).toContain("charReductionPct");
    expect(DEDUP_STORE_SRC).toContain("removedBlocks");
    expect(DEDUP_STORE_SRC).toContain("removedLines");
    expect(DEDUP_STORE_SRC).toContain("messageCount");
  });
});

// (Class C died with the MetricsDashboard — the dedup snapshot's server
// wiring and store ingestion above are the surviving subject.)

describe("D. general class: no SSE signal handler is callback-only (wired-but-inert)", () => {
  // For each SSE event handler in client.ts that surfaces a UI signal, the
  // handler block must contain a DIRECT store write/ingest (setX, appendX,
  // upsertX, ingestX, applyX, setStreaming) — not SOLELY an optional
  // `handlers.onX?.()` callback. A callback-only handler is inert when the
  // caller passes `{}` (which beginChatRun does). The acknowledgment
  // `connected` event is exempt (it carries no UI signal — just runId
  // validation).
  test("every SSE event handler that surfaces a signal has a direct store write/ingest", () => {
    const stripped = stripCommentsAndStringsDropFor(CLIENT_SRC, CLIENT_PATH);
    // The signal-surfacing event types (exclude `connected` = acknowledgment
    // only, and `error` = native EventSource error, no parsed payload).
    const signalEvents = [
      "model",
      "timeline",
      "agent",
      "steered",
      "context",
      "metadata",
      "dedup",
      "done",
      "quality",
      "toolResult",
      "hallucination",
      "uiControl",
    ];
    const directWriteTokens = [
      "ingestModelEvent",
      "ingestInlineTimelineEvent",
      "upsertAgent",
      "setStreaming",
      "ingestToolResult",
      "setQualitySnapshot",
      "setDedupSnapshot",
      "appendEventMessage",
      "applyUiControlAction",
      "finalizeRunningToolCalls",
      "updateLastMessage",
      // The role-safe sibling: walks back to the last ASSISTANT message so
      // a frame arriving after a tool card still lands (the metadata/usage
      // handlers write through it — see chat-messages.ts).
      "updateLastAssistantMessage",
      "clientWarn",
      "refreshTimeline",
      "listChatAutoChecks",
      "appendChatError",
      "pendingContext",
    ];
    const inert: string[] = [];
    for (const evt of signalEvents) {
      const token = `SSE_EVENT_TYPES.${evt}`;
      const start = stripped.indexOf(token);
      if (start === -1) continue;
      const nextListener = stripped.indexOf("addEventListener", start + 1);
      const block = stripped.slice(start, nextListener === -1 ? undefined : nextListener);
      const hasDirect = directWriteTokens.some((t) => block.includes(t));
      if (!hasDirect) inert.push(evt);
    }
    expect(
      inert,
      "these SSE signal handlers have NO direct store write/ingest (callback-only = wired but inert):\n" +
        inert.map((e) => `  ${e}`).join("\n"),
    ).toEqual([]);
  });
});
