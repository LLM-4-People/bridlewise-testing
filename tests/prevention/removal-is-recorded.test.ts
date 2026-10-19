// @vitest-environment node
/**
 * ── DESTROYING SOMETHING IS ITSELF A RECORDED EVENT ────────────────────────
 *
 * The invariant: undo operates on the WORLD, never on the RECORD. Deleting a
 * conversation removes it from retrieval and RECORDS the deletion; the fact
 * that it existed and the fact that someone removed it both survive. The chain
 * only grows.
 *
 * Three routes broke the second half of that. `DELETE /api/chats/:id`,
 * `DELETE /api/projects/:id` and `POST /api/chats/:id/rollback` each destroyed
 * user-visible state and wrote nothing anywhere: afterwards there was no way
 * to say the conversation had ever been there, who removed it, or how much
 * went with it. None of them ever touched `event_log` — so the record was not
 * falsified; it had a hole exactly where the destruction happened, which is
 * the same failure wearing a different coat.
 *
 * The third one is now gone rather than fixed. Recording a destruction is the
 * weakest honest option — the count survives and the content does not — so the
 * rollback route was replaced by WITHDRAWAL: the rows stay, a `rollback` event
 * names the withdrawn ids, and the fold at read time decides what the model
 * receives. The two remaining deletions genuinely remove things a user asked to
 * be gone, so for those, recording the removal is the right shape.
 *
 * THE PRODUCT'S OWN FUNCTION IS CALLED HERE, not a copy of it. The suite
 * redirects `HARNESS_WEB_TIMELINE_DB_PATH` to a per-worker temp ledger
 * (tests/setup/test-setup.ts), so `recordRemoval` writes to a real SQLite
 * ledger through the real recorder, and the assertions read it back through
 * the real query port. A test that retyped the event shape would have proved
 * the retyped copy works.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { recordRemoval, getTimelineQuery } from "../../server/observability/timeline-bridge.ts";
import { callArgumentsOf } from "../helpers/function-scope.ts";

type RemovalDoc = Readonly<{ what: string; id: string; removed?: number; note?: string }>;

/** Every recorded event of one type, read back through the real query port. */
function eventsOfType(eventType: "rollback" | "task") {
  return getTimelineQuery().byEventType(eventType, { limit: 500 }).events;
}

/** Every removal document currently in the ledger. */
function removals(): RemovalDoc[] {
  return [...eventsOfType("rollback"), ...eventsOfType("task")]
    .flatMap((event) => event.documents
      .filter((d) => d.name === "removal" && d.contentJson !== undefined)
      .map((d) => JSON.parse(d.contentJson!) as RemovalDoc));
}

describe("a removal is recorded", () => {
  test("a rolled-back conversation records what went and HOW MUCH", () => {
    recordRemoval("chat-messages", { id: "chat-rb-1", removed: 12, note: "after msg-3" });

    const doc = removals().find((d) => d.id === "chat-rb-1");
    expect(doc).toBeDefined();
    // The COUNT is the point. "Something was removed" is not a record of a
    // removal — a reader has to be able to tell twelve messages from one, and
    // the number is the statement's own `changes`, never an estimate.
    expect(doc).toEqual({ what: "chat-messages", id: "chat-rb-1", removed: 12, note: "after msg-3" });

    const event = eventsOfType("rollback").find((e) => e.description.includes("chat-rb-1"));
    expect(event).toBeDefined();
    expect(event!.description).toContain("12");
    expect(event!.outcome).toBe("succeeded");
    // Who removed it comes from the ambient recording context, not from a
    // parameter. Outside a request boundary that is the visible
    // `unattributed` marker — an admission, never an invented owner.
    expect(event!.actorId.length).toBeGreaterThan(0);
  });

  test("a removed chat and a removed project are each recorded, and distinguishable", () => {
    recordRemoval("chat", { id: "chat-gone-1" });
    recordRemoval("project", { id: "proj-gone-1" });

    const docs = removals();
    expect(docs).toEqual(expect.arrayContaining([
      { what: "chat", id: "chat-gone-1" },
      { what: "project", id: "proj-gone-1" },
    ]));
    // Absence is stated by OMISSION, not by a zero. A route that did not
    // measure how much it removed must not appear to have measured nothing.
    const chat = docs.find((d) => d.id === "chat-gone-1")!;
    expect(Object.keys(chat)).toEqual(["what", "id"]);
    expect(chat.removed).toBeUndefined();
  });

  // THAT THE RECORD OF A REMOVAL IS ITSELF UNREMOVABLE is not asserted here.
  // A version of this test compared a count to itself and would have passed
  // with every append-only trigger dropped. The real proof needs a raw
  // connection issuing DELETE against the ledger file, and opening a second
  // writable handle on the ledger from this process is the one thing
  // `assertLedgerWriterThread` exists to prevent. It is proved where it can
  // be proved: integration/test/timeline/append-only-enforcement.test.ts.
});

describe("the routes actually call it", () => {
  /**
   * The half a behavioural test cannot reach.
   *
   * `recordRemoval` writing correctly proves nothing if the destructive routes
   * stop calling it, and the routes cannot be exercised here without standing
   * up an authenticated server. So this reads the product's SOURCE and
   * requires the call to sit in the same handler as the delete. It is lifted
   * out of the source rather than retyped, so a rename moves both.
   *
   * ── ★ HOW THE HANDLER IS BOUNDED, AND WHAT THAT REPLACES ────────────────
   *
   *     const handler = src.slice(src.indexOf('router.delete("/api/chats/:id"'));
   *     const body = handler.slice(0, handler.indexOf("router.post"));
   *
   * The end delimiter was THE NEXT ROUTE'S KIND. That makes the region a claim
   * about the ORDER OF ROUTES IN THE FILE rather than about this handler:
   * reorder them so a `router.get` follows, or make this the last route, and
   * `indexOf` returns -1, `slice(0, -1)` runs to one character before the end
   * of the FILE, and every `toContain` below is satisfied by some other
   * handler's call. Driven at the parent commit: rc 0, 6/6 passed, with the
   * "same handler" claim unenforced. The projects route below was worse — it
   * had NO end delimiter at all and sliced to end of file.
   *
   * The construct bounds itself or the bound is a guess. `callArgumentsOf`
   * hands back each `router.delete(…)` call's argument list AS THE PARSER
   * DELIMITED IT, so the handler's own callback is the region and nothing
   * outside it can move the boundary. The route path is then matched against
   * that call's FIRST argument, so the subject is chosen by identity rather
   * than by position.
   *
   * REFUSES an absent route, because a route that has vanished must fail
   * rather than report that nothing is wrong with it.
   *
   * Mutation-tested both ways: deleting either `recordRemoval(...)` call fails
   * this, and MOVING one into the neighbouring route also fails it.
   */
  const read = (p: string): string => readFileSync(resolve(import.meta.dirname, "../../server", p), "utf8");

  /** The callback body of the `router.<verb>` registration for exactly this path. */
  function handlerFor(source: string, verb: string, path: string): string {
    const calls = callArgumentsOf(source, `router.${verb}`, `router.${verb} in this route file`);
    const mine = calls.filter((args) => args.trimStart().startsWith(`"${path}"`));
    expect(
      mine.length,
      `exactly one router.${verb}("${path}") registration must exist — `
      + `${mine.length} were found among ${calls.length} router.${verb} calls, and a claim about `
      + "\"the\" handler is unanswerable when the subject is absent or ambiguous",
    ).toBe(1);
    return mine[0]!;
  }

  test("DELETE /api/chats/:id records the removal", () => {
    const src = read("routes/chats.ts");
    const body = handlerFor(src, "delete", "/api/chats/:id");
    // THE WITNESS (§36): the region really is THIS handler's and it is not
    // empty. Without it, an extraction that returned "" would fail the two
    // assertions below for the right reason by accident, and one that returned
    // the whole file would pass them for the wrong reason.
    expect(body, "the witness: the extracted region is this route's own callback").toContain(
      "ctx.params",
    );
    expect(
      body,
      "the witness: the region STOPS at this handler — the next route's path must not be in it",
    ).not.toContain("/api/chats/:id/pin");
    expect(body).toContain("db.deleteChat");
    expect(body).toContain('recordRemoval("chat"');
  });

  /**
   * The trimming route is GONE, and that is a stronger position than recording
   * its trim was.
   *
   * It used to delete `messages` rows and record the count. Recording a
   * destruction is the weakest honest option: the number survives, the
   * messages do not, and "12 were removed" cannot answer which twelve or let
   * anyone put them back. Withdrawal replaced it — rows stay, a `rollback`
   * event names the ids, and the fold at read time decides what the model
   * sees. So the assertion inverts: there must be no delete to record.
   */
  test("no route trims messages any more — withdrawal replaced deletion", () => {
    const src = read("routes/chats.ts");
    expect(src).not.toContain("db.deleteMessagesAfter");
    // The REGISTRATION, not any mention: the file still explains in prose why
    // the route was removed, and that explanation is worth keeping.
    expect(src).not.toMatch(/router\.\w+\(\s*["'`]\/api\/chats\/:id\/rollback/);
  });

  test("the rewind owner records the withdrawal, by measured ids", () => {
    const src = read("run/rewind.ts");
    // The ids, not a predicate. "Everything at or after M" would fold over the
    // re-run's own messages and eat its replacement.
    expect(src).toContain("discardedMessageIds");
    expect(src).not.toContain("db.deleteMessagesAfter");
    // Recorded BEFORE the world changes, and throwing if it cannot be — the
    // opposite of recordRemoval, which reports something already destroyed.
    expect(src).toContain("export function recordRewind");
  });

  test("DELETE /api/projects/:id records the removal", () => {
    const src = read("routes/projects.ts");
    // This one had NO end delimiter at all — it sliced from the anchor to the
    // end of the file, so "in the same handler" was not merely weakly enforced,
    // it was not enforced.
    const body = handlerFor(src, "delete", "/api/projects/:id");
    expect(body, "the witness: the extracted region is this route's own callback").toContain(
      "ctx.params",
    );
    expect(body).toContain("db.deleteProject");
    expect(body).toContain('recordRemoval("project"');
  });

  test("★ the handler region is DRIVEN — it stops where the handler stops", () => {
    // §36 made permanent. Two planted route files with the SAME text in
    // different handlers: the region must find it in one and not in the other,
    // or the "same handler" claim is decoration.
    const planted = (whereTheCallSits: "mine" | "the neighbour") => `
export function mountX(router: R, db: D): void {
  router.delete("/api/things/:id", async (ctx) => {
    const id = ctx.params["id"]!;
    await db.deleteThing(id);
    ${whereTheCallSits === "mine" ? 'recordRemoval("thing", { id });' : ""}
    sendJson(ctx.res, { deleted: true });
  });

  router.post("/api/things/:id/pin", async (ctx) => {
    ${whereTheCallSits === "the neighbour" ? 'recordRemoval("thing", { id: "x" });' : ""}
    sendJson(ctx.res, {});
  });
}
`;
    expect(handlerFor(planted("mine"), "delete", "/api/things/:id")).toContain('recordRemoval("thing"');
    expect(
      handlerFor(planted("the neighbour"), "delete", "/api/things/:id"),
      "a call in the NEXT route must not satisfy a claim about this one — this is the "
      + "whole defect the slice-to-the-next-route's-kind version could not see",
    ).not.toContain('recordRemoval("thing"');
    // AND THE SUBJECT MUST EXIST: a route that has vanished fails loudly
    // rather than reporting that nothing is wrong with it.
    expect(() => handlerFor(planted("mine"), "delete", "/api/gone/:id")).toThrow();
  });
});
