/**
 * THE PAGE FACTS A FAKE `/history` RESPONSE MUST CARRY.
 *
 * `GET /api/chats/:id/history` returns the conversation's TAIL plus a cursor
 * (DESIGN-PERFORMANCE §4), so every stub of that response has to say where
 * its page ended. Without it the client cannot tell "this is the beginning of
 * the conversation" from "older messages are not loaded yet" — which is the
 * whole point of the field, and a stub that omitted it would be testing a
 * shape the server never sends.
 *
 * Declared once here rather than inline per test so a change to the page
 * contract shows up as one edit, not as thirty stubs that quietly disagree
 * with the server.
 */
import type { HistoryPageView } from "../../shared/wire-types.ts";

/**
 * A page that IS the whole conversation: nothing older exists, and the
 * server proved it by returning a short page. The right default for a stub
 * that returns a handful of messages, because that is what the real server
 * would answer for the same data.
 */
export function wholeConversationPage(returned: number, limit = 200): HistoryPageView {
  return {
    limit,
    returned,
    hasOlder: false,
    olderCursor: null,
    messageCount: returned,
    endedBy: "beginning",
  };
}

/**
 * A page with MORE BEHIND IT: the conversation holds `messageCount` messages
 * and this page carries the newest `returned` of them. `olderCursor` is
 * present exactly when `hasOlder` is true, which is the invariant the client
 * relies on to know it can always travel further back.
 */
export function partialPage(
  returned: number,
  messageCount: number,
  cursor = "cursor-older",
  limit = 200,
): HistoryPageView {
  return {
    limit,
    returned,
    hasOlder: true,
    olderCursor: cursor,
    messageCount,
    endedBy: "limit",
  };
}
